// Hand-written validation of the configuration file. Collects every problem, in words a person
// can act on, instead of stopping at the first.

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRole } from "../model/types.ts";
import { COPILOT_DEFAULT_AUTO_TIER, COPILOT_DEFAULT_MODEL, defaultClaude, defaultCopilot, defaultRoles, defaultSettings, expandScopesoup, MACHINE_NAME } from "./defaults.ts";
import type { LabelsConfig, Level, McpServer, ProjectConfig, ProviderName, RoleConfig, SettingName, Settings } from "./types.ts";
import { AI_LABEL_DEFAULT, EFFORT_LEVELS, LEVELS, mcpToolEntry, PROVIDER_NAMES, ROLES } from "./types.ts";
import { CHECK_ROLES, withCheckRules } from "./checkRule.ts";
import { proposeCheckCommand } from "./mergeQueue.ts";
import { migrateConfig } from "./migrate.ts";
import type { HostConfig, JiraHostConfig, MediaConfig, MergeQueueConfig, ResourceConfig, ReviewConfig, ResourceUser, WorkspacesConfig } from "./types.ts";
import { RESOURCE_USERS, SHOULD_FINDINGS } from "./types.ts";
import { DEFAULT_CI_TIMEOUT_MINUTES } from "./types.ts";
import { win32 } from "node:path";

/**
 * `notices`: what the migration to the current format changed (migrate.ts), one line each; empty for a file in the
 * current format. `from`: the file's format before that; `raw`: the file in the current format, for the loader to write.
 */
export type ConfigResult = { ok: true; config: ProjectConfig; notices: string[]; from: number; raw: Record<string, unknown> } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;

/** `machineName` has no default: two machines with the same name would treat each other's claims as their own. */
export const MACHINE_NAME_MISSING = `machineName is required: this machine's name in claims and log lines, for example "machineName": "desk". Give every machine that shares the project its own name: two machines with the same name treat each other's claims as their own.`;

/** In setupCommand, this machine's own clone. */
export const OWN_CLONE = "{{ownClone}}";

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk"];

/** Where each number must lie. Fractions are 0 to just under 1; the rest are whole numbers. */
const SETTING_RANGES: Record<SettingName, { min: number; max: number; whole: boolean }> = {
  maxParallelSessions: { min: 1, max: 32, whole: true },
  tickSeconds: { min: 1, max: 3600, whole: true },
  stallTimeoutMinutes: { min: 1, max: 1440, whole: false },
  sessionTimeoutMinutes: { min: 1, max: 1440, whole: false },
  reserveFiveHour: { min: 0, max: 0.99, whole: false },
  reserveSevenDay: { min: 0, max: 0.99, whole: false },
  budgetReserve: { min: 1, max: 5, whole: true },
  persistence: { min: 1, max: 5, whole: true },
  retryBackoffCapSeconds: { min: 10, max: 86400, whole: true },
  checkTimeoutMinutes: { min: 1, max: 1440, whole: false },
  queueMinBatch: { min: 1, max: 100, whole: true },
  queueMaxBatch: { min: 1, max: 100, whole: true },
  queueRerunCost: { min: 0, max: 2, whole: false },
  queueMinOutcomes: { min: 1, max: 1000, whole: true },
  triageMaxAgeDays: { min: 1, max: 365, whole: true },
};

/** Settings that older files carry and that stay accepted; absent from the defaults. */
const LEGACY_SETTINGS = ["reserveFiveHour", "reserveSevenDay"];

