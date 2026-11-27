// The multiplayer profile's known failures (`multi.ts`): rule id (a rule across machines of `multiRules.ts`, or a single-machine
// rule of `rules.ts` that fails only with several machines), the first seed it fails on, and one line. Kept apart from `known.ts`
// so the two lists are merged and shrunk on their own. As there, a rule here that no longer fails comes off, and `long` marks one
// seen only in the long run. Each entry becomes an issue of its own.

import type { Known } from "./known.ts";

export const KNOWN_MULTI: Record<string, Known> = {
  // Seen in the long run only (seed in the long run).
  A1: { seed: 36, long: true, what: "Scope Soup's own blockers are kept per store: an Item one machine's triage blocked stays blocked in that store (W) after the blocker left the host's record, while another machine works on it and the board shows its lane (pre-existing on main; the two-jobs cause of #243 is gone)" },
  A3: { seed: 16, long: true, what: "a question line written on an Item closed on another machine, or closed in the same second, is folded as ended or open against what its asker's job says, the log ordered by skewed clocks; and a question post reported as failed that the log took (#248: the parked job that did not settle from answers given on another board is fixed)" },
};
