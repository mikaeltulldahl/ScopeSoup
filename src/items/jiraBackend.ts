// The item commands' backend on a Jira host (`service.ts`): for a person's own commands, with their token, and for the board's
// Claim, Hand back and Release buttons, through the server's token for the board's picked person. On the board the person is the
// Jira account the picked name is: the holder when it is their account id, else the one assignable user it names (`JiraBoard.resolve`).

import type { JiraHost } from "../hosts/jira/index.ts";
import type { Actor, Ref, WorkItem } from "../model/types.ts";
import type { Backend } from "./service.ts";

/** How long a person's claim on Jira waits for an agent's claim written meanwhile: the agents' own settle time. */
export const JIRA_CLAIM_SETTLE_MS = 2000;

type Readable = Pick<JiraHost, "info" | "work" | "write" | "read">;

/** The agent whose live claim stands on the issue, if any. */
export function jiraAgentClaim(host: Pick<JiraHost, "read">, now: () => Date) {
  return async (ref: Ref): Promise<string | undefined> => {
    const live = (await host.read(ref)).claims.filter((each) => !each.released && Date.parse(each.until) > now().getTime());
    return live[0] ? `scopesoup on ${live[0].machine}` : undefined;
  };
}

export interface JiraBackendOptions {
  /** Who acts: the Jira account (Cloud's account id, Data Center's user name) and its display name. */
  person: Actor;
  now: () => Date;
  mainBranch: string;
  branches?: Backend["branches"];
  /** Replaces the claim's settle wait, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The writes go through another account's token (the server's): see `Backend.onBehalf`. */
  onBehalf?: boolean;
}

export function jiraBackend(host: Readable, options: JiraBackendOptions): Backend {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  return {
    kind: "jira", host: host.info.id, who: options.person.id, name: options.person.name, work: host.work, write: host.write ?? {}, now: options.now,
    mainBranch: options.mainBranch, ...(options.branches ? { branches: options.branches } : {}),
    agentClaim: jiraAgentClaim(host, options.now), settle: () => sleep(JIRA_CLAIM_SETTLE_MS),
    ...(options.onBehalf ? { onBehalf: true } : {}),
  };
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Who a picked name is on Jira: an account, or why it is none. `hard`: nothing may be done as that name (Scope Soup's own account, an app, several people). */
export type Resolved = { person: Actor } | { why: string; hard: boolean };

/** The board's buttons on a Jira host: who the picked person is there, and the backend that acts for them with the server's token. */
export interface JiraBoard {
  host: string;
  work: Backend["work"];
  /**
   * The Jira account the picked name is: the item's (person) holder when the name is exactly their account id or user name;
   * else the one assignable user whose account id, user name or, failing those, display name it is. Never Scope Soup's own account
   * or an app, and never a display name several assignable users share.
   */
  resolve(picked: string, item: WorkItem | undefined): Promise<Resolved>;
  /** The backend for that person; the caller adds the main branch and the remote it knows. */
  backend(person: Actor): Omit<Backend, "mainBranch" | "branches">;
}

export function jiraBoard(host: Readable & Pick<JiraHost, "people">, options: { now: () => Date; sleep?: (ms: number) => Promise<void> }): JiraBoard {
  const notPerson = (picked: string): Resolved => ({ why: `"${picked}" is Scope Soup's own account or an app on Jira, not a person: pick yourself at the top of the board.`, hard: true });
  return {
    host: host.info.id,
    work: host.work,
    async resolve(picked, item) {
      const self = await host.info.whoami();
      const holder = item?.holder?.actor;
      if (holder && same(picked, holder.id)) return holder.bot || same(holder.id, self.id) ? notPerson(picked) : { person: holder };
      let people: Actor[];
      try {
        people = await host.people();
      } catch (error) {
        return { why: `Jira could not say who may be assigned, so Scope Soup cannot tell who "${picked}" is on Jira now: ${error instanceof Error ? error.message : String(error)}.`, hard: false };
      }
      const byId = people.filter((each) => same(picked, each.id));
      const found = byId.length > 0 ? byId : people.filter((each) => same(picked, each.name));
      if (found.length > 1) return { why: `Several people on Jira are called "${picked}". Pick yourself at the top of the board by your account id (Cloud) or user name (Data Center).`, hard: true };
      const person = found[0];
      if (person) return person.bot || same(person.id, self.id) ? notPerson(picked) : { person };
      if (same(picked, self.id) || same(picked, self.name)) return notPerson(picked);
      return { why: `"${picked}" is not someone Jira can assign this Item to. Pick yourself at the top of the board by your name on Jira (or your account id on Cloud, your user name on Data Center).`, hard: false };
    },
    backend: (person) => {
      const { mainBranch: _main, branches: _branches, ...rest } = jiraBackend(host, { person, now: options.now, mainBranch: "", onBehalf: true, ...(options.sleep ? { sleep: options.sleep } : {}) });
      return rest;
    },
  };
}
