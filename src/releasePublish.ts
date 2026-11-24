// Publishes a release that `pnpm release` built and checked (docs/RUNNING.md, "Cutting a release"):
//
//   pnpm release:publish <version> --notes-file notes.md
//
// Tags exactly the commit `pnpm release` recorded as checked (annotated, "Scope Soup <version>"), pushes the tag to origin and
// creates the GitHub release with the zip, the .exe (when one was built) and their .sha256 files. Run it only after a person
// said yes to publishing. It refuses when the release or its record of the checked commit is missing, when the tag exists here
// or on origin, or when no notes file is given. It never forces, and never moves or deletes an existing tag.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exeName } from "./exe/build.ts";

const SCOPESOUP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Runs `git` or `gh` in `cwd`; the exit code and output. Tests give a fake. */
export type Run = (command: "git" | "gh", args: string[], cwd: string) => { code: number; stdout: string; stderr: string };

export const realRun: Run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
};

/** The record `pnpm release` leaves beside the zip when the check passed: `release/scopesoup-<version>.checked.json`. */
export interface CheckedRecord {
  version: string;
  commit: string;
}

export const checkedRecordName = (version: string): string => `scopesoup-${version}.checked.json`;

export interface PublishOptions {
  version: string;
  notesFile: string | undefined;
  root?: string;
  /** The folder `pnpm release` writes into; default `<root>/release`. */
  releaseDir?: string;
  run?: Run;
  print?: (line: string) => void;
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** Publishes the release. Throws, before anything is tagged or pushed, with the reason it was refused. */
export function publishRelease(options: PublishOptions): { tag: string; commit: string; files: string[] } {
  const { version } = options;
  const root = options.root ?? SCOPESOUP_ROOT;
  const releaseDir = resolve(options.releaseDir ?? join(root, "release"));
  const run = options.run ?? realRun;
  const print = options.print ?? console.log;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version}" is not a version like 1.2.3. Usage: pnpm release:publish <version> --notes-file <notes.md>`);
  if (!options.notesFile) throw new Error("No notes file: pass --notes-file <notes.md>. The notes say what changed and whether the config, meta branch or database format did.");
  const notes = resolve(options.notesFile);
  if (!existsSync(notes)) throw new Error(`The notes file ${notes} does not exist.`);
  const tag = `v${version}`;

  const folder = join(releaseDir, `scopesoup-${version}`);
  const zip = `${folder}.zip`;
  for (const missing of [folder, zip, `${zip}.sha256`].filter((path) => !existsSync(path))) {
    throw new Error(`${missing} does not exist: run \`pnpm release\` for ${version} first.`);
  }
  const recordFile = join(releaseDir, checkedRecordName(version));
  const record = readJson(recordFile) as Partial<CheckedRecord> | null;
  if (!record || record.version !== version || typeof record.commit !== "string" || !/^[0-9a-f]{40}$/.test(record.commit)) {
    throw new Error(`${recordFile} is missing or unreadable, so the checked commit is unknown: run \`pnpm release\` for ${version} again (a --no-check build is never published).`);
  }
  const manifest = readJson(join(folder, "release.json")) as { checked?: unknown; commit?: unknown } | null;
  if (manifest?.checked !== true || manifest.commit !== record.commit) {
    throw new Error(`${join(folder, "release.json")} does not say it was checked on ${record.commit}: run \`pnpm release\` for ${version} again.`);
  }
  const commit = record.commit;
  const exe = join(releaseDir, exeName(version));
  const files = [zip, `${zip}.sha256`];
  if (existsSync(exe)) {
    if (!existsSync(`${exe}.sha256`)) throw new Error(`${exe}.sha256 does not exist: run \`pnpm release\` for ${version} again.`);
    files.push(exe, `${exe}.sha256`);
  }

  const known = run("git", ["cat-file", "-e", `${commit}^{commit}`], root);
  if (known.code !== 0) throw new Error(`The checked commit ${commit} is not in ${root}: run this in the clone that built the release.`);
  const local = run("git", ["tag", "--list", tag], root);
  if (local.code !== 0) throw new Error(`git tag failed: ${local.stderr.trim()}`);
  if (local.stdout.trim() !== "") throw new Error(`${tag} is already a tag here: nothing was done.`);
  const remote = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], root);
  if (remote.code !== 0) throw new Error(`Could not ask origin whether ${tag} exists: ${remote.stderr.trim()}`);
  if (remote.stdout.trim() !== "") throw new Error(`${tag} is already a tag on origin: nothing was done.`);

  if (files.length === 2) print(`No .exe for ${version} in ${releaseDir}: the release gets the zip only.`);
  const step = (command: "git" | "gh", args: string[]): void => {
    print(`  ${command} ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")}`);
    const result = run(command, args, root);
    if (result.code !== 0) throw new Error(`${command} ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    if (result.stdout.trim() !== "") print(result.stdout.trim());
  };
  step("git", ["tag", "-a", tag, commit, "-m", `Scope Soup ${version}`]);
  try {
    step("git", ["push", "origin", tag]);
  } catch (error) {
    run("git", ["tag", "-d", tag], root); // the tag this call made, so that a retry is not refused
    throw error;
  }
  step("gh", ["release", "create", tag, ...files, "--title", `Scope Soup ${version}`, "--notes-file", notes]);
  return { tag, commit, files };
}

function main(): void {
  try {
    const args = process.argv.slice(2);
    const flag = args.indexOf("--notes-file");
    const notesFile = flag >= 0 ? args[flag + 1] : undefined;
    const version = args.find((arg, index) => !arg.startsWith("--") && index !== flag + 1) ?? "";
    publishRelease({ version, notesFile });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
