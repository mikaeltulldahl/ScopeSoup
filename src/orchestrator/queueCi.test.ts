// The merge queue waits for the project's CI on GitHub (`mergeQueue.ci: "github"`). The real driver with real git against a
// bare remote, and the real GitHub adapter against a fake GitHub (synthetic pull requests, check runs, statuses and logs) that
// reads the remote's branches the way GitHub would: a pull request's head is its branch's commit, and it shows as merged once
// that commit is on main.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import { CHECKS_API, fakeChecks } from "../hosts/github/fakeChecks.ts";
import type { FakeChecks } from "../hosts/github/fakeChecks.ts";
import type { RestCheckRun } from "../hosts/github/rest.ts";
import type { Ref } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import { git, isolateGitConfig } from "./fixtures/git-env.ts";
import { realGit } from "./process.ts";
import { createQueueDriver, githubCiRefusal, NO_CHECKS_GRACE_MS } from "./queueDriver.ts";
import type { Notice, QueueDriver, QueueSink, ParkedNotice } from "./queueDriver.ts";

const restoreGitConfig = isolateGitConfig();
const dir = mkdtempSync(join(tmpdir(), "scopesoup-queue-ci-"));
const stores: { close(): void }[] = [];
after(() => {
  stores.forEach((store) => store.close());
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restoreGitConfig();
});

const REPO = "acme/widgets";
const seed = join(dir, "seed");
mkdirSync(seed);
git(seed, "init", "-q", "-b", "main");
writeFileSync(join(seed, "README.md"), "synthetic project\n");
git(seed, "add", ".");
git(seed, "commit", "-q", "-m", "first");

interface World {
  remote: string;
  work: string;
  driver: QueueDriver;
  github: FakeChecks;
  notes: string[];
  notices: Notice[];
  sink: QueueSink;
  switches: { paused: boolean; stopped: boolean };
  /** Minutes since the start, as the driver's clock reads them. */
  clock: { minutes: number };
}

let count = 0;
function world(timeout?: number): World {
  const name = `c${++count}`;
  const remote = join(dir, `${name}.git`);
  git(dir, "clone", "-q", "--bare", seed, remote);
  const work = join(dir, `${name}-work`);
  git(dir, "clone", "-q", remote, work);
  const result = validateConfig({
    project: "p", machineName: "laptop-a", repoPath: work, workspacesDir: join(dir, `${name}-spaces`), level: 4, remoteUrl: remote,
    host: { kind: "github", repo: REPO, write: true },
    mergeQueue: { ci: "github", ...(timeout === undefined ? {} : { ciTimeoutMinutes: timeout }) },
  }, dir);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const config = result.config;
  const store = openStore(join(dir, `${name}.sqlite`));
  stores.push(store);
  const github = fakeChecks(REPO, {
    headOf: (branch) => {
      try {
        return git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).trim();
      } catch {
        return "";
      }
    },
    onBase: (sha, base) => {
      try {
        git(remote, "merge-base", "--is-ancestor", sha, `refs/heads/${base}`);
        return true;
      } catch {
        return false;
      }
    },
    deleteBranch: (branch) => {
      try {
        git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      } catch {
        return false;
      }
      git(remote, "update-ref", "-d", `refs/heads/${branch}`);
      return true;
    },
  });
  const host = createGitHubHost({ token: "t", repo: REPO, apiUrl: CHECKS_API, fetchImpl: github.fetch, allowWrites: true, conventions: true, machine: "laptop-a" });
  const switches = { paused: false, stopped: false };
  const clock = { minutes: 0 };
  const driver = createQueueDriver({
    store, config: () => config, git: realGit,
    runCheck: () => assert.fail("with CI on GitHub no check command runs"),
    now: () => new Date(Date.UTC(2030, 0, 1) + clock.minutes * 60_000).toISOString(),
    paused: () => switches.paused,
    stopped: () => switches.stopped,
    ...(host.queueCi ? { ci: host.queueCi } : {}),
  });
  const notes: string[] = [];
  const notices: Notice[] = [];
  const sink: QueueSink = { note: (kind, reason) => void notes.push(`${kind}: ${reason}`), deliver: async (notice) => void notices.push(notice) };
  return { remote, work, driver, github, notes, notices, sink, switches, clock };
}

