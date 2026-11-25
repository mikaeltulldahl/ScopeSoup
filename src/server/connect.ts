// Settings' "Connect to GitHub Issues" and "Connect to Jira" (#127, decision 98): what the dialog sent, read into the shared
// `host` (and Jira Cloud's email for this machine), then one look at the host with the token from the environment, so the dialog
// can say what connecting would do before anything is written. The token is only read from the environment: never asked for,
// shown or kept. The Items a person ticks move with `src/items/moveToHost.ts`; the rest stay on the meta branch. The same dialog
// in join mode sets up a machine for the host the project already has ("Set up this machine").

import { createClient, type FetchLike } from "../hosts/github/client.ts";
import { createJiraClient } from "../hosts/jira/client.ts";
import { itemsJql } from "../hosts/jira/map.ts";
import type { HostConnection, MetaPart } from "../config/edit.ts";
import { isIdPrefix } from "../hosts/metaBranch/ids.ts";
import type { HostConfig } from "../config/types.ts";
import { createGitHubHost } from "../hosts/github/index.ts";
import { createJiraHost, type JiraHost, type JiraThreadComment } from "../hosts/jira/index.ts";
import { readIssues } from "../items/githubImport.ts";
import { fromGitHub, fromJira, githubOldHost, jiraOldHost, type OldHost, type SourceItem } from "../items/moveToMeta.ts";
import type { Session, WorkItem } from "../model/types.ts";
import type { Host } from "../ports/host.ts";

export type ConnectKind = "github" | "jira";
/** What the dialogs connect to: GitHub or Jira (#127), or back to the meta branch (#134). */
export type HostKind = ConnectKind | "metaBranch";

/** How the look at the host is made; tests and the demo give fakes, so no real host is ever called from them. */
export interface ConnectDeps {
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl?: FetchLike;
  /** The GitHub API's address; the fake's in tests. */
  githubApi?: string;
}

/** The new host with writes on, for moving Items: made with the token from the environment and the deps' `fetch`. */
export function hostFor(kind: ConnectKind, connection: HostConnection, token: string, deps: ConnectDeps, machine: string | undefined, options: { onOutside?: (key: string, reason: string) => void; unfiltered?: boolean } = {}): Host {
  const host = options.unfiltered ? Object.fromEntries(Object.entries(connection.host).filter(([key]) => key !== "filter")) : connection.host;
  const fetchImpl = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  if (kind === "github") return createGitHubHost({ token, repo: String(host.repo), allowWrites: true, conventions: true, ...(machine ? { machine } : {}), ...fetchImpl, ...(deps.githubApi ? { apiUrl: deps.githubApi } : {}) });
  return createJiraHost({
    site: String(host.site), project: String(host.project), deployment: host.deployment === "datacenter" ? "datacenter" : "cloud", token, allowWrites: true, conventions: true,
    ...(connection.email ? { email: connection.email } : {}), ...(machine ? { machine } : {}), ...fetchImpl,
    ...(typeof host.filter === "string" ? { filter: host.filter } : {}), ...(Array.isArray(host.components) ? { components: host.components as string[] } : {}),
    log: () => undefined,
    ...(options.onOutside ? { onOutsideFilter: options.onOutside } : {}),
  });
}

/**
 * The machines where an agent session runs now: this one's running sessions, and agents' unexpired claims on Items (the meta ref's
 * holders). Other machines are seen only through their claims.
 */
export function busyMachines(works: readonly WorkItem[], sessions: readonly Session[], machine: string | undefined, now: Date): string[] {
  const busy = new Set<string>();
  if (sessions.some((session) => session.status === "starting" || session.status === "running" || session.status === "stalled")) busy.add(machine ?? "this machine");
  for (const work of works) {
    const holder = work.holder;
    if (!holder?.actor.bot || work.state === "done" || work.state === "abandoned") continue;
    if (holder.until && Date.parse(holder.until) <= now.getTime()) continue;
    const at = holder.actor.id.lastIndexOf("@");
    busy.add(at >= 0 ? holder.actor.id.slice(at + 1) : holder.actor.name);
  }
  return [...busy].sort();
}

/** Why a Connect or a Join theirs waits, naming the busy machines. */
export function busyText(busy: readonly string[], what: string): string {
  return `${what} waits until no agent session runs on any machine, so no session writes to the Items meanwhile. Busy now: ${busy.join(", ")}. Other machines are seen only through their agents' claims on Items. Pause the agents there and try again when their sessions have ended.`;
}

/**
 * Join mode: the host the project already has, as the dialog would send it, with this machine's part: the email for Jira Cloud,
 * the author and id prefix for the meta branch.
 */
