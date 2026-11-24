// Scope Soup's home on a machine: a folder that holds a folder per release, a pointer to the current one and the
// launcher, so a new version never overwrites the running one and going back is switching the pointer.
//
//   <home>/
//     bin/scopesoup.cmd, bin/scopesoup   the launcher: runs the version `current` names. The person adds bin/ to their PATH.
//     node/node.exe                the Node the Windows .exe brought (src/exe/setup.ts), used when the PATH has no Node 22.18+
//     current                      one line: the folder of the version that runs (`scopesoup-0.5.0`)
//     upgrade.json                 the last switch: from, to, when, whether the new version started, the backup
//     scopesoup-0.5.0/                a release, unpacked as it came
//     scopesoup-0.4.2/                the version before it (kept for "Go back", at most one)
//     backups/                     the database and config copies made before a switch
//
// The launcher owns the restart: Scope Soup exits with RESTART_EXIT_CODE and the launcher starts the pointer's version.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { RESTART_EXIT_CODE, compareVersions, folderOf, versionOf, versionOfFolder } from "./version.ts";

const NODE_FLAGS = "--disable-warning=ExperimentalWarning";
export const POINTER = "current";
export const STATE = "upgrade.json";
/** The folder of the bundled Node in the home, as src/exe/setup.ts writes it (`NODE_DIR`). */
export const BUNDLED_NODE = "node";
/** Exits 0 when the Node that runs it can run Scope Soup (22.18 or newer); the launchers ask the `node` on the PATH. No quotes inside. */
export const NODE_CHECK = "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)";
/** How long a new version must have run before the folder of the one before it is deleted (the upgrade policy). */
export const CLEAN_DAY_MS = 24 * 60 * 60 * 1000;

/** The last switch of the pointer. */
export interface SwitchState {
  /** The folder switched away from: the one "Go back" returns to, until it is deleted. */
  from: string;
  /** The folder switched to. */
  to: string;
  at: string;
  /** Set when `to` started and its board listened. */
  startedAt?: string;
  /** Set when `to` could not start and the pointer went back to `from` on its own. */
  failedStart?: string;
  /** The copies of the database and the config made before the switch. */
  backup?: string;
  /** Set when the folder `from` was deleted (after a clean day, or at the next upgrade). */
  removedFrom?: string;
}

/** The home this release folder sits in: its parent, when the folder is named after its version and the parent has a pointer. */
export function homeOf(root: string): string | null {
  const name = basename(resolve(root));
  const version = versionOfFolder(name);
  if (!version) return null;
  try {
    if (versionOf(root) !== version) return null;
  } catch {
    return null;
  }
  const home = dirname(resolve(root));
  return existsSync(join(home, POINTER)) ? home : null;
}

export function readPointer(home: string): string | null {
  try {
    const line = readFileSync(join(home, POINTER), "utf8").split(/\r?\n/)[0]?.trim() ?? "";
    return versionOfFolder(line) ? line : null;
  } catch {
    return null;
  }
}

