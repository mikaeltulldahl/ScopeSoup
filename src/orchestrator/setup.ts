// The project's setup in a fresh clone. `setupCommand` (usually a script the onboarding skill wrote) runs without a shell in
// the folder a session or the check works in: once per folder, and again when the content of a watched file changes (`setupWatch`,
// or the lockfiles of DEFAULT_SETUP_WATCH), or the command, or a script it names. There is no file watching: before each implement
// or review session and before each check, the watched files are hashed and compared with what the last successful setup in that
// folder saw. The record is a small file in the folder's own git directory (`git rev-parse --git-path`), so each worktree and each
// clone has its own, and a folder made again starts without one. Every folder builds its own output; nothing is shared.
//
// A setup that fails, or leaves files git does not ignore, is reported as the setup's failure: never as a red check, and never as
// the agent's. Its environment has no Scope Soup token and no agent provider's API key.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { commandText } from "../config/commandLine.ts";
import { DEFAULT_SETUP_WATCH } from "../config/defaults.ts";
import { defaultProvider, providerFor } from "./providers/index.ts";
import type { ProjectConfig } from "../config/types.ts";
import { ROLES } from "../config/types.ts";
import { createCheckRunner } from "./checkRunner.ts";
import type { RunCheck } from "./checkRunner.ts";
import type { Git, ProcessControl } from "./process.ts";

/** The record's name in the folder's git directory. */
export const STAMP_FILE = "scopesoup-setup.json";
/** How much of a failed setup's output is kept for the reason: its end. */
const TAIL_CHARS = 1500;

export const SETUP_ADVICE = {
  shim: 'setupCommand is run without a shell. Name the program behind the shim (node.exe and a script, as the onboarding skill writes it), or start a script of the project\'s own with ["cmd.exe", "/d", "/c", "<script>.cmd"].',
  missing: "Install it, or give setupCommand the full path of the program.",
};

/** What the last successful setup in a folder saw. */
export interface SetupStamp {
  v: 1;
  /** The hash of the command and of every file it names (the setup script). */
  command: string;
  /** Each watched file there was, by its path relative to the repository, with the hash of its content. */
  files: Record<string, string>;
  /** ISO 8601, UTC. */
  at: string;
}

export type SetupResult =
  | { kind: "none" }
  | { kind: "current" }
  | { kind: "ran"; why: string; ms: number }
  /**
   * `reason` holds the end of the setup's output: it stays on this machine (the local event, the session on the board). `outcome`
   * says what happened in a few words and holds no output, for whatever leaves the machine (a comment, a log line on the meta branch).
   */
  | { kind: "failed"; why: string; reason: string; outcome: string }
  | { kind: "stopped" };

