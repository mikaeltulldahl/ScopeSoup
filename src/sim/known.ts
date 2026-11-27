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
  // Reached when #223's pace and waiting caps moved the long runs (main passes all 100 seeds; the shrunk steps of D1, B4, B7 and C2 fail on
  // main too, A1 and A3 only on these paths). Not looked into further on #223.
  D1: { seed: 1, long: true, what: "slots lowered while a tick awaits a start: the tick starts the next session by the old number (fails on main with the shrunk step)" },
  A3: { seed: 12, long: true, what: "a re-triage's new park is released by an answer to the earlier park read from the Item's log, leaving its question open" },
  A1: { seed: 12, long: true, what: "after lost stores, an Item a triage found blocked shows in In review, not Blocked" },
  C2: { seed: 12, long: true, what: "an Item whose change is on main stays in To do for more than 2 ticks (fails on main with the shrunk steps)" },
  B4: { seed: 62, long: true, what: "a rewrite's question names an Item that is closed meanwhile (fails on main with the shrunk steps)" },
  B7: { seed: 77, long: true, what: "a triage starts again with the same input after it succeeded (fails on main with the shrunk steps)" },
};
