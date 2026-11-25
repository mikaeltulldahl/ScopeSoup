// The job cycle as an explicit state machine: what happens to a job when its session ends.
//   triage -> implement -> review -> (implement resumed with the findings -> review)* -> merged by the session | handed to the queue
// Below level 4 Scope Soup merges nothing: the implementor merges (level 2), or is resumed to merge after the reviewer's
// approval (level 3), and the hand-over checks that the remote's main contains the branch head. At level 4 Scope Soup merges every
// reviewed change through the merge queue; no change waits for a person's approval.
// Every other end parks the Item with a reason: needs a decision, not ready, escalated.

import type { LabelChange, Ref, RepoLabel, Session, WorkItem } from "../model/types.ts";
import { changeText, isEmptyChange, keepProposal } from "../model/labels.ts";
import { optionText, refKey, restructuringWords } from "../model/types.ts";
import { reusableAnswer } from "../core/answerReuse.ts";
import { blockersOnHost, loadOwnBlockers, setOwnBlockers } from "../store/blockers.ts";
import { answersText, knownAnswers } from "../store/answers.ts";
import { persistenceLimits } from "../config/persistence.ts";
import type { Context } from "./context.ts";
import { ACTOR, errorText } from "./context.ts";
import type { AskedText, Decision, ItemLinkAnswer, Job, ParkedAs, ReviewAnswer, TakenDecision, TriageAnswer } from "./jobs.ts";
import { ASK_PERSON, asImplement, asReview, asTriage, formatFindings, hasMarkup, recoverFields, keepsRecommendations, picks, questionsSettled, releaseIn, parkedDraft } from "./jobs.ts";
import { providerFor } from "./providers/index.ts";
import type { Actions, SessionResultRecord } from "./ports.ts";
import type { QuestionWrite } from "../ports/host.ts";
import { COMMENT_LIMIT, TooLarge, WriteLater } from "../ports/host.ts";
import { mergeQueueOn } from "../store/control.ts";
import { handOverToQueue } from "./queueMerge.ts";
import { closeMerged } from "./mergedClose.ts";
import { itemRepository } from "./workspaces.ts";
import { setupFailedText } from "./setup.ts";
import { triagedNow, triagedText } from "./recheck.ts";
import type { PendingOverturn } from "./overturns.ts";
import { dropOverturns, overturnMessage, overturnsFor } from "./overturns.ts";
import type { ChangedFile } from "../core/fence.ts";
import { FENCE_OUTSIDE_FILES, fenceBreach, proposedSplit } from "../core/fence.ts";
import type { Finding } from "./jobs.ts";
import { restructuringId } from "./restructure.ts";
import { findingKey, noProgress, shouldDraft } from "./progress.ts";
import type { ProposedDraft } from "./drafts.ts";
import { fileDrafts } from "./drafts.ts";
import { reviewSettings } from "../config/types.ts";
import { busyWhy, isOpenItem, keepAboutOthers, linkedItem as namedItem, readWaitingAbouts, writeWaitingAbouts } from "./aboutOthers.ts";
import { workBranch, workspaceKey } from "./paths.ts";


const CONTINUE_MS = 1000;
const BACKOFF_BASE_MS = 10_000;

const PARK_EVENT: Record<ParkedAs, string> = {
  queued: "orchestrator.queued",
  "handed-over": "orchestrator.handed_over",
  "needs-decision": "orchestrator.needs_decision",
  "not-ready": "orchestrator.not_ready",
  escalated: "orchestrator.escalated",
};

function later(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

/** Delay before retry `n` (1 for the first): 10 s doubling, up to the cap. */
export function backoffMs(failures: number, capMs: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), capMs);
}

/** Ends the cycle for now. `ask` puts the item on everyone's list (or the person's whose hand-back it is). */
export async function park(ctx: Context, job: Job, as: ParkedAs, reason: string, ask?: Parameters<Actions["answerTurn"]>[1], retry?: "hand-over", byStep?: true): Promise<void> {
  const key = refKey(job.item);
  job.parked = { as, reason, at: ctx.at, ...(retry ? { retry } : {}), ...(byStep ? { byStep } : {}) };
  // Answers to an earlier set of questions do not count for this parked Item.
  delete job.answered;
  delete job.sessionId;
  delete job.notBefore;
  delete job.resume;
  ctx.commit(PARK_EVENT[as], reason, key, { step: job.step });
  const { actions, runner } = ctx.deps;
  if (ask) await tellPeople(ctx, job, as, reason, ask, retry);
  if (as !== "queued" && as !== "handed-over" && actions.claims) {
    await ctx.act("release the claim", key, () => actions.release(job.item, reason));
  }
  await ctx.act("remove the worktree", key, () => runner.releaseWorkspace(job.workspace));
}

/**
 * The questions or the draft of a parked Item could not be posted for a reason that can change (GitHub down, a 5xx, a rate limit):
 * each tick posts them again by itself, until they are through (the parked Item is a person's question again) or refused for good (it
 * stays escalated). What GitHub took before it failed is found by the host and not posted twice.
 */
export async function retryPost(ctx: Context, job: Job): Promise<void> {
  const parked = job.parked!;
  await tellPeople(ctx, job, "needs-decision", parked.posting ?? parked.reason, "decision");
}

/** `park`'s word to a person: the questions, draft or split on the item's host (GitHub), else a person's list and the item's log. */
async function tellPeople(ctx: Context, job: Job, as: ParkedAs, reason: string, ask: Parameters<Actions["answerTurn"]>[1], retry?: "hand-over"): Promise<void> {
  const key = refKey(job.item);
  const { actions } = ctx.deps;
  // In the item's log too (meta branch): the question stays open until the answer names it. `parked` and `retry` let a restart put the job back.
  // A question from triage or the implementer, or a proposed restructuring.
  // A draft is one line naming the parked Item; its questions are answered with the draft on the item page.
  const refining = as === "needs-decision" && job.refine !== undefined;
  const asked = as === "needs-decision" && !refining ? job.decision ?? (job.step === "triage" ? job.triage?.decision : undefined) : undefined;
  const decision = asked?.question.trim() ? asked : undefined;
  const proposal = as === "needs-decision" ? job.proposal : undefined;
  // Triage found several decisions: each is its own question in the log.
  const all = as === "needs-decision" && !refining && !proposal && !job.decision && job.step === "triage" ? (job.triage?.decisions ?? []).filter((d) => d.question.trim()) : [];
  const questions = all.length > 1 ? all : [];
  // On GitHub the questions are comments, which tell a person too. So are each triage round's draft and a proposed restructuring.
  const posted = as === "needs-decision" && (refining
    ? actions.postDraft !== undefined && (await draftOnHost(ctx, job))
    : actions.askQuestions !== undefined && (await askOnHost(ctx, job, proposal
      ? [{ question: `Proposed restructuring: ${proposal.reason}`, options: [], recommendation: "", proposal: { id: proposal.id, reason: proposal.reason, original: proposal.original, parts: proposal.parts, ...(proposal.carried ? { carried: proposal.carried } : {}) } }]
      : questions.length > 0 ? questions : [decision ?? { question: reason, options: [], recommendation: "" }])));
  if (!posted) {
    await ctx.act("put the item on a person's list", key, () => actions.answerTurn(job.item, ask, reason));
    for (const each of questions) {
      await ctx.act("write the question to the item's log", key, () =>
        actions.appendLog(job.item, "question", { question: each.question, options: each.options, ...(each.recommendation ? { recommendation: each.recommendation } : {}), ...(each.context ? { context: each.context } : {}), ...(each.multiSelect ? { multiSelect: true } : {}), parked: as }));
    }
    // The parts a restructuring has made so far stay in the store: the log line keeps what a person decides on.
    const fields: Record<string, unknown> = proposal
      ? { question: reason, proposal: { id: proposal.id, reason: proposal.reason, original: proposal.original, parts: proposal.parts, ...(proposal.carried ? { carried: proposal.carried } : {}) } }
      : decision
        ? { question: decision.question, options: decision.options, ...(decision.recommendation ? { recommendation: decision.recommendation } : {}), ...(decision.context ? { context: decision.context } : {}), ...(decision.multiSelect ? { multiSelect: true } : {}) }
        : { question: reason };
    fields.parked = as;
    if (refining) fields.refine = job.refine!.round;
    if (retry) fields.retry = retry;
    if (questions.length === 0) await ctx.act("write the question to the item's log", key, () => actions.appendLog(job.item, "question", fields));
  }
}

/** The parked state once its questions are posted: a post that was retried shows the parked state's own reason again. */
function postedParked(parked: NonNullable<Job["parked"]>): NonNullable<Job["parked"]> {
  if (parked.retry !== "post") return parked;
  const { retry: _retry, posting, ...rest } = parked;
  return { ...rest, as: "needs-decision", reason: posting ?? rest.reason };
}

/** What was posted, in order: each question's text and its number on the host. */
const textsOf = (questions: readonly { question: string }[], numbers: readonly number[] | undefined): AskedText[] =>
  questions.map((each, index) => ({ question: each.question.trim(), ...(numbers?.[index] ? { n: numbers[index] } : {}) }));

/**
 * Posts the questions the job parked on as comments on the item's host, written through. False when the item is not on
 * that host (the log line and a person's comment follow instead). A write that fails writes `orchestrator.host_write_failed`,
 * and the Item is parked as an escalation that says so: nothing is queued.
 */
