// What a host adapter implements. Split by capability: a deployment can combine hosts
// (one for work items, one for changes, one for CI), and a host that lacks a capability
// does not implement that port.

import type { Actor, AssumptionSettled, Batch, LabelChange, RepoLabel, Change, ConflictVersions, DecisionOption, Priority, ProposedPart, Ref, Run, Runner, Turn, VerdictValue, WorkItem, WorkState } from "../model/types.ts";

export type Capability = "work" | "changes" | "ci" | "runners" | "batches" | "turn" | "write";

/** Opaque position in a host's change feed. Hides ETags, `since=` and similar. */
export type Cursor = string;

export interface Page<T> {
  items: T[];
  cursor: Cursor;
  /** Objects that no longer exist or left the scope. */
  removed?: Ref[];
  /** Of `removed`, those that moved elsewhere (a transferred issue): ref key -> where it is now. */
  movedTo?: Record<string, string>;
  /** True when nothing changed since the cursor (a free conditional request). */
  unchanged?: boolean;
}

/** "Something changed here." The core always refetches; an event carries no data to trust. */
export interface HostEvent {
  subject?: Ref;
  at: string;
  hint?: string;
}

export interface HostInfo {
  /** Short, stable name used in refs: "github". */
  id: string;
  capabilities: ReadonlySet<Capability>;
  whoami(): Promise<Actor>;
  /** A host that keeps logs per machine (meta branch): this machine's name in the lines it writes. */
  machine?: string;
  /** A host whose claims are comments, not a log per machine (GitHub): this machine's name in Scope Soup's claim comments. */
  claimMachine?: string;
  /** The log per machine is shared with other machines (meta branch with writes and a remote), so Scope Soup claims what it starts. */
  shared?: true;
  /** About the most a comment Scope Soup posts on this host may hold, in characters; `COMMENT_LIMIT` when not given. */
  commentLimit?: number;
  /** The host's own API budget, when it reports one. */
  apiBudget?(): Promise<{ remaining: number; resetAt: string } | null>;
}

export interface WorkPort {
  listWork(since?: Cursor): Promise<Page<WorkItem>>;
  /** Null when the host does not know the item. Throws `WorkGone` when it was moved elsewhere or deleted. */
  getWork(ref: Ref): Promise<WorkItem | null>;
  /** The labels the repository has, with their descriptions, where the host keeps a list of them (GitHub). */
  labels?(): Promise<RepoLabel[]>;
}

/** The item was moved to another place (`movedTo`; GitHub: a transferred issue, 301) or deleted (GitHub: 410). */
export class WorkGone extends Error {
  movedTo?: string;
  constructor(message: string, movedTo?: string) {
    super(message);
    this.name = "WorkGone";
    if (movedTo) this.movedTo = movedTo;
  }
}

export interface ChangePort {
  listChanges(since?: Cursor): Promise<Page<Change>>;
  getChange(ref: Ref): Promise<Change | null>;
}

export interface CiPort {
  runsFor(sha: string): Promise<Run[]>;
  /** Finished runs of one pipeline, newest first. History for estimates. */
  recentRuns(pipeline: string, limit: number): Promise<Run[]>;
  /** Runs that are queued or running now. */
  activeRuns(): Promise<Run[]>;
  runners?(): Promise<Runner[]>;
}

/** One check on a commit, as the host's CI reports it: a check run or a commit status. */
export interface ExternalCheck {
  /** The check run's name, or the status's context. */
  name: string;
  kind: "check-run" | "status";
  state: "pending" | "passed" | "failed";
  /** The host's own word: `success`, `failure`, `timed_out`, `in_progress`, `pending`, `error`, ... */
  conclusion: string;
  /** Where a person reads it. */
  url?: string;
  /** The host's id of a check run, for its log. */
  id?: string;
}

/**
 * The merge queue waits for the project's own CI on the host (GitHub, `mergeQueue.ci: "github"`). Only on a host Scope Soup may
 * write to: opening the batch's pull request is a write.
 */
