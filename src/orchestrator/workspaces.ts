// Workspaces from a pool of clones. Git worktrees clash with submodules, so a project whose
// repository is a submodule of an outer repository lists full clones of the outer repository
// instead. An item claims a free clone, its sessions work in `<clone>/<projectSubdir>` (the
// project's own repository) on the item's branch, it keeps the clone across its steps, and the
// clone is free again when the item parked or merges.
//
// Scope Soup runs git only in the project's repository inside a clone, never in the outer one: not its
// branch, not its other submodules. Keeping the outer clones up to date is the developer's job.
//
// Which clone an item holds is kept in the store (one value, written with an event in the same
// transaction), so a restart finds it again.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectConfig } from "../config/types.ts";
import { overlaps, within } from "../config/validate.ts";
import type { Ref, Session } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import { BRANCH_PREFIX, PathRefused, realish, workspaceKey } from "./paths.ts";
import { slotPathFor } from "./slots.ts";
import { discardLeftovers, listLeftovers, recordLeftovers, TooLargeToRecord } from "./leftovers.ts";
import type { Discarded, Leftovers, Recorded } from "./leftovers.ts";
import type { Git, ProcessControl } from "./process.ts";
import { baseRef } from "./worktree.ts";

export const HOLDINGS_KEY = "orchestrator.workspaces";
const ACTOR = "orchestrator";

/** The clone an item works in. The record outlives the holding: the item's branch stays in that clone. */
export interface Holding {
  /** The item, as `refKey`. */
  item: string;
  /** The clone as configured: an entry of `workspaces.paths`. */
  clone: string;
  branch: string;
  /** True while the item holds the clone; false once it was freed. */
  held: boolean;
  /** When it was last taken or freed. */
  at: string;
}

/** By workspace key (see `workspaceKey`). */
export type Holdings = Record<string, Holding>;

/** The last record that could be read, written with every change; used while the record itself is unreadable. */
const LAST_GOOD_KEY = `${HOLDINGS_KEY}.last_good`;
/** The unreadable text an event was written about, so the event is written once. */
const REPORTED_KEY = `${HOLDINGS_KEY}.unreadable`;

function parseHoldings(text: string | null): Holdings | null {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Holdings) : null;
  } catch {
    return null;
  }
}

export interface HoldingsState {
  /** The record, or the last good one while it cannot be read (empty when there never was one). */
  holdings: Holdings;
  /** False when the stored record is not valid: nothing may be handed out then, and nothing is written. */
  readable: boolean;
}

export function readHoldings(store: Store): HoldingsState {
  const now = parseHoldings(store.getValue(HOLDINGS_KEY));
  if (now) return { holdings: now, readable: true };
  return { holdings: parseHoldings(store.getValue(LAST_GOOD_KEY)) ?? {}, readable: false };
}

export function loadHoldings(store: Store): Holdings {
  return readHoldings(store).holdings;
}

/** Writes one event when the record cannot be read (and one when it can be again). Returns whether it is readable. */
export function checkHoldings(store: Store, at: string): boolean {
  const state = readHoldings(store);
  const reported = store.getValue(REPORTED_KEY) ?? "";
  if (state.readable) {
    if (reported !== "") {
      store.tx(() => {
        store.setValue(REPORTED_KEY, "");
        store.appendEvent({ kind: "orchestrator.workspaces_readable", actor: ACTOR, data: { reason: "The record of which clone each item holds can be read again; clones are handed out again." } }, at);
      });
    }
    return true;
  }
  const text = store.getValue(HOLDINGS_KEY) ?? "";
  if (reported !== text) {
    store.tx(() => {
      store.setValue(REPORTED_KEY, text);
      store.appendEvent({
        kind: "orchestrator.workspaces_unreadable", actor: ACTOR,
        data: { reason: `The record of which clone each item holds (${HOLDINGS_KEY} in Scope Soup's database) is not valid JSON, so it could not be read. ${Object.keys(state.holdings).length > 0 ? "The last good copy stays in use for items that hold a clone. " : ""}No clone is handed out, and nothing is written to the record, until it is readable again.` },
      }, at);
    });
  }
  return false;
}

