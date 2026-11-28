// The job: where one work item stands in the cycle triage -> implement -> review -> (implement
// resumed with the findings -> review)* -> hand over. Kept in the store so a restart resumes instead of forgetting.

import type { FenceSeen } from "../core/fence.ts";
import type { DecisionOption, ItemLinkAnswer, LabelChange, LinkType, LogRecord, OriginalFate, ProposedPart, Ref, Restructuring, WorkItem } from "../model/types.ts";
import { asOptions, asRestructuring, refKey } from "../model/types.ts";
import { asLabelChange } from "../model/labels.ts";
import type { Store } from "../store/store.ts";
import { itemTextHash } from "../core/answerReuse.ts";
import type { ProposedDraft } from "./drafts.ts";
import { resumesStep as phaseResumes } from "../core/phase.ts";
import { phaseOf } from "./phase.ts";
import { asDrafts } from "./drafts.ts";

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
   * A question made from a `duplicateOf` or `conflictsWith` link: the answer that stops the Item once the rewrite is settled
   * (close as a duplicate, or hold until the other Item is done). Picking it counts as keeping the rewrite, like a recommendation.
   */
  stopsOn?: string;
  /** With `stopsOn`, from a `duplicateOf` link: the Item it duplicates, so the host can close it as that one's duplicate. */
  duplicateOf?: Ref;
  /** With `stopsOn`, from a `conflictsWith` link: the Item this one is then blocked by. */
  holdFor?: Ref;
}

/** How the triage says this Item relates to another. Only `blockedBy` is acted on by itself (and on GitHub, `blocks`). */
export const LINK_TYPES: readonly LinkType[] = ["blockedBy", "blocks", "duplicateOf", "conflictsWith", "related"];
export type { ItemLinkAnswer, LinkType };

/**
 * The triage's rewrite of the Item's description, parked for a person with its questions (each recommendation
 * pre-selected on the Item page). Keeping every recommendation, a person accepts, edits or rejects the rewrite in one action;
 * any other answer runs the triage again with the answers.
 */
export interface Rewrite {
  /** The description as the triage read it. */
  original: string;
  /** The description written as if a person takes every recommendation. */
  text: string;
  /** Triage's questions, then the ones made from duplicate and conflict links. */
  questions: Decision[];
  /** Which round of the loop this rewrite is (1 for the first). There is no cap. */
  round: number;
  /** The label changes proposed with the rewrite, kept to the repository's labels; applied with it at Accept or Edit. */
  labels?: LabelChange;
  /** Labels the triage named that the repository does not have: dropped and noted. */
  droppedLabels?: string[];
  /**
   * The rewrite and questions came from agents working on other Items (`aboutOthers`), named here ("triage of A-3"). Once a
   * person settles them, this Item is triaged again with the answers.
   */
  askedBy?: string[];
}

/** A rewrite a person settled (`as`): the next tick goes on from triage's other verdicts (split, not ready, implement). */
export interface SettledRewrite {
  rewrite: Rewrite;
  as: "accepted" | "edited" | "rejected";
  /**
   * An answer picked a question's `stopsOn` (`answer`): close as a duplicate of `duplicateOf`, or hold until `holdFor` is done (it
   * becomes blocked by that Item).
   */
  stop?: { answer: string; duplicateOf?: Ref; holdFor?: Ref };
}

/** An answer to one of several questions: `index` is the question's place in their list. */
export type Answered = { index: number; answer: string; at: string };

/**
 * What a job parked for a person's decision asks (#211 section 4): one value, kept with the parked state it belongs to, so answers to an
 * earlier ask cannot count for this one. Parked on a decision without one, the parked reason is the question.
 */
export type Ask =
  /** One question: a triage's only one, an implementor's, the fence's split. */
  | { is: "question"; decision: Decision }
  /** Triage's questions, two or more, each answered on its own (`answered` so far); the last answer releases the job. */
  | { is: "questions"; list: Decision[]; answered?: Answered[] }
  /** The triage's rewrite of the description with its questions, answered together with Accept, Edit or Reject; `posted` on the host. */
  | { is: "rewrite"; rewrite: Rewrite; posted?: RewritePosted }
  /** A restructuring triage proposed. */
  | { is: "restructuring"; proposal: Proposal };

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Whether two texts are the same when every run of whitespace counts as one space (a paragraph break, a trailing space). */
export function sameText(a: string, b: string): boolean {
  return squash(a) === squash(b);
}

const VERIFICATION_LABEL = /(^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?verification(?:\*\*|__)?[ \t]*:?[ \t]*(?:\*\*|__)?/gi;

/** The text without a last "Verification: ..." part (a heading or a label) that repeats the Item's verification; else the text. */
export function withoutVerification(text: string, verification: string | undefined): string {
  const wanted = squash(verification ?? "");
  if (!wanted) return text;
  for (const found of [...text.matchAll(VERIFICATION_LABEL)].reverse()) {
    if (squash(text.slice(found.index + found[0].length)) === wanted) return text.slice(0, found.index).trimEnd();
  }
  return text;
}

/**
 * A triage's rewrite of a description as it is kept, or "" when it changes nothing: whitespace does not count, and a Verification
 * part the rewrite appended that repeats the Item's verification field (a separate field) is cut first, unless the description has it.
 */
export function changedRewrite(rewrite: string | undefined, body: string | undefined, verification: string | undefined): string {
  const original = (body ?? "").trim();
  let text = (rewrite ?? "").trim();
  if (withoutVerification(original, verification) === original) text = withoutVerification(text, verification);
  return text === "" || sameText(text, original) ? "" : text;
}

/**
 * Questions an agent asks about another Item than its own (`aboutOthers` in its answer), and from triage a rewrite of that Item's
 * description. Scope Soup writes them on that Item (`aboutOthers.ts`). Agent text: data.
 */
export interface AboutOther {
  /** The other Item as the agent named it (`#12`, `12`, `A-3`). */
  item: string;
  questions: Decision[];
  /** Triage only. */
  rewrite?: string;
}

/** A proposed restructuring (decision 94): a person accepts, edits or rejects it on the item page. */
export type Proposal = Restructuring;

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
  /** A restructuring triage proposes: where each part goes and what becomes of the Item, with why. */
  restructure?: { reason: string; original: OriginalFate; parts: ProposedPart[] };
  /** The description rewritten as if a person takes every recommendation. Absent in answers from earlier. */
  rewrite?: string;
  /** Typed links to other Items. */
  links?: ItemLinkAnswer[];
  /** Labels the triage proposes to add and remove, as it wrote them (checked against the repository's labels later). */
  labels?: LabelChange;
  /** Questions about other Items, each with a rewrite of that Item's description when it needs one. */
  aboutOthers?: AboutOther[];
  /** New Items it proposes, filed as drafts for a person (decision 95). */
  drafts?: ProposedDraft[];
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
  /** Questions about other Items (never a rewrite). */
  aboutOthers?: AboutOther[];
  /** New Items it proposes, filed as drafts for a person (decision 95). */
  drafts?: ProposedDraft[];
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
  /** New Items it proposes, filed as drafts for a person (decision 95). */
  drafts?: ProposedDraft[];
}