async function askOnHost(ctx: Context, job: Job, questions: readonly (Decision & Pick<QuestionWrite, "proposal">)[]): Promise<boolean> {
  const key = refKey(job.item);
  const { actions } = ctx.deps;
  const asking = questions.map((each): QuestionWrite => ({
    question: each.question, options: each.options, ...(each.recommendation ? { recommendation: each.recommendation } : {}), ...(each.context ? { context: each.context } : {}), ...(each.multiSelect ? { multiSelect: true as const } : {}),
    parked: "needs-decision", step: job.step, ...(each.proposal ? { proposal: each.proposal } : {}),
  }));
  let asked: { ids: string[]; at: string; numbers?: number[] } | null;
  try {
    asked = await actions.askQuestions!(job.item, asking);
  } catch (error) {
    // A restructuring too large for a comment stays on Scope Soup's board, and the parked Item says so.
    if (error instanceof TooLarge) return keptLocal(ctx, job, "split", error.limit);
    await hostFailed(ctx, job, `the question${asking.length > 1 ? "s" : ""}`, error, `The question${asking.length > 1 ? "s were" : " was"}: ${asking.map((each) => each.question.trim()).join(" ")}`);
    return true;
  }
  if (!asked) return false;
  job.parked = { ...postedParked(job.parked!), questions: asked.ids, texts: textsOf(asking, asked.numbers), ...(asked.at ? { askedAt: asked.at } : {}) };
  ctx.commit("orchestrator.questions_asked", `Asked ${asked.ids.length} question${asked.ids.length > 1 ? "s" : ""} on ${job.item.host} (comment${asked.ids.length > 1 ? "s" : ""} ${asked.ids.join(", ")}); the answers are read from there.`, key, { questions: asked.ids });
  return true;
}

/** A draft or split over the comment limit is not posted: the parked state's reason says so, and a person's list and log take it as before. */
function keptLocal(ctx: Context, job: Job, what: "draft" | "split", limit: number = COMMENT_LIMIT): false {
  const note = `The ${what} is over ${limit.toLocaleString("en-GB")} characters, too large for a comment on ${job.item.host}: it stays on Scope Soup's board.`;
  job.parked = { ...job.parked!, reason: `${job.parked!.reason} ${note}` };
  ctx.commit("orchestrator.kept_local", note, refKey(job.item), { what });
  return false;
}

/**
 * A write to the item's host failed: `orchestrator.host_write_failed`, and the Item is parked as an escalation that says so. Nothing
 * is queued. A failure that can change by itself (`WriteLater`) is retried by each tick (`retryPost`), with no comment to the
 * people on the host that could not be written; the same failure again writes nothing more. A refusal stays a person's to answer.
 */
async function hostFailed(ctx: Context, job: Job, what: string, error: unknown, said: string): Promise<void> {
  const key = refKey(job.item);
  const problem = errorText(error);
  const was = job.parked!;
  const { retry: _retry, posting, ...rest } = was;
  if (error instanceof WriteLater) {
    const reason = `${job.item.host} could not be written: ${problem} ${said} Scope Soup tries again at each tick by itself; answer here to start again instead.`;
    if (was.retry === "post" && was.reason === reason) return;
    ctx.commit("orchestrator.host_write_failed", `Could not post ${what} on ${job.item.host}: ${problem} It is tried again at the next tick.`, key);
    job.parked = { ...rest, as: "escalated", reason, retry: "post", posting: posting ?? was.reason };
    ctx.commit(PARK_EVENT.escalated, reason, key, { step: job.step });
    return;
  }
  ctx.commit("orchestrator.host_write_failed", `Could not post ${what} on ${job.item.host}: ${problem}`, key);
  const reason = `${job.item.host} could not be written: ${problem} ${said} Answer here to start again.`;
  job.parked = { ...rest, as: "escalated", reason };
  ctx.commit(PARK_EVENT.escalated, reason, key, { step: job.step });
  await ctx.act("put the item on a person's list", key, () => ctx.deps.actions.answerTurn(job.item, "escalation", reason));
}

/**
 * Posts the triage round's draft as a comment on the item's host, then its questions as question comments that name
 * it. They are answered with the draft on the board (`POST /api/draft`) or by replies (`followDraft`). False when the item is
 * not on that host, or the draft is too large for a comment (then it stays on the board as before).
 */
async function draftOnHost(ctx: Context, job: Job): Promise<boolean> {
  const key = refKey(job.item);
  const { actions } = ctx.deps;
  const refine = job.refine!;
  let draft: { id: string; at: string } | null;
  try {
    draft = await actions.postDraft!(job.item, { round: refine.round, draft: refine.draft, ...(refine.labels ? { labels: refine.labels } : {}) });
  } catch (error) {
    if (error instanceof TooLarge) return keptLocal(ctx, job, "draft", error.limit);
    await hostFailed(ctx, job, `the draft of round ${refine.round}`, error, `The triage's draft (round ${refine.round}) waits on Scope Soup's board.`);
    return true;
  }
  if (!draft) return false;
  const id = draft.id;
  let ids: string[] = [];
  let numbers: number[] | undefined;
  let askedAt = "";
  if (refine.questions.length > 0) {
    try {
      const asked = await actions.askQuestions!(job.item, refine.questions.map((each): QuestionWrite => ({
        question: each.question, options: each.options, ...(each.recommendation ? { recommendation: each.recommendation } : {}), ...(each.context ? { context: each.context } : {}), ...(each.multiSelect ? { multiSelect: true as const } : {}),
        parked: "needs-decision", step: job.step, draft: id,
      })));
      ids = asked?.ids ?? [];
      numbers = asked?.numbers;
      askedAt = asked?.at ?? "";
    } catch (error) {
      await hostFailed(ctx, job, `the questions of round ${refine.round}`, error, `The triage's draft (round ${refine.round}) and its questions wait on Scope Soup's board.`);
      return true;
    }
  }
  job.parked = { ...postedParked(job.parked!), draft: { id, questions: ids, ...(ids.length > 0 ? { texts: textsOf(refine.questions, numbers) } : {}), ...(askedAt ? { askedAt } : {}) } };
  ctx.commit("orchestrator.draft_posted", `Posted the triage's draft of round ${refine.round} on ${job.item.host} (comment ${id})${ids.length > 0 ? ` with ${ids.length} question${ids.length > 1 ? "s" : ""}` : ""}.`, key, { draft: id, questions: ids });
  return true;
}

/**
 * A parked job whose question comments on the host were all answered (on the board or by an `An:` reply) is picked up
 * again, and the needs-decision label goes; one whose question comment was deleted is released, so the Item starts again at its
 * triage. True when the job was released.
 */
export async function followQuestions(ctx: Context, job: Job, item: WorkItem): Promise<boolean> {
  const settled = questionsSettled(job, item);
  if (!settled) return false;
  const key = refKey(job.item);
  const ids = job.parked?.questions ?? [];
  const texts = job.parked?.texts ?? [];
  const was = releaseIn(ctx.jobs, key, ACTOR, settled.withdrawn);
  if (!was) return false;
  ctx.commit("orchestrator.job_released", settled.reason, key, { was });
  const settle = ctx.deps.actions.settleQuestions;
  if (settled.withdrawn) await questionsDeleted(ctx, job.item, settled.gone.flatMap((id) => texts[ids.indexOf(id)] ?? []));
  else if (settle) await ctx.act("remove the needs-decision label", key, () => settle(job.item));
  return true;
}

/**
 * Question comments were deleted on the host, a person's "don't ask that": the host keeps them, so the triage that runs
 * again (and every later prompt) is told not to ask them, and Scope Soup's other open questions there are withdrawn. A failure is
 * `orchestrator.host_write_failed`; the triage runs again all the same. Then the needs-decision label goes, unless the
 * Item still waits for an answer.
 */
async function questionsDeleted(ctx: Context, item: Ref, deleted: AskedText[]): Promise<void> {
  const withdraw = ctx.deps.actions.withdrawQuestions;
  if (!withdraw) return;
  try {
    await withdraw(item, deleted);
  } catch (error) {
    ctx.commit("orchestrator.host_write_failed", `Could not keep the deleted question${deleted.length === 1 ? "" : "s"} on ${item.host} or withdraw the other open ones: ${errorText(error)}`, refKey(item));
    return;
  }
  const settle = ctx.deps.actions.settleQuestions;
  if (settle) await ctx.act("remove the needs-decision label", refKey(item), () => settle(item));
}

/**
 * The draft's question comments answered on the host by trusted `An:` / `A:` replies, as answers on the board count. All
 * the recommendations: the draft waits for Accept, Edit or Reject on the board, and the needs-decision label stays until
 * then. Any other answer:
 * the triage runs again with the answers, a new round. A deleted question comment un-parks the Item, and the Item starts
 * again at its triage. True when the job left its parked state.
 */
export async function followDraft(ctx: Context, job: Job, item: WorkItem): Promise<boolean> {
  const posted = job.parked?.draft;
  const refine = parkedDraft(job);
  if (!posted || posted.answered || posted.questions.length === 0 || !refine) return false;
  if (posted.askedAt && Date.parse(item.updatedAt) < Date.parse(posted.askedAt)) return false;
  const key = refKey(job.item);
  const open = new Set((item.openQuestions ?? []).map((question) => question.id));
  const given = posted.questions.map((id) => (item.answers ?? []).find((answer) => answer.to === id));
  const gone = posted.questions.flatMap((id, index) => (!open.has(id) && !given[index] ? [posted.texts?.[index] ?? { question: refine.questions[index]?.question ?? "" }] : []));
  if (gone.length > 0) {
    const was = releaseIn(ctx.jobs, key, ACTOR, true);
    if (!was) return false;
    ctx.commit("orchestrator.job_released", `A question comment of the triage's draft (round ${refine.round}) was deleted on ${job.item.host}: the Item is no longer parked, and it starts again at its triage.`, key, { was });
    await questionsDeleted(ctx, job.item, gone.filter((each) => each.question.trim()));
    return true;
  }
  if (given.some((answer) => !answer)) return false;
  const answers = given.map((answer) => answer!.answer);
  const settle = ctx.deps.actions.settleQuestions;
  if (keepsRecommendations(refine, answers)) {
    job.parked = { ...job.parked!, draft: { ...posted, answered: true } };
    ctx.commit("orchestrator.draft_questions_answered", `The questions of the triage's draft (round ${refine.round}) were answered on ${job.item.host} with the recommendations: the draft waits for a person to accept, edit or reject it.`, key, { round: refine.round });
    return false;
  }
  const changed = refine.questions.map((question, index) => ({ question, answer: answers[index]! })).filter((each) => !picks(each.answer, each.question.recommendation));
  delete job.parked;
  delete job.notBefore;
  delete job.refine;
  job.failures = 0;
  ctx.commit("orchestrator.draft_answered", `Answered on ${job.item.host} otherwise than recommended in round ${refine.round} of the triage (${changed.map((each) => `${each.question.question} Answered: ${each.answer}`).join(" ")}); the triage runs again with the answers.`, key, { round: refine.round });
  if (settle) await ctx.act("remove the needs-decision label", key, () => settle(job.item));
  return true;
}

