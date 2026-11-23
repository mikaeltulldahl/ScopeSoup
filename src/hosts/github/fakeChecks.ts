// A fake GitHub for the merge queue's wait for CI: pull requests (listed by head, opened), the check runs and commit
// statuses of a commit, and a job's log. Like GitHub, a new pull request's head is its branch's commit, and it shows as merged once
// that commit is on its base branch; a test answers both from its git remote (`branches`). Also the token's login, comments on
// a pull request, closing it, deleting a branch (which closes an open pull request from it, as on GitHub), and failures put in by a
// test. Records every call. Never touches the network.

import type { FetchLike, FetchResponse } from "./client.ts";
import type { RestCheckRun, RestComment, RestPull, RestStatus } from "./rest.ts";

export const CHECKS_API = "https://api.github.test";

export interface FakeChecks {
  fetch: FetchLike;
  /** `METHOD path`, in order. */
  calls: string[];
  pulls: RestPull[];
  /** By commit id: the check runs GitHub lists for it. */
  runs: Map<string, RestCheckRun[]>;
  /** By commit id: the latest status of each context. */
  statuses: Map<string, RestStatus[]>;
  /** By job id: the log GitHub serves (after its redirect). Absent: 404. */
  logs: Map<string, string>;
  /** The token's login; the pull requests and comments Scope Soup makes are written as this user. */
  login: string;
  /** By pull request number, oldest first. */
  comments: Map<number, RestComment[]>;
  /** The pull request with this number as GitHub shows it now, with `merged` worked out. */
  pull(number: number): RestPull | undefined;
  /** The writes sent: every call that is not a GET. */
  writes(): string[];
  /** The next `times` calls (default 1) that `match` picks are answered with `status` instead. */
  fail(match: (call: string) => boolean, status: number, times?: number): void;
}

/** What the fake asks of the repository behind it. */
export interface FakeBranches {
  /** The commit a branch points at, or "" when there is none. */
  headOf(branch: string): string;
  /** Whether the commit is on that branch now. */
  onBase(sha: string, base: string): boolean;
  /** Deletes the branch; false when there is none. */
  deleteBranch?(branch: string): boolean;
}