const TOP_KEYS = [
  "workspaces", "remoteUrl", "checkCommand", "rerunFilesCommand", "setupCommand", "setupWatch",
  "version", "project", "repoPath", "ownClone", "mainBranch", "remote", "realPaths", "level", "keepAwake", "multiplayer", "machineName", "workspacesDir",
  "streamsDir", "promptsDir", "bugLabels", "claude", "copilot", "settings", "roles", "host", "mergeQueue", "resources", "sharedResources", "media", "review", "labels",
];

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the parsed file. An older format is first brought to the current one in memory (migrate.ts; the loader
 * writes it). Relative paths are resolved against `baseDir` (the file's directory).
 */
export function validateConfig(given: unknown, baseDir: string): ConfigResult {
  const migrated = migrateConfig(given);
  if (!migrated.ok && migrated.raw === undefined) return { ok: false, errors: migrated.errors };
  const raw = migrated.raw!;
  const from = migrated.ok ? migrated.from : 0;
  const notices = migrated.ok ? migrated.changes : [];
  const errors: string[] = migrated.ok ? [] : [...migrated.errors];
  const err = (message: string): void => void errors.push(message);

  const unknownKeys = (obj: Obj, known: readonly string[], where: string): void => {
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) err(`${where}: unknown key "${key}". Known keys: ${known.join(", ")}.`);
    }
  };
  const str = (obj: Obj, key: string, where: string, fallback?: string): string => {
    const value = obj[key];
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "string" || value.trim() === "") {
      err(`${where}${key} must be a non-empty string.`);
      return fallback ?? "";
    }
    return value;
  };
  const bool = (obj: Obj, key: string, where: string, fallback: boolean): boolean => {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      err(`${where}${key} must be true or false.`);
      return fallback;
    }
    return value;
  };
  const strList = (obj: Obj, key: string, where: string, fallback: string[]): string[] => {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
      err(`${where}${key} must be a list of non-empty strings.`);
      return fallback;
    }
    return value as string[];
  };
  const num = (value: unknown, where: string, min: number, max: number, whole: boolean, fallback: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
      err(`${where} must be a ${whole ? "whole " : ""}number from ${min} to ${max}.`);
      return fallback;
    }
    return value;
  };
  const path = (value: string): string => (isAbsolute(value) ? resolve(value) : resolve(baseDir, value));

  unknownKeys(raw, TOP_KEYS, "Top level");

  const project = str(raw, "project", "");
  const repoPath = path(str(raw, "repoPath", "", undefined) || ".");
  const mainBranch = str(raw, "mainBranch", "", "main");
  const remote = str(raw, "remote", "", "origin");
  if (/\s/.test(remote) || remote.startsWith("-")) err(`remote must be a git remote name: no spaces, not starting with "-".`);
  const realPaths = strList(raw, "realPaths", "", []).map(path);
  // This machine's own clone, which a setup script copies personal files from: `{{ownClone}}` in setupCommand.
  const ownClone = raw.ownClone === undefined ? undefined : path(str(raw, "ownClone", ""));
  const keepAwake = bool(raw, "keepAwake", "", true);
  // Singleplayer (false) keeps everything under refs/scopesoup/* in this clone; this machine's choice (decision 93).
  const multiplayer = bool(raw, "multiplayer", "", true);
  let machineName = "";
  if (raw.machineName === undefined) err(MACHINE_NAME_MISSING);
  else if (typeof raw.machineName !== "string" || !MACHINE_NAME.test(raw.machineName)) err('machineName must be 1 to 40 letters, digits, "-", "_" or ".", for example "desk". Hosts show it in claims and log lines.');
  else machineName = raw.machineName;
  const workspacesDir = path(str(raw, "workspacesDir", "", "data/workspaces"));
  const streamsDir = path(str(raw, "streamsDir", "", "data/streams"));
  const promptsDir = raw.promptsDir === undefined
    ? fileURLToPath(new URL("../../prompts", import.meta.url))
    : path(str(raw, "promptsDir", ""));
  const bugLabels = strList(raw, "bugLabels", "", ["bug"]);

  // --- the level ---
  let level: Level = 0;
  if (raw.level !== undefined) {
    if (typeof raw.level !== "number" || !(LEVELS as readonly number[]).includes(raw.level)) err("level must be a whole number from 0 to 4: 0 Watch, 1 Triage, 2 Implement, 3 Review, 4 Autopilot.");
    else level = raw.level as Level;
  }
  let remoteUrl: string | undefined;
  if (raw.remoteUrl !== undefined) {
    if (typeof raw.remoteUrl !== "string" || raw.remoteUrl.trim() === "") err("remoteUrl must be a non-empty string.");
    else remoteUrl = raw.remoteUrl.trim();
  }
  if (level === 4 && remoteUrl === undefined) {
    err(`level 4 (Autopilot) needs remoteUrl: the repository the main branch is pushed to, as \`git remote get-url\` shows it. Scope Soup checks the remote against it before every push.`);
  }
  let mergeQueue: MergeQueueConfig | undefined;
  if (raw.mergeQueue !== undefined) {
    if (isObj(raw.mergeQueue)) mergeQueue = mergeQueueOf(raw.mergeQueue, err);
    else err('mergeQueue must be an object: "ci" and "ciTimeoutMinutes".');
  }
  let media: MediaConfig | undefined;
  if (raw.media !== undefined) {
    if (isObj(raw.media)) media = mediaOf(raw.media, err);
    else err('media must be an object: "push" and "keepDaysAfterClose".');
  }
  let review: ReviewConfig | undefined;
  if (raw.review !== undefined) {
    const given = isObj(raw.review) ? raw.review : null;
    if (!given) err('review must be an object: "shouldFindings".');
    else {
      for (const key of Object.keys(given)) if (key !== "shouldFindings") err(`review: unknown key "${key}". Known keys: shouldFindings.`);
      if (!SHOULD_FINDINGS.includes(given.shouldFindings as ReviewConfig["shouldFindings"])) err(`review.shouldFindings must be one of ${SHOULD_FINDINGS.map((each) => `"${each}"`).join(", ")}.`);
      else review = { shouldFindings: given.shouldFindings as ReviewConfig["shouldFindings"] };
    }
  }
  let labels: LabelsConfig | undefined;
  if (raw.labels !== undefined) {
    const given = isObj(raw.labels) ? raw.labels : null;
    if (!given) err('labels must be an object: "aiGenerated".');
    else {
      for (const key of Object.keys(given)) if (key !== "aiGenerated") err(`labels: unknown key "${key}". Known keys: aiGenerated.`);
      const value = given.aiGenerated;
      const name = value === true ? AI_LABEL_DEFAULT : typeof value === "string" ? value.trim() : value;
      if (name === false) labels = { aiGenerated: false };
      else if (typeof name !== "string" || name === "" || name.length > 50 || /[\s,]/.test(name) || /^(scopesoup|priority):/i.test(name)) {
        err('labels.aiGenerated must be false (no label), true (the label "ai-generated") or a label name of up to 50 characters with no spaces or commas, not starting with "scopesoup:" or "priority:".');
      } else labels = { aiGenerated: name };
    }
  }
  let checkCommand: string[] | undefined;
  if (raw.checkCommand !== undefined) {
    const given = raw.checkCommand;
    if (!Array.isArray(given) || given.length === 0 || given.some((part) => typeof part !== "string") || typeof given[0] !== "string" || given[0].trim() === "") {
      err('checkCommand must be a list: the program, then its arguments, for example ["node", "scripts/check.js"]. It is run without a shell.');
    } else checkCommand = given as string[];
  }
  let rerunFilesCommand: string[] | undefined;
  if (raw.rerunFilesCommand !== undefined) {
    const given = raw.rerunFilesCommand;
    if (!Array.isArray(given) || given.length === 0 || given.some((part) => typeof part !== "string") || (given[0] as string).trim() === "" || given[0] === "{files}") {
      err('rerunFilesCommand must be a list: the program, then its arguments, for example ["node", "--test", "{files}"]. It is run without a shell.');
    } else if (given.filter((part) => part === "{files}").length !== 1) {
      err('rerunFilesCommand must hold exactly one argument that is "{files}": it is replaced by the failed test files, one argument each.');
    } else rerunFilesCommand = given as string[];
  }

  let setupCommand: string[] | undefined;
  if (raw.setupCommand !== undefined) {
    const given = raw.setupCommand;
    if (!Array.isArray(given) || given.length === 0 || given.some((part) => typeof part !== "string") || (given[0] as string).trim() === "") {
      err('setupCommand must be a list: the program, then its arguments, for example ["node", ".scopesoup/scopesoup-setup.mjs", "--from-clone", "{{ownClone}}"]. It is run without a shell.');
    } else setupCommand = given as string[];
  }
  // SetupCommand is shared by every machine; `{{ownClone}}` in it stands for this machine's own clone (ownClone).
  if (setupCommand?.some((word) => word.includes(OWN_CLONE))) {
    if (ownClone === undefined) err(`setupCommand uses ${OWN_CLONE}, so this machine's scopesoup.config.json needs ownClone: the path of your own clone of the project, which the setup copies personal files (.env and the like) from.`);
    else setupCommand = setupCommand.map((word) => word.split(OWN_CLONE).join(ownClone.replace(/\\/g, "/")));
  }
  const setupWatch = raw.setupWatch === undefined ? undefined : setupWatchOf(raw.setupWatch, err);

  // --- claude ---
  const claude = defaultClaude();
  if (raw.claude !== undefined) {
    if (!isObj(raw.claude)) err("claude must be an object.");
    else {
      unknownKeys(raw.claude, Object.keys(claude), "claude");
      claude.path = str(raw.claude, "path", "claude.", claude.path);
      // A command with a directory is a file path like the others, relative to the configuration file; a bare name is looked up on PATH.
      if (/[\\/]/.test(claude.path)) claude.path = path(claude.path);
      claude.prefixArgs = strList(raw.claude, "prefixArgs", "claude.", claude.prefixArgs);
      claude.extraArgs = strList(raw.claude, "extraArgs", "claude.", claude.extraArgs);
      claude.dropApiKeyEnv = bool(raw.claude, "dropApiKeyEnv", "claude.", claude.dropApiKeyEnv);
      const via = raw.claude.promptVia;
      if (via === "stdin" || via === "arg") claude.promptVia = via;
      else if (via !== undefined) err('claude.promptVia must be "stdin" or "arg".');
    }
  }

  // --- copilot ---
  const copilot = defaultCopilot();
  if (raw.copilot !== undefined) {
    if (!isObj(raw.copilot)) err("copilot must be an object.");
    else {
      unknownKeys(raw.copilot, [...Object.keys(copilot), "monthlyRequests", "resetDay"], "copilot");
      copilot.path = str(raw.copilot, "path", "copilot.", copilot.path);
      if (/[\\/]/.test(copilot.path)) copilot.path = path(copilot.path);
      copilot.prefixArgs = strList(raw.copilot, "prefixArgs", "copilot.", copilot.prefixArgs);
      copilot.extraArgs = strList(raw.copilot, "extraArgs", "copilot.", copilot.extraArgs);
      if (raw.copilot.monthlyRequests !== undefined) copilot.monthlyRequests = num(raw.copilot.monthlyRequests, "copilot.monthlyRequests", 1, 1_000_000, true, 0) || undefined;
      if (raw.copilot.resetDay !== undefined) copilot.resetDay = num(raw.copilot.resetDay, "copilot.resetDay", 1, 28, true, 1);
    }
  }

  // --- settings ---
  const settings: Settings = defaultSettings();
  if (raw.settings !== undefined) {
    if (!isObj(raw.settings)) err("settings must be an object.");
    else {
      const names = [...Object.keys(settings), ...LEGACY_SETTINGS] as SettingName[];
      const kept = raw.settings;
      unknownKeys(kept, names, "settings");
      for (const name of names) {
        const given = kept[name];
        if (given === undefined) continue;
        const where = `settings.${name}`;
        if (!isObj(given)) {
          err(`${where} must be an object with "value" (and, if you like, "reason").`);
          continue;
        }
        unknownKeys(given, ["value", "reason"], where);
        const range = SETTING_RANGES[name];
        const value = num(given.value, `${where}.value`, range.min, range.max, range.whole, settings[name]?.value ?? 0.2);
        // The reason is optional: the settings page saves a number without one.
        if (given.reason !== undefined && typeof given.reason !== "string") err(`${where}.reason must be text, if given.`);
        else settings[name] = { value, reason: typeof given.reason === "string" ? given.reason.trim() : "" };
      }
    }
  }

  // --- roles ---
  const roles: Record<SessionRole, RoleConfig> = defaultRoles();
  if (raw.roles !== undefined) {
    if (!isObj(raw.roles)) err("roles must be an object.");
    else {
      unknownKeys(raw.roles, ROLES, "roles");
      for (const role of ROLES) {
        const given = raw.roles[role];
        if (given === undefined) continue;
        const where = `roles.${role}`;
        if (!isObj(given)) {
          err(`${where} must be an object.`);
          continue;
        }
        unknownKeys(given, ["provider", "model", "autoTier", "effort", "maxTurns", "allowedTools", "permissionMode", "mcpServers"], where);
        const target = roles[role];
        const provider = given.provider;
        if (provider !== undefined && !PROVIDER_NAMES.includes(provider as ProviderName)) {
          err(`${where}.provider must be one of ${PROVIDER_NAMES.map((name) => `"${name}"`).join(", ")}.`);
        } else if (provider !== undefined) target.provider = provider as ProviderName;
        // The default models are Claude's; a Copilot role that names none runs on Fusion, with its Auto routing profile.
        const copilotRole = target.provider === "copilot";
        target.model = str(given, "model", `${where}.`, copilotRole ? COPILOT_DEFAULT_MODEL : target.model);
        if (given.autoTier !== undefined) target.autoTier = str(given, "autoTier", `${where}.`, COPILOT_DEFAULT_AUTO_TIER);
        else if (copilotRole) target.autoTier = COPILOT_DEFAULT_AUTO_TIER;
        if (given.effort !== undefined) {
          const effort = str(given, "effort", `${where}.`, "");
          if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) err(`${where}.effort must be one of ${EFFORT_LEVELS.join(", ")}.`);
          else target.effort = effort;
        }
        if (given.maxTurns !== undefined) target.maxTurns = num(given.maxTurns, `${where}.maxTurns`, 1, 1000, true, target.maxTurns);
        target.allowedTools = strList(given, "allowedTools", `${where}.`, target.allowedTools);
        if (given.mcpServers !== undefined) {
          const servers = mcpServersOf(given.mcpServers, `${where}.mcpServers`, err);
          if (Object.keys(servers).length > 0) target.mcpServers = servers;
        }
        const mode = str(given, "permissionMode", `${where}.`, target.permissionMode);
        if (mode === "bypassPermissions") {
          err(`${where}.permissionMode: "bypassPermissions" is refused. List the tools the role needs in allowedTools.`);
        } else if (!PERMISSION_MODES.includes(mode)) {
          err(`${where}.permissionMode must be one of ${PERMISSION_MODES.join(", ")}.`);
        } else target.permissionMode = mode;
      }
    }
  }
  // `{{scopesoup}}` in a role's allowed tools is the folder Scope Soup is installed in (the item commands of the triage).
  const scopesoup = fileURLToPath(new URL("../..", import.meta.url));
  for (const role of ROLES) roles[role].allowedTools = expandScopesoup(roles[role].allowedTools, scopesoup);
  // A role's MCP servers: all their tools count as allowed for it.
  for (const role of ROLES) {
    for (const name of Object.keys(roles[role].mcpServers ?? {})) {
      if (!roles[role].allowedTools.includes(mcpToolEntry(name))) roles[role].allowedTools.push(mcpToolEntry(name));
    }
  }
  // The implementor and the reviewer may always run the project's check command: the one in the file, else the one Settings
  // proposes from the project (the candidate it shows). A person's own list in the file wins for everything else.
  const checkWords = checkCommand ?? proposeCheckCommand(repoPath).command;
  for (const role of CHECK_ROLES) roles[role].allowedTools = withCheckRules(roles[role].allowedTools, checkWords);
  // Which model a role runs on is the project's choice; see recommend.ts for advice that is not enforced.

  const workspaces = workspacesOf(raw.workspaces, path, err);
  const host = raw.host === undefined ? undefined : hostOf(raw.host, repoPath, remote, err);
  if (mergeQueue?.ci === "github" && host !== undefined && host.kind !== "github") {
    err(`mergeQueue.ci is "github", but the host is ${host.kind}: Scope Soup waits for CI on GitHub only for a project whose host is GitHub. Remove mergeQueue.ci, or set it to "local" to run checkCommand.`);
  }
  if (host?.kind === "jira" && !host.write && level > 0) {
    err(`level is ${level}, but the Jira host has writes off (host.write): Scope Soup can only show the Jira project's Items. Set host.write to true, or level to 0 (Watch).`);
  }

  // --- core rule 1 ---
  for (const real of realPaths) {
    if (overlaps(real, workspacesDir)) err(`workspacesDir (${workspacesDir}) overlaps the real path ${real}. Sessions never run there.`);
    if (within(real, repoPath)) err(`repoPath (${repoPath}) is inside the real path ${real}. Point Scope Soup at a separate clone.`);
  }
  if (workspaces.kind === "pool") {
    for (const clone of workspaces.paths) {
      if (overlaps(clone, repoPath)) err(`workspaces.paths: the clone ${clone} equals, contains or is inside repoPath (${repoPath}). A clone of the pool is never the repository Scope Soup itself works from.`);
      for (const real of realPaths) {
        if (overlaps(real, clone)) err(`workspaces.paths: the clone ${clone} overlaps the real path ${real}. Sessions never run there.`);
      }
    }
  }

  const resources = [...resourcesOf(raw.resources, false, err), ...resourcesOf(raw.sharedResources, true, err)];
  const names = resources.map((each) => each.name);
  for (const [index, name] of names.entries()) if (names.indexOf(name) !== index) err(`The resource name "${name}" is used twice: each resource needs its own name, in resources and sharedResources together.`);

  if (settings.queueMinBatch.value > settings.queueMaxBatch.value) {
    err(`settings.queueMinBatch (${settings.queueMinBatch.value}) is larger than settings.queueMaxBatch (${settings.queueMaxBatch.value}).`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    notices,
    from,
    raw,
    config: {
      workspaces,
      ...(host === undefined ? {} : { host }),
      machineName,
      ...(ownClone === undefined ? {} : { ownClone }),
      project, repoPath, mainBranch, remote, realPaths, level, keepAwake, multiplayer, workspacesDir, streamsDir,
      promptsDir, bugLabels,
      ...(remoteUrl === undefined ? {} : { remoteUrl }), ...(checkCommand === undefined ? {} : { checkCommand }), ...(rerunFilesCommand === undefined ? {} : { rerunFilesCommand }),
      ...(setupCommand === undefined ? {} : { setupCommand }), ...(setupWatch === undefined ? {} : { setupWatch }),
      ...(mergeQueue === undefined ? {} : { mergeQueue }),
      ...(media === undefined ? {} : { media }),
      ...(review === undefined ? {} : { review }),
      ...(labels === undefined ? {} : { labels }),
      ...(resources.length > 0 ? { resources } : {}),
      claude, copilot, settings, roles,
    },
  };
}

