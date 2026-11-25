// The pure parts of the Settings page's saving at once (#157): saves one after another, what a field's text saves as, and when
// the page has what a change needs. No DOM, so a test can run them.

import { commandWords } from "../../src/config/commandLine.ts";

/** Runs the tasks it is given one after another, in the order given, even when one fails: fast changes never overwrite each other. */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** A command line as the file holds it; an empty line is `null`, which removes it. */
export function commandChange(text: string): string[] | null {
  const words = commandWords(text);
  return words.length === 0 ? null : words;
}

/** The text as a whole number within the bounds, or why not. */
export function wholeNumber(text: string, min: number, max: number): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: `A whole number from ${min} to ${max}.` };
  const value = Number(trimmed);
  if (value < min || value > max) return { ok: false, reason: `A whole number from ${min} to ${max}.` };
  return { ok: true, value };
}

/** Images' keep-days: "" is Never (`null`), else a number of days. */
export function keepDaysChange(text: string): { ok: true; value: number | null } | { ok: false; reason: string } {
  if (text.trim() === "") return { ok: true, value: null };
  const number = wholeNumber(text, 0, 3650);
  return number;
}

/** Whether every field level 4 asks for has something in it, so the level can be saved. */
export function levelFourFilled(asks: readonly string[], fields: Readonly<Record<string, string>>): boolean {
  return asks.length > 0 && asks.every((name) => (fields[name] ?? "").trim() !== "");
}

/** What the level 4 row says while the level is picked but not saved: the old level stays in effect. */
export function pendingFourText(from: number, asks: readonly string[], filled: boolean): string {
  if (filled) return "Saving…";
  return `Still level ${from} until ${asks.length > 1 ? "these are" : "this is"} filled in.`;
}

/** The resources as typed are ready to save: every one has a name and a number of units from 1 to 64. */
export function resourcesReady(drafts: readonly { name: string; units: string }[]): boolean {
  return drafts.every((each) => each.name.trim() !== "" && wholeNumber(each.units, 1, 64).ok);
}
