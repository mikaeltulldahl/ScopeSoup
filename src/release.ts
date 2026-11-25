// Builds a release: one folder holding the server sources, the prompts, the built web
// app, the docs/RUNNING.md reference, the CLAUDE.md section and start scripts, plus a zip of it. The target machine needs only Node (22.18 or newer):
// no `pnpm install`, no registry. Nothing is bundled; the sources run with Node's type stripping.
//
//   pnpm release            refuses a dirty tree or a version already tagged, runs `pnpm check` on the commit, builds
//   pnpm release --no-check a test build: no check, and its release.json says so (never tag one)
//   pnpm release --no-exe   leaves out the Windows .exe that sets Scope Soup up without Node (src/exe/build.ts)
//
// Writes release/scopesoup-<version>/, release/scopesoup-<version>.zip and its .sha256 (git-ignored), the Windows .exe
// release/scopesoup-<version>-win-x64.exe and its .sha256 (where it can be built: it says so and goes on where not), and,
// when the check passed, release/scopesoup-<version>.checked.json with the checked commit. It never tags, pushes or
// publishes anything itself: `pnpm release:publish` (src/releasePublish.ts) does that from what is written here.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONFIG_VERSION } from "./config/migrate.ts";
import { META_FORMAT } from "./hosts/metaBranch/format.ts";
import { STORE_VERSION } from "./store/schema.ts";
import { buildExe, exeName, exeRefusal } from "./exe/build.ts";
import { checkedRecordName } from "./releasePublish.ts";
import { zipTar } from "./upgrade/unpack.ts";
import { versionOf } from "./upgrade/version.ts";

const SCOPESOUP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_FLAGS = "--disable-warning=ExperimentalWarning";

export interface ReleaseOptions {
  /** The checkout to build from. */
  root?: string;
  /** Where the release folder is made; it is replaced if it exists. */
  outDir: string;
  /** The built web app. Default `<root>/web/dist`. */
  webDist?: string;
  /** The commit the release is built from, and whether the check passed on it; written to `release.json`. */
  commit?: string | null;
  checked?: boolean;
  /** The version written into the release instead of package.json's (the upgrade trial's stand-in releases). */
  version?: string;
}

/** Every module specifier a TypeScript file imports or re-exports, or loads with `import()`. */
export function importsOf(source: string): string[] {
  const found: string[] = [];
  const pattern = /^[ \t]*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** The imports under `dir` that are neither relative nor a Node built-in: what a release must not have. */
export function foreignImports(dir: string): { file: string; specifier: string }[] {
  const builtins = new Set(builtinModules);
  const bad: { file: string; specifier: string }[] = [];
  for (const file of sourceFiles(dir)) {
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".") || specifier.startsWith("node:") || builtins.has(specifier)) continue;
      bad.push({ file, specifier });
    }
  }
  return bad;
}

export { versionOf };

/** Runs git in `cwd`; the exit code and output. Tests give a synthetic repository. */
export type Git = (args: string[], cwd: string) => { code: number; stdout: string; stderr: string };

export const realGitSync: Git = (args, cwd) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
};

/**
 * Why `root` may not be released now, or the commit it would tag: the tree must be clean (nothing changed, nothing
 * untracked that is not ignored), and `v<version>` must not be a tag here or on `remote`.
 */
export function releaseRefusal(root: string, git: Git = realGitSync, remote = "origin"): { refused: string } | { commit: string; version: string; tag: string } {
  const version = versionOf(root);
  const tag = `v${version}`;
  const head = git(["rev-parse", "--verify", "HEAD"], root);
  if (head.code !== 0) return { refused: `${root} is not a git checkout with a commit: ${head.stderr.trim()}` };
  const status = git(["status", "--porcelain", "--untracked-files=normal"], root);
  if (status.code !== 0) return { refused: `git status failed: ${status.stderr.trim()}` };
  if (status.stdout.trim() !== "") return { refused: `The tree is not clean, so the release would not be the commit it is tagged on. Commit or remove these first:\n${status.stdout.trimEnd()}` };
  const local = git(["tag", "--list", tag], root);
  if (local.code !== 0) return { refused: `git tag failed: ${local.stderr.trim()}` };
  if (local.stdout.trim() !== "") return { refused: `${tag} is already a tag here: raise "version" in package.json for a new release.` };
  const remoteTags = git(["ls-remote", "--tags", remote, `refs/tags/${tag}`], root);
  if (remoteTags.code !== 0) return { refused: `Could not ask ${remote} whether ${tag} exists: ${remoteTags.stderr.trim()}` };
  if (remoteTags.stdout.trim() !== "") return { refused: `${tag} is already a tag on ${remote}: raise "version" in package.json for a new release.` };
  return { commit: head.stdout.trim(), version, tag };
}

/** What a release says about itself (`release.json` in its folder): the commit, whether the check passed on it, the formats. */
export interface ReleaseManifest {
  version: string;
  commit: string | null;
  checked: boolean;
  formats: { config: number; meta: number; store: number };
}