/** `roles.<role>.mcpServers`: name -> { command, args?, env? }. `env` lists variable names only: a value in the file would be a secret in a file. */
function mcpServersOf(value: unknown, where: string, err: (message: string) => void): Record<string, McpServer> {
  const servers: Record<string, McpServer> = {};
  if (!isObj(value)) {
    err(`${where} must be an object of servers by name.`);
    return servers;
  }
  const names = (list: unknown, key: string, pattern: RegExp, form: string, at: string): string[] | undefined => {
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string" || !pattern.test(entry))) {
      err(`${at}.${key} must be a list of ${form}.`);
      return undefined;
    }
    return list as string[];
  };
  for (const [name, given] of Object.entries(value)) {
    const at = `${where}.${name}`;
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      err(`${where}: the server name "${name}" may hold only letters, digits and "-".`);
      continue;
    }
    if (!isObj(given)) {
      err(`${at} must be an object with "command", and if you like "args" and "env".`);
      continue;
    }
    const known = ["command", "args", "env"];
    if (Object.keys(given).some((key) => !known.includes(key))) {
      err(`${at} may hold only ${known.join(", ")}. "env" is a list of variable names: the values come from the environment, never from the file.`);
      continue;
    }
    if (typeof given.command !== "string" || given.command.trim() === "") {
      err(`${at}.command must be the program to start, as text.`);
      continue;
    }
    const args = names(given.args, "args", /^/, "strings", at);
    const env = names(given.env, "env", /^[A-Za-z_][A-Za-z0-9_]*$/, "variable names (NAME, not NAME=value)", at);
    servers[name] = { command: given.command.trim(), ...(args ? { args } : {}), ...(env && env.length > 0 ? { env } : {}) };
  }
  return servers;
}

