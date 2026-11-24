// The job: where one work item stands in the cycle triage -> implement -> review -> (implement
// resumed with the findings -> review)* -> hand over. Kept in the store so a restart resumes instead of forgetting.

import type { FenceSeen } from "../core/fence.ts";
import type { CreatedPart, DecisionOption, ItemLinkAnswer, LabelChange, LinkType, ProposedPart, Ref, WorkItem } from "../model/types.ts";
import { asOptions, asParts, refKey } from "../model/types.ts";
import { asLabelChange } from "../model/labels.ts";
import type { Store } from "../store/store.ts";
import { itemTextHash } from "../core/answerReuse.ts";

export type JobStep = "triage" | "implement" | "review";

/**
 * Why a job parked. "queued" and "handed-over" are the good ends of the cycle.
 */
export type ParkedAs = "queued" | "handed-over" | "needs-decision" | "not-ready" | "escalated";

/** A stop for a person: the question, the options, and the answer the session would give. */
export interface Decision {
  question: string;
  /** Each option as `{ label, description }`; plain text from an older answer is kept as it is. */
  options: DecisionOption[];
  /** The label of the option the session would pick. */
  recommendation: string;
  /** What the session said beyond the options, shown as a note under the question. */
  context?: string;
  /** Several options may be picked; the answer names each. */
  multiSelect?: true;
  /**
   * A question made from a `duplicateOf` or `conflictsWith` link. When the answer is this label, the Item parked
   * as not ready with that answer once the draft is settled (Scope Soup closes nothing itself).
   */
  stopsOn?: string;
  /** With `stopsOn`, from a `duplicateOf` link: the Item it duplicates, so the host can close it as that one's duplicate. */
  duplicateOf?: Ref;
}

/** How the triage says this Item relates to another. Only `blockedBy` is acted on by itself (and on GitHub, `blocks`). */
export const LINK_TYPES: readonly LinkType[] = ["blockedBy", "blocks", "duplicateOf", "conflictsWith", "related"];
export type { ItemLinkAnswer, LinkType };

/**
 * The triage's draft of the Item's description, parked for a person with its questions (each recommendation
 * pre-selected on the Item page). Keeping every recommendation, a person accepts, edits or rejects the draft in one action;
 * any other answer runs the triage again with the answers.
 */
export interface Refinement {
  /** The description as the triage read it. */
  original: string;
  /** The description written as if a person takes every recommendation. */
  draft: string;
  /** Triage's questions, then the ones made from duplicate and conflict links. */
  questions: Decision[];
  /** Which round of the loop this draft is (1 for the first). There is no cap. */
  round: number;
  /** The label changes proposed with the draft, kept to the repository's labels; applied with it at Accept or Edit. */
  labels?: LabelChange;
  /** Labels the triage named that the repository does not have: dropped and noted. */
  droppedLabels?: string[];
  /** A person settled the draft: the next tick goes on from triage's other verdicts (split, not ready, implement). */
  settled?: "accepted" | "edited" | "rejected";
  /** With `settled`: an answer picked a question's `stopsOn` (close as a duplicate, hold for a conflict). */
  stop?: string;
  /** With `stop`, the Item a person said this one duplicates. */
  duplicateOf?: Ref;
  /**
   * The draft and questions came from agents working on other Items (`aboutOthers`), named here ("triage of A-3"). Once a
   * person settles them, this Item is triaged again with the answers.
   */
  askedBy?: string[];
}

/**
 * Questions an agent asks about another Item than its own (`aboutOthers` in its answer), and from triage a draft of that Item's
 * description. Scope Soup writes them on that Item (`aboutOthers.ts`). Agent text: data.
 */
export interface AboutOther {
  /** The other Item as the agent named it (`#12`, `12`, `A-3`). */
  item: string;
  questions: Decision[];
  /** Triage only. */
  draft?: string;
}

/**
 * A proposed split: triage found the item too large and names its parts, created as children of the item on accept. A person
 * accepts, edits or rejects it on the item page. (A proposed rewrite of the item's text was removed in a stored one is
 * dropped by `migrateRemovedSteps`.)
 */
export interface Proposal {
  reason: string;
  parts: ProposedPart[];
  /** With `parts`: the answers on the item when the split was proposed, carried over into each part. */
  carried?: string;
  /** With `parts`: the children made so far, each with its part and whether it is linked. Kept so a retry after a failure, or a second press, creates no duplicates. */
  created?: CreatedPart[];
}

/**
 * The triage's answer. The prompt asks for `questions`; `hidesDecision` is true when there is at least one, and the
 * questions are kept as `decisions`. Older stored answers may also carry `risk` and `riskReason`, which nothing reads.
 */