/** A job parked: why, since when, and what it asked on the host. */
export interface JobParked {
  as: ParkedAs; reason: string; at: string;
  /**
   * "hand-over": the work is finished; only the hand-over failed and is retried when a person answers. "post": the parked state's
   * questions or rewrite could not be posted on the host for a reason that can change (down, a 5xx, a rate limit); each tick posts
   * them again by itself.
   */
  retry?: "hand-over" | "post";
  /** With `retry: "post"`, the parked state's own reason, which it shows again once the post is through. */
  posting?: string;
  /** With `retry: "post"`, the parked state's own kind when it was not a question set (a log line that could not be written; #230). */
  postingAs?: ParkedAs;
  /** Parked "not-ready" by triage's verdict (not ready, or too large): a person may overrule it with Implement anyway. */
  verdict?: true;
  /** The implement step itself was parked here (a question, a refused tool, failed attempts), not the hand-over, merging or a person closing the change. Only such a parked Item is resumed by an answer. */
  byStep?: true;
  /** The question comments on the host (GitHub) this parked state waits on, in the order asked; their answers are read from the host. */
  questions?: string[];
  /** The text and number of each of `questions`, in the same order, so a deleted one can be named and its number kept. */
  texts?: AskedText[];
  /** The host's time of the last question comment, so an older read of the item is not taken for a deletion. */
  askedAt?: string;
}

/** The triage round's rewrite comment on the host (GitHub) and its question comments, which a person answers on the board. */
export interface RewritePosted {
  id: string;
  questions: string[];
  /** As `JobParked.texts`. */
  texts?: AskedText[];
  /** The host's time of the last question comment. */
  askedAt?: string;
  /** Each question has its answer from a reply on the host, all the recommendations: the rewrite waits for Accept on the board. */
  answered?: true;
}

export interface Job {
  /** Where the job is: read with `stepAt`, `parkedOf` and the like or a switch on it, and changed only by the moves below. */
  at: JobAt;
  /** The implement session started last: the level it started at, and whether its finish text told it to merge (decision 108). */
  sessionStart?: { level: number; mayMerge: boolean };
  /** Sessions of this step left by an earlier run of Scope Soup in a row (`Session.orphaned`); at the attempts' limit a person is asked. */
  orphanRestarts?: number;
  item: Ref;
  workspace: string;
  branch: string;
  /** Failed attempts of the current step. */
  failures: number;
  /** How many times review (or a failed merging) sent the change back to the implementor. */
  fixRounds: number;
  /** How many times the job parked: each park's questions in the item's log carry it as their `set`, which replaces the set before (#230). */
  parks?: number;
  /** The implementor's own agent session id (to resume it), kept so findings go back to the session that wrote the change. */
  agentSession?: string;
  /**
   * What the implementor is told next: the review's findings, a failed merging or a person's note. The implement step
   * resumes `agentSession` with it; without a known session it starts afresh with this after its prompt. Cleared when done.
   */
  resumeWith?: string;
  /** Levels 2 and 3: where the remote's main was when the item's first implement session started. A branch head already in it is no work done. */
  base?: string;
  /** Where main was once this round's implement session started (its branch cut): a head new in main since then was merged by it. */
  roundBase?: string;
  triage?: TriageAnswer;
  /** How many times a recorded answer was reused for a question an implementer or fixer asked again (capped, so a step cannot loop). */
  reusedAnswers?: number;
  /** Rounds of the rewrite loop so far on this job: each new rewrite counts up from it. */
  rewriteRounds?: number;
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
  /** The branch head `review` was given on, so an approval counts only for that revision (a person's "Merge queue" on the board). */
  reviewedHead?: string;
  /** A person's pick on the board that the job carries out, at most one: read with `pickedFor`, changed only by the moves below. */
  pick?: JobPick;
  /**
   * The tick has seen this job's Item in To do. Read in Backlog after that, another machine's person moved it there, and the job is
   * given up as a move to Backlog here gives it up (#243). A job never seen in To do (a person's Triage pick in Backlog and what
   * follows, or work a person put under way whose move to To do the store has not read yet) goes on as decision 121 says.
   */
  seenInTodo?: true;
  /**
   * The job was made by questions other Items' agents asked about this Item (`writeAboutOthers`), not by a person's pick. In Backlog its
   * triage does not run again with the answers (decision 121): the tick closes it, and the answers wait for the triage after a move to To do.
   */
  othersAsked?: true;
  /** How many times review sent the change back with `changes` (not merging failures): the step-up of the implementor's model reads it. */
  reviewSendBacks?: number;
  /** The model the last implement session started on, so a step-up is said once, when the model changes (decision 105). */
  implementModel?: string;
  /**
   * The progress guards' memory. `must` and `findings`: the `must` findings of the last review round that asked for changes
   * (their count and `findingKey`s), cleared by an approval. `mergeQueue`: the last merging failure's key (`failureKey`).
   */
  progress?: { must?: number; findings?: string[]; mergeQueue?: string };
  /**
   * With `review.shouldFindings: "fix"`: the `findingKey`s of the `should` findings of an approval sent back to the implementor. They
   * go back once; what an approval still says `should` after that merges and becomes a draft (decision 95).
   */
  shouldSent?: string[];
  /** The change a person saw at the fence and let go on (its paths and lines): the fence is widened to it. */
  fence?: FenceSeen;
  /** The branch's head as last written to the item's log in a `revision` line. */
  head?: string;
  /** Level 4: the head of the branch that was handed to the queue. */
  queued?: string;
  /**
   * Level 4: the head the merge queue sent back (its check failed with it, or it conflicted). That revision is never handed to the
   * queue again: the implementor's fix round makes a new one first. Cleared when a new revision is handed over.
   */
  sentBack?: string;
  /** The Item's text as the running triage was given it, kept for `triaged` when its answer is taken. */
  triaging?: TriagedText;
  /** What the newest triage saw, so a waiting Item whose triage is out of date gets one again (`staleTriage`). */
  triaged?: Triaged;
  startedAt: string;
}

/**
 * What a person picked (decision 104): a move on the board, Abandoned, or Try again on a failed hand-over (`hand-over`).
 * - `triage`, `in-review`, `implement` (Implement anyway): that step runs whatever the level; settled with the step, or by a park.
 * - `merge-queue`: the hand-over reads the branch's head again and gives the change to the queue only at the revision the reviewer
 *   approved; taken by the hand-over.
 * - `hand-over`: the owed hand-over is made as this person asked (said in its event); taken by the hand-over.
 * - `todo`: the tick drops the job once no session runs, and gives back its claim and workspace.
 * - `abandoned`: nothing beyond ending the session that ran.
 */
export type PickTo = "triage" | "implement" | "in-review" | "merge-queue" | "hand-over" | "todo" | "abandoned";

/**
 * A person's pick the job carries out. One at a time: a later pick replaces it. `ending`: when it was picked while a step session ran
 * (or one picked before it still is to be ended), the moment of that pick: the tick ends the session at once, the way Stop does, and
 * does not settle its result; then the job goes on as the pick left it.
 */
export type JobPick = { by: string; to: PickTo; ending?: string };

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
  /** Hashes of texts Scope Soup wrote itself since (an accepted or edited rewrite): seeing one of them is no edit. */
  also?: string[];
  /** The ref keys of the open Items its answer's links named; one closed since is new input (#217). */
  linked?: string[];
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
  /** Chosen within the re-triage share while the Item waits in To do (#217), not just before its implement step. */
  background?: true;
}

/** A question as it was posted on the host: its text and its number there (`Qn`). */
export interface AskedText {
  question: string;
  n?: number;
}

export type Jobs = Record<string, Job>;

/**
 * A step's session: waiting to start, or running. A waiting step starts no earlier than `notBefore` (a retry timer, the pause between
 * steps, a limit's reset) and resumes `resume`, the agent session a limit or a stop cut off.
 */
export type StepRun =
  | { is: "waiting"; notBefore?: string; writing?: TextWritten; resume?: string }
  /** `owes`: a person's Merge queue ends this session; once the tick has ended it, the hand-over follows. */
  | { is: "running"; session: string; owes?: "hand-over"; writing?: TextWritten };

/**
 * The description Scope Soup wrote on the host at `at`, while the store may still read the text before it (`from`, its hash): the next
 * step waits for it to be read back. Kept through a session, a parked state and an owed hand-over, which the next step follows.
 */
