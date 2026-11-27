// An agent's leftover refs in Scope Soup's clone (decision 126, rule I2). Implementors are told to keep everything on their branch
// (prompts/implement.md); what is left anyway is swept once its Item is closed and no job or session of this machine has it.
//
// A ref is an agent's only when its name says so, since the clone may be a person's own (I6):
// - a branch `scopesoup/<id>-...` or `scopesoup/<id>/...` (not any Item's own branch);
// - a tag `scopesoup/<id>`, `scopesoup/<id>-...` or `scopesoup/<id>/...`;
// - a stash entry made on `scopesoup/<id>` (its message says "On <branch>:" or "WIP on <branch>:").
// Nothing else is ever touched.
//
// Each is removed when nothing would be lost (all its commits are on the remote's main or the Item's branch as pushed, as last
// fetched), an event with the ref and its sha written first; one that holds work found nowhere else, or an annotated tag, is kept
// and reported once; one that cannot be judged now is reported once and tried again on later sweeps. Verdicts are remembered, so a
// kept ref is not judged again.
//
// The same code runs over real git (`gitRefs`, in the runner) and over the simulator's fake git: only `RefGit` differs.

import type { WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import { workBranch } from "./paths.ts";
import type { Git } from "./process.ts";

/** The sweep's verdicts, by `ref@sha`. */
export const JUDGED_KEY = "orchestrator.leftovers_judged";
/** The most verdicts remembered; the oldest go first. */
const MAX_JUDGED = 500;
const ACTOR = "orchestrator";

export interface StashEntry {
  sha: string;
  /** The branch it was made on, from its message; null on a detached HEAD or a message that names none. */
  branch: string | null;
}

export interface RefInfo {
  sha: string;
  /** An annotated tag: kept, it may be a release or a note someone wants. */
  annotated: boolean;
}

/** What the sweep reads and changes in the clone. Every call may throw: a ref that cannot be judged or removed stays. */
export interface RefGit {
  /** Local branches and tags, by full name (`refs/heads/...`, `refs/tags/...`). */
  refs(): Promise<Map<string, RefInfo>>;
  /** Branches checked out in a worktree (full names): never removed. */
  checkedOut(): Promise<Set<string>>;
  stash(): Promise<StashEntry[]>;
  /** True when every commit `sha` holds is on the remote's main or on `branch` as pushed (as last fetched). */
  refSafe(sha: string, branch: string): Promise<boolean>;
  /** True when each change the stash entry holds (work tree, index, untracked files) is already on one of those, mode and content. */
  stashSafe(sha: string, branch: string): Promise<boolean>;
  /** Deletes the ref only while it still points at `sha`. */
  deleteRef(ref: string, sha: string): Promise<void>;
  /** Drops the stash entry with this sha, after reading its place again; false when it moved meanwhile (nothing dropped). */
  dropStash(sha: string): Promise<boolean>;
  /** The remote's main as last fetched: a ref kept while main was elsewhere is judged again (its work may have landed since, #238). */
  mainTip?(): Promise<string | null>;
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

type Verdict = "kept" | "unjudged" | "failed";
type Judged = Record<string, { verdict: Verdict; at: string; main?: string }>;

function loadJudged(store: Store): Judged {
  try {
    const value: unknown = JSON.parse(store.getValue(JUDGED_KEY) ?? "{}");
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Judged) : {};
  } catch {
    return {};
  }
}

const closed = (item: WorkItem): boolean => item.state === "done" || item.state === "abandoned";
/** What may follow the Item's branch name in a leftover's name. */
const SUFFIX = /^[-/]./;

/**
 * Sweeps the leftovers of every closed Item in the store that has no live work here. Returns how many refs were removed and kept
 * this time. A clone that cannot be read is swept next time.
 */
export async function sweepLeftovers(deps: SweepDeps): Promise<{ removed: number; kept: number }> {
  const { store, git, at, live } = deps;
  const liveItems = new Set(live.map((each) => each.item));
  const items = store.list<WorkItem>("work");
  const ownBranches = new Set([...items.map((item) => workBranch(item.ref)), ...live.map((each) => each.branch)].map((branch) => `refs/heads/${branch}`));
  const done = items.filter((item) => closed(item) && !liveItems.has(refKey(item.ref)));
  if (done.length === 0) return { removed: 0, kept: 0 };

  let refs: Map<string, RefInfo>;
  let checkedOut: Set<string>;
  let stash: StashEntry[];
  try {
    [refs, checkedOut, stash] = [await git.refs(), await git.checkedOut(), await git.stash()];
  } catch {
    return { removed: 0, kept: 0 };
  }

  const judged = loadJudged(store);
  let tip: string | null = null;
  try {
    tip = (await git.mainTip?.()) ?? null;
  } catch {
    tip = null;
  }
  let removed = 0;
  let kept = 0;
  /** Writes the event and the verdict in one transaction; a verdict of null forgets the ref. */
  const record = (id: string, verdict: Verdict | null, kind: string, item: string, data: Record<string, unknown>): void => {
    if (verdict) judged[id] = { verdict, at, ...(verdict === "kept" && tip ? { main: tip } : {}) };
    else delete judged[id];
    const ids = Object.keys(judged);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_JUDGED))) delete judged[old];
    store.tx(() => {
      store.setValue(JUDGED_KEY, JSON.stringify(judged));
      store.appendEvent({ kind, subject: item, actor: ACTOR, data }, at);
    });
  };

  const judge = async (item: string, ref: string, sha: string, what: string, how: { annotated?: boolean; safe: () => Promise<boolean>; remove: () => Promise<boolean>; restore: string }): Promise<void> => {
    const id = `${ref}@${sha}`;
    const before = judged[id]?.verdict;
    // Kept is judged again only once main moved (the work it holds may have merged since), and not reported again.
    const again = before === "kept" && !how.annotated && tip !== null && judged[id]?.main !== undefined && judged[id]!.main !== tip;
    if ((before === "kept" && !again) || before === "failed") return;
    if (how.annotated) {
      kept++;
      record(id, "kept", "orchestrator.leftover_kept", item, { ref, sha, reason: `${what} is an annotated tag, which may be a release or a note someone wants, so it is kept in Scope Soup's clone: git show ${sha}` });
      return;
    }
    let safe: boolean;
    try {
      safe = await how.safe();
    } catch (error) {
      // Tried again on the next sweep; reported once.
      if (before !== "unjudged") record(id, "unjudged", "orchestrator.leftover_unjudged", item, { ref, sha, reason: `${what} was left by the Item's agent and could not be judged (${message(error)}); it is kept, and looked at again later.` });
      return;
    }
    if (!safe) {
      if (again) {
        judged[id] = { ...judged[id]!, main: tip! };
        store.setValue(JUDGED_KEY, JSON.stringify(judged));
        return;
      }
      kept++;
      record(id, "kept", "orchestrator.leftover_kept", item, { ref, sha, reason: `${what} holds work found nowhere else (not on the main branch, nor on the Item's branch as pushed), so it is kept in Scope Soup's clone for a person to look at: git show ${sha}` });
      return;
    }
    // The sha is written before the ref goes, so it can be restored.
    record(id, null, "orchestrator.leftover_removed", item, { ref, sha, reason: `${what} was left by the Item's agent; everything on it is on the main branch or on the Item's branch as pushed, so it is removed. To restore it: ${how.restore}` });
    try {
      if (await how.remove()) removed++;
      else store.appendEvent({ kind: "orchestrator.leftover_not_removed", subject: item, actor: ACTOR, data: { ref, sha, reason: `${what} moved in the stash list while it was being removed, so nothing was dropped; it is tried again later.` } }, at);
    } catch (error) {
      record(id, "failed", "orchestrator.leftover_not_removed", item, { ref, sha, reason: `${what} could not be removed (${message(error)}); it stays, and is not tried again.` });
    }
  };

  for (const work of done) {
    const item = refKey(work.ref);
    const branch = workBranch(work.ref);
    for (const [ref, info] of refs) {
      const isBranch = ref.startsWith(`refs/heads/${branch}`) && SUFFIX.test(ref.slice(`refs/heads/${branch}`.length));
      const tag = `refs/tags/${branch}`;
      const isTag = ref === tag || (ref.startsWith(tag) && SUFFIX.test(ref.slice(tag.length)));
      if ((!isBranch && !isTag) || ownBranches.has(ref) || checkedOut.has(ref)) continue;
      const what = `The ${isTag ? "tag" : "branch"} ${ref.replace(/^refs\/(heads|tags)\//, "")} (${info.sha.slice(0, 12)})`;
      await judge(item, ref, info.sha, what, {
        annotated: isTag && info.annotated, safe: () => git.refSafe(info.sha, branch), remove: async () => (await git.deleteRef(ref, info.sha), true), restore: `git update-ref ${ref} ${info.sha}`,
      });
    }
    for (const entry of stash) {
      if (entry.branch !== branch) continue;
      await judge(item, "refs/stash", entry.sha, `A stash entry made on ${branch} (${entry.sha.slice(0, 12)})`, {
        safe: () => git.stashSafe(entry.sha, branch), remove: () => git.dropStash(entry.sha), restore: `git stash store -m "restored" ${entry.sha}`,
      });
    }
  }
  return { removed, kept };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const STASH_SUBJECT = /^(?:WIP on|On) (.+?):/;
