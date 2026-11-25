// Changes the configuration file from the board. Only the safe fields may change: the level,
// parallel sessions, the usage reserve, the age of a triage and the three models; the setup of a fresh clone; and, saved with level 4 only,
// the check command and the remote's URL that level needs; the limited resources; singleplayer or multiplayer; a Jira host's filter and components. Everything else is
// file-only, with its defaults.
// A change is merged into the file as it is on disk, validated as a whole, and written atomically. A file of an older
// format is migrated first, so a save always writes the current format, with `version`.
// A project setting (the level, the check, the setup, the models, the age of a triage) is in the shared
// settings on the meta ref and is saved as one commit there, which takes effect at once; parallel sessions, the usage reserve
// and the remote's URL are this machine's, saved into its private file.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_MODELS, DEFAULT_SETUP_WATCH } from "./defaults.ts";
import { checkCommandProblem, type MergeQueueOptions, type MergeQueueSetup, mergeQueueSetup } from "./mergeQueue.ts";
import { type LevelChoice, levelChoices } from "./levels.ts";
import { CONFIG_VERSION, migrateConfig } from "./migrate.ts";
import { programFound } from "./program.ts";
import { type Sliders, SLIDERS } from "./sliders.ts";
import type { Level, ProjectConfig } from "./types.ts";
import { mergeQueueCi } from "./types.ts";
import { metaSettings } from "./metaSettings.ts";
import { parseShared, PRIVATE_KEYS, PRIVATE_SETTINGS, repositoryOf, SaveRefused, type SettingChange, SHARED_KEYS, SHARED_SETTINGS, SHARED_WHERE, type SharedSettings, validateFiles } from "./shared.ts";
import { configText, writeConfigFile } from "./write.ts";
import { recordInManifest } from "./manifest.ts";

type Obj = Record<string, unknown>;

/**
 * The fields the board may change, and inside each what may be given. `true` means any value (validation decides);
 * a function checks the names and keys allowed one level down.
 */
const SETTING_NAMES = ["maxParallelSessions", "budgetReserve", "triageMaxAgeDays"];
const ROLE_NAMES = ["triage", "implement", "review"];
const SAFE: Record<string, true | ((value: unknown, err: (message: string) => void) => void)> = {
  level: true,
  // Numbers; validation holds them within their bounds. No reason is asked for.
  settings: (value, err) => nested(value, "settings", SETTING_NAMES, ["value"], err),
  // The model per role (null or "" removes it, so the role runs on its default model). allowedTools, permissionMode and maxTurns govern what a session may do.
  roles: (value, err) => nested(value, "roles", ROLE_NAMES, ["model", "effort"], err),
  // What level 4 needs, saved together with `level: 4` (refused below it); validation checks their form.
  checkCommand: true,
  remoteUrl: true,
  // The setup of a fresh clone, at any level; null removes it (no setup, or the default watched files).
  setupCommand: true,
  setupWatch: true,
  // The limited resources, each list whole (this machine's, and the shared ones on the meta ref); null removes the list.
  resources: true,
  sharedResources: true,
  // Agents' images: pushed to the remote or not, and how long a closed Item's are kept (validation checks the form).
  media: true,
  // What a reviewer's `should` findings on an approved change do: "fix" or "draft" (decision 95).
  review: true,
  // The label on Items an AI made or rewrote: false, true or a name (decision 97).
  labels: true,
  // Singleplayer (false) or multiplayer (true): this machine's, in its private file (decision 93).
  multiplayer: true,
  // A Jira host's filter and the components of new Items (#141); null or empty removes one. Everything else of the host changes
  // only through Connect.
  host: (value, err) => {
    if (!isObj(value)) return void err("host must be an object.");
    for (const key of Object.keys(value)) if (!HOST_FIELDS.includes(key)) err(`host.${key} cannot be changed from the board: the host is changed with Connect. The board changes host.${HOST_FIELDS.join(" and host.")} of a Jira host.`);
  },
};

/** The host's keys Settings may change, on a Jira host. */
const HOST_FIELDS = ["filter", "components"];

/** Fields a null in the change removes from the file. */
const REMOVABLE = ["setupCommand", "setupWatch", "resources", "sharedResources"];

