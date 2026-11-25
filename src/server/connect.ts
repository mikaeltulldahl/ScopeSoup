// Settings' "Connect to GitHub Issues" and "Connect to Jira" (#127): what the dialog sent, read into the shared `host` (and Jira
// Cloud's email for this machine), then one look at the host with the token from the environment, so the dialog can say what
// connecting would do before anything is written. The token is only read from the environment: never asked for, shown or kept.
// Items are not moved: Scope Soup has no move from the meta branch (or another host) to GitHub Issues or Jira, so the dialog
// says that and the old Items stay where they are. (`src/items/githubMove.ts` is the other way, GitHub to the meta branch.)

import { createClient, type FetchLike } from "../hosts/github/client.ts";
import { createJiraClient } from "../hosts/jira/client.ts";
import { itemsJql } from "../hosts/jira/map.ts";
import type { HostConnection } from "../config/edit.ts";

export type ConnectKind = "github" | "jira";

/** How the look at the host is made; tests and the demo give fakes, so no real host is ever called from them. */
export interface ConnectDeps {
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl?: FetchLike;
  /** The GitHub API's address; the fake's in tests. */
  githubApi?: string;
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
