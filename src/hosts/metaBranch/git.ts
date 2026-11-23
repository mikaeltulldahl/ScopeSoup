// Reads the meta ref straight from the repository's object store: no checkout, no working
// directory, no network. Every argument handed to git is either a constant or checked first.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { MetaFormat } from "./format.ts";
import { FORMAT_FILE, readFormat } from "./format.ts";
import { isItemId, isMetaRef, isSha } from "./ids.ts";
import { MAX_FILE_BYTES } from "./limits.ts";
import { endWindowsTree } from "../processTree.ts";
import type { CreationWindow, ProcessEntry } from "../processTree.ts";
import { gitCommand as commandOf, retryGitOnce } from "../gitRetry.ts";
import { isSpawnRefused, retrySpawn } from "../spawnRetry.ts";
import type { ItemFiles } from "./map.ts";

export interface GitOutput {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Runs git in the repository with these arguments, feeding `input` on stdin. Never through a shell.
 * `env` adds variables (a commit's identity); the repository variables are still taken out.
 */
export type RunGit = (args: string[], input?: string | Buffer, env?: Record<string, string>) => Promise<GitOutput>;

/** Variables that would point git at some other repository than the directory it runs in. */
const REPOSITORY_VARIABLES = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"]);

/** Variables that would give a commit another identity or time than the one Scope Soup passes. */
const IDENTITY_VARIABLES = new Set(["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE"]);

/** How long one git process may run before it is ended. */
export const GIT_TIMEOUT_MS = 60_000;

/** The environment git is spawned with: ours, without the variables that name a repository. */
export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Upper-cased for the test: Windows environment names are not case-sensitive.
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (!REPOSITORY_VARIABLES.has(name) && !IDENTITY_VARIABLES.has(name)) env[key] = value;
  }
  // Reads take no locks, so they never get in the way of a writer.
  env.GIT_OPTIONAL_LOCKS = "0";
  // Nothing may wait for a person: no password prompt from git or the credential manager.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  // Objects are what they are: no `git replace` substitutes.
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return env;
}

export interface GitInOptions {
  executable?: string;
  timeoutMs?: number;
}

/** A RunGit that can be stopped: every git it is running is ended, and later calls fail. */
export interface StoppableGit extends RunGit {
  stop(): Promise<void>;
}

/** After git exits, how long its pipes may stay open (held by a hook's or ssh's leftover child) before they are closed. */
const PIPE_GRACE_MS = 2000;

/** Runs a helper program (not git) with a time limit; its stdout, or "" when it fails. A start Windows refuses is tried again. */
function helper(command: string, args: string[], timeoutMs: number): Promise<string> {
  return retrySpawn(command, () => helperOnce(command, args, timeoutMs)).catch(() => "");
}

/** One try of `helper`: rejects only when the start was refused, so that it can be tried again. */
function helperOnce(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((done, refused) => {
    const out: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false });
    } catch (error) {
      return isSpawnRefused(error) ? refused(error) : done("");
    }
    const timer = setTimeout(() => {
      child.kill();
      done("");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (child.pid === undefined && isSpawnRefused(error)) refused(error);
      else done("");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? Buffer.concat(out).toString("utf8") : "");
    });
  });
}

/**
 * How long Git for Windows' `git --exec-path` and `ps -l` may take. On a machine running two checks
 * they took over 5 s, and a listing that times out leaves the MSYS children of a hook out of the kill.
 */
const MSYS_HELPER_TIMEOUT_MS = 15_000;

/** Git for Windows' own `ps` (MSYS), which knows the processes a hook's shell started; null when it cannot be found. */
let msysPs: Promise<string | null> | null = null;
function findMsysPs(executable: string): Promise<string | null> {
  msysPs ??= helper(executable, ["--exec-path"], MSYS_HELPER_TIMEOUT_MS).then((path) => {
    // <Git>/mingw64/libexec/git-core -> <Git>/usr/bin/ps.exe
    const ps = path.trim() ? resolve(path.trim(), "..", "..", "..", "usr", "bin", "ps.exe") : "";
    // Not found (or git too slow to answer): asked again at the next kill, not given up on for good.
    if (!ps || !existsSync(ps)) msysPs = null;
    return ps && existsSync(ps) ? ps : null;
  });
  return msysPs;
}

/** An MSYS process from Git for Windows' `ps -l`: its MSYS pid and parent pid, and its Windows pid. */
interface MsysEntry {
  pid: number;
  parent: number;
  winpid: number;
}

