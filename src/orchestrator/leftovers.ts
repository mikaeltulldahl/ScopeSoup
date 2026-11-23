// Leftovers in the project's repository of a pool clone: listing them, recording them on the
// laptop, and discarding exactly what was listed and recorded (decision 34).
//
// Only workspaces.ts calls this, and only once it has checked that the item holds the clone and a
// session of the item ran there. Nothing here decides whether a discard may happen; it decides what
// goes, keeps a full copy of it first, and reports per path what happened.
//
// - What goes: changes to tracked files (worktree and index, restored from HEAD) and untracked
//   files, as `git status --porcelain=v1 -z --untracked-files=all` lists them. Ignored files are
//   never listed.
// - What stays: anything git ignores, anything matching `workspaces.keep` (gitignore patterns,
//   relative to the project's repository), nested repositories and submodules, links, files behind a
//   link, and a tracked file whose change matches an ignore or keep pattern (left as it is).
// - Nothing goes without a copy: the worktree diff, the staged diff, and a verified copy of every
//   file that is removed or overwritten. When it would exceed the cap or a copy fails, nothing goes.
// - No `git reset --hard`, no `git clean`: tracked files are restored by name with
//   `git restore --source=HEAD --staged --worktree -- :(literal)<path>`, and only while their state
//   is still the recorded one; untracked files are removed one by one, only while they are the plain
//   file that was copied. A file that appeared after the listing is not in the list.
// - Afterwards the record is cut down to exactly what was discarded (`finishRecord`), with a
//   RESTORE.md whose commands bring back that and touch nothing that was left.

import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { within } from "../config/validate.ts";
import type { Git } from "./process.ts";

/** The most that is copied into one record. More than that, and nothing is discarded. */
export const RECORD_CAP_BYTES = 500 * 1024 * 1024;
/** Paths per git call, so a long list stays under the command-line limit on Windows. */
const CHUNK = 100;

export interface Leftovers {
  /** Changed tracked files (worktree or index) that will be restored from HEAD. */
  tracked: string[];
  /** Untracked plain files that will be removed. */
  untracked: string[];
  /** Tracked files taken out of the index whose file is still there: copied, then restored from HEAD. In `tracked` too. */
  shadowed: string[];
  /** Changed tracked files left as they are: they match an ignore or a keep pattern, or are not a plain file. */
  keptTracked: string[];
  /** Untracked paths left as they are: a keep pattern, a nested repository, a link, behind a link, or not a plain file. */
  keptUntracked: string[];
  /** Paths with a conflict: while there are any, nothing is discarded. */
  unmerged: string[];
}

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += CHUNK) out.push(list.slice(index, index + CHUNK));
  return out;
}

function literal(paths: string[]): string[] {
  return paths.map((path) => `:(literal)${path}`);
}

function nul(text: string): string[] {
  return text.split("\0").filter((entry) => entry !== "");
}

async function run(git: Git, args: string[], repo: string): Promise<string> {
  const result = await git(args, repo);
  if (result.code !== 0) throw new Error(`git ${args.slice(0, 3).join(" ")} failed in ${repo}: ${result.stderr.trim() || `code ${result.code}`}`);
  return result.stdout;
}