export type TextWritten = { from: string; at: string };

/**
 * Where the job is, as it is stored: one case each, carrying only what that case needs. A step runs or waits for its session; parked
 * keeps the step it parked at (an answer may resume it); the hand-over is owed; merged is the end. A combination nobody meant (parked
 * and running, owed and parked, merged at a step with a session) cannot be stored.
 */
export type JobAt =
  /**
   * `recheck`: the triage runs again, told why and what changed since the one before. `settled`: a person settled the rewrite it parked
   * on; the next tick goes on from it without a session.
   */
  | { kind: "triage"; run: StepRun; recheck?: Recheck; settled?: SettledRewrite }
  /**
   * `merge`: level 3, the reviewer approved, so this step merges (the implementor's session resumed, or a fresh one told to). `shouldRound`:
   * this round is for the review's `should` findings, and one that commits nothing goes on to the merge.
   */
  | { kind: "implement"; run: StepRun; merge?: true; shouldRound?: true }
  | { kind: "review"; run: StepRun }
  /** `ask`: what it asks a person, parked on a decision (kept while posting it is tried again, or escalated). */
  | { kind: "parked"; step: JobStep; parked: JobParked; ask?: Ask; merge?: true; shouldRound?: true; writing?: TextWritten }
  /** `merge`: the reviewer approved it at level 3, so an answer to a failed hand-over resumes the implementor to merge. */
  | { kind: "hand-over"; step: JobStep; merge?: true; writing?: TextWritten }
  /**
   * `sha`: the change's commit on main. `closeOwed`: closing the Item on the host failed, and each tick tries again (#238). `parked`: what
   * it was parked as when it merged (queued, mostly).
   */
  | { kind: "merged"; step: JobStep; sha: string; closeOwed?: { sha: string; batch?: number }; parked?: JobParked };

type StepCase = Extract<JobAt, { kind: JobStep }>;
type Waiting = Extract<StepRun, { is: "waiting" }>;

const isStepCase = (at: JobAt): at is StepCase => at.kind === "triage" || at.kind === "implement" || at.kind === "review";

/** The step the job is at: the one it runs or waits for, or the one it parked, owes its hand-over or merged at. */
export function stepAt(job: Job): JobStep {
  return isStepCase(job.at) ? job.at.kind : job.at.step;
}

/** The session the job runs now, if any. */
export function sessionIdOf(job: Job | null | undefined): string | undefined {
  const at = job?.at;
  return at && isStepCase(at) && at.run.is === "running" ? at.run.session : undefined;
}

/** The run of a step that waits to start (its timer, the session it resumes, the text it waits for), if the job is at one. */
export function waitingOf(job: Job | null | undefined): Waiting | undefined {
  const at = job?.at;
  return at && isStepCase(at) && at.run.is === "waiting" ? at.run : undefined;
}

/** What the job is parked on; for a merged job, what it was parked as when it merged (queued, mostly). */
export function parkedOf(job: Job | null | undefined): JobParked | undefined {
  const at = job?.at;
  return at?.kind === "parked" || at?.kind === "merged" ? at.parked : undefined;
}

/** Level 3: the reviewer approved, so the implement step (or an answer to its failed hand-over) merges it. */
export function mergeApproved(job: Job): boolean {
  return marksOf(job.at).merge === true;
}

/** The step running now is the round for the review's `should` findings. */
export function shouldRoundOf(job: Job): boolean {
  return marksOf(job.at).shouldRound === true;
}

/** The hand-over is owed: now, or once the session that runs is over. */
export function owesHandOver(job: Job | null | undefined): boolean {
  const at = job?.at;
  return at?.kind === "hand-over" || (at !== undefined && isStepCase(at) && at.run.is === "running" && at.run.owes !== undefined);
}

/** What the parked job asks a person, if it parked on a decision. */
export function askOf(job: Job | null | undefined): Ask | undefined {
  return job?.at.kind === "parked" ? job.at.ask : undefined;
}

/** The rewrite a person settled, which the next tick goes on from, if the job is at that triage. */
export function settledOf(job: Job | null | undefined): SettledRewrite | undefined {
  return job?.at.kind === "triage" ? job.at.settled : undefined;
}

/** The triage's rewrite the job is parked on, or one a person settled that the next tick goes on from. */
export function rewriteOf(job: Job | null | undefined): Rewrite | undefined {
  const ask = askOf(job);
  return ask?.is === "rewrite" ? ask.rewrite : settledOf(job)?.rewrite;
}

/** The rewrite comment and its question comments on the host, for the rewrite the job is parked on, if they were posted. */
export function rewritePosted(job: Job | null | undefined): RewritePosted | undefined {
  const ask = askOf(job);
  return ask?.is === "rewrite" ? ask.posted : undefined;
}

/** The answers so far to the job's several questions. */
export function answeredOf(job: Job | null | undefined): Answered[] {
  const ask = askOf(job);
  return ask?.is === "questions" ? ask.answered ?? [] : [];
}

/** The description Scope Soup wrote that the next step waits to read back, if any. */
export function writingOf(job: Job | null | undefined): TextWritten | undefined {
  const at = job?.at;
  if (!at || at.kind === "merged") return undefined;
  return at.kind === "parked" || at.kind === "hand-over" ? at.writing : at.run.writing;
}

/** The person whose pick of `to` the job carries out, if that is its pick. */
export function pickedFor(job: Job | null | undefined, to: PickTo): string | undefined {
  return job?.pick?.to === to ? job.pick.by : undefined;
}

/** The pick that runs `step` whatever the level (Triage, Implement anyway, In review). */
export const STEP_PICK: Record<JobStep, PickTo> = { triage: "triage", implement: "implement", review: "in-review" };

/**
 * A person picks `to`. It replaces the pick before; a session that pick was to end is still ended, and `ending` (the moment, when a
 * step session runs now) says this pick ends one.
 */
export function pick(job: Job, by: string, to: PickTo, ending?: string): void {
  const ends = ending ?? job.pick?.ending;
  job.pick = { by, to, ...(ends ? { ending: ends } : {}) };
}

/** The pick is carried out, or no longer stands, if it is one of `tos`: the job has no pick then. */
export function pickDone(job: Job, ...tos: PickTo[]): void {
  if (job.pick && tos.includes(job.pick.to)) delete job.pick;
}

/** The session the pick was to end is over (or given up on): what is left of the pick is its move; Abandoned has none. */
export function endingOver(job: Job): void {
  if (!job.pick?.ending) return;
  const { ending: _ending, ...rest } = job.pick;
  if (rest.to === "abandoned") delete job.pick;
  else job.pick = rest;
}

// Moving a job. Each move builds the case it goes to from the one it is in, so what a case keeps is said here and nowhere else. A move
// asked of a case its callers are never in throws: the tick fails with `orchestrator.tick_failed` and goes on at the next one, rather
// than storing a case nobody meant.

function impossible(move: string, at: JobAt): never {
  throw new Error(`${move}: a job that is ${at.kind}${isStepCase(at) ? ` (${at.run.is})` : ""} cannot move so.`);
}

/** The job's case, which must be a step that waits to start. */
function waitingStep(at: JobAt, move: string): StepCase & { run: Waiting } {
  return isStepCase(at) && at.run.is === "waiting" ? (at as StepCase & { run: Waiting }) : impossible(move, at);
}

/** The approval to merge and the round for the `should` findings that a case carries. */
function marksOf(at: JobAt): { merge?: true; shouldRound?: true } {
  const merge = at.kind === "implement" || at.kind === "parked" || at.kind === "hand-over" ? at.merge : undefined;
  const shouldRound = at.kind === "implement" || at.kind === "parked" ? at.shouldRound : undefined;
  return { ...(merge ? { merge } : {}), ...(shouldRound ? { shouldRound } : {}) };
}