export interface TriageAnswer {
  ready: boolean;
  notReadyReason?: string;
  size: "small" | "medium" | "large";
  paths: string[];
  /** Other Items or missing facts that stand in the way. */
  blockers?: string[];
  hidesDecision: boolean;
  /** The first of `decisions` (what the rest of the program reads when it wants one question). */
  decision?: Decision;
  /** Every open decision triage found, in the order it gave them. */
  decisions?: Decision[];
  /** With size "large": the parts triage proposes to split the item into. */
  parts?: ProposedPart[];
  /** The description rewritten as if a person takes every recommendation. Absent in answers from earlier. */
  draft?: string;
  /** Typed links to other Items. */
  links?: ItemLinkAnswer[];
  /** Labels the triage proposes to add and remove, as it wrote them (checked against the repository's labels later). */
  labels?: LabelChange;
  /** Questions about other Items, each with a draft of that Item's description when it needs one. */
  aboutOthers?: AboutOther[];
}

/** The implementor's answer. A refused command is read from the session's result, not asked for. */
export interface ImplementAnswer {
  done: boolean;
  summary: string;
  /** When not done: the question for a person with options and a recommendation, as the triage asks. */
  decision?: Decision;
  /** Levels 2 and 3: what the session says it did with the change, the commit on the main branch or the pull request it opened. Checked, never trusted: the Item is done only when the remote's main contains the branch head. */
  mergedAs?: string;
  /** The questions it decided itself as cheap to change later, recorded on the Item for a person to accept or overturn. */
  decisions?: TakenDecision[];
  /** Questions about other Items (never a draft). */
  aboutOthers?: AboutOther[];
}

/** A decision the implementor took itself: what had to be decided, what it chose, the other options and why. Text from an agent: data. */
export interface TakenDecision {
  question: string;
  chosen: string;
  others: string[];
  why: string;
}

export interface Finding {
  severity: "must" | "should";
  file?: string;
  text: string;
  /** A recorded decision that should have been a question: the implementor stops and asks it. */
  ask?: true;
}

export interface ReviewAnswer {
  verdict: "approve" | "changes";
  findings: Finding[];
}

