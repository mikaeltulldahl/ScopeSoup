// What the board reads about Scope Soup's version and an upgrade: types only, so the web app can import them.

export type TaskState = "downloading" | "waiting" | "switching" | "restarting" | "done" | "failed";

export interface UpgradeTask {
  kind: "upgrade" | "back";
  to: string;
  state: TaskState;
  text: string;
  at: string;
}

export interface UpgradeView {
  now: string;
  version: string;
  /** "release": a release folder in Scope Soup's home; "checkout": a development checkout; "folder": a release folder outside a home. */
  install: "release" | "checkout" | "folder";
  home: string | null;
  checking: boolean;
  checkedAt: string | null;
  checkProblem: string | null;
  /** Why there is no update check here, or null. */
  checkOff: string | null;
  latest: { version: string; notes: string; page: string; publishedAt: string } | null;
  /** The latest release is newer than this version. */
  available: boolean;
  getLatest: { can: boolean; why?: string };
  /** "Go back": the version the last switch left, while its folder is kept. `newer` when that one is newer than this. */
  back: { version: string; newer: boolean; can: boolean; why?: string } | null;
  task: UpgradeTask | null;
  /** After a restart on another version: what was started again (shown for a while, or until dismissed). */
  note: { text: string; at: string } | null;
  lastSwitch: { from: string; to: string; at: string; failedStart?: string; backup?: string } | null;
}
