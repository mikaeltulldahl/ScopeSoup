// The GitHub adapter's side of the merge queue's wait for CI, against a fake GitHub with synthetic fixtures: the batch's pull
// request (opened once, Scope Soup's own text and marker), the checks on a commit (check runs and commit statuses) and a job's log.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ref } from "../../model/types.ts";
import { NotScopeSoups, WriteLater } from "../../ports/host.ts";
import type { FetchLike } from "./client.ts";
import { createGitHubHost } from "./adapter.ts";
import { readMarker } from "./conventions.ts";
import { CHECKS_API, fakeChecks } from "./fakeChecks.ts";
import { FAKE_API, fakeGitHub } from "./fakeFetch.ts";
import { check, R, REPO } from "./fixtures.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BASE = "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567";
const member = (id: string): Ref => ({ host: "github", kind: "work", id });

function hostOn(fake: { fetch: FetchLike }, allowWrites = true) {
  return createGitHubHost({ token: "t", repo: REPO, apiUrl: CHECKS_API, fetchImpl: fake.fetch, allowWrites, conventions: true, machine: "laptop-a" });
}

test("queueCi exists only with writes on: opening the batch's pull request is a write", () => {
  assert.equal(hostOn(fakeChecks(REPO), false).queueCi, undefined);
  assert.ok(hostOn(fakeChecks(REPO)).queueCi);
});

