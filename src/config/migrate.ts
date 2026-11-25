// The configuration file's format. `version` is a whole number raised only when an older file would no longer
// load as it is; a file without it is format 0 (release 0.5.0 and everything before this change). Each step below
// turns a file of one format into the next, and is where the knowledge of the keys that were removed or renamed lives.
// Pure: the loader writes the result (write.ts).

import { defaultSettings } from "./defaults.ts";
import { levelName } from "./types.ts";

/** The format this Scope Soup writes and reads. Raise it, and add a step, when an older file would no longer load as is. */
export const CONFIG_VERSION = 1;

/** Said when a file's `version` is newer than this Scope Soup's. */
export const NEWER_CONFIG = "this project's config is from a newer Scope Soup; upgrade Scope Soup";

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `from`: the file's format. `raw`: the file in the current format, `version` first; the same object when nothing changed.
 * `changes`: what the steps changed, one line each, in the words of the one-time notice. A step that cannot convert a
 * key gives errors, and still `raw`, the rest converted and that key left out, so the other problems can be found too.
 */
export type MigrateResult = { ok: true; from: number; raw: Obj; changes: string[] } | { ok: false; errors: string[]; raw?: Obj };

/**
 * One step: a file of format n becomes format n + 1. It changes `raw` in place, and returns errors for what it cannot
 * convert, leaving that key out.
 */
type Step = (raw: Obj, changes: string[]) => string[];

/** STEPS[n] turns format n into format n + 1. */
const STEPS: readonly Step[] = [from0to1];

/** The file's format: 0 when it has no `version`, null when `version` is not a whole number from 0. */
export function formatOf(raw: Obj): number | null {
  const version = raw.version;
  if (version === undefined) return 0;
  return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : null;
}

/** Brings a parsed file to the current format. A newer file is refused; the given object is never changed. */
export function migrateConfig(given: unknown): MigrateResult {
  if (!isObj(given)) return { ok: false, errors: ["The configuration must be a JSON object."] };
  const from = formatOf(given);
  if (from === null) return { ok: false, errors: [`version must be a whole number: the format of the file, ${CONFIG_VERSION} for this Scope Soup. A file without it is format 0.`] };
  if (from > CONFIG_VERSION) return { ok: false, errors: [`version ${from}: ${NEWER_CONFIG}. This Scope Soup reads formats 0 to ${CONFIG_VERSION}.`] };
  if (from === CONFIG_VERSION) return { ok: true, from, raw: given, changes: [] };
  const raw = structuredClone(given);
  const changes: string[] = [];
  const errors: string[] = [];
  for (let version = from; version < CONFIG_VERSION; version++) errors.push(...STEPS[version]!(raw, changes));
  delete raw.version;
  const current = { version: CONFIG_VERSION, ...raw };
  return errors.length > 0 ? { ok: false, errors, raw: current } : { ok: true, from, raw: current, changes };
}

// --- format 0 to 1 ---

/** Rule switches that format 0 still accepted and no Scope Soup reads, with why. */
const UNBUILT = "the rule was removed until it is built";
const RULES_0: Record<string, string> = {
  isolatedResources: UNBUILT,
  oneCoordinator: UNBUILT,
  toolVerification: UNBUILT,
  queueOnlyWriter: UNBUILT,
  testsWithChange: "the project's own CLAUDE.md says whether changes carry tests",
  changePerItem: "every item has its own branch; Scope Soup opens no pull request itself: whether a change gets one is the project's CLAUDE.md's call",
  weeklyPacing: "the budget reserve is the one usage control",
  waitingCap: "changes no longer wait for a person in numbers that need a cap",
  reviewer: "the level decides: from level 3 (Review) every built change is reviewed, below it none is",
  riskClasses: "there is no approval step any more: no change waits for an Approve, whatever paths it touches",
  pinnedApproval: "there is no approval step any more, so there is no approval to pin",
  hardBudgetStop: "from level 1 the usage stop at settings.budgetReserve is always on; the reserve is the one usage setting",
  claims: "Scope Soup claims the Items it starts by itself when the host is shared with other machines, with a fixed expiry of 120 minutes",
};

