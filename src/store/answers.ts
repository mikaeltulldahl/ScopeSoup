// What a person answered on items. Scope Soup keeps these itself where a host has no place for them
// that a sync would not overwrite. On GitHub the answers are comments, read into each Item,
// and nothing is kept here for an answer to a question.

import type { RecordedAnswer, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "./store.ts";

const KEY = "person.answers";

export function loadAnswers(store: Store): RecordedAnswer[] {
  const text = store.getValue(KEY);
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as RecordedAnswer[]) : [];
  } catch {
    return [];
  }
}

/** The host id of GitHub Items (the GitHub adapter's default, which the hosts set up never change). */
const GITHUB_HOST = "github";

/**
 * Every answer Scope Soup acts on (answer reuse, prompts, the Item page), oldest first: the ones kept here, and on GitHub
 * the answer comments read into each Item.
 */
export function knownAnswers(store: Store): RecordedAnswer[] {
  const onHost = store.list<WorkItem>("work", GITHUB_HOST).flatMap((item) => item.answers ?? []);
  if (onHost.length === 0) return loadAnswers(store);
  return [...loadAnswers(store), ...onHost].map((answer, index) => ({ answer, index })).sort((a, b) => Date.parse(a.answer.at) - Date.parse(b.answer.at) || a.index - b.index).map((each) => each.answer);
}

/** Records an answer and writes `person.answered` in the same transaction. */
export function addAnswer(store: Store, answer: RecordedAnswer): void {
  store.tx(() => {
    store.setValue(KEY, JSON.stringify([...loadAnswers(store), answer]));
    store.appendEvent({ kind: "person.answered", subject: refKey(answer.subject), actor: answer.by, data: answer }, answer.at);
  });
}

/** Puts back answers read from an item's log (the store was new), with one `person.answers_restored` event. */
export function restoreAnswers(store: Store, answers: readonly RecordedAnswer[], at: string): void {
  store.tx(() => {
    store.setValue(KEY, JSON.stringify([...loadAnswers(store), ...answers]));
    store.appendEvent({ kind: "person.answers_restored", subject: answers[0] ? refKey(answers[0].subject) : undefined, actor: "orchestrator", data: { reason: "Read back from the item's log.", count: answers.length } }, at);
  });
}

/** The answers on one item as text for a prompt. Empty when there are none. */
export function answersText(answers: readonly RecordedAnswer[], subjectKey: string): string {
  const mine = answers.filter((answer) => refKey(answer.subject) === subjectKey);
  if (mine.length === 0) return "";
  return mine.map((answer) => (answer.question ? `- Asked: ${answer.question}\n  Answered: ${answer.answer}` : `- ${answer.answer}`)).join("\n");
}
