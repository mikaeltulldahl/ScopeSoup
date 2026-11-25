// A project's settings are in two places, and each key in exactly one of them.
//   Shared, on the meta ref: `settings/settings.json` on `refs/scopesoup/meta` of the repository (src/hosts/metaBranch/settings.ts),
//   written the way Scope Soup writes Items: one commit per save, compare-and-swap, the person's name in the commit. Every machine
//   runs the project at the same level, with the same models, check and rules. A save takes effect at once on the machine
//   that made it, and on the others at their next fetch of the meta ref. The ref's name is fixed, so finding it needs no setting.
//   Private, per machine: `scopesoup.config.json` in the machine's config folder: its name, where the repository is (repoPath and
//   remote), its local paths and what it may spend. Tokens stay in the environment.
// A key in the wrong place is refused with where it belongs; there are no override rules. Validation of the values is
// validate.ts's, on the two taken together.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { SettingChange } from "../hosts/metaBranch/settings.ts";
import { META_REF, SETTINGS_FILE, settingChanges, settingsText } from "../hosts/metaBranch/settings.ts";
import { migrateConfig } from "./migrate.ts";
import { type ConfigResult, validateConfig } from "./validate.ts";

export type { SettingChange };

/** Where the shared settings are, in words. */
export const SHARED_WHERE = `the project's shared settings (${SETTINGS_FILE} on ${META_REF})`;

/** Top-level keys of the private file. `settings` is split by name below; `meta` is this machine's part of a meta branch host. */
export const PRIVATE_KEYS: readonly string[] = [
  "version", "machineName", "repoPath", "remote", "remoteUrl", "realPaths", "ownClone", "keepAwake", "workspacesDir", "workspaces",
  "streamsDir", "promptsDir", "claude", "copilot", "meta", "jira", "settings", "resources",
];
/** Top-level keys of the shared settings. */
export const SHARED_KEYS: readonly string[] = [
  "project", "host", "mainBranch", "level", "checkCommand", "rerunFilesCommand", "setupCommand", "setupWatch", "mergeQueue", "bugLabels",
  "roles", "settings", "sharedResources",
];
/** What this machine may spend, and how often it looks: in the private file's `settings`. */
export const PRIVATE_SETTINGS: readonly string[] = ["maxParallelSessions", "budgetReserve", "reserveFiveHour", "reserveSevenDay", "tickSeconds"];
/** The rule-like numbers: in the shared settings' `settings`. */
export const SHARED_SETTINGS: readonly string[] = [
  "stallTimeoutMinutes", "sessionTimeoutMinutes", "persistence", "retryBackoffCapSeconds", "checkTimeoutMinutes", "queueMinBatch",
  "queueMaxBatch", "queueRerunCost", "queueMinOutcomes", "triageMaxAgeDays",
];
/** A meta branch host's keys that belong to one machine or person: in the private file as `meta.<key>`, never in the shared `host`. */
export const META_KEYS: readonly string[] = ["authorName", "authorEmail", "prefix"];
/** A Jira host's keys that belong to one person: in the private file as `jira.<key>`. The Cloud account's email is personal. */
export const JIRA_PRIVATE_KEYS: readonly string[] = ["email"];

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PRIVATE_NAME = "scopesoup.config.json";
const toShared = (key: string): string => `${key} is a project setting, the same on every machine: it belongs in ${SHARED_WHERE}, saved on the Settings page, not in this machine's ${PRIVATE_NAME}.`;
const toPrivate = (key: string): string => `${key} is this machine's own setting: it belongs in its ${PRIVATE_NAME}, not in ${SHARED_WHERE}, which every machine shares.`;

/**
 * The private file's own keys, the shared settings' own keys, and the two as one object for validate.ts (and for the Settings
 * page, which shows them together). Errors name the key and where it belongs.
 */