const RESOURCE_KEYS = ["name", "units", "neededBy", "env"];

/** `resources` (this machine's) or `sharedResources` (held across machines on the remote): a list of resources. */
function resourcesOf(value: unknown, shared: boolean, err: (message: string) => void): ResourceConfig[] {
  const key = shared ? "sharedResources" : "resources";
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    err(`${key} must be a list, for example [{ "name": "emulator", "units": 2, "neededBy": ["implement", "check"] }].`);
    return [];
  }
  const out: ResourceConfig[] = [];
  for (const [index, entry] of value.entries()) {
    const where = `${key}[${index}]`;
    if (!isObj(entry)) {
      err(`${where} must be an object with name, units and neededBy (and, if you like, env).`);
      continue;
    }
    for (const name of Object.keys(entry)) if (!RESOURCE_KEYS.includes(name)) err(`${where}: unknown key "${name}". Known keys: ${RESOURCE_KEYS.join(", ")}.`);
    const name = entry.name;
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name)) {
      err(`${where}.name must be letters, digits, "-" and "_" (at most 40, starting with a letter or digit): it names the resource's lease on the remote.`);
      continue;
    }
    const units = entry.units;
    if (typeof units !== "number" || !Number.isInteger(units) || units < 1 || units > 64) err(`${where}.units must be a whole number from 1 to 64.`);
    const neededBy = entry.neededBy;
    if (!Array.isArray(neededBy) || neededBy.length === 0 || neededBy.some((user) => !RESOURCE_USERS.includes(user as ResourceUser))) {
      err(`${where}.neededBy must name what needs it, one or more of ${RESOURCE_USERS.join(", ")}.`);
    }
    const env: Record<string, string> = {};
    if (entry.env !== undefined) {
      if (!isObj(entry.env)) err(`${where}.env must be an object of environment variables, for example { "TEST_DB": "test_{{unit}}" }.`);
      else {
        for (const [variable, text] of Object.entries(entry.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) err(`${where}.env: "${variable}" is not an environment variable's name.`);
          else if (typeof text !== "string") err(`${where}.env.${variable} must be text.`);
          else env[variable] = text;
        }
      }
    }
    if (typeof units === "number" && Array.isArray(neededBy)) out.push({ name, units, shared, neededBy: [...new Set(neededBy as ResourceUser[])], env });
  }
  return out;
}

