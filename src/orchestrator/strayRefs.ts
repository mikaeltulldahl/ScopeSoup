// An agent's leftover refs in Scope Soup's own clone (decision 118, rule I2): stash entries, tags and branches it made and did not
// remove. Once its Item is closed and no job of this machine has it, each is removed when nothing would be lost (all its commits are on
// the remote's main or on the Item's branch as pushed), with an event naming the ref and its sha written first; one that holds work
// found nowhere else is kept and reported once, on the Item.
//
// Which refs are an Item's agent's:
// - a stash entry made on the Item's branch (its message says "On <branch>:" or "WIP on <branch>:");
// - a branch named after the Item's branch with a suffix (`scopesoup/12-extra`, `scopesoup/12/try`);
// - a tag or branch that was not there when the Item first took a worktree (its "baseline", noted then) and is no Item's branch.
// A ref that was there before (a person's), or that the remote has (a tag fetched meanwhile), is never an Item's. Nothing outside
// the clone is changed.
//
// The same code runs over real git (`gitRefs`, in the runner) and over the simulator's fake git: only `RefGit` differs.

import { renameSync, writeFileSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import { workBranch } from "./paths.ts";
import type { Git } from "./process.ts";

/** The baselines' file, in the clone's git folder. */
export const BASELINES_FILE = "scopesoup-ref-baselines.json";
export const REPORTED_KEY = "orchestrator.leftovers_reported";
const ACTOR = "orchestrator";

export interface StashEntry {
  sha: string;
  /** The branch it was made on, from its message; null on a detached HEAD or a message that names none. */
  branch: string | null;
}

/** What the sweep reads and changes in the clone. Every call may throw: a failed read keeps the ref. */
export interface RefGit {
  /** Local branches and tags, by full name (`refs/heads/...`, `refs/tags/...`), with the commit each points at. */
  refs(): Promise<Map<string, string>>;
  /** Branches checked out in a worktree (full names): never removed. */
  checkedOut(): Promise<Set<string>>;
  stash(): Promise<StashEntry[]>;
  /** True when the remote has a ref of this name (a tag fetched from it, say): it is not an agent's. */
  onRemote(ref: string): Promise<boolean>;
  /** True when every commit `sha` holds is on the remote's main or on `branch` as pushed; false when one is found nowhere else. */
  refSafe(sha: string, branch: string): Promise<boolean>;
  /** True when each change the stash entry holds is already on the remote's main or on `branch` as pushed. */
  stashSafe(sha: string, branch: string): Promise<boolean>;
  /** Deletes the ref only while it still points at `sha`. */
  deleteRef(ref: string, sha: string): Promise<void>;
  /** Drops the stash entry with this sha (found again by its sha first). */
  dropStash(sha: string): Promise<void>;
  /** The Items' baselines, kept with the clone (not in the store: a lost store must not make an agent's refs nobody's). */
  baselines(): Promise<Baselines>;
  saveBaselines(baselines: Baselines): Promise<void>;
}

/** Refs that were in the clone when the Item first took a worktree, by Item (`refKey`). */
export type Baselines = Record<string, string[]>;

function readJson<T extends object>(store: Store, key: string): T {
  try {
    const value: unknown = JSON.parse(store.getValue(key) ?? "{}");
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

/** Notes the refs in the clone for an Item that has no baseline yet: call it when the Item takes a worktree, before its session. */
export async function noteBaseline(git: RefGit, item: string): Promise<void> {
  const baselines = await git.baselines();
  if (baselines[item]) return;
  baselines[item] = [...(await git.refs()).keys()].sort();
  await git.saveBaselines(baselines);
}

/** A job of this machine (or a live session) on an Item: what it holds is never swept. */
export interface LiveWork {
  item: string;
  branch: string;
}

export interface SweepDeps {
  store: Store;
  git: RefGit;
  /** ISO 8601. */
  at: string;
  live: readonly LiveWork[];
}

const closed = (item: WorkItem | undefined): boolean => !item || item.state === "done" || item.state === "abandoned";
const SUFFIX = /^[-/._]/;

/**
 * Sweeps the leftovers of every Item that is closed (or gone from the store) and has no live work here. Returns how many refs were
 * removed and kept. Never throws for one ref: a ref that cannot be judged or removed stays.
 */
export async function sweepLeftovers(deps: SweepDeps): Promise<{ removed: number; kept: number }> {
  const { store, git, at, live } = deps;
  const liveItems = new Set(live.map((each) => each.item));
  const items = new Map(store.list<WorkItem>("work").map((item) => [refKey(item.ref), item]));
  // Each Item's own branch, and the live jobs' (a job's branch is its Item's, but read it from the job all the same).
  const itemBranches = new Map<string, string>();
  for (const [key, item] of items) itemBranches.set(key, workBranch(item.ref));
  const ownBranches = new Set([...itemBranches.values(), ...live.map((each) => each.branch)].map((branch) => `refs/heads/${branch}`));
  const done = (key: string): boolean => !liveItems.has(key) && closed(items.get(key));

  // Read the clone once. A clone that cannot be read is swept next time.
  let refs: Map<string, string>;
  let checkedOut: Set<string>;
  let stash: StashEntry[];
  let baselines: Baselines;
  try {
    [refs, checkedOut, stash, baselines] = [await git.refs(), await git.checkedOut(), await git.stash(), await git.baselines()];
  } catch {
    return { removed: 0, kept: 0 };
  }

  // Which closed Item each candidate belongs to.
  const claim = new Map<string, { item: string; branch: string; byName: boolean }>();
  const stashOf: { entry: StashEntry; item: string; branch: string }[] = [];
  for (const [key, branch] of itemBranches) {
    if (!done(key)) continue;
    const prefix = `refs/heads/${branch}`;
    for (const ref of refs.keys()) {
      if (ref.startsWith(prefix) && SUFFIX.test(ref.slice(prefix.length)) && !ownBranches.has(ref)) claim.set(ref, { item: key, branch, byName: true });
    }
    for (const entry of stash) if (entry.branch === branch) stashOf.push({ entry, item: key, branch });
  }
  for (const [key, before] of Object.entries(baselines)) {
    if (!done(key)) continue;
    const ref = items.get(key)?.ref;
    const branch = itemBranches.get(key) ?? (ref ? workBranch(ref) : null);
    if (!branch) continue;
    const had = new Set(before);
    for (const name of refs.keys()) {
      if (had.has(name) || ownBranches.has(name) || claim.has(name)) continue;
      if (!name.startsWith("refs/tags/") && !name.startsWith("refs/heads/")) continue;
      claim.set(name, { item: key, branch, byName: false });
    }
  }

  // A ref a live job's baseline does not have may be that job's agent's: it is removed when nothing is lost, but only that job's own
  // close reports it as kept.
  const liveBaselines = live.map((each) => baselines[each.item]).filter((each): each is string[] => !!each).map((each) => new Set(each));
  const maybeLive = (ref: string): boolean => liveBaselines.some((had) => !had.has(ref));
  const reported = readJson<Record<string, true>>(store, REPORTED_KEY);
  let removed = 0;
  let kept = 0;

  const keep = (item: string, ref: string, sha: string, what: string): void => {
    const id = `${ref}@${sha}`;
    if (reported[id]) return;
    reported[id] = true;
    kept++;
    store.tx(() => {
      store.setValue(REPORTED_KEY, JSON.stringify(reported));
      store.appendEvent({
        kind: "orchestrator.leftover_kept", subject: item, actor: ACTOR,
        data: { ref, sha, reason: `${what} holds work found nowhere else (not on the main branch, nor on the Item's branch as pushed), so it is kept in Scope Soup's clone for a person to look at: git show ${sha}` },
      }, at);
    });
  };
  const remove = async (item: string, ref: string, sha: string, what: string, restore: string, run: () => Promise<void>): Promise<void> => {
    // The sha is written before the ref goes, so it can be restored.
    store.appendEvent({ kind: "orchestrator.leftover_removed", subject: item, actor: ACTOR, data: { ref, sha, reason: `${what} was left by the Item's agent; everything on it is on the main branch or on the Item's branch as pushed, so it is removed. To restore it: ${restore}` } }, at);
    try {
      await run();
      removed++;
    } catch (error) {
      store.appendEvent({ kind: "orchestrator.action_failed", subject: item, actor: ACTOR, data: { reason: `Could not remove ${ref}: ${error instanceof Error ? error.message : String(error)}` } }, at);
    }
  };

  for (const [ref, owner] of claim) {
    const sha = refs.get(ref)!;
    if (checkedOut.has(ref)) continue;
    const kind = ref.startsWith("refs/tags/") ? "tag" : "branch";
    const name = ref.replace(/^refs\/(heads|tags)\//, "");
    const what = `The ${kind} ${name} (${sha.slice(0, 12)})`;
    let safe = false;
    try {
      // Found only by being new since the baseline: a tag fetched from the remote meanwhile is new too, and is not the agent's.
      if (!owner.byName && (await git.onRemote(ref))) continue;
      safe = await git.refSafe(sha, owner.branch);
    } catch {
      continue;
    }
    if (safe) await remove(owner.item, ref, sha, what, `git update-ref ${ref} ${sha}`, () => git.deleteRef(ref, sha));
    else if (owner.byName || !maybeLive(ref)) keep(owner.item, ref, sha, what);
  }
  for (const { entry, item, branch } of stashOf) {
    const what = `A stash entry made on ${branch} (${entry.sha.slice(0, 12)})`;
    let safe = false;
    try {
      safe = await git.stashSafe(entry.sha, branch);
    } catch {
      continue;
    }
    if (safe) await remove(item, "refs/stash", entry.sha, what, `git stash store -m "restored" ${entry.sha}`, () => git.dropStash(entry.sha));
    else keep(item, "refs/stash", entry.sha, what);
  }

  // The swept Items' baselines go; a closed Item that is reopened notes a new one when it takes a worktree again.
  const left = Object.fromEntries(Object.entries(baselines).filter(([key]) => !done(key)));
  if (Object.keys(left).length !== Object.keys(baselines).length) await git.saveBaselines(left).catch(() => undefined);
  return { removed, kept };
}

const STASH_SUBJECT = /^(?:WIP on|On) (.+?):/;

/** `RefGit` over real git, in the clone at `repo`. `remote` and `mainBranch` say where main is (as last fetched). */
export function gitRefs(git: Git, repo: string, remote: string, mainBranch: string): RefGit {
  const run = async (args: string[]): Promise<string> => {
    const result = await git(args, repo);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
    return result.stdout;
  };
  const exists = async (rev: string): Promise<boolean> => (await git(["rev-parse", "--verify", "--quiet", rev], repo)).code === 0;
  /** The remote's main and the Item's pushed branch, as there are. Main must be there: without it nothing can be told. */
  const tips = async (branch: string): Promise<string[]> => {
    const main = `refs/remotes/${remote}/${mainBranch}`;
    if (!(await exists(main))) throw new Error(`${main} is not there`);
    const pushed = `refs/remotes/${remote}/${branch}`;
    return [main, ...((await exists(pushed)) ? [pushed] : [])];
  };
  /** Blob ids of the paths at `rev`; a path missing there is absent. */
  const blobs = async (rev: string, paths: string[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    for (let index = 0; index < paths.length; index += 100) {
      const text = await run(["ls-tree", "-r", "-z", "--full-tree", rev, "--", ...paths.slice(index, index + 100).map((path) => `:(literal)${path}`)]);
      for (const line of text.split("\0")) {
        const match = /^\d+ \w+ ([0-9a-f]+)\t(.*)$/s.exec(line);
        if (match) out.set(match[2]!, match[1]!);
      }
    }
    return out;
  };
  /** In the clone's git folder, shared by its worktrees. */
  const baselineFile = async (): Promise<string> => {
    const dir = (await run(["rev-parse", "--git-common-dir"])).trim();
    return join(isAbsolute(dir) ? dir : join(repo, dir), BASELINES_FILE);
  };
  return {
    async refs() {
      const text = await run(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"]);
      const out = new Map<string, string>();
      for (const line of text.split("\n")) {
        const space = line.indexOf(" ");
        if (space > 0) out.set(line.slice(space + 1).trim(), line.slice(0, space));
      }
      return out;
    },
    async checkedOut() {
      const text = await run(["worktree", "list", "--porcelain"]);
      return new Set(text.split("\n").filter((line) => line.startsWith("branch ")).map((line) => line.slice("branch ".length).trim()));
    },
    async stash() {
      if (!(await exists("refs/stash"))) return [];
      const text = await run(["log", "-g", "--format=%H%x00%gs", "refs/stash"]);
      return text.split("\n").filter((line) => line.includes("\0")).map((line) => {
        const [sha, subject] = line.split("\0") as [string, string];
        const branch = STASH_SUBJECT.exec(subject)?.[1] ?? null;
        return { sha: sha.trim(), branch: branch && branch !== "(no branch)" ? branch : null };
      });
    },
    async onRemote(ref) {
      const result = await git(["ls-remote", "--exit-code", remote, ref], repo);
      if (result.code === 2) return false;
      if (result.code !== 0) throw new Error(`git ls-remote ${remote} ${ref} failed: ${result.stderr.trim()}`);
      return true;
    },
    async refSafe(sha, branch) {
      const count = await run(["rev-list", "--count", sha, "--not", ...(await tips(branch))]);
      return Number(count.trim()) === 0;
    },
    async stashSafe(sha, branch) {
      const against = await tips(branch);
      // The entry's files as stashed (the work tree, and the untracked ones when it has them) against the commit it was made on.
      const parts: { rev: string; paths: string[] }[] = [];
      const changed = (await run(["diff", "--name-only", "-z", "--no-renames", `${sha}^1`, sha])).split("\0").filter(Boolean);
      parts.push({ rev: sha, paths: changed });
      if (await exists(`${sha}^3`)) parts.push({ rev: `${sha}^3`, paths: (await run(["ls-tree", "-r", "-z", "--name-only", `${sha}^3`])).split("\0").filter(Boolean) });
      for (const part of parts) {
        if (part.paths.length === 0) continue;
        const mine = await blobs(part.rev, part.paths);
        const elsewhere = await Promise.all(against.map((tip) => blobs(tip, part.paths)));
        // Each file must be on one of the tips as stashed (or absent there too, for a file the entry deletes); one tip may hold all.
        const ok = elsewhere.some((there) => part.paths.every((path) => there.get(path) === mine.get(path)));
        if (!ok) return false;
      }
      return true;
    },
    async deleteRef(ref, sha) {
      await run(["update-ref", "-d", ref, sha]);
    },
    async baselines() {
      try {
        const value: unknown = JSON.parse(readFileSync(await baselineFile(), "utf8"));
        return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Baselines) : {};
      } catch {
        return {};
      }
    },
    async saveBaselines(baselines) {
      const file = await baselineFile();
      writeFileSync(`${file}.tmp`, JSON.stringify(baselines));
      renameSync(`${file}.tmp`, file);
    },
    async dropStash(sha) {
      const entries = (await run(["log", "-g", "--format=%H", "refs/stash"])).split("\n").map((line) => line.trim()).filter(Boolean);
      const index = entries.indexOf(sha);
      if (index < 0) throw new Error(`the stash entry ${sha} is not there any more`);
      await run(["stash", "drop", "--quiet", `stash@{${index}}`]);
    },
  };
}
