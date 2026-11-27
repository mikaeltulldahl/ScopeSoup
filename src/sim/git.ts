// The simulator's git: commits with the paths they touch, main on the remote, branches (local and remote), tags, the stash
// list and worktrees with their uncommitted and untracked files (rule group I). Who made each ref is kept, so the footprint
// rules can tell Scope Soup's own from a person's. `refGit` gives the leftover sweep (`src/orchestrator/strayRefs.ts`) the same view
// of it that real git gives.

import type { RefGit } from "../orchestrator/strayRefs.ts";

export interface Commit {
  sha: string;
  parents: string[];
  paths: string[];
  subject: string;
  /** "agent" (a session on an Item's branch), "person" (outside Scope Soup), "queue", "merge" (a session's merge to main). */
  by: string;
}

export interface Worktree {
  workspace: string;
  branch: string;
  /** Files changed and not committed. */
  dirty: string[];
  untracked: string[];
  detached: boolean;
  /** The Item the worktree was made for (refKey). */
  item: string;
}

/** A stash entry: a commit on the branch it was made on. `same`: a commit with the same changes, when the agent committed them too. */
export interface StashEntry {
  workspace: string;
  item: string;
  scopesoup: boolean;
  sha: string;
  branch: string;
  same?: string;
}

/** Who made a ref: Scope Soup (or its agents) for an Item, or someone else. */
export interface Owned {
  item?: string;
  scopesoup: boolean;
}

/** The pool of paths sessions and people touch, small so that overlaps happen. */
export const PATHS = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "docs/e.md", "test/f.ts"];

/**
 * What the clones of one project share: the commits (a sha names one commit everywhere), the remote's main and how it moved. One
 * clone makes its own; the multiplayer simulator (`multi.ts`) gives each machine's clone the same one.
 */
export class GitOrigin {
  commits = new Map<string, Commit>();
  main = "";
  mainMoves: { sha: string; how: string; item?: string }[] = [];
  count = 0;
}

export class FakeGit {
  origin: GitOrigin;
  commits: Map<string, Commit>;
  branches = new Map<string, string>();
  remoteBranches = new Map<string, string>();
  tags = new Map<string, string>();
  stash: StashEntry[] = [];
  worktrees = new Map<string, Worktree>();
  owners = new Map<string, Owned>();
  /** Refs deleted, with who asked: the footprint rules read it. */
  deleted: { ref: string; madeBy?: Owned; unmerged: boolean }[] = [];
  /** How each commit got onto main: "session told", "session untold", "queue", "person". */
  mainMoves: { sha: string; how: string; item?: string }[];

  /** The remote's main. */
  get main(): string {
    return this.origin.main;
  }

  set main(sha: string) {
    this.origin.main = sha;
  }

  constructor(origin?: GitOrigin) {
    this.origin = origin ?? new GitOrigin();
    this.commits = this.origin.commits;
    this.mainMoves = this.origin.mainMoves;
    if (this.origin.main === "") this.main = this.commit([], ["README.md"], "start", "person");
    // Things Scope Soup did not make, which it must never touch (I6).
    this.branches.set("feature/by-hand", this.main);
    this.owners.set("refs/heads/feature/by-hand", { scopesoup: false });
    this.tags.set("v1.0", this.main);
    this.owners.set("refs/tags/v1.0", { scopesoup: false });
    this.stash.push({ workspace: "/srv/clone", item: "", scopesoup: false, sha: this.commit([this.main], ["src/a.ts"], "WIP on main", "person"), branch: "main" });
  }

  sha(): string {
    this.origin.count++;
    return this.origin.count.toString(16).padStart(40, "0");
  }

  commit(parents: string[], paths: string[], subject: string, by: string): string {
    const sha = this.sha();
    this.commits.set(sha, { sha, parents, paths, subject, by });
    return sha;
  }

