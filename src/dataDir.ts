// Where `scopesoup start` keeps its database and streams: SCOPESOUP_DATA, else `<config folder>/data` of the config the command
// found (what `scopesoup open` uses), else `./data` when there is no config. A folder inside a git working tree is refused: the
// database would land in a clone, where a clean or a checkout can take it, and a commit can pick it up.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

type Env = Record<string, string | undefined>;

export type DataDir = { ok: true; dir: string } | { ok: false; error: string };

/** The nearest folder at or above `path` that exists. */
function existingFolder(path: string): string {
  let here = resolve(path);
  while (!existsSync(here)) {
    const up = dirname(here);
    if (up === here) break;
    here = up;
  }
  return here;
}

/** The top of the git working tree that holds `dir` (which need not exist yet), or null when none does. Ignore rules do not matter: a clean -fdx takes ignored files too. */
export function workingTreeOf(dir: string): string | null {
  const cwd = existingFolder(dir);
  try {
    const git = (...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    return git("rev-parse", "--is-inside-work-tree") === "true" ? git("rev-parse", "--show-toplevel") : null;
  } catch {
    return null; // no git, or not in a repository
  }
}

/** `configFile` is the file `findConfig` named, or null when no config was found. `inTree` is `workingTreeOf`, replaceable for tests. */
export function startDataDir(env: Env, configFile: string | null, inTree: (dir: string) => string | null = workingTreeOf): DataDir {
  const given = env.SCOPESOUP_DATA?.trim();
  const dir = resolve(given || (configFile ? join(dirname(configFile), "data") : "data"));
  const tree = inTree(dir);
  if (tree) {
    return { ok: false, error: `The data folder ${dir} is inside the git working tree ${tree}: the database would be kept in a clone. Set SCOPESOUP_DATA to a folder outside it (by default Scope Soup uses "data" beside scopesoup.config.json, which belongs outside the project's repository).` };
  }
  return { ok: true, dir };
}
