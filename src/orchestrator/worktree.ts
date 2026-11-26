// Git worktrees for sessions. Scope Soup makes and removes them itself; the agent never does.

import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Git } from "./process.ts";

export interface WorktreeSpec {
  repoPath: string;
  path: string;
  branch: string;
  /** The main branch and the remote it is fetched from before a new branch is made. */
  mainBranch: string;
  remote: string;
  /** Called with the reason when the fetch fails. The branch is then made from what is there. */
  onFetchFailed?: (reason: string) => void;
}

/** What new branches start from: the remote's main when it is there, else the local main. */
export async function baseRef(git: Git, repoPath: string, mainBranch: string, remote: string): Promise<string> {
  const tracking = `refs/remotes/${remote}/${mainBranch}`;
  const found = await git(["rev-parse", "--verify", "--quiet", tracking], repoPath);
  return found.code === 0 ? tracking : mainBranch;
}

/**
 * Moves the repository's local main branch to the remote's (as last fetched), so that nothing reading `git log main` in Scope
 * Soup's own clone sees a stale one. Only a ref is moved, never a working tree: a main checked out in any worktree is left, and so
 * is a main with commits that no other branch holds (a reset would lose them). Never throws. Returns why the branch was not moved,
 * or null when it is at the remote's main afterwards or there is nothing to move.
 */
