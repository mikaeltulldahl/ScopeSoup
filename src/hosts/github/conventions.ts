// Scope Soup's own conventions on GitHub, a layer on top of the plain adapter (docs/github-mapping.md).
// Comment markers, the trust rule, and Qn:/An: replies. Nothing here writes to GitHub; the adapter posts the bodies built here.

import { asLabelChange, changeText, isEmptyChange } from "../../model/labels.ts";
import type { Actor, Assumption, AssumptionSettled, DecisionOption, HostRewrite, LabelChange, HostRecord, LogRecord, OpenQuestion, OriginalFate, PartGoes, RecordedAnswer, ProposedPart, Ref, WorkItem } from "../../model/types.ts";
import { asOptions, asRestructuringRecord, optionText } from "../../model/types.ts";
import type { WorkPort } from "../../ports/host.ts";
import { COMMENT_LIMIT, WorkGone } from "../../ports/host.ts";
import type { Client } from "./client.ts";
import { GitHubError } from "./client.ts";
import type { Scope } from "./map.ts";
import { CLAIMED_LABEL, hasLabel, workRef } from "./map.ts";
import type { RestComment, RestTimelineEvent } from "./rest.ts";

export type MarkerKind = "question" | "answer" | "rewrite" | "claim" | "log" | "merged" | "batch" | "assumption" | "moved";
const KINDS = new Set<string>(["question", "answer", "rewrite", "claim", "log", "merged", "batch", "assumption", "moved"]);

export interface Marker {
  kind: MarkerKind;
  data: Record<string, unknown>;
}

const MARKER = /^<!-- scopesoup:([a-z]+) (\{.*\}) -->$/;

/** The hidden last line. `--` and `>` inside the JSON are escaped, so the HTML comment cannot end early. */
export function writeMarker(kind: MarkerKind, data: Record<string, unknown>): string {
  const json = JSON.stringify(Object.assign({ v: 1 }, data, { v: 1 }))
    .replace(/>/g, "\\u003e")
    .replace(/-(?=-)/g, "\\u002d");
  return `<!-- scopesoup:${kind} ${json} -->`;
}

/** A comment body: the visible markdown, a blank line, then the marker. */
export function withMarker(visible: string, kind: MarkerKind, data: Record<string, unknown>): string {
  return `${visible.trimEnd()}\n\n${writeMarker(kind, data)}`;
}