export function combineFiles(privateRaw: Obj, sharedRaw: Obj): { combined: Obj; errors: string[] } {
  const errors: string[] = [];
  for (const key of Object.keys(privateRaw)) if (SHARED_KEYS.includes(key) && key !== "settings") errors.push(toShared(key));
  for (const key of Object.keys(sharedRaw)) if (PRIVATE_KEYS.includes(key) && key !== "settings") errors.push(toPrivate(key));
  if (isObj(privateRaw.settings)) for (const name of Object.keys(privateRaw.settings)) if (SHARED_SETTINGS.includes(name)) errors.push(toShared(`settings.${name}`));
  if (isObj(sharedRaw.settings)) for (const name of Object.keys(sharedRaw.settings)) if (PRIVATE_SETTINGS.includes(name)) errors.push(toPrivate(`settings.${name}`));
  const host = sharedRaw.host;
  if (isObj(host)) {
    for (const key of META_KEYS) if (Object.hasOwn(host, key)) errors.push(`host.${key} belongs to one machine: it goes in that machine's ${PRIVATE_NAME} as meta.${key}, not in ${SHARED_WHERE}, which every machine shares.`);
    if (host.kind === "jira") for (const key of JIRA_PRIVATE_KEYS) if (Object.hasOwn(host, key)) errors.push(`host.${key} belongs to one person: it goes in that machine's ${PRIVATE_NAME} as jira.${key}, not in ${SHARED_WHERE}, which every machine shares.`);
  }
  const jira = privateRaw.jira;
  if (jira !== undefined) {
    if (!isObj(jira)) errors.push(`jira must be an object: this machine's part of a Jira host (${JIRA_PRIVATE_KEYS.join(", ")}).`);
    else {
      for (const key of Object.keys(jira)) if (!JIRA_PRIVATE_KEYS.includes(key)) errors.push(/token/i.test(key) ? `jira.${key}: a token is never kept in the configuration file. Set SCOPESOUP_JIRA_TOKEN in the environment.` : `jira: unknown key "${key}". Known keys: ${JIRA_PRIVATE_KEYS.join(", ")}.`);
      if (!isObj(host) || host.kind !== "jira") errors.push(`jira is this machine's part of a Jira host, but the host in ${SHARED_WHERE} is not "jira". Remove jira.`);
    }
  }
  const meta = privateRaw.meta;
  if (meta !== undefined) {
    if (!isObj(meta)) errors.push(`meta must be an object: this machine's part of a meta branch host (${META_KEYS.join(", ")}).`);
    else {
      for (const key of Object.keys(meta)) if (!META_KEYS.includes(key)) errors.push(`meta: unknown key "${key}". Known keys: ${META_KEYS.join(", ")}.`);
      if (!isObj(host) || host.kind !== "metaBranch") errors.push(`meta is this machine's part of a meta branch host, but the host in ${SHARED_WHERE} is not "metaBranch". Remove meta.`);
    }
  }

  const combined: Obj = {};
  for (const [key, value] of Object.entries(privateRaw)) if (key !== "meta" && key !== "jira" && key !== "settings") combined[key] = value;
  for (const [key, value] of Object.entries(sharedRaw)) if (key !== "settings" && !Object.hasOwn(combined, key)) combined[key] = value;
  if (isObj(host) && host.kind === "metaBranch" && isObj(meta)) combined.host = { ...host, ...meta };
  if (isObj(host) && host.kind === "jira" && isObj(jira)) combined.host = { ...host, ...Object.fromEntries(Object.entries(jira).filter(([key]) => JIRA_PRIVATE_KEYS.includes(key))) };
  if (privateRaw.settings !== undefined || sharedRaw.settings !== undefined) {
    if (privateRaw.settings !== undefined && !isObj(privateRaw.settings)) errors.push(`settings in ${PRIVATE_NAME} must be an object.`);
    if (sharedRaw.settings !== undefined && !isObj(sharedRaw.settings)) errors.push(`settings in ${SHARED_WHERE} must be an object.`);
    combined.settings = { ...(isObj(sharedRaw.settings) ? sharedRaw.settings : {}), ...(isObj(privateRaw.settings) ? privateRaw.settings : {}) };
  }
  return { combined, errors };
}

/**
 * Validates the two together. `raw` in an ok result is the private file in the current format (migrate.ts), the only file the
 * loader ever writes back; `combined` is both as one, as the Settings page shows them.
 */
export function validateFiles(privateGiven: unknown, sharedGiven: unknown, baseDir: string): ConfigResult & { combined?: Obj } {
  const migrated = migrateConfig(privateGiven);
  if (!migrated.ok && migrated.raw === undefined) return { ok: false, errors: migrated.errors };
  const privateRaw = migrated.raw!;
  if (!isObj(sharedGiven)) return { ok: false, errors: [...(migrated.ok ? [] : migrated.errors), `${SHARED_WHERE} must be a JSON object.`] };
  const { combined, errors } = combineFiles(privateRaw, sharedGiven);
  const result = validateConfig(combined, baseDir);
  const all = [...(migrated.ok ? [] : migrated.errors), ...errors, ...(result.ok ? [] : result.errors)];
  if (all.length > 0 || !result.ok || !migrated.ok) return { ok: false, errors: all, combined };
  return { ...result, notices: migrated.changes, from: migrated.from, raw: privateRaw, combined };
}