/** The patterns watched: the file's own list, or the default lockfiles. */
export function setupWatchOf(config: Pick<ProjectConfig, "setupWatch">): readonly string[] {
  return config.setupWatch ?? DEFAULT_SETUP_WATCH;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isInside(repo: string, path: string): boolean {
  const rel = relative(resolve(repo), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function segmentMatch(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return process.platform === "win32" ? pattern.toLowerCase() === name.toLowerCase() : pattern === name;
  const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`, process.platform === "win32" ? "i" : "");
  return regex.test(name);
}

/** The files that match the patterns, relative to `repo` with "/" between folders, sorted. Folders named `.git` are never entered. */
export function watchedFiles(repo: string, patterns: readonly string[]): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    let paths = [""];
    const parts = pattern.split("/").filter((part) => part !== "" && part !== ".");
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      const next: string[] = [];
      for (const base of paths) {
        const dir = join(repo, base);
        let names: string[];
        if (part.includes("*")) {
          try {
            names = readdirSync(dir).filter((name) => name !== ".git" && segmentMatch(part, name));
          } catch {
            names = [];
          }
        } else names = part === ".git" ? [] : [part];
        for (const name of names) {
          const rel = base === "" ? name : `${base}/${name}`;
          const full = join(repo, rel);
          if (last ? isFile(full) : existsSync(full) && statSync(full).isDirectory()) next.push(rel);
        }
      }
      paths = next;
    });
    for (const path of paths) if (path !== "") found.add(path);
  }
  return [...found].sort();
}

function hashOf(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The command's words and the content of every word that names a file inside the repository (a path with a folder in it, or an absolute one
 * under it). A file outside the repository is not hashed: it is a log or another output the setup writes, which would change at every run.
 */
function commandHash(repo: string, command: readonly string[]): string {
  const hash = createHash("sha256").update(JSON.stringify(command));
  for (const word of command) {
    const path = isAbsolute(word) ? word : /[\\/]/.test(word) ? resolve(repo, word) : null;
    if (path && isInside(repo, path) && isFile(path)) hash.update(`\0${word}\0`).update(readFileSync(path));
  }
  return hash.digest("hex");
}

/** What the setup depends on in `repo` now. */
export function setupFingerprint(repo: string, config: Pick<ProjectConfig, "setupCommand" | "setupWatch">): Omit<SetupStamp, "v" | "at"> {
  const files: Record<string, string> = {};
  for (const path of watchedFiles(repo, setupWatchOf(config))) files[path] = hashOf(readFileSync(join(repo, path)));
  return { command: commandHash(repo, config.setupCommand ?? []), files };
}

/** Why the setup must run, in words, or null when the record matches what is there now. */
export function setupReason(stamp: SetupStamp | null, now: Omit<SetupStamp, "v" | "at">): string | null {
  if (!stamp) return "it has not run in this folder yet";
  if (stamp.command !== now.command) return "setupCommand, or the script it names, changed";
  const changed: string[] = [];
  for (const [path, hash] of Object.entries(now.files)) {
    if (stamp.files[path] === undefined) changed.push(`${path} (new)`);
    else if (stamp.files[path] !== hash) changed.push(path);
  }
  for (const path of Object.keys(stamp.files)) if (now.files[path] === undefined) changed.push(`${path} (gone)`);
  if (changed.length === 0) return null;
  return `watched files changed: ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? `, and ${changed.length - 5} more` : ""}`;
}

/** Where the record of `repo` is kept: in its own git directory (a worktree's own, not the shared one). */
export async function stampPath(git: Git, repo: string): Promise<string> {
  const found = await git(["rev-parse", "--git-path", STAMP_FILE], repo);
  if (found.code !== 0) throw new Error(`git rev-parse --git-path failed in ${repo}: ${found.stderr.trim()}`);
  return resolve(repo, found.stdout.trim());
}

export function readStamp(path: string): SetupStamp | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as SetupStamp;
    return value && value.v === 1 && typeof value.command === "string" && typeof value.files === "object" && value.files !== null ? value : null;
  } catch {
    return null;
  }
}

function writeStamp(path: string, stamp: SetupStamp): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(stamp) + "\n");
  renameSync(temp, path);
}

/** `git status --porcelain` lines: changed tracked files and untracked files git does not ignore. */
async function statusLines(git: Git, repo: string): Promise<string[]> {
  const status = await git(["status", "--porcelain", "--untracked-files=all"], repo);
  if (status.code !== 0) throw new Error(`git status failed in ${repo}: ${status.stderr.trim()}`);
  return status.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "");
}

/**
 * The environment the setup runs with: without Scope Soup's tokens and settings (SCOPESOUP_*) and without the API key of the
 * default provider and of each provider a role of `config` runs on (`keyEnv`). A provider's keys may be general ones
 * (`GH_TOKEN`) that a project's setup needs, so they are taken out only while a role runs on that provider.
 */
export function setupEnv(env: NodeJS.ProcessEnv, config?: Pick<ProjectConfig, "roles">): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const providers = new Set([defaultProvider, ...(config ? ROLES.map((role) => providerFor(config as ProjectConfig, role)) : [])]);
  const keys = new Set([...providers].flatMap((provider) => provider.keyEnv.map((key) => key.toUpperCase())));
  for (const [name, value] of Object.entries(env)) {
    if (/^SCOPESOUP_/i.test(name) || keys.has(name.toUpperCase())) continue;
    out[name] = value;
  }
  return out;
}

/** Runs `setupCommand` with `setupEnv` of the configuration in use at each run (a role may move to another provider meanwhile). */
export function createSetupRunner(processes: ProcessControl, env: NodeJS.ProcessEnv, config: () => Pick<ProjectConfig, "roles"> | undefined, now: () => number = Date.now): RunCheck {
  return (...args) => createCheckRunner(processes, setupEnv(env, config()), now, SETUP_ADVICE)(...args);
}

export interface SetupDeps {
  git: Git;
  /** Runs the command (a check runner made with `setupEnv` and SETUP_ADVICE). */
  run: RunCheck;
  timeoutMs: number;
  /** True ends a running setup (Stop). */
  stop: () => boolean;
  /** ISO 8601, UTC. */
  now: () => string;
}

/** The setup's words for a reason or an event: the command as one line. */
export function setupCommandText(config: Pick<ProjectConfig, "setupCommand">): string {
  return config.setupCommand ? commandText(config.setupCommand) : "";
}

/**
 * What may leave this machine about a failed setup (a comment on the host, a line in the item's log on the meta branch, which other
 * machines and people read): where and how it failed, never its output, which may hold a secret the script printed. The output stays
 * in the local event and on the board's Item page.
 */
export function setupFailedText(folder: string, outcome: string, machineName: string): string {
  return `Setup failed in ${folder} (${outcome}); the output is on Scope Soup's board on ${machineName}.`;
}

/** The prompts' line about the setup (`{{setup}}`): it has run, so the agent does not install again. Empty without a setup. */
export function setupPromptLine(config: Pick<ProjectConfig, "setupCommand" | "setupWatch">): string {
  if (!config.setupCommand) return "";
  const watched = config.setupWatch ? (config.setupWatch.length > 0 ? config.setupWatch.join(", ") : null) : "a lockfile";
  return `Scope Soup ran the project's setup in this clone before your session (\`${setupCommandText(config)}\`)${watched ? `, and runs it again when ${watched} changes` : ""}: dependencies are installed and generated files are there. Do not install them or run the setup again yourself.`;
}

/**
 * Runs the setup in `repo` when it must (see the top of the file). Only a setup that passed, and left no file git does not ignore,
 * is recorded; a failed one runs again next time.
 */
export async function ensureSetup(deps: SetupDeps, config: Pick<ProjectConfig, "setupCommand" | "setupWatch">, repo: string): Promise<SetupResult> {
  const command = config.setupCommand;
  if (!command) return { kind: "none" };
  const path = await stampPath(deps.git, repo);
  const why = setupReason(readStamp(path), setupFingerprint(repo, config));
  if (why === null) return { kind: "current" };
  const before = new Set(await statusLines(deps.git, repo));
  const run = await deps.run(command, repo, deps.timeoutMs, deps.stop);
  const tail = run.tail.trim().slice(-TAIL_CHARS);
  const output = tail ? ` The end of its output:\n${tail}` : "";
  switch (run.outcome) {
    case "stopped":
      return { kind: "stopped" };
    case "not-started":
      return { kind: "failed", why, outcome: "it could not be started", reason: `The setup could not be started: ${run.tail}` };
    case "timed-out":
      return { kind: "failed", why, outcome: `timed out after ${Math.round(deps.timeoutMs / 60_000)} minutes`, reason: `The setup did not finish within ${Math.round(deps.timeoutMs / 60_000)} minutes (settings.checkTimeoutMinutes) and was stopped.${output}` };
    case "failed":
      return { kind: "failed", why, outcome: `exit ${run.code ?? "unknown"}`, reason: `The setup exited with code ${run.code ?? "unknown"}.${output}` };
    case "passed":
      break;
  }
  const left = (await statusLines(deps.git, repo)).filter((line) => !before.has(line));
  if (left.length > 0) {
    return {
      kind: "failed", why, outcome: "it left files git does not ignore",
      reason: `The setup passed but changed or added files that git does not ignore (${left.slice(0, 5).join("; ")}${left.length > 5 ? `; and ${left.length - 5} more` : ""}). What it makes must be ignored by git (.gitignore), and tracked files must stay as they are, so that it never ends up in a commit.`,
    };
  }
  writeStamp(path, { v: 1, ...setupFingerprint(repo, config), at: deps.now() });
  return { kind: "ran", why, ms: run.ms };
}