/** The marker on the comment's last line, or null when there is none that parses. Says nothing about trust. */
export function readMarker(body: string | null | undefined): Marker | null {
  const lines = (body ?? "").trimEnd().split(/\r?\n/);
  const match = MARKER.exec((lines[lines.length - 1] ?? "").trim());
  if (!match?.[1] || !match[2] || !KINDS.has(match[1])) return null;
  try {
    const data = JSON.parse(match[2]) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data) || (data as { v?: unknown }).v !== 1) return null;
    return { kind: match[1] as MarkerKind, data: data as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** A reply whose first line starts `A1:` (question 1) or `A:` (the newest open question), or null. */
export function readReply(body: string | null | undefined): { n?: number; answer: string } | null {
  return readReplies(body)[0] ?? null;
}

/**
 * Every answer in a reply whose first line starts `A1:` or `A:`. A later line that starts `A2:` (a number) begins the next
 * answer, so one comment can answer several questions; without such a line the whole text after the first colon is one answer.
 */
export function readReplies(body: string | null | undefined): { n?: number; answer: string }[] {
  const text = (body ?? "").trimStart();
  if (!/^A\d*:/.test(text)) return [];
  const parts: { n?: number; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = parts.length === 0 ? /^A(\d*):(.*)$/.exec(line) : /^A(\d+):(.*)$/.exec(line);
    if (match) parts.push({ ...(match[1] ? { n: Number(match[1]) } : {}), lines: [match[2] ?? ""] });
    else parts[parts.length - 1]!.lines.push(line);
  }
  return parts.flatMap(({ n, lines }) => {
    const answer = lines.join("\n").trim();
    return answer ? [{ ...(n !== undefined ? { n } : {}), answer }] : [];
  });
}

/** Besides the token's own login, these may answer (marker or reply). */
export const ANSWERING_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * The trust rule: any marker counts from the token's own login (`self`, lower case); an answer marker
 * or a reply also from an owner, member or collaborator. Everything else is a plain comment.
 */
export function trusted(comment: RestComment, self: string | null, as: "marker" | "answer"): boolean {
  const login = comment.user?.login?.toLowerCase();
  if (!login) return false;
  if (self !== null && login === self) return true;
  return as === "answer" && ANSWERING_ASSOCIATIONS.has(comment.author_association ?? "");
}

/** Worth keeping between polls: a comment that may carry a marker or be a reply. */
export const mayMatter = (body: string | null | undefined): boolean => readMarker(body) !== null || readReply(body) !== null;

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export interface Thread {
  openQuestions: OpenQuestion[];
  answers: RecordedAnswer[];
  /** The triage rewrites, oldest first: round, the hash of the body each read, and whether it has its answer. */
  rewrites: ThreadRewrite[];
  /**
   * Scope Soup's one log comment (the token's own, lowest id), or null when there is none yet. With the highest question
   * number Scope Soup has used on the issue as far as the log knows (`asked`), and the questions deleted on GitHub, kept so they are
   * not asked again.
   */
  log: { id: number; lines: LogRecord[]; dropped: number } & LogKeep | null;
  /** The newest rewrite, while it waits: no answer, and no other Scope Soup question came after it. */
  waiting: ThreadRewrite | null;
  /** The newest `merged` marker (the closing comment), with the comment's time; null when there is none. */
  merged: Merged | null;
  /** Scope Soup's claim comments (the token's own), lowest id first, live or not. */
  claims: ClaimComment[];
  /** The decisions implementors took themselves, from Scope Soup's `assumption` comments, oldest first, settled or not. */
  assumptions: Assumption[];
}

/** One claim comment: the machine whose Scope Soup claims the Item, until when, and whether it let go. */
export interface ClaimComment {
  id: number;
  machine: string;
  until: string;
  released: boolean;
}

/** The claims that stand at `now` (ms): not released, `until` not passed. The first (lowest comment id) wins. */
export const liveClaims = (claims: readonly ClaimComment[], now: number): ClaimComment[] =>
  claims.filter((claim) => !claim.released && Date.parse(claim.until) > now);

/** The holder an agent's claim shows as, the same actor a claim on the meta branch gives (`scopesoup@laptop-a`). */
export const claimActor = (machine: string): Actor => ({ id: `scopesoup@${machine}`, name: `scopesoup on ${machine}`, bot: true });

/**
 * A claim comment: one visible line, then the marker. `shown` is the machine name as people see it (made inert by the
 * caller); the marker keeps the name as it is, which is what is compared.
 */
export function claimBody(machine: string, shown: string, until: string, released: boolean): string {
  const visible = released ? `Released: Scope Soup (${shown}) no longer works on this.` : `Scope Soup (${shown}) works on this until ${until.slice(11, 16)} UTC.`;
  return withMarker(visible, "claim", { machine, until, released });
}

/** What a `merged` marker says, and when its comment was written. */
export interface Merged {
  sha: string;
  target: string;
  batch?: number;
  at: string;
}

/** One rewrite comment; `questions` are the question comments naming it, each with its answer once it has one. */
export interface ThreadRewrite {
  id: string;
  round: number;
  bodySha: string;
  answered: boolean;
  at: string;
  text: string;
  questions: { question: OpenQuestion; answer?: string }[];
  /** The label changes the marker proposes. */
  labels?: LabelChange;
}

/** One issue's questions and answers from its comments. Pure. */
export function readThread(subject: Ref, comments: RestComment[], self: string | null): Thread {
  const questions: { id: number; n?: number; question: OpenQuestion; optionTexts: string[]; answered: boolean; rewrite?: number; answer?: string }[] = [];
  const answers: RecordedAnswer[] = [];
  const rewrites: ThreadRewrite[] = [];
  let log: Thread["log"] = null;
  let merged: Merged | null = null;
  const claims: ClaimComment[] = [];
  const assumptions: Assumption[] = [];
  const answer = (comment: RestComment, text: string, target: (typeof questions)[number] | undefined, extra: { textHash?: string; options?: string[]; by?: string; question?: string; at?: string } = {}): void => {
    if (target) {
      target.answered = true;
      target.answer = text;
    }
    const record: RecordedAnswer = { subject, answer: text, by: extra.by || comment.user?.login || "ghost", at: extra.at || comment.created_at };
    if (target) {
      record.to = String(target.id);
      record.question = target.question.question;
    } else if (extra.question) record.question = extra.question;
    const options = extra.options ?? target?.optionTexts ?? [];
    if (options.length > 0) record.options = options;
    if (extra.textHash) record.textHash = extra.textHash;
    answers.push(record);
  };

  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    const marker = readMarker(comment.body);
    const markerCounts = marker !== null && trusted(comment, self, marker.kind === "answer" ? "answer" : "marker");
    if (marker && markerCounts) {
      const data = marker.data;
      if (marker.kind === "question") {
        const text = str(data.question);
        // A withdrawn question is no question any more; its number stays used.
        if (!text || data.withdrawn === true) continue;
        const machine = str(data.machine);
        // A marker from the token's login: Scope Soup wrote it.
        const question: OpenQuestion = { id: String(comment.id), at: comment.created_at, by: { who: "scopesoup", agent: true, ...(machine ? { machine } : {}) }, question: text, options: asOptions(data.options) };
        const recommendation = str(data.recommendation);
        if (recommendation) question.recommendation = recommendation;
        const context = str(data.context);
        if (context) question.context = context;
        if (data.multiSelect === true) question.multiSelect = true;
        if (typeof data.proposal === "object" && data.proposal !== null && !Array.isArray(data.proposal)) {
          const proposal = data.proposal as Record<string, unknown>;
          const carried = str(proposal.carried);
          const restructuring = asRestructuringRecord(proposal);
          if (restructuring) question.proposal = { reason: str(proposal.reason), ...restructuring, ...(carried ? { carried } : {}) };
        }
        const n = typeof data.n === "number" && Number.isInteger(data.n) && data.n > 0 ? data.n : undefined;
        const rewrite = typeof data.rewrite === "number" ? data.rewrite : undefined;
        questions.push({ id: comment.id, ...(n ? { n } : {}), question, optionTexts: question.options.map(optionText), answered: false, ...(rewrite !== undefined ? { rewrite } : {}) });
      } else if (marker.kind === "answer") {
        // One comment may carry several answers (`answers`, one per question, sharing `by` and `textHash`).
        const entries = Array.isArray(data.answers)
          ? data.answers.filter((each): each is Record<string, unknown> => typeof each === "object" && each !== null && !Array.isArray(each)).map((each): Record<string, unknown> => ({ by: data.by, textHash: data.textHash, ...each }))
          : [data as Record<string, unknown>];
        for (const entry of entries) {
          const text = str(entry.answer);
          if (!text) continue;
          // An answer moved from Scope Soup's store keeps the time it was given there. Nothing writes `"migrated":true` any more
          // (the one-time move was done by hand), but answer comments on GitHub carry it, so it is still read.
          const migratedAt = entry.migrated === true && !Number.isNaN(Date.parse(str(entry.at))) ? str(entry.at) : "";
          const extra = {
            textHash: str(entry.textHash),
            by: str(entry.by),
            ...(migratedAt ? { at: migratedAt } : {}),
            ...(Array.isArray(entry.options) ? { options: entry.options.filter((each): each is string => typeof each === "string") } : {}),
          };
          if (entry.to === null) {
            // Migrated, or an escalation's answer: no question comment to point at.
            answer(comment, text, undefined, { ...extra, question: str(entry.question) });
            continue;
          }
          const target = questions.find((each) => each.id === entry.to && !each.answered);
          if (target) answer(comment, text, target, extra);
          // A person's decision on a triage rewrite.
          const rewrite = target ? undefined : rewrites.find((each) => Number(each.id) === entry.to && !each.answered);
          if (rewrite) {
            rewrite.answered = true;
            answer(comment, text, undefined, { ...extra, question: `Triage rewrite, round ${rewrite.round}` });
            answers[answers.length - 1]!.to = rewrite.id;
          }
        }
      } else if (marker.kind === "rewrite") {
        const round = typeof data.round === "number" && Number.isInteger(data.round) && data.round > 0 ? data.round : 0;
        const labels = asLabelChange(data.labels);
        if (round > 0) rewrites.push({ id: String(comment.id), round, bodySha: str(data.bodySha), answered: false, at: comment.created_at, text: rewriteText(comment.body), questions: [], ...(labels ? { labels } : {}) });
      } else if (marker.kind === "log" && log === null && self !== null && comment.user?.login?.toLowerCase() === self) {
        // Only the token's own login writes the log; a second log comment (two writers at once) is not read.
        log = { id: comment.id, ...readLogMarker(marker.data) };
      } else if (marker.kind === "merged") {
        const sha = str(data.sha);
        const batch = typeof data.batch === "number" && Number.isInteger(data.batch) ? data.batch : undefined;
        if (sha) merged = { sha, target: str(data.target), ...(batch !== undefined ? { batch } : {}), at: comment.created_at };
      } else if (marker.kind === "claim") {
        // Only the token's own login claims (a marker from anyone else is a plain comment already).
        const machine = str(data.machine);
        const until = str(data.until);
        if (machine && until && !Number.isNaN(Date.parse(until))) claims.push({ id: comment.id, machine, until, released: data.released === true });
      } else if (marker.kind === "assumption" && self !== null && comment.user?.login?.toLowerCase() === self) {
        // Only the token's own login records decisions and their verdicts (the comment is edited in place).
        assumptions.push(...readAssumptions(comment.id, comment.created_at, data));
      }
      continue;
    }
    const replies = readReplies(comment.body);
    if (replies.length === 0 || !trusted(comment, self, "answer")) continue;
    // One reply may answer several questions, `A1:` and `A2:` on lines of their own.
    for (const reply of replies) {
      const open = questions.filter((each) => !each.answered);
      const target = reply.n === undefined ? open[open.length - 1] : open.find((each) => each.n === reply.n);
      // A reply naming an answered or unknown number stays a plain comment.
      if (target) answer(comment, reply.answer, target);
    }
  }
  for (const each of questions) {
    const rewrite = each.rewrite !== undefined ? rewrites.find((one) => Number(one.id) === each.rewrite) : undefined;
    if (rewrite) rewrite.questions.push({ question: each.question, ...(each.answer !== undefined ? { answer: each.answer } : {}) });
  }
  const newest = rewrites[rewrites.length - 1];
  const later = !!newest && questions.some((each) => each.id > Number(newest.id) && each.rewrite !== Number(newest.id));
  const waiting = newest && !newest.answered && !later ? newest : null;
  return { openQuestions: questions.filter((each) => !each.answered).map((each) => each.question), answers, rewrites, log, waiting, merged, claims, assumptions };
}

