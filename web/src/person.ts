// Who is at this board. There is no login, and people are equals and trust each other, so the board asks
// who you are with a picker at the top and remembers it in this browser only. Without storage (a private window, blocked
// site data) it still works for as long as the page is open. Every request names the person (`X-ScopeSoup-Person`).

import type { HeldStorage } from "./heldAnswers.ts";
import { browserStorage } from "./heldAnswers.ts";

export const PERSON_KEY = "scopesoup.person";

/** The header the server reads the board's person from; the name is URI-encoded, as a header carries only plain bytes. */
export const PERSON_HEADER = "X-ScopeSoup-Person";

/** The longest name the server takes. */
export const PERSON_MAX = 100;

/** A name as the board keeps it: inner runs of white space as one space, trimmed, at most `PERSON_MAX` characters. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, PERSON_MAX).trim();
}

/** The person remembered in `storage`, or "" when none is (or the storage cannot be read). */
export function readPerson(storage: HeldStorage | null): string {
  try {
    return cleanName(storage?.getItem(PERSON_KEY) ?? "");
  } catch {
    return "";
  }
}

/** Remembers `name` ("" forgets it). A storage that throws is left alone: the pick then holds for this page only. */
export function writePerson(storage: HeldStorage | null, name: string): void {
  try {
    if (name) storage?.setItem(PERSON_KEY, name);
    else storage?.removeItem(PERSON_KEY);
  } catch {
    // No storage here.
  }
}

let current: string | undefined;
const listeners = new Set<(person: string) => void>();

/** The picked person, or "" when nobody is picked yet. */
export function currentPerson(): string {
  if (current === undefined) current = readPerson(browserStorage());
  return current;
}

/** Picks who is at the board ("" for nobody), remembers it in this browser if it can, and tells every view. */
export function setPerson(name: string): void {
  current = cleanName(name);
  writePerson(browserStorage(), current);
  for (const listener of listeners) listener(current);
}

/** Calls `listener` with the new person on every pick; returns the function that stops it. */
export function onPersonChange(listener: (person: string) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The headers that name the board's person, to add to a request. */
export function personHeaders(person: string = currentPerson()): Record<string, string> {
  return person ? { [PERSON_HEADER]: encodeURIComponent(person) } : {};
}

/** The picker's choices: each known person (the value, as the server matches) with the name shown, which is the display name when there is one. Sorted by what is shown. */
export function pickerOptions(known: readonly string[], picked: string, names: Readonly<Record<string, string>> = {}): { value: string; label: string }[] {
  return pickerNames(known, picked)
    .map((value) => ({ value, label: cleanName(Object.hasOwn(names, value) ? names[value]! : "") || value }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

/** The names the picker offers: the people Scope Soup knows, and the picked one when it is new to Scope Soup. Sorted, each once. */
export function pickerNames(known: readonly string[], picked: string): string[] {
  const names = new Set(known.map(cleanName).filter(Boolean));
  if (picked) names.add(picked);
  return [...names].sort((a, b) => a.localeCompare(b));
}
