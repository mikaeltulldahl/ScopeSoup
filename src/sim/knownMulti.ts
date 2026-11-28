// The multiplayer profile's known failures (`multi.ts`): a rule (across machines, of `multiRules.ts`, or a single-machine rule of
// `rules.ts` that fails only with several machines) on one seed of the long or the normal run, and one line. Kept apart from
// `known.ts` so the two lists are merged and shrunk on their own; matched as there, the rule and the seed together. An entry that no
// longer fails comes off. Each entry names its issue.

import type { Known } from "./known.ts";

// Long seed 1's A3 (#261, a question line folded as open while its asker's job had moved on, the log ordered by skewed
// clocks) is no longer reached since a wait for answers lets its claim go (#271): the run plays differently, the cause is not fixed,
// and #261 stays open.
export const KNOWN_MULTI: Known[] = [
  // Skewed clocks in the fold (#261), reached since #270 made a question written while the log has the Item closed ask nothing: a
  // reopen whose clock is behind the close folds before it, so the log stays closed and every later question is ended at once, on
  // main's fold too (three lines: a close at T, a reopen at T - 10 s from another machine, a question at T + 13 s: no open question).
  // The parked job then waits on a question nobody sees (A3), and another machine takes the Item as free (M9).
  { rule: "A3", seed: 36, long: true, what: "a reopen written with a clock behind the close leaves the log closed, so a later park's question is ended at once (#261)" },
  { rule: "A3", seed: 38, long: true, what: "a reopen written with a clock behind the close leaves the log closed, so a later park's question is ended at once (#261)" },
  { rule: "M9", seed: 38, long: true, what: "another machine starts an Item whose park's question the fold ended (a reopen behind the close, #261)" },
];
