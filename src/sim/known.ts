// The rules that fail on today's code: rule id, the first seed it fails on, and one line. The simulator's test accepts these and
// fails on any other; a rule here that no longer fails on any seed fails the test too, so this list only shrinks. `long`: seen only
// in the long run (`pnpm test:long`), whose seeds the normal run does not play. Each entry becomes an issue of its own; fixing it takes
// the entry off.

export interface Known {
  seed: number;
  what: string;
  long?: true;
}

export const KNOWN: Record<string, Known> = {
  F3: { seed: 2, what: "the tick after a tick that committed something says its idle line (or a claim lost) again, though nothing changed" },
  // Seen in the long run only (seed in the long run). Less looked into than the ones above: the report says which may be the simulator's own.
  A3: { seed: 7, long: true, what: "a person's Start over drops an escalated job but leaves its question line open on the host (reached again after #243 moved the runs; #253)" },
  B1: { seed: 34, long: true, what: "a triage after a lost store is not told an answer given before it (an answer that released a not-ready job is not read back from the log; reached again after #243 moved the runs; #253)" },
  C2: { seed: 3, long: true, what: "a change a person merged by hand (an escalated Item's branch) is on main, but the Item stays open" },
  // Since #229 (a released claim is read back at once, with an event about the Item) the normal run's seeds no longer show it.
  F1: { seed: 1, long: true, what: "an Item whose blocker closes goes from blocked to ready with no event about it; a person's release drops a job with none either" },
  H5: { seed: 22, long: true, what: "an Item waiting only for a slot is not started while one is free (the claim of A6)" },
};
