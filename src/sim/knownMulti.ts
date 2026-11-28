// The multiplayer profile's known failures (`multi.ts`): a rule (across machines, of `multiRules.ts`, or a single-machine rule of
// `rules.ts` that fails only with several machines) on one seed of the long or the normal run, and one line. Kept apart from
// `known.ts` so the two lists are merged and shrunk on their own; matched as there, the rule and the seed together. An entry that no
// longer fails comes off. Each entry names its issue.

import type { Known } from "./known.ts";

export const KNOWN_MULTI: Known[] = [
  // Cross-machine leftovers (#261). Seed 16 stopped failing long ago, and seed 39 once a settled rewrite no longer outlived the Item's
  // close (#211); the rule-only match hid seed 1, which fails on main too.
  { rule: "A3", seed: 1, long: true, what: "a question line folded as open while its asker's job has moved on, the log ordered by skewed clocks (it holds with no skew) (#261)" },
  // Hidden the same way, fails on main too: needs a decision on whose a park is once its claim ran out.
  { rule: "A3", seed: 32, long: true, what: "a machine with a new store rebuilds another machine's park as its own job once that machine's claim ran out (#271)" },
];