/** Parses `ps -l` ("PID PPID PGID WINPID TTY UID STIME COMMAND"); lines that do not parse are left out. */
function parseMsysPs(table: string): MsysEntry[] {
  return table
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parent, , winpid]) => pid !== undefined && parent !== undefined && winpid !== undefined && !Number.isNaN(pid) && !Number.isNaN(parent) && !Number.isNaN(winpid))
    .map(([pid, parent, , winpid]) => ({ pid: pid as number, parent: parent as number, winpid: winpid as number }));
}

/**
 * The Windows processes the MSYS parent pids add to `tree`: every MSYS process started under an MSYS
 * process of the tree. Needed because a hook runs in MSYS `sh`, whose children are created through
 * processes that have already exited, so they hang off no living Windows parent. Each one is taken
 * from the Windows `table` and only when it was created no earlier than the tree's root (and its
 * MSYS parent), by the same rule as the Windows walk: an older process is not in the tree.
 * `ended` are the MSYS pids of processes of the tree ended in an earlier round (gone now): a child of
 * one of them is taken only when it was created before `cutoffMs`, when they were ended.
 */
export function msysAdditions(tree: readonly ProcessEntry[], table: readonly ProcessEntry[], msys: readonly MsysEntry[], ended: ReadonlySet<number> = new Set(), cutoffMs = Infinity): ProcessEntry[] {
  const root = tree[0];
  if (!root) return [];
  const byWinpid = new Map(table.map((entry) => [entry.pid, entry]));
  // Only processes of the tree that are listed now: the pid of one ended in an earlier round may be another's by now.
  const inWindowsTree = new Set(tree.filter((entry) => byWinpid.get(entry.pid)?.createdMs === entry.createdMs).map((entry) => entry.pid));
  const byMsysPid = new Map(msys.map((entry) => [entry.pid, entry]));
  const gone = (pid: number): boolean => ended.has(pid) && !byMsysPid.has(pid);
  const inTree = new Set(msys.filter((entry) => inWindowsTree.has(entry.winpid)).map((entry) => entry.pid));
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of msys) {
      if (inTree.has(entry.pid) || !(inTree.has(entry.parent) || gone(entry.parent))) continue;
      const own = byWinpid.get(entry.winpid);
      const parent = byWinpid.get(byMsysPid.get(entry.parent)?.winpid ?? -1);
      if (!own || own.createdMs < root.createdMs || (parent && own.createdMs < parent.createdMs)) continue;
      if (gone(entry.parent) && own.createdMs > cutoffMs) continue;
      inTree.add(entry.pid);
      grew = true;
    }
  }
  const added: ProcessEntry[] = [];
  for (const entry of msys) {
    const own = byWinpid.get(entry.winpid);
    if (inTree.has(entry.pid) && own && !inWindowsTree.has(own.pid) && !added.includes(own)) added.push(own);
  }
  return added;
}

/**
 * Ends a process and everything it started; true when that could be made sure of. Windows: the tree
 * from one process listing, walked by parent pid and creation time, plus its MSYS children, each
 * ended by its own pid (src/hosts/processTree.ts); nothing when the root is not the process started
 * in `window`. If no listing can be had, the root alone is ended through `child` (Node still holds its
 * handle, so its pid has not been reused). POSIX: the child leads its own process group, which is killed.
 */
