// The multiplayer profile's known failures (`multi.ts`): a rule (across machines, of `multiRules.ts`, or a single-machine rule of
// `rules.ts` that fails only with several machines) on one seed of the long or the normal run, and one line. Kept apart from
// `known.ts` so the two lists are merged and shrunk on their own; matched as there, the rule and the seed together. An entry that no
// longer fails comes off. Each entry names its issue.

import type { Known } from "./known.ts";

// None now. Long seed 1's A3 (#261, a question line folded as open while its asker's job had moved on, the log ordered by skewed
// clocks) is no longer reached since a wait for answers lets its claim go (#271): the run plays differently, the cause is not fixed,
// and #261 stays open.
export const KNOWN_MULTI: Known[] = [];
