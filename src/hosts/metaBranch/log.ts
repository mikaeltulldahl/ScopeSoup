// `items/<id>/log.jsonl`: one JSON object per line, append-only. Pure parsing, and the fold of a
// log into the item's current picture. The format is in docs/DESIGN.md ("Items on a meta branch").
//
// Nothing here is fatal: a line that cannot be read, or a known kind with fields that do not fit,
// is kept with its problem and counted; a kind Scope Soup does not know is kept and counted.

import { asOptions, asRestructuringRecord } from "../../model/types.ts";
import type { DecisionOption, OriginalFate, ProposedPart } from "../../model/types.ts";
import { isBranchName, isFullSha } from "./ids.ts";

/** Who wrote a line: a person or an agent, and on which machine. */
export interface LogActor {
  who: string;
  machine?: string;
  agent: boolean;
}

export interface LogEntry {
  /** 1-based line number in the file. */
  line: number;
  /** The time as UTC ISO 8601 (`2026-11-18T09:00:00.000Z`), whatever offset the line wrote. */
  at: string;
  by: LogActor;
  kind: string;
  /** The whole object as written, `at`, `by` and `kind` included. */
  data: Record<string, unknown>;
  /** The line's identity: its whole content with times and `by` in canonical form. Equal keys are one line. */
  key: string;
}

export interface BadLine {
  line: number;
  raw: string;
  problem: string;
}

export interface ParsedLog {
  entries: LogEntry[];
  malformed: BadLine[];
}