/** A tool was refused (read from the session's result): not a question for a person, but a setting only a person can change. */
function parkTools(ctx: Context, job: Job, who: string, refused: string): Promise<void> {
  const role = job.step;
  const program = providerFor(ctx.config, role).refusedProgram(refused, ctx.config.roles[role].allowedTools);
  const advice = program
    ? `\`${program}\` is already allowed for the ${role} role, so what was refused was the shape of the command, not the program (a \`$(...)\`, heredoc, backtick, pipe, \`&&\` or \`;\` is not matched by the allowed form). The allowedTools do not need to change; answer here to try again with one plain command per call (a commit message goes in a file, then \`git commit -F <file>\`).`
    : `Add the command to allowedTools of the ${role} role in the project's configuration, then answer here to try again.`;
  return parkByStep(
    ctx, job, "escalated",
    `The ${who} could not finish because a tool was refused: ${refused || "no command named"}. ${advice}`,
    "escalation",
  );
}

/** Parks the item for a reason the implement step itself raised: an answer resumes that step (`resumesStep`). */
function parkByStep(ctx: Context, job: Job, as: ParkedAs, reason: string, ask: Parameters<Actions["answerTurn"]>[1]): Promise<void> {
  return park(ctx, job, as, reason, ask, undefined, true);
}

/**
 * A question about a decision a person already answered, on an item whose text has not changed since (triage rewords its
 * questions, so the match is on the options or the subject, not the exact text). The recorded answer is taken as the reply,
 * the reuse is recorded as an event, and a person is not asked again. The answer already goes to every session in its prompt.
 */
async function reuseAnswer(ctx: Context, job: Job, item: WorkItem | null, decision: Decision, who: string): Promise<boolean> {
  if (!item) return false;
  const found = reusableAnswer(knownAnswers(ctx.deps.store), item, decision);
  if (!found) return false;
  const key = refKey(job.item);
  ctx.commit("orchestrator.answer_reused", `The ${who} asked again: ${decision.question.trim()} The answer of ${found.at} is reused: ${found.answer}`, key, { answeredAt: found.at });
  return true;
}

/** How many times a recorded answer is reused for an implementer's question on one item, so a step cannot loop. */
const MAX_REUSED = 3;

/**
 * An implementer stopped with a question. A question a person already answered on the unchanged item is
 * answered from the record and the same step runs again; any other is parked for a person, with the options on the item page.
 * Scope Soup never takes a recommended option itself: whatever the risk, a person decides.
 */
async function ask(ctx: Context, job: Job, who: string, decision: Decision | undefined, fallback: string, item: WorkItem | null): Promise<void> {
  const question = decision?.question.trim() ? decision : undefined;
  if (question && (job.reusedAnswers ?? 0) < MAX_REUSED && (await reuseAnswer(ctx, job, item, question, who))) {
    job.reusedAnswers = (job.reusedAnswers ?? 0) + 1;
    return next(ctx, job, job.step, `The ${who} asked a question a person has answered; the answer is in its prompt. Next: ${job.step} again.`);
  }
  if (question) job.decision = question;
  const text = question
    ? `${question.question} Options: ${question.options.map(optionText).join(" | ") || "none given"}. Recommended: ${question.recommendation || "nothing"}.`
    : `The ${who} stopped: ${fallback || "no reason given"}`;
  return parkByStep(ctx, job, "needs-decision", text, "decision");
}

/**
 * Triage proposes to restructure the item: parked until a person accepts, edits or rejects it. A part into an existing Item is
 * named by that Item's id here when the store knows it. The answers recorded on the item so far are carried over into each new part.
 */
function parkRestructure(ctx: Context, job: Job, proposed: NonNullable<TriageAnswer["restructure"]>, why: string | undefined): Promise<void> {
  // A person's decisions, not their verdicts on earlier proposals (a rejected restructuring or rewrite says nothing about a part).
  const answers = knownAnswers(ctx.deps.store).filter((answer) => !/^Proposed (split|rewrite|restructuring): /.test(answer.question ?? ""));
  const carried = answersText(answers, refKey(job.item));
  const parts = proposed.parts.map((part) => {
    const named = part.goes === "into" ? linkedItem(ctx, job.item, part.into!) : null;
    return named ? { ...part, into: named.ref.id } : part;
  });
  const reason = `Triage proposes to restructure the Item: ${restructuringWords(proposed.original, parts)}.${proposed.reason ? ` ${proposed.reason}` : ""}${why?.trim() ? ` ${why.trim()}` : ""}`;
  job.proposal = { id: restructuringId(job.item, ctx.at), reason, original: proposed.original, parts, ...(carried ? { carried } : {}) };
  return park(ctx, job, "needs-decision", `${reason} Accept, edit or reject it on the item page.`, "decision");
}

/**
 * Sends the change back to the implementor: its own agent session is resumed with `message` (review findings, a failed
 * merging), so it keeps its context. Without a known session the implement step starts afresh with the message after its prompt.
 */
function backToImplementor(ctx: Context, job: Job, message: string, reason: string): void {
  const key = refKey(job.item);
  // A person's overturns kept for the work go with it, and are taken out of the list in the same transaction.
  const overturns = handable(ctx, job);
  ctx.deps.store.tx(() => {
    if (overturns.length > 0) {
      dropOverturns(ctx.deps.store, key, overturns.map((each) => each.id));
      job.overturned = [...(job.overturned ?? []), ...overturns.map((each) => each.id)].slice(-100);
    }
    job.resumeWith = overturns.length > 0 ? [message, overturnMessage(overturns)].filter(Boolean).join("\n") : message;
    next(ctx, job, "implement", overturns.length > 0 ? `${reason} A person's overturn of ${overturns.length === 1 ? "a decision" : `${overturns.length} decisions`} goes with it.` : reason);
  });
}

/**
 * A person's overturns kept for the job's work and not handed to it yet. None for an Item that is done or gone: its
 * job closes, and the tick files the new Item an Overturn after merging files (`overturnsMerged`).
 */
function handable(ctx: Context, job: Job): PendingOverturn[] {
  const item = ctx.deps.store.get<WorkItem>(job.item);
  if (!item || item.state === "done" || item.state === "abandoned") return [];
  return overturnsFor(ctx.deps.store, refKey(job.item)).filter((each) => !(job.overturned ?? []).includes(each.id));
}

/**
 * A person overturned decisions while the change has not merged: the implementor's own session is resumed with the answers
 * before the next step (review, a hand-over, or the implement step that waits), as review findings are (decision 57). An implement
 * step that waits keeps what it was to be told and gets the answers after it. True when it went back.
 */
export function overturnsBack(ctx: Context, job: Job): boolean {
  const pending = handable(ctx, job);
  if (pending.length === 0) return false;
  const waiting = job.step === "implement" && !job.merge ? job.resumeWith ?? "" : "";
  // What the reviewer approved is not what a person wants: the change goes through review again before it is merged.
  delete job.merge;
  backToImplementor(ctx, job, waiting, `A person overturned ${pending.length === 1 ? "a decision" : `${pending.length} decisions`} the implementor took itself while the change has not merged. Next: the implementor's own session changes the work to match, before review.`);
  return true;
}

/** The step succeeded; the next one starts after the short continuation delay. */
function next(ctx: Context, job: Job, step: Job["step"], reason: string): void {
  job.step = step;
  job.failures = 0;
  delete job.sessionId;
  delete job.resume;
  job.notBefore = later(ctx.at, CONTINUE_MS);
  ctx.commit("orchestrator.step", reason, refKey(job.item), { next: step });
}

/** The step failed: retry with backoff, or give the item to a person when the attempts are used up. */
async function failed(ctx: Context, job: Job, why: string, byStep = true): Promise<void> {
  job.failures++;
  delete job.sessionId;
  delete job.resume;
  // A resumed implementor that failed may have failed because of the resume (a lost session): the next attempt starts afresh.
  if (job.step === "implement" && job.resumeWith) delete job.agentSession;
  const max = persistenceLimits(ctx.config.settings.persistence.value).maxAttempts;
  if (job.failures >= max) {
    const reason = `The ${job.step} step failed ${job.failures} times; the limit is ${max}. Last failure: ${why}`;
    if (byStep) await parkByStep(ctx, job, "escalated", reason, "escalation");
    else await park(ctx, job, "escalated", reason, "escalation");
    return;
  }
  const delay = backoffMs(job.failures, ctx.config.settings.retryBackoffCapSeconds.value * 1000);
  job.notBefore = later(ctx.at, delay);
  ctx.commit(
    "orchestrator.retry_scheduled",
    `The ${job.step} step failed (${job.failures} of ${max}): ${why} Trying again in ${Math.round(delay / 1000)} s.`,
    refKey(job.item),
    { failures: job.failures, notBefore: job.notBefore },
  );
}

/**
 * The item's work is not on its branch (no commits over the main branch, or no clone has it): it is
 * neither reviewed nor merged, but implemented again. The reason goes into the event.
 */
export function backToImplement(ctx: Context, job: Job, reason: string): void {
  job.step = "implement";
  job.failures = 0;
  delete job.sessionId;
  delete job.resume;
  delete job.owes;
  delete job.head;
  // The work is gone: a new implementor starts from the Item, not from findings on work that is not there.
  delete job.resumeWith;
  delete job.agentSession;
  delete job.merge;
  delete job.base;
  delete job.sentBack;
  // The decisions were about work that is gone.
  delete job.taken;
  job.notBefore = later(ctx.at, CONTINUE_MS);
  ctx.commit("orchestrator.back_to_implement", `${reason} Nothing is reviewed or merged; next: implement.`, refKey(job.item), { next: "implement" });
}

