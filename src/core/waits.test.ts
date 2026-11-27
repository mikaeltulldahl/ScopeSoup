import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Phase } from "./phase.ts";
import type { WaitFacts, WaitWorld } from "./waits.ts";
import { waitsFor, WRITING_WAIT_MS } from "./waits.ts";

const now = "2026-01-01T12:00:00.000Z";
const facts: WaitFacts = { closed: false, heldByPerson: false, backlog: false, blockers: [], textHash: "h" };
const world: WaitWorld = { now };
const w = (phase: Phase, more: Partial<WaitFacts> = {}, inWorld: Partial<WaitWorld> = {}, pick?: Parameters<typeof waitsFor>[0]["pick"]) => waitsFor({ phase, facts: { ...facts, ...more }, world: { ...world, ...inWorld }, ...(pick ? { pick } : {}) });
const waiting = (why: "first" | "again" = "first"): Phase => ({ at: "implement", run: { is: "waiting" }, why });

describe("waitsFor: one W from the phase, the Item and the world", { concurrency: 4 }, () => {
  it("closed or merged waits for nothing; a person's hold comes before the job", () => {
    assert.deepEqual(w(waiting(), { closed: true }), { kind: "nothing" });
    assert.deepEqual(w({ at: "merged", sha: "m", closeOwed: false }, { heldByPerson: true }), { kind: "nothing" });
    assert.deepEqual(w({ at: "review", run: { is: "running", session: "s" } }, { heldByPerson: true }), { kind: "person", why: "holds" });
  });

  it("a running step is its session; parked phases wait for a person or the queue", () => {
    assert.deepEqual(w({ at: "review", run: { is: "running", session: "s" } }), { kind: "session", role: "review" });
    assert.deepEqual(w({ at: "asked", from: "triage", ask: { is: "questions", n: 3, answered: 1 }, posting: false }), { kind: "person", why: "answer", n: 2 });
    assert.deepEqual(w({ at: "asked", from: "triage", ask: { is: "rewrite" }, posting: false }), { kind: "person", why: "rewrite" });
    assert.deepEqual(w({ at: "asked", from: "triage", ask: { is: "rewrite" }, posting: true }), { kind: "person", why: "escalated" });
    assert.deepEqual(w({ at: "stuck", from: "hand-over" }), { kind: "person", why: "escalated" });
    assert.deepEqual(w({ at: "with-person" }), { kind: "person", why: "merge" });
    assert.deepEqual(w({ at: "queued" }), { kind: "queue" });
    assert.deepEqual(w({ at: "hand-over" }), { kind: "start", role: "hand-over", cause: "next" });
  });

  it("a step not started: blockers, a drop, Backlog, text, same files, switch, level, usage, pace, timer, claim, cap, slot", () => {
    assert.deepEqual(w(waiting(), { blockers: ["b"] }), { kind: "blocker", on: ["b"] });
    assert.deepEqual(w({ at: "triage", run: { is: "waiting" }, why: "first" }, { blockers: ["b"] }, {}, { by: "p", to: "triage" }), { kind: "start", role: "triage", cause: "slot" });
    assert.deepEqual(w(waiting(), {}, {}, { by: "p", to: "drop" }), { kind: "not-started" });
    assert.deepEqual(w(waiting(), { backlog: true }), { kind: "start", role: "implement", cause: "backlog" });
    assert.deepEqual(w(waiting("again"), { backlog: true }), { kind: "start", role: "implement", cause: "slot" });
    const text: Phase = { at: "implement", run: { is: "waiting", text: { from: "h", at: now } }, why: "first" };
    assert.deepEqual(w(text), { kind: "start", role: "implement", cause: "text" });
    assert.deepEqual(w(text, { textHash: "other" }), { kind: "start", role: "implement", cause: "slot" });
    assert.deepEqual(w(text, {}, { now: new Date(Date.parse(now) + WRITING_WAIT_MS).toISOString() }), { kind: "start", role: "implement", cause: "slot" });
    assert.deepEqual(w(waiting(), {}, { sameFiles: ["x"] }), { kind: "start", role: "implement", cause: "same-files" });
    assert.deepEqual(w(waiting("again"), {}, { sameFiles: ["x"] }), { kind: "start", role: "implement", cause: "slot" });
    assert.deepEqual(w(waiting(), {}, { switches: { triage: "started", implement: "paused", review: "started" }, level: 2 }), { kind: "start", role: "implement", cause: "switch" });
    assert.deepEqual(w(waiting(), {}, { level: 1 }), { kind: "start", role: "implement", cause: "level" });
    assert.deepEqual(w(waiting(), {}, { level: 1 }, { by: "p", to: "implement" }), { kind: "start", role: "implement", cause: "slot" });
    assert.deepEqual(w(waiting(), {}, { usageReserve: true }), { kind: "start", role: "implement", cause: "usage" });
    assert.deepEqual(w(waiting(), {}, { paceHolds: true }), { kind: "start", role: "implement", cause: "pace" });
    const timer: Phase = { at: "review", run: { is: "waiting", timer: { time: "2026-01-01T13:00:00.000Z", failures: 1, limit: false } } };
    assert.deepEqual(w(timer), { kind: "start", role: "review", cause: "timer" });
    assert.deepEqual(w(waiting(), {}, { claimedElsewhere: true }), { kind: "start", role: "implement", cause: "claim" });
    assert.deepEqual(w(waiting(), {}, { workCapped: true }), { kind: "start", role: "implement", cause: "cap" });
    assert.deepEqual(w(waiting("again"), {}, { workCapped: true }), { kind: "start", role: "implement", cause: "slot" });
  });
});