export async function followRemoteMain(git: Git, repoPath: string, mainBranch: string, remote: string): Promise<string | null> {
  try {
    const local = `refs/heads/${mainBranch}`;
    const tracking = `refs/remotes/${remote}/${mainBranch}`;
    const was = await git(["rev-parse", "--verify", "--quiet", `${local}^{commit}`], repoPath);
    const target = await git(["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`], repoPath);
    if (was.code !== 0 || target.code !== 0 || was.stdout.trim() === target.stdout.trim()) return null;
    const listed = await git(["worktree", "list", "--porcelain"], repoPath);
    if (listed.stdout.split("\n").some((line) => line.trim() === `branch ${local}`)) {
      return `the local ${mainBranch} is checked out in a worktree, so it is left at ${was.stdout.trim().slice(0, 7)} while ${remote}/${mainBranch} is at ${target.stdout.trim().slice(0, 7)}`;
    }
    // Commits only main holds: any other branch or remote branch (the remote's main included) that has them makes the move lossless.
    const only = await git(["rev-list", "-1", local, "--not", tracking, `--exclude=${mainBranch}`, "--branches", "--remotes"], repoPath);
    if (only.code !== 0 || only.stdout.trim() !== "") {
      return `the local ${mainBranch} has commits that ${remote}/${mainBranch} and no other branch has, so it is left at ${was.stdout.trim().slice(0, 7)}`;
    }
    const moved = await git(["update-ref", "-m", `follow ${remote}/${mainBranch}`, local, target.stdout.trim(), was.stdout.trim()], repoPath);
    return moved.code === 0 ? null : `the local ${mainBranch} could not be moved: ${moved.stderr.trim()}`;
  } catch (error) {
    return `the local ${mainBranch} could not be moved: ${(error as Error).message}`;
  }
}

/**
 * Makes the worktree if it is not there. A branch that does not exist yet is created from the
 * remote's newest main (fetched first), or from the local main when there is no such ref.
 */
export async function ensureWorktree(git: Git, spec: WorktreeSpec): Promise<void> {
  if (existsSync(join(spec.path, ".git"))) return;
  mkdirSync(dirname(spec.path), { recursive: true });
  await git(["worktree", "prune"], spec.repoPath);
  const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${spec.branch}`], spec.repoPath)).code === 0;
  let args: string[];
  if (exists) args = ["worktree", "add", spec.path, spec.branch];
  else {
    const fetch = await git(["fetch", "--quiet", spec.remote, `+refs/heads/${spec.mainBranch}:refs/remotes/${spec.remote}/${spec.mainBranch}`], spec.repoPath);
    if (fetch.code !== 0) spec.onFetchFailed?.(fetch.stderr.trim() || `git fetch exited with code ${fetch.code}`);
    else await followRemoteMain(git, spec.repoPath, spec.mainBranch, spec.remote);
    const base = await baseRef(git, spec.repoPath, spec.mainBranch, spec.remote);
    args = ["worktree", "add", "-b", spec.branch, spec.path, base];
  }
  const result = await git(args, spec.repoPath);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
}

/** Removes the worktree and keeps the branch. Uncommitted work in it is lost. */
export async function removeWorktree(git: Git, repoPath: string, path: string): Promise<void> {
  if (existsSync(path)) {
    const result = await git(["worktree", "remove", "--force", path], repoPath);
    if (result.code !== 0) rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  }
  await git(["worktree", "prune"], repoPath);
}

/** Deletes the branch, after removing any other worktree that has it checked out. A missing branch is fine. */
export async function deleteBranch(git: Git, repoPath: string, branch: string): Promise<void> {
  await git(["worktree", "prune"], repoPath);
  const listed = await git(["worktree", "list", "--porcelain"], repoPath);
  let path = "";
  const holders: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.trim() === `branch refs/heads/${branch}`) holders.push(path);
  }
  const main = realpathSync(repoPath);
  for (const holder of holders) {
    if (realpathSync(holder) === main) throw new Error(`${branch} is checked out in the main clone ${repoPath}.`);
    await removeWorktree(git, repoPath, holder);
  }
  if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoPath)).code !== 0) return;
  const result = await git(["branch", "-D", branch], repoPath);
  if (result.code !== 0) throw new Error(`git branch -D ${branch} failed: ${result.stderr.trim()}`);
}

/** Paths that differ between the branch and where it left the base (see `baseRef`). */
export async function changedPaths(git: Git, repoPath: string, mainBranch: string, remote: string, branch: string): Promise<string[]> {
  const base = await baseRef(git, repoPath, mainBranch, remote);
  const result = await git(["diff", "--name-only", `${base}...${branch}`], repoPath);
  if (result.code !== 0) throw new Error(`git diff ${base}...${branch} failed: ${result.stderr.trim()}`);
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/** Each path the branch changes against where it left the base, with its changed lines (added plus removed; 0 for a binary file). */
export async function changeStat(git: Git, repoPath: string, mainBranch: string, remote: string, branch: string): Promise<{ path: string; lines: number }[]> {
  const base = await baseRef(git, repoPath, mainBranch, remote);
  const result = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", `${base}...${branch}`], repoPath);
  if (result.code !== 0) throw new Error(`git diff ${base}...${branch} failed: ${result.stderr.trim()}`);
  const files: { path: string; lines: number }[] = [];
  for (const record of result.stdout.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record.replace(/^\n/, ""));
    if (!match) continue;
    files.push({ path: match[3]!, lines: match[1] === "-" ? 0 : Number(match[1]) + Number(match[2]) });
  }
  return files;
}

/** How many commits the branch has that the base (see `baseRef`; the same base the prompts name) does not. Throws when the branch is not there. */
export async function commitsAhead(git: Git, repoPath: string, mainBranch: string, remote: string, branch: string): Promise<number> {
  const base = await baseRef(git, repoPath, mainBranch, remote);
  const result = await git(["rev-list", "--count", `${base}..refs/heads/${branch}`], repoPath);
  if (result.code !== 0) throw new Error(`git rev-list ${base}..${branch} failed: ${result.stderr.trim()}`);
  return Number(result.stdout.trim());
}

/**
 * Fetches the remote's main branch into its tracking ref (forced, so a rewritten main is seen as it is) and returns the
 * commit it points at. Throws when the fetch fails or the remote has no such branch.
 */
export async function fetchMain(git: Git, repoPath: string, mainBranch: string, remote: string): Promise<string> {
  const tracking = `refs/remotes/${remote}/${mainBranch}`;
  const fetched = await git(["fetch", "--quiet", remote, `+refs/heads/${mainBranch}:${tracking}`], repoPath);
  if (fetched.code !== 0) throw new Error(`git fetch ${remote} ${mainBranch} failed: ${fetched.stderr.trim() || `code ${fetched.code}`}`);
  await followRemoteMain(git, repoPath, mainBranch, remote);
  const found = await git(["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`], repoPath);
  if (found.code !== 0) throw new Error(`${remote} has no branch ${mainBranch}.`);
  return found.stdout.trim();
}

