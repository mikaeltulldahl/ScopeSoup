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
  // Seen in the long run only (seed in the long run). Less looked into than the ones above: the report says which may be the simulator's own.
  // Since #229 (a released claim is read back at once, with an event about the Item) the normal run's seeds no longer show it.
  // Pre-existing on main (its shrunk steps fail there too), reached when #223's pace and waiting caps moved the long runs.
  C2: { seed: 12, long: true, what: "a job rebuilt from the log after a lost store keeps a head already on main and waits at its implement step behind the paused switch instead of closing as merged (#262)" },
  B4: { seed: 62, long: true, what: "a rewrite's question naming another Item as a duplicate stays open, between ticks, after a person closes that Item (#262)" },
  B7: { seed: 77, long: true, what: "a re-triage orphaned by a restart is started again with the same input and counted as a repeat after success (unsure: may be the simulator's ledger) (#262)" },
};
