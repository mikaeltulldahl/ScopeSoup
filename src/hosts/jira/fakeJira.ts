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

const JQL = /^project = "([A-Z][A-Z0-9_]*)"(?: AND updated >= "(\d{4}-\d{2}-\d{2} \d{2}:\d{2})")?( AND statusCategory != Done)? ORDER BY updated ASC, key ASC$/;

export function fakeJira(setup: FakeJiraSetup): FakeJira {
  const site = (setup.site ?? (setup.deployment === "cloud" ? FAKE_SITE : FAKE_DC_SITE)).replace(/\/+$/, "");
  const api = setup.deployment === "cloud" ? "/rest/api/3" : "/rest/api/2";
  const auth = setup.deployment === "cloud" ? `Basic ${Buffer.from(`${setup.email ?? ""}:${setup.token}`).toString("base64")}` : `Bearer ${setup.token}`;
  const issues = new Map((setup.issues ?? []).map((issue) => [issue.key, issue]));
  const pageSize = setup.pageSize ?? 100;
  const comments = (setup.comments ??= {});
  const issueProperties = (setup.issueProperties ??= {});
  const commentProperties = (setup.commentProperties ??= {});
  let tick = Date.parse("2026-11-21T08:00:00.000Z");
  const writes: FakeWriteState = {
    deployment: setup.deployment, site, user: setup.user, project: setup.project ?? "DEMO", issues, comments, issueProperties, commentProperties,
    people: [setup.user, ...(setup.people ?? [])], assignable: setup.assignable, commentLimit: setup.commentLimit ?? 32_767,
    now: setup.now ?? (() => (tick += 1000)),
    ids: { comment: 40_000, link: 50_000, issue: 60_000 },
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
    const match = JQL.exec(jql);
    if (!match) return refuse(400, `The fake does not know this JQL: ${jql}`);
    const [, project, from, open] = match;
    return [...issues.values()]
      .filter((issue) => issue.key.startsWith(`${project}-`))
      .filter((issue) => !from || jqlTime(isoTime(issue.fields.updated), timeZone) >= from)
      .filter((issue) => !open || issue.fields.status?.statusCategory?.key !== "done")
      .sort((a, b) => isoTime(a.fields.updated).localeCompare(isoTime(b.fields.updated)) || KEY_NUMBER(a.key) - KEY_NUMBER(b.key));
  }

  function route(method: string, path: string, query: URLSearchParams, body: unknown): FetchResponse {
    if (!path.startsWith(`${api}/`)) return refuse(404, "No such API on this deployment.");
    const rest = path.slice(api.length);
    if (method === "GET" && rest === "/myself") return answer(200, setup.user);
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
      return answer(200, withFields(issue, query.get("fields")?.split(",") ?? null));
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
      else if (headers.Authorization !== auth) response = answer(401, "Unauthorized");
      else if (failures.some((each) => each.times > 0 && each.path.test(path))) {
        const failure = failures.find((each) => each.times > 0 && each.path.test(path))!;
        failure.times -= 1;
        response = refuse(failure.status, "The fake was told to fail this request.");
      } else if (limited) {
        limited.times -= 1;
        if (limited.times <= 0) limits.shift();
        response = answer(429, { errorMessages: ["Rate limit exceeded."] }, limited.headers);
      } else response = route(method, path, parsed.searchParams, body);
      calls.push({ method, path: url.slice(site.length), status: response.status, headers, ...(body !== undefined ? { body } : {}) });
      return response;
    },
  };
  return fake;
}