export function joinConnection(host: HostConfig, body: Record<string, unknown>): { ok: true; kind: HostKind; connection: HostConnection } | { ok: false; error: string } {
  if (host.kind === "github") return { ok: true, kind: "github", connection: { host: { kind: "github", repo: host.repo, write: host.write } } };
  if (host.kind === "metaBranch") return { ok: true, kind: "metaBranch", connection: { host: { kind: "metaBranch", write: host.write }, meta: metaPartIn(body) } };
  const { email: _own, ...shared } = host;
  return { ok: true, kind: "jira", connection: { host: shared as unknown as Record<string, unknown>, ...(host.deployment === "cloud" ? { email: text(body.email) } : {}) } };
}

/** This machine's meta branch part as the dialog sent it. */
const metaPartIn = (body: Record<string, unknown>): MetaPart => ({ authorName: text(body.authorName), authorEmail: text(body.authorEmail), prefix: text(body.prefix) });

/** What is wrong with this machine's meta branch part, in words; empty when nothing. */
export function metaPartProblems(meta: MetaPart | undefined): string[] {
  const problems: string[] = [];
  if (!meta?.authorName) problems.push("Give your name: this machine's meta commits are made as you.");
  if (!meta?.authorEmail || !/^[^\s@]+@[^\s@]+$/.test(meta.authorEmail)) problems.push("Give your email, as git writes it in a commit.");
  if (!meta?.prefix || !isIdPrefix(meta.prefix)) problems.push("Give this machine's id prefix: a letter, then up to 15 letters or digits (A gives A-12). Each machine has its own.");
  return problems;
}

