// The Item page's Rounds table. One row per step of the cycle (triage, implement, review, implement resumed with the
// findings, ..., at level 4 the merge's check) and a last row for the Item's outcome, built from the item's log lines. The
// structured answers stay in Scope Soup's store for the orchestrator; this reads only what the log says, plus the session records
// in the store for the cost and the links to a session's details and chat when the line does not carry them. Pure.
//
// The order of the lines: a step's own lines (`revision`, `review`, `question`) are written before its `session` line, in the
// same settle (`src/orchestrator/cycle.ts`), so they are gathered until the next `session` line. A `check` line (level 4) and a
// `merged` line are rows of their own.

import type { LogRecord, Parked, Session } from "../model/types.ts";
import type { RoundFinding, RoundRow } from "./views.ts";

export interface RoundsInput {
  /** The item's log, oldest first: meta branch's `log`, or GitHub's log comment (`hostRecord.log`). */
  log: readonly LogRecord[];
  /** The item's sessions in the store (chat turns are left out here). */
  sessions?: readonly Session[];
  /** Where the orchestrator put the item down, when it did. */
  parked?: Pick<Parked, "as" | "reason" | "at">;
  /** GitHub's `merged` marker, when the log comment has no `merged` line. */
  merged?: { sha: string; target: string; batch?: number; at: string };
}

const STEP_WORDS: Record<string, string> = { triage: "triage", implement: "implement", review: "review" };
const LIVE: readonly Session["status"][] = ["starting", "running", "stalled"];

const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const texts = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value : []).map(text).filter((each) => each !== "");
const short = (sha: string): string => sha.slice(0, 7);

/** A review line's finding as `writeReview` writes it: `[must] file: text`. One without the mark keeps its text. */
export function parseFinding(raw: string): RoundFinding {
  const match = /^\[(must|should)\]\s*(.*)$/s.exec(raw);
  return match ? { severity: match[1] as "must" | "should", text: match[2]!.trim() } : { text: raw };
}

interface Pending {
  commits: string[];
  review?: { verdict: string; findings: RoundFinding[]; model?: string };
  questions: { question: string; parked: string; proposal?: number }[];
}

const empty = (): Pending => ({ commits: [], questions: [] });

/** The triage's verdict in a sentence, from its session line and the questions written with it. */
function triage(fields: Record<string, unknown>, pending: Pending): { found: string; tone: RoundRow["tone"] } {
  const size = text(fields.size);
  const notReady = pending.questions.find((question) => question.parked === "not-ready");
  const split = pending.questions.find((question) => question.proposal !== undefined);
  const asked = pending.questions.filter((question) => question.parked === "needs-decision" && question.proposal === undefined);
  const parts: string[] = [];
  let tone: RoundRow["tone"] = "good";
  if (split) {
    parts.push(`Proposes a restructuring into ${split.proposal} parts.`);
    tone = "wait";
  } else if (notReady || fields.ready === false) {
    parts.push(notReady ? notReady.question.replace(/^Triage: /, "") : `Not ready.${text(fields.summary) ? ` ${text(fields.summary)}` : ""}`);
    tone = "bad";
  } else if (fields.ready === true || text(fields.next) === "implement" || size) {
    parts.push(`Ready${size ? `, ${size}` : ""}.`);
  }
  if (asked.length > 0) {
    // The one line Scope Soup parks for a rewrite already counts its questions ("Triage, round 1: a rewrite ... and 2 questions wait ...").
    const whole = asked.length === 1 && /^Triage, round \d+:/.test(asked[0]!.question);
    parts.push(whole ? asked[0]!.question : `${asked.length === 1 ? "One question" : `${asked.length} questions`} for you: ${asked.map((question) => question.question).join(" / ")}`);
    tone = "wait";
  }
  // A line from earlier with nothing else to go on: its summary, unless it is only the end reason.
  if (parts.length === 0 && text(fields.summary) && text(fields.summary) !== "Completed.") parts.push(text(fields.summary));
  return { found: parts.join(" "), tone };
}