/** The fields saved only with level 4. */
const MERGE_QUEUE_FIELDS = ["checkCommand", "remoteUrl"];

export const SAFE_FIELDS = Object.keys(SAFE);

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names that reach an object's prototype; never looked up or merged. */
const FORBIDDEN = ["__proto__", "constructor", "prototype"];

/** `{ name: { key: ... } }` where each name is one of `names` and each key one of `allowed`. */
function nested(value: unknown, field: string, names: string[], allowed: string[], err: (message: string) => void): void {
  if (!isObj(value)) return void err(`${field} must be an object.`);
  for (const [name, entry] of Object.entries(value)) {
    if (FORBIDDEN.includes(name)) {
      err(`${field}.${name} is not a name the board can change.`);
      continue;
    }
    if (!names.includes(name)) {
      err(`${field}.${name} cannot be changed from the board. Edit the configuration file. The board changes ${field} ${names.join(", ")}.`);
      continue;
    }
    if (!isObj(entry)) {
      err(`${field}.${name} must be an object.`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!allowed.includes(key)) err(`${field}.${name}.${key} cannot be changed from the board. Edit the configuration file, or run the onboarding skill.`);
    }
  }
}

/** Objects merge key by key, keeping the target's order; anything else replaces. Prototype names are skipped. */
function merge(target: unknown, change: unknown): unknown {
  if (!isObj(target) || !isObj(change)) return change;
  const out: Obj = { ...target };
  for (const [key, value] of Object.entries(change)) {
    if (FORBIDDEN.includes(key)) continue;
    out[key] = merge(Object.hasOwn(target, key) ? target[key] : undefined, value);
  }
  return out;
}

/** A null or empty `roles.<role>.model` or `effort` removes it from the file, so the role runs on its default. */
function dropClearedModels(next: Obj, change: Obj): void {
  if (!isObj(change.roles) || !isObj(next.roles)) return;
  for (const [name, entry] of Object.entries(change.roles)) {
    if (FORBIDDEN.includes(name) || !isObj(entry)) continue;
    const role = next.roles[name];
    if (!isObj(role)) continue;
    for (const key of ["model", "effort"]) if (entry[key] === null || entry[key] === "") delete role[key];
    if (Object.keys(role).length === 0) delete next.roles[name];
  }
  if (Object.keys(next.roles).length === 0) delete next.roles;
}

/** A null or empty `host.filter` or `host.components` removes it: every issue of the project is an Item, new ones get no component. */
function dropClearedHost(next: Obj, change: Obj): void {
  if (!isObj(change.host) || !isObj(next.host)) return;
  for (const key of HOST_FIELDS) {
    const given = change.host[key];
    if (given === null || (typeof given === "string" && given.trim() === "") || (Array.isArray(given) && given.length === 0)) delete next.host[key];
  }
}

/** A number saved from the board drops the file's reason for it, which described the old value. */
function dropStaleReasons(next: Obj, change: Obj): void {
  if (!isObj(change.settings) || !isObj(next.settings)) return;
  for (const name of Object.keys(change.settings)) {
    const setting = Object.hasOwn(next.settings, name) ? next.settings[name] : undefined;
    if (isObj(setting)) delete setting.reason;
  }
}

/** A level change as the event records it. */
export interface LevelChange {
  from: Level;
  to: Level;
}

/** A shared change was saved on the meta ref: the commit, what changed, and whether the remote has it yet. */
export interface SharedSaved {
  commit: string | null;
  changes: SettingChange[];
  sharing: { state: "local" | "shared" | "pending"; problem?: string };
}

export type EditResult =
  | { ok: true; config: ProjectConfig; raw: Obj; changed: boolean; level?: LevelChange; shared?: SharedSaved }
  | { ok: false; status: 400 | 500; errors: string[] }
  | { ok: false; status: 409; errors: string[]; players: { mine: PlayersSide; theirs: PlayersSide; backup: string } };

/** One side of a switch to multiplayer: the project's name and host, as each side's shared settings name them. */
export interface PlayersSide {
  project: string | null;
  host: string;
}

