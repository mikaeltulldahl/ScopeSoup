// Builds a synthetic stand-in for a work setup: a bare remote for an outer repository
// and one for a small project, the project as a submodule of the outer one, a pool of two full
// clones of the outer repository, and a scopesoup.config.json for it. Names and content are made up.
//
//   pnpm standin <folder>
//
// The folder must not exist, or be empty. Nothing outside it is written.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSyncRetrying } from "./hosts/spawnRetry.ts";
import { CONFIG_VERSION } from "./config/migrate.ts";
import { metaSettings } from "./config/metaSettings.ts";

const SCOPESOUP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const STANDIN = {
  project: "tidy-units",
  outer: "harbour-tools",
  subdir: "libs/tidy-units",
  port: 4330,
  author: { name: "Scope Soup trial", email: "trial@example.invalid" },
};

export interface Standin {
  folder: string;
  configFile: string;
  dataDir: string;
  /** The bare remotes. */
  projectRemote: string;
  outerRemote: string;
  /** Scope Soup's own clone of the project; the meta ref is written there and pushed to the project's remote. */
  metaRepo: string;
  /** The two clones of the outer repository. */
  pool: string[];
}

/** Forward slashes: one spelling of each path for git, the configuration and both shells. */
function slashed(path: string): string {
  return path.replace(/\\/g, "/");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSyncRetrying("git", [
    "-c", `user.name=${STANDIN.author.name}`, "-c", `user.email=${STANDIN.author.email}`,
    "-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", "-c", "init.defaultBranch=main",
    ...args,
  ], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

const PROJECT_FILES: Record<string, string> = {
  "README.md": "# tidy-units\n\nA tiny library that converts lengths between metric units. Plain JavaScript, no dependencies.\n\nRun the tests with `node --test`.\n",
  "package.json": JSON.stringify({ name: "tidy-units", version: "0.1.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  ".gitattributes": "* text=auto eol=lf\n",
  ".gitignore": "node_modules/\n",
  "src/units.js": [
    "// Lengths, in metres per unit.",
    "const METRES = { mm: 0.001, cm: 0.01, m: 1, km: 1000 };",
    "",
    "/** The units this library knows. */",
    "export function units() {",
    "  return Object.keys(METRES);",
    "}",
    "",
    "/** Converts `value` from one unit to another, for example convert(1500, \"m\", \"km\") is 1.5. */",
    "export function convert(value, from, to) {",
    "  if (!(from in METRES)) throw new Error(`unknown unit: ${from}`);",
    "  if (!(to in METRES)) throw new Error(`unknown unit: ${to}`);",
    "  return (value * METRES[from]) / METRES[to];",
    "}",
    "",
  ].join("\n"),
  "test/units.test.js": [
    "import assert from \"node:assert/strict\";",
    "import { test } from \"node:test\";",
    "import { convert, units } from \"../src/units.js\";",
    "",
    "test(\"converts between metric lengths\", () => {",
    "  assert.equal(convert(1500, \"m\", \"km\"), 1.5);",
    "  assert.equal(convert(2, \"cm\", \"mm\"), 20);",
    "  assert.deepEqual(units(), [\"mm\", \"cm\", \"m\", \"km\"]);",
    "  assert.throws(() => convert(1, \"m\", \"furlong\"), /unknown unit/);",
    "});",
    "",
  ].join("\n"),
};

const OUTER_FILES: Record<string, string> = {
  "README.md": "# harbour-tools\n\nAn imaginary outer repository. The library tidy-units is a submodule under libs/.\n",
  ".gitattributes": "* text=auto eol=lf\n",
  ".gitignore": "node_modules/\n",
  "tools/harbour.txt": "Placeholder for the outer repository's own tools.\n",
};

/** The stand-in machine's private file: where the repository is, its local paths and what it may spend. */
export function standinConfig(projectRemote: string): Record<string, unknown> {
  return {
    version: CONFIG_VERSION,
    repoPath: "scopesoup-repo",
    remote: "origin",
    realPaths: [],
    keepAwake: true,
    machineName: "standin",
    workspacesDir: "data/workspaces",
    streamsDir: "data/streams",
    meta: { prefix: "A", authorName: STANDIN.author.name, authorEmail: STANDIN.author.email },
    workspaces: { kind: "pool", paths: ["pool/one", "pool/two"], projectSubdir: STANDIN.subdir },
    remoteUrl: projectRemote,
    settings: {
      maxParallelSessions: { value: 1, reason: "Trials run one session at a time." },
    },
  };
}

/** The stand-in project's shared settings, on the meta ref of its repository, next to its Items. */
export function standinShared(): Record<string, unknown> {
  const tools = ["Read", "Glob", "Grep", "Edit", "Write", "Bash(git *)", "Bash(node --test*)", "Bash(npm test*)"];
  return {
    project: STANDIN.project,
    mainBranch: "main",
    level: 4,
    host: { kind: "metaBranch", write: true },
    checkCommand: ["node", "--test"],
    settings: {
      checkTimeoutMinutes: { value: 5, reason: "The stand-in's check takes about a second." },
    },
    roles: {
      triage: { model: "haiku" },
      implement: { model: "haiku", allowedTools: tools },
      review: { model: "sonnet" },
    },
  };
}

/** Builds the stand-in in `folder`, which must not exist or be empty. */
export async function buildStandin(folderGiven: string): Promise<Standin> {
  const folder = resolve(folderGiven);
  if (existsSync(folder) && readdirSync(folder).length > 0) throw new Error(`${folder} exists and is not empty. Give an empty or new folder.`);
  const inside = relative(SCOPESOUP_ROOT, folder);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) throw new Error(`${folder} is inside Scope Soup's own checkout. Put the stand-in somewhere else.`);
  mkdirSync(folder, { recursive: true });

  const remotes = join(folder, "remotes");
  mkdirSync(remotes);
  const projectRemote = slashed(join(remotes, `${STANDIN.project}.git`));
  const outerRemote = slashed(join(remotes, `${STANDIN.outer}.git`));
  const seeds = join(folder, "seed");

  // The project, pushed to its bare remote.
  const seedProject = join(seeds, STANDIN.project);
  mkdirSync(seedProject, { recursive: true });
  git(seedProject, "init", "-q", "-b", "main");
  write(seedProject, PROJECT_FILES);
  git(seedProject, "add", ".");
  git(seedProject, "commit", "-q", "-m", "tidy-units: convert lengths, with a test");
  git(folder, "init", "-q", "--bare", "-b", "main", projectRemote);
  git(seedProject, "push", "-q", projectRemote, "main");

  // The outer repository, with the project as a submodule.
  const seedOuter = join(seeds, STANDIN.outer);
  mkdirSync(seedOuter, { recursive: true });
  git(seedOuter, "init", "-q", "-b", "main");
  write(seedOuter, OUTER_FILES);
  git(seedOuter, "submodule", "add", "-q", projectRemote, STANDIN.subdir);
  git(seedOuter, "add", ".");
  git(seedOuter, "commit", "-q", "-m", "harbour-tools: with tidy-units as a submodule");
  git(folder, "init", "-q", "--bare", "-b", "main", outerRemote);
  git(seedOuter, "push", "-q", outerRemote, "main");
  rmSync(seeds, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  // Scope Soup's own clone of the project: repoPath, and where the meta ref is kept.
  const metaRepo = join(folder, "scopesoup-repo");
  git(folder, "clone", "-q", projectRemote, metaRepo);

  // The pool: two full clones of the outer repository with the submodule checked out.
  const pool = [join(folder, "pool", "one"), join(folder, "pool", "two")];
  mkdirSync(join(folder, "pool"));
  for (const clone of pool) {
    git(folder, "clone", "-q", "--recurse-submodules", outerRemote, clone);
    // So that `git submodule update` works later in the clone without the -c.
    git(clone, "config", "protocol.file.allow", "always");
  }

  const dataDir = join(folder, "data");
  mkdirSync(dataDir);
  const configFile = join(folder, "scopesoup.config.json");
  writeFileSync(configFile, JSON.stringify(standinConfig(projectRemote), null, 2) + "\n");
  // The shared settings, written to the meta ref and pushed, as the first person's onboarding does.
  const settings = metaSettings();
  const saved = await settings.save({ repoPath: metaRepo, remote: "origin", machine: "standin", by: STANDIN.author.name, update: () => standinShared() });
  await settings.stop();
  if (!saved.ok) throw new Error(`The stand-in's shared settings could not be written: ${saved.error}`);
  return { folder, configFile, dataDir, projectRemote, outerRemote, metaRepo, pool };
}

/** What to type to start Scope Soup on the stand-in, and how to reset it. */
export function startInstructions(standin: Standin): string {
  const config = standin.configFile;
  const data = standin.dataDir;
  const root = SCOPESOUP_ROOT;
  return [
    `Stand-in built in ${standin.folder}`,
    "",
    "Start Scope Soup on it (PowerShell):",
    `  $env:SCOPESOUP_CONFIG = "${config}"; $env:SCOPESOUP_DATA = "${data}"; $env:SCOPESOUP_PORT = "${STANDIN.port}"; pnpm --dir "${root}" start`,
    "",
    "Start Scope Soup on it (Git Bash):",
    `  SCOPESOUP_CONFIG="${slashed(config)}" SCOPESOUP_DATA="${slashed(data)}" SCOPESOUP_PORT=${STANDIN.port} pnpm --dir "${slashed(root)}" start`,
    "",
    `The board: http://127.0.0.1:${STANDIN.port}`,
    "",
    "level is 4 (Autopilot): items written on the board start real agent sessions (haiku, review on sonnet), and Scope Soup merges them.",
    "Set level 0 on the Settings page (a commit on refs/scopesoup/meta, in effect at once) to look first.",
    "",
    "To reset: stop Scope Soup (Ctrl-C), delete the folder, and run",
    `  pnpm --dir "${root}" standin "${standin.folder}"`,
    `To forget only Scope Soup's local state (the items stay on refs/scopesoup/meta): stop Scope Soup and delete ${data}.`,
  ].join("\n");
}

async function main(): Promise<void> {
  const given = process.argv[2];
  if (!given) {
    console.error("Usage: pnpm standin <folder>");
    process.exitCode = 2;
    return;
  }
  // pnpm runs the script in Scope Soup's folder; a relative folder means the one the person typed it in.
  const folder = resolve(process.env.INIT_CWD ?? process.cwd(), given);
  try {
    console.log(startInstructions(await buildStandin(folder)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
