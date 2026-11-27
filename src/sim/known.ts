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
  C3: { seed: 2, what: "an Item closed while its triage runs keeps its job, its live session and Scope Soup's claim (decision 5)" },
  F3: { seed: 2, what: "the tick after a tick that committed something says its idle line (or a claim lost) again, though nothing changed" },
  I2: { seed: 6, what: "an Item closed while its session runs keeps its worktree" },
  // Seen in the long run only (seed in the long run). Less looked into than the ones above: the report says which may be the simulator's own.
  A6: { seed: 22, long: true, what: "the idle line names another machine's claim that the Item's log does not show (unsure: may be the fake host)" },
  F1: { seed: 1, long: true, what: "an Item whose blocker closes goes from blocked to ready with no event about it; a person's release drops a job with none either" },
  B1: { seed: 7, long: true, what: "a triage after a start over or a lost store is not told an answer given before" },
  C1: { seed: 62, long: true, what: "an answer on one Item closes the other Item of a duplicate pair (decision 8: a close only from the Item's own page; #209)" },
  C2: { seed: 3, long: true, what: "a change a person merged by hand (an escalated Item's branch) is on main, but the Item stays open" },
  D3: { seed: 15, long: true, what: "an implement starts on the same paths as an Item whose implement step began but has no commit yet (busy is read from the head only; #187)" },
  D7: { seed: 5, long: true, what: "a worktree stays held for an Item whose job is gone (closed, or after a lost store)" },
  E4: { seed: 13, long: true, what: "a session that merged without being told to is not escalated (decision 108)" },
  G1: { seed: 1, long: true, what: "after a restart an Item that had a running implementor shows an old rewrite to accept" },
  H1: { seed: 8, long: true, what: "after a lost store an Item rebuilt as queued waits in a merge queue that no longer has it, for ever" },
  H3: { seed: 3, long: true, what: "Scope Soup's claim on an Item outlives its session by more than 120 minutes" },
  H5: { seed: 22, long: true, what: "an Item waiting only for a slot is not started while one is free (the claim of A6)" },
  I1: { seed: 34, long: true, what: "after the store is lost while the host is down, an Item's branch belongs to no Item the store knows (may be the simulator's setup)" },
  I3: { seed: 34, long: true, what: "the same moment as I1: Scope Soup's branches and worktrees over the bound for the open Items known" },
  I4: { seed: 7, long: true, what: "an Item's branch with work not on main is deleted without a person's close" },
};