async function killTree(child: ChildProcess, pid: number, window: CreationWindow, executable: string): Promise<boolean> {
  if (process.platform === "win32") {
    let msysListed = true;
    // The MSYS pids of the tree's processes so far: a later round finds the children they started before they were ended.
    const msysOfTree = new Set<number>();
    const listMsys = async (): Promise<string> => {
      const ps = await findMsysPs(executable);
      return ps ? await helper(ps, ["-l"], MSYS_HELPER_TIMEOUT_MS) : "";
    };
    // The first MSYS listing is taken while PowerShell starts and lists, not after it: on a busy machine each
    // takes seconds. A process it misses because it started in between is found by the next round.
    let first: Promise<string> | undefined = listMsys();
    const result = await endWindowsTree(pid, window, {
      extend: async (tree, table, cutoffMs) => {
        const listing = await (first ?? listMsys());
        first = undefined;
        msysListed &&= listing !== "";
        const msys = parseMsysPs(listing);
        const added = msysAdditions(tree, table, msys, msysOfTree, cutoffMs);
        // Only by a process listed now: a pid of one ended earlier may belong to another process by now.
        const chosen = new Set([...tree, ...added].map((entry) => `${entry.pid} ${entry.createdMs}`));
        const listed = new Map(table.map((entry) => [entry.pid, `${entry.pid} ${entry.createdMs}`]));
        for (const entry of msys) if (chosen.has(listed.get(entry.winpid) ?? "")) msysOfTree.add(entry.pid);
        return added;
      },
    });
    if (!result.listed) child.kill();
    return result.listed && msysListed;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return true;
}

/**
 * Runs git in `repoDir`. The time limit bounds the call itself: when it passes, git and everything
 * it started (a hook, ssh) are ended and the pipes closed, and the call fails. When git exits but
 * something it started still holds its output, the call settles shortly after anyway. `stop()`
 * ends every git still running (on shutdown: a push in flight must not outlive Scope Soup).
 */
export function gitIn(repoDir: string, options: GitInOptions = {}): StoppableGit {
  const executable = options.executable ?? "git";
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const running = new Set<(why?: string) => Promise<void>>();
  let stopped = false;
  // A start Windows refuses (EPERM, nothing ran) is tried again a few times. A git that started is
  // run again only once, when it was ended from outside and is safe to repeat (src/hosts/gitRetry.ts).
  const run: RunGit = (args, input, extra) => retryGitOnce(args, () => retrySpawn(`git ${commandOf(args)}`, () => runOnce(args, input, extra)));
  const runOnce: RunGit = (args, input, extra) =>
    new Promise((resolvePromise, reject) => {
      if (stopped) return reject(new Error(`git ${commandOf(args)} not started: Scope Soup is stopping`));
      const before = Date.now();
      const child = spawn(executable, args, {
        cwd: repoDir,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...gitEnvironment(), ...extra },
        // POSIX: its own process group, so a timeout ends the whole group.
        detached: process.platform !== "win32",
      });
      // When git was created, at the earliest and the latest: a tree kill checks the root against it.
      const window: CreationWindow = { notBeforeMs: before - 100, notAfterMs: Date.now() + 100 };
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      let exited = false;
      // Set while the call is being ended: git's own exit then is the kill, not an answer.
      let ending = false;
      let grace: NodeJS.Timeout | undefined;
      const closePipes = (): void => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
      };
      const result = (code: number | null): GitOutput => ({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8").trim() });
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        running.delete(end);
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        outcome();
      };
      /** Ends the tree and fails the call with `why`. */
      const end = async (why = `did not finish within ${timeoutMs} ms`): Promise<void> => {
        if (settled || ending) return;
        ending = true;
        const complete = exited || child.pid === undefined ? true : await killTree(child, child.pid, window, executable);
        closePipes();
        const left = complete ? "" : "; a hook or ssh it started may not have ended, and processes may be left running";
        finish(() => reject(new Error(`git ${commandOf(args)} ${why}; it and what it started were ended${left}`)));
      };
      running.add(end);
      const timer = setTimeout(() => void end(), timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      // With its pid on it, an error of a git that did start is never taken for a refused start.
      child.on("error", (error) => finish(() => reject(child.pid === undefined ? error : Object.assign(error, { pid: child.pid }))));
      child.on("exit", (code) => {
        // git is gone: its pid may be reused, so the timer must not kill by it any more.
        exited = true;
        clearTimeout(timer);
        if (ending) return;
        // Normally "close" follows at once; if a leftover child holds the pipes, do not wait for it.
        grace = setTimeout(() => {
          closePipes();
          finish(() => resolvePromise(result(code)));
        }, PIPE_GRACE_MS);
      });
      child.on("close", (code) => {
        if (!ending) finish(() => resolvePromise(result(code)));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input ?? "");
    });
  return Object.assign(run, {
    async stop() {
      stopped = true;
      await Promise.all([...running].map((end) => end("was stopped: Scope Soup is stopping")));
    },
  });
}

function failed(what: string, result: GitOutput): Error {
  return new Error(`git ${what} failed (exit ${result.code})${result.stderr ? `: ${result.stderr}` : ""}`);
}

/** The commit the ref points at, or null when the repository has no such ref. A ref at anything else is an error. */
export async function resolveRef(git: RunGit, ref: string): Promise<string | null> {
  if (!isMetaRef(ref)) throw new Error(`"${ref}" is not a ref Scope Soup will read`);
  // One call gives the ref's id and the type of what it points at. for-each-ref takes a pattern, so
  // a ref below this name (refs/x/y for refs/x) is listed too: only the exact name counts.
  const result = await git(["for-each-ref", "--format=%(objecttype) %(objectname) %(refname)", ref]);
  if (result.code !== 0) throw failed("for-each-ref", result);
  let type = "";
  let sha = "";
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const [kind, id, name] = line.trim().split(" ");
    if (name === ref) {
      type = kind ?? "";
      sha = id ?? "";
    }
  }
  if (type === "") return null;
  if (!isSha(sha)) throw failed("for-each-ref", result);
  if (type === "commit") return sha;
  if (type === "tag") {
    const peeled = await git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    const commit = peeled.stdout.toString("utf8").trim();
    if (peeled.code === 0 && isSha(commit)) return commit;
  }
  throw new Error(`The meta ref ${ref} points at a ${type}, not a commit.`);
}

/**
 * Refuses a directory that is not itself a repository: a plain subdirectory of another repository
 * would make git read the outer one. A bare repository, a working copy's top level, a `.git`
 * directory and a submodule's directory (which is a top level) are accepted.
 */
export async function checkRepoRoot(git: RunGit, repoDir: string): Promise<void> {
  const dir = resolve(repoDir);
  if (!existsSync(dir)) throw new Error(`The meta repository ${dir} does not exist.`);
  const real = (path: string): string => {
    const full = realpathSync.native(resolve(path));
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  const here = real(dir);
  const ask = async (args: string[]): Promise<string | null> => {
    const result = await git(args);
    return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
  };
  const gitDir = await ask(["rev-parse", "--absolute-git-dir"]);
  if (gitDir === null) throw new Error(`The meta repository ${dir} is not a git repository.`);
  if (real(gitDir) === here) return; // a bare repository, or a .git directory
  const top = await ask(["rev-parse", "--show-toplevel"]);
  if (top !== null && real(top) === here) return;
  throw new Error(`The meta repository ${dir} is not the top level of a repository (git finds the one at ${top ?? gitDir}). Point SCOPESOUP_META_REPO at the repository's own folder.`);
}

export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  /** Bytes, for a blob; null for anything else. */
  size: number | null;
  path: string;
}

/** Every entry under `items/` in the commit's tree, recursively, and the format entry when there is one. */
export async function listItemsTree(git: RunGit, commit: string): Promise<TreeEntry[]> {
  if (!isSha(commit)) throw new Error(`"${commit}" is not a commit id`);
  const result = await git(["ls-tree", "-r", "-z", "-l", "--full-tree", commit, "--", "items", FORMAT_FILE]);
  if (result.code !== 0) throw failed("ls-tree", result);
  const entries: TreeEntry[] = [];
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    // "<mode> <type> <sha> <size, padded with spaces>": size is "-" for what is not a blob.
    const [mode, type, sha, size] = record.slice(0, tab).split(/ +/);
    if (tab < 0 || !mode || !type || !sha || !size) continue;
    entries.push({ mode, type, sha, size: /^\d+$/.test(size) ? Number(size) : null, path: record.slice(tab + 1) });
  }
  return entries;
}