/** Changes the holdings and writes the event in one transaction. Does nothing, and returns false, while the record is unreadable. */
function commit(store: Store, at: string, change: (holdings: Holdings) => void, kind: string, subject: string, reason: string, data: Record<string, unknown>): boolean {
  let done = false;
  store.tx(() => {
    const state = readHoldings(store);
    if (!state.readable) return;
    change(state.holdings);
    const text = JSON.stringify(state.holdings);
    store.setValue(HOLDINGS_KEY, text);
    store.setValue(LAST_GOOD_KEY, text);
    store.appendEvent({ kind, subject, actor: ACTOR, data: { reason, ...data } }, at);
    done = true;
  });
  return done;
}

function pool(config: ProjectConfig): { paths: string[]; projectSubdir: string } {
  if (config.workspaces.kind !== "pool") throw new Error("The project does not use a pool of clones.");
  return config.workspaces;
}

export function samePath(a: string, b: string): boolean {
  return within(a, b) && within(b, a);
}

/**
 * The project's repository inside a clone of the pool. Throws PathRefused when the clone is not
 * in the pool, the subfolder leaves the clone (through a link, say), or either overlaps a real path.
 */
export function poolRepoPath(config: ProjectConfig, clone: string): string {
  const { paths, projectSubdir } = pool(config);
  if (!paths.some((entry) => samePath(entry, clone))) throw new PathRefused(`${clone} is not a clone of the pool.`);
  const root = realish(clone);
  const repo = realish(join(clone, projectSubdir));
  if (!within(root, repo)) throw new PathRefused(`${repo} is not inside the clone ${root}.`);
  for (const real of config.realPaths) {
    const marked = realish(real);
    if (overlaps(marked, root) || overlaps(marked, repo)) throw new PathRefused(`${repo} overlaps ${marked}, which is marked as real. Sessions never run there.`);
  }
  return repo;
}

/** Null when `repo` is the top of a git repository of its own (not a plain folder of the outer one), else why not. */
export async function notOwnRepository(git: Git, repo: string, projectSubdir: string): Promise<string | null> {
  if (!existsSync(repo)) return `${projectSubdir} is not there`;
  const top = await git(["rev-parse", "--show-toplevel"], repo);
  if (top.code !== 0) return `${projectSubdir} is not a git repository (${top.stderr.trim() || `code ${top.code}`})`;
  if (!samePath(realish(top.stdout.trim()), repo)) return `${projectSubdir} is not a repository of its own but a folder of ${top.stdout.trim()}`;
  return null;
}

/**
 * Uncommitted changes, as `git status --porcelain` lines. Ignored files do not count, and neither do
 * untracked files that match `workspaces.keep` (build output kept on purpose). A changed tracked file counts.
 */
export async function uncommitted(git: Git, repo: string, keep: string[] = []): Promise<string[]> {
  const status = await git(keep.length > 0 ? ["status", "--porcelain=v1", "-z", "--untracked-files=all"] : ["status", "--porcelain"], repo);
  if (status.code !== 0) throw new Error(`git status failed in ${repo}: ${status.stderr.trim()}`);
  if (keep.length === 0) return status.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "");
  const others = await git(["ls-files", "-z", "--others", "--exclude-standard", ...keep.map((pattern) => `--exclude=${pattern}`)], repo);
  if (others.code !== 0) throw new Error(`git ls-files failed in ${repo}: ${others.stderr.trim()}`);
  const counted = new Set(others.stdout.split("\0"));
  const lines: string[] = [];
  const entries = status.stdout.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] ?? "";
    if (entry === "") continue;
    // A rename or copy is followed by its old path.
    if (entry[0] === "R" || entry[0] === "C") index++;
    if (entry.startsWith("?? ") && !counted.has(entry.slice(3))) continue;
    lines.push(entry);
  }
  return lines;
}

function keepOf(config: ProjectConfig): string[] {
  return config.workspaces.kind === "pool" ? config.workspaces.keep ?? [] : [];
}

