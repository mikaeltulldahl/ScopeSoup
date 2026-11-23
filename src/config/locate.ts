// Which scopesoup.config.json a command reads. `--config` wins, then SCOPESOUP_CONFIG, then ./scopesoup.config.json in the folder
// the command runs in. Without any of them the config is found from the git repository the command runs in, matched against
// the configs this machine knows: a short list, `configs.json` in Scope Soup's home (src/upgrade/home.ts), that onboarding adds
// to (`scopesoup config:register <file>`) and offboarding takes the config off again.
//
// A config matches when the repository's top folder (for a worktree, its main repository's too) is the config's own clone
// (`ownClone`), Scope Soup's clone (`repoPath`) or one of its `realPaths`, or when the repository has a remote with the config's
// remote URL (`remoteUrl`, else the URL of `remote` in `repoPath`). No match, or more than one: the command says so and names
// `--config`. Every command that reads the config calls `findConfig`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnvironment } from "../hosts/metaBranch/git.ts";
import { homeOf } from "../upgrade/home.ts";
import { CONFIG_FILE } from "./loader.ts";
import { repositoryOf } from "./shared.ts";

type Env = Record<string, string | undefined>;

/** The list of configs this machine knows, in Scope Soup's home. */
export const KNOWN_CONFIGS = "configs.json";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Scope Soup's home: SCOPESOUP_HOME (the launcher sets it), else the home this release folder sits in; null for a development checkout. */
export function installHome(env: Env = process.env): string | null {
  const given = env.SCOPESOUP_HOME?.trim();
  if (given) return existsSync(given) ? resolve(given) : null;
  return homeOf(ROOT);
}

export const knownConfigsPath = (home: string): string => join(home, KNOWN_CONFIGS);

/** Paths compare as the OS does: case-insensitive on Windows, links followed when the path is there. */
function samePath(a: string, b: string): boolean {
  const norm = (path: string) => {
    let real = resolve(path);
    try {
      real = realpathSync.native(real);
    } catch {
      // Not there: compared as written.
    }
    return process.platform === "win32" ? real.replace(/\//g, "\\").toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

/** The configs on the list, as absolute paths; an unreadable list is an empty one. */
export function knownConfigs(home: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(knownConfigsPath(home), "utf8")) as { configs?: unknown };
    return Array.isArray(raw.configs) ? raw.configs.filter((path): path is string => typeof path === "string" && isAbsolute(path)) : [];
  } catch {
    return [];
  }
}

function writeKnown(home: string, configs: string[]): void {
  const path = knownConfigsPath(home);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ configs }, null, 2) + "\n");
  renameSync(temp, path);
}

/** Puts `file` on the list. Returns false when it was there already. */
export function registerConfig(home: string, file: string): boolean {
  const path = resolve(file);
  const configs = knownConfigs(home);
  if (configs.some((each) => samePath(each, path))) return false;
  writeKnown(home, [...configs, path]);
  return true;
}

/** Whether `file` is on the list. */
export const isKnown = (home: string, file: string): boolean => knownConfigs(home).some((each) => samePath(each, file));

/** Takes `file` off the list. Returns false when it was not on it. */
export function unregisterConfig(home: string, file: string): boolean {
  const configs = knownConfigs(home);
  const kept = configs.filter((each) => !samePath(each, file));
  if (kept.length === configs.length) return false;
  writeKnown(home, kept);
  return true;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: gitEnvironment() }).trim();
  } catch {
    return null;
  }
}

/** A remote URL as compared: no trailing slash or `.git`, forward slashes, no case. */
const urlKey = (url: string): string => url.trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();

/** The repository `cwd` is in: its top folder and its main repository's, and its remote URLs. Null outside a repository. */
function repositoryAt(cwd: string): { tops: string[]; urls: string[] } | null {
  const out = git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], cwd);
  if (!out) return null;
  const [top, common] = out.split(/\r?\n/);
  if (!top || !common) return null;
  const tops = [resolve(top), resolve(basename(common) === ".git" ? dirname(common) : common)];
  const urls = (git(["config", "--get-regexp", "^remote\\..*\\.url$"], top) ?? "").split(/\r?\n/).flatMap((line) => {
    const url = line.slice(line.indexOf(" ") + 1);
    return line.includes(" ") && url ? [urlKey(url)] : [];
  });
  return { tops, urls };
}

/** Whether the config `file` belongs to the repository `here`. */
function matches(file: string, here: { tops: string[]; urls: string[] }): boolean {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (typeof raw !== "object" || raw === null) return false;
  const folder = dirname(file);
  const at = (value: unknown): string[] => (typeof value === "string" && value.trim() !== "" ? [isAbsolute(value) ? resolve(value) : resolve(folder, value)] : []);
  const where = repositoryOf(raw, folder);
  const paths = [where.repoPath, ...at(raw.ownClone), ...(Array.isArray(raw.realPaths) ? raw.realPaths.flatMap(at) : [])];
  if (paths.some((path) => here.tops.some((top) => samePath(top, path)))) return true;
  const url = typeof raw.remoteUrl === "string" && raw.remoteUrl.trim() !== "" ? raw.remoteUrl : existsSync(where.repoPath) ? git(["remote", "get-url", where.remote], where.repoPath) : null;
  return url !== null && url !== "" && here.urls.includes(urlKey(url));
}

export type ConfigPath =
  | { ok: true; file: string; how: "option" | "environment" | "folder" | "repository" }
  /** `file` is ./scopesoup.config.json, for a command that can run without a config. */
  | { ok: false; file: string; error: string };

export interface FindOptions {
  /** `--config`, or a command's file argument. */
  given?: string | undefined;
  env?: Env;
  /** Where the command runs: relative paths, ./scopesoup.config.json and the git repository are this folder's. */
  cwd: string;
  /** Scope Soup's home; default `installHome(env)`. null: no list (a development checkout). */
  home?: string | null;
}

/** The config file a command reads (see the top of this file). */
export function findConfig(options: FindOptions): ConfigPath {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd);
  if (options.given) return { ok: true, file: resolve(cwd, options.given), how: "option" };
  if (env.SCOPESOUP_CONFIG) return { ok: true, file: resolve(cwd, env.SCOPESOUP_CONFIG), how: "environment" };
  const local = resolve(cwd, CONFIG_FILE);
  if (existsSync(local)) return { ok: true, file: local, how: "folder" };
  const give = "Give --config <path to scopesoup.config.json>, or set SCOPESOUP_CONFIG.";
  const fail = (why: string): ConfigPath => ({ ok: false, file: local, error: `${why} ${give}` });
  const here = repositoryAt(cwd);
  if (!here) return fail(`Which project? ${cwd} is not in a git repository, and has no ${CONFIG_FILE}.`);
  const home = options.home === undefined ? installHome(env) : options.home;
  if (!home) return fail(`Which project? This Scope Soup is not installed in a home with a list of configs (a development checkout), and ${cwd} has no ${CONFIG_FILE}.`);
  const found = knownConfigs(home).filter((file) => existsSync(file) && matches(file, here));
  if (found.length === 1) return { ok: true, file: found[0]!, how: "repository" };
  if (found.length === 0) return fail(`No config this machine knows (${knownConfigsPath(home)}) is for the repository at ${here.tops[0]}. Onboarding adds a project's config to the list (scopesoup config:register <file>).`);
  return fail(`More than one config this machine knows is for the repository at ${here.tops[0]}: ${found.join(", ")}.`);
}
