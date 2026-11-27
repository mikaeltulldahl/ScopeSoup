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
  B7: { seed: 3, what: "a triage rewrite that only adds whitespace is shown as a rewrite to accept when it comes with questions" },
  F3: { seed: 2, what: "the tick after a tick that committed something says its idle line (or a claim lost) again, though nothing changed" },
  // Seen in the long run only (seed in the long run). Less looked into than the ones above: the report says which may be the simulator's own.
  A6: { seed: 22, long: true, what: "the idle line names another machine's claim that the Item's log does not show (unsure: may be the fake host)" },
  D3: { seed: 15, long: true, what: "an implement starts on the same paths as an Item whose implement step began but has no commit yet (busy is read from the head only; #187)" },
  // Since #229 (a released claim is read back at once, with an event about the Item) the normal run's seeds no longer show it.
  F1: { seed: 1, long: true, what: "an Item whose blocker closes goes from blocked to ready with no event about it; a person's release drops a job with none either" },
  H5: { seed: 22, long: true, what: "an Item waiting only for a slot is not started while one is free (the claim of A6)" },
};
