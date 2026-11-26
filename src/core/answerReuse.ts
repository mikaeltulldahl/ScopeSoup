// Reusing an answer: a question that comes back after re-triage, reworded, about the same
// decision on an Item whose text has not changed. Pure.

import type { DecisionOption, RecordedAnswer, Ref, WorkItem } from "../model/types.ts";
import { optionText, refKey } from "../model/types.ts";

/** A hash of the text of an Item that its decisions rest on: the title, the description and the verification. */
export function itemTextHash(item: Pick<WorkItem, "title" | "body" | "verification">): string {
  const text = JSON.stringify([item.title.trim(), (item.body ?? "").trim(), (item.verification ?? "").trim()]);
  // Two 32-bit FNV-1a passes with different seeds: pure, and enough to tell an edited text from an unedited one.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The option texts of a question, for keeping with an answer. */
export function optionTexts(options: readonly DecisionOption[]): string[] {
  return options.map(optionText);
}

function normal(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function words(text: string): Set<string> {
  return new Set(normal(text).split(" ").filter((word) => word.length > 2));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** True when the two questions are about the same decision: the same options, or mostly the same words. */
export function sameDecision(
  asked: { question: string; options: readonly string[] },
  answered: { question: string; options?: readonly string[] },
): boolean {
  if (normal(asked.question) === normal(answered.question)) return true;
  const a = asked.options.map(normal).filter(Boolean).sort();
  const b = (answered.options ?? []).map(normal).filter(Boolean).sort();
  if (a.length >= 2 && a.length === b.length && a.every((each, index) => each === b[index])) return true;
  return overlap(words(asked.question), words(answered.question)) >= 0.6;
}

/**
 * The newest answer on the item that was given with the item's text as it is now and that answers a question about the same
 * decision as `asked`. Answers kept without a text hash (older ones) are not reused.
 */
export function reusableAnswer(
  answers: readonly RecordedAnswer[],
  item: WorkItem,
  asked: { question: string; options: readonly DecisionOption[] },
): RecordedAnswer | undefined {
  if (conflictPair(asked.question)) return undefined;
  const key = refKey(item.ref);
  const hash = itemTextHash(item);
  const options = optionTexts(asked.options);
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index]!;
    if (refKey(answer.subject) !== key || answer.textHash !== hash || !answer.question) continue;
    if (answer.question.startsWith("Proposed rewrite:")) continue;
    // A conflict between two Items is decided per pair (`pairAnswer`), whatever the text.
    if (conflictPair(answer.question)) continue;
    if (sameDecision({ question: asked.question, options }, { question: answer.question, ...(answer.options ? { options: answer.options } : {}) })) return answer;
  }
  return undefined;
}

/** The answer to a conflict question that lets both Items go on. */
export const GO_ON_WITH_BOTH = "Go on with both";

/** The answer to a conflict question that holds `held` until `until` is done. */
export const holdAnswer = (held: string, until: string): string => `Hold ${held} until ${until} is done`;

/** The question a triage's `conflictsWith` link becomes; `conflictPair` reads the two Item ids back from it. */
export function conflictQuestion(self: string, other: string, title: string): string {
  return `${self} conflicts with ${other} "${title}". Go on with both, or hold ${self} until ${other} is done?`;
}

/** The two Item ids of a question exactly as `conflictQuestion` writes it (the asking Item first), or null for any other question. */
export function conflictPair(question: string): [string, string] | null {
  const found = /^(\S+) conflicts with (\S+) "[\s\S]*"\. Go on with both, or hold (\S+) until (\S+) is done\?$/.exec(question.trim());
  return found && found[3] === found[1] && found[4] === found[2] ? [found[1]!, found[2]!] : null;
}

/** An answer that picks `label`: the label itself, or the label with its description (`label: description`), as pickers send it. */
function pickedLabel(answer: string, label: string): boolean {
  const given = answer.trim().toLowerCase();
  const wanted = label.toLowerCase();
  return given === wanted || given.startsWith(`${wanted}:`);
}

/** What the newest answer about a conflict between two Items said: go on, hold one of them (`held`), or something else (null). */
export type PairAnswer = { kind: "go-on" } | { kind: "hold"; held: string; until: string };

/**
 * The newest answer to a conflict question about `a` and `b`, asked on either of them, whatever the Items' text: a later answer
 * replaces an earlier one. Null when there is none, or it was neither "go on" nor a hold (the person said something else).
 */
export function pairAnswer(answers: readonly RecordedAnswer[], a: Ref, b: Ref): PairAnswer | null {
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index]!;
    if (answer.subject.host !== a.host) continue;
    const pair = conflictPair(answer.question ?? "");
    if (!pair || !((pair[0] === a.id && pair[1] === b.id) || (pair[0] === b.id && pair[1] === a.id))) continue;
    if (pickedLabel(answer.answer, GO_ON_WITH_BOTH)) return { kind: "go-on" };
    if (pickedLabel(answer.answer, holdAnswer(pair[0], pair[1]))) return { kind: "hold", held: pair[0], until: pair[1] };
    return null;
  }
  return null;
}