/** `repo` is "owner/name". */
export function fakeChecks(repo: string, branches: FakeBranches = { headOf: () => "", onBase: () => false }): FakeChecks {
  const prefix = `/repos/${repo}`;
  const owner = repo.split("/")[0] ?? "";
  const calls: string[] = [];
  const pulls: RestPull[] = [];
  const runs = new Map<string, RestCheckRun[]>();
  const statuses = new Map<string, RestStatus[]>();
  const logs = new Map<string, string>();
  const comments = new Map<number, RestComment[]>();
  const failures: { match: (call: string) => boolean; status: number; times: number }[] = [];
  let clock = Date.UTC(2030, 0, 1);
  let commentId = 5000;

  const shown = (pull: RestPull): RestPull => {
    const merged = pull.merged === true || (pull.state === "open" && branches.onBase(pull.head.sha, pull.base.ref));
    if (merged && !pull.merged) {
      pull.merged = true;
      pull.state = "closed";
      pull.merged_at = new Date(clock).toISOString();
    }
    return { ...pull };
  };

  const answer = (status: number, body: unknown, text?: string): FetchResponse => ({
    status,
    headers: { get: (name) => (name.toLowerCase() === "x-ratelimit-remaining" ? "4999" : name.toLowerCase() === "x-ratelimit-reset" ? "1895000000" : null) },
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  });

  const fake: FakeChecks = {
    calls, pulls, runs, statuses, logs, comments,
    login: "scopesoup-bot",
    pull: (number) => {
      const found = pulls.find((pull) => pull.number === number);
      return found ? shown(found) : undefined;
    },
    writes: () => calls.filter((call) => !call.startsWith("GET ")),
    fail(match, status, times = 1) {
      failures.push({ match, status, times });
    },
    async fetch(url, init) {
      const method = init?.method ?? "GET";
      const path = url.startsWith(CHECKS_API) ? url.slice(CHECKS_API.length) : url;
      const call = `${method} ${path}`;
      calls.push(call);
      clock += 1000;
      const failure = failures.find((each) => each.times > 0 && each.match(call));
      if (failure) {
        failure.times -= 1;
        return answer(failure.status, { message: `failed by the test (${failure.status})` });
      }
      if (path === "/user" && method === "GET") return answer(200, { login: fake.login, type: "User" });
      if (!path.startsWith(prefix)) return answer(404, { message: "Not Found" });
      const rest = path.slice(prefix.length);
      const [route = "", query = ""] = rest.split("?");
      const params = new URLSearchParams(query);
      if (route === "/pulls" && method === "GET") {
        const head = params.get("head") ?? "";
        const state = params.get("state") ?? "open";
        return answer(200, pulls.map(shown).filter((pull) => (state === "all" || pull.state === state) && `${owner}:${pull.head.ref}` === head));
      }
      if (route === "/pulls" && method === "POST") {
        const body = JSON.parse(init?.body ?? "{}") as { title: string; head: string; base: string; body: string; draft?: boolean };
        if (pulls.some((pull) => shown(pull).state === "open" && pull.head.ref === body.head)) return answer(422, { message: "A pull request already exists" });
        const sha = branches.headOf(body.head);
        if (sha === "") return answer(422, { message: "Validation Failed: head does not exist" });
        const number = 100 + pulls.length + 1;
        const at = new Date(clock).toISOString();
        const pull: RestPull = {
          number, title: body.title, body: body.body, state: "open", draft: body.draft === true, merged: false, merged_at: null,
          user: { login: fake.login, type: "User" }, labels: [], base: { ref: body.base }, head: { ref: body.head, sha },
          html_url: `https://github.test/${repo}/pull/${number}`, created_at: at, updated_at: at,
        };
        pulls.push(pull);
        return answer(201, pull);
      }
      const pullMatch = /^\/pulls\/(\d+)$/.exec(route);
      if (pullMatch && method === "GET") {
        const pull = fake.pull(Number(pullMatch[1]));
        return pull ? answer(200, pull) : answer(404, { message: "Not Found" });
      }
      if (pullMatch && method === "PATCH") {
        const pull = pulls.find((each) => each.number === Number(pullMatch[1]));
        if (!pull) return answer(404, { message: "Not Found" });
        const body = JSON.parse(init?.body ?? "{}") as { state?: "open" | "closed" };
        if (body.state && !pull.merged) pull.state = body.state;
        return answer(200, shown(pull));
      }
      const commentsMatch = /^\/issues\/(\d+)\/comments$/.exec(route);
      if (commentsMatch) {
        const number = Number(commentsMatch[1]);
        if (!pulls.some((pull) => pull.number === number)) return answer(404, { message: "Not Found" });
        const list = comments.get(number) ?? [];
        if (method === "GET") return answer(200, list);
        if (method === "POST") {
          const body = JSON.parse(init?.body ?? "{}") as { body: string };
          const comment: RestComment = { id: ++commentId, body: body.body, user: { login: fake.login, type: "User" }, created_at: new Date(clock).toISOString() };
          comments.set(number, [...list, comment]);
          return answer(201, comment);
        }
      }
      const refMatch = /^\/git\/refs\/heads\/(.+)$/.exec(route);
      if (refMatch && method === "DELETE") {
        const branch = refMatch[1]!.split("/").map(decodeURIComponent).join("/");
        if (!(branches.deleteBranch?.(branch) ?? false)) return answer(422, { message: "Reference does not exist" });
        // As on GitHub: an open pull request whose head branch is deleted is closed.
        for (const pull of pulls) if (shown(pull).state === "open" && pull.head.ref === branch) pull.state = "closed";
        return answer(204, null);
      }
      const runsMatch = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(route);
      if (runsMatch && method === "GET") {
        const list = runs.get(runsMatch[1] ?? "") ?? [];
        return answer(200, { total_count: list.length, check_runs: list });
      }
      const statusMatch = /^\/commits\/([0-9a-f]+)\/status$/.exec(route);
      if (statusMatch && method === "GET") {
        const list = statuses.get(statusMatch[1] ?? "") ?? [];
        const state = list.some((each) => each.state === "failure" || each.state === "error") ? "failure" : list.some((each) => each.state === "pending") || list.length === 0 ? "pending" : "success";
        return answer(200, { state, statuses: list, total_count: list.length });
      }
      const logMatch = /^\/actions\/jobs\/(\d+)\/logs$/.exec(route);
      if (logMatch && method === "GET") {
        const log = logs.get(logMatch[1] ?? "");
        return log === undefined ? answer(404, { message: "Not Found" }) : answer(200, null, log);
      }
      return answer(404, { message: "Not Found" });
    },
  };
  return fake;
}
