// The meta branch's format (decision 63). The file `format` at the root of the meta tree holds a whole number and a
// line end. It is raised only for a breaking change: a field whose meaning changes, a new required field, a moved file.
// A meta branch without the file is format 0: everything Scope Soup wrote before the format entry. Format 1 is format 0 with the file;
// nothing else differs, so the step from 0 to 1 only writes it.
//
// Each step below turns a tree of one format into the next. The writer (writer.ts) runs them in one commit, made only
// by the machine that holds the merge queue lease (migrate.ts). Pure: the tree's texts come in through `text`.

import type { Files, PathChange } from "./merge.ts";

/** The format this Scope Soup reads and writes. Raise it, and add a step, only for a breaking change. */
export const META_FORMAT = 1;

/** The format entry: a regular file at the root of the meta tree. */
export const FORMAT_FILE = "format";

/** Said when the meta branch's format is newer than this Scope Soup's. */
export const NEWER_META = "this project's data is from a newer Scope Soup; upgrade";

/** What the format entry says: its format, or why it cannot be read. */
export type MetaFormat = { ok: true; format: number } | { ok: false; problem: string };

const REGULAR = new Set(["100644", "100755"]);

/** The text of the format entry for `format`. */
export const formatText = (format: number = META_FORMAT): string => `${format}\n`;

/**
 * The format a tree is in. `entry`: the tree's entry at `format`, undefined when there is none (format 0). `text`: its
 * content, read only when the entry is a regular file. A number with a line end (`\n` or `\r\n`, or none) is read; a
 * value with anything else, a symlink or a directory cannot be read.
 */
export function readFormat(entry: { mode: string; type: string } | undefined, text: string | null): MetaFormat {
  if (entry === undefined) return { ok: true, format: 0 };
  if (entry.type !== "blob" || !REGULAR.has(entry.mode)) return { ok: false, problem: `${FORMAT_FILE} is not a regular file` };
  const match = /^(0|[1-9][0-9]{0,8})(\r?\n)?$/.exec(text ?? "");
  if (!match) return { ok: false, problem: `${FORMAT_FILE} holds ${JSON.stringify((text ?? "").slice(0, 40))}, not a whole number` };
  return { ok: true, format: Number(match[1]) };
}

/** What a step does to a tree: the paths it changes and, one line each, what it changed (for the commit message). */
export interface StepResult {
  changes: Map<string, PathChange>;
  notes: string[];
}

/**
 * One step: a tree of format n becomes format n + 1. `files` is the tree as the steps before left it, `text` reads a
 * file of it. The format entry is not a step's: the migration writes it at the end. `oldFormWritable`: this Scope Soup may
 * keep writing to a tree of format n as it is until the migration is made (true when format n + 1 only adds to n).
 */
interface Step {
  oldFormWritable: boolean;
  run(files: Files, text: (path: string) => Promise<string | null>): Promise<StepResult>;
}

/** STEPS[n] turns format n into format n + 1. */
const STEPS: readonly Step[] = [
  // 0 to 1: format 1 is format 0 with the format entry. Nothing else changes.
  { oldFormWritable: true, run: async () => ({ changes: new Map(), notes: [] }) },
];

if (STEPS.length !== META_FORMAT) throw new Error(`The meta format is ${META_FORMAT} but there are ${STEPS.length} steps.`);

/**
 * Why this Scope Soup does not write to a meta branch of this format, or null when it does. A newer format, or one whose
 * entry cannot be read, is read only: every write is refused with the upgrade message. An older one is written to as it
 * is when every step from it only adds; otherwise writes wait for the migration.
 */
export function writeProblem(found: MetaFormat): string | null {
  if (!found.ok) return `The meta branch's ${found.problem}, so this Scope Soup cannot tell its format and writes nothing to it (a newer Scope Soup may have written it: then upgrade). Nothing was written.`;
  if (found.format > META_FORMAT) return `The meta branch is format ${found.format} and this Scope Soup knows formats 0 to ${META_FORMAT}: ${NEWER_META}. It is read only here; nothing was written.`;
  if (found.format < META_FORMAT && !STEPS.slice(found.format).every((step) => step.oldFormWritable)) {
    return `The meta branch is format ${found.format} and waits for its migration to format ${META_FORMAT}, made by the machine that holds the merge queue lease. Nothing was written.`;
  }
  return null;
}

/**
 * The changes that bring a tree of format `from` (older than this Scope Soup's) to the current format, the format entry
 * included, and what each step changed. `textOf` reads a blob of the tree by its id.
 */
export async function migrationChanges(from: number, files: Files, textOf: (sha: string) => Promise<string | null>): Promise<StepResult> {
  if (!Number.isInteger(from) || from < 0 || from >= META_FORMAT) throw new Error(`No migration from format ${from}: this Scope Soup is format ${META_FORMAT}.`);
  const changes = new Map<string, PathChange>();
  const notes: string[] = [];
  let current = new Map(files);
  // What earlier steps wrote is read from their changes, the rest from the tree.
  const text = async (path: string): Promise<string | null> => {
    const changed = changes.get(path);
    if (changed === null) return null;
    if (changed && "text" in changed) return changed.text;
    const entry = current.get(path);
    return entry ? textOf(entry.sha) : null;
  };
  for (let version = from; version < META_FORMAT; version++) {
    const step = await (STEPS[version] as Step).run(current, text);
    for (const [path, change] of step.changes) {
      if (path === FORMAT_FILE) throw new Error(`The step from format ${version} changes ${FORMAT_FILE}, which the migration writes.`);
      changes.set(path, change);
      if (change === null) current.delete(path);
      else if (!("text" in change)) current.set(path, change);
    }
    current = new Map(current);
    notes.push(`Format ${version} to ${version + 1}${step.notes.length > 0 ? `: ${step.notes.join(" ")}` : ": the format entry is written; nothing else changes."}`);
  }
  changes.set(FORMAT_FILE, { text: formatText(META_FORMAT) });
  return { changes, notes };
}