/** How a program is looked up for the level's needs; tests give a fake so they never depend on the machine's agent CLI. */
export interface EditOptions {
  programFound?: (command: string) => boolean;
  /** Why a check command cannot be started, or null (`checkCommandProblem` in mergeQueue.ts); tests give a fake. */
  checkCommandProblem?: (command: readonly string[], repoPath: string) => string | null;
  /** For level 4's proposals in the view: the environment, platform and `git remote get-url` (`mergeQueue.ts`). */
  mergeQueue?: MergeQueueOptions;
  /** Where the shared settings are read from and saved to: the meta ref by default. */
  shared?: SharedSettings;
  /** The person who saves, named in the meta commit and the settings' log. A shared change needs one. */
  by?: string;
  /**
   * A switch to multiplayer when the remote's shared settings name another host or project: "join" (this clone's meta ref backed
   * up under `backupRef`, the remote's used) or "mine" (this clone's settings pushed over the project's, for every machine).
   */
  players?: "join" | "mine";
}

let defaultShared: SharedSettings | null = null;
const sharedOf = (options: EditOptions): SharedSettings => options.shared ?? (defaultShared ??= metaSettings());

/** Splits a change from the Settings page into the shared settings' part and the private file's part, by the key sets. */
export function splitChange(change: Obj): { shared: Obj; own: Obj } {
  const shared: Obj = {};
  const own: Obj = {};
  for (const [key, value] of Object.entries(change)) {
    if (key === "settings" && isObj(value)) {
      const mine = Object.fromEntries(Object.entries(value).filter(([name]) => PRIVATE_SETTINGS.includes(name)));
      const ours = Object.fromEntries(Object.entries(value).filter(([name]) => !PRIVATE_SETTINGS.includes(name)));
      if (Object.keys(mine).length > 0) own.settings = mine;
      if (Object.keys(ours).length > 0) shared.settings = ours;
    } else if (PRIVATE_KEYS.includes(key)) own[key] = value;
    else shared[key] = value;
  }
  return { shared, own };
}

type Files = { path: string; text: string; raw: Obj; shared: { raw: Obj; text: string; commit: string }; repoPath: string; remote: string; metaRemote: string | null; machine: string | null };

/** Reads the private file and the shared settings of the repository it names. */
function readFiles(file: string, options: EditOptions): { ok: true; files: Files } | { ok: false; errors: string[] } {
  const path = resolve(file);
  let text: string;
  let raw: unknown;
  try {
    text = readFileSync(path, "utf8");
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isObj(raw)) return { ok: false, errors: [`${path} is not a JSON object.`] };
  const where = repositoryOf(raw, dirname(path));
  const read = parseShared(sharedOf(options).read(where.repoPath));
  if (!read.ok) return { ok: false, errors: [read.error] };
  if (!isObj(read.raw)) return { ok: false, errors: [`${SHARED_WHERE} must be a JSON object.`] };
  return { ok: true, files: { path, text, raw, shared: { raw: read.raw, text: read.text, commit: read.commit }, ...where } };
}

/** The change merged into one file's raw object, with the removals the board's fields allow. */
function applied(raw: Obj, change: Obj): Obj {
  const next = merge(raw, change) as Obj;
  dropClearedModels(next, change);
  dropClearedHost(next, change);
  for (const key of REMOVABLE) if (Object.hasOwn(change, key) && change[key] === null) delete next[key];
  dropStaleReasons(next, change);
  return next;
}

/**
 * Saves the shared part as one meta commit, made on the settings as they stand at the save (`update`) and checked again with
 * this machine's next file. `fields` names what is saved, for the refusals.
 */