// --- the decisions an implementor took itself ---

/** One decision as an `assumption` marker keeps it. */
export interface AssumptionEntry {
  question: string;
  chosen: string;
  others: string[];
  why: string;
}

/** A verdict in an `assumption` marker: the decision's place in the comment (`n`, from 0), and how it was settled. */
export interface AssumptionVerdict extends Omit<AssumptionSettled, "item"> {
  n: number;
  /** With "overturned": the new Item's number. `work` instead, when the answer went into the running work. */
  item?: string;
}

const strs = (value: unknown): string[] => (Array.isArray(value) ? value.map(str).filter(Boolean) : []);

/** The decisions an `assumption` marker records, each with its verdict once it has one. Ids are `<comment id>-<n>`. */
function readAssumptions(id: number, at: string, data: Record<string, unknown>): Assumption[] {
  const verdicts = readVerdicts(data.settled);
  const out: Assumption[] = [];
  const entries = Array.isArray(data.decisions) ? data.decisions : [];
  entries.forEach((entry, n) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
    const fields = entry as Record<string, unknown>;
    const question = str(fields.question);
    const chosen = str(fields.chosen);
    if (!question || !chosen) return;
    const verdict = verdicts.find((each) => each.n === n);
    const settled: AssumptionSettled | undefined = verdict
      ? { verdict: verdict.verdict, at: verdict.at, by: verdict.by, ...(verdict.answer ? { answer: verdict.answer } : {}), ...(verdict.item ? { item: { host: "github", kind: "work", id: verdict.item } } : {}), ...(verdict.work ? { work: true as const } : {}) }
      : undefined;
    out.push({ id: `${id}-${n}`, at, question, chosen, others: strs(fields.others), why: str(fields.why), ...(settled ? { settled } : {}) });
  });
  return out;
}

/** The verdicts of an `assumption` marker; one that does not read is left out (its decision stays open). */
export function readVerdicts(value: unknown): AssumptionVerdict[] {
  const out: AssumptionVerdict[] = [];
  for (const each of Array.isArray(value) ? value : []) {
    if (typeof each !== "object" || each === null || Array.isArray(each)) continue;
    const fields = each as Record<string, unknown>;
    const n = typeof fields.n === "number" && Number.isInteger(fields.n) && fields.n >= 0 ? fields.n : -1;
    if (n < 0 || (fields.verdict !== "accepted" && fields.verdict !== "overturned") || out.some((one) => one.n === n)) continue;
    const answer = str(fields.answer);
    const item = str(fields.item);
    out.push({ n, verdict: fields.verdict, at: str(fields.at), by: str(fields.by) || "someone", ...(answer ? { answer } : {}), ...(item ? { item } : {}), ...(fields.work === true ? { work: true as const } : {}) });
  }
  return out;
}

