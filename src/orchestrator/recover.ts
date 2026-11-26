// Jobs and the answers rebuilt from items' logs (meta branch), so the local store is never
// the only copy of where an item stands. Each item is looked at once per store: the first tick
// that sees it. A deleted store sees every item again.
//
// Only what one laptop needs: an item whose log has an open question waits for its answer; one
// whose newest revision has a passing review and has not merged goes to merging; one whose last
// session said what comes next starts that step again. Anything else starts as a new item.
//
// A GitHub Item has no log of its own. Its record is Scope Soup's comments: the log comment's lines and the waiting triage
// rewrite (`hostRecord`), and the question comments. `jobFromHost` reads those. Its answers stay on GitHub and are read from
// there, so none is restored into the store.

import type { LogRecord, OpenQuestion, RecordedAnswer, Session, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { loadAnswers, restoreAnswers } from "../store/answers.ts";
import type { Context } from "./context.ts";
import { SCOPESOUP } from "./hostActions.ts";
import type { Decision, Finding, Job, JobStep, ParkedAs } from "./jobs.ts";
import { formatFindings } from "./jobs.ts";
import { workBranch, workspaceKey } from "./paths.ts";

const SEEN_KEY = "orchestrator.logs_read";

const STEPS: readonly string[] = ["triage", "implement", "review"];
/** Steps that were removed (the checklist's "check-review"; "fix"). A job stored or rebuilt at one is moved on by `migrateRemovedSteps`. */
const REMOVED_STEPS: readonly string[] = ["check-review", "fix"];
const PARKED_AS: readonly string[] = ["queued", "handed-over", "needs-decision", "not-ready", "escalated"];

const isScopeSoup = (line: { by: { who: string; agent: boolean } }): boolean => line.by.agent && line.by.who === SCOPESOUP.who;
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The job the item's log describes, or null when the item may start as new. Pure. */
export function jobFromLog(item: WorkItem): Job | null {
  const log = (item.log ?? []).filter(isScopeSoup);
  if (log.length === 0 || item.state === "done" || item.state === "abandoned") return null;
  const { job, of, sessions, newest, review } = fromLines(item, log, log[0]!.at);

  // 1. Waits for the answer.
  const open = (item.openQuestions ?? []).filter(isScopeSoup);
  const asked = open[open.length - 1];
  if (asked) {
    const lineOf = (question: OpenQuestion): LogRecord | undefined => of("question").find((each) => Date.parse(each.at) === Date.parse(question.at));
    const line = lineOf(asked);
    const parked = str(line?.fields.parked);
    const as: ParkedAs = PARKED_AS.includes(parked) ? (parked as ParkedAs) : "needs-decision";
    const set = as === "needs-decision" && !asked.proposal ? questionSet(log, open, lineOf) : [];
    // Triage asked several questions (park writes one log line each): all of them wait again, in log order.
    if (set.length > 1) return parkOnDecisions(job, set);
    job.parked = { as, reason: asked.question, at: asked.at, ...(line?.fields.retry === "hand-over" ? { retry: "hand-over" as const } : {}) };
    if (as === "needs-decision") parkOnQuestion(job, asked);
    return job;
  }
  return resumeFromLines(job, sessions, newest, review);
}

/**
 * The job Scope Soup's comments on a GitHub Item describe, or null when the Item may start as new. Pure. A triage rewrite
 * that waits comes back with its round, questions and rewrite comment: `original` is the body when its sha256 is the rewrite's
 * `bodySha`, else the current body, and the parked state's reason says so. Open question comments come back as the parked state that names them,
 * so their answers are read from GitHub. Otherwise the log comment's last session says which step starts again, as on the meta branch.
 */
export function jobFromHost(item: WorkItem): Job | null {
  if (item.state === "done" || item.state === "abandoned") return null;
  const record = item.hostRecord;
  const log = (record?.log ?? []).filter(isScopeSoup);
  const inRewrite = new Set(record?.rewriteQuestions ?? []);
  const open = (item.openQuestions ?? []).filter((question) => isScopeSoup(question) && !inRewrite.has(question.id ?? ""));
  const rewrite = record?.rewrite;
  const startedAt = log[0]?.at ?? rewrite?.at ?? open[0]?.at;
  if (startedAt === undefined) return null;
  const { job, sessions, newest, review } = fromLines(item, log, startedAt);

  if (rewrite) {
    const questions = rewrite.questions.map(decisionOf);
    job.step = "triage";
    job.triage ??= { ready: true, size: "medium", paths: [], hidesDecision: false };
    job.triage.hidesDecision = questions.length > 0;
    job.rewrite = { original: (item.body ?? "").trim(), text: rewrite.text, questions, round: rewrite.round, ...(rewrite.labels ? { labels: rewrite.labels } : {}) };
    // The rounds so far are the rewrite comments.
    job.rewriteRounds = Math.max(record!.rewriteRounds, rewrite.round);
    const said = questions.length > 0
      ? `Triage, round ${rewrite.round}: a rewrite of the description and ${questions.length === 1 ? "1 question waits" : `${questions.length} questions wait`} for an answer: ${questions.map((each, index) => `${index + 1}. ${each.question}`).join(" ")}`
      : `Triage, round ${rewrite.round}: a rewrite of the description waits for a person to accept, edit or reject.`;
    const note = rewrite.bodyKnown ? "" : " The description the rewrite read is no longer known: the current one is shown as the original.";
    const ids = rewrite.questions.flatMap((question) => (question.id ? [question.id] : []));
    const askedAt = rewrite.questions[rewrite.questions.length - 1]?.at;
    job.parked = { as: "needs-decision", reason: `${said}${note}`, at: rewrite.at, rewrite: { id: rewrite.id, questions: ids, ...(askedAt ? { askedAt } : {}) } };
    return job;
  }

  const asked = open[open.length - 1];
  if (asked) {
    const set = asked.proposal ? [] : open.filter((question) => !question.proposal && question.question.trim() !== "");
    if (set.length > 1) parkOnDecisions(job, set);
    else {
      job.parked = { as: "needs-decision", reason: asked.question, at: asked.at };
      parkOnQuestion(job, asked);
    }
    const ids = (set.length > 1 ? set : [asked]).flatMap((question) => (question.id ? [question.id] : []));
    job.parked = { ...job.parked!, questions: ids, askedAt: asked.at };
    return job;
  }
  return resumeFromLines(job, sessions, newest, review);
}

/** The job's start from Scope Soup's log lines: branch, head, review rounds, and what the sessions answered as far as the cycle reads it. */
function fromLines(item: WorkItem, log: readonly LogRecord[], startedAt: string) {
  const of = (kind: string): LogRecord[] => log.filter((line) => line.kind === kind);
  const revisions = of("revision");
  const newest = revisions[revisions.length - 1];
  const job: Job = {
    item: item.ref,
    workspace: workspaceKey(item.ref),
    branch: str([...revisions].reverse().find((line) => str(line.fields.branch))?.fields.branch) || workBranch(item.ref),
    step: "triage",
    failures: 0,
    fixRounds: of("review").filter((line) => line.fields.verdict === "fail").length,
    startedAt,
  };
  if (newest) job.head = str(newest.fields.sha);

  const sessions = of("session");
  const lastOf = (role: string): LogRecord | undefined => sessions.filter((line) => line.fields.role === role).pop();
  const triage = lastOf("triage");
  if (triage) {
    const size = triage.fields.size;
    job.triage = {
      ready: true, size: size === "small" || size === "large" ? size : "medium", paths: [], hidesDecision: false,
    };
  }
  const implement = lastOf("implement");
  if (implement) job.implement = { done: true, summary: str(implement.fields.summary) };
  const review = of("review").pop();
  if (review) {
    const findings: Finding[] = (Array.isArray(review.fields.findings) ? review.fields.findings : []).filter((text): text is string => typeof text === "string").map((text) => ({ severity: "must", text }));
    job.review = { verdict: review.fields.verdict === "pass" ? "approve" : "changes", findings };
    if (str(review.fields.sha)) job.reviewedHead = str(review.fields.sha);
  }
  return { job, of, sessions, newest, review };
}

/** Several questions wait again, in order, so the first answer does not release the item. The parked state's time is the first one's (`parkedAt`). */
function parkOnDecisions(job: Job, set: readonly OpenQuestion[]): Job {
  const decisions: Decision[] = set.map(decisionOf);
  job.parked = { as: "needs-decision", reason: `Triage found ${decisions.length} decisions for a person before the work can start: ${decisions.map((d, i) => `${i + 1}. ${d.question}`).join(" ")}`, at: set[0]!.at };
  job.triage ??= { ready: true, size: "medium", paths: [], hidesDecision: true };
  job.triage.hidesDecision = true;
  job.triage.decision = decisions[0];
  job.triage.decisions = decisions;
  return job;
}

/** One question waits: a proposed restructuring, or a decision with options. */
function parkOnQuestion(job: Job, asked: OpenQuestion): void {
  if (asked.proposal) {
    // A proposed restructuring is still waiting for a person.
    job.proposal = { ...asked.proposal };
  } else if (asked.options.length > 0) {
    job.triage ??= { ready: true, size: "medium", paths: [], hidesDecision: true };
    job.triage.decision = decisionOf(asked);
  }
}

/** When the store has nothing parked: the step the last session named starts again, or a reviewed change that has not merged is handed over again. */
function resumeFromLines(job: Job, sessions: readonly LogRecord[], newest: LogRecord | undefined, review: LogRecord | undefined): Job | null {
  // 2. The last session said which step comes next: that step starts again.
  const next = str(sessions[sessions.length - 1]?.fields.next);
  if (STEPS.includes(next) || REMOVED_STEPS.includes(next)) {
    job.step = next as JobStep;
    // A review that asked for changes sent the change back to the implementor: a fresh one gets the findings.
    if (next === "implement" && sessions[sessions.length - 1]?.fields.role === "review" && job.review?.verdict === "changes" && job.review.findings.length > 0) {
      // The log's findings already carry their severity and file.
      job.resumeWith = `The reviewer asked for these changes:\n${job.review.findings.map((finding) => `- ${finding.text}`).join("\n")}\nFix them and commit.`;
    }
    return job;
  }

  // 3. Reviewed and not merged: the hand-over (merging) is done again, without a session.
  if (newest && review && review.fields.sha === newest.fields.sha && review.fields.verdict === "pass") {
    job.step = "review";
    job.owes = "hand-over";
    return job;
  }
  return null;
}

const decisionOf = (asked: OpenQuestion): Decision => ({ question: asked.question, options: asked.options, recommendation: asked.recommendation ?? "", ...(asked.context ? { context: asked.context } : {}), ...(asked.multiSelect ? { multiSelect: true as const } : {}) });

/**
 * The open questions of the newest parked, in log order: the run of Scope Soup question lines that ends with the newest open
 * question (park writes a parked state's questions one after the other), kept when still open, a "needs-decision" parked and not a
 * proposed restructuring. An earlier parked's questions are cut off by the Scope Soup lines written between them.
 */
function questionSet(log: readonly LogRecord[], open: readonly OpenQuestion[], lineOf: (question: OpenQuestion) => LogRecord | undefined): OpenQuestion[] {
  const newest = lineOf(open[open.length - 1]!);
  const end = newest ? log.indexOf(newest) : -1;
  if (end < 0) return [];
  let start = end;
  while (start > 0 && log[start - 1]!.kind === "question") start--;
  const run = log.slice(start, end + 1);
  return open.filter((question) => {
    const line = lineOf(question);
    return !question.proposal && !!line && run.includes(line) && line.fields.parked === "needs-decision" && question.question.trim() !== "";
  });
}

/** The answers in the item's log, each with the question it names. Pure. */
export function answersFromLog(item: WorkItem): RecordedAnswer[] {
  const log = item.log ?? [];
  return log.flatMap((line): RecordedAnswer[] => {
    if (line.kind !== "answer" || line.by.agent || !str(line.fields.answer)) return [];
    const to = str(line.fields.to);
    const question = to ? log.find((each) => each.kind === "question" && Date.parse(each.at) === Date.parse(to)) : undefined;
    const text = str(question?.fields.question);
    return [{ subject: item.ref, answer: str(line.fields.answer), by: line.by.who, at: line.at, ...(text ? { question: text } : {}) }];
  });
}

/** Rebuilds jobs and answers for items seen for the first time in this store. */
export function recoverFromLogs(ctx: Context, items: readonly WorkItem[]): void {
  const { store } = ctx.deps;
  let seen: string[];
  try {
    const value: unknown = JSON.parse(store.getValue(SEEN_KEY) ?? "[]");
    seen = Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
  } catch {
    seen = [];
  }
  const known = new Set(seen);
  // An item another machine holds is its work: its log is not taken over here. It is triaged again once the claim is gone.
  const claimant = ctx.deps.actions.claimant;
  const heldElsewhere = (item: WorkItem): boolean =>
    !!claimant && !!item.holder && item.holder.actor.id !== claimant && (item.holder.until === undefined || Date.parse(item.holder.until) > Date.parse(ctx.at));
  const fresh = items.filter((item) => !known.has(refKey(item.ref)) && !heldElsewhere(item));
  if (fresh.length === 0) return;
  const answered = new Set(loadAnswers(store).map((answer) => refKey(answer.subject)));
  for (const item of fresh) {
    const key = refKey(item.ref);
    if (ctx.jobs[key]) continue;
    // A GitHub Item, whose record is Scope Soup's comments (a question comment has an id).
    const onHost = !item.log && (!!item.hostRecord || (item.openQuestions ?? []).some((question) => question.id !== undefined));
    if (!item.log && !onHost) continue;
    if (!onHost && !answered.has(key)) {
      const answers = answersFromLog(item);
      if (answers.length > 0) restoreAnswers(store, answers, ctx.at);
    }
    const job = onHost ? jobFromHost(item) : jobFromLog(item);
    if (!job) continue;
    ctx.jobs[key] = job;
    const where = job.parked ? `parked as "${job.parked.as}": ${job.parked.reason}` : job.owes ? "reviewed and not merged: the hand-over is done again" : `the ${job.step} step starts again`;
    ctx.commit("orchestrator.recovered", `Rebuilt from the item's ${onHost ? `comments on ${item.ref.host}` : "log"}: ${where}`, key, { step: job.step });
  }
  store.setValue(SEEN_KEY, JSON.stringify([...seen, ...fresh.map((item) => refKey(item.ref))]));
}

/**
 * Moves on jobs left at a step that was removed, from the store or rebuilt from a log, so none is stuck after an upgrade.
 * A "check-review" job (the checklist stage) goes to review from level 3, else it is released and the
 * item starts over. The findings a failed checklist left for the next fix session become the review's findings it reads.
 * A job parked on a proposed rewrite of the item's text (removed) is released: the item starts over at triage,
 * which asks a question if the text is still wrong.
 * A "fix" job (the fix role) goes back to implement with the review's findings: the implementor's own session is
 * resumed when the store still knows it, else a fresh implementor gets the findings. A fix session that was running at the
 * upgrade is settled as an implementor's (its answer has the same shape), and a parked Item stays parked.
 */
export function migrateRemovedSteps(ctx: Context): void {
  for (const [key, job] of Object.entries(ctx.jobs)) {
    if (job.proposal && !(Array.isArray(job.proposal.parts) && job.proposal.parts.length > 0)) {
      delete ctx.jobs[key];
      ctx.commit("orchestrator.job_released", "The item was parked on a proposed rewrite of its text, which Scope Soup no longer asks about: the job is released and the item starts over at triage.", key, { was: job.parked });
      continue;
    }
    // The pre-approval check was removed: its start count goes, and an owed hand-over is simply repeated by the
    // next hand-over. A check that was running
    // lived only in memory and ended with the old process.
    const precheck = job as Job & { preCheckStarts?: unknown };
    if (precheck.preCheckStarts !== undefined) {
      delete precheck.preCheckStarts;
      ctx.commit("orchestrator.job_migrated", "The count of pre-approval check starts is dropped: that check was removed.", key);
    }
    // Other fields the checklist stage left (`checklist`, `seenRules`, `messageRoundUsed`) are no longer read and do no harm.
    const legacy = job as Job & { fixFindings?: Finding[] };
    if (legacy.fixFindings) {
      const carried = (job.step as string) === "fix" && legacy.fixFindings.length > 0;
      if (carried) job.review = { verdict: "changes", findings: legacy.fixFindings };
      delete legacy.fixFindings;
      ctx.commit("orchestrator.job_migrated", carried ? "The findings of a failed checklist are kept as the findings the implementor works from." : "The findings of a failed checklist are dropped: nothing reads them now.", key);
    }
    if (!REMOVED_STEPS.includes(job.step)) continue;
    if ((job.step as string) === "fix") {
      migrateFix(ctx, key, job);
      continue;
    }
    const was = job.step as string;
    // A checklist session's answer is no longer read: whatever it was doing, the job moves on without it.
    delete job.sessionId;
    delete job.resume;
    delete job.notBefore;
    job.failures = 0;
    if (ctx.config.level >= 3) {
      job.step = "review";
      ctx.commit("orchestrator.step_migrated", `The ${was} step was removed (the checklist stage is gone): the change goes to review instead.`, key, { from: was, to: "review" });
    } else {
      delete ctx.jobs[key];
      ctx.commit("orchestrator.job_released", `The ${was} step was removed (the checklist stage is gone) and level ${ctx.config.level} has no review: the job is released and the item starts over.`, key, { from: was, was: job.parked });
    }
  }
}

/** A job at the removed "fix" step goes back to the implementor with the findings it was to fix. */
function migrateFix(ctx: Context, key: string, job: Job): void {
  job.step = "implement";
  const findings = job.review?.findings ?? [];
  job.resumeWith = findings.length > 0 ? `The reviewer asked for these changes:\n${formatFindings(findings)}\nFix them and commit.` : "The change was sent back. Look at it again, fix what is wrong and commit.";
  // The implementor's own session, when the store still has it: the newest implement session of the item that names one.
  const known = ctx.deps.store.list<Session>("session")
    .filter((session) => refKey(session.subject) === key && session.role === "implement" && session.agentSessionId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .pop();
  if (known?.agentSessionId && !job.agentSession) job.agentSession = known.agentSessionId;
  const how = job.agentSession ? "the implementor's own session is resumed with the findings" : "the implementor's session is not known, so a fresh implementor starts with the findings";
  ctx.commit("orchestrator.step_migrated", `The fix step was removed (findings go back to the implementor): ${how}.`, key, { from: "fix", to: "implement" });
}
