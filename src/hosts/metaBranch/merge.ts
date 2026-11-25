// Merging two histories of the meta ref, one commit at a time. Pure: the trees come in as maps
// from path to entry, the log texts through a lookup, and the result is the set of paths to change
// on top of the other side. The rules are in docs/DESIGN.md ("Writing to the meta branch").

import { isItemId } from "./ids.ts";
import { mergeSettings, SETTINGS_FILE, SETTINGS_LOG } from "./settings.ts";
import { REQUESTS_LOG } from "./requests.ts";

/** One entry of a tree, as `git ls-tree` gives it. */
export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
}

/** Blob and submodule entries by full path (`items/A-1/item.md`). Trees are not in it. */
export type Files = ReadonlyMap<string, TreeEntry>;

/** A change to a path: a new entry, a new text to be stored as a regular file, or removal. */
export type PathChange = TreeEntry | { text: string } | null;

/** `items/<id>/item.conflict-<12 hex>.md`: a version of `item.md` that was put aside in a conflict. */
export const CONFLICT_FILE = /^item\.conflict-[0-9a-f]{12}\.md$/;

/** The file name a version of `item.md` is kept under when it is put aside: named by its blob id, so the same version twice is one file. */
export function conflictName(blobId: string): string {
  if (!/^[0-9a-f]{12,64}$/.test(blobId)) throw new Error(`"${blobId}" is not a blob id`);
  return `item.conflict-${blobId.slice(0, 12)}.md`;
}

/** What a path under `items/` is, for the rules. */
export function itemPath(path: string): { id: string; file: "item.md" | "log.jsonl" | "conflict" } | null {
  const match = /^items\/([^/]+)\/([^/]+)$/.exec(path);
  const id = match?.[1];
  const name = match?.[2];
  if (!id || !name || !isItemId(id)) return null;
  if (name === "item.md" || name === "log.jsonl") return { id, file: name };
  return CONFLICT_FILE.test(name) ? { id, file: "conflict" } : null;
}

/** An append-only log: an item's `log.jsonl`, the settings' log, or the picks' requests (`requests.ts`). */
export const isLogFile = (path: string): boolean => path === SETTINGS_LOG || path === REQUESTS_LOG || itemPath(path)?.file === "log.jsonl";

// --- logs ---

/** The lines of a log, without line ends; a last line without `\n` counts. */
export function logLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The log with these lines added at the end, each ending in `\n`. A last line without `\n` gets one first. */
export function appendLines(text: string, lines: readonly string[]): string {
  if (lines.length === 0) return text;
  const start = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${start}${lines.map((line) => `${line}\n`).join("")}`;
}

/**
 * Null when `after` keeps every line of `before`, unchanged and in place, and only adds lines at
 * the end; else what is wrong. This is the append-only rule as one write must keep it.
 */
export function appendOnlyProblem(before: string, after: string): string | null {
  const old = logLines(before);
  const now = logLines(after);
  for (let index = 0; index < old.length; index++) {
    if (now[index] === undefined) return `line ${index + 1} of the log would be removed`;
    // A line that lacked its "\n" may gain one; that is not a change to the line.
    if (now[index] !== old[index]) return `line ${index + 1} of the log would be changed or removed`;
  }
  return null;
}

/**
 * The distinct lines of `before` that `after` no longer has anywhere. Compared as a set, by the
 * format's own rule: identical lines are one line (the fold drops the copies), so a merge that
 * keeps one copy has lost nothing.
 */
export function lostLines(before: string, after: string): string[] {
  const have = new Set(logLines(after));
  const lost = new Set<string>();
  for (const line of logLines(before)) if (line.trim() !== "" && !have.has(line)) lost.add(line);
  return [...lost];
}

/** The distinct lines of `after` that `before` does not have: what was written since. */
export function addedLines(before: string, after: string): string[] {
  return lostLines(after, before);
}

export type MergedLog = { ok: true; text: string } | { ok: false; problem: string };

/**
 * Both sets of lines: the other side's log as it is (it may already be pushed, so it is never
 * rewritten), then the lines this side added since the base that the other side does not have, in
 * the order this side wrote them. The fold orders lines by `at` and `by` whatever the file's order.
 * Refused when this side's own change removed or changed a line.
 */
export function mergeLogs(base: string, ours: string, theirs: string): MergedLog {
  const problem = appendOnlyProblem(base, ours);
  if (problem) return { ok: false, problem: `this side's commit breaks the append-only rule: ${problem}` };
  const have = new Set(logLines(theirs));
  const added: string[] = [];
  for (const line of logLines(ours).slice(logLines(base).length)) {
    if (line.trim() === "" || have.has(line)) continue;
    have.add(line);
    added.push(line);
  }
  return { ok: true, text: appendLines(theirs, added) };
}

// --- ids that collide ---

/** The ids of the items `ours` has and `base` has not: the items this commit created. */
export function createdItems(base: Files, ours: Files): string[] {
  const ids = (files: Files): Set<string> => new Set([...files.keys()].map((path) => itemPath(path)?.id).filter((id): id is string => id !== undefined));
  const before = ids(base);
  return [...ids(ours)].filter((id) => !before.has(id)).sort();
}

