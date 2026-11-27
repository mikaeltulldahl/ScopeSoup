import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job } from "./jobs.ts";
import { phaseOf, pickOf } from "./phase.ts";

const base: Job = { item: { host: "meta", kind: "work", id: "A-1" }, workspace: "w", branch: "scopesoup/A-1", step: "triage", failures: 0, fixRounds: 0, startedAt: "2026-01-01T00:00:00Z" };
const job = (more: Partial<Job>): Job => ({ ...base, ...more });
const why = (j: Job): string | undefined => (phaseOf(j) as { why?: string }).why;
const ask = (j: Job): unknown => (phaseOf(j) as { ask?: unknown }).ask;
const parked = (as: NonNullable<Job["parked"]>["as"], more: Partial<NonNullable<Job["parked"]>> = {}): Job["parked"] => ({ as, reason: "r", at: "2026-01-01T00:00:00Z", ...more });

describe("phaseOf: the job's flags read as one phase, in the order the tick acts on them", { concurrency: 4 }, () => {
  it("a step waiting or running", () => {
    assert.deepEqual(phaseOf(job({})), { at: "triage", run: { is: "waiting" }, why: "first" });
    assert.deepEqual(phaseOf(job({ sessionId: "s1" })), { at: "triage", run: { is: "running", session: "s1" }, why: "first" });
    assert.deepEqual(phaseOf(job({ step: "review", notBefore: "2026-01-01T01:00:00Z", failures: 2 })), { at: "review", run: { is: "waiting", timer: { time: "2026-01-01T01:00:00Z", failures: 2, limit: false } } });
  });

  it("an implement step that has begun or not", () => {
    assert.equal(why(job({ step: "implement" })), "first");
    for (const more of [{ head: "abc" }, { resumeWith: "fix" }, { failures: 1 }, { merge: true as const }, { agentSession: "x" }]) {
      assert.equal(why(job({ step: "implement", ...more })), "again", JSON.stringify(more));
    }
  });

  it("the written text's wait and a timer, each kept", () => {
    assert.deepEqual(phaseOf(job({ step: "implement", writing: { from: "h", at: "t" }, notBefore: "n" })), { at: "implement", run: { is: "waiting", text: { from: "h", at: "t" }, timer: { time: "n", failures: 0, limit: false } }, why: "first" });
  });

  it("merged first, then a session, then an owed hand-over, then parked", () => {
    assert.deepEqual(phaseOf(job({ merged: "m", parked: parked("queued"), closeOwed: { sha: "m" } })), { at: "merged", sha: "m", closeOwed: true });
    assert.equal(phaseOf(job({ step: "implement", sessionId: "s", parked: parked("escalated") })).at, "implement");
    assert.equal(phaseOf(job({ step: "review", owes: "hand-over" })).at, "hand-over");
  });

  it("each parked kind", () => {
    assert.deepEqual(phaseOf(job({ step: "review", parked: parked("queued") })), { at: "queued" });
    assert.deepEqual(phaseOf(job({ step: "review", parked: parked("handed-over") })), { at: "with-person" });
    assert.deepEqual(phaseOf(job({ parked: parked("not-ready", { verdict: true }) })), { at: "not-ready", verdict: true });
    assert.deepEqual(phaseOf(job({ step: "implement", parked: parked("escalated", { byStep: true }) })), { at: "stuck", from: "implement" });
    assert.deepEqual(phaseOf(job({ step: "implement", parked: parked("escalated", { retry: "hand-over" }) })), { at: "stuck", from: "hand-over" });
    assert.deepEqual(phaseOf(job({ step: "implement", parked: parked("escalated") })), { at: "stuck", from: "change" });
  });

  it("what a parked job asks", () => {
    const q = { question: "Q?", options: [], recommendation: "" };
    const triage = { ready: true, size: "small" as const, paths: [], hidesDecision: true, decision: q, decisions: [q, { ...q, question: "R?" }] };
    assert.deepEqual(phaseOf(job({ triage, parked: parked("needs-decision"), answered: [{ index: 0, answer: "a", at: "t" }] })), { at: "asked", from: "triage", ask: { is: "questions", n: 2, answered: 1 }, posting: false });
    assert.deepEqual(phaseOf(job({ step: "implement", decision: q, parked: parked("needs-decision", { byStep: true }) })), { at: "asked", from: "implement", ask: { is: "question" }, posting: false });
    assert.deepEqual(ask(job({ rewrite: { original: "o", text: "t", questions: [], round: 1 }, parked: parked("needs-decision") })), { is: "rewrite" });
    // A post retried is the parked state it could not post.
    assert.deepEqual(phaseOf(job({ parked: parked("escalated", { retry: "post", postingAs: "needs-decision" }) })), { at: "asked", from: "triage", ask: { is: "question" }, posting: true });
  });

  it("a settled rewrite or a recheck is a triage of its own kind", () => {
    assert.equal(why(job({ rewrite: { original: "o", text: "t", questions: [], round: 1, settled: "accepted" } })), "settled");
    assert.equal(why(job({ recheck: { reasons: [], previous: { ready: true, size: "small", paths: [], hidesDecision: false }, previousAt: "t", commits: [], commitCount: 0, finished: [] } })), "again");
  });
});

describe("pickOf", () => {
  it("a drop first, then the pick of the step it is at, then the queue", () => {
    assert.deepEqual(pickOf(job({ dropAskedBy: "p", triageAskedBy: "q" })), { by: "p", to: "drop" });
    assert.deepEqual(pickOf(job({ triageAskedBy: "q" })), { by: "q", to: "triage" });
    assert.equal(pickOf(job({ step: "implement", triageAskedBy: "q" })), undefined);
    assert.deepEqual(pickOf(job({ step: "review", queueAskedBy: "r" })), { by: "r", to: "queue" });
  });
});