/** Null when the item's branch has commits over the main branch (or the runner cannot tell), else why not. */
export async function emptyBranch(ctx: Context, job: Job): Promise<string | null> {
  const { runner } = ctx.deps;
  if (!runner.commitsAhead) return null;
  let ahead: number;
  try {
    ahead = await runner.commitsAhead(job.branch);
  } catch (error) {
    return `The branch ${job.branch} could not be read (${errorText(error)}), so the item's work is not there.`;
  }
  return ahead > 0 ? null : `The branch ${job.branch} has no commits over ${ctx.config.mainBranch}, so there is no change to review or merge.`;
}

/**
 * The change is built: from level 3 (Review) it goes to review, else it is handed over. At level 2 the implementor merged it
 * itself (or opened a pull request), so the hand-over looks at what it did.
 */
export async function afterBuild(ctx: Context, job: Job, item: WorkItem | null): Promise<void> {
  if (ctx.config.level >= 3) {
    delete job.merge;
    if (await fenced(ctx, job)) return;
    return next(ctx, job, "review", "Built. Next: review by another model.");
  }
  return handOver(ctx, job, item);
}

/** A list of paths for a sentence: the first `max`, then how many more. */
function pathList(paths: readonly string[], max: number): string {
  return paths.length > max ? `${paths.slice(0, max).join(", ")} and ${paths.length - max} more` : paths.join(", ");
}

const FENCE_CUT = "Cut it back";
const FENCE_GO = "Go on as it is";

/**
 * The fence, before review. The program compares the branch's real change (its paths and changed lines) with the first
 * look's `paths` and `size` (`core/fence.ts`). A change well beyond them parked for a person with a report and a proposed split;
 * the answer resumes the implementor with it, and what that person saw widens the fence. True when it was parked. No triage, or
 * one that named no paths: the fence does not apply. A change that cannot be read is an event, and the change goes on.
 */
async function fenced(ctx: Context, job: Job): Promise<boolean> {
  const look = job.triage;
  if (!look || look.paths.every((path) => !path.trim())) return false;
  const { runner } = ctx.deps;
  const key = refKey(job.item);
  let change: ChangedFile[];
  try {
    change = runner.changeStat ? await runner.changeStat(job.branch) : (await runner.changedPaths(job.branch)).map((path) => ({ path }));
  } catch (error) {
    ctx.say("orchestrator.fence_unread", `The fence could not read what ${job.branch} changes (${errorText(error)}); it goes on to review unchecked.`, key);
    return false;
  }
  const breach = fenceBreach(look.size, look.paths, change, job.fence);
  if (!breach) return false;
  const beyond = [
    ...(breach.tooWide ? [`${breach.outside.length} changed files are outside the paths its triage named (${FENCE_OUTSIDE_FILES} are allowed): ${pathList(breach.outside, 10)}.`] : []),
    ...(breach.tooLarge ? [`It changes ${breach.lines} lines, ${(breach.lines! / breach.limit).toFixed(1)} times the ${breach.limit} a ${look.size} Item is held to.`] : []),
  ];
  const report = `This grew beyond the Item. ${beyond.join(" ")} The triage said ${look.size} and named: ${pathList(look.paths, 8)}.`;
  const split = proposedSplit(breach, change).map((part, index) => `${index + 1}. ${part.label}: ${pathList(part.files, 6)}${part.lines !== undefined ? ` (${part.lines} lines)` : ""}.`).join(" ");
  job.fence = { paths: change.map((file) => file.path), ...(breach.lines !== undefined ? { lines: breach.lines } : {}) };
  job.decision = {
    question: "This change grew beyond the Item: cut it back to what its triage named, or let it go on to review as it is?",
    options: [
      { label: FENCE_CUT, description: "The implementor takes the changes beyond the triage's paths and size out of this branch and says what they were; a person files them as a new Item, as the proposed split says." },
      { label: FENCE_GO, description: "The change goes on to review as it is; the fence takes its present extent as the Item's." },
    ],
    recommendation: FENCE_CUT,
    context: `${report} Proposed split: ${split}`,
  };
  job.resumeWith = `Scope Soup stopped the change before review. ${report} Proposed split: ${split} A person was asked whether to cut it back or let it go on; do as their answer below says, commit, and answer done.`;
  ctx.commit("orchestrator.fenced", report, key, { outside: breach.outside.length, ...(breach.lines !== undefined ? { lines: breach.lines } : {}), limit: breach.limit });
  await parkByStep(ctx, job, "needs-decision", `${report} Proposed split: ${split} Options: ${FENCE_CUT} | ${FENCE_GO}. Recommended: ${FENCE_CUT}.`, "decision");
  return true;
}

/** Level 3: the reviewer approved, so the implementor merges it, in its own session when that can be resumed. */
const APPROVED = "Approved. Merge now as CLAUDE.md says.";

/**
 * The change is built (level 2), approved and merged (level 3), or reviewed (level 4). Below level 4 Scope Soup merges nothing: the
 * implementing session merged it (or opened a pull request), and the hand-over checks what it did. At level 4 it goes
 * to the merge queue, which merges the newest main in, runs the check and pushes the checked commit fast-forward.
 */
async function handOver(ctx: Context, job: Job, item: WorkItem | null, askedBy?: string): Promise<void> {
  // This is the hand-over that was owed, if one was: whatever happens now, it is not owed any more unless said again below.
  delete job.owes;
  if (ctx.config.level < 4) return sessionMerged(ctx, job, item, askedBy);
  const { runner } = ctx.deps;
  const empty = await emptyBranch(ctx, job);
  if (empty) return backToImplement(ctx, job, empty);
  let paths: string[];
  try {
    paths = await runner.changedPaths(job.branch);
  } catch (error) {
    await failed(ctx, job, `Could not read what the branch changes: ${errorText(error)}`, false);
    return;
  }
  if (paths.length === 0) {
    await failed(ctx, job, `The agent reported the work done, but ${job.branch} changes nothing.`, false);
    return;
  }
  // The revision the queue sent back is never handed to it again: the implementor's fix round comes first.
  const head = job.sentBack ? await headOf(ctx, job) : null;
  if (head && head === job.sentBack) {
    job.resumeWith ??= "The merge queue sent this revision back. Fix what it found and commit.";
    next(ctx, job, "implement", `${job.branch} is still at ${head.slice(0, 7)}, the revision the merge queue sent back; it is not handed to the queue again. Next: the implementor fixes it.`);
    return;
  }
  if (!mergeQueueOn(ctx.deps.store)) {
    job.owes = "hand-over";
    // The session is over: the tick hands it over by itself once the merge queue is resumed, and settles nothing again meanwhile.
    delete job.sessionId;
    delete job.resume;
    ctx.commit("orchestrator.merge_queue_paused", `The merge queue is paused: ${job.branch} is not handed to the queue now; it is when the merge queue is resumed.`, refKey(job.item));
    return;
  }
  return handOverToQueue(ctx, job);
}

/** The branch's head, or null when it cannot be read. */
async function headOf(ctx: Context, job: Job): Promise<string | null> {
  try {
    return await ctx.deps.runner.head(job.branch);
  } catch {
    return null;
  }
}

/** Where a change handed to a person is, and what they do to merge it. */
export function whereIsIt(remote: string, branch: string, change: Ref | null, repo: string | null): string {
  if (change) return `Merge pull request ${change.id}.`;
  const at = repo ? `in the clone ${repo}` : "in one of the pool's clones (the item's record says which)";
  const push = repo ? ` To get it merged, run: git -C "${repo}" push ${remote} ${branch} and open a pull request from it, or merge it by hand.` : ` Push it from there with: git push ${remote} ${branch}, then open a pull request from it, or merge it by hand.`;
  return `Scope Soup opens no pull request, so the branch exists only ${at}.${push}`;
}

