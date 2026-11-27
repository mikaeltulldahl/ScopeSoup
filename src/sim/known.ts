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
  // Seen in the long run only (seed in the long run).
  // Reached when #268 changed the long run's draws; it waits for a decision on the meta branch's fold.
  A3: { seed: 92, long: true, what: "questions parked after a close and a reopen in the same second read as closed by the close (#270)" },
};
