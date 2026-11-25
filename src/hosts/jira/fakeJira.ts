// A fake Jira site for tests, Cloud or Data Center flavour: an in-memory project behind a `FetchLike`. It answers only the
// requests the host sends and refuses what Jira refuses: a wrong token (401), the removed Cloud `/search` (410), a JQL it does
// not know (400), the other deployment's API version (404). It compares `updated` in JQL to the minute, in the user's time
// zone, so overlap and zone bugs show. 429s with Retry-After on demand. Never touches the network.
// The response shapes are hand-written from Atlassian's documentation; those docs/research/jira.md marks [known] are unconfirmed.

import type { FetchLike, FetchResponse } from "../github/client.ts";
import type { Deployment } from "./client.ts";
import { isoTime, jqlTime } from "./map.ts";
import type { JiraComment, JiraIssue, JiraUser } from "./rest.ts";
import type { FakeWriteState } from "./fakeJiraWrites.ts";
import { routeWrite } from "./fakeJiraWrites.ts";

export const FAKE_SITE = "https://example.atlassian.net";
export const FAKE_DC_SITE = "https://jira.example.test";

export interface FakeJiraSetup {
  deployment: Deployment;
  site?: string;
  token: string;
  /** Cloud: the email of Basic authentication. */
  email?: string;
  user: JiraUser;
  issues?: JiraIssue[];
  comments?: Record<string, JiraComment[]>;
  /** Issue key -> property key -> value. */
  issueProperties?: Record<string, Record<string, unknown>>;
  /** Comment id -> property key -> value. */
  commentProperties?: Record<string, Record<string, unknown>>;
  /** Old key -> new key: a moved issue still answers on its old key. */
  moved?: Record<string, string>;
  /** Results per page at most (Jira's own cap is larger). Default 100. */
  pageSize?: number;
  /** The project writes go to. Default "DEMO". */
  project?: string;
  /** The components the project has: a new issue naming another is refused with 400. Default: any name. */
  components?: string[];
  /** People who may be assignees, besides `user`. */
  people?: JiraUser[];
  /** The comment length limit. Default 32,767. */
  commentLimit?: number;
  /** The fake's clock for `updated` and `created` stamps of writes, milliseconds. Default a fixed time, one second more per write. */
  now?: () => number;
  /** Whether Cloud's comment list answers `expand=properties` with an empty list on every comment. */
  emptyExpand?: boolean;
  /** Who may be assigned in the project (the assignable-user search). Default `user` and `people`. */
  assignable?: JiraUser[];
  /** Other accounts with their own tokens (a person's), acting as themselves: `/myself`, comment authors. Add them to `people` too. */
  others?: { token: string; email?: string; user: JiraUser }[];
}