const item = (id: string): Ref => ({ host: "github", kind: "work", id });

async function ready(w: World, id: string, file: string): Promise<void> {
  const branch = `scopesoup/${id}`;
  git(w.work, "checkout", "-q", "-B", branch, "origin/main");
  writeFileSync(join(w.work, file), `${id}\n`);
  git(w.work, "add", ".");
  git(w.work, "commit", "-q", "-m", `item ${id}`);
  const result = await w.driver.enqueue(item(id), branch, w.work, [file]);
  assert.equal(result.ok, true, JSON.stringify(result));
}

const main = (w: World): string => git(w.remote, "rev-parse", "main").trim();
const merged = (w: World): string[] => w.notices.flatMap((n) => (n.kind === "mark-merged" ? n.members.map((m) => m.change.id) : []));
const sentBack = (w: World) => w.notices.flatMap((n) => (n.kind === "send-back" ? [n] : []));
const parkedNotices = (w: World): ParkedNotice[] => w.notices.flatMap((n) => (n.kind === "parked" ? [n] : []));
const run = (id: number, name: string, status: string, conclusion: string | null = null): RestCheckRun => ({ id, name, status, conclusion, html_url: `https://github.test/${REPO}/runs/${id}`, app: { slug: "github-actions" } });

/** The newest pull request the queue opened: its number and the commit it is for. */
function lastPull(w: World): { number: number; sha: string; branch: string } {
  const pull = w.github.pulls.at(-1);
  assert.ok(pull, "a pull request was opened");
  return { number: pull.number, sha: pull.head.sha, branch: pull.head.ref };
}

