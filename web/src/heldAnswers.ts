// The answers a person has picked on an Item page but not sent yet. They stay in this browser (localStorage, one entry
// per Item, keyed by question id) until Send, so a reload keeps them. Pure apart from the storage handed in; every access is
// wrapped, because storage can be missing or refuse (a private window, blocked site data).

/** What is picked for one question: option labels, and a person's own words when "Other" is chosen (null when it is not). */
export interface Held {
  picked: string[];
  other: string | null;
}

/** The part of `Storage` used here, so a test can give a plain object. */
export type HeldStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "scopesoup.heldAnswers.";

/** The storage key of an Item's held answers. */
export const heldKey = (itemKey: string): string => `${PREFIX}${itemKey}`;

/** The browser's localStorage, or null where there is none or it cannot be reached. */
export function browserStorage(): HeldStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isHeld(value: unknown): value is Held {
  if (typeof value !== "object" || value === null) return false;
  const { picked, other } = value as { picked?: unknown; other?: unknown };
  return Array.isArray(picked) && picked.every((each) => typeof each === "string") && (other === null || typeof other === "string");
}

function readAll(storage: HeldStorage | null, itemKey: string): Record<string, Held> {
  try {
    const parsed = JSON.parse(storage?.getItem(heldKey(itemKey)) ?? "null") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, Held] => isHeld(entry[1])));
  } catch {
    return {};
  }
}

/** The held answers of the questions `ids` on an Item; anything held for a question no longer asked is left out. */
export function loadHeld(storage: HeldStorage | null, itemKey: string, ids: readonly string[]): Record<string, Held> {
  const all = readAll(storage, itemKey);
  return Object.fromEntries(ids.flatMap((id) => (all[id] ? [[id, all[id]] as const] : [])));
}

/** Keeps `held` as the Item's held answers (only questions with something picked); with nothing left the entry goes. */
export function saveHeld(storage: HeldStorage | null, itemKey: string, held: Record<string, Held>): void {
  const kept = Object.fromEntries(Object.entries(held).filter(([, each]) => each.picked.length > 0 || each.other !== null));
  try {
    if (Object.keys(kept).length === 0) storage?.removeItem(heldKey(itemKey));
    else storage?.setItem(heldKey(itemKey), JSON.stringify(kept));
  } catch {
    // Storage full or refused: the answers are still on the page, only a reload loses them.
  }
}

/** After a Send: the answers sent (`ids`) are no longer held; the others stay. */
export function clearHeld(storage: HeldStorage | null, itemKey: string, ids: readonly string[]): void {
  const all = readAll(storage, itemKey);
  for (const id of ids) delete all[id];
  saveHeld(storage, itemKey, all);
}

/** How many answers are held for an Item, for the "not sent" note on its card. */
export const heldCount = (storage: HeldStorage | null, itemKey: string): number =>
  Object.values(readAll(storage, itemKey)).filter((each) => each.picked.length > 0 || (each.other ?? "").trim() !== "").length;

/** Picks an option: one question takes one (it replaces the pick, and Other), a multi-select one toggles it. */
export function pick(held: Held | undefined, label: string, multiSelect: boolean): Held {
  if (!multiSelect) return { picked: [label], other: null };
  const picked = held?.picked ?? [];
  return { picked: picked.includes(label) ? picked.filter((each) => each !== label) : [...picked, label], other: held?.other ?? null };
}

/** Chooses "Other" with a person's words; on a single-choice question it replaces the picked option. */
export const pickOther = (held: Held | undefined, text: string, multiSelect: boolean): Held => ({ picked: multiSelect ? held?.picked ?? [] : [], other: text });

/** On a multi-select question, unticks "Other". */
export const dropOther = (held: Held | undefined): Held => ({ picked: held?.picked ?? [], other: null });

/**
 * The answer sent for a question: each picked option as `send` gives it (in the order the options are shown), then a person's
 * own words as written; several are joined with "; ". Empty when nothing is picked.
 */
export function answerText(held: Held | undefined, options: readonly { label: string; send: string }[]): string {
  if (!held) return "";
  const parts = options.filter((option) => held.picked.includes(option.label)).map((option) => option.send);
  const own = (held.other ?? "").trim();
  if (own) parts.push(own);
  return parts.join("; ");
}

/**
 * Whether a question has an answer: an option is picked (one that is still asked), or "Other" holds words. A multi-select
 * question with nothing ticked, or "Other" ticked and left empty, has none, so it is not counted and not sent.
 */
export const isAnswered = (held: Held | undefined, options: readonly { label: string; send: string }[]): boolean =>
  held !== undefined && (options.some((option) => held.picked.includes(option.label)) || (held.other ?? "").trim() !== "");
