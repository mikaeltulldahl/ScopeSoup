// The simulator's git: commits with the paths they touch, main on the remote, branches (local and remote), tags, the stash
// list and worktrees with their uncommitted and untracked files (rule group I). Who made each ref is kept, so the footprint
// rules can tell Scope Soup's own from a person's.

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

/** Who made a ref: Scope Soup (or its agents) for an Item, or someone else. */
export interface Owned {
  item?: string;
  scopesoup: boolean;
}

/** The pool of paths sessions and people touch, small so that overlaps happen. */
export const PATHS = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "docs/e.md", "test/f.ts"];

export class FakeGit {
  commits = new Map<string, Commit>();
  /** The remote's main. */
  main: string;
  branches = new Map<string, string>();
  remoteBranches = new Map<string, string>();
  tags = new Map<string, string>();
  stash: { workspace: string; item: string; scopesoup: boolean }[] = [];
  worktrees = new Map<string, Worktree>();
  owners = new Map<string, Owned>();
  /** Refs deleted, with who asked: the footprint rules read it. */
  deleted: { ref: string; madeBy?: Owned; unmerged: boolean }[] = [];
  /** How each commit got onto main: "session told", "session untold", "queue", "person". */
  mainMoves: { sha: string; how: string; item?: string }[] = [];
  private count = 0;

  constructor() {
    this.main = this.commit([], ["README.md"], "start", "person");
    // Things Scope Soup did not make, which it must never touch (I6).
    this.branches.set("feature/by-hand", this.main);
    this.owners.set("refs/heads/feature/by-hand", { scopesoup: false });
    this.tags.set("v1.0", this.main);
    this.owners.set("refs/tags/v1.0", { scopesoup: false });
    this.stash.push({ workspace: "/srv/clone", item: "", scopesoup: false });
  }

  sha(): string {
    this.count++;
    return this.count.toString(16).padStart(40, "0");
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

  deleteBranch(branch: string): void {
    const ref = `refs/heads/${branch}`;
    const sha = this.branches.get(branch);
    if (sha === undefined) return;
    const unmerged = this.contains(sha, this.main) === false;
    this.deleted.push({ ref, ...(this.owners.get(ref) ? { madeBy: this.owners.get(ref)! } : {}), unmerged });
    this.branches.delete(branch);
  }
}
