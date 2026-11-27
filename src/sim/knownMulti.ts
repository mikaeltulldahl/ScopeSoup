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
  M3: { seed: 5, long: true, what: "a re-triage runs without a claim (the implement claim released first), so another machine claims the Item and triages it at the same time" },
  // Since #238 the words of a timed wait are read after a tick only, and the normal run's seeds no longer show it.
  A1: { seed: 11, long: true, what: "two machines hold a job for one Item: a card on one machine shows the other machine's open question while its own job waits for a timer (the two-jobs problem of M3; #243)" },
};
