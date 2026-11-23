// A fake GitHub for tests that keeps issues and their dependencies: the issue, and the `dependencies/blocked_by` and
// `dependencies/blocking` lists and writes. Also the issues list, their comments (listed per issue and for the repository,
// posted, deleted) and labels, with ETags and free 304s as GitHub sends them. Also edits of an issue, new issues and
// sub-issue links. Also comment edits (the log comment) and refused comment writes. Also each issue's timeline (closed
// and reopened events) and a close as a duplicate, which needs the target's database id. Also transferred (301) and deleted
// (410) issues, and answers put in by a test (a 502 after GitHub took the post, a 429 with `retry-after`). Also the
// repository's label list. Also the labels' descriptions. Also `state` and `direction` on the issues list, and
// `/user`. Records every call. Never touches the network.

import type { FetchLike } from "./client.ts";
import type { RestComment, RestIssue, RestTimelineEvent } from "./rest.ts";

export const ISSUES_API = "https://api.github.test";

export interface FakeIssues {
  fetch: FetchLike;
  /** `METHOD path`, in order. */
  calls: string[];
  /** The bodies sent, by `METHOD path`. */
  sent: { call: string; body: unknown }[];
  issues: Map<string, RestIssue>;
  /** Issue number -> the database ids of its blockers. */
  blockedBy: Map<string, Set<number>>;
  /** Dependency writes GitHub answers OK to but does not keep. */
  dropsDependencies: boolean;
  /** Issue numbers whose dependency writes GitHub refuses with a 403. */
  refuses: Set<string>;
  /** Issue number -> its comments, oldest first. */
  comments: Map<string, RestComment[]>;
  /** The token's login: comments Scope Soup posts are written as this user. */
  login: string;
  /** GitHub's clock; each write moves it on a second. */
  clock: string;
  /** The repository's labels (created by a POST, listed by a GET). */
  labels: Set<string>;
  /** The descriptions of the repository's labels, by name (listed with them). */
  labelDescriptions: Map<string, string>;
  /** Label writes GitHub answers OK to but does not keep (no push access). */
  dropsLabels: boolean;
  /** A comment from someone else on issue `number` (`association` OWNER, COLLABORATOR, NONE, ...). */
  reply(number: number, login: string, association: string, body: string): RestComment;
  /** Deletes a comment, as a person can on GitHub. */
  deleteComment(id: number): void;
  /** Requests answered 304 (free). */
  notModified: number;
  /** Sub-issue links GitHub refuses with a 403. */
  refusesSubIssues: boolean;
  /** Comment posts and edits GitHub refuses with a 403. */
  refusesComments: boolean;
  /** Issue number -> its timeline, oldest first (only the events the fake makes: `closed`, `reopened`). */
  timeline: Map<string, RestTimelineEvent[]>;
  /** A person reopens issue `number` on GitHub. */
  reopen(number: number): void;
  /** A person transfers issue `number` to another repository: every request for it answers 301 to `to` (an API URL). */
  transfer(number: number, to: string): void;
  /** A person deletes issue `number`: every request for it answers 410. */
  deleteIssue(number: number): void;
  /**
   * The next `times` calls (default 1) that `match` picks are answered with `status` (and `headers`) instead. With `applied`
   * the call takes effect first, as a 502 GitHub sends after it took the post.
   */
  fail(match: (call: string) => boolean, status: number, options?: { headers?: Record<string, string>; times?: number; applied?: boolean }): void;
  /** Called after each call is answered, before the next one: a person's change between Scope Soup's calls. */
  onCall?: (call: string) => void;
  /** Forgets the calls so far. */
  clear(): void;
}

function etagOf(body: unknown): string {
  const text = JSON.stringify(body);
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return `"${text.length}-${hash}"`;
}

const labelsOf = (issue: RestIssue): string[] => issue.labels.map((label) => (typeof label === "string" ? label : label.name));

