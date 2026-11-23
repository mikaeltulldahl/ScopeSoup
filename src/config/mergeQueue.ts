// What level 4 (Autopilot) asks for on the Settings page when the file lacks it: a check command proposed from the
// project's package.json (and, the candidates found in its package.json scripts, CI workflow files and Makefile), the remote's URL read from git, and a cheap test that a check command can be started at all.
// Nothing here runs the check. With `mergeQueue.ci: "github"` the project's own CI checks each batch and no check command is
// asked for; that choice is file-only.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { CHECK_ADVICE } from "../orchestrator/checkRunner.ts";
import { resolveExecutable } from "../orchestrator/executable.ts";
import { programFound } from "./program.ts";
import type { CheckCandidate, MergeQueueSetup } from "./levels.ts";
import { commandWords } from "./commandLine.ts";
import type { ProjectConfig } from "./types.ts";

export type { MergeQueueSetup };

export interface MergeQueueOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** `git remote get-url <remote>` in the clone; replaceable in tests. */
  remoteUrlOf?: (repoPath: string, remote: string) => string;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The package manager the project uses: package.json's `packageManager`, else its lock file, else npm. */
function packageManager(repoPath: string, manifest: Record<string, unknown>): string {
  const named = typeof manifest.packageManager === "string" ? /^(npm|pnpm|yarn|bun)@/.exec(manifest.packageManager)?.[1] : undefined;
  if (named) return named;
  if (isFile(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (isFile(join(repoPath, "yarn.lock"))) return "yarn";
  if (isFile(join(repoPath, "bun.lock")) || isFile(join(repoPath, "bun.lockb"))) return "bun";
  return "npm";
}

/**
 * The check command proposed from the project: its package.json `check` script, else its `test` script, run with its
 * package manager. On Windows a package manager that is only a .cmd shim (as npm installs them) cannot be started without a
 * shell, so the proposal goes through `cmd.exe /d /c`, the form checkCommand's own advice names.
 */
export function proposeCheckCommand(repoPath: string, options: MergeQueueOptions = {}): { command: string[] | null; from: string } {
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { command: null, from: "package.json is not a JSON object" };
    manifest = parsed as Record<string, unknown>;
  } catch {
    return { command: null, from: "the project has no package.json to propose one from" };
  }
  const scripts = typeof manifest.scripts === "object" && manifest.scripts !== null ? (manifest.scripts as Record<string, unknown>) : {};
  const script = ["check", "test"].find((name) => typeof scripts[name] === "string" && (scripts[name] as string).trim() !== "");
  if (script === undefined) return { command: null, from: "package.json has no check or test script" };
  const manager = packageManager(repoPath, manifest);
  const words = [manager, "run", script];
  const from = `the ${script} script in package.json, run with ${manager}`;
  if ((options.platform ?? process.platform) !== "win32") return { command: words, from };
  try {
    resolveExecutable(manager, { env: options.env, platform: "win32" });
    return { command: words, from };
  } catch {
    return { command: ["cmd.exe", "/d", "/c", ...words], from: `${from} (through cmd.exe, since ${manager} is a shell shim here)` };
  }
}

/** How many candidates of each kind are offered. */
const MAX_PER_KIND = 6;
/** Script and target names that usually decide whether a change is OK, offered first. */
const LIKELY = ["check", "ci", "test", "verify", "validate", "lint", "typecheck", "build", "all"];
const likelyFirst = (names: string[]): string[] => [...names].sort((a, b) => rank(a) - rank(b));
function rank(name: string): number {
  const at = LIKELY.indexOf(name.split(":")[0] ?? name);
  return at < 0 ? LIKELY.length : at;
}

/** `run:` steps of a GitHub Actions workflow, one command each: a single line, or each line of a block. Read as text, not run. */
export function workflowRuns(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const runs: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[index] ?? "");
    if (!match) continue;
    const value = (match[2] ?? "").trim();
    if (value !== "" && !/^[|>][-+]?$/.test(value)) {
      runs.push(value.replace(/^(["'])(.*)\1$/, "$2"));
      continue;
    }
    const indent = (match[1] ?? "").length;
    for (index++; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (line.trim() === "") continue;
      if (line.length - line.trimStart().length <= indent) {
        index--;
        break;
      }
      runs.push(line.trim());
    }
  }
  return runs;
}

/** A step a check command can be made of: one plain command, no shell (no `&&`, pipes, variables, redirects), no install or checkout. */
function plainCommand(line: string): boolean {
  if (line === "" || line.startsWith("#") || /[&|;<>$`(){}]/.test(line)) return false;
  return !/\b(install|ci --|checkout|setup|cache|upload|download|echo|cd)\b/.test(line) && !/^(npm|yarn|bun) ci\b/.test(line);
}

/**
 * Commands in the repository that could be the check, for the Settings page to offer: the package.json scripts (run with the
 * project's package manager, through cmd.exe on Windows when it is a shell shim), the plain `run:` steps of the GitHub Actions
 * workflows, and the Makefile's targets. Likely names (check, test, ci, ...) come first. Only read; nothing runs.
 */
export function checkCandidates(repoPath: string, options: MergeQueueOptions = {}): CheckCandidate[] {
  const found: CheckCandidate[] = [];
  const seen = new Set<string>();
  const add = (command: string[], from: string): void => {
    const key = JSON.stringify(command);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ command, from });
  };
  // package.json scripts.
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const manifest = parsed as Record<string, unknown>;
      const scripts = typeof manifest.scripts === "object" && manifest.scripts !== null ? (manifest.scripts as Record<string, unknown>) : {};
      const names = likelyFirst(Object.keys(scripts).filter((name) => typeof scripts[name] === "string" && !/^(pre|post)/.test(name) && !/^(start|dev|serve|watch|prepare)$/.test(name)));
      const manager = packageManager(repoPath, manifest);
      let shim = false;
      if ((options.platform ?? process.platform) === "win32") {
        try {
          resolveExecutable(manager, { env: options.env, platform: "win32" });
        } catch {
          shim = true;
        }
      }
      for (const name of names.slice(0, MAX_PER_KIND)) add([...(shim ? ["cmd.exe", "/d", "/c"] : []), manager, "run", name], `the ${name} script in package.json`);
    }
  } catch {
    // No package.json, or not JSON: nothing from it.
  }
  // GitHub Actions workflows.
  const workflows = join(repoPath, ".github", "workflows");
  let files: string[] = [];
  try {
    files = readdirSync(workflows).filter((name) => /\.ya?ml$/i.test(name)).sort();
  } catch {
    files = [];
  }
  let fromWorkflows = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(workflows, file), "utf8");
    } catch {
      continue;
    }
    for (const run of workflowRuns(text)) {
      if (fromWorkflows >= MAX_PER_KIND || !plainCommand(run)) continue;
      const words = commandWords(run);
      if (words.length === 0) continue;
      add(words, `the workflow .github/workflows/${file}`);
      fromWorkflows++;
    }
  }
  // Makefile targets.
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    let text: string;
    try {
      text = readFileSync(join(repoPath, name), "utf8");
    } catch {
      continue;
    }
    const targets = [...text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/gm)].map((match) => match[1]!).filter((target, index, all) => all.indexOf(target) === index);
    for (const target of likelyFirst(targets).slice(0, MAX_PER_KIND)) add(["make", target], `the ${name}`);
    break;
  }
  return found;
}

/** The program cmd.exe is told to run: the word after /c (or /k), its first word if it was given as one quoted line. */
function cmdInner(args: readonly string[]): string | undefined {
  const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
  const next = at < 0 ? undefined : args[at + 1];
  return next?.trim().split(/\s+/)[0];
}

/**
 * Why a check command cannot be started, or null when it can: its program must resolve the way the merge queue starts it
 * (without a shell; on Windows an .exe, not a .cmd shim), and for `cmd.exe /c <program> ...` the program after /c must be
 * found too. A program named with a folder is the project's own, relative to its repository. The check itself is not run.
 */
export function checkCommandProblem(command: readonly string[], repoPath: string, options: MergeQueueOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const [program = "", ...args] = command;
  const own = (name: string): string => (/[\\/]/.test(name) && !isAbsolute(name) ? resolve(repoPath, name) : name);
  const path = own(program);
  if (platform === "win32") {
    try {
      resolveExecutable(path, { env, platform, advice: CHECK_ADVICE });
    } catch (error) {
      return errorText(error);
    }
    if (/^cmd(\.exe)?$/i.test(basename(path))) {
      const inner = cmdInner(args);
      if (inner === undefined || inner === "") return 'cmd.exe needs /c and then the command to run, for example ["cmd.exe", "/d", "/c", "npm", "test"].';
      const innerPath = own(inner);
      if (!programFound(innerPath, env, platform)) return `Could not find ${inner}${innerPath === inner && !isAbsolute(inner) ? " on PATH" : ""}, which cmd.exe is told to run. ${CHECK_ADVICE.missing}`;
    }
    return null;
  }
  return programFound(path, env, platform) ? null : `Could not find ${program}${path === program && !isAbsolute(program) ? " on PATH" : ""}. ${CHECK_ADVICE.missing}`;
}

/** `git remote get-url <remote>` in the project's clone. Local only: it reads the clone's configuration and contacts nothing. */
export function gitRemoteUrl(repoPath: string, remote: string): string {
  return execFileSync("git", ["-C", repoPath, "remote", "get-url", remote], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

/** What the page asks for at level 4: the file's own values where it has them, proposals for the rest. */
export function mergeQueueSetup(config: ProjectConfig, options: MergeQueueOptions = {}): MergeQueueSetup {
  let checkCommand: string[] | null;
  let checkCommandFrom: string;
  if (config.checkCommand) {
    checkCommand = config.checkCommand;
    checkCommandFrom = "the configuration file";
  } else {
    const proposed = proposeCheckCommand(config.repoPath, options);
    checkCommand = proposed.command;
    checkCommandFrom = proposed.from;
  }
  let remoteUrl: string | null = config.remoteUrl ?? null;
  let remoteUrlProblem: string | null = null;
  if (remoteUrl === null) {
    try {
      remoteUrl = (options.remoteUrlOf ?? gitRemoteUrl)(config.repoPath, config.remote) || null;
      if (remoteUrl === null) remoteUrlProblem = `git shows no URL for the remote "${config.remote}".`;
    } catch (error) {
      remoteUrlProblem = `Could not read the URL of the remote "${config.remote}" in ${config.repoPath}: ${errorText(error).split(/\r?\n/)[0]}`;
    }
  }
  return {
    checkCommand,
    checkCommandFrom,
    checkCommandProblem: checkCommand ? checkCommandProblem(checkCommand, config.repoPath, options) : null,
    checkCandidates: checkCandidates(config.repoPath, options),
    remote: config.remote,
    remoteUrl,
    remoteUrlProblem,
  };
}
