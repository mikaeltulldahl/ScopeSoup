// Scope Soup's own version: the `version` of the package.json in the folder it runs from, a release's or a checkout's.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The exit code that asks the launcher to start the version the pointer names (`home.ts`). */
export const RESTART_EXIT_CODE = 75;

/** `1.2.3` as numbers, or null for anything else (a pre-release suffix is not a release here). */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. A version that does not parse is the oldest. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let at = 0; at < 3; at++) if (left[at] !== right[at]) return left[at]! - right[at]!;
  return 0;
}

/** The version in `<root>/package.json`. */
export function versionOf(root: string): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

/** A development checkout has a `.git`; a release folder has none. */
export function isCheckout(root: string): boolean {
  return existsSync(join(root, ".git"));
}

/** The folder a release of `version` is unpacked into: `scopesoup-0.5.0`. */
export const folderOf = (version: string): string => `scopesoup-${version}`;

/** The version a release folder's name says, or null. */
export function versionOfFolder(name: string): string | null {
  const match = /^scopesoup-(\d+\.\d+\.\d+)$/.exec(name);
  return match ? match[1]! : null;
}
