import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job, JobAt, JobParked, JobStep } from "./jobs.ts";
import { phaseOf, pickOf } from "./phase.ts";
import { atStep } from "./jobs.ts";

const base: Job = { item: { host: "meta", kind: "work", id: "A-1" }, workspace: "w", branch: "scopesoup/A-1", failures: 0, fixRounds: 0, startedAt: "2026-01-01T00:00:00Z", at: atStep("triage") };
const job = (at: JobAt, more: Partial<Job> = {}): Job => ({ ...base, ...more, at });
const why = (j: Job): string | undefined => (phaseOf(j) as { why?: string }).why;
const ask = (j: Job): unknown => (phaseOf(j) as { ask?: unknown }).ask;
const parked = (as: JobParked["as"], more: Partial<JobParked> = {}): JobParked => ({ as, reason: "r", at: "2026-01-01T00:00:00Z", ...more });
const parkedAt = (step: JobStep, as: JobParked["as"], more: Partial<JobParked> = {}): JobAt => ({ kind: "parked", step, parked: parked(as, more) });

describe("phaseOf: where the job is, read as one phase", { concurrency: 4 }, () => {
  it("a step waiting or running", () => {
    assert.deepEqual(phaseOf(job(atStep("triage"))), { at: "triage", run: { is: "waiting" }, why: "first" });
    assert.deepEqual(phaseOf(job(atStep("triage", { is: "running", session: "s1" }))), { at: "triage", run: { is: "running", session: "s1" }, why: "first" });
    assert.deepEqual(phaseOf(job(atStep("review", { is: "waiting", notBefore: "2026-01-01T01:00:00Z" }), { failures: 2 })), { at: "review", run: { is: "waiting", timer: { time: "2026-01-01T01:00:00Z", failures: 2, limit: false } } });
  });

  it("an implement step that has begun or not", () => {
    assert.equal(why(job(atStep("implement"))), "first");
    for (const more of [{ head: "abc" }, { resumeWith: "fix" }, { failures: 1 }, { agentSession: "x" }]) {
      assert.equal(why(job(atStep("implement"), more)), "again", JSON.stringify(more));
    }
    assert.equal(why(job({ kind: "implement", run: { is: "waiting" }, merge: true })), "again");
    assert.equal(why(job(atStep("implement", { is: "waiting", resume: "agent-1" }))), "again");
  });

  it("the written text's wait and a timer, each kept", () => {
    assert.deepEqual(phaseOf(job(atStep("implement", { is: "waiting", writing: { from: "h", at: "t" }, notBefore: "n" }))), { at: "implement", run: { is: "waiting", text: { from: "h", at: "t" }, timer: { time: "n", failures: 0, limit: false } }, why: "first" });
  });

  it("merged, and an owed hand-over", () => {
    assert.deepEqual(phaseOf(job({ kind: "merged", step: "review", sha: "m", parked: parked("queued"), closeOwed: { sha: "m" } })), { at: "merged", sha: "m", closeOwed: true });
    assert.deepEqual(phaseOf(job({ kind: "hand-over", step: "review" })), { at: "hand-over" });
  });

  it("each parked kind", () => {
    assert.deepEqual(phaseOf(job(parkedAt("review", "queued"))), { at: "queued" });
    assert.deepEqual(phaseOf(job(parkedAt("review", "handed-over"))), { at: "with-person" });
    assert.deepEqual(phaseOf(job(parkedAt("triage", "not-ready", { verdict: true }))), { at: "not-ready", verdict: true });
    assert.deepEqual(phaseOf(job(parkedAt("implement", "escalated", { byStep: true }))), { at: "stuck", from: "implement" });
    assert.deepEqual(phaseOf(job(parkedAt("implement", "escalated", { retry: "hand-over" }))), { at: "stuck", from: "hand-over" });
    assert.deepEqual(phaseOf(job(parkedAt("implement", "escalated"))), { at: "stuck", from: "change" });
  });

  it("what a parked job asks", () => {
    const q = { question: "Q?", options: [], recommendation: "" };
    const triage = { ready: true, size: "small" as const, paths: [], hidesDecision: true, decision: q, decisions: [q, { ...q, question: "R?" }] };
    assert.deepEqual(phaseOf(job(parkedAt("triage", "needs-decision"), { triage, answered: [{ index: 0, answer: "a", at: "t" }] })), { at: "asked", from: "triage", ask: { is: "questions", n: 2, answered: 1 }, posting: false });
    assert.deepEqual(phaseOf(job(parkedAt("implement", "needs-decision", { byStep: true }), { decision: q })), { at: "asked", from: "implement", ask: { is: "question" }, posting: false });
    assert.deepEqual(ask(job(parkedAt("triage", "needs-decision"), { rewrite: { original: "o", text: "t", questions: [], round: 1 } })), { is: "rewrite" });
    // A post retried is the parked state it could not post.
    assert.deepEqual(phaseOf(job(parkedAt("triage", "escalated", { retry: "post", postingAs: "needs-decision" }))), { at: "asked", from: "triage", ask: { is: "question" }, posting: true });
  });

  it("a settled rewrite or a recheck is a triage of its own kind", () => {
    assert.equal(why(job(atStep("triage"), { rewrite: { original: "o", text: "t", questions: [], round: 1, settled: "accepted" } })), "settled");
    assert.equal(why(job({ kind: "triage", run: { is: "waiting" }, recheck: { reasons: [], previous: { ready: true, size: "small", paths: [], hidesDecision: false }, previousAt: "t", commits: [], commitCount: 0, finished: [] } })), "again");
  });
});

describe("pickOf", () => {
  it("a drop first, then the pick of the step it is at, then the queue", () => {
    assert.deepEqual(pickOf(job(atStep("triage"), { dropAskedBy: "p", triageAskedBy: "q" })), { by: "p", to: "drop" });
    assert.deepEqual(pickOf(job(atStep("triage"), { triageAskedBy: "q" })), { by: "q", to: "triage" });
    assert.equal(pickOf(job(atStep("implement"), { triageAskedBy: "q" })), undefined);
    assert.deepEqual(pickOf(job(atStep("review"), { queueAskedBy: "r" })), { by: "r", to: "queue" });
  });
});