export interface Job {
  item: Ref;
  workspace: string;
  branch: string;
  step: JobStep;
  /** The session running this step now. */
  sessionId?: string;
  /** Failed attempts of the current step. */
  failures: number;
  /** How many times review (or a failed merging) sent the change back to the implementor. */
  fixRounds: number;
  /** The step may not start before this (a retry timer or a limit reset). */
  notBefore?: string;
  /** The agent session to continue, after a limit or a stop cut it off. */
  resume?: string;
  /** The implementor's own agent session id (to resume it), kept so findings go back to the session that wrote the change. */
  agentSession?: string;
  /**
   * What the implementor is told next: the review's findings, a failed merging or a person's note. The implement step
   * resumes `agentSession` with it; without a known session it starts afresh with this after its prompt. Cleared when done.
   */
  resumeWith?: string;
  /** Level 3: the reviewer approved the change, so the implement step now merges it (the implementor's session is resumed, or a fresh one told to merge). */
  merge?: true;
  /** Levels 2 and 3: where the remote's main was when the item's first implement session started. A branch head already in it is no work done. */
  base?: string;
  parked?: {
    as: ParkedAs; reason: string; at: string;
    /**
     * "hand-over": the work is finished; only the hand-over failed and is retried when a person answers. "post": the parked state's
     * questions or draft could not be posted on the host for a reason that can change (down, a 5xx, a rate limit); each tick posts
     * them again by itself.
     */
    retry?: "hand-over" | "post";
    /** With `retry: "post"`, the parked state's own reason, which it shows again once the post is through. */
    posting?: string;
    /** The implement step itself was parked here (a question, a refused tool, failed attempts), not the hand-over, merging or a person closing the change. Only such a parked Item is resumed by an answer. */
    byStep?: true;
    /** The question comments on the host (GitHub) this parked state waits on, in the order asked; their answers are read from the host. */
    questions?: string[];
    /** The text and number of each of `questions`, in the same order, so a deleted one can be named and its number kept. */
    texts?: AskedText[];
    /** The host's time of the last question comment, so an older read of the item is not taken for a deletion. */
    askedAt?: string;
    /** The triage round's draft comment on the host (GitHub) and its question comments, which a person answers on the board. */
    draft?: { id: string; questions: string[]; /** As `texts` above. */ texts?: AskedText[]; /** The host's time of the last question comment. */ askedAt?: string; /** Each question has its answer from a reply on the host, all the recommendations: the draft waits for Accept on the board. */ answered?: true };
  };
  /** Set when a person said "try again" after a failed hand-over: the next tick hands over without a session. */
  owes?: "hand-over";
  /** A person asked for the owed hand-over (Try again); unset when the tick repeats it by itself. Cleared once logged. */
  owesAskedBy?: string;
  triage?: TriageAnswer;
  /** How many times a recorded answer was reused for a question an implementer or fixer asked again (capped, so a step cannot loop). */
  reusedAnswers?: number;
  /** The question the job is parked on, when an implementer or fixer asked it (a triage question is in `triage.decision`). */
  decision?: Decision;
  /** The split triage proposed; the job parked until a person decides. */
  proposal?: Proposal;
  /** The triage's draft description and its questions, parked for a person, or settled and about to go on. */
  refine?: Refinement;
  /** Rounds of the refinement loop so far, kept while the triage runs again with the answers. */
  refineRounds?: number;
  implement?: ImplementAnswer;
  /** Every decision the implementor recorded on this job so far, oldest first: the reviewer is shown them. */
  taken?: TakenDecision[];
  /**
   * The decisions a person overturned that were handed to this job's work (`resumeWith`), by id: an Overturn pressed
   * again finds its decision here and is not handed twice.
   */
  overturned?: string[];
  /**
   * When the answer released the Item parked at its implement step. Until votes such an Item is picked before the others
   * (`compareItems`); cleared when the step starts.
   */
  answerArrived?: string;
  review?: ReviewAnswer;
  /**
   * The progress guards' memory. `must` and `findings`: the `must` findings of the last review round that asked for changes
   * (their count and `findingKey`s), cleared by an approval. `mergeQueue`: the last merging failure's key (`failureKey`).
   */
  progress?: { must?: number; findings?: string[]; mergeQueue?: string };
  /** The `findingKey`s of the `should` findings already filed as follow-up Items, so one is filed once. */
  followUps?: string[];
  /** The change a person saw at the fence and let go on (its paths and lines): the fence is widened to it. */
  fence?: FenceSeen;
  /**
   * The answers so far to the job's open questions (`jobQuestions`), while it is parked on several of them.
   * `index` is the question's place in that list. The job is released once every question has one.
   */
  answered?: { index: number; answer: string; at: string }[];
  /** The branch's head as last written to the item's log in a `revision` line. */
  head?: string;
  /** The commit of the item's change on the main branch: in the chain the queue pushed (level 4), or as the session merged it (levels 2 and 3). */
  merged?: string;
  /** Level 4: the head of the branch that was handed to the queue. */
  queued?: string;
  /** The Item's text as the running triage was given it, kept for `triaged` when its answer is taken. */
  triaging?: TriagedText;
  /** What the newest triage saw, so a waiting Item whose triage is out of date gets one again (`staleTriage`). */
  triaged?: Triaged;
  /** The triage runs again: why, and what changed since the one before. Cleared when its answer is taken. */
  recheck?: Recheck;
  startedAt: string;
}

/** An Item's text as a triage read it: its hash (`itemTextHash`) and the text, each part clipped. */
export interface TriagedText {
  textHash: string;
  title: string;
  body: string;
  verification: string;
}

/** What a triage saw: when its answer was taken, the remote's main right after it, the Item's text and its open blockers. */
export interface Triaged extends TriagedText {
  at: string;
  /** The commit the remote's main was at, read right after the session; absent when it could not be read. */
  main?: string;
  /** The ref keys of the Items it was blocked by that were open then. */
  blockers: string[];
  /** Hashes of texts Scope Soup wrote itself since (an accepted or edited draft): seeing one of them is no edit. */
  also?: string[];
}

/** A commit on main that touched the paths a triage named. Its subject was written by a person or an agent: data. */
export interface TouchingCommit {
  sha: string;
  subject: string;
}

/** Why the triage of a waiting Item runs again, and what it is told. */
export interface Recheck {
  /** In words, each a clause: "its text was edited", "3 commits on main changed the paths it named", ... */
  reasons: string[];
  /** The answer of the triage before. */
  previous: TriageAnswer;
  /** When that answer was taken. */
  previousAt: string;
  /** The commits on main since then that touch the paths it named, newest first (at most `MAX_COMMITS`), and how many there were. */
  commits: TouchingCommit[];
  commitCount: number;
  /** The Item's text as the triage before read it, when it has been edited since. */
  text?: Omit<TriagedText, "textHash">;
  /** The blockers that were open then and are done now, by id. */
  finished: string[];
}

