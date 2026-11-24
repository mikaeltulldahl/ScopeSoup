// The picks a person made on the decisions implementors took themselves (Accept, or Overturn with a decision) but has not
// sent yet. Like held answers (heldAnswers.ts) they stay in this browser (localStorage, one entry per Item, keyed by decision id)
// until Send, so a reload keeps them. Pure apart from the storage handed in; every access is wrapped.

import type { HeldStorage } from "./heldAnswers.ts";

/** A pick on one decision: Accept, or Overturn with a person's decision (the text may still be empty while it is written). */
export interface HeldPick {
  action: "accept" | "overturn";
  answer: string;
}

/** One pick as `POST /api/decisions` takes it. */
export interface PickEntry {
  id: string;
  action: "accept" | "overturn";
  answer?: string;
}

const PREFIX = "scopesoup.heldDecisions.";

/** The storage key of an Item's held picks. */
export const picksKey = (itemKey: string): string => `${PREFIX}${itemKey}`;

function isPick(value: unknown): value is HeldPick {
  if (typeof value !== "object" || value === null) return false;
  const { action, answer } = value as { action?: unknown; answer?: unknown };
  return (action === "accept" || action === "overturn") && typeof answer === "string";
}

function readAll(storage: HeldStorage | null, itemKey: string): Record<string, HeldPick> {
  try {
    const parsed = JSON.parse(storage?.getItem(picksKey(itemKey)) ?? "null") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, HeldPick] => isPick(entry[1])));
  } catch {
    return {};
  }
}

/** The held picks of the open decisions `ids` of an Item; a pick on a decision settled since (or gone) is left out. */
export function loadPicks(storage: HeldStorage | null, itemKey: string, ids: readonly string[]): Record<string, HeldPick> {
  const all = readAll(storage, itemKey);
  return Object.fromEntries(ids.flatMap((id) => (all[id] ? [[id, all[id]] as const] : [])));
}

/** Keeps `picks` as the Item's held picks; with none left the entry goes. */
export function savePicks(storage: HeldStorage | null, itemKey: string, picks: Record<string, HeldPick>): void {
  try {
    if (Object.keys(picks).length === 0) storage?.removeItem(picksKey(itemKey));
    else storage?.setItem(picksKey(itemKey), JSON.stringify(picks));
  } catch {
    // Storage full or refused: the picks are still on the page, only a reload loses them.
  }
}

/** After a Send: the picks sent (`ids`) are no longer held; the others stay. */
export function clearPicks(storage: HeldStorage | null, itemKey: string, ids: readonly string[]): void {
  const all = readAll(storage, itemKey);
  for (const id of ids) delete all[id];
  savePicks(storage, itemKey, all);
}

/** The picks that can be sent, in the order of `ids`: every Accept, and an Overturn once its decision is written. */
export function readyPicks(picks: Record<string, HeldPick>, ids: readonly string[]): PickEntry[] {
  return ids.flatMap((id): PickEntry[] => {
    const pick = picks[id];
    if (!pick) return [];
    if (pick.action === "accept") return [{ id, action: "accept" }];
    const answer = pick.answer.trim();
    return answer ? [{ id, action: "overturn", answer }] : [];
  });
}

/** How many picks are held for an Item (an Overturn still being written counts too), for the "not sent" note on its card. */
export const picksCount = (storage: HeldStorage | null, itemKey: string): number => Object.keys(readAll(storage, itemKey)).length;

/** The card's "not sent" note for an Item's held answers and decision picks, or null when nothing is held. */
export function unsentNote(answers: number, picks: number): string | null {
  if (answers > 0 && picks > 0) return "answers and decisions not sent";
  if (answers > 0) return "answers not sent";
  if (picks > 0) return "decisions not sent";
  return null;
}
