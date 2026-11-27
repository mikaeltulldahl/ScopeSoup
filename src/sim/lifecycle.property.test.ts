// Random runs of the Item lifecycle (src/sim): the real tick, store, sync, host actions and server against a fake clock, host,
// runner, git and person, with the rules of rules.ts checked after every step and a fair tail at the end. A rule that fails is a
// bug, unless it is on the known list (known.ts), which may only shrink.
//
// Seeds 1 to 8 with 80 random steps by default; 1 to 110 with 600 steps and up to 12 Items with SCOPESOUP_LONG=1 (`pnpm test:long`),
// every one in a world where triages age and days pass, so Scope Soup triages To do Items again within its share (#217, #264).
// The same seeds each time. SCOPESOUP_SIM_SEED=17 plays that seed alone; SCOPESOUP_SIM_TRACE=1 prints every step.

import assert from "node:assert/strict";
import { it } from "node:test";
import { KNOWN } from "./known.ts";
import type { RunResult } from "./play.ts";
import { optionsFor, pasteable, play, shrink } from "./play.ts";
import { RULE_IDS } from "./rules.ts";

const LONG = process.env.SCOPESOUP_LONG === "1";
const ONE = process.env.SCOPESOUP_SIM_SEED ? Number(process.env.SCOPESOUP_SIM_SEED) : undefined;
const TRACE = process.env.SCOPESOUP_SIM_TRACE === "1";
const SEEDS = LONG ? 110 : 8;
const STEPS = LONG ? 600 : 80;

async function run(seed: number): Promise<RunResult> {
  return play(seed, { ...optionsFor(seed, LONG, STEPS), trace: TRACE });
}

