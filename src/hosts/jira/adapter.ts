// The Jira host: one Jira project (Cloud or Data Center) as a host of work items. Read-only in this version: it has no write
// port, whatever the configuration says. No project-specific conventions here.

import type { Actor, Priority, Ref, WorkItem } from "../../model/types.ts";
import type { Capability, Cursor, Host, HostInfo, Page, WorkPort } from "../../ports/host.ts";
import { WorkGone } from "../../ports/host.ts";
import type { Deployment, FetchLike, JiraClient } from "./client.ts";
import { createJiraClient, JiraError } from "./client.ts";
import type { JiraScope } from "./map.ts";
import { actorOf, DEFAULT_ABANDONED_RESOLUTIONS, DEFAULT_BLOCKS_LINK, DEFAULT_PRIORITIES, ISSUE_FIELDS, isoTime, issueToWork, jqlString, jqlTime, PROPERTY_PREFIX, projectOf, textOf } from "./map.ts";
import type { JiraComment, JiraIssue, JiraProperty, JiraUser } from "./rest.ts";

export interface JiraConfig {
  site: string;
  /** The project key, `DEMO`. */
  project: string;
  deployment: Deployment;
  /** Passed in by the caller from SCOPESOUP_JIRA_TOKEN; the adapter never reads the environment. */
  token: string;
  /** Cloud only: the account's email. */
  email?: string;
  /** The host id used in refs. Default "jira". */
  id?: string;
  fetchImpl?: FetchLike;
  /** Milliseconds since the epoch. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Jira priority name -> Scope Soup priority. Default `DEFAULT_PRIORITIES`. */
  priorities?: Record<string, Priority>;
  /** Resolutions that make a done issue abandoned. Default `DEFAULT_ABANDONED_RESOLUTIONS`. */
  abandonedResolutions?: string[];
  /** The link type read as "blocked by". Default "Blocks". */
  blocksLink?: string;
}

/** One comment as read, with Scope Soup's properties on it. Its text is data: people and agents wrote it. */
export interface JiraThreadComment {
  id: string;
  author: Actor;
  /** ISO 8601. */
  created: string;
  markdown: string;
  simplified: string[];
  /** The comment's properties whose key starts with `scopesoup`, by key. */
  properties: Record<string, unknown>;
}

export interface JiraThread {
  comments: JiraThreadComment[];
  /** The issue's properties whose key starts with `scopesoup` (`scopesoup.claim`, `scopesoup.log`, `scopesoup.overturns`). */
  properties: Record<string, unknown>;
}

export interface JiraHost extends Host {
  info: HostInfo;
  work: WorkPort;
  /** An issue's comments and Scope Soup's comment and issue properties, for the conventions layer (a later slice). */
  thread(ref: Ref): Promise<JiraThread>;
  /** What reading the issue's description simplified, as of its last read (node or macro names); empty when nothing. */
  simplified(id: string): string[];
  stats(): { sent: number; retried: number };
}

/** JQL compares `updated` to the minute, so each listing asks from this much before the cursor and gets the newest again. */
const OVERLAP_MS = 2 * 60_000;

const notFound = (error: unknown): boolean => error instanceof JiraError && error.status === 404;
const ours = (key: string): boolean => key === PROPERTY_PREFIX || key.startsWith(`${PROPERTY_PREFIX}.`);