/** The patterns as `--exclude=` values: joined to the option, so a pattern is never read as an option of its own. */
function excludes(keep: string[]): string[] {
  return keep.map((pattern) => `--exclude=${pattern}`);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeRelative(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !path.split(/[\\/]/).includes("..");
}

/** A plain file in the repository, not a link and not behind one. */
function plainFileInside(root: string, path: string): boolean {
  if (!safeRelative(path)) return false;
  const full = resolve(root, path);
  try {
    // Git for Windows lists files behind a junction as if they were in the repository.
    if (!within(root, full) || !within(root, realpathSync(dirname(full)))) return false;
    const stat = lstatSync(full);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** What a discard would do in the repository now. Reads only. */
export async function listLeftovers(git: Git, repo: string, keep: string[]): Promise<Leftovers> {
  const root = realpathSync(repo);
  const out = await run(git, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all"], repo);
  const entries = nul(out).map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
  const found: Leftovers = { tracked: [], untracked: [], shadowed: [], keptTracked: [], keptUntracked: [], unmerged: [] };
  // Tracked files (in HEAD or in the index) that match an ignore or a keep pattern.
  const protectedTracked = new Set(nul(await run(git, ["ls-files", "-z", "--cached", "--ignored", "--with-tree=HEAD", "--exclude-standard", ...excludes(keep)], repo)));
  // Untracked files that are neither ignored nor kept.
  const removable = new Set(nul(await run(git, ["ls-files", "-z", "--others", "--exclude-standard", ...excludes(keep)], repo)));
  const trackedChange = new Set(entries.filter(({ code }) => code !== "??" && !UNMERGED.has(code)).map(({ path }) => path));
  const untrackedToo = new Set(entries.filter(({ code }) => code === "??").map(({ path }) => path));
  // A tracked file whose path is now a folder of untracked files (` D x` and `?? x/y`): restoring the
  // one would have to clear the other. Both are left, and the clone stays passed over.
  const underFolder = (path: string): string | undefined => {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++) {
      const folder = parts.slice(0, length).join("/");
      if (trackedChange.has(folder)) return folder;
    }
    return undefined;
  };
  const replaced = new Set([...untrackedToo].map(underFolder).filter((folder): folder is string => folder !== undefined));
  for (const { code, path } of entries) {
    if (UNMERGED.has(code)) found.unmerged.push(path);
    else if (code === "??") {
      if (trackedChange.has(path)) continue; // Handled with the tracked entry.
      if (path.endsWith("/") || !removable.has(path) || underFolder(path) !== undefined || !plainFileInside(root, path)) found.keptUntracked.push(path);
      else found.untracked.push(path);
    } else if (protectedTracked.has(path) || replaced.has(path)) found.keptTracked.push(path);
    else if (untrackedToo.has(path)) {
      // Taken out of the index (`git rm --cached`) and the file is still there, perhaps changed.
      if (removable.has(path) && plainFileInside(root, path)) {
        found.tracked.push(path);
        found.shadowed.push(path);
      } else found.keptTracked.push(path);
    } else found.tracked.push(path);
  }
  return found;
}

/** Each tracked path's index entry and worktree content, to tell whether it changed since. */
async function trackedStates(git: Git, repo: string, paths: string[]): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const chunk of chunks(paths)) {
    for (const line of nul(await run(git, ["ls-files", "-z", "--stage", "--", ...literal(chunk)], repo))) {
      const tab = line.indexOf("\t");
      index.set(line.slice(tab + 1), `${index.get(line.slice(tab + 1)) ?? ""}${line.slice(0, tab)};`);
    }
  }
  const states = new Map<string, string>();
  for (const path of paths) {
    const full = join(repo, path);
    let worktree: string;
    try {
      const stat = lstatSync(full);
      worktree = stat.isSymbolicLink() ? `link ${readlinkSync(full)}` : stat.isFile() ? `file ${stat.size} ${sha256(full)}` : "other";
    } catch {
      worktree = "absent";
    }
    states.set(path, `${index.get(path) ?? "not in the index"} | ${worktree}`);
  }
  return states;
}

const DIFF_FLAGS = ["--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all", "--src-prefix=a/", "--dst-prefix=b/"];

/** One tracked path's diff, byte for byte as git makes it, in `file`; returns its size (0: no change of this kind). */
async function writeDiff(git: Git, repo: string, args: string[], path: string, file: string): Promise<number> {
  await run(git, [...args, ...DIFF_FLAGS, `--output=${file}`, "--", ...literal([path])], repo);
  return lstatSync(file).size;
}

export interface CopiedFile {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface Recorded {
  /** The record's folder. */
  dir: string;
  meta: RecordMeta;
  repo: string;
  head: string;
  /** Each copied file (untracked and shadowed), as it was when copied. */
  files: Map<string, CopiedFile>;
  /** Each tracked path's state when it was recorded; a path missing here changed while it was recorded and is left. */
  tracked: Map<string, string>;
  /** Each tracked path's own patches, under `patches/` until the discard is over. */
  patches: Map<string, { worktree: string; staged: string }>;
  /** Tracked paths that changed while they were recorded: left as they are. */
  unsettled: string[];
}

export interface RecordMeta {
  item: string;
  clone: string;
  branch: string;
  at: string;
}

/** Raised when what would have to be copied is more than the cap allows. */
export class TooLargeToRecord extends Error {}

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function tooLarge(total: number, capBytes: number): TooLargeToRecord {
  return new TooLargeToRecord(`the files to remove and the diffs come to ${total} bytes, more than the ${capBytes} bytes a record may hold`);
}

/**
 * Writes what will go to a new folder under `under`: a worktree patch and a staged patch per tracked
 * path (under `patches/`), a verified copy of every file that will be removed or overwritten (under
 * `files/`), and `discarded.json` saying the discard has not happened yet. The copies and the patches
 * together may not exceed `capBytes` (TooLargeToRecord; the copies are counted before anything is
 * written). Throws when anything cannot be written or verified; the folder is then removed again (it
 * is Scope Soup's own, never in the repository). `finishRecord` makes it describe the outcome.
 */
export async function recordLeftovers(git: Git, repo: string, leftovers: Leftovers, under: string, meta: RecordMeta, capBytes = RECORD_CAP_BYTES): Promise<Recorded> {
  const toCopy = [...leftovers.untracked, ...leftovers.shadowed];
  let total = 0;
  for (const path of toCopy) total += lstatSync(join(repo, path)).size;
  if (total > capBytes) throw tooLarge(total, capBytes);
  mkdirSync(under, { recursive: true });
  const base = join(under, `${safeName(meta.item)}-${safeName(meta.at)}`);
  let dir = base;
  for (let attempt = 2; ; attempt++) {
    try {
      mkdirSync(dir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 100) throw error;
      dir = `${base}-${attempt}`;
    }
  }
  try {
    const before = await trackedStates(git, repo, leftovers.tracked);
    const patches = new Map<string, { worktree: string; staged: string }>();
    mkdirSync(join(dir, "patches"));
    for (const [index, path] of leftovers.tracked.entries()) {
      const files = { worktree: join(dir, "patches", `${index}.worktree.diff`), staged: join(dir, "patches", `${index}.staged.diff`) };
      total += await writeDiff(git, repo, ["diff", "HEAD"], path, files.worktree);
      total += await writeDiff(git, repo, ["diff", "--cached", "HEAD"], path, files.staged);
      if (total > capBytes) throw tooLarge(total, capBytes);
      patches.set(path, files);
    }
    const files = new Map<string, CopiedFile>();
    for (const path of toCopy) {
      const source = join(repo, path);
      const target = resolve(dir, "files", path);
      if (!within(join(dir, "files"), target)) throw new Error(`${path} would be copied outside the record`);
      mkdirSync(dirname(target), { recursive: true });
      const stat = lstatSync(source);
      copyFileSync(source, target);
      const hash = sha256(source);
      const copied = lstatSync(target);
      if (copied.size !== stat.size || sha256(target) !== hash || lstatSync(source).mtimeMs !== stat.mtimeMs) {
        throw new Error(`the copy of ${path} could not be verified (it changed while it was copied, or the copy is not the same)`);
      }
      files.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash });
    }
    // A tracked path that changed while its patches were written is not in them as it is now: it is left.
    const after = await trackedStates(git, repo, leftovers.tracked);
    const tracked = new Map<string, string>();
    const unsettled: string[] = [];
    for (const path of leftovers.tracked) {
      const state = after.get(path);
      if (state !== undefined && state === before.get(path)) tracked.set(path, state);
      else unsettled.push(path);
    }
    const head = (await run(git, ["rev-parse", "HEAD"], repo)).trim();
    writeFileSync(join(dir, "discarded.json"), `${JSON.stringify({
      state: "Recorded; the discard has not finished. Until it has, this folder holds copies of every candidate, including paths that may be left in the clone: do not restore from it blindly.",
      item: meta.item, clone: meta.clone, repository: repo, branch: meta.branch, head, at: meta.at,
      candidates: { tracked: leftovers.tracked, untracked: leftovers.untracked, takenOutOfTheIndex: leftovers.shadowed },
      kept: { tracked: leftovers.keptTracked, untracked: leftovers.keptUntracked },
    }, null, 2)}\n`);
    return { dir, meta, repo, head, files, tracked, patches, unsettled };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** A word for a POSIX shell. */
function sh(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function posix(path: string): string {
  return path.split("\\").join("/");
}

/**
 * Makes the record describe exactly what was discarded: the patches of restored paths go into
 * `worktree.diff` and `staged.diff` (a file only when it has something in it), the copies of files
 * that were left are removed (they are still in the clone), `discarded.json` lists every path with
 * its outcome, and `RESTORE.md` gives the commands that bring back what was discarded, and nothing else.
 */
export function finishRecord(recorded: Recorded, leftovers: Leftovers, outcome: Discarded): void {
  const { dir, meta, repo, head } = recorded;
  const restored = new Set(outcome.restored);
  const removed = new Set(outcome.removed);
  const join2 = (kind: "worktree" | "staged"): string | null => {
    const parts = outcome.restored.map((path) => recorded.patches.get(path)).filter((files) => files !== undefined).map((files) => readFileSync(files[kind]));
    const all = Buffer.concat(parts);
    if (all.length === 0) return null;
    writeFileSync(join(dir, `${kind}.diff`), all);
    return `${kind}.diff`;
  };
  const staged = join2("staged");
  const worktree = join2("worktree");
  rmSync(join(dir, "patches"), { recursive: true, force: true });
  // Copies to bring back: the removed files, and the restored files that had been taken out of the index.
  const back = [...recorded.files.keys()].filter((path) => removed.has(path) || (restored.has(path) && leftovers.shadowed.includes(path)));
  for (const path of recorded.files.keys()) {
    if (!back.includes(path)) rmSync(resolve(dir, "files", path), { force: true });
  }
  // Every argument is absolute, or starts with `./` after `--`: no path can be read as an option.
  const commands = [`cd ${sh(posix(repo))}`];
  if (staged) commands.push(`git apply --cached --binary -- ${sh(posix(join(dir, staged)))}`);
  if (worktree) commands.push(`git apply --binary -- ${sh(posix(join(dir, worktree)))}`);
  for (const path of back) {
    if (path.includes("/")) commands.push(`mkdir -p -- ${sh(`./${path.slice(0, path.lastIndexOf("/"))}`)}`);
    commands.push(`cp -- ${sh(posix(resolve(dir, "files", path)))} ${sh(`./${path}`)}`);
  }
  const nothing = commands.length === 1;
  let restoreError: unknown = null;
  try {
    writeFileSync(join(dir, "RESTORE.md"), [
      "# Bring back what Scope Soup discarded",
      "",
      `Discarded from \`${repo}\` (clone \`${meta.clone}\`), when ${meta.item} freed it at ${meta.at}. The repository was at commit \`${head}\`; run the commands there, before anything else changes those files.`,
      "",
      `This brings back exactly what was discarded: ${outcome.restored.length} tracked file(s) and ${outcome.removed.length} untracked file(s). It touches nothing that was left in the clone (${outcome.left.length} path(s), listed in discarded.json).`,
      "",
      nothing ? "Nothing was discarded, so there is nothing to bring back." : "Run these in Git Bash (or another POSIX shell), in this order:",
      "",
      ...(nothing ? [] : ["```sh", ...commands, "```", ""]),
      "A file that was only marked intent-to-add (`git add -N`) comes back as an untracked file with the same content. With core.autocrlf on, line endings may differ after `git apply`; the content is the same.",
      "",
    ].join("\n"));
  } catch (error) {
    restoreError = error;
  }
  // Written after RESTORE.md, so it never claims a RESTORE.md that is not there.
  writeFileSync(join(dir, "discarded.json"), `${JSON.stringify({
    state: restoreError === null
      ? "Discarded. This folder holds exactly what was discarded; RESTORE.md says how to bring it back."
      : `Discarded. This folder holds exactly what was discarded, but RESTORE.md could not be written (${message(restoreError)}): bring it back by hand from the lists below (git apply --cached --binary staged.diff, git apply --binary worktree.diff, then copy files/ to the same paths).`,
    restoreSteps: restoreError === null ? "RESTORE.md" : null,
    item: meta.item, clone: meta.clone, repository: repo, branch: meta.branch, head, at: meta.at,
    restored: outcome.restored.filter((path) => !leftovers.shadowed.includes(path)),
    restoredAfterBeingTakenOutOfTheIndex: outcome.restored.filter((path) => leftovers.shadowed.includes(path)),
    removed: outcome.removed,
    left: outcome.left,
    kept: { tracked: leftovers.keptTracked, untracked: leftovers.keptUntracked },
    diffs: { staged, worktree },
    files: Object.fromEntries(back.map((path) => [path, { size: recorded.files.get(path)?.size, sha256: recorded.files.get(path)?.sha256 }])),
  }, null, 2)}\n`);
  if (restoreError !== null) throw new Error(`RESTORE.md could not be written: ${message(restoreError)}`);
}

export interface Discarded {
  /** Tracked paths restored from HEAD (shadowed ones included). */
  restored: string[];
  /** Untracked files removed. */
  removed: string[];
  /** Paths left as they are, and why. */
  left: { path: string; why: string }[];
  /** Set when the record could not be brought up to date with this outcome: it then still holds every candidate. */
  recordError?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
}

/**
 * Discards what was recorded and is still as recorded; every other path is left and named. Never
 * throws for one path: a file that cannot be removed (held open, say) is left and named.
 */
export async function discardLeftovers(git: Git, repo: string, leftovers: Leftovers, recorded: Recorded, remove: (path: string) => void = rmSync): Promise<Discarded> {
  const outcome: Discarded = { restored: [], removed: [], left: recorded.unsettled.map((path) => ({ path, why: "it changed while it was being recorded" })) };
  const now = await trackedStates(git, repo, [...recorded.tracked.keys()]);
  const restore: string[] = [];
  // The state holds the index entry and a hash of the working tree's file, so a shadowed path's copy is checked too.
  for (const [path, state] of recorded.tracked) {
    if (now.get(path) !== state) outcome.left.push({ path, why: "it changed after it was recorded" });
    else restore.push(path);
  }
  const restoreOne = async (paths: string[]): Promise<void> => {
    await run(git, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...literal(paths)], repo);
  };
  for (const chunk of chunks(restore)) {
    try {
      await restoreOne(chunk);
      outcome.restored.push(...chunk);
    } catch {
      for (const path of chunk) {
        try {
          await restoreOne([path]);
          outcome.restored.push(path);
        } catch (error) {
          outcome.left.push({ path, why: `it could not be restored: ${message(error)}` });
        }
      }
    }
  }
  const root = realpathSync(repo);
  for (const path of leftovers.untracked) {
    const copy = recorded.files.get(path);
    const full = resolve(root, path);
    try {
      if (!copy || !plainFileInside(root, path)) throw new Error("it is no longer the plain file inside the repository that was copied");
      const stat = lstatSync(full);
      if (stat.size !== copy.size || stat.mtimeMs !== copy.mtimeMs || sha256(full) !== copy.sha256) throw new Error("it changed after it was copied");
    } catch (error) {
      outcome.left.push({ path, why: message(error) });
      continue;
    }
    try {
      // The file only: folders stay, even when this leaves them empty (git does not see an empty folder).
      remove(full);
      outcome.removed.push(path);
    } catch (error) {
      outcome.left.push({ path, why: `it could not be removed: ${message(error)}` });
    }
  }
  try {
    finishRecord(recorded, leftovers, outcome);
  } catch (error) {
    outcome.recordError = message(error);
  }
  return outcome;
}
