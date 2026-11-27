// A person's action given while a tick runs must survive the tick's save.

import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "../store/store.ts";
import { answerQuestion, loadJobs, jobQuestions, releaseJob, saveJobs, setWhere, where, jobOf } from "./jobs.ts";
import type { Job, Jobs, JobParked, Where } from "./jobs.ts";

function job(id: string, extra: Partial<Job & Where> = {}): Job {
  return jobOf({
    item: { host: "h", kind: "work", id }, workspace: "w", branch: `scopesoup/${id}`, step: "implement", failures: 0, fixRounds: 0,
    startedAt: "2026-11-20T10:00:00Z", ...extra,
  } as Job & Where);
}

const parked: JobParked = { as: "needs-decision", reason: "asks", at: "2026-11-20T10:00:00Z" };
const K1 = "h:work:1";
const K2 = "h:work:2";

test("a release given while a tick holds its jobs is not undone by the tick's save", () => {
  const store = openStore(":memory:");
  const seeded: Jobs = { [K1]: job("1", { parked }), [K2]: job("2", { parked }) };
  store.tx(() => saveJobs(store, seeded));
  const tick = loadJobs(store);
  tick[K2]!.failures = 5; // the tick's own change to another job
  assert.equal(releaseJob(store, { host: "h", kind: "work", id: "1" }, "Ada", "2026-11-20T10:05:00Z", "answered"), true);
  store.tx(() => saveJobs(store, tick));
  const after = loadJobs(store);
  assert.equal(after[K1], undefined, "the released job stays released");
  assert.equal(after[K2]!.failures, 5, "the tick's change is kept");
  assert.equal(tick[K1], undefined, "the tick's map follows the store");
  // A second save does not bring it back.
  store.tx(() => saveJobs(store, tick));
  assert.equal(loadJobs(store)[K1], undefined);
});

test("a proposal accepted while a tick holds its jobs is not undone by the tick's save", () => {
  const store = openStore(":memory:");
  const proposal = { id: "abc12345", reason: "too large", original: "umbrella" as const, parts: [{ title: "Part one", description: "", verification: "", goes: "child" as const }] };
  const asNeedsDecision = { ...parked, as: "needs-decision" } as unknown as JobParked;
  store.tx(() => saveJobs(store, { [K1]: job("1", { parked: asNeedsDecision, proposal }), [K2]: job("2") }));
  const tick = loadJobs(store);
  tick[K2]!.fixRounds = 2;
  assert.equal(releaseJob(store, { host: "h", kind: "work", id: "1" }, "Ada", "2026-11-20T10:05:00Z", "Ada rejected the proposed restructuring."), true);
  store.tx(() => saveJobs(store, tick));
  const after = loadJobs(store);
  assert.equal(after[K1], undefined, "the accepted proposal's job is not parked again");
  assert.equal(after[K2]!.fixRounds, 2);
});

test("a job the tick adds or deletes is kept while the store changed another", () => {
  const store = openStore(":memory:");
  const K3 = "h:work:3";
  store.tx(() => saveJobs(store, { [K1]: job("1", { parked }), [K2]: job("2") }));
  const tick = loadJobs(store);
  tick[K3] = job("3"); // the tick starts an item
  delete tick[K2]; // and finishes another
  releaseJob(store, { host: "h", kind: "work", id: "1" }, "Ada", "2026-11-20T10:05:00Z", "answered");
  store.tx(() => saveJobs(store, tick));
  const after = loadJobs(store);
  assert.deepEqual(Object.keys(after).sort(), [K3]);
  assert.deepEqual(Object.keys(tick).sort(), [K3]);
});

test("a map that was not loaded with loadJobs is saved as it is", () => {
  const store = openStore(":memory:");
  store.tx(() => saveJobs(store, { [K1]: job("1") }));
  store.tx(() => saveJobs(store, { [K2]: job("2") }));
  assert.deepEqual(Object.keys(loadJobs(store)), [K2]);
});

test("a hand-over release (the job stays, owes set) survives the tick's save", () => {
  const store = openStore(":memory:");
  store.tx(() => saveJobs(store, { [K1]: job("1", { parked: { ...parked, retry: "hand-over" } }), [K2]: job("2") }));
  const tick = loadJobs(store);
  setWhere(tick[K2]!, { step: "review" });
  assert.equal(releaseJob(store, { host: "h", kind: "work", id: "1" }, "Ada", "2026-11-20T10:05:00Z", "again"), true);
  store.tx(() => saveJobs(store, tick));
  const after = loadJobs(store);
  assert.equal(where(after[K1])!.parked, undefined);
  assert.equal(where(after[K1])!.owes, "hand-over");
  assert.equal(where(after[K2])!.step, "review");
});