export interface QueueCiPort {
  /**
   * Opens the pull request of a batch's commit, which Scope Soup has pushed to `branch`, into `target`; or returns the open one for
   * that branch. Its text is Scope Soup's own: the batch, its commits and its members, never text an item or agent wrote.
   */
  openBatch(input: { branch: string; target: string; batch: number; sha: string; base: string; members: Ref[] }): Promise<Ref>;
  /** Every check run and commit status on exactly this commit, the latest of each name. Empty when no CI reported anything. */
  checksOn(sha: string): Promise<ExternalCheck[]>;
  /** The end of a check's log, at most `chars` long; null when it cannot be read (not a run of the host's own CI, no rights). */
  checkLog(check: ExternalCheck, chars: number): Promise<string | null>;
  /**
   * Tidies a batch's pull request that is over. With `comment`: the batch did not merge, so the comment is posted, the pull
   * request closed and its branch deleted. Without: it merged, and only the branch is deleted, once the host shows it merged. Only a
   * pull request Scope Soup opened is touched: its head must be `branch`, a `scopesoup/batch-...` branch, and its description must end in
   * the `batch` marker, written by the token's own login; otherwise `NotScopeSoups`. A step already done is not done again.
   */
  cleanBatch(input: { change: Ref; branch: string; comment?: string }): Promise<void>;
}

export interface BatchPort {
  /** Newest first. */
  listBatches(limit: number): Promise<Batch[]>;
}

/** Only for hosts that know whose turn it is themselves (Gerrit's attention set). */
export interface TurnPort {
  turns(): Promise<Turn[]>;
}

export interface WatchPort {
  /** Calls back when something may have changed. Returns a function that stops watching. */
  watch(onEvent: (event: HostEvent) => void): Promise<() => void>;
}

/** A new item, on a host that keeps items itself (meta branch). The host gives it its id. */
export interface NewWork {
  title: string;
  /** Markdown. */
  body?: string;
  /** Default `todo`. */
  state?: WorkState;
  labels?: string[];
  parent?: Ref;
  blockedBy?: Ref[];
  verification?: string;
  priority?: Priority;
  /** The vote, a score offset in points (meta branch header); 0 or left out: none. */
  vote?: number;
  /** Log lines written in the same commit as the item (meta branch), so no one sees the item before them: a `created` line, a person's `claimed` line. */
  log?: LogLineInput[];
  /** Logins the item is assigned to when it is created (GitHub): a person who files an item and takes it in one call. */
  assignees?: string[];
}

/** What to change in an item: a field left out stays as it is; null clears it. */
export interface WorkPatch {
  title?: string;
  body?: string;
  state?: WorkState;
  labels?: string[];
  parent?: Ref | null;
  blockedBy?: Ref[];
  verification?: string | null;
  priority?: Priority | null;
  /** The vote, a score offset in points, written in the header (meta branch); 0 clears it. */
  vote?: number;
  /** With `state: "abandoned"`, closes the item as a duplicate of this one (GitHub: `state_reason: "duplicate"`). */
  duplicateOf?: Ref;
}

/** One line for an item's log. The host adds the time and the machine. Text in it is data, from people and agents. */
/** A decision an implementor took itself, as it is recorded on the host. */
export interface AssumptionWrite {
  question: string;
  chosen: string;
  others: string[];
  why: string;
}

export interface LogLineInput {
  /** A short lower-case word: `claimed`, `session`, `question`, `answer`, `review`, `check`, `merged`... */
  kind: string;
  /** The person or agent the line is from. */
  by: { who: string; agent: boolean };
  /** The kind's own fields (docs/DESIGN.md, "Items on a meta branch"). */
  fields?: Record<string, unknown>;
}

