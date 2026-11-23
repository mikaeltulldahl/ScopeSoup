// The project's history for the board: the newest commits of the main branch and the item branches,
// laid out as lanes, and one commit's message and files. Read with git, without a shell, in
// `repoPath`. Nothing is fetched: it shows what the clone has. Bounded to the newest commits.

import type { ProjectConfig } from "../config/types.ts";
import { layoutLanes } from "../core/graph.ts";
import type { CommitView, HistoryCommit, HistoryView } from "../core/views.ts";
import type { Ref } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { changedFiles } from "./diff.ts";
import { BRANCH_PREFIX, workBranch } from "./paths.ts";
import type { Git } from "./process.ts";
import { notOwnRepository, poolRepoPath } from "./workspaces.ts";

export const DEFAULT_COMMITS = 50;
export const MAX_COMMITS = 500;
/** Characters of a commit message that are returned. */
export const MAX_MESSAGE_CHARS = 20_000;
/** git's empty tree: the "parent" of a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface HistoryDeps {
  config: () => ProjectConfig;
  git: Git;
  now: () => Date;
  /** The items the board knows, to link branches and merged commits to them. */
  works: () => { ref: Ref }[];
}

export const isSha = (text: string) => /^[0-9a-f]{7,64}$/.test(text);

/**
 * The repositories to read: the project's own repository in every clone of the pool (the project
 * folder, not the outer repository), or `repoPath` without a pool.
 */
export async function historyRepos(config: ProjectConfig, git: Git): Promise<string[]> {
  if (config.workspaces.kind !== "pool") return [config.repoPath];
  const repos: string[] = [];
  for (const clone of config.workspaces.paths) {
    try {
      const repo = poolRepoPath(config, clone);
      if (!(await notOwnRepository(git, repo, config.workspaces.projectSubdir))) repos.push(repo);
    } catch {
      // A clone that is not usable has nothing to show.
    }
  }
  return repos;
}

interface Parsed {
  sha: string;
  parents: string[];
  author: string;
  at: string;
  subject: string;
  time: number;
}

/** Newest first, and every commit before its parents, among commits from several repositories. */
function newestFirst(commits: Parsed[]): Parsed[] {
  const known = new Map(commits.map((commit) => [commit.sha, commit]));
  const waiting = new Map<string, number>();
  for (const commit of commits) {
    for (const parent of commit.parents) if (known.has(parent)) waiting.set(parent, (waiting.get(parent) ?? 0) + 1);
  }
  const ready = commits.filter((commit) => !waiting.has(commit.sha));
  const out: Parsed[] = [];
  while (ready.length > 0) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) if (ready[i]!.time > ready[best]!.time) best = i;
    const commit = ready.splice(best, 1)[0]!;
    out.push(commit);
    for (const parent of commit.parents) {
      if (!known.has(parent)) continue;
      const left = (waiting.get(parent) ?? 0) - 1;
      if (left > 0) waiting.set(parent, left);
      else {
        waiting.delete(parent);
        ready.push(known.get(parent)!);
      }
    }
  }
  return out;
}

