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
  const key = refKey(item.ref);
  const hash = itemTextHash(item);
  const options = optionTexts(asked.options);
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index]!;
    if (refKey(answer.subject) !== key || answer.textHash !== hash || !answer.question) continue;
    if (answer.question.startsWith("Proposed rewrite:")) continue;
    if (sameDecision({ question: asked.question, options }, { question: answer.question, ...(answer.options ? { options: answer.options } : {}) })) return answer;
  }
  return undefined;
}

/** The answer to a conflict question that lets both Items go on. */
export const GO_ON_WITH_BOTH = "Go on with both";

/** The question a triage's `conflictsWith` link becomes; `conflictPair` reads the two Item ids back from it. */
export function conflictQuestion(self: string, other: string, title: string): string {
  return `${self} conflicts with ${other} "${title}". Go on with both, or hold ${self} until ${other} is done?`;
}

/** The two Item ids a conflict question is about, or null for any other question. */
export function conflictPair(question: string): [string, string] | null {
  const found = /^(\S+) conflicts with (\S+) "/.exec(question.trim());
  return found ? [found[1]!, found[2]!] : null;
}

/**
 * True when the newest answer to a conflict question about `a` and `b`, asked on either of them, was to go on with both. The
 * memory is per pair, whatever the Items' text: a later answer (a hold) replaces it.
 */
export function wentOnWithBoth(answers: readonly RecordedAnswer[], a: Ref, b: Ref): boolean {
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index]!;
    if (answer.subject.host !== a.host) continue;
    const pair = conflictPair(answer.question ?? "");
    if (!pair || !((pair[0] === a.id && pair[1] === b.id) || (pair[0] === b.id && pair[1] === a.id))) continue;
    return answer.answer.trim().toLowerCase().startsWith(GO_ON_WITH_BOTH.toLowerCase());
  }
  return false;
}