/** Builds the rows, oldest first, with the outcome last. */
export function buildRounds(input: RoundsInput): RoundRow[] {
  const sessions = (input.sessions ?? []).filter((session) => !session.chat);
  const byId = new Map(sessions.map((session) => [session.ref.id, session]));
  const used = new Set<string>();
  const rows: RoundRow[] = [];
  let pending = empty();
  let implementRounds = 0;
  let reviewRounds = 0;
  /** Why the next implement step runs again, from the row before it. */
  let resumeWhy: string | undefined;
  /** The newest question with a parked state and no answer after it: the outcome when the store has nothing parked. */
  let parkedLine: { at: string; question: string; parked: string } | undefined;
  let mergedRow = false;

  /** The store's session for a line: by its id (later lines), else the nearest unused session of the role that ended by then. */
  const sessionOf = (fields: Record<string, unknown>, at: string): Session | undefined => {
    const id = text(fields.sessionId);
    if (id) return byId.get(id);
    const role = text(fields.role);
    const until = Date.parse(at) + 60_000;
    return sessions
      .filter((session) => session.role === role && !used.has(session.ref.id) && session.finishedAt && Date.parse(session.finishedAt) <= until && Date.parse(session.finishedAt) >= Date.parse(at) - 10 * 60_000)
      .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))[0];
  };

  for (const line of input.log) {
    const f = line.fields;
    switch (line.kind) {
      case "revision": {
        const sha = text(f.sha);
        if (sha && !pending.commits.includes(sha)) pending.commits.push(sha);
        break;
      }
      case "review":
        pending.review = { verdict: text(f.verdict), findings: texts(f.findings).map(parseFinding), ...(text(f.model) ? { model: text(f.model) } : {}) };
        break;
      case "question": {
        const parked = text(f.parked);
        const question = text(f.question);
        if (!question) break;
        if (parked) parkedLine = { at: line.at, question, parked };
        // An escalation is the outcome's row, not what the step found.
        if (parked && parked !== "escalated") {
          const proposal = typeof f.proposal === "object" && f.proposal !== null && Array.isArray((f.proposal as Record<string, unknown>).parts) ? ((f.proposal as Record<string, unknown>).parts as unknown[]).length : undefined;
          pending.questions.push({ question, parked, ...(proposal !== undefined ? { proposal } : {}) });
        }
        break;
      }
      case "answer":
        parkedLine = undefined;
        break;
      case "check": {
        const pass = text(f.verdict) === "pass";
        const findings = pass ? [] : texts(f.findings).map((finding) => ({ text: finding }));
        const batch = number(f.batch);
        rows.push({
          kind: "check", step: "check", at: line.at, findings, commits: text(f.sha) ? [text(f.sha)] : [],
          ...(text(f.command) ? { model: text(f.command) } : {}),
          found: pass ? `Passed${batch !== undefined ? ` in batch ${batch}` : ""}.` : `Failed${batch !== undefined ? ` in batch ${batch}` : ""}: the change goes back to the implementor.`,
          tone: pass ? "good" : "bad",
        });
        if (!pass) resumeWhy = "with the failing check";
        break;
      }
      case "merged": {
        const sha = text(f.sha);
        const batch = number(f.batch);
        const target = text(f.target) || "the main branch";
        rows.push({
          kind: "end", step: "merged", at: line.at, findings: [], commits: sha ? [sha] : [], tone: "good",
          found: batch !== undefined ? `Merged on ${target} as ${short(sha)} in batch ${batch}.` : `Merged to ${target} as ${short(sha)} by the implementor.`,
        });
        mergedRow = true;
        parkedLine = undefined;
        pending = empty();
        break;
      }
      case "session": {
        const role = text(f.role);
        const session = sessionOf(f, line.at);
        if (session) used.add(session.ref.id);
        const outcome = text(f.outcome);
        const row: RoundRow = { kind: "step", step: STEP_WORDS[role] ?? (role || "session"), at: line.at, findings: [], commits: pending.commits };
        const model = text(f.model) || session?.model;
        if (model) row.model = model;
        const durationMs = number(f.durationMs);
        if (durationMs !== undefined) row.durationMs = durationMs;
        const costUsd = number(f.costUsd) ?? session?.costUsd;
        if (costUsd !== undefined) row.costUsd = costUsd;
        if (session) row.session = session.ref.id;
        else if (text(f.sessionId)) row.session = text(f.sessionId);
        if (session?.agentSessionId) row.agentSession = session.agentSessionId;
        const summary = text(f.summary);
        if (outcome && outcome !== "succeeded") {
          row.outcome = outcome;
          row.found = `The session ${outcome === "limit" ? "hit the usage limit" : outcome === "cancelled" ? "was stopped" : "failed"}${summary ? `: ${summary}` : "."}`;
          row.tone = outcome === "failed" ? "bad" : "wait";
        } else if (role === "triage") {
          const look = triage(f, pending);
          if (look.found) row.found = look.found;
          row.tone = look.tone;
        } else if (role === "implement") {
          implementRounds++;
          row.round = implementRounds;
          if (implementRounds > 1 && resumeWhy) row.resumed = resumeWhy;
          if (summary) row.did = summary;
          const asked = pending.questions.filter((question) => question.parked === "needs-decision");
          if (asked.length > 0) {
            row.found = `Asks you: ${asked.map((question) => question.question).join(" / ")}`;
            row.tone = "wait";
          }
          resumeWhy = undefined;
        } else if (role === "review") {
          reviewRounds++;
          row.round = reviewRounds;
          const review = pending.review;
          if (review?.model && !row.model) row.model = review.model;
          if (review) {
            row.findings = review.findings;
            const must = review.findings.filter((finding) => finding.severity === "must").length;
            const pass = review.verdict === "pass";
            row.found = pass
              ? `Approves${review.findings.length > 0 ? `, with ${review.findings.length} suggestion${review.findings.length === 1 ? "" : "s"}` : ""}.`
              : `Asks for changes: ${must > 0 ? `${must} must` : `${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}`}${must > 0 && review.findings.length > must ? `, ${review.findings.length - must} should` : ""}.`;
            row.tone = pass ? "good" : "bad";
            resumeWhy = pass ? (text(f.next) === "implement" ? "to merge it" : undefined) : "with the review's findings";
          } else if (summary) row.found = summary;
        } else if (summary) row.did = summary;
        rows.push(row);
        pending = empty();
        break;
      }
    }
  }

  // Commits nobody's session line claimed (a person's hand-back): a row of their own.
  if (pending.commits.length > 0) rows.push({ kind: "step", step: "commits", at: input.log[input.log.length - 1]?.at ?? "", findings: [], commits: pending.commits, did: `${pending.commits.length} new commit${pending.commits.length === 1 ? "" : "s"} on the branch.` });

  // Sessions running now: their line is written when they end.
  for (const session of sessions) {
    if (used.has(session.ref.id) || !LIVE.includes(session.status) || session.finishedAt) continue;
    const role = STEP_WORDS[session.role] ?? session.role;
    const row: RoundRow = { kind: "step", step: role, at: session.startedAt, findings: [], commits: [], live: true, tone: "wait", session: session.ref.id, found: session.lastAction ? `Now: ${session.lastAction}` : "Running." };
    if (session.model) row.model = session.model;
    if (session.agentSessionId) row.agentSession = session.agentSessionId;
    if (session.costUsd !== undefined) row.costUsd = session.costUsd;
    if (session.role === "implement" && implementRounds > 0) {
      row.round = implementRounds + 1;
      if (resumeWhy) row.resumed = resumeWhy;
    }
    rows.push(row);
  }

  if (!mergedRow && input.merged) {
    const { sha, target, batch, at } = input.merged;
    rows.push({
      kind: "end", step: "merged", at, findings: [], commits: [sha], tone: "good",
      found: batch !== undefined ? `Merged on ${target} as ${short(sha)} in batch ${batch}.` : `Merged to ${target} as ${short(sha)}.`,
    });
    mergedRow = true;
  }
  if (mergedRow) return rows;

  const parked = input.parked ?? (parkedLine ? { as: parkedLine.parked as Parked["as"], reason: parkedLine.question, at: parkedLine.at } : undefined);
  if (parked && rows.some((row) => row.live) === false) {
    const end = parkedRow(parked);
    if (end) rows.push(end);
  }
  return rows;
}

function parkedRow(parked: Pick<Parked, "as" | "reason" | "at">): RoundRow | null {
  const base = { kind: "end" as const, at: parked.at, findings: [], commits: [], found: parked.reason };
  switch (parked.as) {
    case "escalated":
      return { ...base, step: "escalated", tone: "bad" };
    case "needs-decision":
    case "not-ready":
      return { ...base, step: "waiting for you", tone: "wait" };
    case "handed-over":
      return { ...base, step: "waiting for you", found: `To merge: ${parked.reason}`, tone: "wait" };
    case "queued":
      return { ...base, step: "in the merge queue", tone: "wait" };
    default:
      return { ...base, step: String(parked.as), tone: "wait" };
  }
}