async function saveShared(files: Files, nextOwn: Obj, multiplayer: boolean, fields: string[], update: (current: Obj) => Obj, options: EditOptions): Promise<{ ok: true; saved: SharedSaved | undefined } | { ok: false; status: 400 | 500; errors: string[] }> {
  const store = sharedOf(options);
  const named = fields.join(", ");
  const are = fields.length === 1 ? "is a project setting" : "are project settings";
  if (!store.save) return { ok: false, status: 400, errors: [`${named} ${are} in ${SHARED_WHERE}, and this Scope Soup cannot write them.`] };
  if (!options.by) return { ok: false, status: 400, errors: [`${named} ${are}, shared by every machine, and a save names who made it: pick who you are at the top of the board first.`] };
  if (!files.machine) return { ok: false, status: 400, errors: ["machineName is missing from this machine's scopesoup.config.json: a save of the shared settings names the machine."] };
  const base = dirname(files.path);
  const done = await store.save({
    repoPath: files.repoPath,
    remote: files.remote,
    // Pushed in multiplayer only, as the private file stands after this save.
    multiplayer,
    machine: files.machine,
    by: options.by,
    update: (current) => {
      const next = update(current);
      const checked = validateFiles(nextOwn, next, base);
      if (!checked.ok) throw new SaveRefused(checked.errors.join(" "));
      return next;
    },
  });
  if (!done.ok) return { ok: false, status: done.refused ? 400 : 500, errors: [`The shared settings were not saved, and nothing was changed: ${done.error}`] };
  return { ok: true, saved: done.changed ? { commit: done.commit, changes: done.changes, sharing: done.sharing } : undefined };
}

/** The host in words, from a shared `host` value: what the switch to multiplayer compares and shows. */
function hostWords(host: unknown): string {
  if (!isObj(host)) return "none (from the environment)";
  if (host.kind === "github") return `GitHub Issues ${String(host.repo)}`;
  if (host.kind === "jira") return `Jira ${String(host.site)} project ${String(host.project)}`;
  if (host.kind === "metaBranch") return "the meta branch";
  return String(host.kind);
}

/** Where "Join theirs" keeps this clone's meta ref: named after its commit, so the question and the join name the same ref. */
export const backupRef = (commit: string): string => `refs/scopesoup-backup/meta-${commit.slice(0, 12)}`;

/**
 * Before a switch from singleplayer to multiplayer: the remote's shared settings. When they name another project or host, the switch
 * waits for a person's choice (409 with both sides), unless `players` gives it: "join" uses the remote's (the caller adopts them
 * after every other check), "mine" goes on, and the meta writer puts this clone's commits on top of the project's. Null: nothing to
 * ask (no remote ref, the same project and host, or no way to read the remote here).
 */
async function joinCheck(files: Files, options: EditOptions): Promise<{ ok: true; commit: string; raw: Obj; backup: string } | Extract<EditResult, { ok: false }> | null> {
  const store = sharedOf(options);
  if (!store.remote) return null;
  const theirs = await store.remote(files.repoPath, files.remote);
  if (!theirs.ok) return { ok: false, status: 400, errors: [`${theirs.error} Multiplayer joins the project's shared settings there, so it was not switched on.`] };
  if (theirs.raw === null || theirs.commit === null) return null;
  const mine: PlayersSide = { project: typeof files.shared.raw.project === "string" ? files.shared.raw.project : null, host: hostWords(files.shared.raw.host) };
  const other: PlayersSide = { project: typeof theirs.raw.project === "string" ? theirs.raw.project : null, host: hostWords(theirs.raw.host) };
  if (mine.project === other.project && mine.host === other.host) return null;
  if (options.players === "mine") return null;
  const backup = backupRef(files.shared.commit);
  if (options.players !== "join") {
    return {
      ok: false, status: 409,
      errors: [`The remote's shared settings name ${other.project ?? "no project"} on ${other.host}; this clone's name ${mine.project ?? "no project"} on ${mine.host}. Join theirs: this clone's settings, and its Items that were never shared, leave the board and are kept only in ${backup}. Or make yours the project's, for every machine.`],
      players: { mine, theirs: other, backup },
    };
  }
  if (!store.adopt) return { ok: false, status: 400, errors: ["This Scope Soup cannot replace the meta ref here."] };
  return { ok: true, commit: theirs.commit, raw: theirs.raw, backup };
}

/**
 * Reads both, merges the change into each one's part (shared keys into the shared settings on the meta ref, this
 * machine's into its private file), validates the two together, and only then writes: the shared part as one meta commit
 * (`shared.save`, compare-and-swap: made again and checked again on the newest settings if another save was first), then the
 * private file. A new level comes back as `level` (from, to) for the event. A level whose needs are missing is refused.
 * A shared change takes effect at once here, and on the other machines at their next fetch of the meta ref.
 */
