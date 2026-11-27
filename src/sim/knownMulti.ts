// The multiplayer profile's known failures (`multi.ts`): a rule (across machines, of `multiRules.ts`, or a single-machine rule of
// `rules.ts` that fails only with several machines) on one seed of the long or the normal run, and one line. Kept apart from
// `known.ts` so the two lists are merged and shrunk on their own; matched as there, the rule and the seed together. An entry that no
// longer fails comes off. Each entry names its issue.

import type { Known } from "./known.ts";

export const KNOWN_MULTI: Known[] = [
  // Cross-machine leftovers (#261). Seed 16 stopped failing long ago; the rule-only match hid seeds 1 and 39, which fail on main too.
  { rule: "A3", seed: 1, long: true, what: "a question line folded as open while its asker's job has moved on, the log ordered by skewed clocks (it holds with no skew) (#261)" },
  { rule: "A3", seed: 39, long: true, what: "a not-ready question line written after a person closed the Item on another machine stays open when that machine's job closes (#261)" },
  // Hidden the same way, fails on main too: needs a decision on whose a park is once its claim ran out.
  { rule: "A3", seed: 32, long: true, what: "a machine with a new store rebuilds another machine's park as its own job once that machine's claim ran out (#271)" },
];
