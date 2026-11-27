// Worktrees reused across Items, like the pool of clones. With `workspaces.kind: "worktree"` Scope Soup keeps a few git worktrees
// of `repoPath` under `workspacesDir` (`slot-1`, `slot-2`, ...). An Item takes a free one, which is put on the Item's branch, keeps it
// across its steps, and frees it when it is parked or merges: its uncommitted edits are written to a patch, tracked files are reset,
// untracked files git does not ignore are removed, and HEAD is detached. Ignored files (installed dependencies, build output, the
// setup's record) stay, so the next Item in that worktree finds its setup done unless a watched file differs. A new worktree is made
// only when none is free, so there are as many as Items have been under way at once.
//
// Which worktree an Item holds is kept in the store (one value, written with an event in the same transaction). A worktree made
// per Item by an older Scope Soup (`<workspacesDir>/<workspace key>`) is still used and removed when the Item is parked, as before.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../config/types.ts";
import type { Ref } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import { PathRefused, workspacePath } from "./paths.ts";
import type { Git } from "./process.ts";
import { gitRefs, noteBaseline } from "./strayRefs.ts";
import { saveWip } from "./wip.ts";
import { baseRef, removeWorktree } from "./worktree.ts";

export const SLOTS_KEY = "orchestrator.worktree_slots";
const ACTOR = "orchestrator";
/** No more worktrees than this are ever made. */
const MAX_SLOTS = 100;

/** A reused worktree. The record outlives the holding, so the Item that held it last gets it back first. */
export interface Slot {
  /** The workspace (see `workspaceKey`) that holds it, or held it last. */
  workspace: string;
  /** The Item, as `refKey`. */
  item: string;
  branch: string;
  held: boolean;
  /** When it was last taken or freed. */
  at: string;
}

/** By the worktree's name (`slot-<n>`). */
export type Slots = Record<string, Slot>;

export function slotName(n: number): string {
  return `slot-${n}`;
}

export function loadSlots(store: Store): Slots {
  const text = store.getValue(SLOTS_KEY);
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Slots) : {};
  } catch {
    return {};
  }
}

function commit(store: Store, at: string, change: (slots: Slots) => void, kind: string, subject: string, reason: string, data: Record<string, unknown>): void {
  store.tx(() => {
    const slots = loadSlots(store);
    change(slots);
    store.setValue(SLOTS_KEY, JSON.stringify(slots));
    store.appendEvent({ kind, subject, actor: ACTOR, data: { reason, ...data } }, at);
  });
}

/** The name of the worktree the workspace holds, or null. */
export function heldSlot(store: Store, workspace: string): string | null {
  return Object.entries(loadSlots(store)).find(([, slot]) => slot.held && slot.workspace === workspace)?.[0] ?? null;
}

/** A worktree an older Scope Soup made for this workspace alone, when it is there. */
function legacyPath(config: ProjectConfig, workspace: string): string | null {
  try {
    const path = workspacePath(config, workspace);
    return existsSync(join(path, ".git")) ? path : null;
  } catch {
    return null;
  }
}

/**
 * Where the workspace's work is checked out now: the worktree it holds, or the one an older Scope Soup made for it. Null when it holds
 * none. Throws PathRefused when a path check fails.
 */
export function slotPathFor(store: Store, config: ProjectConfig, workspace: string): string | null {
  const name = heldSlot(store, workspace);
  if (name) return workspacePath(config, name);
  return legacyPath(config, workspace);
}

/** The worktree the workspace held last (held or freed since), or null. A chat turn resumes there (the agent CLI keeps a session per folder). */
export function lastSlotPath(store: Store, config: ProjectConfig, workspace: string): string | null {
  const name = Object.entries(loadSlots(store)).find(([, slot]) => slot.workspace === workspace)?.[0];
  return name ? workspacePath(config, name) : legacyPath(config, workspace);
}

/** The workspace that holds the worktree at `path` now, or null. */
export function holderOf(store: Store, config: ProjectConfig, path: string): Slot | null {
  for (const [name, slot] of Object.entries(loadSlots(store))) {
    try {
      if (slot.held && workspacePath(config, name) === path) return slot;
    } catch {
      // Refused by a path check: not a worktree a session runs in.
    }
  }
  return null;
}

export interface SlotDeps {
  store: Store;
  config: ProjectConfig;
  git: Git;
  /** ISO 8601. */
  at: string;
}

export interface SlotSpec {
  item: Ref;
  workspace: string;
  branch: string;
  mainBranch: string;
  remote: string;
  onFetchFailed?: (reason: string) => void;
}

async function currentBranch(git: Git, repo: string): Promise<string | null> {
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo);
  return head.code === 0 ? head.stdout.trim() : null;
}

async function hasBranch(git: Git, repo: string, branch: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
}

async function fetchMain(git: Git, repo: string, spec: SlotSpec): Promise<void> {
  const fetch = await git(["fetch", "--quiet", spec.remote, `+refs/heads/${spec.mainBranch}:refs/remotes/${spec.remote}/${spec.mainBranch}`], repo);
  if (fetch.code !== 0) spec.onFetchFailed?.(fetch.stderr.trim() || `git fetch exited with code ${fetch.code}`);
}

