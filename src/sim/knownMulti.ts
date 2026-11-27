// The multiplayer profile's known failures (`multi.ts`): rule id (a rule across machines of `multiRules.ts`, or a single-machine
// rule of `rules.ts` that fails only with several machines), the first seed it fails on, and one line. Kept apart from `known.ts`
// so the two lists are merged and shrunk on their own. As there, a rule here that no longer fails comes off, and `long` marks one
// seen only in the long run. Each entry becomes an issue of its own.

import type { Known } from "./known.ts";

export const KNOWN_MULTI: Record<string, Known> = {
  M1: { seed: 1, what: "two machines act on different answers for an Item: an answer given on one board stays in that machine's store (person.answers); the other reads it from the log only after a lost store" },
  M6: { seed: 1, what: "a session on one machine is not told an answer a person gave on another machine's board (the answers are per store)" },
  // Seen in the long run only (seed in the long run).
  A4: { seed: 4, long: true, what: "an Item its own triage blocked is triaged again while still blocked, after another machine changed it (unsure: may be a re-triage on new input, rightly)" },
  J1: { seed: 6, long: true, what: "an Item a person moved to Backlog on another machine is triaged from Backlog by the machine whose job it had: that job is not dropped when the lane arrives by fetch" },
  M2: { seed: 4, long: true, what: "an answer accepted while the machine cannot reach the meta remote is kept in its store only (logged: false) and never written to the log later" },
  M3: { seed: 5, long: true, what: "a re-triage runs without a claim (the implement claim released first), so another machine claims the Item and triages it at the same time" },
  M4: { seed: 31, long: true, what: "a pick carried out whose answer line could not be pushed (the remote kept moving) is never answered on the meta remote, so other boards show it waiting" },
};