/** A question as it was posted on the host: its text and its number there (`Qn`). */
export interface AskedText {
  question: string;
  n?: number;
}

export type Jobs = Record<string, Job>;

const KEY = "orchestrator.jobs";

function readStored(store: Store): Jobs {
  const text = store.getValue(KEY);
  if (!text) return {};
  try {
    return JSON.parse(text) as Jobs;
  } catch {
    return {};
  }
}

function snapshotOf(jobs: Jobs): Map<string, string> {
  return new Map(Object.entries(jobs).map(([key, job]) => [key, JSON.stringify(job)]));
}

/**
 * What each loaded map triaged like when it was loaded or last saved. A tick holds its map for
 * minutes while the server may release, accept or edit jobs; the save merges against this.
 */
const baselines = new WeakMap<Jobs, Map<string, string>>();

export function loadJobs(store: Store): Jobs {
  const jobs = readStored(store);
  baselines.set(jobs, snapshotOf(jobs));
  return jobs;
}

/**
 * Saves a map from `loadJobs`. Only the jobs changed since it was loaded (or last saved)
 * are written; a job someone else changed in the store meanwhile (an answer, accept,
 * edit or try again) is kept as stored, and `jobs` is updated to match. Call it in the
 * transaction that writes the event.
 */
export function saveJobs(store: Store, jobs: Jobs): void {
  const base = baselines.get(jobs);
  if (!base) {
    store.setValue(KEY, JSON.stringify(jobs));
    return;
  }
  const stored = readStored(store);
  const storedText = snapshotOf(stored);
  const mine = snapshotOf(jobs);
  const merged: Jobs = {};
  for (const key of new Set([...base.keys(), ...mine.keys(), ...storedText.keys()])) {
    const storedChanged = storedText.get(key) !== base.get(key);
    // Someone else's change wins over the tick's: it is a person's word.
    const from = storedChanged ? stored : jobs;
    if (from[key]) merged[key] = from[key];
  }
  for (const key of Object.keys(jobs)) if (!(key in merged)) delete jobs[key];
  for (const [key, job] of Object.entries(merged)) if (jobs[key] !== job) jobs[key] = job;
  store.setValue(KEY, JSON.stringify(merged));
  baselines.set(jobs, snapshotOf(merged));
}

/**
 * Whether an answer to this parked job goes on with the step that asked (an implement step that asked a question
 * or escalated), keeping the review round, findings and branch. An Item parked at triage, a proposed split and a
 * rest of any other step start the item over instead.
 */
export function resumesStep(job: Job): boolean {
  const parked = job.parked;
  // A post that is retried is still the step's own parked state.
  if (!parked || !parked.byStep || parked.retry === "hand-over" || job.proposal) return false;
  return (parked.as === "needs-decision" || parked.as === "escalated") && job.step === "implement";
}

/**
 * Picks a parked job up again: a person answered the decision, or says "try again". An implement step that
 * asked goes on at that step with the answer in its prompt; everything else forgets the job, so the item starts at
 * triage. `startOver` forces the latter. Returns false when there is no parked job for the item.
 */
export function releaseJob(store: Store, item: Ref, actor: string, at: string, reason: string, startOver = false): boolean {
  return store.tx(() => {
    const jobs = loadJobs(store);
    const key = refKey(item);
    const was = releaseIn(jobs, key, actor, startOver);
    if (!was) return false;
    saveJobs(store, jobs);
    store.appendEvent({ kind: "orchestrator.job_released", subject: key, actor, data: { reason, was } }, at);
    return true;
  });
}

/** `releaseJob` on a map of jobs the caller saves (the tick's). Returns the parked state it was released from, or null when there was none. */
export function releaseIn(jobs: Jobs, key: string, actor: string, startOver = false): NonNullable<Job["parked"]> | null {
  const job = jobs[key];
  if (!job || !job.parked) return null;
  const was = job.parked;
  if (was.retry === "hand-over") {
    // The work is done and reviewed: keep it, and let the next tick repeat only the hand-over.
    delete job.parked;
    job.owes = "hand-over";
    job.owesAskedBy = actor;
  } else if (!startOver && resumesStep(job)) {
    // The step that asked runs again, as a new attempt of the same round.
    delete job.parked;
    delete job.decision;
    delete job.sessionId;
    delete job.resume;
    delete job.notBefore;
    job.failures = 0;
    job.answerArrived = was.at;
  } else delete jobs[key];
  return was;
}