describe("queue with CI on GitHub", { concurrency: 4 }, () => {
  test("green: the tested commit itself is pushed to main fast-forward, and the pull request shows as merged", async () => {
    const w = world();
    const before = main(w);
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const pull = lastPull(w);
    assert.match(pull.branch, /^scopesoup\/batch-1-[0-9a-f]{7}$/);
    assert.equal(git(w.remote, "rev-parse", `refs/heads/${pull.branch}`).trim(), pull.sha, "the batch's commit is on its branch");
    assert.equal(git(w.remote, "rev-parse", `${pull.sha}^`).trim(), before, "built on the newest main");
    assert.equal(main(w), before, "nothing merges before the checks");
    assert.match(w.notes.join("\n"), /orchestrator\.queue_ci: Batch 1, first 1 of its chain .*pull request 101 waits for every check/);

    // Still running: the next drain only looks again.
    w.github.runs.set(pull.sha, [run(7, "test", "in_progress")]);
    w.clock.minutes = 3;
    await w.driver.drain(w.sink);
    assert.equal(main(w), before);
    assert.deepEqual(w.notices, []);

    w.github.runs.set(pull.sha, [run(7, "test", "completed", "success"), run(8, "lint", "completed", "success")]);
    w.github.statuses.set(pull.sha, [{ context: "ci/external", state: "success" }]);
    w.clock.minutes = 9;
    await w.driver.drain(w.sink);
    assert.equal(main(w), pull.sha, "what merges is what was tested: no squash, no new commit");
    assert.deepEqual(merged(w), ["1"]);
    const tested = (w.notices as Notice[]).flatMap((n) => (n.kind === "mark-merged" ? [n.tested] : []));
    assert.deepEqual(tested, [pull.sha]);
    assert.equal(w.github.pull(pull.number)?.merged, true, "GitHub shows the pull request as merged");
    // The GitHub writes are the pull request only: no merge call, no comment, no label. The rest went by git push.
    assert.deepEqual(w.github.writes(), [`POST /repos/${REPO}/pulls`]);
  });

  test("red: the change is sent back with the failing check's name, conclusion and the end of its log; nothing merges", async () => {
    const w = world();
    const before = main(w);
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const pull = lastPull(w);
    w.github.runs.set(pull.sha, [run(7, "test", "completed", "failure"), run(8, "lint", "in_progress")]);
    w.github.logs.set("7", "step 1 ok\nnot ok 3 - adds\nError: expected 2, got 3\n");
    await w.driver.drain(w.sink);
    assert.equal(main(w), before);
    const back = sentBack(w);
    assert.deepEqual(back.map((n) => n.change.id), ["1"]);
    const reason = back[0]?.reason;
    assert.equal(reason?.kind, "culprit");
    const excerpt = reason?.kind === "culprit" ? reason.excerpt : "";
    assert.match(excerpt, /^The check "test" on GitHub ended failure on [0-9a-f]{7}\.\nThe end of its log:\n.*Error: expected 2, got 3$/s);
    assert.equal(w.github.pull(pull.number)?.merged, false);
  });

  test("red with a log that cannot be read: the excerpt carries the check's link", async () => {
    const w = world();
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const pull = lastPull(w);
    w.github.statuses.set(pull.sha, [{ context: "ci/external", state: "failure", target_url: "https://ci.example.test/builds/41" }]);
    await w.driver.drain(w.sink);
    const reason = sentBack(w)[0]?.reason;
    assert.match(reason?.kind === "culprit" ? reason.excerpt : "", /The check "ci\/external" on GitHub ended failure .*Its log could not be read: https:\/\/ci\.example\.test\/builds\/41/s);
  });

  test("pending: the queue waits, and past mergeQueue.ciTimeoutMinutes the Item parked for a person with the check's link", async () => {
    const w = world(30);
    const before = main(w);
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const pull = lastPull(w);
    w.github.runs.set(pull.sha, [run(7, "test", "completed", "success"), run(9, "slow suite", "queued")]);
    w.clock.minutes = 29;
    await w.driver.drain(w.sink);
    assert.deepEqual(w.notices, [], "still within the time limit");
    w.clock.minutes = 31;
    await w.driver.drain(w.sink);
    const held = parkedNotices(w);
    assert.deepEqual(held.map((n) => n.changes.map((c) => c.id)), [["1"]]);
    assert.match(held[0]?.message ?? "", /still pending after 31 minutes \(mergeQueue.ciTimeoutMinutes is 30\): "slow suite" \(https:\/\/github\.test\/acme\/widgets\/runs\/9\)\. Nothing was merged and no implementor was resumed/);
    assert.deepEqual(sentBack(w), [], "nothing is resumed");
    assert.deepEqual(merged(w), [], "nothing is merged");
    assert.equal(main(w), before);
    assert.deepEqual(w.driver.state().entries, [], "the change left the queue");
    // A later green says nothing any more: the batch ended.
    w.github.runs.set(pull.sha, [run(7, "test", "completed", "success"), run(9, "slow suite", "completed", "success")]);
    await w.driver.drain(w.sink);
    assert.equal(main(w), before);
  });

  test("no checks at all after the grace: the Item parked for a person saying no CI ran", async () => {
    const w = world();
    const before = main(w);
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    w.clock.minutes = NO_CHECKS_GRACE_MS / 60_000 - 1;
    await w.driver.drain(w.sink);
    assert.deepEqual(w.notices, []);
    w.clock.minutes = NO_CHECKS_GRACE_MS / 60_000;
    await w.driver.drain(w.sink);
    assert.match(parkedNotices(w)[0]?.message ?? "", /^No CI ran on batch 1, first 1 of its chain .*no check run and no commit status on that commit, so nothing was merged unchecked/);
    assert.equal(main(w), before);
  });

  test("Pause merge queue stops merging: a green batch waits, and merges once merging is started again", async () => {
    const w = world();
    const before = main(w);
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const pull = lastPull(w);
    w.github.runs.set(pull.sha, [run(7, "test", "completed", "success")]);
    w.switches.paused = true;
    await w.driver.drain(w.sink);
    assert.equal(main(w), before, "nothing is merged while merging is paused");
    assert.deepEqual(merged(w), []);
    w.switches.paused = false;
    await w.driver.drain(w.sink);
    assert.equal(main(w), pull.sha);
    assert.deepEqual(merged(w), ["1"]);
  });

  test("main moved meanwhile: the batch is rebuilt on the new main and checked again on a new pull request", async () => {
    const w = world();
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const first = lastPull(w);
    // Someone else merges on main while the checks run.
    git(w.work, "checkout", "-q", "-B", "other", "origin/main");
    writeFileSync(join(w.work, "other.txt"), "other\n");
    git(w.work, "add", ".");
    git(w.work, "commit", "-q", "-m", "elsewhere");
    git(w.work, "push", "-q", "origin", "other:main");
    const moved = main(w);
    w.github.runs.set(first.sha, [run(7, "test", "completed", "success")]);
    await w.driver.drain(w.sink);
    assert.equal(main(w), moved, "the commit tested on the old main is not pushed");
    const second = lastPull(w);
    assert.notEqual(second.number, first.number);
    assert.notEqual(second.sha, first.sha);
    assert.equal(git(w.remote, "rev-parse", `${second.sha}^`).trim(), moved, "rebuilt on the new main");
    w.github.runs.set(second.sha, [run(11, "test", "completed", "success")]);
    await w.driver.drain(w.sink);
    assert.equal(main(w), second.sha);
    assert.deepEqual(merged(w), ["1"]);
    assert.equal(w.github.pull(second.number)?.merged, true);
    assert.equal(w.github.pull(first.number)?.merged, false);
  });
});

