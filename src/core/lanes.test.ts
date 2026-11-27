import assert from "node:assert/strict";
import { test } from "node:test";
import { isApproved, laneOf, situate } from "./lanes.ts";
import { assessAll, waitingQueue } from "./turns.ts";
import { buildIndex } from "./snapshot.ts";
import type { SessionRole } from "../model/types.ts";
import { at, batch, change, member, ref, session, snapshot, verdict, work } from "./testing.ts";

const person = { id: "pat", name: "Pat" };

test("an item with no change: To do, or in progress when held or worked on", () => {
  const index = buildIndex(
    snapshot({
      works: [work(1), work(2, { state: "doing" }), work(3), work(4), work(5, { state: "waiting" })],
      sessions: [session("s3", ref("work", 3)), session("s4", ref("work", 4), { role: "triage" })],
    }),
  );
  const lanes = index.snapshot.works.map((item) => laneOf(item, index));
  assert.deepEqual(lanes, ["todo", "in-progress", "in-progress", "todo", "todo"]);
});

test("blocked lane: a todo item with an open blocker, including one waiting on a person; a done blocker frees it", () => {
  const index = buildIndex(
    snapshot({
      works: [
        work(1),
        work(2, { blockedBy: [ref("work", 1)] }),
        work(3, { needsDecision: true }),
        work(4, { blockedBy: [ref("work", 3)] }),
        work(5, { state: "done" }),
        work(6, { blockedBy: [ref("work", 5)] }),
        work(7, { blockedBy: [ref("work", 1)], needsDecision: true }),
        work(8, { blockedBy: [ref("work", 1)], state: "doing" }),
      ],
    }),
  );
  assert.deepEqual(
    index.snapshot.works.map((item) => laneOf(item, index)),
    ["todo", "blocked", "todo", "blocked", "done", "todo", "todo", "in-progress"],
  );
});

test("Backlog (decision 120): an open todo Item a person has not moved to To do, blocked or not; a triage on it keeps it there", () => {
  const index = buildIndex(
    snapshot({
      works: [
        work(1, { backlog: true }),
        work(2, { backlog: true, blockedBy: [ref("work", 3)] }),
        work(3),
        work(4, { backlog: true }),
        work(5, { backlog: true, state: "doing" }),
      ],
      sessions: [session("s4", ref("work", 4), { role: "triage" })],
    }),
  );
  assert.deepEqual(index.snapshot.works.map((item) => laneOf(item, index)), ["backlog", "backlog", "todo", "backlog", "in-progress"]);
  const assessed = assessAll(index, new Date(at(0)));
  assert.equal(assessed[0]!.turn.reason, "in Backlog: waits for a person to move it to To do");
  assert.equal(assessed[0]!.turn.actor, "nobody");
  assert.equal(assessed[3]!.turn.actor, "agent");
});

test("done and abandoned", () => {
  const index = buildIndex(snapshot({ works: [work(1, { state: "done" }), work(2, { state: "abandoned" }), work(3)], changes: [change(30, [3], { state: "merged" })] }));
  assert.deepEqual(index.snapshot.works.map((item) => laneOf(item, index)), ["done", null, "done"]);
});

test("an item whose change merged is Done while the host still has it open, even with an open change", () => {
  const index = buildIndex(snapshot({ works: [work(1), work(2)], changes: [change(30, [1], { state: "open" })], merged: [ref("work", 1)] }));
  assert.deepEqual(index.snapshot.works.map((item) => laneOf(item, index)), ["done", "todo"]);
});

test("a draft change is in progress; an open one is in review; an approved one is queued", () => {
  const index = buildIndex(
    snapshot({
      works: [work(1), work(2), work(3), work(4)],
      changes: [
        change(10, [1], { draft: true }),
        change(20, [2]),
        change(30, [3], { verdicts: [verdict("review", "pass")] }),
        change(40, [4], { verdicts: [verdict("review", "pass"), verdict("ci", "fail")] }),
      ],
    }),
  );
  assert.deepEqual(index.snapshot.works.map((item) => laneOf(item, index)), ["in-progress", "in-review", "queued", "in-review"]);
});

test("a stale approval or one on an older revision does not count", () => {
  const two = [{ id: "r1", sha: "a", createdAt: at(0) }, { id: "r2", sha: "b", createdAt: at(1) }];
  const index = buildIndex(snapshot({ works: [work(1), work(2)] }));
  assert.equal(isApproved(change(1, [1], { verdicts: [verdict("review", "pass", { stale: true })] }), index), false);
  assert.equal(isApproved(change(2, [2], { revisions: two, verdicts: [verdict("review", "pass", { revision: "r1" })] }), index), false);
  assert.equal(isApproved(change(2, [2], { revisions: two, verdicts: [verdict("review", "pass", { revision: "r2" })] }), index), true);
});