/** A link to a pull request the session says it opened: an http(s) URL with no spaces, as it gave it. */
export function pullRequestIn(merged: string | undefined): string | null {
  const text = merged?.trim();
  return text && text.length <= 300 && /^https?:\/\/[^\s<>"'`]+$/.test(text) ? text : null;
}

/**
 * Levels 2 and 3: the implementor said it is done, and at these levels it merges the change itself the way the
 * project's CLAUDE.md says, or opens a pull request. Scope Soup does not take its word: it fetches the remote's main, and the Item
 * is done when main contains the branch head (`merged` is written as a merge writes it). A pull request named in the answer
 * is a hand-over with that link. Anything else is parked for a person with the reason, so nothing is lost silently.
 * After a person's answer to that (`askedBy`), a branch still not merged goes on as the level says (`afterAnswer`).
 */
async function sessionMerged(ctx: Context, job: Job, item: WorkItem | null, askedBy?: string): Promise<void> {
  const { runner, actions } = ctx.deps;
  const key = refKey(job.item);
  const main = ctx.config.mainBranch;
  const name = `${ctx.config.remote}/${main}`;
  const said = job.implement?.mergedAs;
  let tip: string;
  let head: string;
  let contains: boolean | null;
  let onBase: boolean | null = false;
  let squash: string | null = null;
  try {
    tip = (await runner.fetchMain(job.branch)).main;
    head = await runner.head(job.branch);
    contains = await runner.contains(job.branch, head, tip);
    if (job.base) onBase = await runner.contains(job.branch, head, job.base);
    // Main does not contain the head, but the session names a commit: a squash merge, when that commit is on main, new since the
    // work started, and carries the branch's files as the head has them.
    if (contains !== true && said && job.base && onBase !== true && runner.squashed) squash = await runner.squashed(job.branch, said, job.base, head, tip);
  } catch (error) {
    await park(ctx, job, "escalated", `The implementor said ${job.branch} is done, but Scope Soup could not read whether ${name} contains it: ${errorText(error)} Answer here to look again.`, "escalation", "hand-over");
    return;
  }
  // The head was in main before the work started: nothing was committed, whatever the answer says.
  if (onBase === true) {
    await failed(ctx, job, `The implementer reported the work done, but ${job.branch} has no commits over ${name} as it was when the work started (${job.base!.slice(0, 7)}).`);
    return;
  }
  await writeRevision(ctx, job);
  const merged = contains === true ? head : squash;
  if (merged) {
    job.merged = merged;
    const how = contains === true
      ? `${name} at ${tip.slice(0, 7)} contains its head ${head.slice(0, 7)}`
      : `${name} at ${tip.slice(0, 7)} contains ${merged.slice(0, 7)}, a squash of its head ${head.slice(0, 7)} (the same files, new since ${job.base!.slice(0, 7)})`;
    ctx.commit(
      "orchestrator.merged",
      `${job.branch} is merged: ${how}. The implementing session merged it${said ? ` (it says: ${clipText(said, 200)})` : ""}.`,
      key, { sha: merged, main: tip, by: "session", ...(contains === true ? {} : { squashed: head }) },
    );
    await ctx.act("write the merge to the item's log", key, () => actions.appendLog(job.item, "merged", { sha: merged, target: main }));
    await park(ctx, job, "queued", `Merged to ${main} by the implementing session: ${name} contains ${merged.slice(0, 7)}.`);
    await closeMerged(ctx, job, merged);
    return;
  }
  const pr = pullRequestIn(said);
  if (pr) {
    await park(ctx, job, "handed-over", `The implementing session opened a pull request instead of merging: ${pr} . ${name} does not contain ${job.branch} yet; merging the pull request is a person's call.`, "handover");
    return;
  }
  if (askedBy) return afterAnswer(ctx, job, name, askedBy);
  const where = (item ? itemRepository(ctx.deps.store, ctx.config, item.ref) : null) ?? (ctx.config.workspaces.kind === "pool" ? null : ctx.config.repoPath);
  await park(
    ctx, job, "escalated",
    `The implementor said the work is done, but ${name} (at ${tip.slice(0, 7)}) does not contain ${job.branch} (at ${head.slice(0, 7)}), and its answer names no pull request${said ? ` (it said: ${clipText(said, 200)})` : ""}. The change is not lost: ${whereIsIt(ctx.config.remote, job.branch, null, where)} Answer here once it is merged, and Scope Soup looks again.`,
    "escalation", "hand-over",
  );
}

/**
 * A person answered the escalation of a change the implementor said is done and did not merge, and main still does not contain it.
 * At level 2, and at level 3 once the reviewer approved, the implementor merges: its own session is resumed with the answer (the
 * person's answers go with the message). At level 3 before an approval (it was built at level 2), review comes first.
 */
function afterAnswer(ctx: Context, job: Job, name: string, askedBy: string): void {
  const what = `${name} does not contain ${job.branch} yet, and ${askedBy} answered`;
  if (ctx.config.level === 3 && job.merge !== true) {
    next(ctx, job, "review", `${what}. At level 3 a reviewer looks at the change before it is merged. Next: review.`);
    return;
  }
  backToImplementor(
    ctx, job,
    `A person answered your question about merging; their answer is below. Do as it says, then merge it to ${ctx.config.mainBranch} and push the way CLAUDE.md says (or open a pull request if it says so).`,
    `${what}. At level ${ctx.config.level} the implementor merges it. Next: the implementor's own session goes on with the answer.`,
  );
}

/**
 * Level 2 and a job at the review step (the level was lowered while it waited for a reviewer): nobody reviews at level 2, and the
 * implementor merges. Its own session is resumed to merge it, as level 2 does after a build.
 */
export function reviewOffAtLevel2(ctx: Context, job: Job): void {
  backToImplementor(
    ctx, job,
    `Nobody reviews at this level now. If the work is done, merge it to ${ctx.config.mainBranch} and push the way CLAUDE.md says (or open a pull request if it says so).`,
    `${job.branch} waited at the review step, but the project is at level 2, where nobody reviews and the implementor merges. Next: the implementor's own session merges it.`,
  );
}

/** The merging failed in a way the change itself must fix: back to the implementor with the reason, within the review rounds. */
export async function sendBack(ctx: Context, job: Job, finding: string, what: string, failure?: string): Promise<void> {
  const max = persistenceLimits(ctx.config.settings.persistence.value).maxFixRounds;
  if (job.fixRounds >= max) {
    await park(ctx, job, "escalated", `${what} after ${job.fixRounds} round(s) back to the implementor; the limit is ${max}. Nothing was pushed. ${finding}`, "escalation");
    return;
  }
  // The same failing check (or conflict) as at the merge before: the same failure twice in a row ends the run.
  if (failure && job.progress?.mergeQueue === failure) {
    await park(ctx, job, "escalated", `${what}, the same failure as at the merge before. The same failure twice in a row ends the run. Nothing was pushed. ${finding}`, "escalation");
    return;
  }
  if (failure) job.progress = { ...job.progress, mergeQueue: failure };
  // The change goes back to its implementor: no hand-over is owed until a new revision is reviewed.
  delete job.owes;
  job.fixRounds++;
  job.review = { verdict: "changes", findings: [{ severity: "must", text: finding }] };
  backToImplementor(ctx, job, `Merging failed: ${finding}\nFix it and commit.`, `${what}; nothing was pushed. Next: the implementor fixes it, round ${job.fixRounds} of ${max}.`);
}

const clipText = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars - 3)}...` : text);

/** A `revision` line when the branch has a new head (meta branch). Needs the runner's `head`. */
async function writeRevision(ctx: Context, job: Job): Promise<void> {
  const { runner, actions } = ctx.deps;
  await ctx.act("write the revision to the item's log", refKey(job.item), async () => {
    const sha = await runner.head(job.branch);
    if (sha === job.head) return;
    job.head = sha;
    await actions.appendLog(job.item, "revision", { sha, branch: job.branch });
  });
}

/** A `review` line on the head the reviewer saw. */
async function writeReview(ctx: Context, job: Job, answer: ReviewAnswer): Promise<void> {
  const { runner, actions } = ctx.deps;
  await ctx.act("write the review to the item's log", refKey(job.item), async () => {
    const sha = job.head ?? (await runner.head(job.branch));
    const pass = answer.verdict === "approve" && !answer.findings.some((finding) => finding.severity === "must");
    const findings = answer.findings.slice(0, 20).map((finding) => clipText(`[${finding.severity}]${finding.file ? ` ${finding.file}:` : ""} ${finding.text}`, 600));
    await actions.appendLog(job.item, "review", { sha, verdict: pass ? "pass" : "fail", findings, model: ctx.config.roles.review.model });
  });
}

/**
 * A `session` line when a session is over: what it was, how it ended, and `next`, the step the
 * item goes to now (none when it is parked or only its hand-over is owed). A restart reads `next` back.
 */
async function writeSession(ctx: Context, job: Job, session: Session, record: SessionResultRecord): Promise<void> {
  const after = ctx.jobs[refKey(job.item)];
  const output = (typeof record.output === "object" && record.output !== null ? record.output : {}) as Record<string, unknown>;
  const triage = session.role === "triage" && session.status === "succeeded" && typeof output.ready === "boolean";
  const summary =
    // An answer refused for its markup: the markup is not written to the host.
    typeof output.summary === "string" && hasMarkup(output.summary) ? "The answer had tool-call markup inside its summary and was not taken."
    : typeof output.summary === "string" && output.summary.trim() ? output.summary
    : typeof output.verdict === "string" ? `${output.verdict}, ${Array.isArray(output.findings) ? output.findings.length : 0} finding(s)`
    : triage ? triageWords(output)
    // A failed setup's line says where and how, never its output (it is on the board, on this machine).
    : session.setupFailed ? setupHostText(ctx, session)
    : session.endReason ?? "";
  const fields: Record<string, unknown> = {
    role: session.role,
    ...(session.model ? { model: session.model } : {}),
    outcome: session.status,
    summary: clipText(summary, 4000),
    ...(session.finishedAt ? { durationMs: Math.max(0, Date.parse(session.finishedAt) - Date.parse(session.startedAt)) } : {}),
    // The session, which links the step to its cost, stream and chat; and the cost, for a machine whose store lacks it.
    sessionId: session.ref.id,
    ...(typeof session.costUsd === "number" && Number.isFinite(session.costUsd) ? { costUsd: Math.round(session.costUsd * 10_000) / 10_000 } : {}),
  };
  if (triage) fields.ready = output.ready;
  if (after && !after.parked && !after.owes) fields.next = after.step;
  if (output.size === "small" || output.size === "medium" || output.size === "large") fields.size = output.size;
  await ctx.act("write the session to the item's log", refKey(job.item), () => ctx.deps.actions.appendLog(job.item, "session", fields));
}

/** A triage's verdict in a sentence, for its `session` line (its answer has no summary of its own). */
function triageWords(output: Record<string, unknown>): string {
  const size = typeof output.size === "string" ? `, ${output.size}` : "";
  const reason = typeof output.notReadyReason === "string" && output.notReadyReason.trim() ? ` ${output.notReadyReason.trim()}` : "";
  const asked = Array.isArray(output.decisions) ? output.decisions.length : output.decision ? 1 : 0;
  const restructure = typeof output.restructure === "object" && output.restructure !== null ? output.restructure as Record<string, unknown> : {};
  const parts = Array.isArray(restructure.parts) ? restructure.parts.length : 0;
  return [
    output.ready ? `Ready${size}.` : `Not ready${size}.${reason}`,
    ...(asked > 0 ? [`${asked} question${asked === 1 ? "" : "s"} for a person.`] : []),
    ...(parts > 0 ? [`Proposes a restructuring into ${parts} parts.`] : []),
  ].join(" ");
}

/** A failed setup as it may leave the machine: the folder and the outcome, without the output. */
function setupHostText(ctx: Context, session: Session): string {
  return setupFailedText(session.cwd ?? "the Item's workspace", session.setupOutcome ?? "it failed", ctx.config.machineName);
}

/** Called once for a job whose session is over. `main`: where the remote's main is, read right after the session. */
export async function settle(ctx: Context, job: Job, session: Session | null, record: SessionResultRecord, item: WorkItem | null, main?: string | null): Promise<void> {
  await settleStep(ctx, job, session, record, item, main);
  if (session) await writeSession(ctx, job, session, record);
}

async function settleStep(ctx: Context, job: Job, session: Session | null, record: SessionResultRecord, item: WorkItem | null, main?: string | null): Promise<void> {
  const key = refKey(job.item);
  if (!session) {
    await failed(ctx, job, "The session's record is missing from the store.");
    return;
  }

  if (session.status === "limit") {
    job.notBefore = record.resumeAt ?? later(ctx.at, 30 * 60_000);
    job.resume = session.agentSessionId;
    delete job.sessionId;
    ctx.commit("orchestrator.limit", `The ${job.step} session was cut off by the usage limit. It is resumed after ${job.notBefore}.`, key, { notBefore: job.notBefore });
    return;
  }
  if (session.status === "cancelled") {
    job.notBefore = later(ctx.at, CONTINUE_MS);
    job.resume = session.agentSessionId;
    delete job.sessionId;
    ctx.commit("orchestrator.interrupted", `The ${job.step} session was stopped (${session.endReason ?? "no reason recorded"}). It continues when work may start again; this is not counted as a failure.`, key);
    return;
  }
  // The setup failed, so no agent ran: the Item parked for a person with the setup's reason, not counted against the step.
  // The reason goes to the host (a comment, the item's log), so it never carries the setup's output (`setupHostText`).
  if (session.setupFailed) {
    await park(
      ctx, job, "escalated",
      `${setupHostText(ctx, session)} This is the project's setup, not the agent's work, and it is not counted as a failed attempt. Fix the setup (setupCommand on the Settings page, or the setup script it runs) and answer here to try again.`,
      "escalation",
    );
    return;
  }
  if (session.status !== "succeeded") {
    await failed(ctx, job, session.endReason ?? `The session ended as "${session.status}".`);
    return;
  }

  // Fields the model ran into a string as tool-call markup are taken out first; markup that is left makes the answer malformed.
  // The session line on the host is written from the same answer, so it never carries the markup.
  const repaired = recoverFields(record.output);
  if (repaired.recovered.length > 0) {
    record.output = repaired.value;
    ctx.commit("orchestrator.answer_repaired", `The ${job.step} answer had ${repaired.recovered.join(", ")} run into another field as tool-call markup; taken out and read as part of the answer.`, key, { fields: repaired.recovered });
  }

  if (job.step === "triage") {
    const answer = asTriage(record.output);
    if (!answer) return failed(ctx, job, `The triage answer does not have the expected shape, has tool-call markup inside a string, or gives no reason for "not ready" or no question for "needs decision". The answer was: ${JSON.stringify(record.output ?? null).slice(0, 4000)}`);
    job.triage = answer;
    keepAboutOthers(ctx, job, "triage", answer.aboutOthers);
    keepDrafts(ctx, job, "triage", answer.drafts);
    // What this triage saw, so it is taken again once that is out of date.
    const text = job.triaging ?? (item ? triagedText(item) : undefined);
    if (text) job.triaged = triagedNow(text, item, ctx.deps.store.list<WorkItem>("work"), ctx.at, main);
    delete job.triaging;
    delete job.recheck;
    // An answer with a draft goes through the refinement loop. One without (from earlier) is settled as before.
    if (answer.draft !== undefined) return triage(ctx, job, answer, item);
    const decision = answer.decision;
    // Counted as park and jobQuestions count: only decisions with a question (asTriage already drops blank ones).
    const asked = (answer.decisions ?? []).filter((d) => d.question.trim());
    const several = asked.length > 1;
    // Every decision goes to a person, whatever the risk and whether a recommendation is given (core rule 5).
    // With several a person is asked all of them; only a single one is answered from a recorded answer.
    if (answer.hidesDecision && (several || !(decision?.question.trim() && (await reuseAnswer(ctx, job, item, decision, "triage"))))) {
      const text = several
        ? `Triage found ${asked.length} decisions for a person before the work can start: ${asked.map((d, i) => `${i + 1}. ${d.question}`).join(" ")}`
        : decision
        ? `${decision.question} Options: ${decision.options.map(optionText).join(" | ") || "none given"}. Recommended: ${decision.recommendation || "nothing"}.`
        : "Triage found a decision only a person may make, and did not say which.";
      return park(ctx, job, "needs-decision", text, "decision");
    }
    return afterTriage(ctx, job, answer);
  }

  if (job.step === "implement") {
    const answer = asImplement(record.output);
    // The implementor's own session: findings and merging failures resume it.
    if (session.agentSessionId) job.agentSession = session.agentSessionId;
    if (!answer) return failed(ctx, job, "The implementer's answer does not have the expected shape, or has tool-call markup inside a string.");
    job.implement = answer;
    keepAboutOthers(ctx, job, "implement", answer.aboutOthers);
    keepDrafts(ctx, job, "implementor", answer.drafts);
    // The decisions it took itself go on the Item first, whether it finished or stopped to ask.
    if (answer.decisions?.length) await recordDecisions(ctx, job, answer.decisions);
    // Stopped without a question after a command was refused: a setting for a person, not a question.
    if (!answer.done && !answer.decision && record.denied?.length) return parkTools(ctx, job, "implementer", record.denied[0]!);
    if (!answer.done) return ask(ctx, job, "implementer", answer.decision, answer.summary, item);
    // Level 2, or level 3 after the approval: the session merged it itself (or opened a pull request), so its branch may have no
    // commits over main any more. The hand-over looks at what it did.
    const merging = ctx.config.level === 2 || (ctx.config.level === 3 && job.merge === true);
    if (merging) {
      delete job.resumeWith;
      // An overturn that arrived while it worked goes back to it before the hand-over.
      if (overturnsBack(ctx, job)) return;
      return handOver(ctx, job, item);
    }
    // Done with nothing committed. On the first build the implementor found nothing to change in the code: no retry would find
    // more, so it goes to a person to close it (or to answer, which runs the step again). In a fix round the step failed.
    const empty = await emptyBranch(ctx, job);
    if (empty && job.fixRounds === 0) {
      return parkByStep(
        ctx, job, "escalated",
        `Nothing to change: the implementer reported the work done, but ${empty} It said: ${clipText(answer.summary.trim() || "nothing", 600)} If that is right, close the Item; answer here to have it try again.`,
        "escalation",
      );
    }
    if (empty) return failed(ctx, job, `The implementer reported the work done, but: ${empty}`);
    // A fix round for a change the merge queue sent back that committed nothing: the same revision would only fail there again.
    if (job.sentBack && (await headOf(ctx, job)) === job.sentBack) {
      return failed(ctx, job, `The implementer reported the fix done, but ${job.branch} is still at ${job.sentBack.slice(0, 7)}, the revision the merge queue sent back: nothing new was committed.`);
    }
    delete job.resumeWith;
    await writeRevision(ctx, job);
    // An overturn that arrived while it worked: its own session is resumed with it at once, before review.
    if (overturnsBack(ctx, job)) return;
    return afterBuild(ctx, job, item);
  }

  if (job.step === "review") {
    const answer = asReview(record.output);
    if (!answer) return failed(ctx, job, "The reviewer's answer does not have the expected shape, or has tool-call markup inside a string.");
    job.review = answer;
    await writeReview(ctx, job, answer);
    keepDrafts(ctx, job, "reviewer", answer.drafts);
    const must = answer.findings.filter((finding) => finding.severity === "must");
    if (answer.verdict === "approve" && must.length === 0) {
      // An approval starts the review rounds' progress afresh; the merge's stays.
      if (job.progress?.mergeQueue) job.progress = { mergeQueue: job.progress.mergeQueue };
      else delete job.progress;
      // A person overturned a decision while it was in review: back to the implementor, not on to the merge.
      if (overturnsBack(ctx, job)) return;
      // The `should` findings go back to the implementor once ("fix"), or become one draft and the merge goes on.
      const should = answer.findings.filter((finding) => finding.severity === "should" && finding.text.trim());
      if (should.length > 0 && reviewSettings(ctx.config).shouldFindings === "fix" && job.shouldSent === undefined) {
        job.shouldSent = should.map(findingKey);
        return backToImplementor(
          ctx, job, `The reviewer approves, and asks for these smaller changes before the merge:\n${formatFindings(should)}\nFix them and commit.`,
          `The review approves with ${should.length} \`should\` finding(s). Next: the implementor fixes them before the merge (review.shouldFindings "fix"); this round is not counted toward the limit of rounds.`,
        );
      }
      if (should.length > 0) draftShould(ctx, job, item, should);
      if (ctx.config.level >= 4) return handOver(ctx, job, item);
      // Level 3: Scope Soup merges nothing below level 4. The implementor's own session is resumed to merge it.
      job.merge = true;
      return backToImplementor(ctx, job, APPROVED, "The review approves. Next: the implementor merges it as the project's CLAUDE.md says.");
    }
    const max = persistenceLimits(ctx.config.settings.persistence.value).maxFixRounds;
    if (job.fixRounds >= max) {
      const open = answer.findings.map((finding) => finding.text).join(" / ") || "none listed";
      return park(ctx, job, "escalated", `The review still asks for changes after ${job.fixRounds} round(s) back to the implementor; the limit is ${max}. Open findings: ${open}`, "escalation");
    }
    // A round that got nowhere ends the run before the limit.
    const stuck = noProgress(job.progress, must);
    if (stuck) {
      const open = answer.findings.map((finding) => finding.text).join(" / ") || "none listed";
      return park(ctx, job, "escalated", `${stuck} After ${job.fixRounds} round(s) back to the implementor (the limit is ${max}). Open findings: ${open}`, "escalation");
    }
    job.progress = { ...job.progress, must: must.length, findings: must.map(findingKey) };
    job.fixRounds++;
    // A recorded decision that should have been a question: the implementor stops and asks it, and undoes nothing for it yet.
    const asks = answer.findings.some((finding) => finding.ask);
    const ask = asks ? `A finding marked "${ASK_PERSON}" is a decision you took that should have been a question: stop and ask it in \`question\`, and change nothing for it yet. ` : "";
    return backToImplementor(
      ctx, job, `The reviewer asked for these changes:\n${formatFindings(answer.findings)}\n${ask}Fix ${asks ? "the others" : "them"} and commit.`,
      `The review asks for changes (${answer.findings.length} finding(s)). Next: the implementor fixes them, round ${job.fixRounds} of ${max}.`,
    );
  }
}