export async function projectHistory(deps: HistoryDeps, requested: number): Promise<HistoryView> {
  const at = deps.now().toISOString();
  const none = (reason: string): HistoryView => ({ now: at, available: false, reason });
  const config = deps.config();
  const { git } = deps;
  const limit = Math.min(MAX_COMMITS, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_COMMITS));
  const repos = await historyRepos(config, git);
  if (repos.length === 0) return none("No clone of the pool has the project's own repository to show.");

  const tips = new Map<string, string[]>();
  const onMain = new Set<string>();
  const seen = new Map<string, Parsed>();
  let failure: string | null = null;
  let found = 0;
  for (const repo of repos) {
    let main: string | null = null;
    for (const name of [`refs/remotes/${config.remote}/${config.mainBranch}`, `refs/heads/${config.mainBranch}`]) {
      if ((await git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], repo)).code === 0) {
        main = name;
        break;
      }
    }
    if (!main) continue;
    found++;

    // Branches: the item branches, local and as last fetched.
    const branches = await git(["for-each-ref", "--format=%(objectname) %(refname)", `refs/heads/${BRANCH_PREFIX}`, `refs/remotes/${config.remote}/${BRANCH_PREFIX}`], repo);
    const branchTips: { sha: string; name: string }[] = [];
    for (const line of branches.stdout.split("\n")) {
      const match = /^([0-9a-f]+) refs\/(?:heads|remotes\/[^/]+)\/(.+)$/.exec(line.trim());
      if (match) branchTips.push({ sha: match[1]!, name: match[2]! });
    }
    const mainTip = (await git(["rev-parse", main], repo)).stdout.trim();
    const named: [string, string][] = [[mainTip, config.mainBranch], ...branchTips.map((tip): [string, string] => [tip.sha, tip.name])];
    for (const [sha, name] of named) tips.set(sha, [...new Set([...(tips.get(sha) ?? []), name])]);

    // One more than asked for, to know whether there is more.
    const log = await git(
      ["log", "--topo-order", `--max-count=${limit + 1}`, "--no-color", "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%ct%x1e", main, ...branchTips.map((tip) => tip.sha)],
      repo,
    );
    if (log.code !== 0) {
      failure = `git log failed: ${log.stderr.trim().slice(-300)}`;
      continue;
    }
    for (const record of log.stdout.split("\x1e")) {
      const [sha, parents, author, when, subject, time] = record.trim().split("\0");
      if (sha && /^[0-9a-f]+$/.test(sha) && !seen.has(sha)) {
        seen.set(sha, { sha, parents: (parents ?? "").split(" ").filter(Boolean), author: author ?? "", at: when ?? "", subject: subject ?? "", time: Number(time) || 0 });
      }
    }
    for (const sha of (await git(["rev-list", `--max-count=${limit}`, main], repo)).stdout.split("\n")) if (sha) onMain.add(sha);
  }
  if (found === 0) return none(`The repository has no ${config.mainBranch} branch to show.`);
  if (seen.size === 0 && failure) return none(failure);
  const ordered = repos.length === 1 ? [...seen.values()] : newestFirst([...seen.values()]);
  const parsed = ordered.map(({ time: _time, ...commit }) => commit);
  const more = parsed.length > limit;
  const shown = parsed.slice(0, limit);

  const itemOf = new Map(deps.works().map((work) => [workBranch(work.ref), work.ref]));
  const byId = new Map(deps.works().map((work) => [work.ref.id, work.ref]));
  const layout = layoutLanes(shown);
  const commits: HistoryCommit[] = shown.map((commit, index) => {
    const refs = tips.get(commit.sha) ?? [];
    const branchItem = refs.map((name) => itemOf.get(name)).find((ref) => ref !== undefined);
    const named = /\(#(\d+)\)\s*$/.exec(commit.subject);
    const mergedItem = named ? byId.get(named[1]!) : undefined;
    const item = branchItem ?? mergedItem;
    const isMain = onMain.has(commit.sha);
    return {
      ...commit,
      refs,
      onMain: isMain,
      ...(item ? { item: refKey(item) } : {}),
      ...(isMain && item ? { merged: true } : {}),
      graph: layout.rows[index]!,
    };
  });
  return { now: at, available: true, mainBranch: config.mainBranch, commits, lanes: layout.lanes, limit, more };
}

export async function commitView(deps: Pick<HistoryDeps, "config" | "git" | "now">, sha: string): Promise<CommitView> {
  const at = deps.now().toISOString();
  const none = (reason: string): CommitView => ({ now: at, available: false, reason });
  if (!isSha(sha)) return none("That is not a commit id.");
  const { git } = deps;
  let repo = "";
  let full = "";
  for (const candidate of await historyRepos(deps.config(), git)) {
    const resolved = await git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], candidate);
    if (resolved.code === 0 && resolved.stdout.trim() !== "") {
      repo = candidate;
      full = resolved.stdout.trim();
      break;
    }
  }
  if (full === "") return none("The repository has no such commit.");
  const message = await git(["show", "-s", "--no-color", "--format=%B", full], repo);
  const parent = await git(["rev-parse", "--verify", "--quiet", `${full}^1^{commit}`], repo);
  const base = parent.code === 0 && parent.stdout.trim() !== "" ? parent.stdout.trim() : EMPTY_TREE;
  const changed = await changedFiles(git, repo, base, full);
  if (!changed.ok) return none(changed.reason);
  return { now: at, available: true, sha: full, message: message.stdout.trim().slice(0, MAX_MESSAGE_CHARS), ...changed.value };
}