export async function editConfig(file: string, change: unknown, options: EditOptions = {}): Promise<EditResult> {
  if (!isObj(change)) return { ok: false, status: 400, errors: ["The change must be a JSON object of fields to change."] };
  const errors: string[] = [];
  const err = (message: string): void => void errors.push(message);
  for (const [key, value] of Object.entries(change)) {
    const rule = Object.hasOwn(SAFE, key) ? SAFE[key] : undefined;
    if (rule === undefined) err(`${key} cannot be changed from the board. Edit the configuration, or run the onboarding skill. Fields the board may change: ${SAFE_FIELDS.join(", ")}.`);
    else if (rule !== true) rule(value, err);
  }
  if (errors.length > 0) return { ok: false, status: 400, errors };

  const read = readFiles(file, options);
  if (!read.ok) return { ok: false, status: 500, errors: read.errors };
  // Singleplayer to multiplayer: the remote's shared settings first (decision 98). Joining them is checked against them, and
  // done only after every other check, just before this machine's file is written.
  let join: { commit: string; raw: Obj; backup: string } | undefined;
  if (change.multiplayer === true && read.files.raw.multiplayer === false) {
    const players = await joinCheck(read.files, options);
    if (players) {
      if (!players.ok) return players;
      join = players;
    }
  }
  const { path, text, raw } = read.files;
  const shared = join ? { ...read.files.shared, raw: join.raw } : read.files.shared;
  const files = read.files;
  const migrated = migrateConfig(raw);
  if (!migrated.ok) return { ok: false, status: 400, errors: migrated.errors };
  const parts = splitChange(change);
  if (join && Object.keys(parts.shared).length > 0) return { ok: false, status: 400, errors: [`Join theirs saves only the switch to multiplayer; save ${Object.keys(parts.shared).join(", ")} again after it.`] };
  if (Object.hasOwn(parts.shared, "host") && !(isObj(shared.raw.host) && shared.raw.host.kind === "jira")) {
    return { ok: false, status: 400, errors: ["host.filter and host.components are a Jira host's: the project's host is not Jira."] };
  }
  const nextOwn = applied(migrated.raw, parts.own);
  const nextShared = applied(shared.raw, parts.shared);
  const result = validateFiles(nextOwn, nextShared, dirname(path));
  if (!result.ok) return { ok: false, status: 400, errors: result.errors };
  const mergeQueue = MERGE_QUEUE_FIELDS.filter((key) => Object.hasOwn(change, key));
  if (mergeQueue.length > 0 && result.config.level !== 4) {
    return { ok: false, status: 400, errors: [`${mergeQueue.join(" and ")} can be saved from the board only with level 4 (Autopilot). Edit the configuration, or pick level 4.`] };
  }
  // A cheap test that the check command can be started; the check itself is not run on save.
  if (Object.hasOwn(change, "checkCommand") && result.config.checkCommand) {
    const problem = (options.checkCommandProblem ?? ((command, repo) => checkCommandProblem(command, repo, options.mergeQueue)))(result.config.checkCommand, result.config.repoPath);
    if (problem) return { ok: false, status: 400, errors: [`checkCommand cannot be run: ${problem}`] };
  }

  const before = validateFiles(raw, shared.raw, dirname(path));
  let level: LevelChange | undefined;
  if (Object.hasOwn(change, "level")) {
    const from: Level = before.ok ? before.config.level : 0;
    const to = result.config.level;
    if (!before.ok || from !== to) {
      const blocked = levelChoices(result.config, options.programFound ?? programFound)[to]?.blocked;
      if (blocked) return { ok: false, status: 400, errors: [blocked] };
      level = { from, to };
    }
  }

  let saved: SharedSaved | undefined;
  const sharedFields = Object.keys(parts.shared);
  if (sharedFields.length > 0 && JSON.stringify(nextShared) !== JSON.stringify(shared.raw)) {
    const done = await saveShared(files, nextOwn, result.config.multiplayer, sharedFields, (current) => applied(current, parts.shared), options);
    if (!done.ok) return done;
    saved = done.saved;
  }

  // Join theirs, last: this clone's meta ref kept under the backup ref, then the remote's used; undone if the file cannot be written.
  let undo: (() => Promise<void>) | undefined;
  if (join) {
    try {
      undo = await sharedOf(options).adopt!(files.repoPath, files.remote, join.commit, join.backup);
    } catch (error) {
      return { ok: false, status: 500, errors: [`Joining the remote's settings failed, and nothing was changed: ${error instanceof Error ? error.message : String(error)}`] };
    }
    recordInManifest(path, [{ kind: "ref", ref: join.backup, what: "this clone's meta ref before it joined the remote's (Join theirs)" }], "scopesoup");
  }
  const out = configText(nextOwn, text);
  const ownChanged = out !== text;
  if (ownChanged) {
    // An older file is migrated by the save as it would be at start: with a copy of the old file beside it.
    const failed = writeConfigFile(path, out, migrated.from < CONFIG_VERSION ? { version: migrated.from } : undefined);
    if (failed) {
      if (undo) await undo().catch(() => undefined);
      return { ok: false, status: 500, errors: [saved ? `${failed} The shared settings were saved (${saved.commit?.slice(0, 7) ?? ""}).` : `${failed}${undo ? " The meta ref was put back as it was." : ""}`] };
    }
  }
  if (!ownChanged && !saved) return { ok: true, config: result.config, raw: nextOwn, changed: false };
  return { ok: true, config: result.config, raw: nextOwn, changed: true, ...(level ? { level } : {}), ...(saved ? { shared: saved } : {}) };
}