/** Operations a person may have paused in the repository; the file or folder each leaves under the git directory. */
const OPERATIONS: [file: string, what: string][] = [
  ["rebase-merge", "a rebase"], ["rebase-apply", "a rebase or a mailbox apply"], ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"], ["REVERT_HEAD", "a revert"], ["BISECT_LOG", "a bisect"],
];

/** Null, or the operation a person has under way in the repository (its tree may well be clean: a paused rebase). */
async function operationInProgress(git: Git, repo: string): Promise<string | null> {
  const found = await git(["rev-parse", ...OPERATIONS.flatMap(([file]) => ["--git-path", file])], repo);
  if (found.code !== 0) throw new Error(`git rev-parse --git-path failed in ${repo}: ${found.stderr.trim()}`);
  const paths = found.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  for (const [index, [file, what]] of OPERATIONS.entries()) {
    const path = paths[index];
    if (path !== undefined && existsSync(resolve(repo, path))) return `${what} is in progress (${file})`;
  }
  return null;
}

/** Null when Scope Soup may switch the repository to an item's branch, else why not: it is on something that looks like a person's own work. */
async function personsWork(git: Git, repo: string, mainBranch: string): Promise<string | null> {
  const current = await currentBranch(git, repo);
  if (current !== null) {
    return current === mainBranch || current.startsWith(BRANCH_PREFIX) ? null : `it is on the branch ${current}, which looks like a person's work`;
  }
  const contained = await git(["for-each-ref", "--contains", "HEAD", "--format=%(refname)", "refs/heads", "refs/remotes"], repo);
  if (contained.code !== 0) throw new Error(`git for-each-ref failed in ${repo}: ${contained.stderr.trim()}`);
  if (contained.stdout.trim() !== "") return null;
  const head = await git(["rev-parse", "--short", "HEAD"], repo);
  return `it is on a detached HEAD at ${head.stdout.trim() || "an unknown commit"} that no local or remote-tracking branch contains, which looks like a person's work`;
}

function listed(lines: string[]): string {
  return lines.slice(0, 5).map((line) => line.trim()).join(", ") + (lines.length > 5 ? `, and ${lines.length - 5} more` : "");
}

async function currentBranch(git: Git, repo: string): Promise<string | null> {
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo);
  return head.code === 0 ? head.stdout.trim() : null;
}

async function hasBranch(git: Git, repo: string, branch: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
}

export interface PoolDeps {
  store: Store;
  config: ProjectConfig;
  git: Git;
  /** ISO 8601. */
  at: string;
  /** To see that the root process of each of the item's sessions has ended. Without it a freed clone's leftovers are never discarded. */
  processes?: Pick<ProcessControl, "isAlive">;
  /** The most a record of discarded leftovers may copy. Default RECORD_CAP_BYTES; tests make it small. */
  recordCapBytes?: number;
  /** How one untracked file is removed. Default `rmSync`; tests make it fail. */
  removeFile?: (path: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Raised by `takeClone` when the item's work is recorded at a commit that no clone of the pool has. */
export class WorkNotFound extends Error {}

async function revParse(git: Git, repo: string, rev: string): Promise<string | null> {
  const found = await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], repo);
  return found.code === 0 ? found.stdout.trim() : null;
}

/**
 * Whether the repository holds the item's work at `head`: its branch points there, or (with no such
 * branch) it is on a detached HEAD there. "branch" when the branch is there, "detached" when only HEAD is.
 */
async function holdsHead(git: Git, repo: string, branch: string, head: string): Promise<"branch" | "detached" | null> {
  const tip = await revParse(git, repo, `refs/heads/${branch}`);
  if (tip !== null) return tip === head ? "branch" : null;
  if ((await currentBranch(git, repo)) !== null) return null;
  return (await revParse(git, repo, "HEAD")) === head ? "detached" : null;
}

/**
 * Gives the item a clone if it holds none. Returns null when it holds one now, or the reason it
 * must wait. A clone that is held, refused by a path check, not shaped as configured, or has
 * uncommitted changes in the project's repository is not handed out; it is left as it is.
 *
 * `head`: the item's newest revision, when its work is past implement. With no record of which
 * clone the item had (the store was rebuilt from the item's log), only a clone whose item branch,
 * or detached HEAD, is at that commit is the item's: it is taken, and no other. When no clone of
 * the pool has it, WorkNotFound is thrown.
 */
