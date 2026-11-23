// Unpacking a release zip into its own folder in Scope Soup's home, after checking it: its size and SHA-256 when
// known, that it unpacks to one folder `scopesoup-<version>/` with the files a release has, and that its version is the
// one asked for. The running version's folder is never touched; a half-unpacked zip never becomes a release folder.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { folderOf, versionOf } from "./version.ts";

/** What a release folder must have to be started and to be set up (`pnpm release`). */
export const RELEASE_FILES = ["package.json", "src/main.ts", "src/scopesoup.ts", "src/item.ts", "web/dist/index.html", "docs/RUNNING.md"];

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The tar that reads zip files: Windows' own (bsdtar), not another one earlier on the PATH (GNU tar, from Git, does not). */
export function zipTar(): string {
  if (process.platform !== "win32") return "tar";
  const own = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(own) ? own : "tar";
}

/** Unpacks `zip` into the empty folder `into` with a tool the machine has. Throws when none works. */
export function extractZip(zip: string, into: string): void {
  const attempts: [string, string[]][] = process.platform === "win32"
    ? [[zipTar(), ["-x", "-f", zip, "-C", into]], ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${into.replace(/'/g, "''")}'`]]]
    : [["unzip", ["-q", zip, "-d", into]], ["tar", ["-x", "-f", zip, "-C", into]]];
  const problems: string[] = [];
  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, { stdio: "pipe", windowsHide: true });
      return;
    } catch (error) {
      problems.push(`${command}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      for (const entry of readdirSync(into)) rmSync(join(into, entry), { recursive: true, force: true });
    }
  }
  throw new Error(`The zip could not be unpacked (${problems.join("; ")}).`);
}

export interface Expected {
  version: string;
  size?: number;
  sha256?: string;
}

/** Checks the zip's bytes against what the release says. Throws with the reason. */
export function checkZip(zip: string, expected: Expected): void {
  const bytes = readFileSync(zip);
  if (expected.size !== undefined && bytes.length !== expected.size) throw new Error(`The zip is ${bytes.length} bytes, and the release says ${expected.size}.`);
  if (expected.sha256 !== undefined && sha256(bytes) !== expected.sha256.toLowerCase()) throw new Error("The zip's SHA-256 is not the one the release gives: it was not unpacked.");
}

/** Why `folder` is not a release of `version`, or null. */
export function layoutProblem(folder: string, version: string): string | null {
  for (const file of RELEASE_FILES) if (!existsSync(join(folder, file))) return `it has no ${file}`;
  if (existsSync(join(folder, ".git"))) return "it is a git checkout, not a release";
  let found: string;
  try {
    const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { name?: unknown };
    if (pkg.name !== "scopesoup") return "its package.json is not Scope Soup's";
    found = versionOf(folder);
  } catch {
    return "its package.json cannot be read";
  }
  return found === version ? null : `it is version ${found}, not ${version}`;
}

/**
 * Checks `zip` and unpacks it into `<home>/scopesoup-<version>`, through a temporary folder in the home that is renamed into
 * place only when everything is right. A folder of that name already there (a try that did not finish) is replaced,
 * unless it is `keep` (the running version). Returns the folder's name.
 */
export function unpackRelease(zip: string, home: string, expected: Expected, keep: readonly string[] = []): string {
  checkZip(zip, expected);
  const folder = folderOf(expected.version);
  if (keep.includes(folder)) throw new Error(`${folder} is in use here and is not replaced.`);
  const temp = join(home, `.unpack-${folder}-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  try {
    extractZip(zip, temp);
    const top = readdirSync(temp);
    if (top.length !== 1 || top[0] !== folder) throw new Error(`The zip holds ${top.length === 0 ? "nothing" : top.join(", ")}, not one folder ${folder}.`);
    const problem = layoutProblem(join(temp, folder), expected.version);
    if (problem) throw new Error(`The zip is not a Scope Soup release ${expected.version}: ${problem}.`);
    const target = join(home, folder);
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    renameSync(join(temp, folder), target);
    return folder;
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