export interface BatchObject {
  type: string;
  content: Buffer;
}

/** Reads objects by id with one `git cat-file --batch`. Missing objects are left out of the map. */
export async function readObjects(git: RunGit, shas: string[]): Promise<Map<string, BatchObject>> {
  const wanted = [...new Set(shas)];
  for (const sha of wanted) if (!isSha(sha)) throw new Error(`"${sha}" is not an object id`);
  const objects = new Map<string, BatchObject>();
  if (wanted.length === 0) return objects;
  const result = await git(["cat-file", "--batch"], `${wanted.join("\n")}\n`);
  if (result.code !== 0) throw failed("cat-file", result);
  const out = result.stdout;
  let at = 0;
  for (const sha of wanted) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) throw new Error("git cat-file --batch ended early");
    const header = out.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    if (header[1] === "missing" || header.length !== 3) continue;
    const size = Number(header[2]);
    if (!Number.isInteger(size) || size < 0 || at + size > out.length) throw new Error("git cat-file --batch gave an unreadable header");
    objects.set(sha, { type: header[1] as string, content: out.subarray(at, at + size) });
    at += size + 1;
  }
  return objects;
}

/** The committer time of a raw commit object, as ISO 8601 in UTC. */
export function commitTime(commit: Buffer): string | null {
  const match = /^committer .* (\d+) [+-]\d{4}$/m.exec(commit.toString("utf8"));
  return match ? new Date(Number(match[1]) * 1000).toISOString() : null;
}

export interface MetaTree {
  /** The commit the ref points at; null when there is no ref. */
  commit: string | null;
  /** The commit's time; the fallback for items and lines that give none. */
  time: string;
  files: ItemFiles[];
  skipped: string[];
  /** The meta branch's format, from its `format` entry (none is format 0). */
  format: MetaFormat;
}