/** The `package.json` scripts of a release: the commands a person or a skill runs with `pnpm --dir <release>`, as in a checkout. */
export function releaseScripts(): Record<string, string> {
  return {
    start: `node ${NODE_FLAGS} src/main.ts`,
    // Makes this release the current version of the home it was unpacked into, and writes the launcher.
    "setup-home": `node ${NODE_FLAGS} src/scopesoup.ts setup-home`,
    item: `node ${NODE_FLAGS} src/item.ts`,
    open: `node ${NODE_FLAGS} src/open.ts`,
    shortcut: `node ${NODE_FLAGS} src/shortcut.ts`,
    offboard: `node ${NODE_FLAGS} src/offboard/cli.ts`,
    "config:check": `node ${NODE_FLAGS} src/config/check.ts`,
    "config:register": `node ${NODE_FLAGS} src/config/register.ts`,
    "settings:init": `node ${NODE_FLAGS} src/config/settingsInit.ts`,
    "config:setup": `node ${NODE_FLAGS} src/config/setupScript.ts`,
    "config:host": `node ${NODE_FLAGS} src/hostPart.ts`,
    "meta:accept": `node ${NODE_FLAGS} src/hosts/metaBranch/accept.ts`,
  };
}

/** Builds the release folder. Throws when the web app is not built or a source imports a package. */
export function buildRelease(options: ReleaseOptions): string {
  const root = options.root ?? SCOPESOUP_ROOT;
  const webDist = options.webDist ?? join(root, "web", "dist");
  if (!existsSync(join(webDist, "index.html"))) throw new Error(`${webDist} has no built web app. Run \`pnpm web:build\` first.`);
  const out = resolve(options.outDir);
  rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  mkdirSync(out, { recursive: true });

  cpSync(join(root, "src"), join(out, "src"), { recursive: true, filter: (path) => !path.endsWith(".test.ts") });
  cpSync(join(root, "prompts"), join(out, "prompts"), { recursive: true });
  cpSync(webDist, join(out, "web", "dist"), { recursive: true });
  // The MIT licence asks for its notice in every copy.
  cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
  // What the onboarding skill reads from the install: the reference and the CLAUDE.md section.
  mkdirSync(join(out, "docs"), { recursive: true });
  cpSync(join(root, "docs", "RUNNING.md"), join(out, "docs", "RUNNING.md"));
  mkdirSync(join(out, "plugins", "scopesoup"), { recursive: true });
  cpSync(join(root, "plugins", "scopesoup", "claude-md-section.md"), join(out, "plugins", "scopesoup", "claude-md-section.md"));
  const version = options.version ?? versionOf(root);
  writeFileSync(join(out, "package.json"), JSON.stringify({
    name: "scopesoup", version, license: "MIT", private: true, type: "module", engines: { node: ">=22.18" },
    // The commands a person or the onboarding skill runs with `pnpm --dir <release>`, as in a checkout.
    scripts: releaseScripts(),
  }, null, 2) + "\n");
  writeFileSync(join(out, "scopesoup.cmd"), [
    "@echo off",
    "rem Starts Scope Soup. Settings come from the SCOPESOUP_* environment variables (docs/RUNNING.md).",
    `node ${NODE_FLAGS} "%~dp0src\\main.ts" %*`,
    "",
  ].join("\r\n"));
  writeFileSync(join(out, "scopesoup.sh"), [
    "#!/bin/sh",
    "# Starts Scope Soup. Settings come from the SCOPESOUP_* environment variables (docs/RUNNING.md).",
    `exec node ${NODE_FLAGS} "$(dirname "$0")/src/main.ts" "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });

  const manifest: ReleaseManifest = { version, commit: options.commit ?? null, checked: options.checked ?? false, formats: { config: CONFIG_VERSION, meta: META_FORMAT, store: STORE_VERSION } };
  writeFileSync(join(out, "release.json"), JSON.stringify(manifest, null, 2) + "\n");

  const bad = foreignImports(join(out, "src"));
  if (bad.length > 0) throw new Error(`Imports that are not Node built-ins: ${bad.map((b) => `${b.file}: ${b.specifier}`).join("; ")}`);
  return out;
}

/** Zips `folder` next to itself with a tool the machine has. Returns the zip's path, or null if none works. */
export function zipFolder(folder: string): string | null {
  const zip = `${folder}.zip`;
  rmSync(zip, { force: true });
  const parent = dirname(folder);
  const name = folder.slice(parent.length + 1);
  const attempts: [string, string[]][] = process.platform === "win32"
    ? [[zipTar(), ["-a", "-c", "-f", zip, "-C", parent, name]],
       ["powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${folder}' -DestinationPath '${zip}'`]]]
    : [["zip", ["-q", "-r", zip, name]], ["tar", ["-a", "-c", "-f", zip, "-C", parent, name]]];
  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, { cwd: parent, stdio: "pipe" });
      if (existsSync(zip)) return zip;
    } catch { /* try the next tool */ }
  }
  return null;
}

