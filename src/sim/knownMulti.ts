// The multiplayer profile's known failures (`multi.ts`): rule id (a rule across machines of `multiRules.ts`, or a single-machine
// rule of `rules.ts` that fails only with several machines), the first seed it fails on, and one line. Kept apart from `known.ts`
// so the two lists are merged and shrunk on their own. As there, a rule here that no longer fails comes off, and `long` marks one
// seen only in the long run. Each entry becomes an issue of its own.

import type { Known } from "./known.ts";

export const KNOWN_MULTI: Record<string, Known> = {
  M1: { seed: 1, what: "two machines act on different answers for an Item: an answer given on one board stays in that machine's store (person.answers); the other reads it from the log only after a lost store" },
  M6: { seed: 1, what: "a session on one machine is not told an answer a person gave on another machine's board (the answers are per store)" },
  // Seen in the long run only (seed in the long run).
  A1: { seed: 36, long: true, what: "Scope Soup's own blockers are kept per store: an Item one machine's triage blocked stays blocked in that store (W) after the blocker left the host's record, while another machine works on it and the board shows its lane (pre-existing on main; the two-jobs cause of #243 is gone)" },
  A3: { seed: 1, long: true, what: "a job parked on a question that is not open on the host, across machines (#248)" },
  H5: { seed: 1, long: true, what: "an Item waiting only for a slot is not started while one is free, across machines (#256)" },
  B1: { seed: 12, long: true, what: "an answer given once is in a machine's store twice (#256)" },
};
