// Names of the small values (kv) that more than one part reads or writes.

/** The board reads these. The sync writes `runners` and `sync`; the switches (store/control.ts) write `agents` and `mergeQueue`. */
export const KEYS = {
  /** JSON array of runners (model `Runner`, plus an optional `since`). */
  runners: "runners",
  /** "started", "paused" or "stopped" (by Stop): whether the orchestrator starts sessions. Missing reads as paused. The old `paused` key is not read. */
  agents: "control.agents",
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
} as const;