/** Top-level keys of format 0 that no Scope Soup reads, with why. */
const KEYS_0: Record<string, string> = {
  irreversibleActions: "no code read it",
  review: "the checklist stage was removed; a built change goes straight to review",
  agentCheckCommand: "the prompts no longer name a check command; a session checks the way the project's CLAUDE.md says",
  inviteLabel: "Scope Soup picks from the whole backlog in order; there is no invite label any more",
};

/** Roles of format 0 that nothing starts, with why. */
const ROLES_0: Record<string, string> = {
  rebase: "nothing started that role",
  situation: "nothing started that role",
  "check-review": "the checklist stage was removed",
  fix: "review findings and merging failures go back to the implementor's own session",
};

/** Settings of format 0 that no Scope Soup reads, with why. */
const SETTINGS_0: Record<string, string> = {
  reviewDepth: "every change is reviewed from level 3",
  autonomy: "questions always go to a person; Scope Soup no longer takes a recommended option itself",
  triageDepth: "an item that states its size skips triage, every other gets a full triage session",
  modelStrength: "each role's model is roles.<role>.model, by default opus for triage and review and sonnet for implement",
};

const OLD_MERGE_QUEUE = "the level decides: below level 4 Scope Soup merges nothing, the implementing session merges; at level 4 Scope Soup merges every reviewed change through the merge queue. Only the object form, mergeQueue.ci and mergeQueue.ciTimeoutMinutes, is read";

/** Puts `value` under `key` where `old` stood, keeping the order of the other keys. */
function replaceKey(raw: Obj, old: string, key: string, value: unknown): void {
  const entries = Object.entries(raw).map(([name, given]): [string, unknown] => (name === old ? [key, value] : [name, given]));
  for (const name of Object.keys(raw)) delete raw[name];
  Object.assign(raw, Object.fromEntries(entries));
}

/**
 * Format 0 to 1: every key a release up to 0.5.0 wrote and no Scope Soup reads any more is dropped, and the two that still
 * mean something are converted: `dryRun` (with an older string `mergeQueue`) becomes `level`, and
 * `settings.parallelSessions` is merged into `settings.maxParallelSessions`.
 */
