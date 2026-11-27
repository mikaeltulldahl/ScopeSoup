// The multiplayer profile's known failures (`multi.ts`): rule id (a rule across machines of `multiRules.ts`, or a single-machine
// rule of `rules.ts` that fails only with several machines), the first seed it fails on, and one line. Kept apart from `known.ts`
// so the two lists are merged and shrunk on their own. As there, a rule here that no longer fails comes off, and `long` marks one
// seen only in the long run. Each entry becomes an issue of its own.

import type { Known } from "./known.ts";

export const KNOWN_MULTI: Record<string, Known> = {
  // Seen in the long run only (seed in the long run).
  // Reached when #223's pace and waiting caps moved the long runs (main passes all 40 seeds); not looked into on #223, so whether #223 caused
  // any of them is not known.
  M8: { seed: 12, long: true, what: "a machine acts on a pick's answer (\"To the merge queue\") on an Item that no person sent, as that machine reads it" },
  A6: { seed: 19, long: true, what: "the idle line says the one slot is in use while no session lives on the machine and an Item waits only for a slot" },
  F3: { seed: 20, long: true, what: "a tick right after a tick drops a job (orchestrator.job_dropped), after a 3-hour clock step" },
  A1: { seed: 36, long: true, what: "Scope Soup's own blockers are kept per store: an Item one machine's triage blocked stays blocked in that store (W) after the blocker left the host's record, while another machine works on it and the board shows its lane (pre-existing on main; the two-jobs cause of #243 is gone)" },
  A3: { seed: 16, long: true, what: "a question line written on an Item closed on another machine, or closed in the same second, is folded as ended or open against what its asker's job says, the log ordered by skewed clocks; and a question post reported as failed that the log took (#248: the parked job that did not settle from answers given on another board is fixed)" },
};
