// Rules across machines (multiRules.ts) built by hand: the bad state, to show the rule fires, and the state next to it that is right.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkItem } from "../model/types.ts";
import type { Job } from "../orchestrator/jobs.ts";
import { atStep } from "../orchestrator/jobs.ts";
import type { MachineObs, MultiObs } from "./multiRules.ts";
import { MULTI_RULES } from "./multiRules.ts";
import type { Ledger } from "./world.ts";

const T0 = Date.parse("2026-11-18T10:00:00.000Z");
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const ref = { host: "metaBranch", kind: "work", id: "A-1" } as const;
const KEY = "metaBranch:work:A-1";

function ledger(over: Partial<Ledger> = {}): Ledger {
  return { requests: [], closesAsked: new Map(), texts: new Map(), ended: [], answers: [], asksInFair: new Map(), skipped: 0, seen: new Map(), ...over };
}

const item: WorkItem = { ref, title: "Item 1", state: "todo", hostState: "todo", labels: [], blockedBy: [], openChildren: 0, updatedAt: iso(0) };

const parked: Job = {
  item: ref, workspace: "w", branch: "scopesoup/A-1", failures: 0, fixRounds: 0, startedAt: iso(0),
  at: { kind: "parked", step: "triage", parked: { as: "needs-decision", reason: "Which one?", at: iso(1) } },
};
const waiting: Job = { ...parked, at: atStep("implement") };

function machine(name: string, over: Partial<MachineObs> = {}): MachineObs {
  return { name, items: [item], answers: [], live: [], events: [], ledger: ledger(), started: [], now: T0 + 2 * 60_000, down: false, jobs: {}, onlineTicks: 0, ...over };
}

const line = (minutes: number, machine: string, kind: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ at: iso(minutes), by: { who: "scopesoup", machine, agent: true }, kind, ...fields });
const claimed = (minutes: number, machine: string): string => line(minutes, machine, "claimed", { until: iso(minutes + 120) });

function obs(machines: MachineObs[], log: string[], step = 1): MultiObs {
  return { step, final: false, machines, remote: new Map([["A-1", { itemMd: "", log: log.join("\n") }]]), requestLines: [], picks: [], filed: [] };
}

const started = (step: number) => ({ step, request: { role: "triage" as const, subject: ref, attempt: 1, workspace: "w", branch: "scopesoup/A-1", vars: {} } });

/** Runs M9 over the observations in order with one memo, and returns the first thing it says is wrong. */
function fires(...steps: MultiObs[]): string | null {
  const rule = MULTI_RULES.find((each) => each.id === "M9")!;
  const memo = {};
  for (const o of steps) {
    const found = rule.check(o, memo);
    if (found) return found;
  }
  return null;
}

describe("M9: a wait for answers belongs to no machine, and one machine goes on after the answer (#271)", () => {
  it("fires when a machine keeps its claim on a job that only waits for answers once it ticked online since", () => {
    const log = [claimed(0, "laptop-b"), line(1, "laptop-b", "question", { question: "Which one?", set: "1" })];
    const b = (ticks: number) => machine("laptop-b", { jobs: { [KEY]: parked }, onlineTicks: ticks });
    assert.equal(fires(obs([machine("laptop-a"), b(3)], log)), null, "the tick that parked may not have let it go yet");
    assert.match(fires(obs([machine("laptop-a"), b(3)], log), obs([machine("laptop-a"), b(4)], log)) ?? "", /A-1 only waits for a person's answers on laptop-b/);
  });

  it("holds when the park let the claim go, while offline, and for a change in the merge queue", () => {
    const released = [claimed(0, "laptop-b"), line(1, "laptop-b", "question", { question: "Which one?", set: "1" }), line(1, "laptop-b", "released")];
    const b = (ticks: number, over: Partial<MachineObs> = {}) => machine("laptop-b", { jobs: { [KEY]: parked }, onlineTicks: ticks, ...over });
    assert.equal(fires(obs([b(3)], released), obs([b(4)], released)), null);
    const held = [claimed(0, "laptop-b")];
    assert.equal(fires(obs([b(3, { down: true })], held), obs([b(4, { down: true })], held)), null);
    const queued: Job = { ...parked, at: { kind: "parked", step: "review", parked: { as: "queued", reason: "In the queue.", at: iso(1) } } };
    assert.equal(fires(obs([b(3, { jobs: { [KEY]: queued } })], held), obs([b(4, { jobs: { [KEY]: queued } })], held)), null);
  });

  it("fires when a second machine goes on after the same answer while the first still holds the Item", () => {
    // laptop-b parked and let go; laptop-a rebuilt the wait from the log. A person answers; laptop-a wins the claim and starts. Then
    // laptop-a parks again and lets go, and laptop-b, which read the old answer, takes the claim and starts its stale job too.
    const answered = ledger({ answers: [{ step: 2, item: KEY, text: "This one." }] });
    const log = [claimed(0, "laptop-b"), line(1, "laptop-b", "released"), claimed(3, "laptop-a")];
    const first = obs([machine("laptop-a", { ledger: answered, started: [started(3)], jobs: { [KEY]: waiting } }), machine("laptop-b", { jobs: { [KEY]: waiting } })], log, 3);
    const relog = [...log, line(4, "laptop-a", "question", { question: "And now?", set: "2" }), line(4, "laptop-a", "released"), claimed(5, "laptop-b")];
    const second = obs([machine("laptop-a", { ledger: answered, started: [started(3)], jobs: { [KEY]: parked } }), machine("laptop-b", { started: [started(5)], jobs: { [KEY]: waiting } })], relog, 5);
    assert.match(fires(first, second) ?? "", /laptop-a went on after the last person's input on it \(step 2\), and laptop-b started a triage session on it too/);
  });

  it("holds when a person's input comes between, the first machine's claim ran out, or it let the Item go", () => {
    const once = ledger({ answers: [{ step: 2, item: KEY, text: "This one." }] });
    const twice = ledger({ answers: [...once.answers, { step: 4, item: KEY, text: "That one." }] });
    const log = [claimed(0, "laptop-a")];
    const a = (over: Partial<MachineObs> = {}) => machine("laptop-a", { ledger: once, started: [started(3)], jobs: { [KEY]: waiting }, ...over });
    const first = obs([a(), machine("laptop-b")], log, 3);
    const after = obs([a({ ledger: twice }), machine("laptop-b", { started: [started(5)] })], [...log, claimed(4, "laptop-b")], 5);
    assert.equal(fires(first, after), null, "an answer at step 4 is a new turn");
    const lapsed = obs([a(), machine("laptop-b", { started: [started(5)] })], [...log, claimed(130, "laptop-b")], 5);
    assert.equal(fires(first, lapsed), null, "laptop-a's claim ran out unrenewed");
    const gone = obs([a({ jobs: {} }), machine("laptop-b", { started: [started(5)] })], [...log, line(4, "laptop-a", "released"), claimed(5, "laptop-b")], 5);
    assert.equal(fires(first, gone), null, "laptop-a's triage found it blocked and let it go");
    const still = obs([a(), machine("laptop-b", { started: [started(5)] })], [...log, claimed(5, "laptop-b")], 5);
    assert.match(fires(first, still) ?? "", /laptop-b started a triage session on it too/);
  });
});