/** True when the newest answer about a conflict between `a` and `b` was to go on with both. */
export function wentOnWithBoth(answers: readonly RecordedAnswer[], a: Ref, b: Ref): boolean {
  return pairAnswer(answers, a, b)?.kind === "go-on";
}

/** The ids of the Items a person said to hold `item` until they are done (the newest answer about each pair is a hold of `item`). */
export function heldUntil(answers: readonly RecordedAnswer[], item: Ref): string[] {
  const others = new Set<string>();
  for (const answer of answers) {
    if (answer.subject.host !== item.host) continue;
    const pair = conflictPair(answer.question ?? "");
    if (pair && (pair[0] === item.id || pair[1] === item.id)) others.add(pair[0] === item.id ? pair[1] : pair[0]);
  }
  return [...others].filter((other) => {
    const said = pairAnswer(answers, item, { ...item, id: other });
    return said?.kind === "hold" && said.held === item.id;
  });
}

/** The question a triage's `duplicateOf` link becomes; `duplicatePair` reads the two Item ids back from it. */
export function duplicateQuestion(self: string, other: string, title: string, reason?: string): string {
  const why = reason?.trim();
  return `Triage found ${self} a duplicate of ${other} "${title}".${why ? ` Its reason: ${/[.!?]$/.test(why) ? why : `${why}.`}` : ""} Which one closes?`;
}

/** The two Item ids of a question as `duplicateQuestion` writes it (the asking Item first), or null for any other question. */
export function duplicatePair(question: string): [string, string] | null {
  const found = /^Triage found (\S+) a duplicate of (\S+) "[\s\S]*"\.[\s\S]* Which one closes\?$/.exec(question.trim());
  return found ? [found[1]!, found[2]!] : null;
}

/** The answer to a duplicate question that keeps both Items. */
export const KEEP_BOTH = "Keep both";

/** The answer to a duplicate question that closes `closed` as a duplicate of `of`. */
export const closeAnswer = (closed: string, of: string): string => `Close ${closed} as a duplicate of ${of}`;

/**
 * The newest answer to a duplicate question about `a` and `b` (asked on either of them, in either direction) when it stands: "Keep
 * both", or a close that took effect (`isClosed` says the Item it named is closed). A close that did not happen (the write failed, or
 * the Item was left open as busy), or anything else a person wrote, does not settle the pair. A later answer replaces an earlier one.
 */
export function duplicateSettled(answers: readonly RecordedAnswer[], a: Ref, b: Ref, isClosed: (id: string) => boolean): RecordedAnswer | undefined {
  const newest = answers.findLast((answer) => {
    if (answer.subject.host !== a.host) return false;
    const pair = duplicatePair(answer.question ?? "");
    return pair !== null && ((pair[0] === a.id && pair[1] === b.id) || (pair[0] === b.id && pair[1] === a.id));
  });
  if (!newest) return undefined;
  if (pickedLabel(newest.answer, KEEP_BOTH)) return newest;
  for (const [closed, of] of [[a.id, b.id], [b.id, a.id]] as const) if (pickedLabel(newest.answer, closeAnswer(closed, of)) && isClosed(closed)) return newest;
  return undefined;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `text` names the Item `id` (`A-3`, `#12`, `12`) as a word of its own. */
const mentions = (text: string, id: string): boolean => new RegExp(`(?:^|[^\\p{L}\\p{N}-])#?${escaped(id)}(?![\\p{L}\\p{N}])`, "u").test(text);

/**
 * True when an agent's question (its text and options) reads as asking which of the two Items `a` and `b` to keep: it names one of
 * them with words of duplicates or of one staying open, or names both with closing. Scope Soup asks that itself (`duplicateQuestion`).
 */
export function asksAboutDuplicate(question: { question: string; options: readonly DecisionOption[] }, a: string, b: string): boolean {
  const text = [question.question, ...question.options.map(optionText)].join(" ");
  const names = [a, b].filter((id) => mentions(text, id)).length;
  if (names >= 1 && /duplicat|\b(?:stays?|kept|keeps?|remains?|leaves?)(?: \S+)? open\b|\bwhich (?:one|of (?:the|them|these|those))\b/i.test(text)) return true;
  return names === 2 && /\b(?:close[sd]?|closing)\b/i.test(text);
}