const GITHUB_KEYS = ["kind", "repo", "write"];
const JIRA_KEYS = ["kind", "site", "project", "deployment", "filter", "components", "write", "email", "priorities", "abandonedResolutions", "blocksLink", "issueType", "childIssueType", "transitions", "resolutions", "relatesLink", "duplicateLink", "commentLimit", "answerers"];
const TRANSITION_TARGETS = ["todo", "doing", "done", "abandoned"] as const;
const RESOLUTION_TARGETS = ["done", "abandoned", "duplicate"] as const;
const PRIORITY_NAMES = ["blocker", "critical", "major", "minor"] as const;
/** `mergeQueue`, the object form: what checks the merge queue's batches, and how long a check on GitHub may stay pending. */
function mergeQueueOf(value: Obj, err: (message: string) => void): MergeQueueConfig {
  for (const key of Object.keys(value)) {
    if (key !== "ci" && key !== "ciTimeoutMinutes") err(`mergeQueue: unknown key "${key}". Known keys: ci, ciTimeoutMinutes.`);
  }
  let ci: MergeQueueConfig["ci"] = "local";
  if (value.ci !== undefined) {
    if (value.ci !== "local" && value.ci !== "github") err(`mergeQueue.ci must be "local" (checkCommand runs in the queue's clone) or "github" (the project's own CI on GitHub).`);
    else ci = value.ci;
  }
  let ciTimeoutMinutes = DEFAULT_CI_TIMEOUT_MINUTES;
  if (value.ciTimeoutMinutes !== undefined) {
    const given = value.ciTimeoutMinutes;
    if (typeof given !== "number" || !Number.isFinite(given) || given < 1 || given > 1440) err("mergeQueue.ciTimeoutMinutes must be a number from 1 to 1440.");
    else ciTimeoutMinutes = given;
  }
  return { ci, ciTimeoutMinutes };
}