/** Short text with no control characters: names of people, agents and machines. */
const NAME = /^[^\u0000-\u001f\u007f]{1,100}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function isLogTime(value: unknown): value is string {
  return typeof value === "string" && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

/** A log time as UTC ISO 8601 with milliseconds. */
const utc = (value: string): string => new Date(value).toISOString();

/** An actor as text, for ordering and for telling two spellings of the same writer apart from other writers. */
const actorText = (actor: LogActor): string => JSON.stringify([actor.who, actor.machine ?? null, actor.agent]);

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with object keys in code-unit order, so equal content gives equal text. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(byCodeUnits).map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The fields that hold a time or a writer are put in canonical form before two lines are compared. */
function identity(data: Record<string, unknown>, at: string, by: LogActor): string {
  const copy: Record<string, unknown> = { ...data, at, by: actorText(by) };
  if (isLogTime(copy.until)) copy.until = utc(copy.until);
  if (isLogTime(copy.to)) copy.to = utc(copy.to);
  const toBy = actorOf(copy.toBy);
  if (toBy) copy.toBy = actorText(toBy);
  return stableJson(copy);
}

function actorOf(value: unknown): LogActor | null {
  if (typeof value === "string") return NAME.test(value) ? { who: value, agent: false } : null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { who, machine, agent } = value as Record<string, unknown>;
  if (typeof who !== "string" || !NAME.test(who)) return null;
  if (machine !== undefined && (typeof machine !== "string" || !NAME.test(machine))) return null;
  if (agent !== undefined && typeof agent !== "boolean") return null;
  const actor: LogActor = { who, agent: agent === true };
  if (machine !== undefined) actor.machine = machine;
  return actor;
}

/** Reads every line. Blank lines are skipped and not counted. */
export function parseLog(text: string): ParsedLog {
  const entries: LogEntry[] = [];
  const malformed: BadLine[] = [];
  const lines = text.replace(/^﻿/, "").split("\n");
  lines.forEach((rawLine, index) => {
    const raw = rawLine.replace(/\r$/, "");
    if (raw.trim() === "") return;
    const line = index + 1;
    const bad = (problem: string): void => void malformed.push({ line, raw, problem });
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return bad("not JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("not a JSON object");
    const data = value as Record<string, unknown>;
    if (!isLogTime(data.at)) return bad("`at` is not an ISO 8601 time with a zone");
    const by = actorOf(data.by);
    if (!by) return bad("`by` is not a name or { who, machine?, agent? }");
    if (typeof data.kind !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(data.kind)) return bad("`kind` is missing or not a short lower-case word");
    const at = utc(data.at);
    entries.push({ line, at, by, kind: data.kind, data, key: identity(data, at, by) });
  });
  return { entries, malformed };
}

// --- the fold ---

export interface Holder {
  by: LogActor;
  at: string;
  until?: string;
}

export interface RevisionLine {
  at: string;
  by: LogActor;
  sha: string;
  branch?: string;
}

export interface VerdictLine {
  at: string;
  by: LogActor;
  sha: string;
  verdict: "pass" | "fail";
  findings: string[];
  /** For `check`: the command that was run. */
  command?: string;
}

export interface MergedLine {
  at: string;
  by: LogActor;
  sha: string;
  target?: string;
}

export interface QuestionLine {
  at: string;
  by: LogActor;
  question: string;
  options: DecisionOption[];
  recommendation?: string;
  /** What the asker said beyond the options. */
  context?: string;
  /** Several options may be picked. */
  multiSelect?: true;
  /** A proposed restructuring: `original`, `parts` (and `carried`), and `reason`. */
  proposal?: { id: string; reason: string; original: OriginalFate; parts: ProposedPart[]; carried?: string };
  /** The park that asked it: a question of another set by the same writer replaces it. */
  set?: string;
}

/** An item's current picture, as far as its log tells it. */
export interface LogPicture {
  holder?: Holder;
  /** The branch of the newest revision that named one. */
  branch?: string;
  /** Oldest first. */
  revisions: RevisionLine[];
  reviews: VerdictLine[];
  checks: VerdictLine[];
  /** The newest revision's `merged` line. A line for an older revision does not count. */
  merged?: MergedLine;
  /** Questions with no answer yet, oldest first. */
  openQuestions: QuestionLine[];
  /** The newest `at` of any readable line. */
  lastAt?: string;
  /** How many lines were read as entries, known kind or not. */
  entries: number;
  /** Every readable line once, in fold order: the item's history. */
  lines: LogEntry[];
  /** Entries of a kind Scope Soup does not know: kept, counted, otherwise ignored. */
  unknown: LogEntry[];
  /** Lines that could not be read, and known kinds whose fields do not fit. Kept, counted, ignored. */
  malformed: BadLine[];
}

const sameActor = (a: LogActor, b: LogActor): boolean => a.who === b.who && a.machine === b.machine;
/** The holder's own line: an agent's from the same machine; a person's from any machine (a person is not tied to one). */
const holderOwn = (held: LogActor, by: LogActor): boolean => (held.agent === true ? sameActor(held, by) : by.agent !== true && held.who === by.who);

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

function texts(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
}

const later = (a: string | undefined, b: string): string => (a === undefined || Date.parse(b) > Date.parse(a) ? b : a);

/** The order lines are folded in: the instant, then the writer's text, then the place in the file. */
function foldOrder(a: LogEntry, b: LogEntry): number {
  return Date.parse(a.at) - Date.parse(b.at) || byCodeUnits(actorText(a.by), actorText(b.by)) || a.line - b.line;
}

/**
 * Folds the entries. The file's order does not matter (two laptops' logs may be merged by keeping
 * both sets of lines): lines are put in the order of `at` as an instant, then `by` as text, then
 * their place in the file, and a line identical to an earlier one (same content) is dropped.
 * Rules:
 * - `claimed` needs `until`. It takes the item when nobody holds it, when the holder claims again
 *   (renewal), or when an agent holder's `until` has passed by this line's `at`. Otherwise the earlier
 *   claim stands. A person's claim never runs out (no stall timer): only their `released` ends it.
 * - The holder's own line: an agent's is one from the same `who` and `machine`; a person's (a person is not tied
 *   to a machine) is one by that person (`who`) from any machine.
 * - `released` lets go when it is the holder's own, or (people are equals, anyone releases anyone's hold) when a
 *   person writes it with `of` naming the person who holds it (`who@machine`, or `who` without a machine). An agent's
 *   claim is let go only by that agent.
 * - `revision`, `review`, `check` and `merged` make the change. A `sha` is a full commit id. A
 *   revision whose sha is already there is the same revision. `merged` counts only when its sha is
 *   the newest revision's.
 * - `question` is open until an `answer` names it by its `at` in `to` (and, when the answer has
 *   it, its writer in `toBy` and its text in `toQuestion`, for several asked at once), whichever of the two folds first, or, without `to`, until the next
 *   answer (which takes the newest question open at the end of its own instant; with `toSet`, the question of that set, by
 *   `toQuestion` when given, whichever folds first), or until a question of
 *   another `set` by the same writer replaces it (each park of Scope Soup's writes one set).
 */
export function foldLog(log: ParsedLog): LogPicture {
  const picture: LogPicture = { revisions: [], reviews: [], checks: [], openQuestions: [], entries: log.entries.length, lines: [], unknown: [], malformed: [...log.malformed] };
  const seen = new Set<string>();
  const ordered = [...log.entries].sort(foldOrder).filter((entry) => !seen.has(entry.key) && !!seen.add(entry.key));
  picture.lines = ordered;
  const merges: MergedLine[] = [];
  // Answers that named a question not folded yet.
  const earlyAnswers: { to: number; toBy?: LogActor; toQuestion?: string }[] = [];
  // Answers that named a set of questions not folded yet.
  const setAnswers: { set: string; toQuestion?: string }[] = [];
  // Answers without `to`, by their instant: each takes the newest open question once its instant is folded, so a question of the same
  // instant that folds after it (an earlier `by` as text) is the one it answers.
  const newestAnswers: number[] = [];
  // The questions of a set that were answered: the same question of that set written again later (a retried write) stays answered.
  const answered = new Set<string>();
  const answeredKey = (question: { set?: string; question: string; by: LogActor }): string | null => (question.set ? JSON.stringify([question.set, question.question, question.by.who, question.by.machine ?? ""]) : null);
  const markAnswered = (question: QuestionLine | undefined): void => {
    const key = question ? answeredKey(question) : null;
    if (key) answered.add(key);
  };
  const answerNewest = (before: number): void => {
    while (newestAnswers.length > 0 && newestAnswers[0]! < before) {
      newestAnswers.shift();
      markAnswered(picture.openQuestions.pop());
    }
  };
  for (const entry of ordered) {
    const { at, by, data } = entry;
    answerNewest(Date.parse(at));
    picture.lastAt = later(picture.lastAt, at);
    const bad = (problem: string): void => void picture.malformed.push({ line: entry.line, raw: JSON.stringify(data), problem });
    const sha = text(data.sha);
    const needSha = (): string | null => {
      if (sha && isFullSha(sha)) return sha;
      bad(`a ${entry.kind} line needs \`sha\`, a full commit id (40 or 64 lower-case hex digits)`);
      return null;
    };
    const openBefore = entry.kind === "answer" ? [...picture.openQuestions] : null;
    switch (entry.kind) {
      case "claimed": {
        if (!isLogTime(data.until)) {
          bad("a claimed line needs `until`, an ISO 8601 time with a zone");
          break;
        }
        const until = utc(data.until);
        const held = picture.holder;
        // A person's hold has no stall timer: its `until` never frees it; only the person's `released` line does.
        const free = !held || holderOwn(held.by, by) || (held.by.agent === true && held.until !== undefined && Date.parse(held.until) <= Date.parse(at));
        if (free) picture.holder = { by, at, until };
        break;
      }
      case "released": {
        const held = picture.holder;
        if (!held) break;
        const heldBy = held.by.machine ? `${held.by.who}@${held.by.machine}` : held.by.who;
        if (holderOwn(held.by, by) || (held.by.agent !== true && by.agent !== true && text(data.of) === heldBy)) delete picture.holder;
        break;
      }
      case "revision": {
        const commit = needSha();
        if (!commit) break;
        const branch = text(data.branch);
        if (branch !== undefined && !isBranchName(branch)) {
          bad("`branch` is not a usable branch name");
          break;
        }
        if (picture.revisions.some((revision) => revision.sha === commit)) break;
        picture.revisions.push(branch ? { at, by, sha: commit, branch } : { at, by, sha: commit });
        if (branch) picture.branch = branch;
        break;
      }
      case "review":
      case "check": {
        const commit = needSha();
        if (!commit) break;
        const verdict = data.verdict;
        if (verdict !== "pass" && verdict !== "fail") {
          bad(`a ${entry.kind} line needs \`verdict\`, "pass" or "fail"`);
          break;
        }
        const line: VerdictLine = { at, by, sha: commit, verdict, findings: texts(data.findings) };
        const command = text(data.command);
        if (command) line.command = command;
        (entry.kind === "review" ? picture.reviews : picture.checks).push(line);
        break;
      }
      case "merged": {
        const commit = needSha();
        if (!commit) break;
        const target = text(data.target);
        if (target !== undefined && !isBranchName(target)) {
          bad("`target` is not a usable branch name");
          break;
        }
        merges.push(target ? { at, by, sha: commit, target } : { at, by, sha: commit });
        break;
      }
      case "question": {
        const question = text(data.question);
        if (!question) {
          bad("a question line needs `question`");
          break;
        }
        const line: QuestionLine = { at, by, question, options: asOptions(typeof data.options === "string" ? [data.options] : data.options) };
        const recommendation = text(data.recommendation);
        if (recommendation) line.recommendation = recommendation;
        const context = text(data.context);
        if (context) line.context = context;
        if (data.multiSelect === true) line.multiSelect = true;
        const set = text(data.set);
        if (set) line.set = set;
        const proposed = data.proposal;
        if (typeof proposed === "object" && proposed !== null && !Array.isArray(proposed)) {
          const fields = proposed as Record<string, unknown>;
          const reason = text(fields.reason);
          const restructuring = asRestructuringRecord(fields);
          const carried = text(fields.carried);
          if (reason && restructuring) line.proposal = { reason, ...restructuring, ...(carried ? { carried } : {}) };
          // A proposed rewrite of the item's text (removed): the line stays in the log and the history, but nothing
          // answers it any more, so it is not an open question and the item is not held by it.
          else if (reason && (text(fields.description) || text(fields.verification))) break;
        }
        // A new set of questions from the same writer replaces the set still open (decision 1 of #211).
        if (set) picture.openQuestions = picture.openQuestions.filter((open) => !(open.set !== undefined && open.set !== set && sameActor(open.by, by)));
        // An answer naming this question may fold before it: the same instant with an earlier `by` as text, or another clock.
        const early = earlyAnswers.findIndex((answer) => answer.to === Date.parse(at) && (answer.toBy === undefined || sameActor(by, answer.toBy)) && (answer.toQuestion === undefined || answer.toQuestion === question));
        if (early >= 0) {
          earlyAnswers.splice(early, 1);
          markAnswered(line);
          break;
        }
        // The same question of the same set written again (a write retried after it was taken): one question, open or answered.
        if (set && picture.openQuestions.some((open) => open.set === set && open.question === question && sameActor(open.by, by))) break;
        if (answered.has(answeredKey(line) ?? "")) break;
        const bySet = set ? setAnswers.findIndex((answer) => answer.set === set && (answer.toQuestion === undefined || answer.toQuestion === question)) : -1;
        if (bySet >= 0) {
          setAnswers.splice(bySet, 1);
          markAnswered(line);
          break;
        }
        picture.openQuestions.push(line);
        break;
      }
      case "answer": {
        if (!text(data.answer)) {
          bad("an answer line needs `answer`");
          break;
        }
        // Named by its park's `set` (and text): Scope Soup's store had not read the question back when the answer was given.
        const toSet = text(data.toSet);
        if (data.to === undefined && toSet) {
          const toQuestion = text(data.toQuestion);
          const match = (open: QuestionLine): boolean => open.set === toSet && (toQuestion === undefined || open.question === toQuestion);
          let index = -1;
          picture.openQuestions.forEach((open, i) => void (match(open) && (index = i)));
          if (index >= 0) picture.openQuestions.splice(index, 1);
          else setAnswers.push({ set: toSet, ...(toQuestion ? { toQuestion } : {}) });
          break;
        }
        if (data.to === undefined) {
          newestAnswers.push(Date.parse(at));
          break;
        }
        if (!isLogTime(data.to)) {
          bad("`to` is not an ISO 8601 time with a zone (the `at` of the question answered)");
          break;
        }
        const toBy = data.toBy === undefined ? undefined : actorOf(data.toBy);
        if (toBy === null) {
          bad("`toBy` is not a name or { who, machine?, agent? }");
          break;
        }
        const to = Date.parse(data.to);
        // With `toQuestion`, of several asked in the same instant only the one with that text (or, with none, the first); without, all.
        const toQuestion = text(data.toQuestion);
        const named = (question: QuestionLine): boolean => Date.parse(question.at) === to && (toBy === undefined || sameActor(question.by, toBy));
        const before = picture.openQuestions.length;
        if (toQuestion === undefined) picture.openQuestions = picture.openQuestions.filter((question) => !named(question));
        else {
          const exact = picture.openQuestions.findIndex((question) => named(question) && question.question === toQuestion);
          const found = exact >= 0 ? exact : picture.openQuestions.findIndex(named);
          if (found >= 0) picture.openQuestions.splice(found, 1);
        }
        if (picture.openQuestions.length === before) earlyAnswers.push({ to, ...(toBy ? { toBy } : {}), ...(toQuestion ? { toQuestion } : {}) });
        break;
      }
      case "settings":
        // A save of the shared settings, in the settings' own log (settings/log.jsonl): what changed.
        if (!Array.isArray(data.changes)) bad("a settings line needs `changes`, a list of { key, from?, to? }");
        break;
      case "created":
      case "edited":
      case "session":
      case "assumption":
      // A person's verdict on an implementor's recorded decision; read by `assumptionsOf` (map.ts).
      case "accepted":
      case "overturned":
        // Kept in the log for the item page and the orchestrator; no effect on the picture.
        break;
      default:
        picture.unknown.push(entry);
    }
    if (openBefore) for (const question of openBefore) if (!picture.openQuestions.includes(question)) markAnswered(question);
  }
  answerNewest(Infinity);
  // The change has merged when the newest revision has: an older revision's `merged` says nothing.
  const newest = picture.revisions[picture.revisions.length - 1];
  const merged = newest ? merges.filter((line) => line.sha === newest.sha).pop() : undefined;
  if (merged) picture.merged = merged;
  return picture;
}