/** What became of a write to an item. */
export interface WriteOutcome {
  /** The item. A new item can move to another id when another machine took its id first. */
  work: Ref;
  /** `shared`: the other machines can have it. `pending`: written here, not shared yet (see `problem`); it goes with a later round. `local`: there is nothing to share with. */
  shared: "shared" | "pending" | "local";
  problem?: string;
  /** The item's text was changed in two places at once: both versions are kept and it waits for a person. */
  conflict: boolean;
  /** A new item moved to `work` while it was shared, because another machine had made an item with this id first. */
  movedFrom?: string;
  /** False when the item was created but could not be put under its `parent` (`problem` says why); `linkChild` tries again. */
  linked?: false;
}

/** One question Scope Soup asks on an item's host (GitHub: a question comment). Its text is already inert. */
export interface QuestionWrite {
  question: string;
  options: DecisionOption[];
  recommendation?: string;
  context?: string;
  /** Several options may be picked. */
  multiSelect?: true;
  /** How the item parked (`needs-decision`) and the step that asked. */
  parked: string;
  step: string;
  /** The draft comment of the triage round this question belongs to. */
  draft?: string;
  /** A proposed split: the question is a person's decision on it (`POST /api/proposal`). */
  proposal?: { reason: string; parts: ProposedPart[]; carried?: string };
}

/** One triage round's draft of the description, posted on the item's host (GitHub: a draft comment). Its text is already inert. */
export interface DraftWrite {
  round: number;
  draft: string;
  /** The label changes proposed with the draft; its marker carries them. */
  labels?: LabelChange;
}

/** About the most a comment Scope Soup posts on GitHub may hold (GitHub allows 65,536); a draft or split over a host's limit stays on Scope Soup's board. Other hosts give their own (`HostInfo.commentLimit`). */
export const COMMENT_LIMIT = 60_000;

/** The answer Scope Soup posts on an item's host (GitHub: an answer comment). Its text is already inert. */
export interface AnswerWrite {
  answer: string;
  /** The question's text, kept with an answer that names no question comment (an escalation's). */
  question?: string;
  /** The option texts of the question. */
  options?: string[];
  /** `itemTextHash` of the item when the answer was given, for answer reuse. */
  textHash?: string;
  /** A person's decision on a triage draft or a proposed split. */
  proposal?: "accepted" | "edited" | "rejected";
  /** Who answered: the board's picked person. Without it the host names the account that writes. */
  by?: string;
}

/** The question has an answer on the host already; a second one is refused. */
export class AlreadyAnswered extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlreadyAnswered";
  }
}

/** The issue's body changed since the triage draft was written; accepting it would overwrite a person's edit. */
export class BodyChanged extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyChanged";
  }
}

/** The pull request is not one of Scope Soup's own batch pull requests, so nothing was changed on it and nothing will be. */
export class NotScopeSoups extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotScopeSoups";
  }
}

/**
 * The host could not be written for a reason that can change by itself (down, overloaded, offline, a rate limit). The step
 * is tried again by itself; a write that may have been taken before the failure is looked for before it is sent again.
 */
export class WriteLater extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteLater";
  }
}

/** The comment would be over the host's comment limit (`COMMENT_LIMIT` on GitHub); nothing was posted. */
export class TooLarge extends Error {
  /** The host's limit, in characters. */
  limit: number;
  constructor(message: string, limit: number = COMMENT_LIMIT) {
    super(message);
    this.name = "TooLarge";
    this.limit = limit;
  }
}