export function createJiraHost(config: JiraConfig): JiraHost {
  const client: JiraClient = createJiraClient({
    site: config.site, deployment: config.deployment, token: config.token,
    ...(config.email ? { email: config.email } : {}),
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    ...(config.now ? { now: config.now } : {}),
    ...(config.sleep ? { sleep: config.sleep } : {}),
  });
  const now = config.now ?? Date.now;
  const scope: JiraScope = {
    host: config.id ?? "jira",
    site: client.site,
    project: config.project,
    deployment: config.deployment,
    priorities: config.priorities ?? DEFAULT_PRIORITIES,
    abandonedResolutions: config.abandonedResolutions ?? DEFAULT_ABANDONED_RESOLUTIONS,
    blocksLink: config.blocksLink ?? DEFAULT_BLOCKS_LINK,
  };
  const api = client.api;
  let me: { actor: Actor; timeZone: string } | null = null;
  const simplifiedByKey = new Map<string, string[]>();

  async function myself(): Promise<{ actor: Actor; timeZone: string }> {
    if (me) return me;
    const user = await client.get<JiraUser>(`${api}/myself`);
    me = { actor: actorOf(user), timeZone: user.timeZone || "UTC" };
    return me;
  }

  const info: HostInfo = {
    id: scope.host,
    capabilities: new Set<Capability>(["work"]),
    whoami: async () => (await myself()).actor,
  };

  const toWork = (issue: JiraIssue): WorkItem => {
    const { item, simplified } = issueToWork(scope, issue);
    if (simplified.length > 0) simplifiedByKey.set(issue.key, simplified);
    else simplifiedByKey.delete(issue.key);
    return item;
  };

  const work: WorkPort = {
    async listWork(since?: Cursor): Promise<Page<WorkItem>> {
      const project = `project = ${jqlString(scope.project)}`;
      let jql: string;
      if (since) {
        const from = new Date(Date.parse(since) - OVERLAP_MS).toISOString();
        jql = `${project} AND updated >= ${jqlString(jqlTime(from, (await myself()).timeZone))} ORDER BY updated ASC, key ASC`;
      } else {
        // The first listing and a full pass: what is open. Closed issues come in through `updated` from then on.
        jql = `${project} AND statusCategory != Done ORDER BY updated ASC, key ASC`;
      }
      const issues = await client.search<JiraIssue>(jql, ISSUE_FIELDS);
      const items = issues.filter((issue) => projectOf(issue.key) === scope.project).map(toWork);
      let cursor = since ?? "";
      for (const item of items) if (item.updatedAt > cursor) cursor = item.updatedAt;
      // Nothing to take a time from: start a minute back, for a clock that runs ahead of Jira's.
      if (!cursor) cursor = new Date(now() - 60_000).toISOString();
      return { items, cursor };
    },

    async getWork(ref: Ref): Promise<WorkItem | null> {
      let issue: JiraIssue;
      try {
        issue = await client.get<JiraIssue>(`${api}/issue/${encodeURIComponent(ref.id)}?fields=${ISSUE_FIELDS.join(",")}`);
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
      // A moved issue still answers on its old key, with its new key (unconfirmed, research section 1).
      if (issue.key !== ref.id) throw new WorkGone(`${ref.id} was moved on Jira to ${issue.key}.`, issue.key);
      return toWork(issue);
    },
  };

  /** Scope Soup's properties of an entity: the key list, then each of ours. */
  async function propertiesAt(path: string): Promise<Record<string, unknown>> {
    const list = await client.get<{ keys?: { key: string }[] }>(path);
    const found: Record<string, unknown> = {};
    for (const { key } of list.keys ?? []) {
      if (!ours(key)) continue;
      found[key] = (await client.get<JiraProperty>(`${path}/${encodeURIComponent(key)}`)).value;
    }
    return found;
  }

  async function thread(ref: Ref): Promise<JiraThread> {
    const key = encodeURIComponent(ref.id);
    // `expand=properties` on the comment list saves a request per comment where Jira honours it (unconfirmed on both); a
    // comment that comes back without `properties` has them read one by one.
    const comments = await client.paged<JiraComment>(`${api}/issue/${key}/comment?expand=properties`, "comments");
    const read: JiraThreadComment[] = [];
    for (const comment of comments) {
      let properties: Record<string, unknown>;
      if (Array.isArray(comment.properties)) {
        properties = {};
        for (const property of comment.properties) if (ours(property.key)) properties[property.key] = property.value;
      } else {
        properties = await propertiesAt(`${api}/comment/${encodeURIComponent(comment.id)}/properties`);
      }
      const text = textOf(scope, comment.body);
      read.push({ id: comment.id, author: actorOf(comment.author), created: isoTime(comment.created), markdown: text.markdown, simplified: text.simplified, properties });
    }
    return { comments: read, properties: await propertiesAt(`${api}/issue/${key}/properties`) };
  }

  return {
    info,
    work,
    thread,
    simplified: (id) => simplifiedByKey.get(id) ?? [],
    stats: () => client.stats(),
  };
}