export interface FakeJiraCall {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface FakeJira {
  fetch: FetchLike;
  calls: FakeJiraCall[];
  issues: Map<string, JiraIssue>;
  /** Issue key -> comments, as the writes leave them. */
  comments: Record<string, JiraComment[]>;
  issueProperties: Record<string, Record<string, unknown>>;
  commentProperties: Record<string, Record<string, unknown>>;
  /** The next `times` requests are answered 429 with these headers. */
  limit(times: number, headers: Record<string, string>): void;
  /** Paths (method and status) requested since the last call of this. */
  take(): string[];
  /** The next `times` requests whose path matches `path` are answered with `status`. */
  fail(path: RegExp, status: number, times: number): void;
}

const KEY_NUMBER = (key: string): number => Number(/-(\d+)$/.exec(key)?.[1] ?? 0);

const JQL_REST = /^(?: AND updated >= "(\d{4}-\d{2}-\d{2} \d{2}:\d{2})")?( AND statusCategory != Done)?(?: AND key = "([A-Z][A-Z0-9_]*-\d+)")? ORDER BY updated ASC, key ASC$/;

/** The JQL the fake knows: `project = "X"`, then ` AND (filter)`, then the rest. The filter's text is parsed by `matchesFilter`. */
function parseJql(jql: string): { project: string; filter: string | null; from?: string; open: boolean; key?: string } | null {
  const head = /^project = "([A-Z][A-Z0-9_]*)"/.exec(jql);
  if (!head) return null;
  let rest = jql.slice(head[0].length);
  let filter: string | null = null;
  if (rest.startsWith(" AND (")) {
    let depth = 1;
    let quote: string | null = null;
    let at = 6;
    for (; at < rest.length && depth > 0; at += 1) {
      const char = rest[at]!;
      if (quote) {
        if (char === "\\") at += 1;
        else if (char === quote) quote = null;
      } else if (char === '"') quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
    }
    if (depth > 0) return null;
    filter = rest.slice(6, at - 1);
    rest = rest.slice(at);
  }
  const match = JQL_REST.exec(rest);
  if (!match) return null;
  return { project: head[1]!, filter, ...(match[1] ? { from: match[1] } : {}), open: Boolean(match[2]), ...(match[3] ? { key: match[3] } : {}) };
}

/**
 * A small subset of JQL for a filter: clauses joined by AND, each `component = "Board"` or `labels = scopesoup` (a name bare or
 * in double quotes). Null when a clause is outside the subset, which the fake answers with 400 as Jira does for JQL it cannot parse.
 */
export function matchesFilter(issue: JiraIssue, filter: string): boolean | null {
  const clauses = filter.split(/\s+AND\s+/i).map((clause) => /^(component|labels)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s"()]+))$/i.exec(clause.trim()));
  if (clauses.some((match) => !match)) return null;
  return clauses.every((match) => {
    const wanted = (match![2] ?? match![3] ?? "").replace(/\\(.)/g, "$1").toLowerCase();
    const names = match![1]!.toLowerCase() === "labels" ? (issue.fields.labels ?? []) : (issue.fields.components ?? []).map((each) => each.name);
    return names.some((name) => name.toLowerCase() === wanted);
  });
}

export function fakeJira(setup: FakeJiraSetup): FakeJira {
  const site = (setup.site ?? (setup.deployment === "cloud" ? FAKE_SITE : FAKE_DC_SITE)).replace(/\/+$/, "");
  const api = setup.deployment === "cloud" ? "/rest/api/3" : "/rest/api/2";
  const authOf = (token: string, email: string | undefined): string => (setup.deployment === "cloud" ? `Basic ${Buffer.from(`${email ?? ""}:${token}`).toString("base64")}` : `Bearer ${token}`);
  const accounts = new Map([[authOf(setup.token, setup.email), setup.user], ...(setup.others ?? []).map((other): [string, JiraUser] => [authOf(other.token, other.email), other.user])]);
  const issues = new Map((setup.issues ?? []).map((issue) => [issue.key, issue]));
  const pageSize = setup.pageSize ?? 100;
  const comments = (setup.comments ??= {});
  const issueProperties = (setup.issueProperties ??= {});
  const commentProperties = (setup.commentProperties ??= {});
  let tick = Date.parse("2026-11-21T08:00:00.000Z");
  const writes: FakeWriteState = {
    deployment: setup.deployment, site, user: setup.user, project: setup.project ?? "DEMO", components: setup.components, issues, comments, issueProperties, commentProperties,
    people: [setup.user, ...(setup.people ?? [])], assignable: setup.assignable, commentLimit: setup.commentLimit ?? 32_767,
    now: setup.now ?? (() => (tick += 1000)),
    ids: { comment: 40_000, link: 50_000, issue: 60_000 },
    changelog: {},
  };
  const calls: FakeJiraCall[] = [];
  const limits: { times: number; headers: Record<string, string> }[] = [];
  const failures: { path: RegExp; status: number; times: number }[] = [];
  let taken = 0;

  const answer = (status: number, body: unknown, headers: Record<string, string> = {}): FetchResponse => {
    const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    return {
      status,
      headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
      json: async () => body,
      text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  const refuse = (status: number, message: string): FetchResponse => answer(status, { errorMessages: [message], errors: {} });

  const timeZone = setup.user.timeZone ?? "UTC";
  const withFields = (issue: JiraIssue, fields: string[] | null): JiraIssue => {
    if (!fields) return issue;
    const picked: Record<string, unknown> = {};
    for (const name of fields) if (name in issue.fields) picked[name] = (issue.fields as Record<string, unknown>)[name];
    return { ...issue, fields: picked };
  };

  function search(jql: string): JiraIssue[] | FetchResponse {
    const parsed = parseJql(jql);
    if (!parsed) return refuse(400, `The fake does not know this JQL: ${jql}`);
    const { project, filter, from, open, key } = parsed;
    if (filter !== null && matchesFilter({ id: "", key: "", fields: {} }, filter) === null) return refuse(400, `The fake does not know this JQL filter: ${filter}`);
    return [...issues.values()]
      .filter((issue) => issue.key.startsWith(`${project}-`))
      .filter((issue) => key === undefined || issue.key === key)
      .filter((issue) => filter === null || matchesFilter(issue, filter))
      .filter((issue) => !from || jqlTime(isoTime(issue.fields.updated), timeZone) >= from)
      .filter((issue) => !open || issue.fields.status?.statusCategory?.key !== "done")
      .sort((a, b) => isoTime(a.fields.updated).localeCompare(isoTime(b.fields.updated)) || KEY_NUMBER(a.key) - KEY_NUMBER(b.key));
  }

  function route(method: string, path: string, query: URLSearchParams, body: unknown): FetchResponse {
    if (!path.startsWith(`${api}/`)) return refuse(404, "No such API on this deployment.");
    const rest = path.slice(api.length);
    if (method === "GET" && rest === "/myself") return answer(200, writes.user);
    if (rest === "/search" && setup.deployment === "cloud") return refuse(410, "This endpoint was removed; use /rest/api/3/search/jql.");
    if (method === "POST" && rest === "/search/jql" && setup.deployment === "cloud") {
      const request = (body ?? {}) as { jql?: string; fields?: string[]; maxResults?: number; nextPageToken?: string };
      const found = search(request.jql ?? "");
      if (!Array.isArray(found)) return found;
      const start = Number(request.nextPageToken ?? 0);
      const size = Math.min(request.maxResults ?? 50, pageSize);
      const page = found.slice(start, start + size).map((issue) => withFields(issue, request.fields ?? null));
      const more = start + size < found.length;
      return answer(200, { issues: page, isLast: !more, ...(more ? { nextPageToken: String(start + size) } : {}) });
    }
    if (method === "GET" && rest === "/search" && setup.deployment === "datacenter") {
      const found = search(query.get("jql") ?? "");
      if (!Array.isArray(found)) return found;
      const start = Number(query.get("startAt") ?? 0);
      const size = Math.min(Number(query.get("maxResults") ?? 50), pageSize);
      const fields = query.get("fields")?.split(",") ?? null;
      return answer(200, { startAt: start, maxResults: size, total: found.length, issues: found.slice(start, start + size).map((issue) => withFields(issue, fields)) });
    }
    let match = /^\/issue\/([^/]+)$/.exec(rest);
    if (method === "GET" && match?.[1]) {
      const key = decodeURIComponent(match[1]);
      const issue = issues.get(setup.moved?.[key] ?? key);
      if (!issue) return refuse(404, "Issue does not exist or you do not have permission to see it.");
      const histories = writes.changelog[issue.key] ?? [];
      const changelog = (query.get("expand") ?? "").split(",").includes("changelog") ? { changelog: { startAt: 0, maxResults: histories.length, total: histories.length, histories } } : {};
      return answer(200, { ...withFields(issue, query.get("fields")?.split(",") ?? null), ...changelog });
    }
    match = /^\/issue\/([^/]+)\/comment$/.exec(rest);
    if (method === "GET" && match?.[1]) {
      const key = decodeURIComponent(match[1]);
      if (!issues.has(key)) return refuse(404, "Issue does not exist or you do not have permission to see it.");
      const all = setup.comments?.[key] ?? [];
      const start = Number(query.get("startAt") ?? 0);
      const size = Math.min(Number(query.get("maxResults") ?? 50), pageSize);
      // Only the Cloud flavour expands properties on the list, so both of the host's paths are tried.
      const expand = setup.deployment === "cloud" && (query.get("expand") ?? "").split(",").includes("properties");
      const comments = all.slice(start, start + size).map((comment) =>
        expand ? { ...comment, properties: setup.emptyExpand ? [] : Object.entries(setup.commentProperties?.[comment.id] ?? {}).map(([property, value]) => ({ key: property, value })) } : comment,
      );
      return answer(200, { startAt: start, maxResults: size, total: all.length, comments });
    }
    match = /^\/(issue|comment)\/([^/]+)\/properties(?:\/([^/]+))?$/.exec(rest);
    if (method === "GET" && match?.[1] && match[2]) {
      const id = decodeURIComponent(match[2]);
      const store = match[1] === "issue" ? setup.issueProperties?.[id] : setup.commentProperties?.[id];
      if (match[1] === "issue" && !issues.has(id)) return refuse(404, "Issue does not exist or you do not have permission to see it.");
      if (match[3] === undefined) return answer(200, { keys: Object.keys(store ?? {}).map((key) => ({ key, self: `${site}${path}/${key}` })) });
      const key = decodeURIComponent(match[3]);
      if (!store || !(key in store)) return refuse(404, `The property with key '${key}' does not exist.`);
      return answer(200, { key, value: store[key] });
    }
    const written = routeWrite(writes, method, rest, query, body, answer, refuse);
    if (written) return written;
    return refuse(404, `The fake does not serve ${method} ${path}.`);
  }

  const fake: FakeJira = {
    calls,
    issues,
    comments,
    issueProperties,
    commentProperties,
    limit(times, headers) {
      limits.push({ times, headers });
    },
    fail(path, status, times) {
      failures.push({ path, status, times });
    },
    take() {
      const fresh = calls.slice(taken).map((call) => `${call.status} ${call.method} ${call.path}`);
      taken = calls.length;
      return fresh;
    },
    async fetch(url, init) {
      const method = init?.method ?? "GET";
      const headers = init?.headers ?? {};
      const parsed = new URL(url);
      const path = url.slice(site.length).split("?")[0] ?? "";
      const body: unknown = init?.body ? JSON.parse(init.body) : undefined;
      let response: FetchResponse;
      const limited = limits[0];
      if (!url.startsWith(`${site}/`)) response = refuse(404, "Another site.");
      else if (!accounts.has(headers.Authorization ?? "")) response = answer(401, "Unauthorized");
      else if (failures.some((each) => each.times > 0 && each.path.test(path))) {
        const failure = failures.find((each) => each.times > 0 && each.path.test(path))!;
        failure.times -= 1;
        response = refuse(failure.status, "The fake was told to fail this request.");
      } else if (limited) {
        limited.times -= 1;
        if (limited.times <= 0) limits.shift();
        response = answer(429, { errorMessages: ["Rate limit exceeded."] }, limited.headers);
      } else {
        // The request acts as the token's account.
        writes.user = accounts.get(headers.Authorization ?? "")!;
        response = route(method, path, parsed.searchParams, body);
      }
      calls.push({ method, path: url.slice(site.length), status: response.status, headers, ...(body !== undefined ? { body } : {}) });
      return response;
    },
  };
  return fake;
}
