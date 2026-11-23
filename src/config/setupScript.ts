// The setup of a fresh clone, as the scopesoup-onboard skill proposes it. `pnpm config:setup <your clone> <repository>` reads
// the person's own clone (never writes to it) and prints a proposal as JSON: the steps a fresh clone needs (installs from the
// lockfiles, submodules, Makefile setup targets), the ignored personal files to copy from the person's clone (.env and local
// settings: names only, never their content), the files to watch (`setupWatch`) and the `setupCommand` that runs the script.
// With `--write` (after the person's yes, with the steps and files they confirmed in `--steps <json>` and `--files <json>`, or the
// proposal as it is) it writes the setup script, `.scopesoup/scopesoup-setup.mjs`, into <repository> (Scope Soup's own clone of the
// project, where the skill commits it on a branch for the person to merge; the command is a shared setting).
// The command passes `--from-clone {{ownClone}}`: each machine's own clone, from its private file's `ownClone`.
//
// The script is plain Node (Scope Soup needs Node anyway) and is the project's: the person may edit it. Run with
// `--from-clone <path>`, it copies each listed personal file from that clone, only into a place git ignores in the folder it runs
// in (so a secret never ends up in a commit), and prints only file names. Nothing else is copied: absolute paths in a clone's
// build output would break. Then it runs each step, in order, and stops at the first that fails.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETUP_WATCH } from "./defaults.ts";
import { watchedFiles } from "../orchestrator/setup.ts";

/** One step of the script: a program and its arguments, run in the folder (or a subfolder of it). */
export interface SetupStep {
  run: string[];
  /** A subfolder, relative, "/" between folders. Absent: the folder itself. */
  cwd?: string;
  /** Why it is proposed, for the person. */
  from: string;
}

export interface SetupProposal {
  steps: SetupStep[];
  /** Ignored files in the person's clone, relative, that look personal (settings, secrets): proposed, never copied blindly. */
  personalFiles: string[];
  setupWatch: string[];
  /** Where the script goes, and the command that runs it. */
  script: string;
  setupCommand: string[];
}

export const SCRIPT_NAME = "scopesoup-setup.mjs";
/** Where the script lives, relative to the repository. */
export const SCRIPT_PATH = `.scopesoup/${SCRIPT_NAME}`;
/** Lockfiles and the install each asks for. */
const INSTALLS: [file: string, run: string[]][] = [
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["package-lock.json", ["npm", "ci"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
  ["bun.lock", ["bun", "install", "--frozen-lockfile"]],
  ["poetry.lock", ["poetry", "install"]],
  ["uv.lock", ["uv", "sync", "--frozen"]],
  ["Pipfile.lock", ["pipenv", "sync"]],
  ["Cargo.lock", ["cargo", "fetch"]],
  ["go.sum", ["go", "mod", "download"]],
  ["Gemfile.lock", ["bundle", "install"]],
  ["composer.lock", ["composer", "install"]],
];
/** Folders never looked into for lockfiles or personal files. */
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "target", "out", ".next", "coverage", "__pycache__", "vendor"]);
/** Names of ignored files that hold a person's settings or secrets. */
const PERSONAL = [/^\.env(\..+)?$/i, /\.local(\.[A-Za-z0-9]+)?$/i, /^local\.[A-Za-z0-9]+$/i, /^\.npmrc$/i, /^secrets?\.[A-Za-z0-9]+$/i, /^credentials?\.[A-Za-z0-9]+$/i, /^\.secrets?$/i];
/** A personal file larger than this is not proposed: it is data, not a setting. */
const MAX_PERSONAL_BYTES = 256 * 1024;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The folder itself and its subfolders one level down (not the skipped ones): where lockfiles are looked for. */
function folders(repo: string): string[] {
  const found = [""];
  let names: string[] = [];
  try {
    names = readdirSync(repo);
  } catch {
    names = [];
  }
  for (const name of names.sort()) if (!SKIP_DIRS.has(name) && !name.startsWith(".") && isDir(join(repo, name))) found.push(name);
  return found;
}

