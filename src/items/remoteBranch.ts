// A person's hand-back is read from the project's remote. The Item's branch is fixed (`scopesoup/<item>`, `workBranch`);
// the person pushes it, and Scope Soup fetches it into the repository it works from and records its tip. The branch of the same
// name there, where the review and the merge look for it, is brought to that tip. A branch that is not on the remote, or
// has no commits beyond the main branch, is not handed back.

import type { Git } from "../orchestrator/process.ts";

/** How an Item's branch stands on the remote after a fetch. */
export type BranchOnRemote = { state: "missing" } | { state: "empty"; sha: string } | { state: "ready"; sha: string; ahead: number };

/** The project's remote, as the item commands read it. Errors (no remote, no network) are thrown with git's words. */
export interface RemoteBranches {
  /** The remote's name and its main branch, for the words and the commands to copy. */
  names(): { remote: string; mainBranch: string };
  /** Whether the remote has the branch now; nothing is fetched. */
  exists(branch: string): Promise<boolean>;
  /** Fetches the branch and the main branch, and says how the branch stands. */
  fetch(branch: string): Promise<BranchOnRemote>;
}

export interface RemoteWhere {
  /** The project's repository: the one Scope Soup works from. */
  repo: string;
  remote: string;
  mainBranch: string;
}

/** git may not ask for a password: a server has nobody to answer it. */
const QUIET = { GIT_TERMINAL_PROMPT: "0" };

const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ").slice(-400);

export function remoteBranches(git: Git, where: () => RemoteWhere): RemoteBranches {
  const commitOf = async (ref: string): Promise<string | undefined> => {
    const head = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], where().repo);
    const sha = head.stdout.trim();
    return head.code === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : undefined;
  };

  /**
   * The review and the merge read the branch of the same name in the repository, so it is brought to the remote's tip: made
   * when it is not there, moved forward when it is behind. Nothing here is lost: a branch with commits the remote does not
   * have, or one checked out in a worktree that would have to move, is refused with what to do.
   */
  const bringLocal = async (branch: string, sha: string, remote: string, repo: string): Promise<void> => {
    const local = await commitOf(`refs/heads/${branch}`);
    if (local === sha) return;
    if (local) {
      const behind = await git(["merge-base", "--is-ancestor", local, sha], repo);
      if (behind.code !== 0) throw new Error(`${branch} in ${repo} has commits that are not on ${remote}. Push them (git push ${remote} ${branch}), or delete that branch there if they are not wanted`);
      const listed = await git(["worktree", "list", "--porcelain"], repo);
      const lines = listed.stdout.split(/\r?\n/);
      const at = lines.findIndex((line) => line === `branch refs/heads/${branch}`);
      if (at >= 0) {
        const path = lines.slice(0, at).reverse().find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? repo;
        throw new Error(`${branch} is checked out in ${path}, behind ${remote}. Run git pull there, then hand back`);
      }
    }
    // Only from what was read just now: a branch that moved in between is not overwritten.
    const moved = await git(["update-ref", "-m", "Scope Soup: hand-back from the remote", `refs/heads/${branch}`, sha, local ?? "0".repeat(sha.length)], repo);
    if (moved.code !== 0) throw new Error(`could not set ${branch} in ${repo}: ${tail(moved.stderr)}`);
  };

  const exists = async (branch: string): Promise<boolean> => {
    const { repo, remote } = where();
    const listed = await git(["ls-remote", "--heads", remote, `refs/heads/${branch}`], repo, undefined, QUIET);
    if (listed.code !== 0) throw new Error(`could not reach ${remote}: ${tail(listed.stderr)}`);
    return listed.stdout.split(/\r?\n/).some((line) => line.split(/\s+/)[1] === `refs/heads/${branch}`);
  };
  return {
    names: () => {
      const { remote, mainBranch } = where();
      return { remote, mainBranch };
    },
    exists,
    async fetch(branch) {
      const { repo, remote, mainBranch } = where();
      if (!(await exists(branch))) return { state: "missing" };
      const tracking = `refs/remotes/${remote}/${branch}`;
      const fetched = await git(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${tracking}`, `+refs/heads/${mainBranch}:refs/remotes/${remote}/${mainBranch}`], repo, undefined, QUIET);
      if (fetched.code !== 0) throw new Error(`could not fetch ${branch} from ${remote}: ${tail(fetched.stderr)}`);
      const sha = await commitOf(tracking);
      if (!sha) throw new Error(`${branch} was fetched from ${remote} but cannot be read in ${repo}`);
      const ahead = await git(["rev-list", "--count", `refs/remotes/${remote}/${mainBranch}..${sha}`], repo);
      if (ahead.code !== 0) throw new Error(`could not compare ${branch} with ${remote}/${mainBranch}: ${tail(ahead.stderr)}`);
      const count = Number(ahead.stdout.trim());
      if (count === 0) return { state: "empty", sha };
      await bringLocal(branch, sha, remote, repo);
      return { state: "ready", sha, ahead: count };
    },
  };
}

/** A remote that answers from a function, for tests: `tip` says how each branch stands. Nothing runs git. */
export function fixedBranches(tip: (branch: string) => BranchOnRemote, names = { remote: "origin", mainBranch: "main" }): RemoteBranches & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    names: () => names,
    exists: async (branch) => tip(branch).state !== "missing",
    fetch: async (branch) => {
      fetched.push(branch);
      return tip(branch);
    },
  };
}
