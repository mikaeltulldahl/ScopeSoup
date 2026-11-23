// Closing a GitHub Item: merged (the closing comment with its `merged` marker), abandoned (`not_planned`), a duplicate
// (`state_reason: "duplicate"` with the target's database id, and a `duplicate` line in the log comment), and a merged Item that a
// person reopens, which leaves Done on the next poll. The real adapter and host actions run on a fake GitHub. All names are synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { situate } from "../core/lanes.ts";
import { buildIndex, emptySnapshot } from "../core/snapshot.ts";
import { assess, turnContext } from "../core/turns.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import { createHostActions } from "./hostActions.ts";

const R = "/repos/harbour/tides/issues";
const ref = (id: string): Ref => ({ host: "github", kind: "work", id });
const config = (() => {
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
})();

function world() {
  const fake = fakeIssues("harbour/tides", [1, 2, 3]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot", now: () => Date.parse(fake.clock) });
  const store = openStore(":memory:");
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store });
  return { fake, host, store, actions };
}

/** The lane and the reason the board and the Item page give for each Item, from the items alone (no jobs): what GitHub says. */
function board(items: WorkItem[]): Record<string, { lane: string | null; reason: string }> {
  const index = buildIndex({ ...emptySnapshot(), works: items });
  const ctx = turnContext(index, new Date("2026-11-22T10:00:00Z"));
  return Object.fromEntries(items.map((item) => {
    const { situation, turn } = assess(situate(item, index), ctx);
    return [item.ref.id, { lane: situation.lane, reason: turn.reason }];
  }));
}

test("a merged Item's closing comment carries the merged marker; reopened, it leaves Done on the next poll and the timeline is read only then", async () => {
  const w = world();
  const first = await w.host.work.listWork();
  assert.equal(await w.actions.closeMerged!(ref("1"), { sha: "180c44b".padEnd(40, "0"), target: "main", batch: 12 }), "closed");
  const closing = w.fake.comments.get("1")!.at(-1)!;
  assert.match(closing.body ?? "", /^Merged on main as 180c44b in batch 12\. Closing this item\./);
  assert.deepEqual(readMarker(closing.body), { kind: "merged", data: { v: 1, sha: "180c44b".padEnd(40, "0"), target: "main", batch: 12 } });
  assert.deepEqual(w.fake.sent.at(-1), { call: `PATCH ${R}/1`, body: { state: "closed", state_reason: "completed" } });

  // Closed: Done, and no timeline read.
  w.fake.clear();
  const closed = await w.host.work.listWork(first.cursor);
  const one = closed.items.find((item) => item.ref.id === "1")!;
  assert.deepEqual([one.state, one.merged?.batch, one.merged?.reopened], ["done", 12, undefined]);
  assert.equal(w.fake.calls.some((call) => call.includes("/timeline")), false);

  // A person reopens it: on the next poll the timeline is read (once, for that issue only), and the Item is work again.
  w.fake.reopen(1);
  w.fake.clear();
  const reopened = await w.host.work.listWork(closed.cursor);
  const again = reopened.items.find((item) => item.ref.id === "1")!;
  assert.equal(again.state, "todo");
  assert.ok(again.merged?.reopened);
  assert.deepEqual(w.fake.calls.filter((call) => call.includes("/timeline")), [`GET ${R}/1/timeline?per_page=100`]);
  assert.equal(board([again])["1"]!.lane, "backlog");
  // Open with a merged marker and no reopen after it (the close did not take): Done.
  assert.equal(board([{ ...again, merged: { ...again.merged!, reopened: undefined } }])["1"]!.lane, "done");

  // Read again with nothing changed on GitHub: the timeline is asked conditionally and costs a free 304.
  await w.host.work.getWork(ref("1"));
  const before = w.fake.notModified;
  w.fake.clear();
  assert.ok((await w.host.work.getWork(ref("1")))?.merged?.reopened);
  assert.ok(w.fake.calls.includes(`GET ${R}/1/timeline?per_page=100`));
  assert.equal(w.fake.notModified - before, w.fake.calls.length);
});

test("abandoning a GitHub Item closes it as not_planned, and its re-read must show it", async () => {
  const w = world();
  await w.host.write!.editWork!(ref("2"), { state: "abandoned" });
  assert.deepEqual(w.fake.sent.at(-1), { call: `PATCH ${R}/2`, body: { state: "closed", state_reason: "not_planned" } });
  assert.equal((await w.host.work.getWork(ref("2")))?.state, "abandoned");
});

test("closing as a duplicate sends state_reason duplicate with the target's database id, and the log comment names the target", async () => {
  const w = world();
  assert.equal(await w.actions.closeDuplicate!(ref("3"), ref("1")), true);
  assert.deepEqual(w.fake.sent.find((each) => each.call === `PATCH ${R}/3`)?.body, { state: "closed", state_reason: "duplicate", duplicate_issue_id: 9001 });
  const log = w.fake.comments.get("3")!.find((comment) => readMarker(comment.body)?.kind === "log")!;
  assert.deepEqual((readMarker(log.body)!.data.lines as { kind: string; fields: unknown }[]).map(({ kind, fields }) => ({ kind, fields })), [{ kind: "duplicate", fields: { of: "1" } }]);
  assert.match(log.body ?? "", /closed as a duplicate of #1\./);
  const item = w.store.get<WorkItem>(ref("3"))!;
  assert.deepEqual([item.state, item.hostState, item.duplicateOf?.id], ["abandoned", "closed:duplicate", "1"]);
  assert.deepEqual(board([item])["3"], { lane: null, reason: "duplicate of #1" });
  // A target GitHub does not know: the write fails, and nothing is logged.
  await assert.rejects(w.actions.closeDuplicate!(ref("2"), ref("99")));
  assert.equal(w.fake.comments.get("2"), undefined);
});