/** Ignored files of the clone that look personal, by `git ls-files --others --ignored`. Read only. */
export function personalFiles(clone: string, git: (args: string[], cwd: string) => string = gitText): string[] {
  let listed: string;
  try {
    listed = git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], clone);
  } catch {
    return [];
  }
  return listed.split("\0")
    .filter((path) => path !== "" && !path.endsWith("/"))
    .filter((path) => !path.split("/").some((part) => SKIP_DIRS.has(part)))
    .filter((path) => PERSONAL.some((pattern) => pattern.test(basename(path))))
    .filter((path) => {
      try {
        return statSync(join(clone, path)).size <= MAX_PERSONAL_BYTES;
      } catch {
        return false;
      }
    })
    .sort();
}

function gitText(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/** What a fresh clone of the project needs, read from the person's own clone. `repository`: where the script is written. */
export function proposeSetup(clone: string, repository: string, git: (args: string[], cwd: string) => string = gitText): SetupProposal {
  const steps: SetupStep[] = [];
  const watch = new Set<string>(watchedFiles(clone, DEFAULT_SETUP_WATCH));
  if (isFile(join(clone, ".gitmodules"))) steps.push({ run: ["git", "submodule", "update", "--init", "--recursive"], from: ".gitmodules" });
  for (const folder of folders(clone)) {
    for (const [file, run] of INSTALLS) {
      const rel = folder === "" ? file : `${folder}/${file}`;
      if (!isFile(join(clone, rel))) continue;
      steps.push({ run, ...(folder === "" ? {} : { cwd: folder }), from: rel });
      watch.add(rel);
      // One install per folder: the first lockfile found decides the package manager.
      break;
    }
    // requirements*.txt without a lock of their own: a virtual environment in the folder.
    const requirements = watchedFiles(join(clone, folder), ["requirements*.txt"]);
    if (requirements.length > 0 && !steps.some((step) => (step.cwd ?? "") === folder && /^(poetry|uv|pipenv)$/.test(step.run[0] ?? ""))) {
      const at = folder === "" ? "" : `${folder}/`;
      steps.push({ run: ["python", "-m", "venv", ".venv"], ...(folder === "" ? {} : { cwd: folder }), from: `${at}${requirements[0]}` });
      for (const file of requirements) {
        steps.push({ run: ["{venv-python}", "-m", "pip", "install", "-r", file], ...(folder === "" ? {} : { cwd: folder }), from: `${at}${file}` });
        watch.add(`${at}${file}`);
      }
    }
  }
  // A Makefile target that sets things up.
  try {
    const makefile = ["Makefile", "makefile", "GNUmakefile"].map((name) => join(clone, name)).find(isFile);
    if (makefile) {
      const text = readFileSync(makefile, "utf8");
      const target = ["setup", "bootstrap", "deps", "install"].find((name) => new RegExp(`^${name}\\s*:(?!=)`, "m").test(text));
      if (target) steps.push({ run: ["make", target], from: `the ${target} target in ${basename(makefile)}` });
    }
  } catch {
    // An unreadable Makefile proposes nothing.
  }
  const script = join(resolve(repository), SCRIPT_PATH).replace(/\\/g, "/");
  return {
    steps,
    personalFiles: personalFiles(clone, git),
    setupWatch: [...watch].sort(),
    script,
    // Run in each fresh folder, so the script is found relative to it; {{ownClone}} is each machine's own clone.
    setupCommand: ["node", SCRIPT_PATH, "--from-clone", "{{ownClone}}"],
  };
}


/** The setup script, with the steps and personal files the person confirmed. */
export function renderSetupScript(project: string, steps: readonly SetupStep[], files: readonly string[]): string {
  for (const file of files) {
    if (isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes("..")) throw new Error(`"${file}" must be relative to the repository, without "..".`);
  }
  const plainSteps = steps.map(({ run, cwd }) => ({ run, ...(cwd ? { cwd } : {}) }));
  return `#!/usr/bin/env node
// The setup of a fresh clone of ${project.replace(/[\r\n]/g, " ")} for Scope Soup, written by the scopesoup-onboard skill. Scope Soup runs it, as setupCommand,
// in each of its worktrees or clones and in the merge queue's clone: once, and again when a watched file (setupWatch) changes.
// It is yours to edit. Keep it printing names only: Scope Soup keeps the end of its output when it fails.
//
//   node ${SCRIPT_PATH} --from-clone <your own clone>
//
// 1. Copies each file of PERSONAL_FILES from your clone (settings, secrets that git ignores), only into a place git ignores here.
// 2. Runs each step of STEPS in order, and stops at the first that fails.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const PERSONAL_FILES = ${JSON.stringify(files, null, 2)};
const STEPS = ${JSON.stringify(plainSteps, null, 2)};

const here = process.cwd();
function fail(message) {
  console.error(\`Setup failed: \${message}\`);
  process.exit(1);
}
function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const from = option("--from-clone");
if (from !== undefined) {
  if (!existsSync(from)) fail(\`--from-clone \${from} is not there.\`);
  if (realpathSync(from) === realpathSync(here)) fail("--from-clone names the folder the setup runs in.");
}
for (const file of PERSONAL_FILES) {
  if (from === undefined) {
    console.log(\`Not copied (no --from-clone): \${file}\`);
    continue;
  }
  if (isAbsolute(file) || file.split(/[\\\\/]/).includes("..")) fail(\`\${file} is not a path inside the repository.\`);
  const source = join(from, file);
  if (!existsSync(source)) {
    console.log(\`Not in your clone, not copied: \${file}\`);
    continue;
  }
  // Only into a place git ignores here and does not track, so it never ends up in a commit.
  const ignored = spawnSync("git", ["check-ignore", "-q", file], { cwd: here }).status === 0;
  if (!ignored) fail(\`\${file} is not ignored by git here, so it is not copied (a secret must never be committed).\`);
  const target = join(here, file);
  if (existsSync(target) && readFileSync(target).equals(readFileSync(source))) {
    console.log(\`Already there: \${file}\`);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(\`Copied from your clone: \${file}\`);
}

/** The Python of the folder's virtual environment, for a step that names {venv-python}. */
function venvPython(cwd) {
  return process.platform === "win32" ? join(cwd, ".venv", "Scripts", "python.exe") : join(cwd, ".venv", "bin", "python");
}
const quote = (word) => (/^[A-Za-z0-9_.:\\/=@+-]+$/.test(word) ? word : \`"\${word.replace(/"/g, '\\\\"')}"\`);
for (const step of STEPS) {
  const cwd = step.cwd ? resolve(here, step.cwd) : here;
  const words = step.run.map((word) => (word === "{venv-python}" ? venvPython(cwd) : word));
  console.log(\`> \${words.join(" ")}\${step.cwd ? \` (in \${step.cwd})\` : ""}\`);
  // On Windows package managers are .cmd shims, which only a shell starts.
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", \`"\${words.map(quote).join(" ")}"\`], { cwd, stdio: "inherit", windowsVerbatimArguments: true })
    : spawnSync(words[0], words.slice(1), { cwd, stdio: "inherit" });
  if (result.status !== 0) fail(\`\${words.join(" ")} \${result.error ? \`could not start (\${result.error.message})\` : \`exited with \${result.status ?? result.signal}\`}.\`);
}
console.log("Setup done.");
`;
}

/** `pnpm config:setup <your clone> <repository> [--write] [--project <name>] [--steps <json>] [--files <json>]`. */
export function main(argv: string[]): number {
  const words = argv.filter((word, index) => !word.startsWith("--") && !(argv[index - 1] ?? "").match(/^--(project|steps|files)$/));
  const option = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at < 0 ? undefined : argv[at + 1];
  };
  const [clone, folder] = words;
  if (!clone || !folder) {
    console.error("usage: pnpm config:setup <your own clone> <repository> [--write] [--project <name>] [--steps <json>] [--files <json>]");
    return 2;
  }
  if (!existsSync(join(clone, ".git"))) {
    console.error(`${clone} is not a git clone.`);
    return 1;
  }
  const proposal = proposeSetup(clone, folder);
  const steps = option("--steps") ? (JSON.parse(option("--steps")!) as SetupStep[]) : proposal.steps;
  const files = option("--files") ? (JSON.parse(option("--files")!) as string[]) : proposal.personalFiles;
  if (argv.includes("--write")) {
    mkdirSync(dirname(proposal.script), { recursive: true });
    writeFileSync(proposal.script, renderSetupScript(option("--project") ?? basename(resolve(clone)), steps, files));
  }
  console.log(JSON.stringify({ ...proposal, steps, personalFiles: files, written: argv.includes("--write") }, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