/** An agent's `drafts`: filed as Item drafts for a person, linked to this Item (decision 95). One filed before is not filed again. */
function keepDrafts(ctx: Context, job: Job, role: "triage" | "implementor" | "reviewer", drafts: readonly ProposedDraft[] | undefined): void {
  if (!drafts || drafts.length === 0) return;
  const key = refKey(job.item);
  const made = fileDrafts(ctx.deps.store, job.item, role, drafts, ACTOR, ctx.at);
  const titles = (list: readonly string[]): string => list.map((title) => `"${clipText(title, 120)}"`).join(", ");
  if (made.filed.length > 0) {
    ctx.commit("orchestrator.drafts_filed", `The ${role} of ${job.item.id} proposed ${made.filed.length === 1 ? "a new Item" : `${made.filed.length} new Items`}: ${titles(made.filed.map((each) => each.title))}. ${made.filed.length === 1 ? "It waits" : "They wait"} in Your turn as ${made.filed.length === 1 ? "a draft" : "drafts"} for a person to approve or deny.`, key, { drafts: made.filed.map((each) => each.ref.id) });
  }
  if (made.known.length > 0) ctx.commit("orchestrator.drafts_known", `The ${role} of ${job.item.id} proposed ${titles(made.known)} again: filed as a draft before, not filed twice.`, key, { count: made.known.length });
}

