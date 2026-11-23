// The manifest's entries (`manifest.ts`), with no imports, so the board's build can read the offboarding plan's types.

/** What a project file holds of Scope Soup's. */
export type ProjectChange = "claude-md-section" | "plugin-settings" | "setup-script";

export type ManifestThing =
  /** A folder Scope Soup made outside the config folder: its clone, the workspaces, the streams, the data folder. */
  | { kind: "folder"; path: string; what: string }
  /** A ref Scope Soup wrote on the project's remote. */
  | { kind: "ref"; ref: string; what: string }
  /** A branch Scope Soup pushed to the project's remote (the setup script's `scopesoup/onboard`). */
  | { kind: "branch"; branch: string; what: string }
  /** A label Scope Soup created on GitHub. */
  | { kind: "label"; repo: string; name: string }
  /** A file in the project's repository that Scope Soup's onboarding added to or changed, for the person to commit. */
  | { kind: "project-file"; path: string; change: ProjectChange };

export type ManifestEntry = ManifestThing & { at: string; by: string };