/** Writes a file whole: a temporary file beside it, then a rename, so a reader (the launcher) sees the old or the new. */
function writeWhole(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/** Points the launcher at `folder`, which must be a release folder in the home. */
export function writePointer(home: string, folder: string): void {
  if (!versionOfFolder(folder) || !existsSync(join(home, folder, "package.json"))) throw new Error(`${join(home, folder)} is not a Scope Soup release folder.`);
  // No line end: the Windows launcher reads it with `set /p`, the sh one with `head -n 1`.
  writeWhole(join(home, POINTER), folder);
}

export function readState(home: string): SwitchState | null {
  try {
    const raw = JSON.parse(readFileSync(join(home, STATE), "utf8")) as Partial<SwitchState>;
    return typeof raw.from === "string" && typeof raw.to === "string" && typeof raw.at === "string" ? (raw as SwitchState) : null;
  } catch {
    return null;
  }
}

export function writeState(home: string, state: SwitchState): void {
  writeWhole(join(home, STATE), JSON.stringify(state, null, 2) + "\n");
}

/** The release folders in the home, newest version first. */
export function versionFolders(home: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(home, { withFileTypes: true }).filter((entry) => entry.isDirectory() && versionOfFolder(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
  return names.sort((a, b) => compareVersions(versionOfFolder(b)!, versionOfFolder(a)!));
}

/** The folder "Go back" returns to: the one the last switch left, while it is still on disk. */
export function previousFolder(home: string): string | null {
  const state = readState(home);
  const current = readPointer(home);
  if (!state || !current || state.to !== current || state.from === current || state.removedFrom) return null;
  return existsSync(join(home, state.from, "package.json")) ? state.from : null;
}

/** Switches the pointer to `to` and records the switch. The caller has waited for idle and made the backup. */
export function switchPointer(home: string, to: string, at: string, backup?: string): SwitchState {
  const from = readPointer(home);
  if (!from) throw new Error(`${join(home, POINTER)} names no Scope Soup version.`);
  writePointer(home, to);
  const state: SwitchState = { from, to, at, ...(backup ? { backup } : {}) };
  writeState(home, state);
  return state;
}

/** The new version's board listened: the switch held. */
export function markStarted(home: string, folder: string, at: string): void {
  const state = readState(home);
  if (!state || state.to !== folder || state.startedAt || state.failedStart) return;
  writeState(home, { ...state, startedAt: at });
}

/**
 * The version `folder` could not start (a version that cannot read the project's data refuses to start, and the old
 * one is used again). When it is the one the last switch went to and it never started, the pointer goes back to the one
 * before; returns that folder. A version the pointer went back to is not switched again, so this cannot go round.
 */
export function revertFailedStart(home: string, folder: string, at: string): string | null {
  const state = readState(home);
  if (!state || state.to !== folder || state.startedAt || state.failedStart || state.removedFrom) return null;
  if (readPointer(home) !== folder || !existsSync(join(home, state.from, "package.json"))) return null;
  writePointer(home, state.from);
  writeState(home, { from: folder, to: state.from, at, failedStart: at, ...(state.backup ? { backup: state.backup } : {}), startedAt: at });
  return state.from;
}

/**
 * The upgrade policy: at most two versions on disk. Every release folder but the current one and the one "Go back"
 * returns to is deleted; that one too after the current one has run cleanly for a day (`now`), or when `beforeUpgrade`.
 * Returns the folders deleted.
 */
export function cleanUp(home: string, now: Date, beforeUpgrade = false): string[] {
  const current = readPointer(home);
  if (!current) return [];
  const state = readState(home);
  const previous = previousFolder(home);
  const cleanDay = state?.startedAt !== undefined && !state.failedStart && now.getTime() - Date.parse(state.startedAt) >= CLEAN_DAY_MS;
  const keep = new Set([current, ...(previous && !beforeUpgrade && !cleanDay ? [previous] : [])]);
  const removed: string[] = [];
  for (const folder of versionFolders(home)) {
    if (keep.has(folder)) continue;
    rmSync(join(home, folder), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    removed.push(folder);
  }
  if (state && previous && removed.includes(previous)) writeState(home, { ...state, removedFrom: now.toISOString() });
  return removed;
}

/** The Windows launcher: runs the version `current` names, and starts it again when it exits asking for a restart. */
export function launcherCmd(): string {
  return [
    "@echo off",
    "rem Scope Soup's launcher (docs/RUNNING.md, \"Installing and upgrading\"): runs the version the file \"current\" in the",
    "rem folder above this one names. After an upgrade or a going back, Scope Soup exits with code 75 and is started again here.",
    "setlocal",
    "set \"SCOPESOUP_HOME=%~dp0..\"",
    "set \"SCOPESOUP_LAUNCHER=1\"",
    "rem With no Node 22.18 or newer on the PATH, the Node the .exe put in the home is used (only in this window).",
    `if not exist "%SCOPESOUP_HOME%\\${BUNDLED_NODE}\\node.exe" goto run`,
    `node -e "${NODE_CHECK}" >nul 2>nul && goto run`,
    `set "PATH=%SCOPESOUP_HOME%\\${BUNDLED_NODE};%PATH%"`,
    ":run",
    "set \"SCOPESOUP_CURRENT=\"",
    "set /p SCOPESOUP_CURRENT=<\"%SCOPESOUP_HOME%\\current\"",
    "if \"%SCOPESOUP_CURRENT%\"==\"\" (",
    "  echo No Scope Soup version is named in \"%SCOPESOUP_HOME%\\current\". 1>&2",
    "  exit /b 1",
    ")",
    `node ${NODE_FLAGS} "%SCOPESOUP_HOME%\\%SCOPESOUP_CURRENT%\\src\\scopesoup.ts" %*`,
    "set \"SCOPESOUP_CODE=%errorlevel%\"",
    `if "%SCOPESOUP_CODE%"=="${RESTART_EXIT_CODE}" if /i "%~1"=="start" goto run`,
    "exit /b %SCOPESOUP_CODE%",
    "",
  ].join("\r\n");
}

/** The launcher for sh (Git Bash, macOS, Linux). */
export function launcherSh(): string {
  return [
    "#!/bin/sh",
    "# Scope Soup's launcher (docs/RUNNING.md, \"Installing and upgrading\"): runs the version the file \"current\" in the",
    "# folder above this one names. After an upgrade or a going back, Scope Soup exits with code 75 and is started again here.",
    "SCOPESOUP_HOME=\"$(cd \"$(dirname \"$0\")/..\" && pwd)\"",
    "SCOPESOUP_LAUNCHER=1",
    "export SCOPESOUP_HOME SCOPESOUP_LAUNCHER",
    "# With no Node 22.18 or newer on the PATH, the Node the .exe put in the home is used (only for this process).",
    `if [ -f "$SCOPESOUP_HOME/${BUNDLED_NODE}/node.exe" ] && ! node -e "${NODE_CHECK}" >/dev/null 2>&1; then PATH="$SCOPESOUP_HOME/${BUNDLED_NODE}:$PATH"; export PATH; fi`,
    "while :; do",
    "  current=\"$(head -n 1 \"$SCOPESOUP_HOME/current\" 2>/dev/null | tr -d '\\r')\"",
    "  if [ -z \"$current\" ]; then echo \"No Scope Soup version is named in $SCOPESOUP_HOME/current.\" >&2; exit 1; fi",
    `  node ${NODE_FLAGS} "$SCOPESOUP_HOME/$current/src/scopesoup.ts" "$@"`,
    "  code=$?",
    `  if [ "$code" = ${RESTART_EXIT_CODE} ] && [ "$1" = start ]; then continue; fi`,
    "  exit $code",
    "done",
    "",
  ].join("\n");
}

export interface HomeSetup {
  home: string;
  bin: string;
  current: string;
  /** What the person does themselves: add `bin` to their PATH. Scope Soup never changes it. */
  pathAdvice: string[];
}

/**
 * Makes `root` (a release folder named after its version) the current version of the home it sits in, and writes the
 * launcher into `<home>/bin`. The pointer is written only when there is none, or it names a folder that is not there.
 * Never touches the PATH or any other setting of the machine: it says how the person adds the folder themselves.
 */
export function setupHome(root: string, platform: NodeJS.Platform = process.platform): HomeSetup {
  const folder = basename(resolve(root));
  const version = versionOf(root);
  if (folder !== folderOf(version)) throw new Error(`The release folder must be named ${folderOf(version)} (it is ${folder}): unpack the release zip as it is, into the folder that is to be Scope Soup's home.`);
  if (existsSync(join(root, ".git"))) throw new Error(`${root} is a development checkout, not a release: unpack a release zip into Scope Soup's home folder.`);
  const home = dirname(resolve(root));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "scopesoup.cmd"), launcherCmd());
  writeFileSync(join(bin, "scopesoup"), launcherSh(), { mode: 0o755 });
  const pointed = readPointer(home);
  if (!pointed || !existsSync(join(home, pointed, "package.json"))) writePointer(home, folder);
  const current = readPointer(home) ?? folder;
  const pathAdvice = platform === "win32"
    ? [
        `Add ${bin} to your PATH yourself; Scope Soup does not change it. In Windows: Settings, search "environment variables",`,
        `"Edit environment variables for your account", Path, New, ${bin}. Or in PowerShell, for your account only:`,
        `  [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";${bin}", "User")`,
        "Then open a new terminal and run: scopesoup version",
      ]
    : [`Add ${bin} to your PATH yourself; Scope Soup does not change it. For example, in ~/.profile:`, `  export PATH="${bin}:$PATH"`, "Then open a new terminal and run: scopesoup version"];
  return { home, bin, current, pathAdvice };
}
