// Settings' "Connect to GitHub Issues" and "Connect to Jira" (#127, decision 95): what the dialog sent, read into the shared
// `host` (and Jira Cloud's email for this machine), then one look at the host with the token from the environment, so the dialog
// can say what connecting would do before anything is written. The token is only read from the environment: never asked for,
// shown or kept. The Items a person ticks move with `src/items/moveToHost.ts`; the rest stay on the meta branch. The same dialog
// in join mode sets up a machine for the host the project already has ("Set up this machine").

import { createClient, type FetchLike } from "../hosts/github/client.ts";
import { createJiraClient } from "../hosts/jira/client.ts";
import { itemsJql } from "../hosts/jira/map.ts";
import type { HostConnection } from "../config/edit.ts";
import type { HostConfig } from "../config/types.ts";
import { createGitHubHost } from "../hosts/github/index.ts";
import { createJiraHost } from "../hosts/jira/index.ts";
import type { Session, WorkItem } from "../model/types.ts";
import type { Host } from "../ports/host.ts";

export type ConnectKind = "github" | "jira";

/** How the look at the host is made; tests and the demo give fakes, so no real host is ever called from them. */
export interface ConnectDeps {
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl?: FetchLike;
  /** The GitHub API's address; the fake's in tests. */
  githubApi?: string;
}

/** The new host with writes on, for moving Items: made with the token from the environment and the deps' `fetch`. */
export function hostFor(kind: ConnectKind, connection: HostConnection, token: string, deps: ConnectDeps, machine: string | undefined): Host {
  const host = connection.host;
  const fetchImpl = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  if (kind === "github") return createGitHubHost({ token, repo: String(host.repo), allowWrites: true, conventions: true, ...(machine ? { machine } : {}), ...fetchImpl, ...(deps.githubApi ? { apiUrl: deps.githubApi } : {}) });
  return createJiraHost({
    site: String(host.site), project: String(host.project), deployment: host.deployment === "datacenter" ? "datacenter" : "cloud", token, allowWrites: true, conventions: true,
    ...(connection.email ? { email: connection.email } : {}), ...(machine ? { machine } : {}), ...fetchImpl,
    ...(typeof host.filter === "string" ? { filter: host.filter } : {}), ...(Array.isArray(host.components) ? { components: host.components as string[] } : {}),
    log: () => undefined,
  });
}

/** The machines where an agent session runs now: this one's running sessions, and agents' unexpired claims on Items (the meta ref's holders). */
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

/** Join mode: the host the project already has, as the dialog would send it, with this machine's email for Jira Cloud. */
export function joinConnection(host: HostConfig, email: unknown): { ok: true; kind: ConnectKind; connection: HostConnection } | { ok: false; error: string } {
  if (host.kind === "github") return { ok: true, kind: "github", connection: { host: { kind: "github", repo: host.repo, write: host.write } } };
  if (host.kind !== "jira") return { ok: false, error: "The project's host is the meta branch: onboarding sets a machine up for it." };
  const { email: _own, ...shared } = host;
  return { ok: true, kind: "jira", connection: { host: shared as unknown as Record<string, unknown>, ...(host.deployment === "cloud" ? { email: text(email) } : {}) } };
}

export const TOKEN_VARIABLE: Record<ConnectKind, string> = { github: "SCOPESOUP_GITHUB_TOKEN", jira: "SCOPESOUP_JIRA_TOKEN" };
export const HOST_NAME: Record<ConnectKind, string> = { github: "GitHub Issues", jira: "Jira" };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The dialog's fields as the configuration holds them. Form problems are left to the configuration's validation. */
export function connectionOf(body: Record<string, unknown>): { ok: true; kind: ConnectKind; connection: HostConnection } | { ok: false; error: string } {
  const write = body.write !== false;
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
  return { ok: false, error: 'Give "kind": "github" or "jira".' };
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
