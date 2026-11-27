// Jobs and the answers rebuilt from items' logs (meta branch), so the local store is never
// the only copy of where an item stands. Each item is looked at once per store: the first tick
// that sees it. A deleted store sees every item again.
//
// The rule for a restart and a lost store (#238): what is lost is only what this process or this store held; the host (each
// Item's log) and git (its branch, the remote's main) are read back, and nothing they do not say is made up.
// - A restart keeps the store: a session whose process is gone is `orphaned`, and its step starts again, not counted as a failure,
//   up to the attempts' limit in a row (`settleStep`). A change in the merge queue stays there, the queue's state being in the store.
// - A lost store: the answers are the logs', read on every read (`knownAnswers`) beside what the store has (a person may answer
//   before the first tick), and the job is what the log says: an item whose log has an open question waits for its answer; one
//   whose newest revision has a passing review and has not merged goes to merging (handed over again, so to the queue that exists now); one whose last
//   session said what comes next starts that step again. Anything else starts as a new item.
// - Either way, a change is merged when main holds it, whoever put it there: the queue's notice, the session merge check (told or
//   not, against the main the work started from), or a handed-over branch a person merged.
// - An answer on the meta branch is recorded only once the item's log took it (`answerAll` in the server), so it is never only here,
//   and every machine reads it from there.
//
// A GitHub Item has no log of its own. Its record is Scope Soup's comments: the log comment's lines and the waiting triage
// rewrite (`hostRecord`), and the question comments. `jobFromHost` reads those. Its answers stay on GitHub and are read from
// there, so none is restored into the store.

import type { LogRecord, OpenQuestion, RecordedAnswer, Session, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Context } from "./context.ts";
import { SCOPESOUP } from "./hostActions.ts";
import type { Decision, Finding, Job, JobStep, ParkedAs } from "./jobs.ts";
import { formatFindings, jobOf, setWhere, where } from "./jobs.ts";
import { workBranch, workspaceKey } from "./paths.ts";

const SEEN_KEY = "orchestrator.logs_read";

const STEPS: readonly string[] = ["triage", "implement", "review"];
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
    setWhere(job, { parked: { as, reason: asked.question, at: asked.at, ...(line?.fields.retry === "hand-over" ? { retry: "hand-over" as const } : {}) } });
    if (as === "needs-decision") parkOnQuestion(job, asked);
    return job;
  }
  return resumeFromLines(job, log, sessions, newest, review);
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
    setWhere(job, { step: "triage" });
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
    setWhere(job, { parked: { as: "needs-decision", reason: `${said}${note}`, at: rewrite.at, rewrite: { id: rewrite.id, questions: ids, ...(askedAt ? { askedAt } : {}) } } });
    return job;
  }

  const asked = open[open.length - 1];
  if (asked) {
    const set = asked.proposal ? [] : open.filter((question) => !question.proposal && question.question.trim() !== "");
    if (set.length > 1) parkOnDecisions(job, set);
    else {
      setWhere(job, { parked: { as: "needs-decision", reason: asked.question, at: asked.at } });
      parkOnQuestion(job, asked);
    }
    const ids = (set.length > 1 ? set : [asked]).flatMap((question) => (question.id ? [question.id] : []));
    setWhere(job, { parked: { ...where(job).parked!, questions: ids, askedAt: asked.at } });
    return job;
  }
  return resumeFromLines(job, log, sessions, newest, review);
}

/** The job's start from Scope Soup's log lines: branch, head, review rounds, and what the sessions answered as far as the cycle reads it. */
function fromLines(item: WorkItem, log: readonly LogRecord[], startedAt: string) {
  const of = (kind: string): LogRecord[] => log.filter((line) => line.kind === kind);
  const revisions = of("revision");
  const newest = revisions[revisions.length - 1];
  const job: Job = jobOf({
    item: item.ref,
    workspace: workspaceKey(item.ref),
    branch: str([...revisions].reverse().find((line) => str(line.fields.branch))?.fields.branch) || workBranch(item.ref),
    step: "triage",
    failures: 0,
    fixRounds: of("review").filter((line) => line.fields.verdict === "fail").length,
    startedAt,
  });
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
    // No revision line (a host outage lost it): the revision the review read is the newest known (#268).
    if (!newest && str(review.fields.sha)) job.head = str(review.fields.sha);
  }
  return { job, of, sessions, newest, review };
}