test("a verdict in a dimension Scope Soup does not know, such as the old \"risk\", neither approves nor holds a change; only a fail stops it", () => {
  const index = buildIndex(snapshot({ works: [work(1)] }));
  assert.equal(isApproved(change(1, [1], { verdicts: [verdict("review", "pass"), verdict("risk", "pending")] }), index), true);
  assert.equal(isApproved(change(1, [1], { verdicts: [verdict("risk", "pass", { by: person })] }), index), false);
  assert.equal(isApproved(change(1, [1], { verdicts: [verdict("review", "pass"), verdict("risk", "fail")] }), index), false);
});

test("a stored fix session (role removed) pulls a change back to in progress; a review session keeps it in review", () => {
  const works = [work(1), work(2)];
  const changes = [change(10, [1], { verdicts: [verdict("review", "fail")] }), change(20, [2], { verdicts: [verdict("review", "pass")] })];
  const index = buildIndex(
    snapshot({ works, changes, sessions: [session("s1", ref("change", 10), { role: "fix" as SessionRole }), session("s2", ref("change", 20), { role: "review" })] }),
  );
  assert.equal(laneOf(works[0]!, index), "in-progress");
  assert.equal(laneOf(works[1]!, index), "in-review");
});

test("batches: testing and bisecting are checking, forming and requeued are queued, a culprit goes back", () => {
  const works = [1, 2, 3, 4, 5, 6].map((id) => work(id));
  const approved = { verdicts: [verdict("review", "pass")] };
  const changes = works.map((item, i) => change((i + 1) * 10, [item.ref.id], approved));
  const index = buildIndex(
    snapshot({
      works,
      changes,
      batches: [
        batch(1, [member(10)]),
        batch(2, [member(20), member(60, "requeued")], { status: "bisecting" }),
        batch(3, [member(30, "waiting")], { status: "forming" }),
        batch(4, [member(40, "culprit"), member(50, "requeued")], { status: "failed", finishedAt: at(-5) }),
      ],
    }),
  );
  assert.deepEqual(works.map((item) => laneOf(item, index)), ["checking", "checking", "queued", "in-progress", "queued", "queued"]);
  assert.equal(situate(works[3]!, index).member?.state, "culprit");
});

test("a culprit with a new revision is judged afresh", () => {
  const works = [work(1)];
  const revised = change(10, [1], { revisions: [{ id: "r1", sha: "sha-10", createdAt: at(0) }, { id: "r2", sha: "new", createdAt: at(5) }] });
  const index = buildIndex(snapshot({ works, changes: [revised], batches: [batch(1, [member(10, "culprit")], { status: "failed" })] }));
  assert.equal(laneOf(works[0]!, index), "in-review");
});

test("the newest open change decides, and a session cut off by a limit still counts", () => {
  const works = [work(1), work(2)];
  const index = buildIndex(
    snapshot({
      works,
      changes: [change(10, [1], { state: "closed", updatedAt: at(9) }), change(11, [1], { draft: true, updatedAt: at(1) })],
      sessions: [session("s", ref("work", 2), { status: "limit" })],
    }),
  );
  assert.equal(situate(works[0]!, index).change?.ref.id, "11");
  assert.equal(laneOf(works[1]!, index), "in-progress");
});

test("an approved change whose Item is parked for a person's question after review waits in review, not in the queue", () => {
  const index = buildIndex(
    snapshot({
      works: [work(1), work(2)],
      changes: [change(10, [1], { verdicts: [verdict("review", "pass")] }), change(20, [2], { verdicts: [verdict("review", "pass")] })],
      parked: [
        { subject: ref("work", 1), as: "needs-decision", reason: "the fix round asked", at: at(-5), decision: { question: "Which way?", options: [], recommendation: "" } },
        { subject: ref("work", 2), as: "queued", reason: "in the queue", at: at(-5) },
      ],
    }),
  );
  assert.deepEqual(index.snapshot.works.map((item) => laneOf(item, index)), ["in-review", "queued"]);
  assert.deepEqual(waitingQueue(index).map((each) => each.ref.id), ["20"]);
  const turn = assessAll(index, new Date(at(0))).find((each) => each.situation.item.ref.id === "1")!;
  assert.equal(turn.tone, "yours");
  assert.match(turn.turn.reason, /Which way\?/);
});