export const TOKEN_VARIABLE: Record<ConnectKind, string> = { github: "SCOPESOUP_GITHUB_TOKEN", jira: "SCOPESOUP_JIRA_TOKEN" };
export const HOST_NAME: Record<ConnectKind, string> = { github: "GitHub Issues", jira: "Jira" };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The dialog's fields as the configuration holds them. Form problems are left to the configuration's validation. */
export function connectionOf(body: Record<string, unknown>): { ok: true; kind: HostKind; connection: HostConnection } | { ok: false; error: string } {
  const write = body.write !== false;
  // Back to the meta branch (#134): always with writes on, and this machine's part.
  if (body.kind === "metaBranch") return { ok: true, kind: "metaBranch", connection: { host: { kind: "metaBranch", write: true }, meta: metaPartIn(body) } };
  if (body.kind === "github") {
    // "owner/name", also when pasted as the repository's address.
    const repo = text(body.repo).replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    return { ok: true, kind: "github", connection: { host: { kind: "github", repo, write } } };
  }
  if (body.kind === "jira") {
    const deployment = body.deployment === "datacenter" ? "datacenter" : "cloud";
    const filter = text(body.filter);
    const components = Array.isArray(body.components) ? body.components.map(text).filter((each) => each !== "") : [];
    const host: Record<string, unknown> = { kind: "jira", site: text(body.site).replace(/\/+$/, ""), project: text(body.project).toUpperCase(), deployment, write };
    if (filter !== "") host.filter = filter;
    if (components.length > 0) host.components = components;
    return { ok: true, kind: "jira", connection: { host, ...(deployment === "cloud" ? { email: text(body.email) } : {}) } };
  }
  return { ok: false, error: 'Give "kind": "github", "jira" or "metaBranch".' };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Looks at the host with the token from the environment: the repository (and whether the token may write to it), or the Jira
 * account and how many open issues of the project (within the filter) would be the Items. Reads only.
 */
export async function lookAtHost(kind: ConnectKind, connection: HostConnection, deps: ConnectDeps): Promise<{ problems: string[]; lines: string[] }> {
  const variable = TOKEN_VARIABLE[kind];
  const token = deps.env[variable];
  const host = connection.host;
  const write = host.write === true;
  if (!token) {
    const what = kind === "github" ? `a GitHub token that can read${write ? " and write" : ""} the repository's issues` : host.deployment === "datacenter" ? "a Jira personal access token" : "a Jira Cloud API token of the account whose email you gave";
    return { problems: [`${variable} is not set in the environment Scope Soup was started in. Set it to ${what} and start Scope Soup again. The token is only read from the environment: it is never asked for here or kept in a file.`], lines: [] };
  }
  const fetchImpl = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  if (kind === "github") {
    const repo = String(host.repo);
    try {
      const client = createClient({ token, repo, ...fetchImpl, ...(deps.githubApi ? { apiUrl: deps.githubApi } : {}) });
      const found = (await client.get<{ full_name?: string; has_issues?: boolean; permissions?: { push?: boolean } }>(client.repoPath(""))).data;
      const problems: string[] = [];
      if (found.has_issues === false) problems.push(`${repo} has issues turned off on GitHub. Turn them on in the repository's settings first.`);
      if (write && found.permissions?.push !== true) problems.push(`The token in ${variable} cannot write to ${repo}. Give it write access to issues, or connect read-only.`);
      return { problems, lines: [`${variable} is set and reads ${found.full_name ?? repo}${write && found.permissions?.push === true ? ", with write access" : ""}.`] };
    } catch (error) {
      return { problems: [`GitHub did not answer for ${repo} with the token in ${variable}: ${messageOf(error)}`], lines: [] };
    }
  }
  const site = String(host.site);
  const project = String(host.project);
  try {
    const client = createJiraClient({ site, deployment: host.deployment === "datacenter" ? "datacenter" : "cloud", token, ...(connection.email ? { email: connection.email } : {}), ...fetchImpl });
    const me = await client.get<{ displayName?: string }>(`${client.api}/myself`);
    // The open issues, asked as the host asks for them.
    const jql = `${itemsJql({ project, ...(typeof host.filter === "string" ? { filter: host.filter } : {}) })} AND statusCategory != Done ORDER BY updated ASC, key ASC`;
    const issues = await client.search<unknown>(jql, ["summary"]);
    return {
      problems: [],
      lines: [
        `${variable} is set and signs in to ${site} as ${me.displayName ?? "the token's account"}.`,
        `${issues.length} open issue(s) of ${project}${host.filter ? " within the filter" : ""} would be the Items.`,
      ],
    };
  } catch (error) {
    return { problems: [`Jira did not answer for project ${project} on ${site} with the token in ${variable}: ${messageOf(error)}`], lines: [] };
  }
}

/** Where the Items are now, in words, from the host in use. */
export function hostWhere(host: { kind: string; repo?: string; project?: string } | undefined): string {
  if (!host) return "the host set in the environment";
  if (host.kind === "metaBranch") return "the meta branch (refs/scopesoup/meta)";
  if (host.kind === "github") return `GitHub Issues (${host.repo})`;
  return `Jira (project ${host.project})`;
}

/** The host the Items move back from (#134): its open issues to tick, the ticked ones read in full, and the step on it after. */
export interface MoveSource {
  list(): Promise<{ id: string; title: string }[]>;
  read(names: readonly string[]): Promise<SourceItem[]>;
  old: OldHost;
}

/**
 * GitHub through the import's reader (`readIssues`) and its step on GitHub (`moveIssues`); Jira through its host, with writes as
 * the project's host has them. The token is the one from the environment; the deps' `fetch` in tests and the demo.
 */
export function sourceOf(host: Extract<HostConfig, { kind: "github" | "jira" }>, token: string, deps: ConnectDeps, machine: string | undefined): MoveSource {
  const fetchImpl = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  if (host.kind === "github") {
    const client = createClient({ token, repo: host.repo, ...fetchImpl, ...(deps.githubApi ? { apiUrl: deps.githubApi } : {}) });
    return {
      list: async () => (await readIssues(client, "none", 0)).filter((issue) => issue.open).map((issue) => ({ id: `#${issue.number}`, title: issue.title })),
      read: async (names) => fromGitHub((await readIssues(client, "none", ALL_COMMENTS)).filter((issue) => issue.open && names.includes(`#${issue.number}`)), host.repo),
      old: githubOldHost(client),
    };
  }
  const joined = joinConnection(host, { email: host.email });
  if (!joined.ok) throw new Error(joined.error);
  const jira = hostFor("jira", joined.connection, token, deps, machine) as JiraHost;
  return {
    list: async () => (await jira.work.listWork()).items.filter((work) => work.state !== "done" && work.state !== "abandoned").map((work) => ({ id: work.ref.id, title: work.title })),
    async read(names) {
      const works: WorkItem[] = [];
      const comments = new Map<string, JiraThreadComment[]>();
      for (const name of names) {
        const ref = { host: jira.info.id, kind: "work" as const, id: name };
        const work = await jira.work.getWork(ref);
        if (!work || work.state === "done" || work.state === "abandoned") continue;
        works.push(work);
        comments.set(name, (await jira.thread(ref)).comments);
      }
      return fromJira(works, comments, host.site);
    },
    old: jiraOldHost(jira),
  };
}

/** Every comment of people on an issue comes along as its history. */
const ALL_COMMENTS = 1000;