/** No git call of the sweep waits longer than this, and none asks for a password. */
const GIT_TIMEOUT_MS = 60_000;

/** `RefGit` over real git, in the clone at `repo`. Main and pushed branches are read from the remote-tracking refs: nothing is fetched. */
export function gitRefs(git: Git, repo: string, remote: string, mainBranch: string): RefGit {
  const call = (args: string[]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`git ${args[0]} took longer than ${GIT_TIMEOUT_MS / 1000} s`)), GIT_TIMEOUT_MS);
    });
    return Promise.race([git(args, repo, undefined, { GIT_TERMINAL_PROMPT: "0" }), late]).finally(() => clearTimeout(timer));
  };
  const run = async (args: string[]): Promise<string> => {
    const result = await call(args);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
    return result.stdout;
  };
  const exists = async (rev: string): Promise<boolean> => (await call(["rev-parse", "--verify", "--quiet", rev])).code === 0;
  /** The remote's main and the Item's pushed branch, as there are. Main must be there: without it nothing can be told. */
  const tips = async (branch: string): Promise<string[]> => {
    const main = `refs/remotes/${remote}/${mainBranch}`;
    if (!(await exists(main))) throw new Error(`${main} is not there`);
    const pushed = `refs/remotes/${remote}/${branch}`;
    return [main, ...((await exists(pushed)) ? [pushed] : [])];
  };
  /** Mode and blob of each path at `rev` (a tree-ish); a path missing there is absent. */
  const entries = async (rev: string, paths: string[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    for (let index = 0; index < paths.length; index += 100) {
      const text = await run(["ls-tree", "-r", "-z", "--full-tree", rev, "--", ...paths.slice(index, index + 100).map((path) => `:(literal)${path}`)]);
      for (const line of text.split("\0")) {
        const match = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(line);
        if (match) out.set(match[3]!, `${match[1]} ${match[2]}`);
      }
    }
    return out;
  };
  const names = (text: string): string[] => text.split("\0").filter(Boolean);
  const stashShas = async (): Promise<string[]> => ((await exists("refs/stash")) ? (await run(["log", "-g", "--format=%H", "refs/stash"])).split("\n").map((line) => line.trim()).filter(Boolean) : []);
  return {
    async mainTip() {
      const main = `refs/remotes/${remote}/${mainBranch}`;
      return (await exists(main)) ? (await run(["rev-parse", main])).trim() : null;
    },
    async refs() {
      const text = await run(["for-each-ref", "--format=%(objectname) %(objecttype) %(refname)", "refs/heads", "refs/tags"]);
      const out = new Map<string, RefInfo>();
      for (const line of text.split("\n")) {
        const [sha, type, ...name] = line.trim().split(" ");
        if (sha && type && name.length > 0) out.set(name.join(" "), { sha, annotated: type === "tag" });
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
    async refSafe(sha, branch) {
      const count = await run(["rev-list", "--count", sha, "--not", ...(await tips(branch))]);
      return Number(count.trim()) === 0;
    },
    async stashSafe(sha, branch) {
      const against = await tips(branch);
      // The work tree (the entry itself) and the index (its second parent) against the commit it was made on; the untracked files
      // (a third parent, when there is one) in full.
      const parts = [
        { rev: sha, paths: names(await run(["diff", "--name-only", "-z", "--no-renames", `${sha}^1`, sha])) },
        { rev: `${sha}^2`, paths: names(await run(["diff", "--name-only", "-z", "--no-renames", `${sha}^1`, `${sha}^2`])) },
      ];
      if (await exists(`${sha}^3`)) parts.push({ rev: `${sha}^3`, paths: names(await run(["ls-tree", "-r", "-z", "--name-only", `${sha}^3`])) });
      for (const part of parts) {
        if (part.paths.length === 0) continue;
        const mine = await entries(part.rev, part.paths);
        const elsewhere = await Promise.all(against.map((tip) => entries(tip, part.paths)));
        // Every file on one of the tips as stashed (or absent there too, for a file the entry deletes).
        if (!elsewhere.some((there) => part.paths.every((path) => there.get(path) === mine.get(path)))) return false;
      }
      return true;
    },
    async deleteRef(ref, sha) {
      await run(["update-ref", "-d", ref, sha]);
    },
    async dropStash(sha) {
      const index = (await stashShas()).indexOf(sha);
      if (index < 0) return false;
      // Read the place again just before the drop: another program may have pushed or dropped an entry meanwhile.
      const now = await call(["rev-parse", "--verify", "--quiet", `refs/stash@{${index}}`]);
      if (now.code !== 0 || now.stdout.trim() !== sha) return false;
      await run(["stash", "drop", "--quiet", `stash@{${index}}`]);
      return true;
    },
  };
}
