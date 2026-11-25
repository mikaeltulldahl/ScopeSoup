// The project configuration. Loaded from `scopesoup.config.json`; see docs/RULES.md for the core rules and the levels.
// Every rule and every number carries the reason it was set, in the words of whoever set it.

import type { SessionRole } from "../model/types.ts";

export const ROLES: readonly SessionRole[] = ["triage", "implement", "review"];

export interface NumberSetting {
  value: number;
  /** Why, in the words of whoever set it; "" when the file gives none (the settings page asks for none). */
  reason: string;
}

export interface Settings {
  /** Most sessions at once, of every role: 1 favours efficiency, more favours speed. */
  maxParallelSessions: NumberSetting;
  tickSeconds: NumberSetting;
  /** No stream event for this long is a stall. */
  stallTimeoutMinutes: NumberSetting;
  /** Hard limit on one session, whatever it is doing. */
  sessionTimeoutMinutes: NumberSetting;
  /** Slider 1 to 5 over the share of the 5-hour and weekly windows kept for people's own use; see budgetReserve.ts. */
  budgetReserve: NumberSetting;
  /** Older exact share of the 5-hour window, 0 to 1. Still accepted; when present it replaces the slider's value. */
  reserveFiveHour?: NumberSetting;
  /** Older exact share of the weekly window, 0 to 1. Still accepted; when present it replaces the slider's value. */
  reserveSevenDay?: NumberSetting;
  /** Slider 1 to 5 over the failed attempts of one step and the review-and-fix rounds before the item goes to a person; see persistence.ts. */
  persistence: NumberSetting;
  retryBackoffCapSeconds: NumberSetting;
  /** The most the check command may run at merging before it is stopped and counts as failed. */
  checkTimeoutMinutes: NumberSetting;
  /** The merge queue's smallest batch: at least this many ready changes are tried together once the queue has the outcomes to size by (level 4). */
  queueMinBatch: NumberSetting;
  /** The merge queue's largest batch: a chain is never longer than this. */
  queueMaxBatch: NumberSetting;
  /** f: what a red check costs in addition, as a share of a full check, until the queue's own reruns have measured it. */
  queueRerunCost: NumberSetting;
  /** How many outcomes (merged changes and culprits) the queue needs before it sizes batches by the model instead of the plain rule. */
  queueMinOutcomes: NumberSetting;
  /** Days after which a waiting Item's triage is taken again before its implement step. Optional in the file. */
  triageMaxAgeDays: NumberSetting;
}

export type SettingName = keyof Settings;

