// The diff of an item's branch against where it left the main branch, for the item page. Read with
// git, without a shell, in the repository that holds the branch (`itemRepository`). Nothing is
// fetched: it shows what the clone has. Bounded, so a huge or binary change cannot flood the page.

import type { ProjectConfig } from "../config/types.ts";
import type { DiffFile, DiffView } from "../core/views.ts";
import type { Ref } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import { workBranch } from "./paths.ts";
import type { Git } from "./process.ts";
import { itemRepository } from "./workspaces.ts";

/** Files named in the list. */
export const MAX_FILES = 200;
/** A file with more changed lines than this is named, not shown. */
export const MAX_FILE_LINES = 1500;
/** Characters of diff text for one file, and for all files together. */
export const MAX_FILE_CHARS = 100_000;
export const MAX_TOTAL_CHARS = 400_000;

export interface DiffDeps {
  store: Store;
  config: () => ProjectConfig;
  git: Git;
  now: () => Date;
}

export async function itemDiff(deps: DiffDeps, item: Ref): Promise<DiffView> {
  const at = deps.now().toISOString();
  const none = (reason: string): DiffView => ({ now: at, available: false, reason });
  const config = deps.config();
  let repo: string | null;
  try {
    repo = itemRepository(deps.store, config, item);
  } catch (error) {
    return none(error instanceof Error ? error.message : String(error));
  }
  if (!repo) return none("No clone holds this item's branch.");
  const branch = workBranch(item);
  const tip = `refs/heads/${branch}`;
  const { git } = deps;
  const tipped = await git(["rev-parse", "--verify", "--quiet", `${tip}^{commit}`], repo);
  if (tipped.code !== 0) return none(`There is no branch ${branch} yet.`);

  // The newest main the clone knows: the fetched remote branch, else the local one.
  let main: string | null = null;
  for (const name of [`refs/remotes/${config.remote}/${config.mainBranch}`, `refs/heads/${config.mainBranch}`]) {
    if ((await git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], repo)).code === 0) {
      main = name;
      break;
    }
  }
  if (!main) return none(`The clone has no ${config.mainBranch} branch to compare with.`);
  const mergeBase = await git(["merge-base", main, tip], repo);
  const base = mergeBase.stdout.trim();
  if (mergeBase.code !== 0 || base === "") return none(`${branch} shares no history with ${config.mainBranch}.`);

  const changed = await changedFiles(git, repo, base, tip);
  if (!changed.ok) return none(changed.reason);
  return { now: at, available: true, branch, base, tip: tipped.stdout.trim(), ...changed.value };
}

export interface ChangedFiles {
  files: DiffFile[];
  /** Files past the list's bound: counted, not named. */
  omitted: number;
  totalAdded: number;
  totalRemoved: number;
}

/** The files that differ between two commits of `repo`, with the bounds above. Also used for one commit of the history. */
export async function changedFiles(git: Git, repo: string, base: string, tip: string): Promise<{ ok: true; value: ChangedFiles } | { ok: false; reason: string }> {
  const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
  const stat = await git(["diff", ...common, "--numstat", "-z", base, tip], repo);
  if (stat.code !== 0) return { ok: false, reason: `git diff failed: ${stat.stderr.trim().slice(-300)}` };

  const entries: { path: string; added: number; removed: number; binary: boolean }[] = [];
  for (const record of stat.stdout.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) continue;
    const binary = match[1] === "-";
    entries.push({ path: match[3]!, added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary });
  }

  const files: DiffFile[] = [];
  let spent = 0;
  for (const entry of entries.slice(0, MAX_FILES)) {
    const file: DiffFile = { ...entry };
    if (entry.binary) file.note = "Binary file, not shown.";
    else if (entry.added + entry.removed > MAX_FILE_LINES) file.note = `Too large to show: ${entry.added + entry.removed} changed lines.`;
    else if (spent >= MAX_TOTAL_CHARS) file.note = "Not shown: the page's limit for one change is reached.";
    else {
      const shown = await git(["diff", ...common, "-U3", base, tip, "--", `:(literal)${entry.path}`], repo);
      if (shown.code !== 0) file.note = "Could not be read.";
      else {
        // Git's header lines are dropped; the page already names the file.
        const start = shown.stdout.indexOf("@@");
        let text = start < 0 ? "" : shown.stdout.slice(start);
        if (text.length > MAX_FILE_CHARS) text = `${text.slice(0, MAX_FILE_CHARS)}\n[cut: longer than ${MAX_FILE_CHARS} characters]\n`;
        spent += text.length;
        file.diff = text;
      }
    }
    files.push(file);
  }
  return {
    ok: true,
    value: {
      files,
      omitted: Math.max(0, entries.length - files.length),
      totalAdded: entries.reduce((sum, entry) => sum + entry.added, 0),
      totalRemoved: entries.reduce((sum, entry) => sum + entry.removed, 0),
    },
  };
}