/**
 * Whether `ancestor` is `descendant` or one of its ancestors. Null when `ancestor` is not a commit in the repository
 * (a commit that history no longer reaches may have been pruned). Throws when git cannot tell otherwise.
 */
export async function isAncestor(git: Git, repoPath: string, ancestor: string, descendant: string): Promise<boolean | null> {
  if ((await git(["cat-file", "-e", `${ancestor}^{commit}`], repoPath)).code !== 0) return null;
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], repoPath);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant} failed: ${result.stderr.trim() || `code ${result.code}`}`);
}

/**
 * The commits in `since..until` that touch any of `paths`: the newest `max` (id and subject) and how many in all. Null
 * when `since` is not a commit in the repository. The paths come from an agent's answer and are passed after `--` only.
 */
export async function commitsTouching(git: Git, repoPath: string, since: string, until: string, paths: readonly string[], max: number): Promise<{ commits: { sha: string; subject: string }[]; count: number } | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(since) || !/^[0-9a-f]{7,64}$/i.test(until)) return null;
  if ((await git(["cat-file", "-e", `${since}^{commit}`], repoPath)).code !== 0) return null;
  const range = `${since}..${until}`;
  const counted = await git(["rev-list", "--count", range, "--", ...paths], repoPath);
  if (counted.code !== 0) throw new Error(`git rev-list ${range} failed: ${counted.stderr.trim() || `code ${counted.code}`}`);
  const count = Number(counted.stdout.trim()) || 0;
  if (count === 0) return { commits: [], count: 0 };
  const listed = await git(["log", `--max-count=${max}`, "--format=%H%x09%s", range, "--", ...paths], repoPath);
  if (listed.code !== 0) throw new Error(`git log ${range} failed: ${listed.stderr.trim() || `code ${listed.code}`}`);
  const commits = listed.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const tab = line.indexOf("\t");
    return tab < 0 ? { sha: line.trim(), subject: "" } : { sha: line.slice(0, tab), subject: line.slice(tab + 1).trim() };
  });
  return { commits, count };
}

/**
 * A squash merge: `commit` (as the session named it) is on the remote's main (`tip`), was not in main when the work
 * started (it descends from `base` and is not it), and has every file the branch changed over `base` exactly as the branch head
 * has it. Returns its full id, or null when any of that does not hold.
 */
export async function squashedOnMain(git: Git, repoPath: string, commit: string, base: string, head: string, tip: string): Promise<string | null> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return null;
  const found = await git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], repoPath);
  if (found.code !== 0) return null;
  const full = found.stdout.trim();
  if (full === base) return null;
  if ((await isAncestor(git, repoPath, full, tip)) !== true || (await isAncestor(git, repoPath, base, full)) !== true) return null;
  const changed = await git(["diff", "--name-only", "--no-renames", base, head], repoPath);
  if (changed.code !== 0) throw new Error(`git diff ${base} ${head} failed: ${changed.stderr.trim()}`);
  const paths = changed.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (paths.length === 0) return null;
  const same = await git(["diff", "--quiet", "--no-renames", head, full, "--", ...paths], repoPath);
  if (same.code === 0) return full;
  if (same.code === 1) return null;
  throw new Error(`git diff ${head} ${full} failed: ${same.stderr.trim() || `code ${same.code}`}`);
}