/** The agent CLIs a role can run on (`src/orchestrator/providers/`). */
export const PROVIDER_NAMES = ["claude", "copilot"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface RoleConfig {
  /** The agent CLI the role's sessions run on. Absent: "claude". */
  provider?: ProviderName;
  /** The model, in the words of the role's provider. */
  model: string;
  /** Copilot only: the Auto routing profile (`--auto-tier`) when the model is "fusion" or "auto". Absent there: "balance". */
  autoTier?: string;
  maxTurns: number;
  /** Permission rules passed as `--allowedTools`. */
  allowedTools: string[];
  permissionMode: string;
  /** MCP servers the role's sessions get, by name (`mcpServers`, docs/RUNNING.md). Their tools are added to `allowedTools` when the file is read. */
  mcpServers?: Record<string, McpServer>;
}

/** One MCP server of a role. Values never sit in the file: `env` names variables whose values come from the environment. */
export interface McpServer {
  command: string;
  args?: string[];
  env?: string[];
}

/** The `allowedTools` entry that allows every tool of an MCP server (Claude Code's own form, `mcp__<server>`). */
export const MCP_TOOL_PREFIX = "mcp__";
export function mcpToolEntry(server: string): string {
  return `${MCP_TOOL_PREFIX}${server}`;
}

export interface ClaudeConfig {
  /** The executable. Spawned directly, never through a shell (on Windows: an .exe, not a .cmd). */
  path: string;
  /** Arguments placed before Scope Soup's own, for running the CLI through `node <script>`. */
  prefixArgs: string[];
  /** Arguments placed after Scope Soup's own. */
  extraArgs: string[];
  /** How the prompt reaches the CLI. "stdin" has no length limit. */
  promptVia: "stdin" | "arg";
  /** Remove ANTHROPIC_API_KEY from the child's environment so sessions draw from the subscription. */
  dropApiKeyEnv: boolean;
}

export interface CopilotConfig {
  /** The executable. Spawned directly, never through a shell (on Windows: copilot.exe, not a .cmd). */
  path: string;
  /** Arguments placed before Scope Soup's own, for running the CLI through `node <script>`. */
  prefixArgs: string[];
  /** Arguments placed after Scope Soup's own. */
  extraArgs: string[];
}

/**
 * "worktree": git worktrees of `repoPath` under `workspacesDir`, reused across items like a pool (`slots.ts`).
 * "pool": full clones kept side by side (for a project that is a submodule of an outer repository).
 * A session gets a free clone and works in `<clone>/<projectSubdir>`, the project's own repository.
 */
export type WorkspacesConfig =
  | { kind: "worktree" }
  | {
    kind: "pool";
    /** Absolute. The clones, in the order they are handed out. */
    paths: string[];
    /** Relative to each clone, inside it. "." when the clone is the project's repository. */
    projectSubdir: string;
    /**
     * Gitignore patterns, relative to the project's repository, for build output that is not
     * ignored: kept when a session's leftovers are discarded as its clone is freed. Absent: none.
     */
    keep?: string[];
  };

/**
 * Where the project's items live. Tokens are never here: they stay in the environment.
 * Absent: the host comes from the SCOPESOUP_GITHUB_* and SCOPESOUP_META_* environment variables.
 */
export type HostConfig =
  | {
    kind: "github";
    /** "owner/name". */
    repo: string;
    /** Write issues, labels and comments, and at level 4 with mergeQueue.ci "github" the batches' pull requests (SCOPESOUP_WRITE=1). */
    write: boolean;
  }
  | {
    kind: "metaBranch";
    /** Absolute. The repository whose meta ref (`refs/scopesoup/meta`) holds the items: `repoPath`, or from the environment. */
    repoPath: string;
    /** Create and edit items, append to logs, fetch and push the meta ref. */
    write: boolean;
    /** With write: the person meta commits are made as. */
    authorName?: string;
    authorEmail?: string;
    /** With write: this machine's prefix of item ids (A gives A-12). */
    prefix?: string;
    /** The remote the meta ref is shared with (`remote`); null for none. */
    remote: string | null;
    fetchSeconds: number;
  }
  | JiraHostConfig;

/**
 * A Jira project, Cloud or Data Center, written to with `write`. The token is SCOPESOUP_JIRA_TOKEN:
 * Cloud an API token with the account's `email` (this machine's `jira.email`), Data Center a personal access token.
 */
export interface JiraHostConfig {
  kind: "jira";
  /** `https://example.atlassian.net`, or the Data Center base URL; no trailing slash. */
  site: string;
  /** The project key, `DEMO`. */
  project: string;
  deployment: "cloud" | "datacenter";
  /** Write issues, comments, labels and properties (a level above Watch needs it). */
  write: boolean;
  /** Cloud: the account's email, from this machine's private file (`jira.email`). */
  email?: string;
  /** Jira priority name -> Scope Soup priority; replaces the defaults (Jira's default names) when given. */
  priorities?: Record<string, "blocker" | "critical" | "major" | "minor">;
  /** Resolutions that make a done issue abandoned; replaces the defaults when given. */
  abandonedResolutions?: string[];
  /** The issue link type read as "is blocked by". Default "Blocks". */
  blocksLink?: string;
  /** The issue type of a new Item. Default "Task". */
  issueType?: string;
  /** The issue type of a split's child. Default "Sub-task". */
  childIssueType?: string;
  /** The transition (or the status it goes to) per target; defaults "To Do", "In Progress", "Done", "Won't Do". */
  transitions?: Partial<Record<"todo" | "doing" | "done" | "abandoned", string>>;
  /** The resolution a transition's screen gets when it asks for one; defaults "Done", "Won't Do", "Duplicate". */
  resolutions?: Partial<Record<"done" | "abandoned" | "duplicate", string>>;
  /** The link type from a follow-up to its Item. Default "Relates". */
  relatesLink?: string;
  /** The link type from a duplicate to its original. Default "Duplicate". */
  duplicateLink?: string;
  /** About the most a comment Scope Soup posts may hold, in characters, counted on the body as sent. Default 32000. */
  commentLimit?: number;
  /** People whose answers count besides the project's assignable users: account ids (Cloud) or user names (Data Center). */
  answerers?: string[];
}

/**
 * What checks a batch of the merge queue. "local" (the default): `checkCommand` in the queue's clone. "github": the
 * project's own CI on GitHub, on a pull request Scope Soup opens for the batch's commit (a GitHub host with writes on).
 */
export interface MergeQueueConfig {
  ci: "local" | "github";
  /** With ci "github": how long a check may stay pending before the batch's Items are parked for a person. Default 60. */
  ciTimeoutMinutes: number;
}

export const DEFAULT_CI_TIMEOUT_MINUTES = 60;

/** What checks the merge queue's batches: "local" unless the file says `mergeQueue.ci: "github"`. */
export function mergeQueueCi(config: Pick<ProjectConfig, "mergeQueue">): MergeQueueConfig["ci"] {
  return config.mergeQueue?.ci ?? "local";
}

/** What needs a resource: a session of a role, or the merge queue's check. */
export type ResourceUser = SessionRole | "check";
export const RESOURCE_USERS: readonly ResourceUser[] = [...ROLES, "check"];

/**
 * A limited resource (a license seat, an emulator, a phone on USB, a test database). A session or check that needs one takes
 * a unit before it starts and gives it back when it ends; without a free unit it waits. `resources` in the private file are this
 * machine's own; `sharedResources` in the shared settings are held across machines on the project's remote, one lease per unit.
 */
export interface ResourceConfig {
  /** Letters, digits, "-" and "_": it names the unit's ref on the remote. */
  name: string;
  units: number;
  shared: boolean;
  neededBy: ResourceUser[];
  /** Environment variables for the session or check that holds a unit; `{{unit}}` in a value is the unit's number, from 1. */
  env: Record<string, string>;
}

export const LEVELS = [0, 1, 2, 3, 4] as const;
export type Level = (typeof LEVELS)[number];

/** The name of each level, as the board and the notices show it. */
export const LEVEL_NAMES: Readonly<Record<Level, string>> = { 0: "Watch", 1: "Triage", 2: "Implement", 3: "Review", 4: "Autopilot" };

/** "level 2 (Implement)", as notices and events say it. */
export function levelName(level: Level): string {
  return `level ${level} (${LEVEL_NAMES[level]})`;
}

export interface ProjectConfig {
  project: string;
  /** Absent: the host comes from the environment. */
  host?: HostConfig;
  /** Absolute. The clone Scope Soup makes worktrees from. */
  repoPath: string;
  mainBranch: string;
  /** The git remote the main branch is fetched from before a new item branch is made. */
  remote: string;
  /** Absolute. This machine's own clone of the project, which `{{ownClone}}` in setupCommand stands for. */
  ownClone?: string;
  /** Core rule 1: absolute paths marked as real. Sessions never run in or around them. */
  realPaths: string[];
  /**
   * How much Scope Soup does on its own, 0 to 4; each level includes the ones below (docs/RUNNING.md, "Levels").
   * 0 Watch: shows the work, starts nothing, merges nothing. 1 Triage: triage sessions only. 2 Implement.
   * 3 Review: every built change is reviewed. 4 Autopilot: Scope Soup merges reviewed changes.
   */
  level: Level;
  /** Windows: keep the machine from sleeping while sessions run or work waits. No effect elsewhere. */
  keepAwake: boolean;
  /**
   * This machine's name where hosts show it: claim comments, log lines, the merge queue lease, session commits. Required, and
   * the only way to name the machine. Never the computer's host name, which a public repository would show to everyone.
   */
  machineName: string;
  /** Absolute. Worktrees for sessions live here. */
  workspacesDir: string;
  /** Where sessions work: git worktrees reused across items (the default), or a clone taken from a pool. */
  workspaces: WorkspacesConfig;
  /** Absolute. One raw stream file per session. */
  streamsDir: string;
  /** Absolute. Prompt templates and answer schemas. */
  promptsDir: string;
  /** Labels that mark an item as a bug; bugs go first. */
  bugLabels: string[];
  /**
   * The repository `remote` must point at before Scope Soup pushes the main branch. Required at level 4 (Autopilot), where Scope Soup merges
   * every reviewed change through the batching merge queue (`src/queue`): a batch is built into one chain, checked, and pushed to
   * the main branch, fast-forward only (one waiting change is a batch of one). Below level 4 Scope Soup merges nothing.
   */
  remoteUrl?: string;
  /** The program and its arguments, run without a shell in the item's repository at merging in the queue's own clone, on each chain (level 4). Without it nothing merges. */
  checkCommand?: string[];
  /**
   * Level 4: the check command for rerunning only the test files that failed, so a
   * flake is told from a real failure without running the whole suite again. The program and its
   * arguments, with exactly one argument that is `{files}`: it is replaced by one argument per failed
   * file, for example `["node", "--test", "{files}"]`. Without it the whole check is run again.
   */
  rerunFilesCommand?: string[];
  /**
   * The program and its arguments that set up a fresh clone (dependencies, generated files, ignored personal files copied
   * from the person's own clone), usually a setup script the onboarding skill wrote. Run without a shell in each workspace before
   * an implement or review session, and in the queue's clone before the check: once per folder, and again when the content of a
   * file in `setupWatch` (or the command, or a script it names) changes. Absent: nothing is set up.
   */
  setupCommand?: string[];
  /**
   * The files, relative to the project's repository, whose content decides when the setup runs again: lockfiles and what
   * code generation reads. `*` stands for any characters inside one part of a path (`requirements*.txt`). Absent: the files of
   * `DEFAULT_SETUP_WATCH` that are there.
   */
  setupWatch?: string[];
  /** What the merge queue waits for at level 4. Absent: the check command in the queue's clone, as `{ ci: "local" }`. */
  mergeQueue?: MergeQueueConfig;
  /** This machine's resources (`resources`) and the shared ones (`sharedResources`), in that order. Absent: none. */
  resources?: ResourceConfig[];
  claude: ClaudeConfig;
  /** The Copilot CLI, for roles whose provider is "copilot". Absent: `defaultCopilot()`. */
  copilot?: CopilotConfig;
  settings: Settings;
  roles: Record<SessionRole, RoleConfig>;
}