/**
 * Scope Soup's comment with the decisions an implementor took itself: each in words with its verdict once it has one, then the
 * `assumption` marker with the decisions and the verdicts. The texts are inert already.
 */
export function assumptionBody(decisions: readonly AssumptionEntry[], settled: readonly AssumptionVerdict[] = []): string {
  const line = (each: AssumptionEntry, n: number): string => {
    const verdict = settled.find((one) => one.n === n);
    const said = verdict
      ? verdict.verdict === "accepted"
        ? ` _Accepted by ${verdict.by}._`
        : ` _Overturned by ${verdict.by}: ${verdict.answer ?? ""}${verdict.item ? ` Reworked in #${verdict.item}.` : verdict.work ? " It went into the running work." : ""}_`
      : "";
    return `${n + 1}. **${each.question}** Chose: ${each.chosen}.${each.others.length > 0 ? ` Other options: ${each.others.join("; ")}.` : ""}${each.why ? ` Why: ${each.why}` : ""}${said}`;
  };
  const visible = [
    "**The implementor decided these itself**, as cheap to change later; the work went on. Accept or overturn each on Scope Soup's board.",
    decisions.map(line).join("\n"),
  ].join("\n\n");
  return withMarker(visible, "assumption", {
    decisions: decisions.map((each) => ({ question: each.question, chosen: each.chosen, others: each.others, why: each.why })),
    ...(settled.length > 0 ? { settled: settled.map((each) => ({ ...each })) } : {}),
  });
}

/** The proposed description inside a rewrite comment's `<details>`, or the visible part as it is. */
function rewriteText(body: string | null | undefined): string {
  const lines = (body ?? "").trimEnd().split(/\r?\n/);
  const visible = lines.slice(0, -1).join("\n").trim();
  const match = /^<details><summary>[^\n]*<\/summary>\n\n([\s\S]*)\n\n<\/details>(?:\n\nLabels: [^\n]*)?$/.exec(visible);
  return (match?.[1] ?? visible).trim();
}

/**
 * The Item waits for an answer, so `scopesoup:needs-decision` is on: a Scope Soup question is open, or a triage rewrite waits for
 * Accept, Edit or Reject (with no question too, or only labels proposed). A rewrite still waits once each of
 * its questions is answered with the recommendation; an answer otherwise than recommended starts a new round, so it no longer waits.
 */
export function waitsForAnswer(thread: Thread): boolean {
  const rewrite = thread.waiting;
  return thread.openQuestions.length > 0 || (!!rewrite && rewrite.questions.every((each) => each.answer === undefined || picksRecommendation(each.answer, each.question.recommendation)));
}

/** The answer names the recommendation: its label, or `label: ...` (as `picks` in the orchestrator). */
function picksRecommendation(answer: string, recommendation: string | undefined): boolean {
  const given = answer.trim().toLowerCase();
  const wanted = (recommendation ?? "").trim().toLowerCase();
  return wanted !== "" && (given === wanted || given.startsWith(`${wanted}:`));
}

// --- the log comment ---

/** The writer of every line in the log comment: Scope Soup (`SCOPESOUP` in the orchestrator). */
const LOG_WRITER = { who: "scopesoup", agent: true };
/** A session's summary is cut to this in the log comment, and a review's findings to `FINDINGS_CHARS` in all. */
export const SUMMARY_CHARS = 500;
export const FINDINGS_CHARS = 2000;

const clip = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars - 3)}...` : text);

/** What the log comment keeps besides its lines: the highest question number used, and the questions deleted on GitHub. */
export interface LogKeep {
  asked: number;
  deleted: { question: string; n?: number }[];
}

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** The lines and the dropped count of a log marker; a line that is not `{at, kind, fields}` is skipped. */
function readLogMarker(data: Record<string, unknown>): { lines: LogRecord[]; dropped: number } & LogKeep {
  const lines: LogRecord[] = [];
  for (const line of Array.isArray(data.lines) ? data.lines : []) {
    if (typeof line !== "object" || line === null) continue;
    const { at, kind, fields } = line as Record<string, unknown>;
    if (typeof at !== "string" || typeof kind !== "string" || !kind) continue;
    const own = typeof fields === "object" && fields !== null && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {};
    lines.push({ at, by: LOG_WRITER, kind, fields: own });
  }
  const dropped = typeof data.dropped === "number" && Number.isInteger(data.dropped) && data.dropped > 0 ? data.dropped : 0;
  const deleted: LogKeep["deleted"] = [];
  for (const each of Array.isArray(data.deleted) ? data.deleted : []) {
    const question = typeof each === "object" && each !== null ? str((each as Record<string, unknown>).question) : "";
    const n = typeof each === "object" && each !== null ? positive((each as Record<string, unknown>).n) : undefined;
    if (question) deleted.push({ question, ...(n ? { n } : {}) });
  }
  const asked = Math.max(positive(data.asked) ?? 0, ...deleted.map((each) => each.n ?? 0));
  return { lines, dropped, asked, deleted };
}

/** A line's fields as the log comment keeps them: a session's summary cut to 500 characters, a review's (or a check's) findings to 2,000 in all. */
export function clipLogFields(kind: string, fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields };
  if (kind === "session" && typeof out.summary === "string") out.summary = clip(out.summary, SUMMARY_CHARS);
  if ((kind === "review" || kind === "check") && Array.isArray(out.findings)) {
    let left = FINDINGS_CHARS;
    const kept: string[] = [];
    for (const finding of out.findings) {
      if (typeof finding !== "string" || left <= 3) continue;
      const text = clip(finding, left);
      kept.push(text);
      left -= text.length;
    }
    out.findings = kept;
  }
  return out;
}

const words = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const shortSha = (value: unknown): string => words(value).slice(0, 7);

export interface LogLine {
  at: string;
  kind: string;
  fields: Record<string, unknown>;
}

/** One log line in words, for people. The fields are inert already. */
function lineInWords(line: LogLine): string {
  const f = line.fields;
  let said: string;
  if (line.kind === "session") {
    const minutes = typeof f.durationMs === "number" ? `, ${Math.max(1, Math.round(f.durationMs / 60_000))} min` : "";
    said = `${words(f.role) || "a"} session ${words(f.outcome) || "ended"}${minutes}${words(f.summary) ? `: ${words(f.summary)}` : "."}${words(f.next) ? ` Next: ${words(f.next)}.` : ""}`;
  } else if (line.kind === "revision") {
    said = `revision ${shortSha(f.sha)}${words(f.branch) ? ` on ${words(f.branch)}` : ""}${f.handback === true ? ", handed back" : ""}.`;
  } else if (line.kind === "review") {
    const count = Array.isArray(f.findings) ? f.findings.length : 0;
    said = `review of ${shortSha(f.sha)}: ${words(f.verdict) || "done"}${count > 0 ? `, ${count} finding${count > 1 ? "s" : ""}` : ""}.`;
  } else if (line.kind === "check") {
    said = `check of ${shortSha(f.sha)}: ${words(f.verdict) || "done"}${words(f.command) ? ` (${words(f.command)})` : ""}.`;
  } else if (line.kind === "edited") {
    const changed = Array.isArray(f.changed) ? f.changed.map(words).filter(Boolean).join(", ") : "";
    said = `edited ${changed || "the item"}${words(f.via) ? ` via ${words(f.via)}` : ""}.`;
  } else if (line.kind === "duplicate") {
    said = `closed as a duplicate of #${words(f.of)}.`;
  } else said = `${words(line.kind)}.`;
  return `- ${line.at.slice(0, 16).replace("T", " ")} UTC: ${said}`;
}

