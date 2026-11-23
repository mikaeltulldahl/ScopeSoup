// Writes the configuration file: the settings page's save (edit.ts) and the migration to the current format.
// A temporary file beside it, then a rename: a reader sees the old file or the new, never half. A migration first keeps
// one copy of the old file next to it, `<name>.v<old format>.json`, and only the newest such copy.

import { randomBytes } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** `value` as JSON in the style of `like` (the file as it was): its indentation, line ends and final newline kept. */
export function configText(value: unknown, like: string): string {
  const indent = /^\{\r?\n([ \t]+)"/.exec(like)?.[1] ?? 2;
  const eol = like.includes("\r\n") ? "\r\n" : "\n";
  return JSON.stringify(value, null, indent).replace(/\n/g, eol) + (like === "" || /\r?\n$/.test(like) ? eol : "");
}

function stemOf(path: string): string {
  const name = basename(path);
  return name.toLowerCase().endsWith(".json") ? name.slice(0, -".json".length) : name;
}

/** Where a migration keeps the old file of format `version`: `scopesoup.config.v0.json` beside `scopesoup.config.json`. */
export function backupPath(path: string, version: number): string {
  return join(dirname(path), `${stemOf(path)}.v${version}.json`);
}

/** The copies of older formats beside `path`, as backupPath names them. */
export function backupsOf(path: string): string[] {
  const stem = stemOf(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${stem}\\.v\\d+\\.json$`, "i");
  try {
    return readdirSync(dirname(path)).filter((name) => pattern.test(name)).map((name) => join(dirname(path), name));
  } catch {
    return [];
  }
}

/**
 * Replaces the file at `path` with `text`. With `backup`, the file as it is (of that format) is first copied to
 * backupPath, and every older copy is removed once the new file is in place. Nothing is changed unless all of it can be:
 * a file that cannot be written is found before anything is written. Returns why it failed, or null.
 */
export function writeConfigFile(path: string, text: string, backup?: { version: number }): string | null {
  try {
    accessSync(path, constants.W_OK);
  } catch (error) {
    return `${path} cannot be written (${message(error)}); it was not changed.`;
  }
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const copy = backup === undefined ? undefined : backupPath(path, backup.version);
  const copyExisted = copy !== undefined && existsSync(copy);
  try {
    writeFileSync(temp, text);
    if (copy !== undefined) copyFileSync(path, copy);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    if (copy !== undefined && !copyExisted) rmSync(copy, { force: true });
    return `Cannot write ${path}: ${message(error)}; it was not changed.`;
  }
  if (copy !== undefined) {
    for (const older of backupsOf(path)) if (older.toLowerCase() !== copy.toLowerCase()) rmSync(older, { force: true });
  }
  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