/** Where the private file says the repository is: repoPath (relative to the file's folder) and the remote. */
export function repositoryOf(privateRaw: unknown, baseDir: string): { repoPath: string; remote: string; machine: string | null } {
  const raw = isObj(privateRaw) ? privateRaw : {};
  const given = typeof raw.repoPath === "string" && raw.repoPath.trim() !== "" ? raw.repoPath : ".";
  return {
    repoPath: isAbsolute(given) ? resolve(given) : resolve(baseDir, given),
    remote: typeof raw.remote === "string" && raw.remote.trim() !== "" ? raw.remote : "origin",
    machine: typeof raw.machineName === "string" && raw.machineName.trim() !== "" ? raw.machineName.trim() : null,
  };
}

/** The shared settings as read: their text and the meta commit they were read from. */
export type SharedRead = { ok: true; text: string; commit: string } | { ok: false; error: string };

/** A save of the shared settings: `update` is made on the newest settings, again if another save was first. */
export interface SaveRequest {
  repoPath: string;
  remote: string;
  machine: string;
  /** The person at the board: the line's writer and the commit's author. */
  by: string;
  /** The settings as they stand, to the settings to write; throws `SaveRefused` when the result is not valid. */
  update(current: Obj): Obj;
}

/** Thrown by `SaveRequest.update`: the save is refused with this text, and nothing is written. */
export class SaveRefused extends Error {}

export type SaveResult =
  | { ok: true; commit: string | null; changed: boolean; changes: SettingChange[]; sharing: { state: "local" | "shared" | "pending"; problem?: string } }
  | { ok: false; refused: boolean; error: string };

/** One save in the settings' log, for History. */
export interface SettingsLogEntry {
  at: string;
  who: string;
  machine?: string;
  changes: SettingChange[];
}

/** Where the shared settings are read from and saved to: the meta ref (metaSettings.ts); tests give `memorySettings`. */
export interface SharedSettings {
  read(repoPath: string): SharedRead;
  /** Without it a save of a shared setting is refused. */
  save?(request: SaveRequest): Promise<SaveResult>;
  /** The settings' log, newest first. */
  log?(repoPath: string): SettingsLogEntry[];
}

/** Parses a shared read, or says why it cannot be used. */
export function parseShared(read: SharedRead): { ok: true; raw: unknown; text: string; commit: string } | { ok: false; error: string } {
  if (!read.ok) return read;
  try {
    return { ok: true, raw: JSON.parse(read.text), text: read.text, commit: read.commit };
  } catch (error) {
    return { ok: false, error: `${SHARED_WHERE} are not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** A plain file as the shared settings, read only: `--shared`, and tests. */
export function fileSettings(path: string): SharedSettings {
  return {
    read() {
      try {
        return { ok: true, text: readFileSync(path, "utf8"), commit: "file" };
      } catch (error) {
        return { ok: false, error: `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}

/** Shared settings kept in memory, for tests: a save is one "commit" and one log line, as on the meta ref. */
export function memorySettings(initial: Obj | null, now: () => string = () => new Date().toISOString()): SharedSettings & { current(): Obj | null; saves: number } {
  let current: Obj | null = initial === null ? null : structuredClone(initial);
  const entries: SettingsLogEntry[] = [];
  const state = {
    saves: 0,
    current: () => current,
    read(): SharedRead {
      return current === null ? { ok: false, error: `There are no shared settings yet (${SHARED_WHERE}).` } : { ok: true, text: settingsText(current), commit: `memory-${state.saves}` };
    },
    async save(request: SaveRequest): Promise<SaveResult> {
      let next: Obj;
      try {
        next = request.update(structuredClone(current ?? {}));
      } catch (error) {
        return { ok: false, refused: error instanceof SaveRefused, error: error instanceof Error ? error.message : String(error) };
      }
      const changes = settingChanges(current ?? {}, next);
      if (changes.length === 0) return { ok: true, commit: null, changed: false, changes: [], sharing: { state: "local" } };
      current = next;
      state.saves++;
      entries.unshift({ at: now(), who: request.by, machine: request.machine, changes });
      return { ok: true, commit: `memory-${state.saves}`, changed: true, changes, sharing: { state: "local" } };
    },
    log: () => [...entries],
  };
  return state;
}