/** A job parked on triage's `count` decisions. */
function asking(id: string, count: number): Job {
  const decisions = Array.from({ length: count }, (_, index) => ({ question: `Question ${index + 1}?`, options: [{ label: "a", description: "" }, { label: "b", description: "" }], recommendation: "a" }));
  return job(id, {
    step: "triage",
    parked: { as: "needs-decision", reason: "asks", at: "2026-11-20T10:00:00Z" },
    triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision: decisions[0], decisions, risk: "low", riskReason: "" },
  } as Partial<Job & Where>);
}

test("several open questions: each answer is kept, and only the last one releases the job", () => {
  const store = openStore(":memory:");
  const item = { host: "h", kind: "work", id: "1" } as const;
  store.tx(() => saveJobs(store, { [K1]: asking("1", 2) }));
  assert.equal(jobQuestions(loadJobs(store)[K1]!).length, 2);
  assert.deepEqual(answerQuestion(store, item, 2, "x", "Ada", "2026-11-20T10:01:00Z"), { refused: "no-questions" }, "no third question");
  assert.deepEqual(answerQuestion(store, item, 0, "x", "Ada", "2026-11-20T10:01:00Z", "2026-11-20T09:00:00Z"), { refused: "parked-changed" }, "read from another parked state");
  assert.deepEqual(answerQuestion(store, item, 1, "b", "Ada", "2026-11-20T10:01:00Z"), { released: false, open: 1 });
  assert.deepEqual(loadJobs(store)[K1]!.answered?.map((each) => [each.index, each.answer]), [[1, "b"]]);
  // A question has one answer: a second one is refused, and the first is kept.
  assert.deepEqual(answerQuestion(store, item, 1, "a", "Ada", "2026-11-20T10:02:00Z"), { refused: "answered" });
  assert.deepEqual(loadJobs(store)[K1]!.answered?.map((each) => [each.index, each.answer]), [[1, "b"]]);
  assert.ok(where(loadJobs(store)[K1])!.parked);
  assert.deepEqual(answerQuestion(store, item, 0, "a", "Ada", "2026-11-20T10:03:00Z", "2026-11-20T10:00:00Z"), { released: true, open: 0 });
  assert.equal(loadJobs(store)[K1], undefined, "an Item parked at triage starts over at triage");
  const released = store.eventsAfter(0, 50).filter((event) => event.kind === "orchestrator.job_released");
  assert.equal(released.length, 1);
  assert.match(String((released[0]!.data as { reason: string }).reason), /all 2 questions: 1\. Question 1\? Answered: a 2\. Question 2\? Answered: b$/);
  // A late answer finds nothing open.
  assert.deepEqual(answerQuestion(store, item, 0, "b", "Ada", "2026-11-20T10:04:00Z"), { refused: "no-questions" });
});

test("a single question is not one of the job's open questions: it is answered and released as before", () => {
  const store = openStore(":memory:");
  store.tx(() => saveJobs(store, { [K1]: asking("1", 1) }));
  assert.deepEqual(jobQuestions(loadJobs(store)[K1]!), []);
  assert.deepEqual(answerQuestion(store, { host: "h", kind: "work", id: "1" }, 0, "a", "Ada", "2026-11-20T10:01:00Z"), { refused: "no-questions" });
});

test("an answer to one of several questions given while a tick holds its jobs survives the tick's save", () => {
  const store = openStore(":memory:");
  store.tx(() => saveJobs(store, { [K1]: asking("1", 2), [K2]: job("2") }));
  const tick = loadJobs(store);
  tick[K2]!.failures = 3;
  assert.deepEqual(answerQuestion(store, { host: "h", kind: "work", id: "1" }, 0, "a", "Ada", "2026-11-20T10:01:00Z"), { released: false, open: 1 });
  store.tx(() => saveJobs(store, tick));
  const after = loadJobs(store);
  assert.deepEqual(after[K1]!.answered?.map((each) => each.index), [0]);
  assert.equal(after[K2]!.failures, 3);
});
