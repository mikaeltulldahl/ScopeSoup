// The answers read from an Item's log (meta branch) as the answering server recorded them. Synthetic texts.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRecord, WorkItem } from "../model/types.ts";
import { addAnswer, answersFromLog, knownAnswers } from "./answers.ts";
import { openStore } from "./store.ts";

const PERSON = { who: "Ada", agent: false };
const BOT = { who: "scopesoup", agent: true };
const AT = "2026-11-18T10:00:00.000Z";
const item = (log: LogRecord[]): WorkItem => ({ ref: { host: "metaBranch", kind: "work", id: "A-1" }, title: "Item", state: "todo", log } as WorkItem);
const read = (log: LogRecord[]): [string, string | undefined][] => answersFromLog(item(log)).map((answer) => [answer.answer, answer.question]);

test("of two questions asked in one instant, an answer names the one its toQuestion says", () => {
  assert.deepEqual(read([
    { at: AT, by: BOT, kind: "question", fields: { question: "Part 20?" } },
    { at: AT, by: BOT, kind: "question", fields: { question: "Part 11?" } },
    { at: AT, by: PERSON, kind: "answer", fields: { answer: "yes", to: AT, toQuestion: "Part 11?" } },
  ]), [["yes", "Part 11?"]]);
});

test("a line's own question, else the line its to names", () => {
  assert.deepEqual(read([
    { at: AT, by: BOT, kind: "question", fields: { question: "Part 20?" } },
    { at: AT, by: PERSON, kind: "answer", fields: { answer: "no", to: AT } },
    { at: AT, by: PERSON, kind: "answer", fields: { answer: "Go on.", toSet: "1@x", question: "Why stopped?" } },
  ]), [["no", "Part 20?"], ["Go on.", "Why stopped?"]]);
});

test("a line with answers stands for each of them (a triage rewrite's answers and its decision); an agent's line is no answer", () => {
  assert.deepEqual(read([
    { at: AT, by: PERSON, kind: "answer", fields: { answer: "Accepted the triage's rewrite, keeping the recommendations: yes.", answers: [{ question: "Part 20?", answer: "yes" }, { question: "Triage rewrite, round 1", answer: "Accepted." }] } },
    { at: AT, by: BOT, kind: "answer", fields: { answer: "Not a person's." } },
  ]), [["yes", "Part 20?"], ["Accepted.", "Triage rewrite, round 1"]]);
});

test("an answer kept here and in the log is one; the same answer given to two asks of one question is two everywhere", () => {
  const log: LogRecord[] = [
    { at: AT, by: PERSON, kind: "answer", fields: { answer: "yes", toSet: "1@a", question: "Part 20?" } },
    { at: "2026-11-18T11:00:00.000Z", by: { ...PERSON, machine: "laptop-b" }, kind: "answer", fields: { answer: "yes", toSet: "2@b", question: "Part 20?" } },
  ];
  const here = openStore(":memory:");
  const there = openStore(":memory:");
  for (const store of [here, there]) store.put(item(log), "sync", AT);
  // This machine gave the first; the other machine's board the second.
  addAnswer(here, { subject: item([]).ref, answer: "yes", question: "Part 20?", by: "Ada", at: "2026-11-18T09:59:59.500Z" });
  assert.equal(knownAnswers(here).length, 2);
  assert.equal(knownAnswers(there).length, 2);
});