/** The host keys the Settings page's connect dialogs set; a reconnect to the same kind keeps the file's other host keys. */
const CONNECT_KEYS = ["kind", "repo", "site", "project", "deployment", "filter", "components", "write"];

/**
 * A host to connect to from Settings (#127): the shared `host`, and on Jira Cloud this machine's `jira.email`; for the meta branch
 * (#134) this machine's `meta` part (who its meta commits are made as, and the prefix of its Items' ids).
 */
export interface HostConnection {
  host: Obj;
  email?: string;
  meta?: MetaPart;
}

/** This machine's part of a meta branch host, in its private file as `meta`. */
export interface MetaPart {
  authorName: string;
  authorEmail: string;
  prefix: string;
}

/** This machine's `meta` part as its private file has it now (kept while another host is in use), or nothing. */
export function metaPartOf(file: string): Partial<MetaPart> {
  try {
    const raw = JSON.parse(readFileSync(resolve(file), "utf8")) as unknown;
    const meta = isObj(raw) && isObj(raw.meta) ? raw.meta : {};
    return Object.fromEntries(["authorName", "authorEmail", "prefix"].filter((key) => typeof meta[key] === "string").map((key) => [key, meta[key]])) as Partial<MetaPart>;
  } catch {
    return {};
  }
}

/**
 * Connects the project to another host: `host` in the shared settings (one meta commit, as any project setting), and in this
 * machine's file `jira.email` for Jira Cloud; the other hosts' parts of this machine stay. `join` sets this machine up for the
 * host the project has and leaves the shared settings alone. Checked as a whole first; `dryRun` stops there and writes nothing.
 * Items are moved by the caller (`src/items/moveToHost.ts`).
 */
