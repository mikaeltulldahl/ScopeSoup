// What a blank project gets: the core only, at level 0.

import type { SessionRole } from "../model/types.ts";
import type { ClaudeConfig, CopilotConfig, ProviderName, RoleConfig, Settings } from "./types.ts";

/** What `machineName` may be: letters, digits, `-`, `_` and `.`, 1 to 40 of them. */
export const MACHINE_NAME = /^[A-Za-z0-9._-]{1,40}$/;
const GUESS = "Starting guess; change it when it proves wrong.";

export function defaultSettings(): Settings {
  return {
    maxParallelSessions: { value: 1, reason: "One session at a time: the efficient end of the slider." },
    tickSeconds: { value: 30, reason: GUESS },
    stallTimeoutMinutes: { value: 5, reason: GUESS },
    sessionTimeoutMinutes: { value: 60, reason: GUESS },
    budgetFiveHour: { value: 0.8, reason: "80% of the 5-hour window's even pace: the rest is kept for people's own use." },
    budgetSevenDay: { value: 0.8, reason: "80% of the weekly window's even pace: the rest is kept for people's own use." },
    waitingCapTriage: { value: 2, reason: "New triage stops first, so an implementor's questions are not crowded out." },
    waitingCapWork: { value: 5, reason: "No more new work than a person can answer for." },
    retriageShare: { value: 0.05, reason: "A twentieth of what Scope Soup uses keeps To do's triages fresh, however long the list (#217)." },
    persistence: { value: 3, reason: "The middle position: 3 attempts and 2 review rounds, as before the slider existed." },
    retryBackoffCapSeconds: { value: 300, reason: GUESS },
    checkTimeoutMinutes: { value: 60, reason: "The check is expected to take about 10 minutes; the limit is well above that." },
    queueMinBatch: { value: 2, reason: "Two changes are the smallest batch worth building into one chain." },
    queueMaxBatch: { value: 12, reason: "Keeps chains short to build, the wait to merge reasonable and conflicts rare (docs/BATCH_SIZE.md)." },
    queueRerunCost: { value: 0.15, reason: "A rerun of only the failed files costs about a seventh of a full check; the queue measures it and moves away from this." },
    queueMinOutcomes: { value: 10, reason: "Ten merged or sent-back changes are enough to size batches by the model; fewer use the plain rule." },
  };
}

const READ_ONLY = ["Read", "Glob", "Grep", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)"];
const WRITING = ["Read", "Glob", "Grep", "Edit", "Write", "Bash(git *)"];
/**
 * The triage searches and reads the other Items with the item commands. `{{scopesoup}}` is the folder Scope Soup is installed
 * in, filled in when the configuration is read (`expandScopesoup`); a role's own list in the file may use it too.
 */
export const ITEM_READING = ["Bash(pnpm --dir {{scopesoup}} item list*)", "Bash(pnpm --dir {{scopesoup}} item show*)"];

/** The model a Copilot role runs on when the file names none: Copilot Fusion, which picks among the models the plan has. */
export const COPILOT_DEFAULT_MODEL = "fusion";
/** The Auto routing profile a Copilot role on Fusion uses when the file names none. */
export const COPILOT_DEFAULT_AUTO_TIER = "balance";

/** The model of each role when the file names none: a strong triage and review. */
export const DEFAULT_MODELS: Readonly<Record<SessionRole, string>> = { triage: "opus", implement: "sonnet", review: "opus" };

export function defaultRoles(): Record<SessionRole, RoleConfig> {
  return {
    triage: { model: DEFAULT_MODELS.triage, maxTurns: 15, allowedTools: [...READ_ONLY, ...ITEM_READING], permissionMode: "dontAsk" },
    implement: { model: DEFAULT_MODELS.implement, maxTurns: 80, allowedTools: [...WRITING], permissionMode: "dontAsk" },
    review: { model: DEFAULT_MODELS.review, maxTurns: 30, allowedTools: [...READ_ONLY], permissionMode: "dontAsk" },
  };
}

/** The folder Scope Soup is installed in, as a session types it in a command: forward slashes, in quotes when it has a space. */
export function scopesoupFolder(folder: string): string {
  const plain = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  return /\s/.test(plain) ? `"${plain}"` : plain;
}

/** A role's allowed tools with `{{scopesoup}}` filled in. */
export function expandScopesoup(tools: readonly string[], folder: string): string[] {
  return tools.map((tool) => tool.split("{{scopesoup}}").join(scopesoupFolder(folder)));
}

/**
 * What the setup watches when the file names no `setupWatch`: the common lockfiles and dependency lists, each only when it is
 * there. A project with other inputs (what its code generation reads) lists them in `setupWatch`.
 */
export const DEFAULT_SETUP_WATCH: readonly string[] = [
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "requirements*.txt", "poetry.lock", "uv.lock",
  "Pipfile.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock", ".gitmodules",
];

export function defaultClaude(): ClaudeConfig {
  return { path: "claude", prefixArgs: [], extraArgs: [], promptVia: "stdin", dropApiKeyEnv: true };
}

export function defaultCopilot(): CopilotConfig {
  return { path: "copilot", prefixArgs: [], extraArgs: [] };
}

/** The provider a role runs on: the one it names, else Claude. */
export function roleProvider(role: Pick<RoleConfig, "provider">): ProviderName {
  return role.provider ?? "claude";
}
