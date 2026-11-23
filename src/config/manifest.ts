// The manifest, a record of everything Scope Soup made or changed outside its config folder, so that offboarding works from a
// list and guesses nothing. It is `scopesoup.manifest.jsonl` beside this machine's `scopesoup.config.json`: one JSON line per thing,
// appended by onboarding and by Scope Soup while it runs, never rewritten. A thing already on it is not added again.
//
// The write points are few: `settings:init` (the meta ref, Scope Soup's clone), `config:setup --write` (the setup script and its
// branch), `pnpm offboard record` (the skill's optional CLAUDE.md section and plugin lines), Scope Soup's start (its clone and the
// folders it keeps outside the config folder) and the GitHub host (a label it created). Offboarding also looks for Scope Soup's own
// names (`refs/scopesoup/*`, `scopesoup/*` branches, its labels, the `.v*` copies), so a thing missing here is still found.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { within } from "./validate.ts";

export const MANIFEST_FILE = "scopesoup.manifest.jsonl";

import type { ManifestEntry, ManifestThing, ProjectChange } from "./manifestTypes.ts";

export type { ManifestEntry, ManifestThing, ProjectChange };

/** The manifest of the config file `configFile`. */
export const manifestPath = (configFile: string): string => join(dirname(configFile), MANIFEST_FILE);

/** One key per thing: the same thing is listed once. Paths compare as the OS does (case on Windows). */
export function thingKey(thing: ManifestThing): string {
  const path = (value: string) => (process.platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value);
  switch (thing.kind) {
    case "folder": return `folder ${path(thing.path)}`;
    case "ref": return `ref ${thing.ref}`;
    case "branch": return `branch ${thing.branch}`;
    case "label": return `label ${thing.repo.toLowerCase()} ${thing.name.toLowerCase()}`;
    case "project-file": return `project-file ${thing.path} ${thing.change}`;
  }
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const CHANGES: readonly string[] = ["claude-md-section", "plugin-settings", "setup-script"];

/** One line, or null when it is not an entry this Scope Soup knows (skipped, never fatal). */
export function parseEntry(line: string): ManifestEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const at = isText(o.at) ? o.at : "";
  const by = isText(o.by) ? o.by : "";
  if (o.kind === "folder" && isText(o.path) && isText(o.what)) return { kind: "folder", path: o.path, what: o.what, at, by };
  if (o.kind === "ref" && isText(o.ref) && o.ref.startsWith("refs/scopesoup/") && isText(o.what)) return { kind: "ref", ref: o.ref, what: o.what, at, by };
  if (o.kind === "branch" && isText(o.branch) && isText(o.what)) return { kind: "branch", branch: o.branch, what: o.what, at, by };
  if (o.kind === "label" && isText(o.repo) && isText(o.name)) return { kind: "label", repo: o.repo, name: o.name, at, by };
  if (o.kind === "project-file" && isText(o.path) && typeof o.change === "string" && CHANGES.includes(o.change)) return { kind: "project-file", path: o.path, change: o.change as ProjectChange, at, by };
  return null;
}

/** The manifest's entries, the first of each thing; a line that cannot be read is skipped. */
export function parseManifest(text: string): ManifestEntry[] {
  const seen = new Set<string>();
  const out: ManifestEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const entry = parseEntry(line);
    if (!entry || seen.has(thingKey(entry))) continue;
    seen.add(thingKey(entry));
    out.push(entry);
  }
  return out;
}

/** The lines to append for `things`: only those not on the manifest yet, each once. */
export function linesToAdd(existing: readonly ManifestEntry[], things: readonly ManifestThing[], at: string, by: string): string[] {
  const seen = new Set(existing.map(thingKey));
  const lines: string[] = [];
  for (const thing of things) {
    const key = thingKey(thing);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(JSON.stringify({ ...thing, at, by }));
  }
  return lines;
}

export function readManifest(file: string): ManifestEntry[] {
  if (!existsSync(file)) return [];
  return parseManifest(readFileSync(file, "utf8"));
}

/**
 * Appends what is new of `things` to the manifest of `configFile`. A folder inside the config folder is left out: it goes with
 * the folder. Never throws: the record helps offboarding, and a failure to write it must not stop the work (offboarding's scan
 * finds Scope Soup's own names anyway). Returns what was added.
 */
export function recordInManifest(configFile: string, things: readonly ManifestThing[], by: string, at: string = new Date().toISOString()): string[] {
  try {
    const folder = dirname(configFile);
    if (!existsSync(folder)) return [];
    const outside = things.filter((thing) => thing.kind !== "folder" || !within(folder, thing.path));
    const file = manifestPath(configFile);
    const lines = linesToAdd(readManifest(file), outside, at, by);
    if (lines.length > 0) appendFileSync(file, lines.map((line) => `${line}\n`).join(""));
    return lines;
  } catch {
    return [];
  }
}