const ITEM_FILE = /^items\/([^/]+)\/(item\.md|log\.jsonl|item\.conflict-[0-9a-f]{12}\.md)$/;

/** The most an `item.md` or a `log.jsonl` may hold: a larger one is malformed for its item and is not read (limits.ts). */
export { MAX_FILE_BYTES };

/** Only these modes are regular files; a symlink (120000) or anything else is not read. */
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

export interface ReadOptions {
  maxFileBytes?: number;
}

interface Found {
  itemMd?: TreeEntry;
  log?: TreeEntry;
  /** Versions of item.md put aside in a conflict (named, not read). */
  conflicts?: string[];
}

/**
 * Reads every item in the meta commit (from `resolveRef`; null for no ref). Ids come from tree
 * entry names and are checked; anything under `items/` that is not `items/<id>/item.md` or
 * `items/<id>/log.jsonl` as a regular file is skipped and named. The sizes come with the tree, so
 * a file over the cap is never read and spoils only its own item.
 */
export async function readMetaTree(git: RunGit, commit: string | null, now: () => string, options: ReadOptions = {}): Promise<MetaTree> {
  if (!commit) return { commit: null, time: now(), files: [], skipped: [], format: { ok: true, format: 0 } };
  const cap = options.maxFileBytes ?? MAX_FILE_BYTES;
  const entries = await listItemsTree(git, commit);
  const byId = new Map<string, Found>();
  const skipped: string[] = [];
  // The format entry; with `-r`, a directory of that name shows as the files in it, which is no format entry either.
  const formatEntries = entries.filter((entry) => entry.path === FORMAT_FILE || entry.path.startsWith(`${FORMAT_FILE}/`));
  const formatEntry = formatEntries.length === 1 && formatEntries[0]?.path === FORMAT_FILE ? formatEntries[0] : undefined;
  const formatBlob = formatEntry && formatEntry.type === "blob" && REGULAR_FILE_MODES.has(formatEntry.mode) && isSha(formatEntry.sha) && (formatEntry.size ?? Infinity) <= 64 ? formatEntry.sha : undefined;
  for (const entry of entries) {
    if (entry.path === FORMAT_FILE || entry.path.startsWith(`${FORMAT_FILE}/`)) continue;
    const match = ITEM_FILE.exec(entry.path);
    const id = match?.[1];
    if (!match || !id || !isItemId(id) || entry.type !== "blob" || !REGULAR_FILE_MODES.has(entry.mode) || !isSha(entry.sha)) {
      skipped.push(entry.path);
      continue;
    }
    const found = byId.get(id) ?? {};
    if (match[2] === "item.md") found.itemMd = entry;
    else if (match[2] === "log.jsonl") found.log = entry;
    else (found.conflicts ??= []).push(match[2] as string);
    byId.set(id, found);
  }
  const small = (entry: TreeEntry | undefined): entry is TreeEntry => entry !== undefined && entry.size !== null && entry.size <= cap;
  const blobs = [...byId.values()].flatMap((found) => [found.itemMd, found.log]).filter(small).map((entry) => entry.sha);
  const objects = await readObjects(git, [commit, ...blobs, ...(formatBlob ? [formatBlob] : [])]);
  const format: MetaFormat =
    formatEntries.length === 0
      ? { ok: true, format: 0 }
      : !formatEntry
        ? { ok: false, problem: `${FORMAT_FILE} is not a regular file` }
        : readFormat(formatEntry, formatBlob ? (objects.get(formatBlob)?.content.toString("utf8") ?? null) : null);
  const commitObject = objects.get(commit);
  const time = (commitObject && commitTime(commitObject.content)) ?? now();
  const files: ItemFiles[] = [...byId.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, found]) => {
      const files: ItemFiles = { id };
      if (found.conflicts) files.conflicts = found.conflicts;
      const tooBig = (name: string, entry: TreeEntry): string => `${name} is ${entry.size} bytes, over the limit of ${cap}; not read`;
      if (found.itemMd) {
        if (small(found.itemMd)) {
          const content = objects.get(found.itemMd.sha)?.content.toString("utf8");
          if (content !== undefined) files.itemMd = content;
        } else files.itemMdProblem = tooBig("item.md", found.itemMd);
      }
      if (found.log) {
        if (small(found.log)) {
          const content = objects.get(found.log.sha)?.content.toString("utf8");
          if (content !== undefined) files.log = content;
        } else files.logProblem = tooBig("log.jsonl", found.log);
      }
      return files;
    });
  return { commit, time, files, skipped, format };
}