it("random runs keep the lifecycle rules, apart from the known failures, and reach what the rules are about", async (t) => {
  const seeds = ONE !== undefined ? [ONE] : Array.from({ length: SEEDS }, (_, i) => i + 1);
  const first = new Map<string, RunResult>();
  const totals = { steps: 0, merges: 0, answers: 0, restarts: 0, accepted: 0, rejected: 0, closed: 0, retriagedInShare: 0, retriagedBeforeStart: 0 };
  const waits = new Set<string>();
  // A person's picks and rewrite accepts while the Item's work is busy (#268): how often, and on how many seeds.
  const BUSY = ["queue-pick-over-session", "queue-pick-over-review", "pick-over-session", "pick-over-parked", "pick-over-hand-over", "accept-over-session", "accept-over-parked", "accept-over-hand-over"] as const;
  const busy = new Map<string, { times: number; seeds: number }>(BUSY.map((each) => [each, { times: 0, seeds: 0 }]));
  for (const seed of seeds) {
    const result = await run(seed);
    for (const failure of result.failures) if (!first.has(failure.rule)) first.set(failure.rule, result);
    totals.steps += result.steps;
    totals.merges += result.merges;
    // A person's answers: to questions, and to a triage's rewrite (with its questions). Since questions close when answered (#230),
    // the fake person no longer answers the same stale question again and again.
    totals.answers += (result.seen.get("answered") ?? 0) + ["accept", "edit", "reject"].reduce((sum, each) => sum + (result.seen.get(`rewrite-${each}`) ?? 0), 0);
    totals.restarts += result.seen.get("restart") ?? 0;
    totals.accepted += result.seen.get("rewrite-accept") ?? 0;
    totals.rejected += result.seen.get("rewrite-reject") ?? 0;
    totals.closed += (result.seen.get("close-done") ?? 0) + (result.seen.get("close-abandoned") ?? 0);
    for (const w of result.waits) waits.add(w);
    // Triages Scope Soup took again on its own (#217): within the share while the Item waits in To do, or just before it starts.
    totals.retriagedInShare += result.seen.get("retriage-share") ?? 0;
    totals.retriagedBeforeStart += result.seen.get("retriage-before-start") ?? 0;
    for (const each of BUSY) {
      const n = result.seen.get(each) ?? 0;
      const sum = busy.get(each)!;
      sum.times += n;
      if (n > 0) sum.seeds++;
    }
  }
  t.diagnostic(`${seeds.length} seeds, ${totals.steps} steps, ${totals.merges} merges, ${totals.answers} answers, ${totals.accepted} rewrites accepted and ${totals.rejected} rejected, ${totals.closed} closes, ${totals.restarts} restarts, ${totals.retriagedInShare} triages taken again within the share and ${totals.retriagedBeforeStart} before a start`);
  const said = (each: string): string => `${busy.get(each)!.times} (${busy.get(each)!.seeds} seeds)`;
  t.diagnostic(`while busy: Merge queue picks over a running session ${said("queue-pick-over-session")}, a review among them ${said("queue-pick-over-review")}; picks over a session ${said("pick-over-session")}, a parked job ${said("pick-over-parked")}, an owed hand-over ${said("pick-over-hand-over")}; rewrites accepted and written over a session ${said("accept-over-session")}, a parked job ${said("accept-over-parked")}, an owed hand-over ${said("accept-over-hand-over")}`);

  // A rule that fails and is not known: the first failure in words, its replay, and the steps shrunk to a test to paste.
  const unknown = [...first.keys()].filter((rule) => !(rule in KNOWN));
  if (unknown.length > 0) {
    const parts: string[] = [];
    for (const rule of unknown) {
      const result = first.get(rule)!;
      parts.push(result.reports.get(rule)!);
      if (ONE === undefined || !TRACE) parts.push(`shrunk, to paste into src/sim/rules.test.ts:\n${pasteable(result, rule, await shrink(result, rule))}`);
    }
    assert.fail(`rules that fail and are not on the known list:\n\n${parts.join("\n\n")}`);
  }
  // The known list only shrinks: a known rule that no longer fails comes off it. (A single seed does not tell.)
  if (ONE === undefined) {
    const fixed = Object.keys(KNOWN).filter((rule) => !first.has(rule) && (LONG || !KNOWN[rule]!.long));
    assert.deepEqual(fixed, [], `these rules no longer fail on any seed: take them off the known list in src/sim/known.ts`);
  }
  for (const rule of Object.keys(KNOWN)) assert.ok(RULE_IDS.includes(rule), `the known list names ${rule}, which is not a rule`);

  // The runs reach what the rules are about; otherwise a rule would hold for nothing.
  if (ONE === undefined) {
    assert.ok(totals.merges >= seeds.length, `only ${totals.merges} merges`);
    assert.ok(totals.answers >= seeds.length, `only ${totals.answers} answers`);
    assert.ok(totals.accepted > 0 && totals.rejected > 0, "no rewrite was both accepted and rejected");
    assert.ok(totals.restarts > 0, "no restart");
    assert.ok(totals.closed > 0, "no close by a person");
    const wanted = ["not-started", "session", "nothing", "queue", "person(answer)", "person(rewrite)", "person(not-ready)", "person(holds)", "start(slot)", "start(timer)", "start(same-files)", "start(switch)", "start(level)", "start(usage)", "start(pace)", "tick(paced)"];
    // Seen in the long run only: the normal run's few seeds do not reach an escalation, and reach a blocked Item only by chance (a
    // blockedBy link from a triage that settles while the other Item is open; since #229 none of the 8 seeds does).
    // B9, B10 and J4 must not hold over nothing: the long run reaches triages taken again within the share.
    if (LONG) assert.ok(totals.retriagedInShare > 0, "no triage was taken again within the share");
    if (LONG) wanted.push("person(escalated)", "blocker", "start(cap)", "tick(triage-capped)", "tick(work-capped)");
    for (const w of wanted) {
      assert.ok(waits.has(w), `no Item ever waited as ${w}`);
    }
  }
});

it("a run replays the same: seed 1 played twice writes the same events", async () => {
  const a = await run(1);
  const b = await run(1);
  assert.equal(a.events.length, b.events.length);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.failures, b.failures);
});