// Scope Soup tidies its own batch pull requests that are over.
const hasBranch = (w: World, branch: string): boolean => {
  try {
    git(w.remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};
const commentsOn = (w: World, number: number): string[] => (w.github.comments.get(number) ?? []).map((comment) => comment.body ?? "");

describe("tidying batch pull requests", { concurrency: 4 }, () => {
  test("red: the pull request gets one comment why, is closed, and its branch is deleted", async () => {
    const w = world();
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const pull = lastPull(w);
    w.github.runs.set(pull.sha, [run(7, "test (ubuntu)", "completed", "failure")]);
    await w.driver.drain(w.sink);
    await w.driver.drain(w.sink);
    assert.deepEqual(commentsOn(w, pull.number), ["Red: `test (ubuntu)` ended failure; the change went back to the implementor."]);
    assert.equal(w.github.pull(pull.number)?.state, "closed");
    assert.equal(w.github.pull(pull.number)?.merged, false);
    assert.equal(hasBranch(w, pull.branch), false);
  });

  test("timed out: the comment says so and the Items wait for an answer; closed and deleted", async () => {
    const w = world(30);
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const pull = lastPull(w);
    w.github.runs.set(pull.sha, [run(9, "slow suite", "queued")]);
    w.clock.minutes = 31;
    await w.driver.drain(w.sink);
    await w.driver.drain(w.sink);
    assert.deepEqual(commentsOn(w, pull.number), ["Timed out after 31 min; the Items wait for an answer."]);
    assert.equal(w.github.pull(pull.number)?.state, "closed");
    assert.equal(hasBranch(w, pull.branch), false);
  });

  test("rebuilt because main moved: the old pull request says why, is closed and its branch deleted; the new one merges and its branch goes", async () => {
    const w = world();
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const first = lastPull(w);
    git(w.work, "checkout", "-q", "-B", "other", "origin/main");
    writeFileSync(join(w.work, "other.txt"), "other\n");
    git(w.work, "add", ".");
    git(w.work, "commit", "-q", "-m", "elsewhere");
    git(w.work, "push", "-q", "origin", "other:main");
    await w.driver.drain(w.sink);
    assert.match(commentsOn(w, first.number).join("\n"), /^Not merged: batch 1 ended \(the main branch moved outside the queue \([0-9a-f]{7}\)\)\. Scope Soup closes this pull request and deletes its branch\.$/);
    assert.equal(w.github.pull(first.number)?.state, "closed");
    assert.equal(hasBranch(w, first.branch), false);
    const second = lastPull(w);
    w.github.runs.set(second.sha, [run(11, "test", "completed", "success")]);
    await w.driver.drain(w.sink);
    assert.equal(main(w), second.sha);
    assert.equal(hasBranch(w, second.branch), true, "deleted at the next drain, once the batch is over");
    await w.driver.drain(w.sink);
    assert.equal(hasBranch(w, second.branch), false);
    assert.equal(w.github.pull(second.number)?.merged, true, "a merged pull request stays merged");
    assert.deepEqual(commentsOn(w, second.number), [], "a merged one gets no comment");
  });

  test("a failed delete is retried at the next drain and does not hold the queue up", async () => {
    const w = world();
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const pull = lastPull(w);
    w.github.runs.set(pull.sha, [run(7, "test", "completed", "failure")]);
    await w.driver.drain(w.sink);
    w.github.fail((call) => call.startsWith("DELETE "), 502);
    await ready(w, "2", "two.txt");
    await w.driver.drain(w.sink);
    assert.equal(hasBranch(w, pull.branch), true);
    assert.match(w.notes.join("\n"), /could not be tidied: .*Scope Soup tries again at the next tick/);
    const next = lastPull(w);
    assert.notEqual(next.number, pull.number, "the queue went on with the next batch");
    await w.driver.drain(w.sink);
    assert.equal(hasBranch(w, pull.branch), false);
    assert.equal(commentsOn(w, pull.number).length, 1);
  });

  test("a pull request whose marker was edited away is left as it is", async () => {
    const w = world();
    await ready(w, "1", "one.txt");
    await w.driver.drain(w.sink);
    const pull = lastPull(w);
    w.github.pulls[0]!.body = "Edited by a person.";
    w.github.runs.set(pull.sha, [run(7, "test", "completed", "failure")]);
    await w.driver.drain(w.sink);
    const writes = w.github.writes().length;
    await w.driver.drain(w.sink);
    await w.driver.drain(w.sink);
    assert.equal(w.github.writes().length, writes, "no comment, no close, no delete");
    assert.equal(w.github.pull(pull.number)?.state, "open");
    assert.equal(hasBranch(w, pull.branch), true);
    assert.match(w.notes.join("\n"), /was left as it is: .*no batch marker/);
  });
});

test("mergeQueue.ci github is refused at start when remoteUrl is not the GitHub repository, and the queue says why", async () => {
  const ci = { mergeQueue: { ci: "github" as const, ciTimeoutMinutes: 60 } };
  assert.equal(githubCiRefusal({ ...ci, remoteUrl: "git@github.com:acme/widgets.git" }, REPO), null);
  assert.equal(githubCiRefusal({ ...ci, remoteUrl: "https://github.com/Acme/widgets" }, REPO), null);
  assert.equal(githubCiRefusal({ remoteUrl: "git@git.example.invalid:other/repo.git" }, REPO), null, "the local check needs no GitHub");
  const refused = githubCiRefusal({ ...ci, remoteUrl: "git@git.example.invalid:other/repo.git" }, REPO);
  assert.match(refused ?? "", /^mergeQueue.ci is "github", but remoteUrl \(git@git\.example\.invalid:other\/repo\.git\) is not the GitHub repository acme\/widgets/);
  const result = validateConfig({ project: "p", machineName: "laptop-a", repoPath: join(dir, "none"), level: 4, remoteUrl: "git@git.example.invalid:other/repo.git", mergeQueue: { ci: "github" } }, dir);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  const store = openStore(join(dir, `refused.sqlite`));
  stores.push(store);
  const driver = createQueueDriver({ store, config: () => result.config, git: realGit, runCheck: () => assert.fail("not run"), now: () => "2030-01-01T00:00:00.000Z", paused: () => false, stopped: () => false, ...(refused ? { ciRefused: refused } : {}) });
  assert.match(driver.checkMissing() ?? "", /is not the GitHub repository acme\/widgets.*so it cannot open the batch's pull request$/);
});
