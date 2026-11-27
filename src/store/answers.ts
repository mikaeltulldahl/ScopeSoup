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

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The answers in an Item's log (meta branch), each with the question it names, as the answering server recorded them: a line's
 * `answers` when it stands for several (a triage rewrite's answers and its decision), else its `answer`, with the question its
 * `question` gives, else its `toQuestion`, else the line its `to` names. Pure.
 */
export function answersFromLog(item: WorkItem): RecordedAnswer[] {
  const log = item.log ?? [];
  return log.flatMap((line): RecordedAnswer[] => {
    if (line.kind !== "answer" || line.by.agent || !str(line.fields.answer)) return [];
    const one = (answer: string, question: string): RecordedAnswer => ({ subject: item.ref, answer, by: line.by.who, at: line.at, ...(question ? { question } : {}) });
    if (Array.isArray(line.fields.answers)) {
      return line.fields.answers.flatMap((each: unknown) => {
        const { answer, question } = (typeof each === "object" && each !== null ? each : {}) as { answer?: unknown; question?: unknown };
        return str(answer) ? [one(str(answer), str(question))] : [];
      });
    }
    // `toQuestion` before the line `to` names: several questions may share one instant.
    const to = str(line.fields.to);
    const asked = to ? log.find((each) => each.kind === "question" && Date.parse(each.at) === Date.parse(to)) : undefined;
    return [one(str(line.fields.answer), str(line.fields.question) || str(line.fields.toQuestion) || str(asked?.fields.question))];
  });
}

/** One answer however it was read: the same answer to the same question on the same Item. The store's time is the server's, the log line's the host's, so the time does not tell them apart. */
export const sameAnswer = (answer: RecordedAnswer): string => `${refKey(answer.subject)}|${answer.question ?? ""}|${answer.answer}`;

/**
 * Every answer Scope Soup acts on (answer reuse, prompts, the Item page), oldest first: the ones kept here; the ones in each
 * meta-branch Item's log, which every machine reads on every sync, so an answer given on another machine's board counts here too
 * (an answer kept here and in the log is one answer, each kept one standing for one of the log's); and on GitHub the answer comments read into each Item.
 */
export function knownAnswers(store: Store): RecordedAnswer[] {
  const kept = loadAnswers(store);
  const works = store.list<WorkItem>("work");
  // Each answer kept here is one of the log's: the same answer given twice (to two asks of one question) is two in both.
  const had = new Map<string, number>();
  for (const answer of kept) had.set(sameAnswer(answer), (had.get(sameAnswer(answer)) ?? 0) + 1);
  const fromLogs = works.flatMap((item) => (item.log ? answersFromLog(item) : [])).filter((answer) => {
    const left = had.get(sameAnswer(answer)) ?? 0;
    if (left > 0) had.set(sameAnswer(answer), left - 1);
    return left === 0;
  });
  const onHost = works.filter((item) => item.ref.host === GITHUB_HOST).flatMap((item) => item.answers ?? []);
  if (fromLogs.length === 0 && onHost.length === 0) return kept;
  return [...kept, ...fromLogs, ...onHost].map((answer, index) => ({ answer, index })).sort((a, b) => Date.parse(a.answer.at) - Date.parse(b.answer.at) || a.index - b.index).map((each) => each.answer);
}

/** Records an answer and writes `person.answered` in the same transaction. */
export function addAnswer(store: Store, answer: RecordedAnswer): void {
  store.tx(() => {
    store.setValue(KEY, JSON.stringify([...loadAnswers(store), answer]));
    store.appendEvent({ kind: "person.answered", subject: refKey(answer.subject), actor: answer.by, data: answer }, answer.at);
  });
}

/** The answers on one item as text for a prompt. Empty when there are none. */
export function answersText(answers: readonly RecordedAnswer[], subjectKey: string): string {
  const mine = answers.filter((answer) => refKey(answer.subject) === subjectKey);
  if (mine.length === 0) return "";
  return mine.map((answer) => (answer.question ? `- Asked: ${answer.question}\n  Answered: ${answer.answer}` : `- ${answer.answer}`)).join("\n");
}