/** Every method is optional: a host implements what it can. */
export interface WritePort {
  /** Creates an item; on a host that keeps items itself. */
  createWork?(input: NewWork): Promise<WriteOutcome>;
  /**
   * Changes an item's fields. An item whose text was changed in two places at once is in conflict
   * and is refused, unless `resolveConflict` names the versions put aside that this edit settles
   * (as the host shows them, e.g. blob ids). Only those are removed: a version the person did not
   * see stays, and the outcome says the item is still in conflict.
   */
  editWork?(work: Ref, patch: WorkPatch, options?: { resolveConflict?: { supersedes: string[] } }): Promise<WriteOutcome>;
  /**
   * Adds blockers to an item and never removes one (a triage's blockers, on a host whose items are issues). Only the
   * missing ones are written; a re-read must show them. Throws when the host refuses or did not apply it.
   */
  addBlockers?(work: Ref, blockers: Ref[]): Promise<WriteOutcome>;
  /** An item in conflict: its text as it stands and the versions put aside, whole, as the host stores them. Null when it is not in conflict. */
  conflictVersions?(work: Ref): Promise<ConflictVersions | null>;
  /**
   * Settles a conflict: `text` becomes the item's whole text (as the host stores it, e.g. `item.md`)
   * and the versions named in `supersedes` (their `id`s from `conflictVersions`) are removed.
   */
  resolveConflict?(work: Ref, text: string, supersedes: string[]): Promise<WriteOutcome>;
  /** Puts an existing item under a parent, where the link is a call of its own (GitHub sub-issues). Nothing when it is already there. */
  linkChild?(parent: Ref, child: Ref): Promise<void>;
  /** Adds a line to an item's log. A log is append-only: lines are never changed or removed. */
  appendLog?(work: Ref, line: LogLineInput): Promise<WriteOutcome>;
  /** Several lines added to an item's log in one write (the answers of one Send). */
  appendLogs?(work: Ref, lines: LogLineInput[]): Promise<WriteOutcome>;
  comment?(subject: Ref, markdown: string): Promise<void>;
  /**
   * Posts each question as a comment of its own, numbered on from the item's earlier questions, and marks the item as
   * waiting for an answer (GitHub: the `scopesoup:needs-decision` label). Returns the question ids in order and the host's time of
   * the last one. Throws when the host refuses or did not apply it; `WriteLater` when that can change by itself. A
   * question still open on the item with the same text (and draft) is not posted again: its comment is returned, so a retry
   * after a post that was taken before the failure posts no second one. `numbers` are the questions' numbers (`Qn`), in order.
   */
  askQuestions?(work: Ref, questions: QuestionWrite[]): Promise<{ ids: string[]; at: string; numbers?: number[] }>;
  /**
   * Question comments of Scope Soup's were deleted on the host (a person's "don't ask that"): they are kept with the item
   * (GitHub: in the log comment) with their numbers, which are never used again, and every other open question of Scope Soup's on
   * the item is withdrawn (edited to say so), because the triage runs again. The texts are already inert.
   */
  withdrawQuestions?(work: Ref, deleted: { question: string; n?: number }[]): Promise<void>;
  /**
   * Posts the answer to question `to` (null: to none, an escalation's answer). Throws `AlreadyAnswered` when the
   * question has an answer already. With the last open question answered, the item stops waiting (the label goes). Returns how
   * many questions are still open.
   */
  answerQuestion?(work: Ref, to: string | null, answer: AnswerWrite): Promise<{ open: number }>;
  /** Several answers sent together, in one write (GitHub: one comment with `A1:` and `A2:` lines). Refused whole as `answerQuestion`. */
  answerQuestions?(work: Ref, answers: { to: string | null; answer: AnswerWrite }[]): Promise<{ open: number }>;
  /**
   * Posts a triage round's draft as a comment, with the hash of the body it read. Throws `TooLarge` (nothing posted)
   * over `COMMENT_LIMIT`. Returns the comment's id and the host's time. `WriteLater` as `askQuestions`; an unanswered draft
   * of the same round with the same text and body hash is returned instead of posting a second one.
   */
  postDraft?(work: Ref, draft: DraftWrite): Promise<{ id: string; at: string }>;
  /**
   * Before a draft is accepted: throws `BodyChanged` when the body is no longer the one the draft read, `AlreadyAnswered`
   * when the draft has an answer, and an error when the draft comment is gone.
   */
  checkDraft?(work: Ref, draft: string): Promise<void>;
  /**
   * Adds a line to Scope Soup's one log comment on the item (GitHub), made with the first line and then edited in place. Its
   * text is already inert. Throws when the host refuses or does not show it.
   */
  logLine?(work: Ref, line: { kind: string; fields: Record<string, unknown> }): Promise<void>;
  /** The item stops waiting for an answer (the label goes) when no question is open on it any more, and no triage draft waits. */
  settleQuestions?(work: Ref): Promise<void>;
  /**
   * The decisions an implementor took itself, as one comment on the item with the `scopesoup:assumption` label (GitHub), which
   * does not block and is not `scopesoup:needs-decision`. The texts are inert already. Throws when the host refuses or did not apply it.
   */
  postAssumptions?(work: Ref, decisions: AssumptionWrite[]): Promise<{ id: string }>;
  /**
   * A person's verdicts on decisions (`<comment id>-<n>`), sent together: each written into its comment's marker, one edit per
   * comment; the label goes once no decision on the item is open. Throws `AlreadyAnswered`, before anything is written, when one is
   * settled already or not there.
   */
  settleAssumptions?(work: Ref, settles: { id: string; settled: AssumptionSettled }[]): Promise<void>;
  /**
   * Closes an item as done, after the comment is written; on a host whose items are issues. With `merged` the comment
   * carries the `merged` marker (GitHub, with the conventions on).
   */
  closeWork?(work: Ref, comment: string, merged?: { sha: string; target: string; batch?: number }): Promise<void>;
  /** Comments on a change, then closes it unless the host already marks it merged. */
  closeChange?(change: Ref, comment: string): Promise<void>;
  /**
   * Proposes a branch that is already on the host as a change. When an open change for the
   * branch exists it is returned instead of a second one being made.
   */
  openChange?(input: { branch: string; target: string; title: string; body: string; draft?: boolean }): Promise<Ref>;
  setLabels?(subject: Ref, add: string[], remove: string[]): Promise<void>;
  /**
   * A triage draft's label changes, at Accept: reads the item's labels, then one call per label to add (only one the
   * repository has and the item lacks) or remove (only one the item has), never a full replace; then a re-read that must show
   * them. Returns what was sent. Throws when the host refuses or did not apply it.
   */
  changeLabels?(work: Ref, add: string[], remove: string[]): Promise<{ added: string[]; removed: string[] }>;
  /**
   * Scope Soup claims the item for this machine until `until` (GitHub: a claim comment, then the `scopesoup:claimed` label), or
   * renews its live claim (the comment edited). Then the lowest live claim must be this one; otherwise this one is released and
   * the claim is not won. `shown` is the machine's name as people read it, inert already. Throws when the host refuses it.
   */
  claim?(work: Ref, claim: { until: string; shown: string }): Promise<{ won: true } | { won: false; why: string }>;
  /** Lets go of this machine's claim (its comment edited to released) and, with no other live claim, removes the label. */
  releaseClaim?(work: Ref, claim: { shown: string }): Promise<void>;
  /** Adds and removes assignees (logins) of an item, on a host where the assignee is the holder (GitHub). A person's hold, never a claim. */
  setAssignees?(work: Ref, add: string[], remove: string[]): Promise<void>;
  setWorkState?(work: Ref, state: WorkState): Promise<void>;
  vote?(change: Ref, revision: string, dimension: string, value: VerdictValue, score?: number): Promise<void>;
  /** `expectSha` makes sure no revision other than the tested one can merge. */
  merge?(change: Ref, expectSha: string, mode: "fast-forward" | "host-default"): Promise<{ sha: string }>;
  triggerCi?(pipeline: string, gitRef: string, inputs?: Record<string, string>): Promise<Ref | null>;
}

/** What the rest of the program is handed for one configured host. */
export interface Host {
  info: HostInfo;
  /** Ends whatever the host still has running (a push in flight), on shutdown. */
  stop?(): Promise<void>;
  work?: WorkPort;
  changes?: ChangePort;
  ci?: CiPort;
  batches?: BatchPort;
  turns?: TurnPort;
  watch?: WatchPort;
  write?: WritePort;
  /** The merge queue's wait for the project's own CI; only with writes on. */
  queueCi?: QueueCiPort;
}