/** Several questions wait again, in order, so the first answer does not release the item. The parked state's time is the first one's (`parkedAt`). */
function parkOnDecisions(job: Job, set: readonly OpenQuestion[]): Job {
  const decisions: Decision[] = set.map(decisionOf);
  setWhere(job, { parked: { as: "needs-decision", reason: `Triage found ${decisions.length} decisions for a person before the work can start: ${decisions.map((d, i) => `${i + 1}. ${d.question}`).join(" ")}`, at: set[0]!.at } });
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
function resumeFromLines(job: Job, log: readonly LogRecord[], sessions: readonly LogRecord[], newest: LogRecord | undefined, review: LogRecord | undefined): Job | null {
  // 2. The last session said which step comes next: that step starts again.
  const next = str(sessions[sessions.length - 1]?.fields.next);
  if (STEPS.includes(next)) {
    setWhere(job, { step: next as JobStep });
    // A review that asked for changes sent the change back to the implementor: a fresh one gets the findings.
    if (next === "implement" && sessions[sessions.length - 1]?.fields.role === "review" && job.review?.verdict === "changes" && job.review.findings.length > 0) {
      // The log's findings already carry their severity and file.
      job.resumeWith = `The reviewer asked for these changes:\n${job.review.findings.map((finding) => `- ${finding.text}`).join("\n")}\nFix them and commit.`;
    }
    return job;
  }

  // 3. Reviewed and not merged: the hand-over (merging) is done again, without a session. Not when a triage ran after that review:
  // the work was dropped and started again from triage (a person's To do or Triage pick), so the old approval hands nothing over.
  const triagedSince = review !== undefined && sessions.some((line) => line.fields.role === "triage" && log.indexOf(line) > log.indexOf(review));
  // A revision line a host outage lost: the review names the revision it read (#268).
  const reviewedNewest = review !== undefined && (newest ? review.fields.sha === newest.fields.sha : str(review.fields.sha) !== "");
  if (reviewedNewest && review.fields.verdict === "pass" && !triagedSince) {
    setWhere(job, { step: "review", owes: "hand-over" });
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

/** Rebuilds jobs for items seen for the first time in this store. Their answers are read from the logs on every read (`knownAnswers`). */
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
  for (const item of fresh) {
    const key = refKey(item.ref);
    if (ctx.jobs[key]) continue;
    // A GitHub Item, whose record is Scope Soup's comments (a question comment has an id).
    const onHost = !item.log && (!!item.hostRecord || (item.openQuestions ?? []).some((question) => question.id !== undefined));
    if (!item.log && !onHost) continue;
    const job = onHost ? jobFromHost(item) : jobFromLog(item);
    if (!job) continue;
    // Backlog is no work (decision 121): a step that would start again there is not rebuilt, as a move to Backlog drops it (the
    // move's drop may have been lost with the store). What waits for a person there still waits.
    if (item.backlog && !where(job).parked) continue;
    ctx.jobs[key] = job;
    const at = where(job);
    const said = at.parked ? `parked as "${at.parked.as}": ${at.parked.reason}` : at.owes ? "reviewed and not merged: the hand-over is done again" : `the ${at.step} step starts again`;
    ctx.commit("orchestrator.recovered", `Rebuilt from the item's ${onHost ? `comments on ${item.ref.host}` : "log"}: ${said}`, key, { step: at.step });
  }
  store.setValue(SEEN_KEY, JSON.stringify([...seen, ...fresh.map((item) => refKey(item.ref))]));
}

