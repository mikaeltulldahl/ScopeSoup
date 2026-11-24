// The Jira host: one Jira project (Cloud or Data Center) as a host of work items. It writes only with `allowWrites`
// (write.ts). With `conventions`, Scope Soup's questions, answers, drafts, decisions, claims and log are read into each item
// (conventions.ts). Jira has no pull requests: a Jira project's changes stay on its git remote.

import type { Actor, Priority, Ref, WorkItem } from "../../model/types.ts";
import type { Capability, Cursor, Host, HostInfo, Page, WorkPort, WritePort } from "../../ports/host.ts";
import { WorkGone } from "../../ports/host.ts";
import type { Deployment, FetchLike, JiraClient } from "./client.ts";
import { createJiraClient, JiraError } from "./client.ts";
import type { JiraScope } from "./map.ts";
import { actorOf, DEFAULT_ABANDONED_RESOLUTIONS, DEFAULT_BLOCKS_LINK, DEFAULT_PRIORITIES, ISSUE_FIELDS, isoTime, issueToWork, jqlString, jqlTime, PROPERTY_PREFIX, projectOf, textOf, workRef } from "./map.ts";
import type { JiraComment, JiraIssue, JiraProperty, JiraUser } from "./rest.ts";
import type { JiraRead } from "./conventions.ts";
import { applyJiraThread, readJiraThread } from "./conventions.ts";
import type { TransitionTarget } from "./write.ts";
import { createJiraWrite, DEFAULT_CHILD_ISSUE_TYPE, DEFAULT_DUPLICATE_LINK, DEFAULT_ISSUE_TYPE, DEFAULT_RELATES_LINK, DEFAULT_RESOLUTIONS, DEFAULT_TRANSITIONS, descriptionSha, JIRA_COMMENT_LIMIT } from "./write.ts";

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
  /** Read Scope Soup's comment and issue properties into each item: more requests per changed issue. */
  conventions?: boolean;
  /** Must be true for the host to get a write port. */
  allowWrites?: boolean;
  /** This machine's name in Scope Soup's claims. Claims need it, the conventions and writes. */
  machine?: string;
  /** The issue type of a new Item. Default "Task". */
  issueType?: string;
  /** The issue type of a split's child, created under its parent. Default "Sub-task". */
  childIssueType?: string;
  /** The transition (or the status it goes to) Scope Soup uses per target; defaults `DEFAULT_TRANSITIONS`. */
  transitions?: Partial<Record<TransitionTarget, string>>;
  /** The resolution a transition's screen gets, when it asks for one; defaults `DEFAULT_RESOLUTIONS`. */
  resolutions?: Partial<Record<"done" | "abandoned" | "duplicate", string>>;
  /** The link type from a follow-up to the Item it came from. Default "Relates". */
  relatesLink?: string;
  /** The link type from a duplicate to its original. Default "Duplicate". */
  duplicateLink?: string;
  /** About the most a comment Scope Soup posts may hold. Default `JIRA_COMMENT_LIMIT`. */
  commentLimit?: number;
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
  /** An issue's comments and Scope Soup's comment and issue properties, as read. */
  thread(ref: Ref): Promise<JiraThread>;
  /** The same through the trust rule, as the conventions read it. */
  read(ref: Ref): Promise<JiraRead>;
  write?: WritePort;
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

  const commentLimit = config.commentLimit ?? JIRA_COMMENT_LIMIT;
  const claims = config.conventions && config.allowWrites && config.machine ? config.machine : undefined;
  const info: HostInfo = {
    id: scope.host,
    capabilities: new Set<Capability>(config.allowWrites ? ["work", "write"] : ["work"]),
    whoami: async () => (await myself()).actor,
    commentLimit,
    ...(claims ? { claimMachine: claims } : {}),
  };
  /** The sha256 of each issue's description as last read: is a draft's original still the description? */
  const bodyShas = new Map<string, string>();

  const toWork = (issue: JiraIssue): WorkItem => {
    bodyShas.set(issue.key, descriptionSha(issue.fields.description));
    const { item, simplified } = issueToWork(scope, issue);
    if (simplified.length > 0) simplifiedByKey.set(issue.key, simplified);
    else simplifiedByKey.delete(issue.key);
    return item;
  };

  const plainWork: WorkPort = {
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

  /** The token's own account, lower case, or null when it cannot be read (then only people's answers count). */
  async function selfId(): Promise<string | null> {
    try {
      return (await myself()).actor.id.toLowerCase();
    } catch {
      return null;
    }
  }

  async function read(ref: Ref): Promise<JiraRead> {
    return readJiraThread(scope.host, ref, await thread(ref), await selfId());
  }

  /** Issues with an open question: read again each listing, so a deleted question comment is seen. */
  const parked = new Set<string>();
  const fill = async (item: WorkItem): Promise<WorkItem> => {
    const filled = applyJiraThread(item, await read(item.ref), (sha) => !!sha && bodyShas.get(item.ref.id) === sha, now());
    if ((filled.openQuestions?.length ?? 0) > 0) parked.add(item.ref.id);
    else parked.delete(item.ref.id);
    return filled;
  };

  // With the conventions, every listed or fetched issue gets its comments and properties read: a comment bumps the issue's
  // `updated` [known], so a new answer lists its issue.
  const work: WorkPort = config.conventions
    ? {
      async listWork(since) {
        const page = await plainWork.listWork(since);
        const listed = new Set(page.items.map((item) => item.ref.id));
        const items = [...page.items];
        const removed: Ref[] = [];
        const movedTo: Record<string, string> = {};
        for (const id of [...parked]) {
          if (listed.has(id)) continue;
          const ref = workRef(scope, id);
          try {
            const item = await plainWork.getWork(ref);
            if (item) items.push(item);
            else {
              parked.delete(id);
              removed.push(ref);
            }
          } catch (error) {
            if (!(error instanceof WorkGone)) throw error;
            parked.delete(id);
            removed.push(ref);
            if (error.movedTo) movedTo[`${ref.host}:${ref.kind}:${ref.id}`] = error.movedTo;
          }
        }
        for (const item of items) await fill(item);
        return { ...page, items, ...(removed.length > 0 ? { removed: [...(page.removed ?? []), ...removed], movedTo: { ...page.movedTo, ...movedTo } } : {}) };
      },
      async getWork(ref) {
        const item = await plainWork.getWork(ref);
        return item ? fill(item) : null;
      },
    }
    : plainWork;

  const write = config.allowWrites
    ? createJiraWrite({
      client, scope,
      settings: {
        issueType: config.issueType ?? DEFAULT_ISSUE_TYPE,
        childIssueType: config.childIssueType ?? DEFAULT_CHILD_ISSUE_TYPE,
        transitions: { ...DEFAULT_TRANSITIONS, ...config.transitions },
        resolutions: { ...DEFAULT_RESOLUTIONS, ...config.resolutions },
        relatesLink: config.relatesLink ?? DEFAULT_RELATES_LINK,
        duplicateLink: config.duplicateLink ?? DEFAULT_DUPLICATE_LINK,
        commentLimit,
      },
      ...(claims ? { machine: claims } : {}),
      self: async () => (await myself()).actor.id,
      read,
      now,
    })
    : undefined;
  // The conventions' writes are read back only with the conventions on.
  if (write && !config.conventions) {
    for (const name of ["askQuestions", "answerQuestion", "answerQuestions", "withdrawQuestions", "postDraft", "checkDraft", "logLine", "settleQuestions", "postAssumptions", "settleAssumptions"] as const) delete write[name];
  }

  // The labels the triage may propose: every label on the site (Cloud's `GET /label`; Data Center has no such list [known]).
  if (scope.deployment === "cloud") work.labels = async () => (await client.paged<string>(`${api}/label`, "values")).map((name) => ({ name }));

  return {
    info,
    work,
    ...(write ? { write } : {}),
    thread,
    read,
    simplified: (id) => simplifiedByKey.get(id) ?? [],
    stats: () => client.stats(),
  };
}
