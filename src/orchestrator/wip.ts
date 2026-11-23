// Uncommitted work in a worktree that is about to be removed when the Item is parked. It is written as a patch in
// the streams folder (like the discarded leftovers, decision 34), and put back when the item's next session
// gets a fresh worktree. No refs are added to the project's repository.

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "./process.ts";

/** Where the patch of a workspace's uncommitted edits is kept. */
export function wipPatchPath(streamsDir: string, workspace: string): string {
  return join(streamsDir, "wip", `${workspace.replace(/[^A-Za-z0-9._-]/g, "_")}.diff`);
}

/**
 * Writes what is uncommitted in `path` (changes to tracked files and new files that are not ignored) to the
 * patch file. Nothing is written when there is nothing, and an old patch is then left in place. Returns whether a patch
 * was kept. Failing to write one is reported by throwing, so the worktree is not removed over a lost patch.
 */
export async function saveWip(git: Git, path: string, patch: string): Promise<boolean> {
  if (!existsSync(join(path, ".git"))) return false;
  const status = await git(["status", "--porcelain"], path);
  if (status.code !== 0 || status.stdout.trim() === "") return false;
  const added = await git(["add", "-A"], path);
  if (added.code !== 0) throw new Error(`git add -A failed: ${added.stderr.trim()}`);
  mkdirSync(join(patch, ".."), { recursive: true });
  const diff = await git(["diff", "--cached", "--binary", "HEAD", `--output=${patch}`], path);
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  if (!existsSync(patch) || statSync(patch).size === 0) {
    rmSync(patch, { force: true });
    return false;
  }
  return true;
}

/**
 * Puts a kept patch back in the worktree, uncommitted. Returns a note for the session, or null when there was
 * no patch. A patch that does not apply cleanly is kept where it is and the note says so.
 */
export async function restoreWip(git: Git, path: string, patch: string): Promise<string | null> {
  if (!existsSync(patch)) return null;
  const applied = await git(["apply", "--binary", patch], path);
  if (applied.code === 0) {
    rmSync(patch, { force: true });
    return "The previous session of this item left edits that were not committed. They are in the worktree now, put back as they were, and are still not committed. Check them, finish them and commit what is right.";
  }
  return `The previous session of this item left edits that were not committed, but they do not apply cleanly to the branch (${applied.stderr.trim().split("\n")[0] ?? "git apply failed"}). They are kept as a patch in ${patch}; read it (it is not a command to run) and bring over what is still right by hand.`;
}