/**
 * The `should` findings of an approved change, with `review.shouldFindings` "draft" or after their one round back ("fix"), become one
 * draft from the reviewer; the merge goes on.
 */
function draftShould(ctx: Context, job: Job, item: WorkItem | null, should: readonly Finding[]): void {
  const listed = should.map((finding) => clipText(`${finding.file ? `${finding.file}: ` : ""}${finding.text.trim()}`, 300)).join(" / ");
  ctx.commit("orchestrator.should_drafted", `The review approved with ${should.length} \`should\` finding(s); they become a draft for a person, and the merge goes on: ${listed}`, refKey(job.item), { findings: should.length });
  keepDrafts(ctx, job, "reviewer", [shouldDraft(item ?? { ref: job.item, title: job.item.id }, should)]);
}

/**
 * The implementor decided these itself as cheap to change later: kept on the job for the reviewer, and recorded on the
 * Item (GitHub: one comment with the `scopesoup:assumption` label, which does not block; metaBranch: an `assumption` line). The work
 * goes on; a failed write is an event and does not stop it.
 */
async function recordDecisions(ctx: Context, job: Job, decisions: readonly TakenDecision[]): Promise<void> {
  const key = refKey(job.item);
  job.taken = [...(job.taken ?? []), ...decisions].slice(-50);
  ctx.commit("orchestrator.decisions_recorded", `The implementor decided ${decisions.length === 1 ? "one question" : `${decisions.length} questions`} itself as cheap to change later: ${decisions.map((each, index) => `${index + 1}. ${each.question} Chose: ${each.chosen}.`).join(" ")} They wait on the board for Accept or Overturn; the work goes on.`, key, { count: decisions.length });
  await ctx.act("record the decisions on the item", key, () =>
    ctx.deps.actions.appendLog(job.item, "assumption", {
      decisions: decisions.map((each) => ({ question: each.question, chosen: each.chosen, others: each.others, why: each.why })),
      // What a Scope Soup from earlier shows of the line in the item's history.
      assumption: decisions.map((each) => `${each.question} ${each.chosen}`).join("; "),
    }));
}

/** Triage's verdicts once its questions (and its draft) are settled: a restructuring, not ready, too large, or implement. */
async function afterTriage(ctx: Context, job: Job, answer: TriageAnswer, settled = ""): Promise<void> {
  // A restructuring is proposed whatever `ready` says: the parts are what can be made ready.
  if (answer.restructure) return parkRestructure(ctx, job, answer.restructure, answer.ready ? undefined : answer.notReadyReason);
  const blockers = answer.blockers?.length ? ` Blockers: ${answer.blockers.join("; ")}.` : "";
  if (!answer.ready) return park(ctx, job, "not-ready", `Triage: not ready. ${answer.notReadyReason ?? "No reason given."}${blockers}`, "not-ready");
  if (answer.size === "large") return park(ctx, job, "not-ready", "Triage: too large for one change. Split it into smaller items first.", "not-ready");
  return next(ctx, job, "implement", `Triage: ready, ${answer.size}.${blockers}${settled} Next: implement.`);
}

/** The Item a triage's link names (`#12`, `12`, `A-3` or a ref key), on the subject's own host; null when the store has none. */
const linkedItem = (ctx: Context, subject: Ref, name: string): WorkItem | null => namedItem(ctx.deps.store, subject, name);

/**
 * A duplicate or a conflict the triage found becomes a question for a person; Scope Soup closes nothing by itself. Where the host can close a duplicate (GitHub), the answer closes it there.
 */
function linkQuestions(ctx: Context, job: Job, links: readonly ItemLinkAnswer[]): Decision[] {
  const self = job.item.id;
  const closes = ctx.deps.actions.closeDuplicate !== undefined;
  const questions: Decision[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (link.type !== "duplicateOf" && link.type !== "conflictsWith") continue;
    const other = linkedItem(ctx, job.item, link.item);
    if (!other || !isOpenItem(other) || seen.has(`${link.type} ${other.ref.id}`)) continue;
    seen.add(`${link.type} ${other.ref.id}`);
    const stop = link.type === "duplicateOf" ? `Close ${self} as a duplicate of ${other.ref.id}` : `Hold ${self} until ${other.ref.id} is settled`;
    questions.push({
      question: link.type === "duplicateOf" ? `Close ${self} as a duplicate of ${other.ref.id} "${other.title}"?` : `${self} conflicts with ${other.ref.id} "${other.title}". Hold ${self} until that is settled?`,
      options: link.type === "duplicateOf"
        ? [{ label: stop, description: closes ? `Scope Soup closes ${self} on the host as a duplicate of ${other.ref.id}.` : `${self} parked as not ready; close it on the host yourself. Scope Soup closes nothing.` }, { label: "Keep both", description: `Work on ${self} as it is.` }]
        : [{ label: stop, description: `${self} parked as not ready until you answer again.` }, { label: "Go on with both", description: `Work on ${self} as it is.` }],
      recommendation: stop,
      ...(link.reason ? { context: link.reason } : {}),
      stopsOn: stop,
      ...(link.type === "duplicateOf" ? { duplicateOf: other.ref } : {}),
    });
  }
  return questions;
}

/**
 * A write to the host that must take effect: null when it did, else why not, with `orchestrator.host_write_failed`.
 * Without a way to write (writes off) it fails too. Nothing is kept in the store instead and nothing is queued.
 */
async function writeBlockers(ctx: Context, subject: Ref, blockers: Ref[], what: string): Promise<string | null> {
  const add = ctx.deps.actions.addBlockers;
  let problem: string | null = null;
  if (!add) problem = `writes to ${subject.host} are off.`;
  else {
    try {
      await add(subject, blockers);
    } catch (error) {
      problem = errorText(error);
    }
  }
  if (problem) ctx.commit("orchestrator.host_write_failed", `Could not ${what}: ${problem}`, refKey(subject));
  return problem;
}

/** On GitHub a triage's `blocks` link is written as `blocked_by` on the other open Item. A failure does not stop this one. */
async function writeBlocksLinks(ctx: Context, subject: Ref, links: readonly ItemLinkAnswer[]): Promise<void> {
  const done = new Set<string>();
  for (const link of links) {
    if (link.type !== "blocks") continue;
    const other = linkedItem(ctx, subject, link.item);
    if (!other || !isOpenItem(other) || done.has(other.ref.id)) continue;
    done.add(other.ref.id);
    await writeBlockers(ctx, other.ref, [subject], `write ${other.ref.id} blocked by ${subject.id}`);
  }
}

/**
 * The triage's answer with a draft. A `blockedBy` link to an open Item is acted on at once: it is recorded as Scope Soup's
 * own blocker (and written to the item's `blockedBy` field where Scope Soup writes items; on GitHub, only written as an issue
 * dependency, and a write that fails parks the Item as escalated), the job closes and the Item waits in Blocked; its first
 * look runs again once the blocker is done. Otherwise the questions (with the duplicate and conflict links
 * made into questions) and the draft are parked for a person; with no question and the draft the same as the description, triage's
 * other verdicts follow at once.
 */
async function triage(ctx: Context, job: Job, answer: TriageAnswer, item: WorkItem | null): Promise<void> {
  const { store, actions, runner } = ctx.deps;
  const key = refKey(job.item);
  const links = answer.links ?? [];
  const blockers: WorkItem[] = [];
  for (const link of links) {
    if (link.type !== "blockedBy") continue;
    const other = linkedItem(ctx, job.item, link.item);
    if (other && isOpenItem(other) && !blockers.some((each) => each.ref.id === other.ref.id)) blockers.push(other);
  }
  const names = blockers.map((each) => each.ref.id).join(", ");
  // A GitHub Item's blockers are its issue dependencies, never Scope Soup's record.
  const onHost = blockersOnHost(job.item);
  if (onHost) await writeBlocksLinks(ctx, job.item, links);
  const had = !onHost && (loadOwnBlockers(store)[key] ?? []).length > 0;
  if (!onHost && (blockers.length > 0 || had)) {
    setOwnBlockers(store, job.item, blockers.map((each) => each.ref), "orchestrator", ctx.at, blockers.length > 0 ? `The triage found ${job.item.id} blocked by ${names}.` : `The triage found no blocker of ${job.item.id} any more.`);
  }
  if (blockers.length > 0) {
    const refs = blockers.map((each) => each.ref);
    if (onHost) {
      const problem = await writeBlockers(ctx, job.item, refs, `write ${job.item.id} blocked by ${names}`);
      if (problem) {
        return park(ctx, job, "escalated", `The triage found ${job.item.id} blocked by ${names}, but the dependency could not be written on ${job.item.host}: ${problem} Nothing is kept instead. Add it there, or answer here to look again.`, "escalation");
      }
    } else if (actions.addBlockers) await ctx.act("write the blockers to the item", key, () => actions.addBlockers!(job.item, refs));
    if (actions.claims) await ctx.act("release the claim", key, () => actions.release(job.item, `blocked by ${names}`));
    await ctx.act("remove the worktree", key, () => runner.releaseWorkspace(job.workspace));
    delete ctx.jobs[key];
    ctx.commit("orchestrator.blocked", `Triage: ${job.item.id} is blocked by ${names}. It waits in Blocked, and its triage runs again once ${blockers.length > 1 ? "they are" : "it is"} done.`, key, { blockedBy: refs.map(refKey) });
    return;
  }
  const answers = knownAnswers(store);
  const questions = [...(answer.decisions ?? []), ...linkQuestions(ctx, job, links)]
    .filter((question) => question.question.trim() && !(item && reusableAnswer(answers, item, question)));
  const original = item?.body?.trim() ?? "";
  const draft = (answer.draft ?? "").trim();
  const { change: labels, dropped } = await proposedLabels(ctx, job, answer, item);
  const droppedNote = dropped.length > 0 ? ` The triage named label${dropped.length > 1 ? "s" : ""} the repository does not have, dropped: ${dropped.join(", ")}.` : "";
  if (questions.length === 0 && (draft === "" || draft === original) && isEmptyChange(labels)) return afterTriage(ctx, job, answer, ` The draft keeps the description as it is.${droppedNote}`);
  const round = (job.refineRounds ?? 0) + 1;
  job.refineRounds = round;
  job.refine = { original, draft: draft || original, questions, round, ...(!isEmptyChange(labels) ? { labels } : {}), ...(dropped.length > 0 ? { droppedLabels: dropped } : {}) };
  const labelNote = isEmptyChange(labels) ? "" : ` Labels: ${changeText(labels)}.`;
  const reason = questions.length > 0
    ? `Triage, round ${round}: a draft description and ${questions.length} question(s) wait for an answer: ${questions.map((each, index) => `${index + 1}. ${each.question}`).join(" ")}${labelNote}${droppedNote}`
    : `Triage, round ${round}: a draft description waits for a person to accept, edit or reject.${labelNote}${droppedNote}`;
  return park(ctx, job, "needs-decision", reason, "decision");
}

