// Where a session may run. The two invariants are checked before every launch: the working
// directory is inside the workspaces directory, and it is nowhere near a path marked as real.

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { overlaps, within } from "../config/validate.ts";
import type { ProjectConfig } from "../config/types.ts";
import { ITEM_BRANCH_PREFIX } from "../model/people.ts";
import type { Ref } from "../model/types.ts";
import { refKey } from "../model/types.ts";

/** A directory-safe name for an item: `[A-Za-z0-9._-]` kept, the rest `_`, with a hash when that changed anything. */
export function workspaceKey(ref: Ref): string {
  const key = refKey(ref);
  const safe = key.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 80);
  return `${safe}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`;
}

/** Every item branch starts with this. */
export const BRANCH_PREFIX = ITEM_BRANCH_PREFIX;

/** The branch a session works on for an item. */
export function workBranch(ref: Ref): string {
  const safe = ref.id.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "").replace(/\.{2,}/g, ".").slice(0, 60);
  return `${BRANCH_PREFIX}${safe || createHash("sha1").update(ref.id).digest("hex").slice(0, 8)}`;
}

/** Resolves symlinks in the part of the path that exists, so a link cannot smuggle a path past the checks. */
export function realish(path: string): string {
  let existing = resolve(path);
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync(existing);
  } catch {
    // Keep the unresolved path; the textual checks still apply.
  }
  return join(real, ...tail);
}

export class PathRefused extends Error {}

/** The worktree directory for a workspace key. Throws PathRefused when an invariant fails. */
export function workspacePath(config: ProjectConfig, key: string): string {
  if (key === "" || key === "." || key === ".." || /[\\/]/.test(key)) throw new PathRefused(`"${key}" is not a workspace name.`);
  const root = realish(config.workspacesDir);
  const path = realish(join(config.workspacesDir, key));
  if (!within(root, path) || path === root) throw new PathRefused(`${path} is not inside the workspaces directory ${root}.`);
  for (const real of config.realPaths) {
    const marked = realish(real);
    if (overlaps(marked, path)) throw new PathRefused(`${path} overlaps ${marked}, which is marked as real. Sessions never run there.`);
    if (within(marked, realish(config.repoPath))) throw new PathRefused(`The repository ${config.repoPath} is inside ${marked}, which is marked as real.`);
  }
  return path;
}