test("openBatch opens one pull request from the batch branch, with Scope Soup's own text and a batch marker, and finds it again", async () => {
  const fake = fakeChecks(REPO, { headOf: (branch) => (branch === "scopesoup/batch-3-a1b2c3d" ? SHA : ""), onBase: () => false });
  const ci = hostOn(fake).queueCi!;
  const input = { branch: "scopesoup/batch-3-a1b2c3d", target: "main", batch: 3, sha: SHA, base: BASE, members: [member("12"), member("15")] };
  const ref = await ci.openBatch(input);
  assert.equal(ref.id, "101");
  assert.equal(ref.url, `https://github.test/${REPO}/pull/101`);
  const pull = fake.pull(101)!;
  assert.equal(pull.title, "Scope Soup mergeQueue: batch 3");
  assert.equal(pull.base.ref, "main");
  assert.equal(pull.head.sha, SHA);
  assert.match(pull.body ?? "", /^Batch 3 of Scope Soup's mergeQueue: #12, #15, built on main at 0f1e2d3\./);
  // No closing keyword: merging closes the Items itself, and the pull request is linked to none of them.
  assert.doesNotMatch(pull.body ?? "", /\b(close[sd]?|fix(e[sd])?|resolve[sd]?|refs?)\b/i);
  assert.deepEqual(readMarker(pull.body), { kind: "batch", data: { v: 1, batch: 3, sha: SHA, base: BASE, members: ["12", "15"] } });
  // Asked again (a restart before the wait was stored): the open pull request is returned, no second one is made.
  assert.equal((await ci.openBatch(input)).id, "101");
  assert.deepEqual(fake.writes(), [`POST ${R}/pulls`]);
});

test("checksOn reads every check run (the latest of each name) and every commit status on exactly that commit", async () => {
  const fake = fakeChecks(REPO);
  fake.runs.set(SHA, [
    { ...check(7, "test", "completed", "failure"), html_url: "https://github.test/run/7", app: { slug: "github-actions" } },
    { ...check(9, "test", "completed", "success"), html_url: "https://github.test/run/9", app: { slug: "github-actions" } },
    check(8, "lint", "in_progress"),
    check(10, "docs", "completed", "skipped"),
  ]);
  fake.statuses.set(SHA, [
    { context: "ci/external", state: "pending", target_url: "https://ci.example.test/1" },
    { context: "ci/other", state: "error" },
  ]);
  const checks = await hostOn(fake).queueCi!.checksOn(SHA);
  assert.deepEqual(checks, [
    { name: "test", kind: "check-run", id: "9", state: "passed", conclusion: "success", url: "https://github.test/run/9" },
    { name: "lint", kind: "check-run", id: "8", state: "pending", conclusion: "in_progress" },
    { name: "docs", kind: "check-run", id: "10", state: "passed", conclusion: "skipped" },
    { name: "ci/external", kind: "status", state: "pending", conclusion: "pending", url: "https://ci.example.test/1" },
    { name: "ci/other", kind: "status", state: "failed", conclusion: "error" },
  ]);
  assert.deepEqual(await hostOn(fakeChecks(REPO)).queueCi!.checksOn(SHA), [], "no CI at all: nothing");
});

test("checkLog gives the end of an Actions job's log, and null when it cannot be read", async () => {
  const fake = fakeChecks(REPO);
  fake.logs.set("7", `${"x".repeat(50)}\nError: expected 2, got 3\n`);
  const ci = hostOn(fake).queueCi!;
  assert.equal(await ci.checkLog({ name: "test", kind: "check-run", id: "7", state: "failed", conclusion: "failure" }, 30), "...xxxxx\nError: expected 2, got 3");
  assert.equal(await ci.checkLog({ name: "test", kind: "check-run", id: "8", state: "failed", conclusion: "failure" }, 30), null, "no log: null");
  assert.equal(await ci.checkLog({ name: "ci/other", kind: "status", state: "failed", conclusion: "error" }, 30), null, "a status has no log here");
  assert.deepEqual(fake.writes(), []);
});

test("a GitHub failure that can pass by itself is WriteLater; a refusal is not", async () => {
  const flaky = fakeGitHub({ [`${R}/commits/${SHA}/check-runs?per_page=100`]: { status: 502, body: { message: "Bad Gateway" } } });
  const host = createGitHubHost({ token: "t", repo: REPO, apiUrl: FAKE_API, fetchImpl: flaky.fetch, allowWrites: true });
  await assert.rejects(host.queueCi!.checksOn(SHA), WriteLater);
  const refused = fakeGitHub({
    [`${R}/commits/${SHA}/check-runs?per_page=100`]: { status: 403, body: { message: "Resource not accessible by integration" } },
    [`${R}/commits/${SHA}/status?per_page=100`]: { status: 403, body: { message: "Resource not accessible by integration" } },
  });
  const other = createGitHubHost({ token: "t", repo: REPO, apiUrl: FAKE_API, fetchImpl: refused.fetch, allowWrites: true });
  await assert.rejects(other.queueCi!.checksOn(SHA), (error) => !(error instanceof WriteLater));
});

// --- tidying Scope Soup's own batch pull requests ---

const BRANCH = "scopesoup/batch-3-a1b2c3d";

/** A fake whose remote holds the batch branch until it is deleted; `merged` says whether its commit is on main. */
function withBatch(merged = false) {
  const live = new Set([BRANCH, "feature/x"]);
  const fake = fakeChecks(REPO, { headOf: (branch) => (live.has(branch) ? SHA : ""), onBase: () => merged, deleteBranch: (branch) => live.delete(branch) });
  return { fake, live, ci: hostOn(fake).queueCi! };
}

async function opened(ci: NonNullable<ReturnType<typeof hostOn>["queueCi"]>, branch = BRANCH): Promise<Ref> {
  return ci.openBatch({ branch, target: "main", batch: 3, sha: SHA, base: BASE, members: [member("12")] });
}

const writesAfter = (fake: ReturnType<typeof fakeChecks>, from: number) => fake.calls.slice(from).filter((call) => !call.startsWith("GET "));

test("cleanBatch on a batch that did not merge: one comment, the pull request closed, its branch deleted", async () => {
  const { fake, live, ci } = withBatch();
  const change = await opened(ci);
  const from = fake.calls.length;
  await ci.cleanBatch({ change, branch: BRANCH, comment: "Red: `test` ended failure; the change went back to the implementor." });
  assert.deepEqual(writesAfter(fake, from), [`POST ${R}/issues/101/comments`, `PATCH ${R}/pulls/101`, `DELETE ${R}/git/refs/heads/scopesoup/batch-3-a1b2c3d`]);
  assert.deepEqual(fake.comments.get(101)?.map((comment) => comment.body), ["Red: `test` ended failure; the change went back to the implementor."]);
  assert.equal(fake.pull(101)?.state, "closed");
  assert.equal(live.has(BRANCH), false);
});

test("cleanBatch is retried after a failure without doing a step twice: a failed close, then a failed delete", async () => {
  const { fake, live, ci } = withBatch();
  const change = await opened(ci);
  const job = { change, branch: BRANCH, comment: "Timed out after 60 min; the Items wait for an answer." };
  fake.fail((call) => call.startsWith("PATCH "), 502);
  await assert.rejects(ci.cleanBatch(job), WriteLater);
  fake.fail((call) => call.startsWith("DELETE "), 503);
  await assert.rejects(ci.cleanBatch(job), WriteLater);
  assert.equal(live.has(BRANCH), true);
  await ci.cleanBatch(job);
  assert.equal(live.has(BRANCH), false);
  assert.equal(fake.comments.get(101)?.length, 1, "the comment is posted once");
  assert.equal(fake.writes().filter((call) => call.startsWith("PATCH ")).length, 2, "the close is sent again only while the pull request is open");
  // Done already: asking again changes nothing (the branch is gone, the pull request closed).
  const from = fake.calls.length;
  await ci.cleanBatch(job);
  assert.deepEqual(writesAfter(fake, from), [`DELETE ${R}/git/refs/heads/scopesoup/batch-3-a1b2c3d`]);
});

test("cleanBatch on a batch that merged deletes only its branch, and only once GitHub shows it merged", async () => {
  const notYet = withBatch(false);
  const change = await opened(notYet.ci);
  await assert.rejects(notYet.ci.cleanBatch({ change, branch: BRANCH }), WriteLater);
  assert.equal(notYet.live.has(BRANCH), true, "an open pull request's branch is not deleted: that would close it unmerged");
  const merged = withBatch(true);
  await opened(merged.ci);
  const from = merged.fake.calls.length;
  await merged.ci.cleanBatch({ change, branch: BRANCH });
  assert.deepEqual(writesAfter(merged.fake, from), [`DELETE ${R}/git/refs/heads/scopesoup/batch-3-a1b2c3d`]);
  assert.equal(merged.fake.pull(101)?.merged, true);
  assert.equal(merged.fake.comments.get(101), undefined);
});

test("cleanBatch never touches a pull request without Scope Soup's marker from the token's login and the batch branch", async () => {
  const job = (change: Ref, branch = BRANCH) => ({ change, branch, comment: "Not merged." });
  // Another author, even with the marker in its description.
  const other = withBatch();
  const change = await opened(other.ci);
  other.fake.pulls[0]!.user = { login: "someone-else", type: "User" };
  const from = other.fake.calls.length;
  await assert.rejects(other.ci.cleanBatch(job(change)), NotScopeSoups);
  // The token's own pull request, but its marker edited away.
  other.fake.pulls[0]!.user = { login: "scopesoup-bot", type: "User" };
  other.fake.pulls[0]!.body = "Batch 3, edited by a person.";
  await assert.rejects(other.ci.cleanBatch(job(change)), NotScopeSoups);
  assert.deepEqual(writesAfter(other.fake, from), []);
  // Another head branch than the one asked for, or a branch that is not a batch branch: nothing is written.
  const foreign = withBatch();
  const feature = await foreign.ci.openBatch({ branch: "feature/x", target: "main", batch: 3, sha: SHA, base: BASE, members: [] });
  const before = foreign.fake.calls.length;
  await assert.rejects(foreign.ci.cleanBatch(job(feature)), NotScopeSoups);
  await assert.rejects(foreign.ci.cleanBatch(job(feature, "feature/x")), NotScopeSoups);
  assert.deepEqual(writesAfter(foreign.fake, before), []);
  assert.equal(foreign.live.has("feature/x"), true);
  assert.equal(foreign.fake.pull(101)?.state, "open");
});