/** A step case; what the step carries beside its run is kept only when the job stays at that step, unless `marks` says it. */
function stepCase(step: JobStep, run: StepRun, from?: JobAt, marks: { merge?: true; shouldRound?: true } = {}): StepCase {
  switch (step) {
    case "triage":
      return { kind: "triage", run, ...(from?.kind === "triage" && from.recheck ? { recheck: from.recheck } : {}), ...(from?.kind === "triage" && from.settled ? { settled: from.settled } : {}) };
    case "implement":
      return { kind: "implement", run, ...(from?.kind === "implement" ? marksOf(from) : {}), ...marks };
    case "review":
      return { kind: "review", run };
  }
}

/** A step that waits to start, with nothing to resume and no timer: where a new job begins. */
export function atStep(step: JobStep, run: StepRun = { is: "waiting" }): JobAt {
  return stepCase(step, run);
}

const waitingRun = (writing: TextWritten | undefined, notBefore?: string, resume?: string): Waiting =>
  ({ is: "waiting", ...(notBefore ? { notBefore } : {}), ...(writing ? { writing } : {}), ...(resume ? { resume } : {}) });

/** An owed hand-over at `step`, with the approval to merge `from` carries. */
function handOverCase(step: JobStep, from: JobAt, writing: TextWritten | undefined): JobAt {
  const merge = marksOf(from).merge;
  return { kind: "hand-over", step, ...(merge ? { merge } : {}), ...(writing ? { writing } : {}) };
}

/** The step waits for nothing but its start, with the parked job's or owed hand-over's text wait and approval. */
function backAtStep(at: Extract<JobAt, { kind: "parked" | "hand-over" }>): StepCase {
  return stepCase(at.step, waitingRun(at.writing), at, at.step === "implement" ? marksOf(at) : {});
}

/** A session starts on the step that waits. */
export function startSession(job: Job, session: string): void {
  const at = waitingStep(job.at, "startSession");
  job.at = stepCase(at.kind, { is: "running", session, ...(at.run.writing ? { writing: at.run.writing } : {}) }, at);
}

/**
 * The session is over, or a waiting step's session is no longer to be resumed: the step waits again, or the hand-over a person asked
 * for while it ran is owed now. A job with no step run (parked, owed, merged: an Item closed then) has none to end.
 */
export function endSession(job: Job): void {
  const at = job.at;
  if (!isStepCase(at)) return;
  if (at.run.is === "running" && at.run.owes) job.at = handOverCase(at.kind, at, at.run.writing);
  else job.at = stepCase(at.kind, waitingRun(at.run.writing, at.run.is === "waiting" ? at.run.notBefore : undefined), at);
}

/** The waiting step starts no earlier than `notBefore`, and then resumes `resume` if given. */
export function wait(job: Job, notBefore: string, resume?: string): void {
  const at = waitingStep(job.at, "wait");
  job.at = stepCase(at.kind, waitingRun(at.run.writing, notBefore, resume), at);
}

/**
 * Parks the job at its step, ending its session, asking `ask` (what a park on a decision asks; it replaces what it asked before). A
 * merged job keeps what it is parked as beside the merge, and asks nothing.
 */
export function parkJob(job: Job, parked: JobParked, ask?: Ask): void {
  job.at = parkedFrom(job.at, parked, ask);
}

function parkedFrom(at: JobAt, parked: JobParked, ask: Ask | undefined): JobAt {
  switch (at.kind) {
    case "merged":
      return { ...at, parked };
    case "parked": {
      const { ask: _ask, ...rest } = at;
      return { ...rest, parked, ...(ask ? { ask } : {}) };
    }
    case "hand-over":
      return impossible("parkJob", at);
    case "triage":
    case "implement":
    case "review":
      // A session a person's Merge queue is ending, still there while the tick waits for it to go (a lost claim parks it then): the
      // hand-over it asked for is owed now.
      if (at.run.is === "running" && at.run.owes) return handOverCase(at.kind, at, at.run.writing);
      return { kind: "parked", step: at.kind, parked, ...(ask ? { ask } : {}), ...marksOf(at), ...(at.run.writing ? { writing: at.run.writing } : {}) };
  }
}

/** What a parked job is parked on, replaced: its posted questions, a note, an escalation that it could not be posted. */
export function editParked(job: Job, parked: JobParked): void {
  if (job.at.kind !== "parked") impossible("editParked", job.at);
  job.at = { ...job.at, parked };
}

/** The answers so far to the parked job's several questions. */
export function recordAnswers(job: Job, answered: Answered[]): void {
  const at = job.at;
  if (at.kind !== "parked" || at.ask?.is !== "questions") return impossible("recordAnswers", at);
  job.at = { ...at, ask: { ...at.ask, answered } };
}

/** The rewrite the job is parked on is (or its questions are answered) on the host as `posted`. A job asking no rewrite has none. */
export function postRewrite(job: Job, posted: RewritePosted): void {
  const at = job.at;
  if (at.kind === "parked" && at.ask?.is === "rewrite") job.at = { ...at, ask: { ...at.ask, posted } };
}

/** A person settled the rewrite the job is parked on: its triage waits, and the next tick goes on from `settled` without a session. */
export function settleAsked(job: Job, settled: SettledRewrite): void {
  const at = job.at;
  if (at.kind !== "parked" || at.ask?.is !== "rewrite") return impossible("settleAsked", at);
  const back = backAtStep(at);
  job.at = back.kind === "triage" ? { ...back, settled } : back;
}

/** The rewrite a person settled, taken up by the tick (or no longer to go on from): the triage waits for nothing more of it. */
export function takeSettled(job: Job): SettledRewrite | undefined {
  const at = job.at;
  if (at.kind !== "triage" || !at.settled) return undefined;
  const { settled, ...rest } = at;
  job.at = rest;
  return settled;
}

/**
 * The parked job is let go: its step waits to start again (`then: "step"`), or the hand-over it failed is owed again. A merged job
 * forgets what it was parked as.
 */
export function release(job: Job, then: "step" | "hand-over" = "step"): void {
  const at = job.at;
  if (at.kind === "merged") {
    const { parked: _parked, ...rest } = at;
    job.at = rest;
  } else if (at.kind === "parked") job.at = then === "step" ? backAtStep(at) : handOverCase(at.step, at, at.writing);
  else impossible("release", at);
}

/**
 * The waiting job goes on to `step`, not before `notBefore`, with the approval to merge or the `should` round if told. Staying at the
 * same step keeps what that step carries.
 */
export function nextStep(job: Job, step: JobStep, notBefore?: string, told: { merge?: true; shouldRound?: true } = {}): void {
  const at = waitingStep(job.at, "nextStep");
  job.at = stepCase(step, waitingRun(at.run.writing, notBefore), at, told);
}

/**
 * The job goes back to its triage, for `recheck` or afresh, with no timer and no approval to merge: a waiting step waits for the triage,
 * a parked job stays parked (at triage).
 */
export function toTriage(job: Job, recheck?: Recheck): void {
  const at = job.at;
  if (at.kind === "parked") {
    const { merge: _merge, ...rest } = at;
    job.at = { ...rest, step: "triage" };
    return;
  }
  const waiting = waitingStep(at, "toTriage");
  const settled = waiting.kind === "triage" ? waiting.settled : undefined;
  job.at = { kind: "triage", run: waitingRun(waiting.run.writing), ...(recheck ? { recheck } : {}), ...(settled ? { settled } : {}) };
}

/**
 * A person's In review or Merge queue pick (`owe`): the job is at review, no longer parked and with no timer or approval to merge. A
 * session that runs goes on until the tick ends it, with the hand-over owed after it for Merge queue.
 */
