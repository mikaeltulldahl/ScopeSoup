import assert from "node:assert/strict";
import { test } from "node:test";
import { batchProgress, estimateFor, isLikelyStuck, progressFraction, runProgress } from "./estimates.ts";
import { at, batch, member, passed, run, T0 } from "./testing.ts";
import { refKey } from "../model/types.ts";
import type { Run } from "../model/types.ts";

const now = new Date(T0);
const byKey = (runs: Run[]) => new Map(runs.map((each) => [refKey(each.ref), each]));

test("estimate is the mean of the last ten passed runs of the same pipeline", () => {
  const runs: Run[] = [];
  // Twelve passed runs: the two oldest (60 min) must be ignored.
  for (let i = 0; i < 12; i++) runs.push(passed(i, i < 2 ? 60 : 6, at(-100 + i)));
  runs.push(passed("other", 30, at(-1), "light check"));
  runs.push(run("failed", { status: "failed", startedAt: at(-50), finishedAt: at(-1) }));
  runs.push(run("running", { status: "running", startedAt: at(-500) }));
  assert.equal(estimateFor("full suite", runs), 6 * 60_000);
  assert.equal(estimateFor("light check", runs), 30 * 60_000);
});

test("no history gives no estimate; zero durations are dropped", () => {
  assert.equal(estimateFor("full suite", []), null);
  assert.equal(estimateFor("full suite", [run(1, { status: "passed", startedAt: T0, finishedAt: T0 }), run(2, { status: "passed" })]), null);
});

test("progress is elapsed over estimate, capped at 0.99", () => {
  assert.equal(progressFraction(3, 6), 0.5);
  assert.equal(progressFraction(60, 6), 0.99);
  const history = [passed("h", 6, at(-60))];
  const half = runProgress(run(1, { status: "running", startedAt: at(-3) }), history, now);
  assert.equal(half.state, "running");
  assert.equal(half.fraction, 0.5);
  assert.equal(half.remainingMs, 3 * 60_000);
  assert.equal(half.etaAt, at(3));
  assert.equal(half.words, "3 min of ~6 min");
  const over = runProgress(run(2, { status: "running", startedAt: at(-8) }), history, now);
  assert.equal(over.fraction, 0.99);
  assert.equal(over.remainingMs, undefined);
  assert.equal(over.overByMs, 2 * 60_000);
  assert.equal(over.likelyStuck, false);
});

test("a run with no history is indeterminate, unless the host has its own estimate", () => {
  const bare = runProgress(run(1, { status: "running", startedAt: at(-3) }), [], now);
  assert.equal(bare.state, "indeterminate");
  assert.equal(bare.fraction, undefined);
  const hosted = runProgress(run(2, { status: "running", startedAt: at(-3), estimateMs: 12 * 60_000 }), [], now);
  assert.equal(hosted.fraction, 0.25);
});

test("a queued run waits for a runner; it is not a slow run", () => {
  const progress = runProgress(run(1, { status: "queued", createdAt: at(-2) }), [passed("h", 6)], now);
  assert.equal(progress.state, "waiting-for-runner");
  assert.equal(progress.fraction, undefined);
  assert.equal(progress.words, "waiting for a runner (2 min)");
});

test("likely stuck beyond ten times the estimate, or a day without one", () => {
  assert.equal(isLikelyStuck(60, 6), false);
  assert.equal(isLikelyStuck(61, 6), true);
  assert.equal(isLikelyStuck(23 * 3_600_000, null), false);
  assert.equal(isLikelyStuck(25 * 3_600_000, null), true);
  const stuck = runProgress(run(1, { status: "running", startedAt: at(-61) }), [passed("h", 6, at(-100))], now);
  assert.equal(stuck.likelyStuck, true);
  assert.match(stuck.words, /likely stuck/);
});

test("a finished run reports how long it took", () => {
  assert.equal(runProgress(passed(1, 5), [], now).words, "passed in 5 min");
});

test("batch ETA is the largest remaining time, only once every run has started", () => {
  const history = [passed("h1", 6, at(-60)), passed("h2", 10, at(-60), "browser suite")];
  const a = run("a", { status: "running", startedAt: at(-4) });
  const b = run("b", { status: "running", startedAt: at(-1), pipeline: "browser suite" });
  const both = batch(1, [member(1)], { runs: [a.ref, b.ref] });
  const progress = batchProgress(both, byKey([a, b]), history, now);
  assert.equal(progress.remainingMs, 9 * 60_000);
  assert.equal(progress.etaAt, at(9));
  assert.equal(progress.estimateMs, 10 * 60_000);

  const queued = run("b", { status: "queued", createdAt: at(-1), pipeline: "browser suite" });
  const partly = batchProgress(both, byKey([a, queued]), history, now);
  assert.equal(partly.state, "running");
  assert.equal(partly.etaAt, undefined);

  const waiting = batchProgress(batch(2, [member(1)], { runs: [queued.ref] }), byKey([queued]), history, now);
  assert.equal(waiting.state, "waiting-for-runner");
});

test("a batch with no history is indeterminate and has no ETA; a bisecting batch follows its probe", () => {
  const a = run("a", { status: "running", startedAt: at(-4) });
  const bare = batchProgress(batch(1, [member(1)], { runs: [a.ref] }), byKey([a]), [], now);
  assert.equal(bare.state, "indeterminate");
  assert.equal(bare.etaAt, undefined);

  const old = run("old", { status: "failed", startedAt: at(-20), finishedAt: at(-12) });
  const probe = run("p", { status: "running", startedAt: at(-2) });
  const bisecting = batch(2, [member(1), member(2)], { status: "bisecting", runs: [old.ref], probes: [{ prefix: 1, status: "running", run: probe.ref }] });
  const progress = batchProgress(bisecting, byKey([old, probe]), [passed("h", 8, at(-60))], now);
  assert.equal(progress.fraction, 0.25);
  assert.equal(batchProgress(batch(3, [], { status: "merged" }), new Map(), [], now).state, "finished");
});