/** `media`: whether agents' images are pushed to the remote, and how long a closed Item's images are kept. */
function mediaOf(value: Obj, err: (message: string) => void): MediaConfig {
  for (const key of Object.keys(value)) {
    if (key !== "push" && key !== "keepDaysAfterClose") err(`media: unknown key "${key}". Known keys: push, keepDaysAfterClose.`);
  }
  let push = false;
  if (value.push !== undefined) {
    if (typeof value.push !== "boolean") err("media.push must be true or false.");
    else push = value.push;
  }
  let keepDaysAfterClose: number | null = null;
  if (value.keepDaysAfterClose !== undefined && value.keepDaysAfterClose !== null) {
    const given = value.keepDaysAfterClose;
    if (typeof given !== "number" || !Number.isInteger(given) || given < 0 || given > 3650) err("media.keepDaysAfterClose must be a whole number of days from 0 to 3650, or null to keep the images.");
    else keepDaysAfterClose = given;
  }
  return { push, keepDaysAfterClose };
}

// The meta ref is refs/scopesoup/meta in repoPath, shared with remote (both from this machine's file): no ref, folder or remote here.
const META_BRANCH_KEYS = ["kind", "write", "authorName", "authorEmail", "prefix", "fetchSeconds"];

/** Why a text cannot be a JQL condition to AND with the project, or null: no ORDER BY, balanced quotes and parentheses. */
export function jqlFragmentProblem(text: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  let outside = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (quote) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else {
      outside += char;
      if (char === "(") depth += 1;
      else if (char === ")" && --depth < 0) return "closes a parenthesis that was never opened.";
    }
  }
  if (quote) return "has a quote that is never closed.";
  if (depth !== 0) return "has a parenthesis that is never closed.";
  if (/\border\s+by\b/i.test(outside)) return "must not have an ORDER BY: Scope Soup orders the issues itself.";
  return null;
}

