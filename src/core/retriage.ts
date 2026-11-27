// Re-triage of To do within a share of usage (#217). Pure: what was used, the Items and the time come in as arguments.
//
// Like a vector's amortized push: keeping To do's triages fresh costs a fixed share of what Scope Soup uses, not an amount that grows
// with the list. Within the share one To do Item at a time is triaged again, the stalest first; an Item is a candidate only when real
// input changed since its triage (age alone is none) and its triage is older than a floor, so a short list is not triaged over and over.

import type { UsageWindowKind } from "../model/types.ts";

/** The window the share is measured over: the triages taken again and every session started in the last week. */
export const RETRIAGE_WINDOW_MS = 7 * 24 * 3600_000;
/** The floor: an Item's triage is taken again on Scope Soup's own choice only once it is at least this old. */
export const RETRIAGE_FLOOR_MS = 24 * 3600_000;
const DAY_MS = 24 * 3600_000;

export interface RetriageBudgetInput {
  /** `settings.retriageShare`: the share of all expected use (0 to 0.5) the triages taken again on Scope Soup's own choice may take. */
  share: number;
  /** Expected use per window of the triages taken again in the window (each counts a triage's expected use). */
  retriage: Record<UsageWindowKind, number>;
  /** Expected use per window of every session started in the window, those triages too. */
  all: Record<UsageWindowKind, number>;
  /** A triage's expected use per window: the one that would start. */
  next: Record<UsageWindowKind, number>;
}

export interface RetriageBudget {
  allow: boolean;
  /** The share the triages taken again used of all use in the window (the window furthest along decides), 0 to 1. */
  used: number;
  share: number;
  reason: string;
}

const pct = (share: number): string => `${Math.round(share * 100)} %`;

/**
 * Whether one more triage taken again on Scope Soup's own choice fits its share: with it, its use is at most the share of all use,
 * in each window. So it waits until other work has used about (1 / share − 1) triages' worth; with a share of 0 none starts.
 */
export function retriageBudget(input: RetriageBudgetInput): RetriageBudget {
  let used = 0;
  let allow = input.share > 0;
  for (const kind of ["five_hour", "seven_day"] as const) {
    const all = input.all[kind];
    if (all > 0) used = Math.max(used, input.retriage[kind] / all);
    if (input.retriage[kind] + input.next[kind] > input.share * (all + input.next[kind]) + 1e-12) allow = false;
  }
  const words = `triage again has used ${pct(used)} of what Scope Soup used in the last week; its share is ${pct(input.share)}`;
  return { allow, used, share: input.share, reason: allow ? `${words}: one more fits` : input.share <= 0 ? "triage again on Scope Soup's own choice is off (its share is 0 %)" : `${words}: one more would go past it` };
}

/** What changed since an Item's triage that it read: how many commits on main touched its paths, and the other changes, each one. */
export interface RetriageInput {
  commits: number;
  /** Text edited, each blocker or linked Item done since. */
  others: number;
}

/** Whether an Item's triage is old enough to be taken again on Scope Soup's own choice (the floor). */
export function pastFloor(triagedAt: string, now: string): boolean {
  const age = Date.parse(now) - Date.parse(triagedAt);
  return Number.isFinite(age) && age >= RETRIAGE_FLOOR_MS;
}

/** How stale an Item's triage is: real input since it, weighted by its age. No input, no staleness: age alone is no input. */
export function staleness(input: RetriageInput, triagedAt: string, now: string): number {
  const inputs = input.commits + input.others;
  if (inputs <= 0) return 0;
  const days = Math.max(0, (Date.parse(now) - Date.parse(triagedAt)) / DAY_MS);
  return inputs * (1 + (Number.isFinite(days) ? days : 0));
}

/** The stalest candidate, or undefined when none has input; ties go to the earlier one (To do's order). */
export function stalest<T extends { staleness: number }>(candidates: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const each of candidates) if (each.staleness > 0 && (!best || each.staleness > best.staleness)) best = each;
  return best;
}