function from0to1(raw: Obj, changes: string[]): string[] {
  const errors: string[] = [];
  const dropped = (key: string, why: string): void => void changes.push(`${key} was dropped: ${why}.`);

  for (const [key, why] of Object.entries(KEYS_0)) {
    if (!Object.hasOwn(raw, key)) continue;
    // Only format 0's `review` (its `checklist`) is dropped; `review.shouldFindings` is today's (decision 95).
    if (key === "review" && !(typeof raw.review === "object" && raw.review !== null && Object.hasOwn(raw.review, "checklist"))) continue;
    delete raw[key];
    dropped(key === "review" ? "review.checklist" : key, why);
  }

  // The level, from dryRun and an older mergeQueue; read before rules is dropped, for the note on risk classes.
  const merging = raw.mergeQueue === "push" || raw.mergeQueue === "queue" || raw.mergeQueue === "person" ? raw.mergeQueue : undefined;
  if (Object.hasOwn(raw, "dryRun")) {
    const dryRun = raw.dryRun;
    if (raw.level !== undefined) {
      delete raw.dryRun;
      dropped("dryRun", `the file sets level ${String(raw.level)}, which decides what Scope Soup does`);
    } else if (typeof dryRun !== "boolean") {
      delete raw.dryRun;
      errors.push("dryRun must be true or false. It is an older key: set level instead, from 0 (Watch) to 4 (Autopilot).");
    } else {
      const described = merging === "push" || merging === "queue" ? 4 : 1;
      if (dryRun) {
        replaceKey(raw, "dryRun", "level", 0);
        changes.push(`dryRun true became "level": 0: a dry run is ${levelName(0)}, Scope Soup shows the work and starts nothing. The rest of the file describes ${levelName(described)}; set "level": ${described} when Scope Soup should do that.`);
      } else if (described === 1) {
        replaceKey(raw, "dryRun", "level", 1);
        changes.push(`dryRun false with mergeQueue "person" became "level": 1, ${levelName(1)}: agents used to hand changes to a person, so Scope Soup now only takes a triage. Set "level": 2 or 3 to implement; there the session merges its change itself, as the project's CLAUDE.md says.`);
      } else {
        const risky = isObj(raw.rules) && isObj(raw.rules.riskClasses) && raw.rules.riskClasses.on === true;
        replaceKey(raw, "dryRun", "level", 4);
        changes.push(`dryRun false with mergeQueue "${merging}" became "level": 4, ${levelName(4)}: Scope Soup implements, reviews and merges through the merge queue.${risky ? " Risk classes were on: changes no longer wait for an approval." : ""}`);
      }
    }
  }
  if (raw.mergeQueue !== undefined && !isObj(raw.mergeQueue)) {
    dropped(`mergeQueue ${JSON.stringify(raw.mergeQueue)}`, OLD_MERGE_QUEUE);
    delete raw.mergeQueue;
  }

  // No rule switch is left: every one format 0 knew is dropped; any other name is an error.
  if (raw.rules !== undefined) {
    if (!isObj(raw.rules)) errors.push("rules must be an object.");
    else {
      for (const key of Object.keys(raw.rules)) {
        const why = Object.hasOwn(RULES_0, key) ? RULES_0[key] : undefined;
        if (why) dropped(`rules.${key}`, why);
        else errors.push(`rules: unknown key "${key}". No rule switch is left: the level decides what Scope Soup does (docs/RULES.md).`);
      }
      if (Object.keys(raw.rules).length === 0) dropped("rules", "no rule switch is left; the level decides what Scope Soup does");
    }
    delete raw.rules;
  }

  if (isObj(raw.settings)) {
    const settings = raw.settings;
    for (const [key, why] of Object.entries(SETTINGS_0)) {
      if (!Object.hasOwn(settings, key)) continue;
      delete settings[key];
      dropped(`settings.${key}`, `the setting was removed (${why})`);
    }
    if (Object.hasOwn(settings, "parallelSessions")) changes.push(mergeParallel(settings));
  }

  if (isObj(raw.roles)) {
    for (const [key, why] of Object.entries(ROLES_0)) {
      if (!Object.hasOwn(raw.roles, key)) continue;
      delete raw.roles[key];
      dropped(`roles.${key}`, why);
    }
  }

  if (isObj(raw.host) && raw.host.kind === "metaBranch" && Object.hasOwn(raw.host, "machine")) {
    delete raw.host.machine;
    dropped("host.machine", "the top-level machineName names the machine now");
  }
  return errors;
}

/**
 * `settings.parallelSessions` (implement and fix sessions at once) became part of `maxParallelSessions`. The
 * smaller of the two is kept, as that is the most implementors the old file let run; a value that is not a whole number
 * from 1 to 32 is only dropped. Returns the line for the notice.
 */
function mergeParallel(settings: Obj): string {
  const given = settings.parallelSessions;
  delete settings.parallelSessions;
  const value = isObj(given) ? given.value : undefined;
  const usable = typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 32;
  const max = settings.maxParallelSessions;
  const hasMax = max !== undefined;
  const maxValue = isObj(max) && typeof max.value === "number" ? max.value : defaultSettings().maxParallelSessions.value;
  if (usable && (!hasMax || (isObj(max) && value < maxValue))) {
    const reason = isObj(given) && typeof given.reason === "string" && given.reason.trim() !== "" ? given.reason : isObj(max) ? max.reason : undefined;
    settings.maxParallelSessions = typeof reason === "string" ? { value, reason } : { value };
  }
  const kept = isObj(settings.maxParallelSessions) ? settings.maxParallelSessions.value : maxValue;
  return `settings.parallelSessions was merged into settings.maxParallelSessions, which caps every session${usable ? `; the smaller value, ${String(kept)}, is kept` : ""}.`;
}