/** `repo` is "owner/name"; each issue number gets the database id 9000 + its number. Issues of `others` live in other repositories. */
export function fakeIssues(repo: string, numbers: number[], others: { repo: string; number: number; id: number }[] = []): FakeIssues {
  const issues = new Map<string, RestIssue>();
  const byPath = new Map<string, RestIssue>();
  const add = (where: string, number: number, id: number): RestIssue => {
    const issue: RestIssue = {
      number, id, title: `Tide table ${number}`, body: "Show the tides.", state: "open", state_reason: null, labels: [], assignees: [],
      updated_at: "2026-11-22T09:00:00Z", html_url: `https://github.test/${where}/issues/${number}`,
    };
    byPath.set(`/repos/${where}/issues/${number}`, issue);
    return issue;
  };
  for (const number of numbers) issues.set(String(number), add(repo, number, 9000 + number));
  for (const other of others) add(other.repo, other.number, other.id);
  const byId = (id: number): RestIssue | undefined => [...byPath.values()].find((issue) => issue.id === id);
  const R = `/repos/${repo}/issues/`;
  let nextComment = 50_000;

  const tick = (): string => (fake.clock = new Date(Date.parse(fake.clock) + 1000).toISOString().replace(".000Z", "Z"));
  const addComment = (number: number, login: string, association: string, body: string): RestComment => {
    const at = tick();
    const comment: RestComment = { id: nextComment++, body, user: { login }, author_association: association, created_at: at, updated_at: at, issue_url: `${ISSUES_API}${R}${number}` };
    fake.comments.set(String(number), [...(fake.comments.get(String(number)) ?? []), comment]);
    // A comment bumps its issue's updated_at.
    const issue = issues.get(String(number));
    if (issue) issue.updated_at = at;
    return comment;
  };

  /** Issue number -> the answer every request for it gets (transferred or deleted). */
  const gone = new Map<string, { status: number; body: unknown; headers: Record<string, string> }>();
  const failures: { match: (call: string) => boolean; status: number; headers: Record<string, string>; times: number; applied: boolean }[] = [];
  const leave = (number: number, answer: { status: number; body: unknown; headers: Record<string, string> }): void => {
    gone.set(String(number), answer);
    issues.delete(String(number));
    fake.comments.delete(String(number));
  };

  const event = (number: number, name: string): void => {
    fake.timeline.set(String(number), [...(fake.timeline.get(String(number)) ?? []), { event: name, created_at: fake.clock }]);
  };

  const fake: FakeIssues = {
    calls: [], sent: [], issues, blockedBy: new Map(), dropsDependencies: false, refuses: new Set(),
    comments: new Map(), labels: new Set(), labelDescriptions: new Map(), login: "scopesoup-bot", clock: "2026-11-22T09:00:00Z", dropsLabels: false, notModified: 0, refusesSubIssues: false, refusesComments: false,
    reply: (number, login, association, body) => addComment(number, login, association, body),
    timeline: new Map(),
    reopen(number) {
      const issue = issues.get(String(number))!;
      Object.assign(issue, { state: "open", state_reason: "reopened", updated_at: tick() });
      event(number, "reopened");
    },
    deleteComment(id) {
      for (const [number, list] of fake.comments) fake.comments.set(number, list.filter((comment) => comment.id !== id));
    },
    transfer(number, to) {
      leave(number, { status: 301, body: { message: "Moved Permanently", url: to }, headers: { location: to } });
    },
    deleteIssue(number) {
      leave(number, { status: 410, body: { message: "This issue was deleted" }, headers: {} });
    },
    fail(match, status, options = {}) {
      failures.push({ match, status, headers: options.headers ?? {}, times: options.times ?? 1, applied: options.applied === true });
    },
    clear() {
      fake.calls.length = 0;
      fake.sent.length = 0;
    },
    async fetch(url, init) {
      const method = init?.method ?? "GET";
      const path = url.replace(ISSUES_API, "");
      const call = `${method} ${path}`;
      fake.calls.push(call);
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      if (body) fake.sent.push({ call, body });
      const since = new URLSearchParams(path.split("?")[1] ?? "").get("since");
      // The part after `/repos/{repo}/issues/` without the query, split: ["12", "comments"], ["comments", "5"], ...
      const rest = path.startsWith(R) ? path.slice(R.length).split("?")[0]!.split("/") : [];
      const own = rest[0] !== undefined ? issues.get(rest[0]) : undefined;
      const blockers = (number: string): RestIssue[] => [...(fake.blockedBy.get(number) ?? [])].map(byId).filter((each): each is RestIssue => each !== undefined);
      let answer: [number, unknown] = [404, { message: "Not Found" }];
      const dependency = path.startsWith(R) ? /^(\d+)\/dependencies\/(blocked_by|blocking)(?:\/(\d+))?(?:\?.*)?$/.exec(path.slice(R.length)) : null;
      const left = rest[0] !== undefined ? gone.get(rest[0]) : undefined;
      const failure = failures.find((each) => each.times > 0 && each.match(call));
      if (failure) failure.times -= 1;
      const headers = new Map<string, string>(Object.entries(left?.headers ?? failure?.headers ?? {}));
      if (left) answer = [left.status, left.body];
      else if (failure && !failure.applied) answer = [failure.status, { message: `Synthetic ${failure.status}` }];
      else if (method === "GET" && path === "/user") answer = [200, { login: fake.login, type: "User" }];
      else if (method === "GET" && byPath.has(path)) {
        const issue = structuredClone(byPath.get(path)!);
        const open = blockers(String(issue.number)).filter((each) => each.state === "open").length;
        if (path.startsWith(R)) issue.issue_dependencies_summary = { blocked_by: open, total_blocked_by: blockers(String(issue.number)).length };
        answer = [200, issue];
      } else if (method === "GET" && path.startsWith(`${R}comments?`)) {
        const all = [...fake.comments.values()].flat().filter((comment) => !since || (comment.updated_at ?? comment.created_at) >= since);
        answer = [200, all.sort((a, b) => (a.updated_at ?? "").localeCompare(b.updated_at ?? "") || a.id - b.id)];
      } else if (method === "GET" && path.startsWith(`${R.slice(0, -1)}?`)) {
        // `state` (default open) and `direction` (default asc) are read as GitHub reads them.
        const query = new URLSearchParams(path.split("?")[1] ?? "");
        const state = query.get("state") ?? "open";
        const listed = [...issues.values()].filter((issue) => (!since || issue.updated_at >= since) && (state === "all" || issue.state === state));
        const sorted = listed.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
        if (query.get("direction") === "desc") sorted.reverse();
        answer = [200, sorted.map((issue) => structuredClone(issue))];
      } else if (method === "GET" && own && rest[1] === "comments" && rest.length === 2) answer = [200, fake.comments.get(rest[0]!) ?? []];
      else if (method === "GET" && own && rest[1] === "timeline" && rest.length === 2) answer = [200, fake.timeline.get(rest[0]!) ?? []];
      else if ((method === "POST" || method === "PATCH") && fake.refusesComments && (rest[1] === "comments" || rest[0] === "comments")) answer = [403, { message: "Resource not accessible by personal access token" }];
      else if (method === "POST" && own && rest[1] === "comments" && rest.length === 2) answer = [201, addComment(own.number, fake.login, "OWNER", String(body?.body))];
      else if (method === "PATCH" && rest[0] === "comments" && rest[1]) {
        const comment = [...fake.comments.values()].flat().find((each) => each.id === Number(rest[1]));
        if (comment) {
          comment.body = String(body?.body);
          // An edit moves the comment's updated_at, not its issue's.
          comment.updated_at = tick();
          answer = [200, structuredClone(comment)];
        }
      }
      else if (method === "DELETE" && rest[0] === "comments" && rest[1]) {
        fake.deleteComment(Number(rest[1]));
        answer = [204, null];
      } else if (method === "GET" && path.startsWith(`/repos/${repo}/labels?`)) {
        answer = [200, [...fake.labels].map((name) => ({ name, description: fake.labelDescriptions.get(name) ?? null }))];
      } else if (method === "POST" && path === `/repos/${repo}/labels`) {
        const name = String(body?.name);
        answer = fake.labels.has(name) ? [422, { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists" }] }] : [201, body];
        fake.labels.add(name);
      } else if (method === "POST" && own && rest[1] === "labels" && rest.length === 2) {
        if (!fake.dropsLabels) for (const name of body?.labels as string[]) if (!labelsOf(own).includes(name)) own.labels.push({ name });
        own.updated_at = tick();
        answer = [200, own.labels];
      } else if (method === "DELETE" && own && rest[1] === "labels" && rest[2]) {
        const index = labelsOf(own).indexOf(decodeURIComponent(rest[2]));
        if (index < 0) answer = [404, { message: "Label does not exist" }];
        else {
          if (!fake.dropsLabels) own.labels.splice(index, 1);
          own.updated_at = tick();
          answer = [200, own.labels];
        }
      } else if (method === "PATCH" && own && rest.length === 1 && body?.state_reason === "duplicate" && !byId(Number(body.duplicate_issue_id))) {
        answer = [422, { message: "Validation Failed: duplicate_issue_id must name an issue" }];
      } else if (method === "PATCH" && own && rest.length === 1) {
        const was = own.state;
        for (const field of ["title", "body", "state", "state_reason"] as const) if (body?.[field] !== undefined) Object.assign(own, { [field]: body[field] });
        own.updated_at = tick();
        if (own.state !== was) event(own.number, own.state === "open" ? "reopened" : "closed");
        answer = [200, structuredClone(own)];
      } else if (method === "POST" && path === R.slice(0, -1)) {
        const number = Math.max(...[...issues.values()].map((issue) => issue.number)) + 1;
        const issue = add(repo, number, 9000 + number);
        Object.assign(issue, { title: String(body?.title), body: typeof body?.body === "string" ? body.body : null, updated_at: tick() });
        issues.set(String(number), issue);
        answer = [201, structuredClone(issue)];
      } else if (method === "POST" && own && rest[1] === "sub_issues" && rest.length === 2) {
        const child = byId(Number(body?.sub_issue_id));
        if (fake.refusesSubIssues) answer = [403, { message: "Resource not accessible by personal access token" }];
        else if (child) {
          child.parent_issue_url = `${ISSUES_API}${R}${own.number}`;
          child.updated_at = tick();
          answer = [201, structuredClone(own)];
        }
      } else if (dependency && issues.has(dependency[1]!)) {
        const [, number, side, removed] = dependency as unknown as [string, string, string, string | undefined];
        const own = issues.get(number)!;
        if (method === "GET" && side === "blocked_by") answer = [200, blockers(number)];
        else if (method === "GET" && side === "blocking") answer = [200, [...fake.blockedBy].filter(([, ids]) => ids.has(own.id)).map(([other]) => issues.get(other))];
        else if (fake.refuses.has(number)) answer = [403, { message: "Resource not accessible by personal access token" }];
        else if (method === "POST" && side === "blocked_by") {
          if (!fake.dropsDependencies) fake.blockedBy.set(number, new Set([...(fake.blockedBy.get(number) ?? []), Number(body?.issue_id)]));
          answer = [201, own];
        } else if (method === "DELETE" && side === "blocked_by" && removed) {
          if (!fake.dropsDependencies) fake.blockedBy.get(number)?.delete(Number(removed));
          answer = [200, own];
        }
      }
      if (failure?.applied) answer = [failure.status, { message: `Synthetic ${failure.status}` }];
      fake.onCall?.(call);
      if (method === "GET" && answer[0] === 200) {
        const etag = etagOf(answer[1]);
        headers.set("etag", etag);
        if (init?.headers?.["If-None-Match"] === etag) {
          fake.notModified += 1;
          answer = [304, null];
        }
      }
      const [status, sent] = answer;
      return { status, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null }, json: async () => sent, text: async () => JSON.stringify(sent) };
    },
  };
  return fake;
}
