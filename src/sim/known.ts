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
  A1: { seed: 1, what: "a running review on an Item with no change shows in Backlog; a person's wait at a later stage shows in Backlog, not its stage's lane; an Item in Queued while its implementor runs (#207)" },
  A3: { seed: 2, what: "an answer from the page releases the job but leaves the Item's question line open on the host (#194, #209)" },
  B7: { seed: 3, what: "a triage rewrite that only adds whitespace is shown as a rewrite to accept when it comes with questions" },
  C3: { seed: 2, what: "an Item closed while its triage runs keeps its job, its live session and Scope Soup's claim (decision 5)" },
  F1: { seed: 6, what: "an Item whose blocker closes goes from blocked to ready with no event about it; a person's release drops a job with none either" },
  F3: { seed: 2, what: "the tick after a tick that committed something says its idle line (or a claim lost) again, though nothing changed" },
  I2: { seed: 6, what: "an Item closed while its session runs keeps its worktree" },
};