export function toReview(job: Job, owe: boolean): void {
  const at = job.at;
  if (at.kind === "merged") impossible("toReview", at);
  if (isStepCase(at) && at.run.is === "running") {
    const writing = at.run.writing;
    job.at = { kind: "review", run: { is: "running", session: at.run.session, ...(owe ? { owes: "hand-over" as const } : {}), ...(writing ? { writing } : {}) } };
    return;
  }
  const writing = writingOf(job);
  job.at = owe ? { kind: "hand-over", step: "review", ...(writing ? { writing } : {}) } : { kind: "review", run: waitingRun(writing) };
}

/** The waiting step's hand-over is owed instead, made by the next tick without a session. */
export function oweHandOver(job: Job): void {
  const at = waitingStep(job.at, "oweHandOver");
  job.at = handOverCase(at.kind, at, at.run.writing);
}

/** The owed hand-over is taken up (or no longer owed): the step waits again; a session that runs no longer ends in one. */
export function handOverTaken(job: Job): void {
  const at = job.at;
  if (at.kind === "hand-over") job.at = backAtStep(at);
  else if (isStepCase(at) && at.run.is === "running" && at.run.owes) {
    const { owes: _owes, ...run } = at.run;
    job.at = { ...at, run };
  }
}

/** The change is on main as `sha`. What the job was parked as stays beside it. */
export function markMerged(job: Job, sha: string): void {
  const at = job.at;
  if (at.kind === "merged") impossible("markMerged", at);
  job.at = { kind: "merged", step: stepAt(job), sha, ...(at.kind === "parked" ? { parked: at.parked } : {}) };
}

/** Closing the merged Item on the host is owed (`close`), or taken (undefined). */
export function oweClose(job: Job, close: { sha: string; batch?: number } | undefined): void {
  const at = job.at;
  if (at.kind !== "merged") return impossible("oweClose", at);
  const { closeOwed: _owed, ...rest } = at;
  job.at = close ? { ...rest, closeOwed: close } : rest;
}

/** The reviewer's approval to merge, or the round for the `should` findings, no longer holds. */
export function dropMark(job: Job, mark: "merge" | "shouldRound"): void {
  const at = job.at;
  if ((at.kind === "implement" || at.kind === "parked" || (mark === "merge" && at.kind === "hand-over")) && marksOf(at)[mark]) {
    const { [mark]: _dropped, ...rest } = at as JobAt & { merge?: true; shouldRound?: true };
    job.at = rest as JobAt;
  }
}

/** The next step waits until `written` is read back, or (undefined) no longer. A merged job has no next step. */
export function awaitText(job: Job, written: TextWritten | undefined): void {
  const at = job.at;
  if (at.kind === "merged") return;
  if (at.kind === "parked" || at.kind === "hand-over") {
    const { writing: _w, ...rest } = at;
    job.at = written ? { ...rest, writing: written } : rest;
    return;
  }
  const { writing: _w, ...run } = at.run;
  job.at = { ...at, run: written ? { ...run, writing: written } : run } as StepCase;
}

/** A job's fields other than where it is. */
export type JobFields = Omit<Job, "at">;

/** The job as stored, or null when it is not of the stored shape (an older one): such a job is dropped, not read (decision 136). */
function parseJob(value: unknown): Job | null {
  if (typeof value !== "object" || value === null) return null;
  const job = value as Partial<Job> & Record<string, unknown>;
  const at = job.at as Partial<JobAt> | undefined;
  if (!job.item || typeof job.branch !== "string" || typeof at !== "object" || at === null) return null;
  switch (at.kind) {
    case "triage":
    case "implement":
    case "review":
      return typeof at.run === "object" && at.run !== null && (at.run.is === "waiting" || (at.run.is === "running" && typeof at.run.session === "string")) ? (job as Job) : null;
    case "parked":
      return isStep(at.step) && isParked(at.parked) ? (job as Job) : null;
    case "hand-over":
      return isStep(at.step) ? (job as Job) : null;
    case "merged":
      return isStep(at.step) && typeof at.sha === "string" && (at.parked === undefined || isParked(at.parked)) ? (job as Job) : null;
    default:
      return null;
  }
}

const isStep = (value: unknown): value is JobStep => value === "triage" || value === "implement" || value === "review";
const PARKED_AS: readonly ParkedAs[] = ["queued", "handed-over", "needs-decision", "not-ready", "escalated"];
const isParked = (value: unknown): value is JobParked =>
  typeof value === "object" && value !== null && PARKED_AS.includes((value as JobParked).as) && typeof (value as JobParked).reason === "string" && typeof (value as JobParked).at === "string";

const KEY = "orchestrator.jobs";

