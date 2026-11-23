// What offboarding finds now, for the plan (`plan.ts`). It reads only: the manifest, this machine's file and the shared
// settings, `refs/scopesoup/*` and `scopesoup/*` branches on the remote (git ls-remote, and a fetch of those commits into Scope Soup's own
// clone to see which are merged), `scopesoup/*` branches in Scope Soup's clone and the pool clones, the project's files on the main
// branch, GitHub's labels and open pull requests (through a port), and folders on this machine. It never pushes, writes a ref
// (not even FETCH_HEAD: Scope Soup may be running), or changes a file. The person's own checkout (`ownClone`, `realPaths`) is never read or listed for removal.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isKnown, knownConfigsPath } from "../config/locate.ts";
import { manifestPath, readManifest, type ManifestEntry } from "../config/manifest.ts";
import { repositoryOf, validateFiles } from "../config/shared.ts";
import { overlaps } from "../config/validate.ts";
import { backupsOf } from "../config/write.ts";
import { META_REF, SETTINGS_FILE } from "../hosts/metaBranch/settings.ts";
import type { Git } from "../orchestrator/process.ts";
import type { Found, FoundBranch, FoundFolder, FoundLocalBranch, FoundPull } from "./plan.ts";
import { CLAUDE_MD, PLUGIN_SETTINGS, SECTION_HEADING, SETUP_SCRIPT, withoutPluginLines } from "./projectFiles.ts";

/** What offboarding reads and changes on GitHub. The real one is `github.ts`; tests give a fake. */
export interface OffboardGitHub {
  repo: string;
  labels(): Promise<string[]>;
  /** Open pull requests from a `scopesoup/*` branch of the repository itself. */
  pulls(): Promise<FoundPull[]>;
  deleteLabel(name: string): Promise<void>;
  closePull(number: number): Promise<void>;
}