  /** Whether `ancestor` is `descendant` or reachable from it. */
  contains(ancestor: string, descendant: string): boolean | null {
    if (!this.commits.has(ancestor) || !this.commits.has(descendant)) return null;
    const seen = new Set<string>();
    const todo = [descendant];
    while (todo.length > 0) {
      const sha = todo.pop()!;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      todo.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return false;
  }

  /** The commits reachable from `tip` and not from `base`. */
  between(base: string, tip: string): Commit[] {
    const out: Commit[] = [];
    const seen = new Set<string>();
    const todo = [tip];
    while (todo.length > 0) {
      const sha = todo.pop()!;
      if (seen.has(sha) || this.contains(sha, base)) continue;
      seen.add(sha);
      const c = this.commits.get(sha);
      if (!c) continue;
      out.push(c);
      todo.push(...c.parents);
    }
    return out;
  }

  /** A person's (or another program's) commit on main, touching the paths. */
  outsideCommit(paths: string[]): string {
    this.main = this.commit([this.main], paths, `outside change to ${paths.join(", ")}`, "person");
    this.mainMoves.push({ sha: this.main, how: "person" });
    return this.main;
  }

  /** Merges a branch head into main (a merge commit), as a session or the queue does. */
  mergeToMain(head: string, how: string, item: string): string {
    this.main = this.commit([this.main, head], [], `merge ${item}`, how === "queue" ? "queue" : "merge");
    this.mainMoves.push({ sha: this.main, how, item });
    return this.main;
  }

  /** Makes the worktree, and the branch from main when it is not there. */
  ensureWorktree(workspace: string, branch: string, item: string): Worktree {
    if (!this.branches.has(branch)) {
      this.branches.set(branch, this.main);
      this.owners.set(`refs/heads/${branch}`, { item, scopesoup: true });
    }
    let tree = this.worktrees.get(workspace);
    if (!tree) {
      tree = { workspace, branch, dirty: [], untracked: [], detached: false, item };
      this.worktrees.set(workspace, tree);
      this.owners.set(`worktree:${workspace}`, { item, scopesoup: true });
    }
    return tree;
  }

  removeWorktree(workspace: string): void {
    this.worktrees.delete(workspace);
  }

  /** Whether every commit `sha` holds is on main or on `branch` as pushed. */
  safe(sha: string, branch: string): boolean {
    const pushed = this.remoteBranches.get(branch);
    return this.between(this.main, sha).every((c) => pushed !== undefined && this.contains(c.sha, pushed) === true);
  }

  /** Whether the stash entry's changes are on main or on `branch` as pushed. */
  stashSafe(entry: StashEntry, branch: string): boolean {
    if (!entry.same) return false;
    const pushed = this.remoteBranches.get(branch);
    return this.contains(entry.same, this.main) === true || (pushed !== undefined && this.contains(entry.same, pushed) === true);
  }

  /** The view of the clone the leftover sweep reads and changes, as real git gives it. */
  refGit(): RefGit {
    return {
      mainTip: async () => this.main,
      refs: async () => new Map([
        ...[...this.branches].map(([name, sha]) => [`refs/heads/${name}`, { sha, annotated: false }] as const),
        ...[...this.tags].map(([name, sha]) => [`refs/tags/${name}`, { sha, annotated: false }] as const),
      ]),
      checkedOut: async () => new Set([...this.worktrees.values()].filter((t) => !t.detached).map((t) => `refs/heads/${t.branch}`)),
      stash: async () => this.stash.map((entry) => ({ sha: entry.sha, branch: entry.branch })),
      refSafe: async (sha, branch) => this.safe(sha, branch),
      stashSafe: async (sha, branch) => {
        const entry = this.stash.find((each) => each.sha === sha);
        if (!entry) throw new Error(`no stash entry ${sha}`);
        return this.stashSafe(entry, branch);
      },
      deleteRef: async (ref, sha) => {
        const [map, name] = ref.startsWith("refs/tags/") ? [this.tags, ref.slice(10)] : [this.branches, ref.slice(11)];
        if (map.get(name) !== sha) throw new Error(`${ref} is not at ${sha}`);
        const madeBy = this.owners.get(ref);
        this.deleted.push({ ref, ...(madeBy ? { madeBy } : {}), unmerged: !this.safe(sha, `scopesoup/${madeBy?.item?.split(":").pop() ?? ""}`) });
        map.delete(name);
      },
      dropStash: async (sha) => {
        const index = this.stash.findIndex((each) => each.sha === sha);
        if (index < 0) return false;
        const entry = this.stash[index]!;
        this.deleted.push({ ref: "refs/stash", madeBy: { ...(entry.item ? { item: entry.item } : {}), scopesoup: entry.scopesoup }, unmerged: !this.stashSafe(entry, entry.branch) });
        this.stash.splice(index, 1);
        return true;
      },
    };
  }

  /** A person works in the clone: a tag, a branch and a stash entry of theirs, none named after an Item (I6). */
  personRefs(n: number): void {
    this.tags.set(`release-${n}`, this.main);
    this.owners.set(`refs/tags/release-${n}`, { scopesoup: false });
    this.branches.set(`person/try-${n}`, this.main);
    this.owners.set(`refs/heads/person/try-${n}`, { scopesoup: false });
    this.stash.push({ workspace: "/srv/clone", item: "", scopesoup: false, sha: this.commit([this.main], [], "WIP on main", "person"), branch: "main" });
  }

  deleteBranch(branch: string): void {
    const ref = `refs/heads/${branch}`;
    const sha = this.branches.get(branch);
    if (sha === undefined) return;
    const unmerged = this.contains(sha, this.main) === false;
    this.deleted.push({ ref, ...(this.owners.get(ref) ? { madeBy: this.owners.get(ref)! } : {}), unmerged });
    this.branches.delete(branch);
  }
}