export async function connectHost(file: string, connection: HostConnection, options: EditOptions & { dryRun?: boolean; join?: boolean } = {}): Promise<EditResult> {
  if (!isObj(connection.host) || FORBIDDEN.some((key) => Object.hasOwn(connection.host, key))) return { ok: false, status: 400, errors: ["host must be an object."] };
  const read = readFiles(file, options);
  if (!read.ok) return { ok: false, status: 500, errors: read.errors };
  const files = read.files;
  const migrated = migrateConfig(files.raw);
  if (!migrated.ok) return { ok: false, status: 400, errors: migrated.errors };
  const withHost = (current: Obj): Obj => {
    const old = isObj(current.host) && current.host.kind === connection.host.kind ? Object.fromEntries(Object.entries(current.host).filter(([key]) => !CONNECT_KEYS.includes(key))) : {};
    return { ...current, host: { ...old, ...connection.host } };
  };
  // This machine's part of each host stays side by side (`meta`, `jira`): only the active host's is read (decision 98).
  const nextOwn: Obj = { ...migrated.raw };
  if (connection.email !== undefined) nextOwn.jira = { ...(isObj(nextOwn.jira) ? nextOwn.jira : {}), email: connection.email };
  if (connection.meta !== undefined) nextOwn.meta = { ...(isObj(nextOwn.meta) ? nextOwn.meta : {}), ...connection.meta };
  const nextShared = options.join ? files.shared.raw : withHost(files.shared.raw);
  const result = validateFiles(nextOwn, nextShared, dirname(files.path));
  if (!result.ok) return { ok: false, status: 400, errors: result.errors };
  if (options.dryRun) return { ok: true, config: result.config, raw: nextOwn, changed: false };
  let saved: SharedSaved | undefined;
  if (JSON.stringify(nextShared) !== JSON.stringify(files.shared.raw)) {
    const done = await saveShared(files, nextOwn, result.config.multiplayer, ["host"], withHost, options);
    if (!done.ok) return done;
    saved = done.saved;
  }
  const out = configText(nextOwn, files.text);
  const ownChanged = out !== files.text;
  if (ownChanged) {
    const failed = writeConfigFile(files.path, out, migrated.from < CONFIG_VERSION ? { version: migrated.from } : undefined);
    if (failed) return { ok: false, status: 500, errors: [saved ? `${failed} The shared settings were saved (${saved.commit?.slice(0, 7) ?? ""}).` : failed] };
  }
  return { ok: true, config: result.config, raw: nextOwn, changed: ownChanged || saved !== undefined, ...(saved ? { shared: saved } : {}) };
}

/**
 * What `GET /api/config` shows: both files as one (`raw`, no key is in both, so nothing says which file it is in), as
 * Scope Soup reads them (with defaults), the level picker's rows, and `mergeQueue`, what level 4 would ask for.
 */
export type ConfigView =
  | { present: false }
  | { present: true; file: string; raw: unknown; config: ProjectConfig | null; errors: string[]; safeFields: string[]; sharedFields: string[]; sliders: Sliders; defaultModels: Readonly<Record<string, string>>; setupWatchDefault: readonly string[]; levels: LevelChoice[]; mergeQueue: MergeQueueSetup | null };

export function readConfigView(file: string | undefined, options: EditOptions = {}): ConfigView {
  if (file === undefined) return { present: false };
  const path = resolve(file);
  // Which of the page's fields are shared by every machine (saved on the meta ref); the rest are this machine's.
  const sharedFields = [...SAFE_FIELDS.filter((key) => SHARED_KEYS.includes(key) && key !== "settings"), ...SETTING_NAMES.filter((name) => SHARED_SETTINGS.includes(name)).map((name) => `settings.${name}`)];
  const common = { file: path, safeFields: SAFE_FIELDS, sharedFields, sliders: SLIDERS, defaultModels: DEFAULT_MODELS, setupWatchDefault: DEFAULT_SETUP_WATCH };
  const read = readFiles(path, options);
  if (!read.ok) return { present: true, ...common, raw: null, config: null, errors: read.errors, levels: [], mergeQueue: null };
  const result = validateFiles(read.files.raw, read.files.shared.raw, dirname(path));
  if (!result.ok) return { present: true, ...common, raw: result.combined ?? null, config: null, errors: result.errors, levels: [], mergeQueue: null };
  const levels = levelChoices(result.config, options.programFound ?? programFound);
  // Level 4's needs, proposed for the page to ask for: while one is missing, or while the check command is the
  // project's own, so the page can show the check question with the candidates found in the repository. git is read only for a
  // missing remote URL.
  const mergeQueue = (levels[4]?.asks.length ?? 0) > 0 || mergeQueueCi(result.config) === "local" ? mergeQueueSetup(result.config, options.mergeQueue) : null;
  // The same test of the command as a save makes, when one is given (tests and the demo look at no PATH).
  if (mergeQueue?.checkCommand && options.checkCommandProblem) mergeQueue.checkCommandProblem = options.checkCommandProblem(mergeQueue.checkCommand, result.config.repoPath);
  return { present: true, ...common, raw: result.combined, config: result.config, errors: [], levels, mergeQueue };
}