/** `host` of kind "jira": a Jira project, written to with `write`. */
function jiraHostOf(value: Obj, write: boolean, text: (key: string) => string | undefined, err: (message: string) => void): JiraHostConfig {
  const site = text("site")?.replace(/\/+$/, "");
  if (site === undefined) err(`host.site must be the Jira site's address, as "https://example.atlassian.net" (Cloud) or your Data Center's base URL.`);
  else if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(site)) err(`host.site (${site}) must be an http or https address with no query, as "https://example.atlassian.net".`);
  const project = text("project");
  if (project === undefined) err(`host.project must be the Jira project key, as "DEMO".`);
  else if (!/^[A-Z][A-Z0-9_]+$/.test(project)) err(`host.project (${project}) must be a Jira project key: capital letters, digits and "_", starting with a letter, as "DEMO".`);
  const filter = text("filter");
  if (filter !== undefined) {
    const problem = jqlFragmentProblem(filter);
    if (problem) err(`host.filter (${filter}) ${problem} Write it as a condition on the project's issues, as 'component = "Board" AND labels = scopesoup'.`);
  }
  let components: string[] | undefined;
  if (value.components !== undefined) {
    const given = value.components;
    if (!Array.isArray(given) || given.length === 0 || !given.every((entry) => typeof entry === "string" && entry.trim() !== "")) err(`host.components must be a list of component names that new Items get, as ["Board"].`);
    else components = [...new Set(given.map((entry: string) => entry.trim()))];
  }
  const deployment = value.deployment;
  if (deployment !== "cloud" && deployment !== "datacenter") err(`host.deployment must be "cloud" (Jira Cloud, an API token with the account's email) or "datacenter" (self-hosted Jira, a personal access token).`);
  const email = text("email");
  if (deployment === "cloud" && email === undefined) err(`host.deployment is "cloud", so the account's email is required with the API token: set jira.email in this machine's scopesoup.config.json.`);
  if (deployment === "datacenter" && email !== undefined) err("host.deployment is \"datacenter\": a personal access token needs no email. Remove jira.email.");
  const config: JiraHostConfig = { kind: "jira", site: site ?? "", project: project ?? "", deployment: deployment === "datacenter" ? "datacenter" : "cloud", write };
  if (email !== undefined) config.email = email;
  if (filter !== undefined) config.filter = filter;
  if (components) config.components = components;
  if (value.priorities !== undefined) {
    if (!isObj(value.priorities) || Object.keys(value.priorities).length === 0) err(`host.priorities must be an object from Jira priority names to ${PRIORITY_NAMES.join(", ")}, as { "Highest": "blocker" }.`);
    else {
      const map: Record<string, (typeof PRIORITY_NAMES)[number]> = {};
      for (const [name, given] of Object.entries(value.priorities)) {
        const found = PRIORITY_NAMES.find((priority) => priority === given);
        if (found) map[name] = found;
        else err(`host.priorities.${name} must be one of ${PRIORITY_NAMES.join(", ")}.`);
      }
      config.priorities = map;
    }
  }
  if (value.abandonedResolutions !== undefined) {
    const given = value.abandonedResolutions;
    if (!Array.isArray(given) || !given.every((entry) => typeof entry === "string" && entry.trim() !== "")) err(`host.abandonedResolutions must be a list of resolution names, as ["Won't Do", "Duplicate"].`);
    else config.abandonedResolutions = given.map((entry: string) => entry.trim());
  }
  for (const key of ["blocksLink", "issueType", "childIssueType", "relatesLink", "duplicateLink"] as const) {
    const given = text(key);
    if (given !== undefined) config[key] = given;
  }
  const names = <T extends string>(key: "transitions" | "resolutions", targets: readonly T[], example: string): Partial<Record<T, string>> | undefined => {
    const given = value[key];
    if (given === undefined) return undefined;
    if (!isObj(given)) {
      err(`host.${key} must be an object from ${targets.join(", ")} to a name, as ${example}.`);
      return undefined;
    }
    const map: Partial<Record<T, string>> = {};
    for (const [target, name] of Object.entries(given)) {
      if (!targets.includes(target as T)) err(`host.${key}: unknown key "${target}". Known keys: ${targets.join(", ")}.`);
      else if (typeof name !== "string" || name.trim() === "") err(`host.${key}.${target} must be a non-empty name.`);
      else map[target as T] = name.trim();
    }
    return map;
  };
  const transitions = names("transitions", TRANSITION_TARGETS, `{ "done": "Close Issue" }`);
  if (transitions) config.transitions = transitions;
  const resolutions = names("resolutions", RESOLUTION_TARGETS, `{ "abandoned": "Won't Fix" }`);
  if (resolutions) config.resolutions = resolutions;
  if (value.answerers !== undefined) {
    const given = value.answerers;
    if (!Array.isArray(given) || !given.every((entry) => typeof entry === "string" && entry.trim() !== "")) err(`host.answerers must be a list of Jira account ids (Cloud) or user names (Data Center) whose answers count, as ["robin"].`);
    else config.answerers = given.map((entry: string) => entry.trim());
  }
  if (value.commentLimit !== undefined) {
    const given = value.commentLimit;
    if (typeof given !== "number" || !Number.isInteger(given) || given < 1000 || given > 1_000_000) err("host.commentLimit must be a whole number of characters from 1000 to 1000000 (Jira's default limit is 32767).");
    else config.commentLimit = given;
  }
  return config;
}

/** `host`: where the items live. No token here; tokens stay in the environment. */
function hostOf(value: unknown, repoPath: string, remote: string, err: (message: string) => void): HostConfig | undefined {
  if (!isObj(value) || (value.kind !== "github" && value.kind !== "metaBranch" && value.kind !== "jira")) {
    err('host must be an object with "kind": "github", "metaBranch" or "jira".');
    return undefined;
  }
  const known = value.kind === "github" ? GITHUB_KEYS : value.kind === "jira" ? JIRA_KEYS : META_BRANCH_KEYS;
  for (const key of Object.keys(value)) {
    if (/token/i.test(key)) err(`host.${key}: a token is never kept in the configuration file. Set it in the environment.`);
    else if (!known.includes(key)) err(`host: unknown key "${key}" for kind "${value.kind}". Known keys: ${known.join(", ")}.`);
  }
  const text = (key: string): string | undefined => {
    const given = value[key];
    if (given === undefined) return undefined;
    if (typeof given !== "string" || given.trim() === "") {
      err(`host.${key} must be a non-empty string.`);
      return undefined;
    }
    return given.trim();
  };
  let write = false;
  if (value.write !== undefined) {
    if (typeof value.write !== "boolean") err("host.write must be true or false.");
    else write = value.write;
  }

  if (value.kind === "github") {
    const repo = text("repo");
    if (repo === undefined) err('host.repo must be the repository as "owner/name".');
    else if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) err(`host.repo (${repo}) must be the repository as "owner/name".`);
    return { kind: "github", repo: repo ?? "", write };
  }

  if (value.kind === "jira") return jiraHostOf(value, write, text, err);

  const authorName = text("authorName");
  const authorEmail = text("authorEmail");
  const prefix = text("prefix");
  let fetchSeconds = 60;
  if (value.fetchSeconds !== undefined) {
    const given = value.fetchSeconds;
    if (typeof given !== "number" || !Number.isInteger(given) || given < 0 || given > 86400) err("host.fetchSeconds must be a whole number from 0 to 86400.");
    else fetchSeconds = given;
  }
  if (write && (authorName === undefined || authorEmail === undefined)) {
    err("host.write is true, so host.authorName and host.authorEmail are required: meta commits are made as that person. Each machine sets them in its own scopesoup.config.json as meta.authorName and meta.authorEmail.");
  }
  return {
    kind: "metaBranch",
    repoPath,
    write,
    remote,
    fetchSeconds,
    ...(authorName === undefined ? {} : { authorName }),
    ...(authorEmail === undefined ? {} : { authorEmail }),
    ...(prefix === undefined ? {} : { prefix }),
  };
}