/** The parts of this machine's configuration offboarding needs, read leniently: a configuration that no longer validates still offboards. */
export interface OffboardSetup {
  configFile: string;
  configFolder: string;
  repoPath: string;
  remote: string;
  mainBranch: string;
  /** The GitHub repository when the host is GitHub, or when the manifest says Scope Soup created labels there. */
  githubRepo: string | null;
  workspacesDir: string | null;
  streamsDir: string | null;
  /** The pool's project repositories (each clone with its project folder): the person's, but Scope Soup's branches may be in them. */
  pool: { clone: string; repo: string }[];
  /** Never removed: the person's own checkout and every real path. */
  protectedPaths: string[];
  manifest: ManifestEntry[];
  problems: string[];
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

async function ok(git: Git, args: string[], cwd: string): Promise<string | null> {
  const result = await git(args, cwd);
  return result.code === 0 ? result.stdout : null;
}

/** Reads this machine's file, the manifest and the shared settings (the remote's, fetched without writing a ref). */
export async function readSetup(configFile: string, git: Git): Promise<OffboardSetup> {
  const file = resolve(configFile);
  const configFolder = dirname(file);
  const problems: string[] = [];
  let privateRaw: unknown = {};
  try {
    privateRaw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const where = repositoryOf(privateRaw, configFolder);
  const manifest = readManifest(manifestPath(file));
  let sharedRaw: unknown = {};
  if (existsSync(where.repoPath)) {
    // The remote's meta commit, fetched without writing FETCH_HEAD or a ref: Scope Soup may be running and fetching in this clone.
    const remoteMeta = (await ok(git, ["ls-remote", where.remote, META_REF], where.repoPath))?.trim().split(/\s+/)[0];
    const fetched = remoteMeta ? await git(["fetch", "-q", "--no-tags", "--no-write-fetch-head", where.remote, META_REF], where.repoPath) : null;
    const from = remoteMeta && fetched?.code === 0 ? remoteMeta : META_REF;
    const text = await ok(git, ["show", `${from}:${SETTINGS_FILE}`], where.repoPath);
    if (text !== null) {
      try {
        sharedRaw = JSON.parse(text);
      } catch {
        problems.push(`The shared settings on ${META_REF} are not valid JSON.`);
      }
    }
  } else problems.push(`Scope Soup's clone ${where.repoPath} is not there.`);
  // A remote that is a folder on this machine is never removed, whatever folder it is in.
  const remoteUrl = existsSync(where.repoPath) ? (await ok(git, ["remote", "get-url", where.remote], where.repoPath))?.trim() : undefined;
  const localRemote = remoteUrl && !/^[a-z+]+:\/\//i.test(remoteUrl) && !/^[^/\\]+@[^:]+:/.test(remoteUrl) && existsSync(resolve(where.repoPath, remoteUrl)) ? [resolve(where.repoPath, remoteUrl)] : [];
  const checked = validateFiles(privateRaw, sharedRaw, configFolder);
  const raw = isObj(privateRaw) ? privateRaw : {};
  const shared = isObj(sharedRaw) ? sharedRaw : {};
  const labelRepo = manifest.find((entry) => entry.kind === "label");
  if (checked.ok) {
    const config = checked.config;
    const pool = config.workspaces.kind === "pool" ? config.workspaces.paths.map((clone) => ({ clone, repo: join(clone, (config.workspaces as { projectSubdir: string }).projectSubdir) })) : [];
    return {
      configFile: file, configFolder, repoPath: config.repoPath, remote: config.remote, mainBranch: config.mainBranch,
      githubRepo: config.host?.kind === "github" ? config.host.repo : labelRepo?.kind === "label" ? labelRepo.repo : null,
      workspacesDir: config.workspacesDir, streamsDir: config.streamsDir, pool,
      protectedPaths: [...config.realPaths, ...(config.ownClone ? [config.ownClone] : []), ...localRemote],
      manifest, problems,
    };
  }
  problems.push(`The configuration does not validate, so only what it names plainly is used: ${checked.errors.slice(0, 3).join("; ")}`);
  const abs = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? resolve(configFolder, value) : null);
  const host = isObj(shared.host) ? shared.host : {};
  return {
    configFile: file, configFolder, repoPath: where.repoPath, remote: where.remote,
    mainBranch: typeof shared.mainBranch === "string" ? shared.mainBranch : "main",
    githubRepo: host.kind === "github" && typeof host.repo === "string" ? host.repo : labelRepo?.kind === "label" ? labelRepo.repo : null,
    workspacesDir: abs(raw.workspacesDir), streamsDir: abs(raw.streamsDir), pool: [],
    protectedPaths: [...(Array.isArray(raw.realPaths) ? raw.realPaths.flatMap((each) => (abs(each) ? [abs(each) as string] : [])) : []), ...(abs(raw.ownClone) ? [abs(raw.ownClone) as string] : []), ...localRemote],
    manifest, problems,
  };
}

/** `git cherry`: true when every commit of `tip` not on `main` has an equal change on it (merged, or merged as a rebased copy). */
async function mergedInto(git: Git, repo: string, main: string, tip: string): Promise<boolean> {
  const out = await ok(git, ["cherry", main, tip], repo);
  return out !== null && !out.split("\n").some((line) => line.startsWith("+"));
}

async function holdsWork(git: Git, repo: string): Promise<string | undefined> {
  const status = await ok(git, ["status", "--porcelain"], repo);
  if (status === null) return undefined;
  if (status.trim() !== "") return "changes not committed";
  const unpushed = await ok(git, ["rev-list", "-n", "1", "--branches", "--not", "--remotes"], repo);
  if (unpushed && unpushed.trim() !== "") return "commits on a branch that no remote has";
  return undefined;
}

const samePath = (a: string, b: string): boolean => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The `.v*` copies: `scopesoup.config.v<N>.json` beside the config file, `scopesoup.v<N>.sqlite` in each data folder. */
function copiesIn(configFile: string, dataDirs: string[]): string[] {
  const found = backupsOf(configFile);
  for (const dir of dataDirs) {
    try {
      for (const name of readdirSync(dir)) if (/^scopesoup\.v\d+\.sqlite(-wal|-shm)?$/i.test(name)) found.push(join(dir, name));
    } catch {
      // Not there.
    }
  }
  return found;
}

export interface ScanOptions {
  git: Git;
  /** GitHub, when the project is on it and a token is set. */
  github?: OffboardGitHub | null;
  /** SCOPESOUP_DATA as this machine runs Scope Soup, when known (the manifest records it at each start). */
  dataDir?: string;
  install: string;
  /** Scope Soup's home, whose list of configs may hold this config; null or absent: none. */
  home?: string | null;
}

export async function scan(setup: OffboardSetup, options: ScanOptions): Promise<Found & { mainSha: string | null }> {
  const { git } = options;
  const repo = setup.repoPath;
  const haveRepo = existsSync(repo);
  // The remote: Scope Soup's refs and branches.
  const remoteRefs: string[] = [];
  const heads = new Map<string, string>();
  let mainSha: string | null = null;
  const listed = haveRepo ? await ok(git, ["ls-remote", setup.remote], repo) : null;
  for (const line of (listed ?? "").split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (ref.startsWith("refs/scopesoup/")) remoteRefs.push(ref);
    else if (ref.startsWith("refs/heads/scopesoup/")) heads.set(ref.slice("refs/heads/".length), sha);
    else if (ref === `refs/heads/${setup.mainBranch}`) mainSha = sha;
  }
  remoteRefs.sort();
  // Bring those commits into Scope Soup's clone (no ref written), to tell merged from not.
  if (haveRepo && mainSha) await git(["fetch", "-q", "--no-tags", "--no-write-fetch-head", setup.remote, `refs/heads/${setup.mainBranch}`, ...[...heads.keys()].map((name) => `refs/heads/${name}`)], repo);
  const remoteBranches: FoundBranch[] = [];
  for (const [name, sha] of [...heads].sort(([a], [b]) => (a < b ? -1 : 1))) {
    remoteBranches.push({ name, sha, merged: mainSha !== null && (await mergedInto(git, repo, mainSha, sha)) });
  }
  // Local scopesoup/* branches that the remote does not have at the same commit.
  const localBranches: FoundLocalBranch[] = [];
  const repos = [...(haveRepo ? [repo] : []), ...setup.pool.map((each) => each.repo).filter((each) => existsSync(each))];
  for (const where of repos) {
    const out = await ok(git, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/scopesoup/"], where);
    const lines = (out ?? "").split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    if (where !== repo && mainSha) await git(["fetch", "-q", "--no-tags", "--no-write-fetch-head", setup.remote, `refs/heads/${setup.mainBranch}`], where);
    for (const line of lines) {
      const [name, sha] = line.trim().split(" ");
      // In Scope Soup's clone a branch the remote has at the same commit goes with the clone; a pool clone stays, so it is listed.
      if (!name || !sha || (where === repo && heads.get(name) === sha)) continue;
      localBranches.push({ repo: where, name, sha, onRemote: heads.has(name), merged: mainSha !== null && (await mergedInto(git, where, mainSha, sha)) });
    }
  }
  // GitHub.
  let github: Found["github"] = null;
  if (options.github) {
    try {
      github = { repo: options.github.repo, labels: await options.github.labels(), pulls: await options.github.pulls() };
    } catch (error) {
      github = { repo: options.github.repo, problem: error instanceof Error ? error.message : String(error) };
    }
  } else if (setup.githubRepo) github = { repo: setup.githubRepo, problem: "SCOPESOUP_GITHUB_TOKEN is not set" };
  // The project's files on the main branch.
  const projectFiles: Found["projectFiles"] = [];
  if (haveRepo && mainSha) {
    const show = (path: string) => ok(git, ["show", `${mainSha}:${path}`], repo);
    const instructions = await show(CLAUDE_MD);
    if (instructions !== null && instructions.split(/\r?\n/).some((line) => line.trimEnd() === SECTION_HEADING)) projectFiles.push({ path: CLAUDE_MD, change: "claude-md-section" });
    const plugin = await show(PLUGIN_SETTINGS);
    if (plugin !== null && withoutPluginLines(plugin) !== null) projectFiles.push({ path: PLUGIN_SETTINGS, change: "plugin-settings" });
    if ((await show(SETUP_SCRIPT)) !== null) projectFiles.push({ path: SETUP_SCRIPT, change: "setup-script" });
  }
  // Folders on this machine, the config folder last.
  const folders: FoundFolder[] = [];
  const add = (path: string, what: string, extra: Partial<FoundFolder> = {}) => {
    if (folders.some((each) => samePath(each.path, path))) return;
    const yours = setup.protectedPaths.some((each) => overlaps(each, path)) || overlaps(options.install, path);
    folders.push({ path, what, exists: existsSync(path), ...extra, ...(yours ? { yours: true } : {}) });
  };
  if (setup.workspacesDir && isDir(setup.workspacesDir)) {
    let held: string | undefined;
    for (const name of readdirSync(setup.workspacesDir)) {
      const path = join(setup.workspacesDir, name);
      if (existsSync(join(path, ".git"))) held ??= (await holdsWork(git, path)) ? `${name} has changes not committed or pushed` : undefined;
    }
    add(setup.workspacesDir, "Scope Soup's worktrees and the merge queue's clone", held ? { holdsWork: held } : {});
  }
  if (setup.streamsDir) {
    const wip = join(setup.streamsDir, "wip");
    const unfinished = isDir(wip) && readdirSync(wip).length > 0;
    add(setup.streamsDir, "the sessions' streams and saved leftovers", unfinished ? { holdsWork: "it keeps patches of unfinished work (wip)" } : {});
  }
  // The data folder: as given, as the manifest recorded it at a start, and the onboarding skill's `<config folder>/data`.
  const dataDirs = [
    ...(options.dataDir ? [options.dataDir] : []),
    ...setup.manifest.flatMap((entry) => (entry.kind === "folder" && entry.what.startsWith("the data folder") ? [entry.path] : [])),
    ...(isDir(join(setup.configFolder, "data")) ? [join(setup.configFolder, "data")] : []),
  ].filter((dir, index, all) => all.findIndex((other) => samePath(other, dir)) === index);
  for (const dir of dataDirs) add(dir, "the data folder (Scope Soup's database)");
  if (haveRepo) {
    const held = await holdsWork(git, repo);
    add(repo, "Scope Soup's clone of the project", held ? { holdsWork: held } : {});
  }
  for (const entry of setup.manifest) if (entry.kind === "folder") add(entry.path, entry.what);
  for (const each of setup.pool) folders.push({ path: each.clone, what: "a clone of the pool", exists: existsSync(each.clone), yours: true });
  folders.push({ path: setup.configFolder, what: `the config folder (this machine's settings, the manifest${dataDirs.some((dir) => overlaps(setup.configFolder, dir)) ? ", the data folder" : ""})`, exists: true, ...(setup.protectedPaths.some((each) => overlaps(each, setup.configFolder)) ? { yours: true } : {}) });

  return {
    configFolder: setup.configFolder,
    manifest: setup.manifest,
    remote: setup.remote,
    mainBranch: setup.mainBranch,
    remoteRefs,
    remoteBranches,
    localBranches,
    github,
    projectFiles,
    folders,
    copies: copiesIn(setup.configFile, dataDirs),
    install: options.install,
    registered: options.home && isKnown(options.home, setup.configFile) ? { home: options.home, list: knownConfigsPath(options.home), file: setup.configFile } : null,
    mainSha,
  };
}

/** The default export folder: beside the config folder, so it outlives it. */
export const defaultOutFolder = (configFolder: string): string => join(dirname(configFolder), `${basename(configFolder)}-offboard`);