function readRaw(store: Store): Record<string, unknown> {
  const text = store.getValue(KEY);
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The stored jobs that have the stored shape; the others are left for `dropUnreadable`. */
function readStored(store: Store): Jobs {
  const jobs: Jobs = {};
  for (const [key, value] of Object.entries(readRaw(store))) {
    const job = parseJob(value);
    if (job) jobs[key] = job;
  }
  return jobs;
}

/** The keys of stored jobs that do not have the stored shape. */
function unreadable(store: Store): string[] {
  return Object.entries(readRaw(store)).filter(([, value]) => !parseJob(value)).map(([key]) => key);
}

/**
 * Drops the stored jobs that do not have the stored shape (a job an older Scope Soup wrote), each with an event, as a lost store loses
 * them: the Item is rebuilt from its log or starts again at triage (decision 136). No older shape is read. Call it in a transaction.
 */
export function dropUnreadable(store: Store, at: string): void {
  const gone = unreadable(store);
  if (gone.length === 0) return;
  const raw = readRaw(store);
  for (const key of gone) delete raw[key];
  store.setValue(KEY, JSON.stringify(raw));
  for (const key of gone) {
    store.appendEvent({ kind: "orchestrator.job_unreadable", subject: key, actor: "orchestrator", data: { reason: `The stored job of ${key} is of an older shape, which this Scope Soup does not read: it is dropped, and the Item is rebuilt from its log or starts again at triage.` } }, at);
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

/** Whether someone else (the server: a person's pick, an answer) changed the job in the store since `jobs` was loaded or last saved. */
export function changedInStore(store: Store, jobs: Jobs, key: string): boolean {
  const base = baselines.get(jobs);
  if (!base) return false;
  const stored = readStored(store)[key];
  return (stored === undefined ? undefined : JSON.stringify(stored)) !== base.get(key);
}

/**
 * What someone else did to the job in the store since `jobs` was loaded or last saved: nothing, a person's pick (decision 104: it
 * asks for an interrupt or a drop, or changes the step, the kind of case or what the job is parked on), or another change (an answer, a
 * hold).
 */
export function changedMeanwhile(store: Store, jobs: Jobs, key: string, starting?: Job): "none" | "picked" | "changed" {
  // A save since the tick took the job it is `starting` (another Item's start) may have read someone else's change into the map and
  // its baseline: the map then holds another job than that one, and the change is told against the job the tick took.
  const folded = starting !== undefined && jobs[key] !== starting;
  if (!folded && !changedInStore(store, jobs, key)) return "none";
  const stored = readStored(store)[key];
  const text = baselines.get(jobs)?.get(key);
  const was = folded ? starting : text === undefined ? undefined : (JSON.parse(text) as Job);
  if (!stored || !was || stored.pick?.ending !== undefined || stored.pick?.to === "todo" || stored.at.kind !== was.at.kind || stepAt(stored) !== stepAt(was)) return "picked";
  return JSON.stringify(parkedOf(stored)) === JSON.stringify(parkedOf(was)) ? "changed" : "picked";
}

/** The job as the store has it now, made this map's (its baseline too), so the map's next save keeps it with what is added to it. */
export function adoptStored(store: Store, jobs: Jobs, key: string): Job | undefined {
  const stored = readStored(store)[key];
  const base = baselines.get(jobs);
  if (stored === undefined) {
    delete jobs[key];
    base?.delete(key);
    return undefined;
  }
  jobs[key] = stored;
  base?.set(key, JSON.stringify(stored));
  return stored;
}

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
  // A job of an older shape stays as it is until the tick drops it with its event (`dropUnreadable`).
  const raw = readRaw(store);
  const kept = Object.fromEntries(unreadable(store).filter((key) => !(key in merged)).map((key) => [key, raw[key]]));
  store.setValue(KEY, JSON.stringify({ ...kept, ...merged }));
  baselines.set(jobs, snapshotOf(merged));
}

/**
 * Whether an answer to this parked job goes on with the step that asked (an implement step that asked a question
 * or escalated), keeping the review round, findings and branch. An Item parked at triage, a proposed restructuring and a
 * rest of any other step start the item over instead.
 */
export function resumesStep(job: Job): boolean {
  return phaseResumes(phaseOf(job));
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
export function releaseIn(jobs: Jobs, key: string, actor: string, startOver = false): JobParked | null {
  const job = jobs[key];
  const was = parkedOf(job);
  if (!job || !was) return null;
  if (was.retry === "hand-over") {
    // The work is done and reviewed: keep it, and let the next tick repeat only the hand-over.
    release(job, "hand-over");
    // A pick that waits (a drop) is not replaced: it comes first.
    if (!job.pick) pick(job, actor, "hand-over");
  } else if (!startOver && resumesStep(job)) {
    // The step that asked runs again, as a new attempt of the same round.
    release(job);
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
  const ids = parkedOf(job)?.questions;
  if (!ids || ids.length === 0) return null;
  const askedAt = parkedOf(job)?.askedAt;
  if (askedAt && Date.parse(item.updatedAt) < Date.parse(askedAt)) return null;
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
  // A rewrite's questions are answered together with the rewrite (`POST /api/rewrite`), not one by one; questions not posted yet not at all.
  const phase = phaseOf(job);
  const ask = askOf(job);
  if (phase.at !== "asked" || ask?.is !== "questions" || phase.posting) return [];
  return ask.list;
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
  if (parkedAt !== undefined && Date.parse(parkedAt) !== Date.parse(parkedOf(job)!.at)) return "parked-changed";
  if (answeredOf(job).some((each) => each.index === index)) return "answered";
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
    const done = answerIn(jobs, key, index, answer, actor, at, parkedAt);
    if ("refused" in done) return done;
    saveJobs(store, jobs);
    if (done.was) store.appendEvent({ kind: "orchestrator.job_released", subject: key, actor, data: { reason: done.reason, was: done.was } }, at);
    else store.appendEvent({ kind: "orchestrator.question_answered", subject: key, actor, data: { reason: done.reason, index, open: done.open } }, at);
    return { released: !!done.was, open: done.open };
  });
}

/**
 * `answerQuestion` on a map of jobs the caller saves (the tick's), with the event's reason for the caller to write: the parked state
 * it released (`was`) with the answer to the last open question, else how many are still open.
 */
export function answerIn(jobs: Jobs, key: string, index: number, answer: string, actor: string, at: string, parkedAt?: string): { open: number; reason: string; was?: JobParked } | { refused: AnswerRefusal } {
  const job = jobs[key];
  const refused = answerRefusal(job, index, parkedAt);
  if (refused || !job) return { refused: refused ?? "no-questions" };
  const questions = jobQuestions(job);
  const answered = [...answeredOf(job).filter((each) => each.index < questions.length), { index, answer, at }].sort((a, b) => a.index - b.index);
  const open = questions.length - answered.length;
  if (open > 0) {
    recordAnswers(job, answered);
    return { open, reason: `A person answered question ${index + 1} of ${questions.length}; ${open} still open.` };
  }
  const reason = `A person answered all ${questions.length} questions: ${answered.map((each) => `${each.index + 1}. ${questions[each.index]!.question} Answered: ${each.answer}`).join(" ")}`;
  const was = releaseIn(jobs, key, actor);
  return was ? { open: 0, reason, was } : { refused: "no-questions" };
}

/** A question a parked job asked in its Item's log: its text, whether the log holds it open, and the answer line that names it. */
export interface LogQuestion {
  question: string;
  open: boolean;
  answer?: { text: string; by: string };
}

const sameWriter = (a: { who: string; machine?: string }, b: { who: string; machine?: string }): boolean => a.who === b.who && (a.machine ?? "") === (b.machine ?? "");

/**
 * The questions a parked job asked in its Item's log (meta branch), in the order asked, as the log reads now: which are still open,
 * and the answer each answered one got, on any machine's board (#248). The park's lines are those of its set (`parkSet`), or, for a
 * job rebuilt from the log, the set of the line it parked on. Null for a park with no line in the log (a GitHub Item, a post that is
 * tried again), a proposed restructuring, and a parked state no answer picks up (queued, handed over).
 */
export function askedInLog(job: Job, item: Pick<WorkItem, "log" | "openQuestions">): LogQuestion[] | null {
  const parked = parkedOf(job);
  const log = item.log;
  const ask = askOf(job);
  if (!parked || !log || parked.questions || parked.retry === "post" || ask?.is === "restructuring") return null;
  if (parked.as !== "needs-decision" && parked.as !== "not-ready" && parked.as !== "escalated") return null;
  // Only lines that ask what this park asks: an earlier park of a job made again may have had the same set (#248).
  const texts = new Set([parked.reason, ask?.is === "question" ? ask.decision.question : undefined, ...jobQuestions(job).map((each) => each.question)].filter((text): text is string => !!text?.trim()));
  const lines = log.filter((line) => line.kind === "question" && line.by.agent && typeof line.fields.question === "string" && texts.has(line.fields.question));
  const ofSet = (set: unknown, by?: { who: string; machine?: string }): LogRecord[] => lines.filter((line) => line.fields.set === set && (!by || sameWriter(line.by, by)));
  const own = ofSet(parkSet(job));
  // A job parked here (it counts its parks) reads only its own set: until the store has read that set back, an earlier park's line
  // of the same instant is not its.
  const first = own.length > 0 || job.parks !== undefined ? undefined : lines.find((line) => Date.parse(line.at) === Date.parse(parked.at));
  const asked = own.length > 0 ? own : !first ? [] : typeof first.fields.set === "string" ? ofSet(first.fields.set, first.by) : [first];
  if (asked.length === 0) return null;
  const open = item.openQuestions ?? [];
  const names = (answer: LogRecord, line: LogRecord): boolean => {
    const { to, toBy, toQuestion, toSet } = answer.fields;
    if (typeof toQuestion === "string" && toQuestion !== line.fields.question) return false;
    // An answer that names its park's set too is that set's only: two parks of one instant may ask the same text (a job made again).
    if (typeof toSet === "string" && typeof line.fields.set === "string" && toSet !== line.fields.set) return false;
    if (typeof to === "string") return Date.parse(to) === Date.parse(line.at) && (typeof toBy !== "object" || toBy === null || sameWriter(toBy as { who: string; machine?: string }, line.by));
    return typeof toSet === "string" && toSet === line.fields.set;
  };
  // A question of a set written twice (a write tried again after it was taken) is one question.
  const once = asked.filter((line, index) => asked.findIndex((each) => each.fields.question === line.fields.question) === index);
  return once.map((line) => {
    const question = line.fields.question as string;
    const isOpen = open.some((each) => !each.proposal && each.question === question && sameWriter(each.by, line.by) && asked.some((one) => one.fields.question === question && Date.parse(one.at) === Date.parse(each.at)));
    const answer = isOpen ? undefined : log.find((each) => each.kind === "answer" && !each.by.agent && typeof each.fields.answer === "string" && each.fields.answer.trim() !== "" && asked.some((one) => one.fields.question === question && names(each, one)));
    return { question, open: isOpen, ...(answer ? { answer: { text: answer.fields.answer as string, by: answer.by.who } } : {}) };
  });
}

/** Why an answer to a rewrite is refused: no rewrite parked on the item (any more), the page read another parked state, or the answers do not fit its questions. */
export type RewriteRefusal = "no-rewrite" | "parked-changed" | "answers";

/** The rewrite this job is parked on, unsettled. */
export function parkedRewrite(job: Job | undefined): Rewrite | undefined {
  const phase = job ? phaseOf(job) : undefined;
  const ask = askOf(job);
  return phase?.at === "asked" && ask?.is === "rewrite" && phase.from === "triage" && !phase.posting ? ask.rewrite : undefined;
}

/** Whether `answers` (one per question, in order) may be given to the rewrite parked on this job now; null when they may. */
export function rewriteRefusal(job: Job | undefined, parkedAt: string, answers: readonly string[]): RewriteRefusal | null {
  const rewrite = parkedRewrite(job);
  if (!job || !rewrite) return "no-rewrite";
  if (Date.parse(parkedAt) !== Date.parse(parkedOf(job)!.at)) return "parked-changed";
  if (answers.length !== rewrite.questions.length || answers.some((answer) => answer.trim() === "")) return "answers";
  return null;
}

/** Whether an answer picks the option labelled `label`: the label itself, or the label with its description after a colon (any case). */
export function picks(answer: string | undefined, label: string): boolean {
  const given = (answer ?? "").trim().toLowerCase();
  const wanted = label.trim().toLowerCase();
  return wanted !== "" && (given === wanted || given.startsWith(`${wanted}:`));
}

/**
 * True when every answer is the recommendation of its question, or its stopping answer (`stopsOn`: holding for a conflict does not
 * change the description): then the rewrite, written for the recommendations, can be settled.
 */
export function keepsRecommendations(rewrite: Rewrite, answers: readonly string[]): boolean {
  return rewrite.questions.every((question, index) => picks(answers[index], question.recommendation) || (question.stopsOn !== undefined && picks(answers[index], question.stopsOn)));
}

/**
 * A person answers a parked rewrite, in the store transaction the caller holds. Keeping every recommendation, the rewrite is
 * settled as `action` and the next tick goes on from triage's other verdicts (`afterRewrite`); a stopping answer (close as a
 * duplicate, hold for a conflict) is kept with it. Any other answer sends the item back to its triage, which runs again with
 * the answers in its prompt (the caller records them). No round cap.
 */
export function settleRewrite(store: Store, item: Ref, answers: readonly string[], action: "accept" | "edit" | "reject", actor: string, at: string, parkedAt: string, written: readonly string[] = [], onHost = false): { refused: RewriteRefusal } | { rerun: true } | { settled: SettledRewrite["as"] } {
  const jobs = loadJobs(store);
  const key = refKey(item);
  const job = jobs[key];
  const refused = rewriteRefusal(job, parkedAt, answers);
  if (refused || !job) return { refused: refused ?? "no-rewrite" };
  const rewrite = parkedRewrite(job)!;
  job.failures = 0;
  if (!keepsRecommendations(rewrite, answers)) {
    release(job);
    const changed = rewrite.questions.map((question, index) => ({ question, answer: answers[index]! })).filter((each) => !picks(each.answer, each.question.recommendation));
    saveJobs(store, jobs);
    store.appendEvent({ kind: "orchestrator.rewrite_answered", subject: key, actor, data: { reason: `A person answered round ${rewrite.round} of the triage otherwise than recommended (${changed.map((each) => `${each.question.question} Answered: ${each.answer}`).join(" ")}); the triage runs again with the answers.`, round: rewrite.round } }, at);
    return { rerun: true };
  }
  const settled = action === "accept" ? "accepted" : action === "edit" ? "edited" : "rejected";
  const stop = rewrite.questions.find((question, index) => question.stopsOn !== undefined && picks(answers[index], question.stopsOn));
  settleAsked(job, { rewrite, as: settled, ...(stop?.stopsOn ? { stop: { answer: stop.stopsOn, ...(stop.duplicateOf ? { duplicateOf: stop.duplicateOf } : {}), ...(stop.holdFor ? { holdFor: stop.holdFor } : {}) } } : {}) });
  if (settled !== "rejected" && written.length > 0) {
    if (job.triaged) job.triaged = adoptWritten(job.triaged, written);
    if (onHost) awaitWritten(store, job, item, written, at);
  }
  const said = stop?.stopsOn ?? "";
  saveJobs(store, jobs);
  store.appendEvent({ kind: `orchestrator.rewrite_${settled}`, subject: key, actor, data: { reason: `A person ${settled} the triage's rewrite (round ${rewrite.round}).${said ? ` Answered: ${said}.` : ""}`, round: rewrite.round, original: rewrite.original, text: rewrite.text } }, at);
  return { settled };
}

/** The set a park's questions carry in the item's log: the park's count and moment, so a job rebuilt from the log does not reuse an old one (#230). */
export function parkSet(job: Job): string {
  return `${job.parks ?? 0}@${parkedOf(job)?.at ?? ""}`;
}

/**
 * The number of the job's next park: one past both its own count and every park number in the Item's log. A job made again on the Item
 * (an answer released the one before, a person's move) counts on from the parks before it, so a park in the same instant as an earlier
 * job's never gets that job's set, and its answers are not taken for this one's.
 */
export function nextPark(job: Job, log: readonly LogRecord[] | undefined): number {
  let most = job.parks ?? 0;
  for (const line of log ?? []) {
    const set = line.kind === "question" ? line.fields.set : undefined;
    const n = typeof set === "string" ? Number(set.split("@")[0]) : Number.NaN;
    if (Number.isInteger(n) && n > most) most = n;
  }
  return most + 1;
}

export { WRITING_WAIT_MS } from "../core/waits.ts";

/**
 * Scope Soup wrote `bodies` (one text, in the forms it may have been written in) on the host as the Item's description, at `at`: while
 * the store still reads another text, the job waits for it (`Job.writing`), with an event. Only for a write that really happened. A store
 * that reads it already needs no wait. Call it in the transaction that saves the job.
 */
export function awaitWritten(store: Store, job: Job, item: Ref, bodies: readonly string[], at: string): void {
  const current = store.get<WorkItem>(item);
  if (!current) return;
  const hashes = bodies.map((body) => itemTextHash({ title: current.title, body, verification: current.verification }));
  const from = itemTextHash(current);
  if (hashes.includes(from)) {
    awaitText(job, undefined);
    return;
  }
  awaitText(job, { from, at });
  store.appendEvent({ kind: "orchestrator.text_wait", subject: refKey(item), actor: "orchestrator", data: { reason: `The description of ${item.id} was written on ${item.host}; its next step waits until Scope Soup reads it back from there.` } }, at);
}

/**
 * A person accepted or edited the triage's rewrite, so Scope Soup wrote the description itself: the text it wrote
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

/** The board marks the recommended option itself, so a trailing "(recommended)" the model wrote in a label is dropped. */
export function withoutRecommendedMark(label: string): string {
  const stripped = label.replace(/\s*\(\s*recommended\s*\)\s*$/i, "").trim();
  return stripped || label;
}

function asDecision(value: unknown): Decision | undefined {
  if (!isObj(value) || typeof value.question !== "string" || !value.question.trim()) return undefined;
  return withContext({
    question: value.question,
    options: asOptions(value.options).map((option) => (typeof option === "string" ? withoutRecommendedMark(option) : { ...option, label: withoutRecommendedMark(option.label) })),
    recommendation: typeof value.recommendation === "string" ? withoutRecommendedMark(value.recommendation) : "",
    ...(value.multiSelect === true ? { multiSelect: true as const } : {}),
  }, value.context);
}

/**
 * Tool-call markup inside a string: the model ran fields together. Only `<parameter name=` or a closing tag named
 * after a field of the triage answer counts; an HTML closing tag such as `</summary>` in a reason is ordinary text.
 */
const MARKUP = /<parameter\s+name\s*=|<\/(?:ready|notReadyReason|size|paths|blockers|questions|hidesDecision|decisions|decision|question|options|recommendation|context|proposal|parts|title|description|verification|reason|risk|riskReason|rewrite|links|aboutOthers|drafts|done|mergedAs|chosen|others|why|verdict|findings|severity|parameter)\s*>/;

/** True when any string anywhere in the value holds tool-call markup. */
export function hasMarkup(value: unknown): boolean {
  if (typeof value === "string") return MARKUP.test(value);
  if (Array.isArray(value)) return value.some(hasMarkup);
  if (isObj(value)) return Object.values(value).some(hasMarkup);
  return false;
}

const PARAMETER = /^<parameter\s+name\s*=\s*"([A-Za-z]+)"\s*>/;

/**
 * The fields run into one string, as `<parameter name="x">value</parameter>` blocks; null unless the whole text is such blocks
 * (the last may be unclosed) with distinct names. A value that starts with `[` or `{` must be JSON.
 */
function parameterBlocks(text: string): Map<string, unknown> | null {
  const fields = new Map<string, unknown>();
  let rest = text;
  while (rest.trim()) {
    rest = rest.trimStart();
    const open = PARAMETER.exec(rest);
    if (!open || fields.has(open[1]!)) return null;
    const name = open[1]!;
    rest = rest.slice(open[0].length);
    const close = rest.search(/<\/parameter\s*>|<parameter\s+name\s*=/);
    const end = close < 0 ? rest.length : close;
    // A block may end in the field's own closing tag instead of `</parameter>`.
    const raw = rest.slice(0, end).replace(new RegExp(`</${name}\\s*>\\s*$`), "").trim();
    rest = rest.slice(end).replace(/^<\/parameter\s*>/, "");
    if (raw.startsWith("[") || raw.startsWith("{")) {
      try {
        fields.set(name, JSON.parse(raw));
      } catch {
        return null;
      }
    } else fields.set(name, raw);
  }
  return fields;
}

/** A field the answer leaves empty, so one recovered from markup may fill it. */
function emptyField(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

/**
 * An answer whose fields the model ran into one of its top-level strings: the string ends in tool-call markup such as
 * `</summary>\n<parameter name="decisions">[...]`. The fields are taken out of the string into the answer, where they are
 * checked like any other. Only when the whole tail reads as such blocks, every one fills a field the answer leaves empty, and the
 * text before them has no markup; otherwise the string is left as it is, and the answer's markup makes it malformed.
 * `recovered` names the fields taken out (for a log line; their text is never logged).
 */
export function recoverFields(value: unknown): { value: unknown; recovered: string[] } {
  if (!isObj(value)) return { value, recovered: [] };
  let out: Obj = value;
  const recovered: string[] = [];
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== "string") continue;
    const start = text.search(/<parameter\s+name\s*=/);
    if (start < 0) continue;
    const fields = parameterBlocks(text.slice(start));
    const head = text.slice(0, start).replace(new RegExp(`</${key}\\s*>\\s*$`), "").trimEnd();
    if (!fields || MARKUP.test(head) || [...fields.keys()].some((name) => name === key || !emptyField(out[name]))) continue;
    out = { ...out, [key]: head, ...Object.fromEntries(fields) };
    recovered.push(...fields.keys());
  }
  return { value: out, recovered };
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
  // A restructuring that does not hold together (a part dropped, a fate that does not fit its parts) is left out.
  const restructure = asRestructuring(value.restructure);
  const why = typeof value.restructure === "object" && value.restructure !== null ? (value.restructure as Record<string, unknown>).reason : undefined;
  if (restructure) answer.restructure = { reason: typeof why === "string" ? why.trim() : "", ...restructure };
  if (typeof value.rewrite === "string") answer.rewrite = value.rewrite;
  const links = asLinks(value.links);
  if (links.length > 0) answer.links = links;
  const labels = asLabelChange(value.labels);
  if (labels) answer.labels = labels;
  const others = asAboutOthers(value.aboutOthers, true);
  if (others.length > 0) answer.aboutOthers = others;
  const drafts = asDrafts(value.drafts, hasMarkup);
  if (drafts.length > 0) answer.drafts = drafts;
  return answer;
}

/**
 * The questions about other Items in an answer: each needs an Item and a question, or (`rewrites`, triage) a rewrite. An entry with
 * tool-call markup is dropped. No cap on how many; each text clipped.
 */
export function asAboutOthers(value: unknown, rewrites: boolean): AboutOther[] {
  if (!Array.isArray(value)) return [];
  const out: AboutOther[] = [];
  for (const entry of value as unknown[]) {
    if (!isObj(entry) || typeof entry.item !== "string" || !entry.item.trim() || hasMarkup(entry)) continue;
    const questions: Decision[] = [];
    for (const each of Array.isArray(entry.questions) ? (entry.questions as unknown[]) : []) {
      const decision = asDecision(each);
      if (decision) questions.push(decision);
    }
    const rewrite = rewrites && typeof entry.rewrite === "string" && entry.rewrite.trim() ? entry.rewrite.trim().slice(0, 50_000) : undefined;
    if (questions.length === 0 && !rewrite) continue;
    out.push({ item: entry.item.trim().slice(0, 200), questions, ...(rewrite ? { rewrite } : {}) });
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
  // Markup left inside a string (`recoverFields` could not take the fields out): the fields cannot be trusted to be complete.
  // An `aboutOthers` or `drafts` entry with markup is dropped alone (`asAboutOthers`, `asDrafts`).
  if (hasMarkup({ ...value, aboutOthers: undefined, drafts: undefined })) return null;
  const answer: ImplementAnswer = { done: value.done, summary: typeof value.summary === "string" ? value.summary : "" };
  // `question`, or `decision` from an older answer or a fix session that was running at the upgrade.
  const decision = asDecision(value.question) ?? asDecision(value.decision);
  if (decision) answer.decision = decision;
  if (typeof value.mergedAs === "string" && value.mergedAs.trim()) answer.mergedAs = value.mergedAs.trim().slice(0, 500);
  const decisions = asTaken(value.decisions);
  if (decisions.length > 0) answer.decisions = decisions;
  const others = asAboutOthers(value.aboutOthers, false);
  if (others.length > 0) answer.aboutOthers = others;
  const drafts = asDrafts(value.drafts, hasMarkup);
  if (drafts.length > 0) answer.drafts = drafts;
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
  if (hasMarkup({ ...value, drafts: undefined })) return null;
  const findings: Finding[] = [];
  for (const entry of value.findings as unknown[]) {
    if (!isObj(entry) || typeof entry.text !== "string") return null;
    const finding: Finding = { severity: entry.severity === "should" ? "should" : "must", text: entry.text };
    if (typeof entry.file === "string") finding.file = entry.file;
    // A decision that should have been a question is a must, whatever severity came with it.
    if (entry.ask === true) Object.assign(finding, { severity: "must", ask: true });
    findings.push(finding);
  }
  const drafts = asDrafts(value.drafts, hasMarkup);
  return { verdict: value.verdict, findings, ...(drafts.length > 0 ? { drafts } : {}) };
}

/** How a finding that should have been a question is marked for the implementor (prompts/implement.md names it). */
export const ASK_PERSON = "ask a person";

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "(none listed)";
  return findings.map((finding) => `- [${finding.severity}${finding.ask ? `, ${ASK_PERSON}` : ""}]${finding.file ? ` ${finding.file}:` : ""} ${finding.text}`).join("\n");
}