/**
 * What the host says of the question comments a parked job waits on. `withdrawn`: one was deleted, so the parking is
 * released and the Item starts again at the triage. `answered`: each has its answer. Null while one is still open, for a
 * parked Item without question comments, and for a read of the item older than the questions.
 */
export function questionsSettled(job: Job, item: Pick<WorkItem, "openQuestions" | "answers" | "updatedAt">): { withdrawn: boolean; reason: string; gone: string[] } | null {
  const ids = job.parked?.questions;
  if (!ids || ids.length === 0) return null;
  if (job.parked?.askedAt && Date.parse(item.updatedAt) < Date.parse(job.parked.askedAt)) return null;
  const open = new Set((item.openQuestions ?? []).map((question) => question.id));
  const answers = new Map((item.answers ?? []).flatMap((answer) => (answer.to ? [[answer.to, answer] as const] : [])));
  const gone = ids.filter((id) => !open.has(id) && !answers.has(id));
  if (gone.length > 0) {
    return { withdrawn: true, gone, reason: `The question comment${gone.length > 1 ? "s" : ""} ${gone.join(", ")} ${gone.length > 1 ? "were" : "was"} deleted on ${job.item.host}: the Item is no longer parked, and it starts again at its triage.` };
  }
  if (ids.some((id) => open.has(id))) return null;
  const said = ids.map((id) => answers.get(id)!).map((answer) => `${answer.question ? `${answer.question} ` : ""}Answered: ${answer.answer}`);
  return { withdrawn: false, gone: [], reason: `Answered on ${job.item.host}: ${said.join(" ")}` };
}

/**
 * The questions a person must all answer before this parked job is picked up again: triage's decisions when it
 * found more than one (the same list, in the same order, that `park` writes to the item's log). Empty for a single
 * question, which is answered and released as before, and for anything that is not a triage decision.
 */
export function jobQuestions(job: Job): Decision[] {
  // A draft's questions are answered together with the draft (`POST /api/draft`), not one by one.
  if (job.parked?.as !== "needs-decision" || job.step !== "triage" || job.proposal || job.decision || job.refine) return [];
  const all = (job.triage?.decisions ?? []).filter((decision) => decision.question.trim());
  return all.length > 1 ? all : [];
}

/** Why an answer to one of several questions is refused: no such set (any more), the parked state is not the one the page read, or the question already has an answer. */
export type AnswerRefusal = "no-questions" | "parked-changed" | "answered";

/**
 * Whether a person may answer question `index` of this job's open questions now. `parkedAt` is the time of the parked state
 * the answer was given on (the page sends `parked.at`); an answer read from an earlier parked state, before a release or a new
 * triage, is refused instead of merging on another question. Null when it may.
 */
export function answerRefusal(job: Job | undefined, index: number, parkedAt: string | undefined): AnswerRefusal | null {
  const questions = job ? jobQuestions(job) : [];
  if (!job || !Number.isInteger(index) || index < 0 || index >= questions.length) return "no-questions";
  if (parkedAt !== undefined && Date.parse(parkedAt) !== Date.parse(job.parked!.at)) return "parked-changed";
  if ((job.answered ?? []).some((each) => each.index === index)) return "answered";
  return null;
}

/**
 * A person answers one of the job's open questions (`index` into `jobQuestions`). The answer is kept in the
 * job; the answer to the last open question releases it (`releaseJob`). All in one store transaction, so two
 * answers sent at once cannot both see a question still open, and a running tick's save keeps them. A question has
 * one answer: a second one is refused, as is an answer from another parked state (`answerRefusal`).
 */
export function answerQuestion(store: Store, item: Ref, index: number, answer: string, actor: string, at: string, parkedAt?: string): { released: boolean; open: number } | { refused: AnswerRefusal } {
  return store.tx(() => {
    const jobs = loadJobs(store);
    const key = refKey(item);
    const job = jobs[key];
    const refused = answerRefusal(job, index, parkedAt);
    if (refused || !job) return { refused: refused ?? "no-questions" };
    const questions = jobQuestions(job);
    const answered = [...(job.answered ?? []).filter((each) => each.index < questions.length), { index, answer, at }].sort((a, b) => a.index - b.index);
    const open = questions.length - answered.length;
    if (open > 0) {
      job.answered = answered;
      saveJobs(store, jobs);
      store.appendEvent({ kind: "orchestrator.question_answered", subject: key, actor, data: { reason: `A person answered question ${index + 1} of ${questions.length}; ${open} still open.`, index, open } }, at);
      return { released: false, open };
    }
    const reason = `A person answered all ${questions.length} questions: ${answered.map((each) => `${each.index + 1}. ${questions[each.index]!.question} Answered: ${each.answer}`).join(" ")}`;
    return { released: releaseJob(store, item, actor, at, reason), open: 0 };
  });
}

