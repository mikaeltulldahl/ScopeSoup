// Random runs of the multiplayer profile (src/sim/multi.ts): two or three machines on one meta remote, each with its own store,
// server, tick and clock, with the single-machine rules checked per machine and the rules across machines (multiRules.ts) after
// every step and at the end. A rule that fails is a bug, unless it is known: on the single-machine list (known.ts) for a rule of
// rules.ts, or on the multiplayer list (knownMulti.ts), which may only shrink.
//
// Seeds 1 to 3 with 60 random steps by default; 1 to 40 with 400 steps with SCOPESOUP_LONG=1 (`pnpm test:long`). The same seeds
// each time. SCOPESOUP_SIM_SEED=17 plays that seed alone; SCOPESOUP_SIM_TRACE=1 prints every step.

import assert from "node:assert/strict";
import { it } from "node:test";
import { KNOWN } from "./known.ts";
import { KNOWN_MULTI } from "./knownMulti.ts";
import type { MultiResult } from "./multi.ts";
import { multiOptionsFor, playMulti } from "./multi.ts";
import { MULTI_RULE_IDS } from "./multiRules.ts";
import { RULE_IDS } from "./rules.ts";

const LONG = process.env.SCOPESOUP_LONG === "1";
const ONE = process.env.SCOPESOUP_SIM_SEED ? Number(process.env.SCOPESOUP_SIM_SEED) : undefined;
const TRACE = process.env.SCOPESOUP_SIM_TRACE === "1";
const SEEDS = LONG ? 40 : 3;
const STEPS = LONG ? 400 : 60;

it("multiplayer runs converge and keep the rules across machines, apart from the known failures", async (t) => {
  const seeds = ONE !== undefined ? [ONE] : Array.from({ length: SEEDS }, (_, i) => i + 1);
  const first = new Map<string, MultiResult>();
  const seen = new Map<string, number>();
  let steps = 0;
  for (const seed of seeds) {
    const result = await playMulti(seed, { ...multiOptionsFor(seed, LONG, STEPS), trace: TRACE });
    for (const failure of result.failures) if (!first.has(failure.rule)) first.set(failure.rule, result);
    for (const [what, n] of result.seen) seen.set(what, (seen.get(what) ?? 0) + n);
    steps += result.steps;
  }
  t.diagnostic(`${seeds.length} seeds, ${steps} steps, ${[...seen].sort().map(([what, n]) => `${what} ${n}`).join(", ")}`);

  const known = (rule: string): boolean => rule in KNOWN_MULTI || rule in KNOWN;
  const unknown = [...first.keys()].filter((rule) => !known(rule));
  assert.deepEqual(unknown, [], `rules that fail and are not on a known list:\n\n${unknown.map((rule) => first.get(rule)!.reports.get(rule)!).join("\n\n")}`);
  if (ONE === undefined) {
    const fixed = Object.keys(KNOWN_MULTI).filter((rule) => !first.has(rule) && (LONG || !KNOWN_MULTI[rule]!.long));
    assert.deepEqual(fixed, [], "these rules no longer fail on any seed: take them off the list in src/sim/knownMulti.ts");
  }
  for (const rule of Object.keys(KNOWN_MULTI)) assert.ok(MULTI_RULE_IDS.includes(rule) || RULE_IDS.includes(rule), `the multiplayer known list names ${rule}, which is not a rule`);

  // The runs reach what the rules are about.
  if (ONE === undefined) {
    for (const what of ["fetch", "race", "offline", "restart", "answered"]) assert.ok((seen.get(what) ?? 0) > 0, `no ${what} in the runs`);
    if (LONG) assert.ok((seen.get("pick-requested") ?? 0) > 0, "no pick was requested of another machine");
  }
});
