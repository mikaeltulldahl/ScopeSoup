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
  B4: { seed: 62, long: true, what: "a rewrite's question naming another Item as a duplicate stays open, between ticks, after a person closes that Item (#262)" },
};