/**
 * The log comment: the lines in words, newest last, then the marker. Over the comment limit the oldest lines are dropped and counted.
 * `keep` (the highest question number used, the deleted questions) is never dropped. Its texts are inert already.
 */
export function logBody(lines: readonly LogLine[], dropped: number, keep: LogKeep = { asked: 0, deleted: [] }): string {
  let kept = [...lines];
  let gone = dropped;
  const deleted = keep.deleted.map((each) => `${each.n ? `Q${each.n} ` : ""}"${words(each.question)}"`).join(", ");
  const build = (): string => {
    const visible = [
      "**Scope Soup's log** (one comment, edited in place; newest last)",
      ...(deleted ? [`_Questions deleted on GitHub, not to be asked again: ${deleted}._`] : []),
      ...(gone > 0 ? [`_${gone} older line${gone > 1 ? "s" : ""} dropped._`] : []),
      kept.map(lineInWords).join("\n"),
    ].join("\n\n");
    return withMarker(visible, "log", {
      lines: kept.map((line) => ({ at: line.at, kind: line.kind, fields: line.fields })), dropped: gone,
      ...(keep.asked > 0 ? { asked: keep.asked } : {}), ...(keep.deleted.length > 0 ? { deleted: keep.deleted } : {}),
    });
  };
  let body = build();
  while (body.length > COMMENT_LIMIT && kept.length > 1) {
    // About as many lines as the excess needs, at least one; then built again.
    const cut = Math.min(kept.length - 1, Math.max(1, Math.floor(((body.length - COMMENT_LIMIT) / body.length) * kept.length)));
    kept = kept.slice(cut);
    gone += cut;
    body = build();
  }
  return body;
}

/** The item's record for `recover.ts`. `bodyKnown` says whether the issue's body is the one whose sha256 a rewrite names. */
export function hostRecordOf(thread: Thread, bodyKnown: (sha: string) => boolean): HostRecord {
  const record: HostRecord = {
    log: thread.log?.lines ?? [], dropped: thread.log?.dropped ?? 0, rewriteRounds: thread.rewrites.length,
    rewriteQuestions: thread.rewrites.flatMap((rewrite) => rewrite.questions.flatMap((each) => (each.question.id ? [each.question.id] : []))),
  };
  if (thread.log && thread.log.deleted.length > 0) record.deletedQuestions = thread.log.deleted.map((each) => each.question);
  const waiting = thread.waiting;
  if (waiting) {
    const rewrite: HostRewrite = { id: waiting.id, round: waiting.round, at: waiting.at, text: waiting.text, bodyKnown: bodyKnown(waiting.bodySha), questions: waiting.questions.map((each) => each.question), ...(waiting.labels ? { labels: waiting.labels } : {}) };
    record.rewrite = rewrite;
  }
  return record;
}

/**
 * The number the next question on the issue gets: one more than any its trusted question or answer markers name, so none is reused.
 * And more than `used` (the log comment's highest, which counts deleted questions).
 */
export function nextQuestionNumber(comments: RestComment[], self: string | null, used = 0): number {
  let highest = used;
  for (const comment of comments) {
    const marker = readMarker(comment.body);
    if (!marker || (marker.kind !== "question" && marker.kind !== "answer") || !trusted(comment, self, marker.kind === "answer" ? "answer" : "marker")) continue;
    const n = marker.data.n;
    if (typeof n === "number" && Number.isInteger(n) && n > highest) highest = n;
  }
  return highest + 1;
}