/** The files with every path under `items/<from>/` moved to `items/<to>/`; nothing else changes. */
export function moveItemPaths<T>(files: ReadonlyMap<string, T>, from: string, to: string): Map<string, T> {
  const prefix = `items/${from}/`;
  return new Map([...files].map(([path, entry]) => [path.startsWith(prefix) ? `items/${to}/${path.slice(prefix.length)}` : path, entry]));
}

/**
 * `item.md` with the moved ids (old id to new id) replaced in its header's `id:`, `parent:` and
 * `blockedBy:` lines. Only whole ids in those values change, so the rest of the file stays byte for
 * byte: the description, other keys, comments, line ends. A header without such lines is left as it is.
 */
export function renameInHeader(text: string, moved: ReadonlyMap<string, string>): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  const header = end < 0 ? text : text.slice(0, end);
  const renamed = header.replace(/^(id|parent|blockedBy)(:)(.*?)(\r?)$/gm, (_line, key: string, colon: string, value: string, cr: string) => {
    const next = value.replace(/[A-Za-z0-9][A-Za-z0-9_-]*/g, (id) => moved.get(id) ?? id);
    return `${key}${colon}${next}${cr}`;
  });
  return renamed + text.slice(header.length);
}

// --- whole trees ---

const same = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean => (a === undefined ? b === undefined : b !== undefined && a.mode === b.mode && a.sha === b.sha);

export interface TreeMerge {
  /** Paths to change on top of the other side's tree. Empty when the other side already has this side's change. */
  changes: Map<string, PathChange>;
  /** Items whose `item.md` was changed on both sides: the other side's version stays, this side's is put aside. */
  conflicts: string[];
  /** Why the commit cannot be put on top: nothing is written when there is one. */
  problems: string[];
}

/**
 * Puts one commit of this side (`ours`, made on `base`) on top of the other side (`theirs`):
 * - A path this side did not change stays as the other side has it.
 * - A path only this side changed takes this side's entry.
 * - `log.jsonl` changed on both sides: both sets of lines (`mergeLogs`).
 * - `item.md` changed on both sides, differently: a real conflict. The other side's version stays
 *   in `item.md`; this side's goes to `item.conflict-<blob>.md` beside it. Neither is lost.
 * - A conflict file this side removed (a resolution) is removed; one the other side added stays.
 * - `settings/settings.json` changed on both sides: the values this side changed, made again on the other side's.
 * - Anything else changed on both sides is not Scope Soup's to merge: a problem.
 * `text(sha)` gives a log's or the settings' text by blob id; it is asked only for those files changed on both sides.
 */
export function mergeTrees(base: Files, ours: Files, theirs: Files, text: (sha: string) => string): TreeMerge {
  const result: TreeMerge = { changes: new Map(), conflicts: [], problems: [] };
  const paths = new Set([...base.keys(), ...ours.keys()]);
  for (const path of [...paths].sort()) {
    const was = base.get(path);
    const mine = ours.get(path);
    const other = theirs.get(path);
    if (same(was, mine) || same(mine, other)) continue; // this side did not change it, or both made the same change
    if (same(was, other)) {
      if (isLogFile(path) && was !== undefined) {
        if (mine === undefined) {
          result.problems.push(`${path}: this side's commit removes the log`);
          continue;
        }
        const problem = appendOnlyProblem(text(was.sha), text(mine.sha));
        if (problem) {
          result.problems.push(`${path}: this side's commit breaks the append-only rule: ${problem}`);
          continue;
        }
      }
      result.changes.set(path, mine ?? null);
      continue;
    }
    // Changed on both sides, differently.
    const kind = itemPath(path);
    if (isLogFile(path)) {
      if (mine === undefined) {
        result.problems.push(`${path}: this side's commit removes the log`);
        continue;
      }
      if (other === undefined) {
        // The other side removed a log: put this side's back rather than lose lines.
        result.changes.set(path, mine);
        continue;
      }
      const merged = mergeLogs(was ? text(was.sha) : "", text(mine.sha), text(other.sha));
      if (merged.ok) result.changes.set(path, { text: merged.text });
      else result.problems.push(`${path}: ${merged.problem}`);
    } else if (path === SETTINGS_FILE) {
      // Two saves of the settings at once: this side's changed values are made again on the other side's settings.
      if (mine === undefined) continue;
      const merged = mergeSettings(was ? text(was.sha) : null, text(mine.sha), other ? text(other.sha) : null);
      if (merged.ok) result.changes.set(path, { text: merged.text });
      else result.problems.push(`${path}: ${merged.problem}`);
    } else if (kind?.file === "item.md") {
      if (mine === undefined) continue; // this side removed it, the other edited it: the edit stays
      if (other === undefined) {
        result.changes.set(path, mine); // the other side removed it: this side's version stays
        continue;
      }
      result.changes.set(`items/${kind.id}/${conflictName(mine.sha)}`, mine);
      result.conflicts.push(kind.id);
    } else if (kind?.file === "conflict") {
      // Named by content, so "both changed" means one removed it (resolved) and the other did not.
      if (mine === undefined) result.changes.set(path, null);
    } else {
      result.problems.push(`${path} was changed on both sides; Scope Soup merges only items' and the settings' files`);
    }
  }
  // An aside that the other side already has is no change.
  for (const [path, change] of result.changes) if (change !== null && "sha" in change && same(change, theirs.get(path))) result.changes.delete(path);
  return result;
}