/** Writes `<file>.sha256` ("<hex>  <name>"), which the upgrade checks the zip against. Returns the hex. */
export function writeChecksum(zip: string): string {
  const hex = createHash("sha256").update(readFileSync(zip)).digest("hex");
  writeFileSync(`${zip}.sha256`, `${hex}  ${zip.slice(dirname(zip).length + 1)}\n`);
  return hex;
}

export interface CutOptions {
  root?: string;
  git?: Git;
  /** Runs the check on the tree as it is; true when it passed. Default `pnpm check` with its output shown. */
  check?: (root: string) => boolean;
  /** A test build: no check, and the release says it was not checked. */
  noCheck?: boolean;
  outDir?: string;
  /** The built web app; default `<root>/web/dist` (`pnpm check` builds it). */
  webDist?: string;
  /** Build the Windows .exe from the release folder (default true); where it cannot be built, that is said and the release goes on. */
  exe?: boolean;
  /** Builds the .exe; default `buildExe`. Tests give a fake. */
  buildExe?: typeof buildExe;
  /** Why the .exe cannot be built here, or null; default `exeRefusal`. */
  exeRefusal?: () => string | null;
  print?: (line: string) => void;
}

/**
 * Cuts a release: refuses a dirty tree or a tagged version, runs the check on the exact commit, makes sure the
 * tree and HEAD did not change meanwhile, builds and zips, and records the checked commit beside the zip for
 * `releasePublish.ts`. Tags, pushes and publishes nothing.
 */
export function cutRelease(options: CutOptions = {}): { out: string; zip: string | null; exe: string | null; commit: string } {
  const root = options.root ?? SCOPESOUP_ROOT;
  const git = options.git ?? realGitSync;
  const print = options.print ?? console.log;
  const first = releaseRefusal(root, git);
  if ("refused" in first) throw new Error(first.refused);
  const check = options.check ?? ((dir: string) => spawnSync("pnpm", ["check"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" }).status === 0);
  if (!options.noCheck) {
    print(`Checking ${first.commit} (pnpm check)...`);
    if (!check(root)) throw new Error(`The check failed on ${first.commit}: no release was made.`);
    const after = releaseRefusal(root, git);
    if ("refused" in after) throw new Error(`After the check: ${after.refused}`);
    if (after.commit !== first.commit) throw new Error(`HEAD moved from ${first.commit} to ${after.commit} during the check: no release was made.`);
  }
  const out = buildRelease({ root, outDir: options.outDir ?? join(root, "release", `scopesoup-${first.version}`), commit: first.commit, checked: !options.noCheck, ...(options.webDist ? { webDist: options.webDist } : {}) });
  const recordFile = join(dirname(out), checkedRecordName(first.version));
  rmSync(recordFile, { force: true }); // a test build must not inherit an older record
  for (const stale of [exeName(first.version), `${exeName(first.version)}.sha256`]) rmSync(join(dirname(out), stale), { force: true }); // an older .exe is not this release's
  if (!options.noCheck) writeFileSync(recordFile, JSON.stringify({ version: first.version, commit: first.commit }, null, 2) + "\n");
  const zip = zipFolder(out);
  const hex = zip ? writeChecksum(zip) : null;
  print(`Release folder: ${out}`);
  print(zip ? `Zip: ${zip} (SHA-256 ${hex}, also in ${zip}.sha256)` : "No zip tool found (tar, PowerShell or zip): only the folder was made.");
  let exe: string | null = null;
  if (options.exe ?? true) {
    const refusal = (options.exeRefusal ?? (() => exeRefusal({})))();
    if (refusal) {
      print(`No .exe was built: ${refusal} (--no-exe leaves it out without this note.)`);
    } else {
      try {
        const built = (options.buildExe ?? buildExe)({ releaseFolder: out });
        exe = built.exe;
        print(`Exe: ${exe} (${(built.bytes / 1e6).toFixed(0)} MB, Node ${process.version} inside, SHA-256 ${writeChecksum(exe)}, also in ${exe}.sha256)`);
      } catch (error) {
        print(`No .exe was built: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  print(`Formats: config ${CONFIG_VERSION}, meta branch ${META_FORMAT}, database ${STORE_VERSION}. Say in the notes whether any changed since the last release.`);
  if (options.noCheck) {
    print("This is a test build (--no-check): do not tag or publish it.");
  } else {
    print(`To publish it, after a person said yes: pnpm release:publish ${first.version} --notes-file <notes.md>`);
    print(`That tags exactly ${first.commit} as ${first.tag}, pushes the tag and creates the GitHub release with the files above.`);
    if (!zip) print("There is no zip, so there is nothing to publish.");
  }
  return { out, zip, exe, commit: first.commit };
}

function main(): void {
  try {
    cutRelease({ noCheck: process.argv.includes("--no-check"), exe: !process.argv.includes("--no-exe") });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
