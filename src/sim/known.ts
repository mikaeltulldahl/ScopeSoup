// The failures on today's code: a rule on one seed, in the long run or the normal one, with one line. The simulator's test accepts
// exactly these, the rule and the seed together, and fails on any other failure, also of the same rule on another seed (#268: a rule
// alone hid every failure of it). An entry that no longer fails fails the test too, so this list only shrinks. Each entry names its
// issue; fixing it takes the entry off.

export interface Known {
  rule: string;
  seed: number;
  /** In the long run (`pnpm test:long`), whose seeds the normal run does not play; else in the normal run. */
  long: boolean;
  what: string;
}

/** Whether the list has this rule on this seed, for this run. */
export function isKnown(list: readonly Known[], rule: string, seed: number, long: boolean): boolean {
  return list.some((each) => each.rule === rule && each.seed === seed && each.long === long);
}

export const KNOWN: Known[] = [
  // Reached when #268 changed the long run's draws; it waits for a decision on the meta branch's fold.
  { rule: "A3", seed: 92, long: true, what: "questions parked after a close and a reopen in the same second read as closed by the close (#270)" },
];