/**
 * The label changes the triage proposed, kept to the labels of the Item's host (`repoLabels`, read again now) and never
 * `scopesoup:*`. A label the host does not have is dropped and noted; without a list (writes off, or it cannot be read) none is kept.
 */
async function proposedLabels(ctx: Context, job: Job, answer: TriageAnswer, item: WorkItem | null): Promise<{ change: LabelChange; dropped: string[] }> {
  const none = { change: { add: [], remove: [] }, dropped: [] };
  if (!answer.labels || isEmptyChange(answer.labels) || !item || !ctx.deps.actions.repoLabels) return none;
  let repo: RepoLabel[] | null;
  try {
    repo = await ctx.deps.actions.repoLabels(job.item);
  } catch (error) {
    ctx.say("orchestrator.labels_unread", `The labels of ${job.item.host} could not be read, so the triage's label changes for ${job.item.id} are left out: ${errorText(error)}`, refKey(job.item));
    return none;
  }
  if (!repo) return none;
  return keepProposal(answer.labels, repo.map((each) => each.name), item.labels);
}

/**
 * A person settled the triage's draft (`settleDraft`): an answer that stops the Item (close as a duplicate, hold for a
 * conflict) parked it as not ready; otherwise triage's other verdicts follow.
 */
export async function afterRefine(ctx: Context, job: Job): Promise<void> {
  const refine = job.refine;
  delete job.refine;
  delete job.refineRounds;
  // Questions and a draft from agents of other Items: once settled, this Item is triaged again with the answers.
  if (refine?.askedBy) return next(ctx, job, "triage", `A person settled what ${refine.askedBy.join(" and ")} asked about ${job.item.id}${refine.settled ? ` (the draft ${refine.settled})` : ""}. Next: triage again, with the answers.`);
  if (refine?.stop && refine.duplicateOf && ctx.deps.actions.closeDuplicate) {
    // Closed on the host, written through; a failure is `orchestrator.host_write_failed`, and the Item parked as before.
    const key = refKey(job.item);
    try {
      if (await ctx.deps.actions.closeDuplicate(job.item, refine.duplicateOf)) {
        const closed = `${job.item.id} was closed on its host as a duplicate of ${refine.duplicateOf.id}, as a person answered.`;
        ctx.commit("orchestrator.item_closed", closed, key, { duplicateOf: refKey(refine.duplicateOf) });
        // Parked without a turn for a person; the next tick sees the Item abandoned and closes the job.
        return park(ctx, job, "not-ready", closed);
      }
    } catch (error) {
      ctx.commit("orchestrator.host_write_failed", `Could not close ${job.item.id} as a duplicate of ${refine.duplicateOf.id}: ${errorText(error)}`, key);
      return park(ctx, job, "not-ready", `A person answered: ${refine.stop}. Closing it on the host failed (${errorText(error)}); close it there yourself, or answer here to look at it again.`, "not-ready");
    }
  }
  if (refine?.stop) return park(ctx, job, "not-ready", `A person answered: ${refine.stop}. Scope Soup closes nothing itself; answer here to look at it again.`, "not-ready");
  if (!job.triage) return next(ctx, job, "implement", "The draft is settled. Next: implement.");
  return afterTriage(ctx, job, job.triage, refine?.settled ? ` A person ${refine.settled} the draft.` : "");
}

/** A person said "try again" after a failed hand-over: repeat it without a session, if the branch is still there. */
export async function retryHandOver(ctx: Context, job: Job, item: WorkItem | null): Promise<void> {
  delete job.owes;
  try {
    await ctx.deps.runner.changedPaths(job.branch);
  } catch (error) {
    delete ctx.jobs[refKey(job.item)];
    ctx.commit("orchestrator.job_closed", `The branch ${job.branch} can no longer be read (${errorText(error)}); the item starts over.`, refKey(job.item));
    return;
  }
  const asker = job.owesAskedBy;
  const who = asker ? `as ${asker} asked` : "by the tick itself: nobody asked";
  ctx.commit("orchestrator.handover_retry", `Trying the hand-over of ${job.branch} again, ${who}.`, refKey(job.item), { by: asker ?? "tick" });
  delete job.owesAskedBy;
  await handOver(ctx, job, item, asker);
}

/**
 * Writes the questions (and the draft) agents of other Items asked about an Item, once it is free (`busyWhy`): the Item parks on
 * them as on triage's own draft and questions, with the same Accept, Edit and Reject, and the same posting on its host. Work paused
 * on it keeps its branch and its implementor's session; the answers send it back to its triage. Questions for an Item that is not
 * free wait, said once; for one unknown or closed they are dropped with an event.
 */
export async function writeAboutOthers(ctx: Context): Promise<void> {
  const { store } = ctx.deps;
  for (const [key, entries] of Object.entries(readWaitingAbouts(store))) {
    if (entries.length === 0) continue;
    const item = store.list<WorkItem>("work").find((work) => refKey(work.ref) === key) ?? null;
    if (!item || !isOpenItem(item)) {
      store.tx(() => {
        const waiting = readWaitingAbouts(store);
        delete waiting[key];
        writeWaitingAbouts(store, waiting);
        ctx.commit("orchestrator.about_other_dropped", `${entries.length} set(s) of questions from other Items waited for ${item ? `${item.ref.id}, which is now ${item.state}` : "an Item that is no longer in the store"}: dropped.`, key, { sets: entries.length });
      });
      continue;
    }
    const existing = ctx.jobs[key];
    const busy = busyWhy(ctx, item, existing);
    if (busy) {
      ctx.say("orchestrator.about_other_wait", `Questions from ${[...new Set(entries.map((each) => each.askedBy))].join(" and ")} wait for ${item.ref.id}: ${busy}.`, key);
      continue;
    }
    ctx.forget("orchestrator.about_other_wait", key);
    const askedBy = [...new Set(entries.map((each) => each.askedBy))];
    const questions = entries.flatMap((each) => each.questions);
    const original = item.body?.trim() ?? "";
    const draft = [...entries].reverse().find((each) => each.draft)?.draft ?? original;
    // A job parked before gave back its claim and workspace then; one between steps holds them still.
    const holds = existing !== undefined && !existing.parked;
    const job: Job = existing ?? { item: item.ref, workspace: workspaceKey(item.ref), branch: workBranch(item.ref), step: "triage", failures: 0, fixRounds: 0, startedAt: ctx.at };
    // Work paused on it keeps its branch, its implementor's session and the findings it is to be told; what it was about to do
    // next waits until the triage has run again with the answers.
    job.step = "triage";
    job.failures = 0;
    for (const field of ["decision", "proposal", "refine", "notBefore", "resume", "recheck", "triaging", "answered", "merge", "answerArrived"] as const) delete job[field];
    const round = (job.refineRounds ?? 0) + 1;
    job.refineRounds = round;
    job.refine = { original, draft, questions, round, askedBy };
    const reason = questions.length > 0
      ? `Asked by ${askedBy.join(" and ")}: ${draft !== original ? "a draft description and " : ""}${questions.length} question(s) about ${item.ref.id} wait for an answer: ${questions.map((each, index) => `${index + 1}. ${each.question}`).join(" ")}`
      : `Drafted by ${askedBy.join(" and ")}: a draft description of ${item.ref.id} waits for a person to accept, edit or reject.`;
    store.tx(() => {
      const waiting = readWaitingAbouts(store);
      delete waiting[key];
      writeWaitingAbouts(store, waiting);
      ctx.jobs[key] = job;
      ctx.commit("orchestrator.about_other_written", `Wrote on ${item.ref.id} what ${askedBy.join(" and ")} asked: ${questions.length} question(s)${draft !== original ? " and a draft" : ""}.`, key, { askedBy, questions: questions.length });
    });
    if (holds) await park(ctx, job, "needs-decision", reason, "decision");
    else await parkFresh(ctx, job, reason);
  }
}

/** `park` for an Item with no claim or workspace of its own to give back (no job, or one parked before). */
async function parkFresh(ctx: Context, job: Job, reason: string): Promise<void> {
  job.parked = { as: "needs-decision", reason, at: ctx.at };
  delete job.sessionId;
  ctx.commit(PARK_EVENT["needs-decision"], reason, refKey(job.item), { step: job.step });
  await tellPeople(ctx, job, "needs-decision", reason, "decision");
}
