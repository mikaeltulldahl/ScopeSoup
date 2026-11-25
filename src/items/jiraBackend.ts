// The item commands' backend on a Jira host (`service.ts`): for a person's own commands, with their token, and for the board's
// Claim, Hand back and Release buttons, through the server's token for the board's picked person. On the board the person is the
// Jira account the picked name is: the holder when it names them, else (to claim) the one assignable user it names.

import type { JiraHost } from "../hosts/jira/index.ts";
import type { Actor, Ref, WorkItem } from "../model/types.ts";
import type { Backend } from "./service.ts";
import { Refused } from "./service.ts";

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

/** Whether a picked name names this account: its account id or user name, or its display name, in any case. */
export const namesActor = (picked: string, actor: Actor): boolean => same(picked, actor.id) || same(picked, actor.name);

/** The item's holder, when it is a person and the picked name names them. Needs no call to Jira. */
export function heldByPicked(picked: string, item: WorkItem | undefined): Actor | undefined {
  const actor = item?.holder?.actor;
  return actor && !actor.bot && namesActor(picked, actor) ? actor : undefined;
}

/** The board's buttons on a Jira host: who the picked person is there, and the backend that acts for them with the server's token. */
export interface JiraBoard {
  host: string;
  work: Backend["work"];
  /**
   * The Jira account the picked name is: the item's holder when it names them; else, to claim, the one assignable user it names
   * (never Scope Soup's own account or an app), or a refusal that says why. To hand back or release, a name that is not the
   * holder's stays as given: the rules then refuse a hand-back, and a release names whose hold it was.
   */
  person(picked: string, item: WorkItem | undefined, claim: boolean): Promise<Actor>;
  /** The backend for that person; the caller adds the main branch and the remote it knows. */
  backend(person: Actor): Omit<Backend, "mainBranch" | "branches">;
}

export function jiraBoard(host: Readable & Pick<JiraHost, "people">, options: { now: () => Date; sleep?: (ms: number) => Promise<void> }): JiraBoard {
  return {
    host: host.info.id,
    work: host.work,
    async person(picked, item, claim) {
      const holder = heldByPicked(picked, item);
      if (holder) return holder;
      if (!claim) return { id: picked, name: picked };
      const self = await host.info.whoami();
      let people: Actor[];
      try {
        people = await host.people();
      } catch (error) {
        throw new Refused(`Jira could not say who may be assigned, so ${picked} cannot be made the assignee now: ${error instanceof Error ? error.message : String(error)}.`);
      }
      const byId = people.filter((each) => same(picked, each.id));
      const found = byId.length > 0 ? byId : people.filter((each) => same(picked, each.name));
      if (found.length > 1) throw new Refused(`Several people on Jira are called "${picked}". Pick yourself at the top of the board by your account id (Cloud) or user name (Data Center).`);
      const person = found[0];
      if (!person) throw new Refused(`"${picked}" is not someone Jira can assign this Item to. Pick yourself at the top of the board by your name on Jira (or your account id on Cloud, your user name on Data Center).`);
      if (person.bot || same(person.id, self.id)) throw new Refused(`"${picked}" is Scope Soup's own account or an app on Jira, not a person: pick yourself at the top of the board.`);
      return person;
    },
    backend: (person) => {
      const { mainBranch: _main, branches: _branches, ...rest } = jiraBackend(host, { person, now: options.now, mainBranch: "", onBehalf: true, ...(options.sleep ? { sleep: options.sleep } : {}) });
      return rest;
    },
  };
}