export async function takeClone(deps: PoolDeps, item: Ref, workspace: string, branch: string, head?: string): Promise<string | null> {
  const { store, config, git, at } = deps;
  const { paths, projectSubdir } = pool(config);
  const readable = checkHoldings(store, at);
  const before = loadHoldings(store);
  const mine = before[workspace];
  if (mine?.held) return null;
  if (!readable) return "the record of which clone each item holds cannot be read, so no clone is handed out until it can (see the event log)";
  const busy = Object.entries(before).filter(([key, holding]) => holding.held && key !== workspace).map(([, holding]) => holding.clone);
  // Rebuilt from the log: the clones that hold the item's newest revision.
  const owners = new Map<string, "branch" | "detached">();
  const seek = head && !mine ? head : undefined;
  if (seek) {
    for (const clone of paths) {
      try {
        const repo = poolRepoPath(config, clone);
        if (await notOwnRepository(git, repo, projectSubdir)) continue;
        const how = await holdsHead(git, repo, branch, seek);
        if (how) owners.set(clone, how);
      } catch {
        // Refused by a path check: not a place for the item's work.
      }
    }
    if (owners.size === 0) {
      throw new WorkNotFound(`no clone of the pool has ${item.id}'s newest revision ${seek.slice(0, 12)} on ${branch} or as its detached HEAD, so its work is not there to review or merge`);
    }
  }
  // The clone the item had before goes first: its branch is there.
  const order = mine ? [...paths.filter((clone) => samePath(clone, mine.clone)), ...paths.filter((clone) => !samePath(clone, mine.clone))] : paths;
  const refused: string[] = [];
  for (const clone of order) {
    if (busy.some((held) => samePath(held, clone))) continue;
    const own = owners.get(clone);
    // The item's work is in a known clone: no other clone is taken, so it never starts on a fresh branch.
    if (seek && !own) continue;
    let repo: string;
    try {
      repo = poolRepoPath(config, clone);
    } catch (error) {
      refused.push(`the clone ${clone} is refused: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const shape = await notOwnRepository(git, repo, projectSubdir);
    if (shape) {
      refused.push(`the clone ${clone} is refused: ${shape}`);
      continue;
    }
    const operation = await operationInProgress(git, repo);
    if (operation) {
      refused.push(`the clone ${clone} is refused: ${operation} in ${projectSubdir}, so a person is working there; it is left as it is`);
      continue;
    }
    const dirt = await uncommitted(git, repo, keepOf(config));
    if (dirt.length > 0) {
      refused.push(`the clone ${clone} is refused: it has uncommitted changes in ${projectSubdir} that belong to no item (${listed(dirt)}); it is left as it is`);
      continue;
    }
    // A detached HEAD at the item's own revision is the item's work, even when no branch contains it.
    const person = own === "detached" ? null : await personsWork(git, repo, config.mainBranch);
    if (person) {
      refused.push(`the clone ${clone} is refused: in ${projectSubdir} ${person}; it is left as it is`);
      continue;
    }
    // A branch of the item's name that this item did not make here is somebody's or an earlier run's: not continued on silently.
    // One at the item's newest revision is the item's own.
    if (!own && !(mine && samePath(mine.clone, clone)) && (await hasBranch(git, repo, branch))) {
      refused.push(`the clone ${clone} is refused: ${projectSubdir} already has a branch ${branch} that ${item.id} did not start there (old commits, a person's or an earlier run's); it is left as it is`);
      continue;
    }
    // The item moved to another clone: bring its branch along, so its work is not started over.
    if (mine && !samePath(mine.clone, clone) && !(await hasBranch(git, repo, branch))) {
      try {
        const from = poolRepoPath(config, mine.clone);
        if (await hasBranch(git, from, branch)) await git(["fetch", "--quiet", from, `+refs/heads/${branch}:refs/heads/${branch}`], repo);
      } catch {
        // The earlier clone is gone or refused: the branch starts again from the main branch.
      }
    }
    // Only HEAD holds the item's work: its branch is made there, so the work is not started again from the main branch.
    if (own === "detached" && seek) {
      const made = await git(["branch", branch, seek], repo);
      if (made.code !== 0) {
        refused.push(`the clone ${clone} is refused: ${branch} could not be made at ${seek.slice(0, 12)} (${made.stderr.trim()})`);
        continue;
      }
    }
    const key = refKey(item);
    let taken = false;
    commit(store, at, (holdings) => {
      // Nothing else may have taken it in the meantime.
      if (Object.entries(holdings).some(([other, holding]) => other !== workspace && holding.held && samePath(holding.clone, clone))) return;
      holdings[workspace] = { item: key, clone, branch, held: true, at };
      taken = true;
    }, "orchestrator.workspace_taken", key,
    `${item.id} took the clone ${clone}; its sessions work in ${repo} on ${branch}.${own ? ` The clone holds ${item.id}'s newest revision ${seek?.slice(0, 12)} (from the item's log), so it is the item's own.` : ""}${refused.length > 0 ? ` Passed over: ${refused.join("; ")}.` : ""}`,
    { workspace, clone, branch });
    if (taken) return null;
  }
  const held = busy.length;
  return `no clone of the pool is free (${held} of ${paths.length} held by items under way${refused.length > 0 ? `; ${refused.join("; ")}` : ""})`;
}

/** Raised by `prepareClone` when the item holds no clone and none is free. */
export class NoFreeClone extends Error {}

export interface PrepareSpec {
  item: Ref;
  workspace: string;
  branch: string;
  mainBranch: string;
  remote: string;
  onFetchFailed?: (reason: string) => void;
}

/**
 * Puts the project's repository in the item's clone on the item's branch and returns its path.
 * A branch that is not there yet is made from the remote's newest main, fetched first (as worktrees
 * do). A clone found on another branch with uncommitted changes is refused (PathRefused) and left as it is.
 */
export async function prepareClone(deps: PoolDeps, spec: PrepareSpec): Promise<string> {
  const { store, config, git } = deps;
  const { projectSubdir } = pool(config);
  let holding = loadHoldings(store)[spec.workspace];
  if (!holding?.held) {
    const wait = await takeClone(deps, spec.item, spec.workspace, spec.branch);
    if (wait) throw new NoFreeClone(`No clone to work in: ${wait}.`);
    holding = loadHoldings(store)[spec.workspace];
    if (!holding) throw new Error("The clone was taken but not recorded.");
  }
  const repo = poolRepoPath(config, holding.clone);
  const shape = await notOwnRepository(git, repo, projectSubdir);
  if (shape) throw new PathRefused(`The clone ${holding.clone} is refused: ${shape}.`);
  const current = await currentBranch(git, repo);
  if (current === spec.branch) return repo;
  const operation = await operationInProgress(git, repo);
  if (operation) throw new PathRefused(`The clone ${holding.clone} is refused: ${operation} in ${projectSubdir}, so a person is working there. It is left as it is.`);
  const dirt = await uncommitted(git, repo, keepOf(config));
  if (dirt.length > 0) {
    throw new PathRefused(
      `The clone ${holding.clone} has uncommitted changes in ${projectSubdir} that do not belong to ${spec.item.id} ` +
      `(it is on ${current ?? "a detached HEAD"}, not ${spec.branch}): ${listed(dirt)}. It is left as it is.`,
    );
  }
  const person = await personsWork(git, repo, spec.mainBranch);
  if (person) throw new PathRefused(`The clone ${holding.clone} is refused: in ${projectSubdir} ${person}. It is left as it is.`);
  let args: string[];
  if (await hasBranch(git, repo, spec.branch)) args = ["checkout", "--quiet", spec.branch];
  else {
    const fetch = await git(["fetch", "--quiet", spec.remote, `+refs/heads/${spec.mainBranch}:refs/remotes/${spec.remote}/${spec.mainBranch}`], repo);
    if (fetch.code !== 0) spec.onFetchFailed?.(fetch.stderr.trim() || `git fetch exited with code ${fetch.code}`);
    args = ["checkout", "--quiet", "-b", spec.branch, await baseRef(git, repo, spec.mainBranch, spec.remote)];
  }
  const result = await git(args, repo);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${repo}: ${result.stderr.trim()}`);
  return repo;
}

const LIVE: Session["status"][] = ["starting", "running", "stalled"];

/**
 * Null when the leftovers may be discarded, else why not. Reads only. The code cannot tell a
 * person's edits from a session's; what it checks is that the item holds the clone, that a session
 * of the item ran in it during this hold, that none is running (by its record and its root process:
 * processes that session started and left behind are not looked for), and that the repository is
 * where the item left it, with no operation of a person's under way.
 */
async function notOwnLeftovers(deps: PoolDeps, workspace: string, holding: Holding, repo: string): Promise<string | null> {
  const { store, config, git, processes } = deps;
  const state = readHoldings(store);
  const now = state.holdings[workspace];
  if (!state.readable) return "the record of which clone each item holds cannot be read";
  if (!now?.held || now.item !== holding.item || !samePath(now.clone, holding.clone) || now.branch !== holding.branch) {
    return `the record does not say that ${holding.item} holds the clone`;
  }
  if (!processes) return "there is no way to check that the item's sessions have ended";
  let ran = false;
  for (const session of store.list<Session>("session")) {
    if (refKey(session.subject) !== holding.item) continue;
    if (LIVE.includes(session.status) && !session.finishedAt) return `the session ${session.ref.id} of ${holding.item} is still running`;
    // Sessions since the item took this clone ran in it (an item holds one clone at a time). Only the root process is checked.
    if (session.pid !== undefined && session.startedAt >= holding.at) {
      ran = true;
      if (processes.isAlive(session.pid)) return `process ${session.pid} of the session ${session.ref.id} is still there`;
    }
  }
  if (!ran) return `no session of ${holding.item} ran in the clone since it was taken, so the changes are not a session's`;
  const branch = await currentBranch(git, repo);
  if (branch !== holding.branch) {
    const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], repo);
    const tip = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${holding.branch}`], repo);
    if (branch !== null || head.code !== 0 || tip.code !== 0 || head.stdout.trim() !== tip.stdout.trim()) {
      return `the project's repository is on ${branch ?? `a detached HEAD at ${head.stdout.trim().slice(0, 12) || "an unknown commit"}`}, not on ${holding.branch} or at its tip, so the changes may be a person's`;
    }
  }
  const operation = await operationInProgress(git, repo);
  if (operation) return `${operation}, so a person is working there`;
  // Real paths on both sides: a junction or a subst drive must not put the record into the clone.
  const records = realish(join(config.streamsDir, "discarded"));
  if (overlaps(realish(holding.clone), records) || overlaps(repo, records)) return `the record would be written inside the clone (${records})`;
  return null;
}

/**
 * Decision 34: when an item's clone is freed, the uncommitted changes in the project's repository
 * there are discarded, so the clone can be handed out again. Only when every check of
 * `notOwnLeftovers` holds, both before anything is written and again just before the discard; else
 * nothing is touched, an event says why, and the clone is passed over as before until a person
 * cleans it. Ignored files, `workspaces.keep`, nested repositories and the outer repository stay.
 * A full copy of what goes is first written to `<streamsDir>/discarded/<item>-<time>/`; when that
 * fails or would be too large, nothing goes. Afterwards one event says exactly what went and what was left.
 */
async function discardOwnLeftovers(deps: PoolDeps, workspace: string, holding: Holding): Promise<void> {
  const { store, config, git, at } = deps;
  const data = { workspace, clone: holding.clone, branch: holding.branch };
  const event = (kind: string, reason: string, extra: Record<string, unknown> = {}): void => {
    store.tx(() => store.appendEvent({ kind, subject: holding.item, actor: ACTOR, data: { reason, ...data, ...extra } }, at));
  };
  const untouched = (why: string, extra: Record<string, unknown> = {}): void => event("orchestrator.workspace_not_discarded",
    `The uncommitted changes in the clone ${holding.clone} were not discarded: ${why}. Nothing was touched; the clone is passed over until a person cleans it.`, extra);
  const keep = keepOf(config);
  let repo: string;
  let leftovers: Leftovers;
  let recorded: Recorded;
  try {
    repo = poolRepoPath(config, holding.clone);
    const shape = await notOwnRepository(git, repo, pool(config).projectSubdir);
    if (shape) return untouched(shape);
    // Clean, or only build output that is kept: nothing to do, nothing to say.
    if ((await uncommitted(git, repo, keep)).length === 0) return;
    const before = await notOwnLeftovers(deps, workspace, holding, repo);
    if (before) return untouched(before);
    leftovers = await listLeftovers(git, repo, keep);
    if (leftovers.unmerged.length > 0) return untouched(`there are conflicts in ${listed(leftovers.unmerged)}`);
    if (leftovers.tracked.length === 0 && leftovers.untracked.length === 0) {
      const kept = [...leftovers.keptTracked, ...leftovers.keptUntracked];
      return untouched(kept.length > 0
        ? `all of it is kept (a changed tracked file that matches workspaces.keep or an ignore pattern, a nested repository, or a link): ${listed(kept)}`
        : "only a nested submodule has changes, and submodules are not cleaned");
    }
    try {
      recorded = await recordLeftovers(git, repo, leftovers, join(config.streamsDir, "discarded"), { item: holding.item, clone: holding.clone, branch: holding.branch, at }, deps.recordCapBytes);
    } catch (error) {
      if (error instanceof TooLargeToRecord) return untouched(`the leftovers are too large to record (${error.message}), so a person must clean the clone`);
      return untouched(`the record of what would go could not be written or verified (${errorText(error)}), so a person must clean the clone`);
    }
    const again = await notOwnLeftovers(deps, workspace, holding, repo);
    if (again) return untouched(`${again} (checked again after a record was written to ${recorded.dir})`, { record: recorded.dir });
  } catch (error) {
    // Nothing was discarded yet: everything above only reads the repository.
    return untouched(errorText(error));
  }
  let done: Discarded;
  try {
    done = await discardLeftovers(git, repo, leftovers, recorded, deps.removeFile);
  } catch (error) {
    event("orchestrator.workspace_discard_failed",
      `Discarding the uncommitted changes in the clone ${holding.clone} failed partway (${errorText(error)}). Some of them may be gone: compare the clone with the full record in ${recorded.dir}. The clone is passed over until a person cleans it.`,
      { record: recorded.dir });
    return;
  }
  const shadowed = done.restored.filter((path) => leftovers.shadowed.includes(path));
  let remaining = "";
  try {
    const left = await uncommitted(git, repo, keep);
    if (left.length > 0) remaining = ` Still there, so the clone is passed over until a person cleans it: ${listed(left)}.`;
  } catch {
    // Only the wording of the event depends on it.
  }
  const kept = [...leftovers.keptTracked, ...leftovers.keptUntracked];
  const summary = `Discarded uncommitted changes in the clone ${holding.clone}, freed by ${holding.item}. ` +
    `Restored from HEAD: ${done.restored.length > 0 ? listed(done.restored) : "nothing"}` +
    (shadowed.length > 0 ? ` (of which taken out of the index and copied first: ${listed(shadowed)})` : "") + ". " +
    `Removed: ${done.removed.length > 0 ? listed(done.removed) : "nothing"}. ` +
    (done.left.length > 0 ? `Left as they are: ${done.left.slice(0, 5).map((entry) => `${entry.path} (${entry.why})`).join("; ")}${done.left.length > 5 ? `, and ${done.left.length - 5} more` : ""}. ` : "") +
    (kept.length > 0 ? `Kept: ${listed(kept)}. ` : "") +
    (done.recordError
      ? `A full copy is in ${recorded.dir}, but the record could not be finished (${done.recordError}): read discarded.json there for its state before restoring anything from it.`
      : `A full copy is in ${recorded.dir}: discarded.json there lists every path and what happened to it, and RESTORE.md says how to bring back what was discarded.`) + remaining;
  commit(store, at, () => undefined, "orchestrator.workspace_discarded", holding.item, summary, {
    ...data, record: recorded.dir, restored: done.restored.length, removed: done.removed.length, left: done.left.length, kept: kept.length,
  });
}

/**
 * Frees the item's clone. Uncommitted changes in the project's repository are first recorded and
 * discarded when `discardOwnLeftovers` allows it (a session of the item ran there, and so on). The repository is then left on a
 * detached HEAD at the item's last commit, so the branch can be deleted later.
 */
export async function releaseClone(deps: PoolDeps, workspace: string, reason?: string): Promise<void> {
  const { store, config, git, at } = deps;
  const holding = loadHoldings(store)[workspace];
  if (!holding?.held) return;
  await discardOwnLeftovers(deps, workspace, holding);
  try {
    const repo = poolRepoPath(config, holding.clone);
    if (!(await notOwnRepository(git, repo, pool(config).projectSubdir)) && (await currentBranch(git, repo)) === holding.branch) {
      await git(["checkout", "--quiet", "--detach"], repo);
    }
  } catch {
    // The clone is gone or refused now: it is freed all the same.
  }
  commit(store, at, (holdings) => {
    const entry = holdings[workspace];
    if (entry) holdings[workspace] = { ...entry, held: false, at };
  }, "orchestrator.workspace_freed", holding.item, reason ?? `The clone ${holding.clone} is free again.`, { workspace, clone: holding.clone, branch: holding.branch });
}

/** The project's repository in the clone that has the branch: the one the item holds, or held last. */
export function cloneRepoForBranch(store: Store, config: ProjectConfig, branch: string): string {
  const found = Object.values(loadHoldings(store)).find((holding) => holding.branch === branch);
  if (!found) throw new Error(`No clone of the pool has ${branch}.`);
  return poolRepoPath(config, found.clone);
}

/**
 * Deletes the branch in every clone of the pool that has it, and forgets the item's clone. A clone
 * that an item holds with the branch checked out is refused.
 */
export async function deleteBranchInPool(deps: PoolDeps, branch: string): Promise<void> {
  const { store, config, git, at } = deps;
  const { paths, projectSubdir } = pool(config);
  const holdings = loadHoldings(store);
  for (const clone of paths) {
    let repo: string;
    try {
      repo = poolRepoPath(config, clone);
    } catch {
      continue;
    }
    if (await notOwnRepository(git, repo, projectSubdir)) continue;
    if (!(await hasBranch(git, repo, branch))) continue;
    if ((await currentBranch(git, repo)) === branch) {
      if (Object.values(holdings).some((holding) => holding.held && samePath(holding.clone, clone))) {
        throw new Error(`${branch} is checked out in the clone ${clone}, which an item holds.`);
      }
      const detach = await git(["checkout", "--quiet", "--detach"], repo);
      if (detach.code !== 0) throw new Error(`git checkout --detach failed in ${repo}: ${detach.stderr.trim()}`);
    }
    const result = await git(["branch", "-D", branch], repo);
    if (result.code !== 0) throw new Error(`git branch -D ${branch} failed in ${repo}: ${result.stderr.trim()}`);
  }
  for (const [workspace, holding] of Object.entries(holdings)) {
    if (holding.branch !== branch || holding.held) continue;
    commit(store, at, (current) => void delete current[workspace], "orchestrator.workspace_forgotten", holding.item,
      `${branch} is deleted; the item no longer has a clone.`, { workspace, clone: holding.clone, branch });
  }
}

/**
 * Where the item's branch is checked out: the directory to run git in for its diff or its merge.
 * Worktrees: the reused worktree the item holds. Pool: the project's repository in the clone the item holds (or
 * held last, while its branch is there). Null when the item has none. Throws PathRefused when a
 * path check fails.
 */
export function itemRepository(store: Store, config: ProjectConfig, item: Ref): string | null {
  if (config.workspaces.kind === "pool") {
    const key = refKey(item);
    const found = Object.values(loadHoldings(store)).find((holding) => holding.item === key);
    return found ? poolRepoPath(config, found.clone) : null;
  }
  // The reused worktree the Item holds (or one an older Scope Soup made for it alone).
  const path = slotPathFor(store, config, workspaceKey(item));
  return path !== null && existsSync(join(path, ".git")) ? path : null;
}
