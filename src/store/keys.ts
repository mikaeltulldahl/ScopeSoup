// Names of the small values (kv) that more than one part reads or writes.

/** The board reads these. The sync writes `runners` and `sync`; the switches (store/control.ts) write `triage`, `implement`, `review` and `mergeQueue`. */
export const KEYS = {
  /** JSON array of runners (model `Runner`, plus an optional `since`). */
  runners: "runners",
  /** "started", "paused" or "stopped" (by Stop): whether triage sessions start. Missing reads as paused. */
  triage: "control.triage",
  /** The same for implementor sessions. */
  implement: "control.implement",
  /** The same for review sessions (and taking on hand-backs). */
  review: "control.review",
  /** "started", "paused" or "stopped" (by Stop): whether Scope Soup merges (level 4). Missing reads as paused. */
  mergeQueue: "control.mergeQueue",
  /** JSON `{ "lastAt"?: string, "error"?: string }`. */
  sync: "sync",
  /** JSON `MergeQueueNote`: who held the merge queue lease when this machine last looked. */
  mergeQueueNote: "mergeQueueNote",
  /** JSON: the units of the limited resources this machine holds, what waits for them, and what other machines held (`resources.ts`). */
  resources: "resources",
  /** The orchestrator's idle reason ("Nothing was started because ..."), written while nothing starts and emptied when something does. */
  idle: "orchestrator.idle_reason",
  /** JSON: the last update check (when, the newest release, a problem), so a restart does not ask again within the day. */
  updateCheck: "scopesoup.update_check",
  /** JSON: what Get latest or Go back paused and the next start is to start again (`{ triage, implement, review, mergeQueue, kind, to, at }`); "" when none. */
  upgradeResume: "scopesoup.upgrade_resume",
  /** JSON `{ text, at }`: the note on the board after that ("Upgraded to 0.6.0; agents started again as before"); "" when none. */
  upgradeNote: "scopesoup.upgrade_note",
  /** `<repo>#<branch>`: the main branch whose "no protection on GitHub" warning a person dismissed; "" when none. */
  branchProtectionDismissed: "scopesoup.branch_protection_dismissed",
} as const;