/** Takes a free worktree for the workspace: the one it held last first, then the lowest free one, else a new one. Returns its name. */
async function takeSlot(deps: SlotDeps, spec: SlotSpec): Promise<string> {
  const { store, config, git, at } = deps;
  const slots = loadSlots(store);
  const last = Object.entries(slots).find(([, slot]) => slot.workspace === spec.workspace && !slot.held)?.[0];
  const order = [...(last ? [last] : []), ...Array.from({ length: MAX_SLOTS }, (_, index) => slotName(index + 1)).filter((name) => name !== last)];
  const passed: string[] = [];
  for (const name of order) {
    if (slots[name]?.held) continue;
    const path = workspacePath(config, name);
    if (existsSync(join(path, ".git"))) {
      const status = await git(["status", "--porcelain"], path);
      if (status.code !== 0 || status.stdout.trim() !== "") {
        passed.push(`${name} has changes no Item holds (${status.code !== 0 ? status.stderr.trim() : status.stdout.trim().split("\n").slice(0, 3).join("; ")})`);
        continue;
      }
    } else if (existsSync(path)) {
      passed.push(`${path} is there but is not a worktree`);
      continue;
    }
    const key = refKey(spec.item);
    // The refs in the clone now: what the Item's agent leaves beyond them is its own (`strayRefs.ts`). Unread, no baseline is noted.
    await noteBaseline(gitRefs(git, config.repoPath, spec.remote, spec.mainBranch), key).catch(() => undefined);
    commit(store, at, (now) => {
      now[name] = { workspace: spec.workspace, item: key, branch: spec.branch, held: true, at };
    }, "orchestrator.worktree_taken", key,
    `${spec.item.id} took the worktree ${path}${name === last ? " it had before" : ""}; its sessions work there on ${spec.branch}.${passed.length > 0 ? ` Passed over: ${passed.join("; ")}.` : ""}`,
    { slot: name, workspace: spec.workspace, branch: spec.branch });
    return name;
  }
  throw new Error(`No worktree can be taken under ${config.workspacesDir}: ${passed.slice(0, 5).join("; ") || `all ${MAX_SLOTS} are held`}.`);
}

/**
 * Puts the workspace's worktree on the Item's branch and returns its path: the one it holds, or one taken now (made when it is not
 * there yet). A branch that is not there yet is made from the remote's newest main, fetched first.
 */
export async function prepareSlot(deps: SlotDeps, spec: SlotSpec): Promise<string> {
  const { store, config, git } = deps;
  // The workspace's name is checked as a folder name all the same: it names the patch of uncommitted edits, and older worktrees.
  workspacePath(config, spec.workspace);
  const legacy = legacyPath(config, spec.workspace);
  if (legacy && !heldSlot(store, spec.workspace)) return checkoutBranch(git, legacy, spec);
  const name = heldSlot(store, spec.workspace) ?? (await takeSlot(deps, spec));
  const path = workspacePath(config, name);
  let fetched = false;
  if (!existsSync(join(path, ".git"))) {
    if (existsSync(path)) throw new PathRefused(`${path} is there but is not a worktree; it is left as it is.`);
    mkdirSync(config.workspacesDir, { recursive: true });
    await git(["worktree", "prune"], config.repoPath);
    await fetchMain(git, config.repoPath, spec);
    const base = await baseRef(git, config.repoPath, spec.mainBranch, spec.remote);
    const made = await git(["worktree", "add", "--detach", path, base], config.repoPath);
    if (made.code !== 0) throw new Error(`git worktree add ${path} failed: ${made.stderr.trim()}`);
    fetched = true;
  }
  return checkoutBranch(git, path, spec, fetched);
}

async function checkoutBranch(git: Git, path: string, spec: SlotSpec, fetched = false): Promise<string> {
  if ((await currentBranch(git, path)) === spec.branch) return path;
  let args: string[];
  if (await hasBranch(git, path, spec.branch)) args = ["checkout", "--quiet", spec.branch];
  else {
    if (!fetched) await fetchMain(git, path, spec);
    args = ["checkout", "--quiet", "-b", spec.branch, await baseRef(git, path, spec.mainBranch, spec.remote)];
  }
  const result = await git(args, path);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${path}: ${result.stderr.trim()}`);
  return path;
}

/**
 * Frees the workspace's worktree. Its uncommitted edits go to `patch` first (a failure to write it keeps the worktree held),
 * then tracked files are reset, untracked files git does not ignore are removed and HEAD is detached; ignored files stay. A worktree
 * an older Scope Soup made for this workspace alone is removed, as it was then.
 */
export async function releaseSlot(deps: SlotDeps, workspace: string, patch: string, reason?: string): Promise<void> {
  const { store, config, git, at } = deps;
  const name = heldSlot(store, workspace);
  if (!name) {
    const legacy = legacyPath(config, workspace);
    if (legacy) {
      await saveWip(git, legacy, patch);
      await removeWorktree(git, config.repoPath, legacy);
    }
    return;
  }
  const path = workspacePath(config, name);
  if (existsSync(join(path, ".git"))) {
    await saveWip(git, path, patch);
    for (const args of [["reset", "--hard", "--quiet"], ["clean", "-fd", "--quiet"], ["checkout", "--quiet", "--detach"]]) {
      const result = await git(args, path);
      if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${path}: ${result.stderr.trim()}`);
    }
  }
  const slot = loadSlots(store)[name]!;
  commit(store, at, (slots) => {
    const entry = slots[name];
    if (entry) slots[name] = { ...entry, held: false, at };
  }, "orchestrator.worktree_freed", slot.item, reason ?? `The worktree ${path} is free again; its ignored files (installed dependencies, build output) stay for the next Item.`,
  { slot: name, workspace, branch: slot.branch });
}