/** `workspaces`: absent means worktrees. A pool's paths resolve like the other paths; its subfolder must stay inside each clone. */
function workspacesOf(value: unknown, path: (value: string) => string, err: (message: string) => void): WorkspacesConfig {
  if (value === undefined) return { kind: "worktree" };
  if (!isObj(value)) {
    err('workspaces must be an object with "kind": "worktree" or "pool".');
    return { kind: "worktree" };
  }
  if (value.kind === "worktree") {
    for (const key of Object.keys(value)) if (key !== "kind") err(`workspaces: unknown key "${key}" for kind "worktree".`);
    return { kind: "worktree" };
  }
  if (value.kind !== "pool") {
    err('workspaces.kind must be "worktree" or "pool".');
    return { kind: "worktree" };
  }
  for (const key of Object.keys(value)) {
    if (!["kind", "paths", "projectSubdir", "keep"].includes(key)) err(`workspaces: unknown key "${key}". Known keys: kind, paths, projectSubdir, keep.`);
  }
  const given = value.paths;
  let paths: string[] = [];
  if (!Array.isArray(given) || given.length === 0 || given.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    err("workspaces.paths must be a non-empty list of clone folders.");
  } else {
    paths = (given as string[]).map(path);
    paths.forEach((clone, index) => {
      paths.slice(index + 1).forEach((other) => {
        if (overlaps(clone, other)) err(`workspaces.paths: ${clone} and ${other} overlap. Each clone is a folder of its own.`);
      });
    });
  }
  let projectSubdir = ".";
  if (value.projectSubdir !== undefined) {
    const subdir = value.projectSubdir;
    if (typeof subdir !== "string" || subdir.trim() === "") err("workspaces.projectSubdir must be a non-empty string.");
    else if (isAbsolute(subdir) || win32.isAbsolute(subdir) || /^[A-Za-z]:/.test(subdir) || subdir.split(/[\\/]/).includes("..")) {
      err(`workspaces.projectSubdir (${subdir}) must be a folder inside each clone: relative, without "..".`);
    } else projectSubdir = subdir;
  }
  if (value.keep === undefined) return { kind: "pool", paths, projectSubdir };
  return { kind: "pool", paths, projectSubdir, keep: keepOf(value.keep, err) };
}

/**
 * `workspaces.keep`: gitignore patterns relative to the project's repository. They reach git only
 * as `--exclude=<pattern>` values, but are held to the same shape as projectSubdir all the same, and
 * a negation (`!`) is refused: it could make a file that git ignores removable.
 */
function keepOf(value: unknown, err: (message: string) => void): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    err("workspaces.keep must be a list of patterns.");
    return [];
  }
  const keep: string[] = [];
  for (const pattern of value as string[]) {
    if (pattern.trim() === "" || /[\0\r\n]/.test(pattern)) err(`workspaces.keep: "${pattern}" must be a non-empty pattern on one line.`);
    else if (isAbsolute(pattern) || win32.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.split(/[\\/]/).includes("..")) {
      err(`workspaces.keep: "${pattern}" must be relative to the project's repository, without "..".`);
    } else if (pattern.includes("\\")) err(`workspaces.keep: "${pattern}" must use "/" between folders, as in .gitignore.`);
    else if (pattern.startsWith("!")) err(`workspaces.keep: "${pattern}" may not start with "!": a pattern can only keep more, never less.`);
    else keep.push(pattern);
  }
  return keep;
}

/**
 * `setupWatch`: paths relative to the project's repository, "/" between folders, without ".."; `*` only inside one part of a
 * path. Read as files whose content is hashed, never run or copied.
 */
function setupWatchOf(value: unknown, err: (message: string) => void): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    err('setupWatch must be a list of files relative to the project\'s repository, for example ["pnpm-lock.yaml", "web/pnpm-lock.yaml"].');
    return undefined;
  }
  const watch: string[] = [];
  let bad = false;
  for (const path of value as string[]) {
    const fail = (why: string): void => {
      bad = true;
      err(`setupWatch: "${path}" ${why}`);
    };
    if (path.trim() === "" || /[\0\r\n]/.test(path)) fail("must be a non-empty path on one line.");
    else if (isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) fail('must be relative to the project\'s repository, without "..".');
    else if (path.includes("\\")) fail('must use "/" between folders.');
    else if (path.includes("**")) fail('may use "*" only inside one part of the path, not "**".');
    else watch.push(path);
  }
  return bad ? undefined : watch;
}

function norm(path: string): string {
  const resolved = resolve(path);
  // Windows paths compare without case.
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `inner` is `outer` or lies below it. Compares resolved paths as text. */
export function within(outer: string, inner: string): boolean {
  const a = norm(outer);
  const b = norm(inner);
  if (a === b) return true;
  const sep = a.endsWith("/") || a.endsWith("\\") ? "" : process.platform === "win32" ? "\\" : "/";
  return b.startsWith(a + sep);
}

/** True when either path contains the other. */
export function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}