/** Why an answer to a draft is refused: no draft parked on the item (any more), the page read another parked state, or the answers do not fit its questions. */
export type DraftRefusal = "no-draft" | "parked-changed" | "answers";

/** The draft this job is parked on, unsettled. */
export function parkedDraft(job: Job | undefined): Refinement | undefined {
  return job?.parked?.as === "needs-decision" && job.step === "triage" && job.refine && !job.refine.settled ? job.refine : undefined;
}

/** Whether `answers` (one per question, in order) may be given to the draft parked on this job now; null when they may. */
export function draftRefusal(job: Job | undefined, parkedAt: string, answers: readonly string[]): DraftRefusal | null {
  const refine = parkedDraft(job);
  if (!job || !refine) return "no-draft";
  if (Date.parse(parkedAt) !== Date.parse(job.parked!.at)) return "parked-changed";
  if (answers.length !== refine.questions.length || answers.some((answer) => answer.trim() === "")) return "answers";
  return null;
}

/** Whether an answer picks the option labelled `label`: the label itself, or the label with its description after a colon (any case). */
export function picks(answer: string | undefined, label: string): boolean {
  const given = (answer ?? "").trim().toLowerCase();
  const wanted = label.trim().toLowerCase();
  return wanted !== "" && (given === wanted || given.startsWith(`${wanted}:`));
}

/** True when every answer is the recommendation of its question: then the draft, written for those answers, can be settled. */
export function keepsRecommendations(refine: Refinement, answers: readonly string[]): boolean {
  return refine.questions.every((question, index) => picks(answers[index], question.recommendation));
}

/**
 * A person answers a parked draft, in the store transaction the caller holds. Keeping every recommendation, the draft is
 * settled as `action` and the next tick goes on from triage's other verdicts (`afterRefine`); a stopping answer (close as a
 * duplicate, hold for a conflict) is kept with it. Any other answer sends the item back to its triage, which runs again with
 * the answers in its prompt (the caller records them). No round cap.
 */
export function settleDraft(store: Store, item: Ref, answers: readonly string[], action: "accept" | "edit" | "reject", actor: string, at: string, parkedAt: string, written: readonly string[] = []): { refused: DraftRefusal } | { rerun: true } | { settled: NonNullable<Refinement["settled"]> } {
  const jobs = loadJobs(store);
  const key = refKey(item);
  const job = jobs[key];
  const refused = draftRefusal(job, parkedAt, answers);
  if (refused || !job) return { refused: refused ?? "no-draft" };
  const refine = job.refine!;
  delete job.parked;
  delete job.notBefore;
  job.failures = 0;
  if (!keepsRecommendations(refine, answers)) {
    delete job.refine;
    const changed = refine.questions.map((question, index) => ({ question, answer: answers[index]! })).filter((each) => !picks(each.answer, each.question.recommendation));
    saveJobs(store, jobs);
    store.appendEvent({ kind: "orchestrator.draft_answered", subject: key, actor, data: { reason: `A person answered round ${refine.round} of the triage otherwise than recommended (${changed.map((each) => `${each.question.question} Answered: ${each.answer}`).join(" ")}); the triage runs again with the answers.`, round: refine.round } }, at);
    return { rerun: true };
  }
  const settled = action === "accept" ? "accepted" : action === "edit" ? "edited" : "rejected";
  refine.settled = settled;
  if (settled !== "rejected" && job.triaged && written.length > 0) job.triaged = adoptWritten(job.triaged, written);
  const stop = refine.questions.find((question, index) => question.stopsOn !== undefined && picks(answers[index], question.stopsOn));
  if (stop) refine.stop = stop.stopsOn;
  if (stop?.duplicateOf) refine.duplicateOf = stop.duplicateOf;
  saveJobs(store, jobs);
  store.appendEvent({ kind: `orchestrator.draft_${settled}`, subject: key, actor, data: { reason: `A person ${settled} the triage's draft (round ${refine.round}).${stop ? ` Answered: ${stop.stopsOn}.` : ""}`, round: refine.round, original: refine.original, draft: refine.draft } }, at);
  return { settled };
}

/**
 * A person accepted or edited the triage's draft, so Scope Soup wrote the description itself: the text it wrote
 * counts as the text the triage saw, not as an edit. `bodies` are the forms it may have been written in (as given, made inert).
 */
