// The project's shared settings on the meta ref, next to the Items: `settings/settings.json` (the settings, one JSON
// object) and `settings/log.jsonl` (one line per save: who changed what). The meta ref's name is fixed, so finding the
// settings needs no setting. Pure: how the files are named, how a save's changes are described, and how two saves made on
// two machines at once are merged when one is put on top of the other (docs/DESIGN.md, "Items on a meta branch").

import { isDeepStrictEqual } from "node:util";

/** The meta ref of every project: the Items (on a meta branch host) and the shared settings (on every host). */
export const META_REF = "refs/scopesoup/meta";

/** The shared settings, a JSON object. */
export const SETTINGS_FILE = "settings/settings.json";

/** One line per save, append-only, as an Item's log: `kind` "settings" with `changes`. */
export const SETTINGS_LOG = "settings/log.jsonl";

export const isSettingsPath = (path: string): boolean => path === SETTINGS_FILE || path === SETTINGS_LOG;

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** Names that reach an object's prototype; never merged. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** One changed value, by its dotted path (`settings.triageMaxAgeDays.value`); `from` or `to` absent: there was none, or it was removed. */
export interface SettingChange {
  key: string;
  from?: unknown;
  to?: unknown;
}

/** The values that differ between two settings objects, leaf by leaf (objects are walked, lists and plain values compared whole). */
export function settingChanges(before: unknown, after: unknown, prefix = ""): SettingChange[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (!isObj(before) || !isObj(after)) {
    const change: SettingChange = { key: prefix };
    if (before !== undefined) change.from = before;
    if (after !== undefined) change.to = after;
    return [change];
  }
  const out: SettingChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    out.push(...settingChanges(Object.hasOwn(before, key) ? before[key] : undefined, Object.hasOwn(after, key) ? after[key] : undefined, prefix === "" ? key : `${prefix}.${key}`));
  }
  return out;
}

/** The settings as Scope Soup writes them: two-space JSON and a line end. */
export function settingsText(settings: Obj): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** `ours`' change since `base`, made again on `theirs`: a key only `ours` changed takes `ours`' value; the rest stays `theirs`'. */
function applyDiff(base: unknown, ours: unknown, theirs: unknown): unknown {
  if (isDeepStrictEqual(base, ours)) return theirs;
  if (!isObj(base) || !isObj(ours) || !isObj(theirs)) return ours;
  const out: Obj = { ...theirs };
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (FORBIDDEN.has(key)) continue;
    const was = Object.hasOwn(base, key) ? base[key] : undefined;
    const mine = Object.hasOwn(ours, key) ? ours[key] : undefined;
    if (isDeepStrictEqual(was, mine)) continue;
    const merged = applyDiff(was, mine, Object.hasOwn(theirs, key) ? theirs[key] : undefined);
    if (merged === undefined) delete out[key];
    else out[key] = merged;
  }
  return out;
}

/**
 * Two machines saved the settings at once: this side's save (`ours`, made on `base`) is put on top of the other side's
 * (`theirs`). Only the values this side's save changed are made again on `theirs`; a value both changed takes this side's,
 * as a save on one machine that lost the compare-and-swap is made again on the newest settings. Null `base` or `theirs`:
 * there was no file.
 */
export function mergeSettings(base: string | null, ours: string, theirs: string | null): { ok: true; text: string } | { ok: false; problem: string } {
  const parse = (text: string | null, side: string): Obj | string => {
    if (text === null) return {};
    try {
      const value = JSON.parse(text) as unknown;
      return isObj(value) ? value : `${SETTINGS_FILE} on ${side} is not a JSON object`;
    } catch {
      return `${SETTINGS_FILE} on ${side} is not valid JSON`;
    }
  };
  const was = parse(base, "the base");
  const mine = parse(ours, "this side");
  const other = parse(theirs, "the other side");
  for (const side of [was, mine, other]) if (typeof side === "string") return { ok: false, problem: side };
  return { ok: true, text: settingsText(applyDiff(was, mine, other) as Obj) };
}