/** The number in a question comment's marker, if it has one. */
export function questionNumber(comment: RestComment | undefined): number | undefined {
  const n = readMarker(comment?.body)?.data.n;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** What a question comment says: `**Qn: question**`, the context, the options, how to answer; then its marker. The text is inert already. */
export function questionBody(n: number, ask: { question: string; options: DecisionOption[]; recommendation?: string; context?: string; multiSelect?: true; parked: string; step: string; rewrite?: string; proposal?: { id: string; reason: string; original: OriginalFate; parts: ProposedPart[]; carried?: string } }): string {
  const option = (each: DecisionOption): string => {
    const label = typeof each === "string" ? each : each.label;
    const description = typeof each === "string" ? "" : each.description;
    const recommended = ask.recommendation && label.trim().toLowerCase() === ask.recommendation.trim().toLowerCase() ? " (recommended)" : "";
    return `- **${label}**${recommended}${description ? `: ${description}` : ""}`;
  };
  const visible = [
    `**Q${n}: ${ask.question.trim()}**`,
    ...(ask.context?.trim() ? [ask.context.trim()] : []),
    ...(ask.options.length > 0 ? [`${ask.multiSelect ? "Pick one or more.\n\n" : ""}${ask.options.map(option).join("\n")}`] : []),
    // A proposed restructuring lists its parts and where each goes; it is decided on Scope Soup's board.
    ...(ask.proposal ? [ask.proposal.parts.map((part, index) => `${index + 1}. **${part.title.trim()}** (${GOES_WORDS[part.goes]}${part.goes === "into" ? ` #${part.into}` : ""})${part.description.trim() ? `: ${part.description.trim()}` : ""}`).join("\n"), `This Item ${FATE_WORDS[ask.proposal.original]}.`] : []),
    ask.proposal ? "Accept, edit or reject the restructuring on Scope Soup's board." : `Answer on Scope Soup's board, or reply here with \`A${n}: <your answer>\`.`,
  ].join("\n\n");
  return withMarker(visible, "question", {
    n, question: ask.question.trim(), options: ask.options,
    ...(ask.recommendation ? { recommendation: ask.recommendation } : {}), ...(ask.context?.trim() ? { context: ask.context.trim() } : {}), ...(ask.multiSelect ? { multiSelect: true } : {}),
    parked: ask.parked, step: ask.step,
    ...(ask.rewrite ? { rewrite: Number(ask.rewrite) } : {}),
    ...(ask.proposal ? { proposal: { id: ask.proposal.id, reason: ask.proposal.reason, original: ask.proposal.original, parts: ask.proposal.parts, ...(ask.proposal.carried ? { carried: ask.proposal.carried } : {}) } } : {}),
  });
}

/** Where a part goes, as a question comment says it. */
const GOES_WORDS: Record<PartGoes, string> = { original: "stays in this Item", child: "new sub-issue", related: "new related issue", unlinked: "new issue", into: "added to" };
/** What becomes of the Item, as a question comment says it. */
const FATE_WORDS: Record<OriginalFate, string> = { keeps: "keeps the part that stays in it", umbrella: "becomes an umbrella over its sub-issues", replaced: "is closed as replaced by the parts" };

/** A question comment withdrawn by Scope Soup: one line saying so, then its marker with `withdrawn`, which keeps its number used. */
export function withdrawnBody(data: Record<string, unknown>): string {
  const n = positive(data.n);
  return withMarker(`${n ? `~~Q${n}~~ ` : ""}Withdrawn: Scope Soup asks again.`, "question", { ...data, withdrawn: true });
}

/**
 * What a rewrite comment says: the rewrite inside `<details>`, then its marker with the round and the hash of the body it read.
 * The text is inert already. Proposed label changes are a line under it (`Labels: +bug, −question`) and `labels` in the marker.
 */
export function rewriteBody(round: number, rewrite: string, bodySha: string, labels?: LabelChange): string {
  const change = labels && !isEmptyChange(labels) ? labels : undefined;
  const visible = `<details><summary>Triage, round ${round}: proposed description</summary>\n\n${rewrite.trim()}\n\n</details>${change ? `\n\nLabels: ${changeText(change)}` : ""}`;
  return withMarker(visible, "rewrite", { round, bodySha, ...(change ? { labels: { add: change.add, remove: change.remove } } : {}) });
}

/** The closing comment of a merged Item: the text, then the `merged` marker. The text is inert already. */
export function mergedBody(text: string, merged: { sha: string; target: string; batch?: number }): string {
  return withMarker(text, "merged", { sha: merged.sha, target: merged.target, ...(merged.batch !== undefined ? { batch: merged.batch } : {}) });
}

/**
 * The description of a batch's pull request (`mergeQueue.ci: "github"`): what it is in words, made only of Scope Soup's own data
 * (numbers, commit ids, item numbers without a closing keyword, so nothing is linked or closed by it), then the `batch` marker.
 */
export function batchBody(batch: { batch: number; sha: string; base: string; target: string; members: Ref[] }): string {
  const items = batch.members.map((member) => (/^\d+$/.test(member.id) ? `#${member.id}` : member.id.replace(/[^\w.-]/g, "")));
  const visible = [
    `Batch ${batch.batch} of Scope Soup's mergeQueue: ${items.join(", ") || "no items"}, built on ${batch.target} at ${batch.base.slice(0, 7)}.`,
    "",
    `Scope Soup waits for every check on ${batch.sha.slice(0, 7)} and, when all are green, pushes that same commit to ${batch.target} (fast-forward), which shows this pull request as merged. Please do not push to this branch or merge it by hand.`,
  ].join("\n");
  return withMarker(visible, "batch", { batch: batch.batch, sha: batch.sha, base: batch.base, members: batch.members.map((member) => member.id) });
}

/**
 * What an answer comment says: `**An:** answer` (or the question asked, for an answer to no question comment); then its marker.
 * (`"migrated":true` with the time an answer was given is only read, by `readThread`: nothing writes it any more.)
 */
export function answerBody(to: number | null, n: number | undefined, given: { answer: string; by: string; question?: string; options?: string[]; textHash?: string; proposal?: string }): string {
  return withMarker(answerVisible(to, n, given), "answer", answerFields(to, n, given));
}

type GivenAnswer = { answer: string; question?: string; options?: string[]; textHash?: string; proposal?: string };

const answerVisible = (to: number | null, n: number | undefined, given: GivenAnswer): string =>
  to === null && given.question ? `Asked: ${given.question.trim()}\n\n**Answer:** ${given.answer.trim()}` : `**${n ? `A${n}` : "Answer"}:** ${given.answer.trim()}`;

const answerFields = (to: number | null, n: number | undefined, given: GivenAnswer & { by?: string }): Record<string, unknown> => ({
  to, ...(n ? { n } : {}), answer: given.answer.trim(), ...(given.by !== undefined ? { by: given.by } : {}),
  ...(given.textHash ? { textHash: given.textHash } : {}), ...(given.options && given.options.length > 0 ? { options: given.options } : {}),
  ...(to === null && given.question ? { question: given.question.trim() } : {}),
  ...(given.proposal ? { proposal: given.proposal } : {}),
});

/**
 * Several answers sent together in one comment: `**A1:** …`, `**A2:** …` (each as `answerBody` shows it), then one marker
 * with `answers`, one entry per answer, and the writer once. One entry is written as `answerBody`.
 */
export function answersBody(entries: readonly { to: number | null; n?: number; given: GivenAnswer }[], by: string): string {
  if (entries.length === 1) return answerBody(entries[0]!.to, entries[0]!.n, { ...entries[0]!.given, by });
  const visible = entries.map((each) => answerVisible(each.to, each.n, each.given)).join("\n\n");
  return withMarker(visible, "answer", { answers: entries.map((each) => answerFields(each.to, each.n, each.given)), by });
}

/**
 * Sets the item's questions, answers and `needsDecision` (`waitsForAnswer`) from its thread. And Scope Soup's record (log comment, rewrites), when it
 * has one; `bodyKnown` says whether the issue's body has the sha256 a rewrite names. An open issue with a live claim at `now`
 * (ms) is doing, held by that claim's machine until its `until`; an assignee (a person's hold) stays the holder.
 */
export function applyThread(item: WorkItem, thread: Thread, bodyKnown: (sha: string) => boolean = () => false, now: number = Date.now()): WorkItem {
  const claim = liveClaims(thread.claims, now)[0];
  if (claim && item.hostState === "open") {
    if (!item.holder) item.holder = { actor: claimActor(claim.machine), until: claim.until };
    if (item.state === "todo") item.state = "doing";
    // Backlog is only for an Item in state todo (decision 120).
    delete item.backlog;
  }
  if (thread.openQuestions.length > 0) item.openQuestions = thread.openQuestions;
  // The label's rule: an open question, or a triage rewrite waiting for Accept, Edit or Reject.
  if (waitsForAnswer(thread)) item.needsDecision = true;
  if (thread.answers.length > 0) item.answers = thread.answers;
  if (thread.log || thread.rewrites.length > 0) item.hostRecord = hostRecordOf(thread, bodyKnown);
  if (thread.merged) item.merged = { ...thread.merged };
  if (thread.assumptions.length > 0) item.assumptions = thread.assumptions;
  // GitHub does not say which issue a duplicate duplicates; Scope Soup's log comment does.
  const duplicate = item.hostState === "closed:duplicate" ? thread.log?.lines.filter((line) => line.kind === "duplicate" && str(line.fields.of)).pop() : undefined;
  if (duplicate) item.duplicateOf = { host: item.ref.host, kind: "work", id: str(duplicate.fields.of) };
  return item;
}

const issueNumberOf = (url: string | undefined): string | null => /\/issues\/(\d+)$/.exec(url ?? "")?.[1] ?? null;

export interface ConventionsDeps {
  client: Client;
  scope: Scope;
  whoami(): Promise<Actor>;
  /** Milliseconds since the epoch. */
  now(): number;
  /** The sha256 of the issue's body as last read, if known (a rewrite's `original` is that body when the hashes match). */
  bodySha?(id: string): string | undefined;
  /**
   * The issue has the `scopesoup:claimed` label and no live claim (it expired, or was released and the label stayed): the
   * adapter removes the label, with writes on. Absent: the label is left, and the Item reads as unclaimed all the same.
   */
  staleClaimLabel?(id: string, label: string): Promise<void>;
}

/**
 * The work port with comments read in: one conditional `GET /issues/comments?since=` per poll for the
 * whole repository. The comments that may matter are kept in memory per issue; a full listing (the
 * first poll, or a full sync) rebuilds them, which also drops deleted ones.
 */
export function withConventions(work: WorkPort, deps: ConventionsDeps): WorkPort {
  const { client, scope } = deps;
  const r = client.repoPath;
  let kept: Map<string, Map<number, RestComment>> | null = null;
  let cursor = "";
  let self: string | null | undefined;

  async function selfLogin(): Promise<string | null> {
    if (self !== undefined) return self;
    try {
      self = (await deps.whoami()).id.toLowerCase();
    } catch {
      // A token that cannot say who it is: only answers from owners, members and collaborators count.
      self = null;
    }
    return self;
  }

  /** Lists changed comments and returns the issues whose kept comments changed. */
  async function pollComments(since: string | undefined): Promise<Set<string>> {
    const full = since === undefined;
    const fresh = full || kept === null;
    const query = fresh ? "sort=updated&direction=asc&per_page=100" : `since=${encodeURIComponent(cursor)}&sort=updated&direction=asc&per_page=100`;
    const got = await client.list<RestComment>(r(`/issues/comments?${query}`));
    const changed = new Set<string>();
    if (!fresh && got.unchanged) return changed;
    const before = kept;
    if (fresh) kept = new Map();
    const store = kept ?? new Map<string, Map<number, RestComment>>();
    let newest = fresh ? "" : cursor;
    for (const comment of got.data) {
      const updated = comment.updated_at ?? comment.created_at;
      if (updated > newest) newest = updated;
      const number = issueNumberOf(comment.issue_url);
      if (!number) continue;
      const comments = store.get(number) ?? new Map<number, RestComment>();
      const old = (fresh ? before?.get(number) : comments)?.get(comment.id);
      comments.delete(comment.id);
      const matters = mayMatter(comment.body);
      if (matters) comments.set(comment.id, comment);
      if (comments.size > 0) store.set(number, comments);
      else store.delete(number);
      // `since` is inclusive: the newest comment comes again with the next change and is no change itself.
      const same = old !== undefined && matters && old.body === comment.body && (old.updated_at ?? old.created_at) === updated;
      // After a restart (no comments kept) with a cursor, what changed since the cursor counts as changed.
      const counts = fresh ? since !== undefined && updated >= since : true;
      if ((matters || old !== undefined) && !same && counts) changed.add(number);
    }
    kept = store;
    cursor = newest || new Date(deps.now() - 60_000).toISOString();
    return changed;
  }

  /** Issues with an open question. Their comments are listed again each poll, so a deleted one is seen (a free 304 when none changed). */
  const parkedIssues = new Set<string>();

  /**
   * The time of the issue's last `reopened` event, if it is newer than its `merged` marker. Read only for an open issue with
   * such a marker, and conditionally: a free 304 while the timeline is unchanged.
   */
  async function reopenedSince(id: string, mergedAt: string): Promise<string | undefined> {
    const events = (await client.list<RestTimelineEvent>(r(`/issues/${id}/timeline?per_page=100`))).data;
    const last = events.filter((each) => each.event === "reopened" && each.created_at).map((each) => each.created_at!).sort().pop();
    return last !== undefined && last > mergedAt ? last : undefined;
  }

  const fill = async (item: WorkItem, comments: Iterable<RestComment> | undefined): Promise<WorkItem> => {
    const self = await selfLogin();
    const thread = readThread(item.ref, [...(comments ?? [])], self);
    const filled = applyThread(item, thread, (sha) => !!sha && deps.bodySha?.(item.ref.id) === sha, deps.now());
    // A claim label with no live claim behind it is stale; the next instance that sees it removes it. Not without knowing
    // the token's login: then no claim comment can be trusted, so none can be told live.
    const stale = hasLabel(filled.labels, CLAIMED_LABEL);
    if (stale && self !== null && deps.staleClaimLabel && liveClaims(thread.claims, deps.now()).length === 0) {
      await deps.staleClaimLabel(item.ref.id, stale);
      filled.labels = filled.labels.filter((label) => label !== stale);
    }
    if (filled.merged && filled.hostState === "open") {
      const reopened = await reopenedSince(item.ref.id, filled.merged.at);
      if (reopened) filled.merged.reopened = reopened;
    }
    if ((filled.openQuestions?.length ?? 0) > 0) parkedIssues.add(item.ref.id);
    else parkedIssues.delete(item.ref.id);
    return filled;
  };

  const commentsOf = async (id: string): Promise<{ unchanged: boolean; comments: Map<number, RestComment> }> => {
    const got = await client.list<RestComment>(r(`/issues/${id}/comments?per_page=100`), { noRedirect: true });
    const comments = new Map<number, RestComment>();
    for (const comment of got.data) if (mayMatter(comment.body)) comments.set(comment.id, comment);
    return { unchanged: got.unchanged, comments };
  };

  const sameComments = (a: Map<number, RestComment> | undefined, b: Map<number, RestComment>): boolean =>
    (a?.size ?? 0) === b.size && [...b].every(([id, comment]) => a?.get(id)?.body === comment.body);

  /**
   * The parkedIssues issues whose comments changed since the last look, with what `kept` holds updated. An issue whose comments
   * cannot be listed any more (moved: 301, deleted: 410, or 404) goes into `gone`, and is parked no more.
   */
  async function relistParked(gone: Set<string>): Promise<Set<string>> {
    const changed = new Set<string>();
    for (const id of [...parkedIssues]) {
      if (!kept) continue;
      let got: Awaited<ReturnType<typeof commentsOf>>;
      try {
        got = await commentsOf(id);
      } catch (error) {
        if (!(error instanceof GitHubError && [301, 404, 410].includes(error.status))) throw error;
        parkedIssues.delete(id);
        kept.delete(id);
        gone.add(id);
        continue;
      }
      if (got.unchanged || sameComments(kept.get(id), got.comments)) continue;
      if (got.comments.size > 0) kept.set(id, got.comments);
      else kept.delete(id);
      changed.add(id);
    }
    return changed;
  }

  return {
    async listWork(since) {
      const page = await work.listWork(since);
      const changed = await pollComments(since);
      const gone = new Set<string>();
      for (const id of await relistParked(gone)) changed.add(id);
      // A parkedIssues issue that was transferred or deleted leaves the board now, not at the next full sync.
      const removed: Ref[] = [];
      const movedTo: Record<string, string> = {};
      for (const id of gone) {
        const ref = workRef(scope, Number(id));
        try {
          const item = await work.getWork(ref);
          if (item) changed.add(id);
          else removed.push(ref);
        } catch (error) {
          if (!(error instanceof WorkGone)) throw error;
          removed.push(ref);
          if (error.movedTo) movedTo[`${ref.host}:${ref.kind}:${ref.id}`] = error.movedTo;
        }
      }
      // A comment bumps its issue's updated_at [known, unconfirmed], so its issue is normally listed already.
      const listed = new Set(page.items.map((item) => item.ref.id));
      const extra: WorkItem[] = [];
      for (const id of changed) {
        if (listed.has(id)) continue;
        const item = await work.getWork(workRef(scope, Number(id)));
        if (item) extra.push(item);
      }
      if (page.unchanged && extra.length === 0 && removed.length === 0) return page;
      const items = [...page.items, ...extra];
      for (const item of items) await fill(item, kept?.get(item.ref.id)?.values());
      const { unchanged: _unchanged, ...rest } = page;
      return { ...rest, items, ...(removed.length > 0 ? { removed: [...(rest.removed ?? []), ...removed], movedTo: { ...rest.movedTo, ...movedTo } } : {}) };
    },

    // One issue: its own comments, conditionally, so a deleted comment is seen too.
    async getWork(ref) {
      const item = await work.getWork(ref);
      if (!item) return null;
      const { comments } = await commentsOf(ref.id);
      if (kept) {
        if (comments.size > 0) kept.set(ref.id, comments);
        else kept.delete(ref.id);
      }
      return fill(item, comments.values());
    },
  };
}