export function adoptWritten(triaged: Triaged, bodies: readonly string[]): Triaged {
  const hashes = bodies.map((body) => itemTextHash({ title: triaged.title, body, verification: triaged.verification }));
  return { ...triaged, also: [...new Set([...(triaged.also ?? []), ...hashes])].slice(-6) };
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// The CLI checks answers against the schema. These checks repeat the parts the cycle relies on,
// because nothing an agent returns is trusted to have the right shape.

function withContext(decision: Decision, context: unknown): Decision {
  if (typeof context === "string" && context.trim()) decision.context = context.trim();
  return decision;
}

function asDecision(value: unknown): Decision | undefined {
  if (!isObj(value) || typeof value.question !== "string" || !value.question.trim()) return undefined;
  return withContext({
    question: value.question,
    options: asOptions(value.options),
    recommendation: typeof value.recommendation === "string" ? value.recommendation : "",
    ...(value.multiSelect === true ? { multiSelect: true as const } : {}),
  }, value.context);
}

/**
 * Tool-call markup inside a string: the model ran fields together. Only `<parameter name=` or a closing tag named
 * after a field of the triage answer counts; an HTML closing tag such as `</summary>` in a reason is ordinary text.
 */
const MARKUP = /<parameter\s+name\s*=|<\/(?:ready|notReadyReason|size|paths|blockers|questions|hidesDecision|decisions|decision|question|options|recommendation|context|proposal|parts|title|description|verification|reason|risk|riskReason|draft|links|aboutOthers)\s*>/;

/** True when any string anywhere in the value holds tool-call markup. */
export function hasMarkup(value: unknown): boolean {
  if (typeof value === "string") return MARKUP.test(value);
  if (Array.isArray(value)) return value.some(hasMarkup);
  if (isObj(value)) return Object.values(value).some(hasMarkup);
  return false;
}

export function asTriage(value: unknown): TriageAnswer | null {
  if (!isObj(value) || typeof value.ready !== "boolean") return null;
  if (hasMarkup(value)) return null;
  // A "not ready" without its reason is not an answer a person can act on.
  if (!value.ready && !(typeof value.notReadyReason === "string" && value.notReadyReason.trim())) return null;
  // The questions, or the `decisions` list or single `decision` an older answer gave.
  const older = Array.isArray(value.decisions) ? value.decisions : value.decision !== undefined ? [value.decision] : [];
  const listed = Array.isArray(value.questions) && (value.questions.length > 0 || older.length === 0) ? value.questions : older;
  const decisions: Decision[] = [];
  // A question left blank is dropped here, so every count (the reason, the log, the page) sees the same list.
  for (const entry of listed as unknown[]) {
    const decision = asDecision(entry);
    if (decision) decisions.push(decision);
  }
  // An older answer that said it hides a decision and named none is not one a person can act on.
  if (value.hidesDecision === true && decisions.length === 0) return null;
  if (value.size !== "small" && value.size !== "medium" && value.size !== "large") return null;
  const answer: TriageAnswer = { ready: value.ready, size: value.size, paths: strings(value.paths) ? value.paths : [], hidesDecision: decisions.length > 0 };
  if (typeof value.notReadyReason === "string") answer.notReadyReason = value.notReadyReason;
  const blockers = strings(value.blockers) ? value.blockers.filter((each) => each.trim()) : [];
  if (blockers.length > 0) answer.blockers = blockers;
  if (decisions.length > 0) {
    answer.decision = decisions[0];
    answer.decisions = decisions;
  }
  // Parts mean something only for an item too large for one change.
  const parts = answer.size === "large" ? asParts(value.parts) : [];
  if (parts.length > 0) answer.parts = parts;
  if (typeof value.draft === "string") answer.draft = value.draft;
  const links = asLinks(value.links);
  if (links.length > 0) answer.links = links;
  const labels = asLabelChange(value.labels);
  if (labels) answer.labels = labels;
  const others = asAboutOthers(value.aboutOthers, true);
  if (others.length > 0) answer.aboutOthers = others;
  return answer;
}

/**
 * The questions about other Items in an answer: each needs an Item and a question, or (`drafts`, triage) a draft. An entry with
 * tool-call markup is dropped. No cap on how many; each text clipped.
 */
export function asAboutOthers(value: unknown, drafts: boolean): AboutOther[] {
  if (!Array.isArray(value)) return [];
  const out: AboutOther[] = [];
  for (const entry of value as unknown[]) {
    if (!isObj(entry) || typeof entry.item !== "string" || !entry.item.trim() || hasMarkup(entry)) continue;
    const questions: Decision[] = [];
    for (const each of Array.isArray(entry.questions) ? (entry.questions as unknown[]) : []) {
      const decision = asDecision(each);
      if (decision) questions.push(decision);
    }
    const draft = drafts && typeof entry.draft === "string" && entry.draft.trim() ? entry.draft.trim().slice(0, 50_000) : undefined;
    if (questions.length === 0 && !draft) continue;
    out.push({ item: entry.item.trim().slice(0, 200), questions, ...(draft ? { draft } : {}) });
  }
  return out;
}

/** The typed links of a triage's answer; an entry of an unknown type or without an item is dropped. */
export function asLinks(value: unknown): ItemLinkAnswer[] {
  if (!Array.isArray(value)) return [];
  const links: ItemLinkAnswer[] = [];
  for (const entry of value as unknown[]) {
    if (!isObj(entry) || !LINK_TYPES.includes(entry.type as LinkType) || typeof entry.item !== "string" || !entry.item.trim()) continue;
    links.push({ type: entry.type as LinkType, item: entry.item.trim().slice(0, 200), ...(typeof entry.reason === "string" && entry.reason.trim() ? { reason: entry.reason.trim().slice(0, 1000) } : {}) });
  }
  return links.slice(0, 50);
}

export function asImplement(value: unknown): ImplementAnswer | null {
  if (!isObj(value) || typeof value.done !== "boolean") return null;
  const answer: ImplementAnswer = { done: value.done, summary: typeof value.summary === "string" ? value.summary : "" };
  // `question`, or `decision` from an older answer or a fix session that was running at the upgrade.
  const decision = asDecision(value.question) ?? asDecision(value.decision);
  if (decision) answer.decision = decision;
  if (typeof value.mergedAs === "string" && value.mergedAs.trim()) answer.mergedAs = value.mergedAs.trim().slice(0, 500);
  const decisions = asTaken(value.decisions);
  if (decisions.length > 0) answer.decisions = decisions;
  const others = asAboutOthers(value.aboutOthers, false);
  if (others.length > 0) answer.aboutOthers = others;
  return answer;
}

/** The decisions of an implementor's answer: each needs a question and what was chosen; at most 20, each text clipped. */
export function asTaken(value: unknown): TakenDecision[] {
  if (!Array.isArray(value)) return [];
  const text = (each: unknown, chars: number): string => (typeof each === "string" ? each.trim().slice(0, chars) : "");
  const out: TakenDecision[] = [];
  for (const entry of value as unknown[]) {
    if (!isObj(entry)) continue;
    const question = text(entry.question, 1000);
    const chosen = text(entry.chosen, 1000);
    if (!question || !chosen) continue;
    const others = Array.isArray(entry.others) ? entry.others.map((each) => text(each, 500)).filter(Boolean).slice(0, 10) : [];
    out.push({ question, chosen, others, why: text(entry.why, 2000) });
  }
  return out.slice(0, 20);
}

/** What the reviewer is told when the implementor recorded no decisions (also the runner's default for `{{decisions}}`). */
export const NO_DECISIONS = "The implementor recorded no decisions of its own.";

/** The decisions as lines for a prompt or a reason. */
export function takenText(decisions: readonly TakenDecision[]): string {
  return decisions.map((each, index) => `${index + 1}. ${each.question} Chose: ${each.chosen}.${each.others.length > 0 ? ` Other options: ${each.others.join("; ")}.` : ""}${each.why ? ` Why: ${each.why}` : ""}`).join("\n");
}

export function asReview(value: unknown): ReviewAnswer | null {
  if (!isObj(value) || (value.verdict !== "approve" && value.verdict !== "changes") || !Array.isArray(value.findings)) return null;
  const findings: Finding[] = [];
  for (const entry of value.findings as unknown[]) {
    if (!isObj(entry) || typeof entry.text !== "string") return null;
    const finding: Finding = { severity: entry.severity === "should" ? "should" : "must", text: entry.text };
    if (typeof entry.file === "string") finding.file = entry.file;
    // A decision that should have been a question is a must, whatever severity came with it.
    if (entry.ask === true) Object.assign(finding, { severity: "must", ask: true });
    findings.push(finding);
  }
  return { verdict: value.verdict, findings };
}

/** How a finding that should have been a question is marked for the implementor (prompts/implement.md names it). */
export const ASK_PERSON = "ask a person";

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "(none listed)";
  return findings.map((finding) => `- [${finding.severity}${finding.ask ? `, ${ASK_PERSON}` : ""}]${finding.file ? ` ${finding.file}:` : ""} ${finding.text}`).join("\n");
}
