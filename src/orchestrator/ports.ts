// What the tick needs from the runner and from the hosts, as interfaces the caller injects.

import type { LabelChange, Ref, RepoLabel, Session, SessionRole } from "../model/types.ts";
import type { AnswerWrite, RewriteWrite, QuestionWrite, WorkPatch } from "../ports/host.ts";
import type { AssumptionOutcome, AssumptionPick } from "./assumptions.ts";

export interface SessionRequest {
  role: SessionRole;
  /** The work item the session is for. */
  subject: Ref;
  /** 1 for the first try of a step. */
  attempt: number;
  /** Names the worktree, or the item's hold on a clone of the pool; one per item, shared by the item's sessions. */
  workspace: string;
  branch: string;
  /** Values for the prompt template. */
  vars: Record<string, string>;
  /** The agent's own session id, to continue a session a limit cut off, or the implementor's session findings go back to. */
  resume?: string;
  /**
   * A short message for the agent: with `resume`, it is all the session is sent, in place of the role's prompt; without,
   * it goes after the prompt (a fresh implementor, when the session that wrote the change is not known).
   */
  message?: string;
  /**
   * A turn of a person's chat with the session `resume`: it is sent only `message`, with the role's model, permission mode
   * and tools but without its answer schema. The reply is free text and is never read as the role's answer.
   */
  chat?: true;
  /** The model in place of the role's (the implementor's model by size, or its step-up). */
  model?: string;
  /** The environment variables of the resource units the session holds (taken by the caller; the runner gives them back). */
  env?: Record<string, string>;
}

/** What a finished session left behind besides the Session object. Stored under `session.result:<id>`. */
export interface SessionResultRecord {
  /** The structured answer, when the run produced one that fits the schema. */
  output?: unknown;
  /** For status "limit": when the limit resets. */
  resumeAt?: string;
  turns?: number;
  subtype?: string;
  malformedLines?: number;
  /** Commands (or tools) the permission check refused during the run. */
  denied?: string[];
  /** Premium requests and AI credits the agent's session used so far, when its provider says. */
  premiumRequests?: number;
  aiCredits?: number;
}

export interface AgentRunner {
  /**
   * Starts a session and returns once the process is launched. A start that is refused or
   * fails still returns a Session, already over, with the reason in `endReason`.
   */
  start(request: SessionRequest): Promise<Session>;
  /** Kills stalled and overdue sessions; settles sessions the store calls running that no process backs. */
  reconcile(): Promise<void>;
  /** Stops every running session, or only those of `roles` (and their setups under way). Returns how many were told to stop. */
  stopAll(reason: string, roles?: readonly SessionRole[]): number;
  /**
   * Stops the running sessions of one item (and its setup under way); with `stepsOnly`, a person's chat turn on it is left alone.
   * Returns how many were told to stop. Absent in fakes that do not need it.
   */
  stopFor?(subject: Ref, reason: string, stepsOnly?: boolean): number;
  /** Sessions with a live process. */
  running(): number;
  /**
   * A session for this item is being started or runs (a step's, or a turn of a person's chat). Synchronous, and true
   * from the moment `start` is called, so a check followed by `start` cannot be overtaken. Absent in fakes that do not need it.
   */
  busy?(subject: Ref): boolean;
  /**
   * Makes sure the item has a workspace before its session is started. Returns null when it has one
   * (worktrees are made at start, so always), or the reason it must wait: no clone of the pool is free.
   * `head`: the item's newest revision, when its work is past implement. In a pool with no record of the
   * item's clone, only a clone at that commit is taken; when none has it, `WorkNotFound` is thrown.
   */
  takeWorkspace(item: Ref, workspace: string, branch: string, head?: string): Promise<string | null>;
  /** Removes an item's worktree, or frees its clone of the pool. The branch stays. */
  releaseWorkspace(workspace: string, reason?: string): Promise<void>;
  /** Deletes an item's local branch (and any worktree still holding it). A branch that is not there is no error; the main branch and branches outside the item prefix are refused. */
  deleteBranch(branch: string): Promise<void>;
  /** Paths the branch changes against the main branch. */
  changedPaths(branch: string): Promise<string[]>;
  /** Each path the branch changes against the main branch with its changed lines, for the fence. Without it the fence compares only the paths. */
  changeStat?(branch: string): Promise<{ path: string; lines: number }[]>;
  /** How many commits the branch has over the main branch (where it left it). Throws when the branch is not there. Without it the check is skipped. */
  commitsAhead?(branch: string): Promise<number>;
  /** The full commit id the branch points at, for the item's log (`revision`, `review`) and to see a merge by the session. */
  head(branch: string): Promise<string>;
  /**
   * Fetches the remote's main branch in the repository that has `branch` (the project's, or the item's clone of the pool) and
   * returns that repository and the commit main points at: how Scope Soup sees a merge by the session and guards the main branch.
   */
  fetchMain(branch: string): Promise<{ repo: string; main: string }>;
  /** In the repository that has `branch`: whether `ancestor` is `descendant` or an ancestor of it; null when `ancestor` is not a commit there. */
  contains(branch: string, ancestor: string, descendant: string): Promise<boolean | null>;
  /**
   * A squash merge by the session, in the repository that has `branch`: the full id of `commit` when it is on `tip` (the
   * remote's main), descends from `base` and is not it, and has every file the branch changed over `base` as `head` has it;
   * else null.
   */
  squashed?(branch: string, commit: string, base: string, head: string, tip: string): Promise<string | null>;
  /**
   * In the repository that has `branch`, the commits in `since..until` that touch any of `paths` (newest first, at most
   * `max`) and how many there are in all; null when `since` is not a commit there. Without it the paths are not checked.
   */
  commitsTouching?(branch: string, since: string, until: string, paths: readonly string[], max: number): Promise<{ commits: { sha: string; subject: string }[]; count: number } | null>;
}

/** Writes outside Scope Soup's own store. The caller decides what they do; `dryActions` does nothing. */
export interface Actions {
  /**
   * Marks the item as held by Scope Soup until `until`, and says whether this machine holds it after that.
   * Writing the same claim again renews it. On a host that keeps a log per item the claim is shared
   * and read back: when another machine's claim came first, or the claim could not be shared, it is
   * not won and the item is not started here.
   */
  claim(item: Ref, until: string, at: string): Promise<ClaimResult>;
  /** The actor id Scope Soup's claims are written as on this host (`scopesoup@laptop-a`), when claims are shared between machines. */
  claimant?: string;
  /**
   * Scope Soup claims the items it starts, with a fixed expiry (`CLAIM_EXPIRY_MINUTES`), and releases them when they are parked: on a
   * shared meta branch with writes on, and on GitHub with writes and claim comments. There is no switch.
   */
  claims?: true;
  release(item: Ref, reason: string): Promise<void>;
  /** Puts the item on a person's list: a decision, an escalation, something not ready, or a change handed over to a person. */
  answerTurn(item: Ref, kind: "decision" | "escalation" | "not-ready" | "handover", reason: string): Promise<void>;
  /**
   * Adds blockers the triage found to the item's own `blockedBy` field, on a host whose items Scope Soup writes with a
   * log of their own (meta branch). On GitHub (with writes on) as issue dependencies, then a re-read that must show them and
   * goes into the store; throws when GitHub refuses or did not apply it. Absent where writes are off.
   */
  addBlockers?(item: Ref, blockers: Ref[]): Promise<void>;
  /**
   * Replaces the item's description on its host with text a person accepted from the triage's rewrite, on a host whose
   * items are issues (GitHub, with writes on). Only the body changes. Throws when the host refuses; false when the item is not on
   * this host. Absent where the host cannot do it.
   */
  replaceDescription?(item: Ref, text: string): Promise<boolean>;
  /**
   * Changes the title, description, verification, state or priority of an item on a host whose items are issues (GitHub,
   * with writes on): the calls, then a re-read that must show them. Throws when the host refuses or did not apply it; false when
   * the item is not on this host.
   */
  editItem?(item: Ref, patch: WorkPatch): Promise<boolean>;
  /**
   * Posts the questions an item parked on as comments on its host (GitHub, with writes on), with the needs-decision label,
   * and reads the item back into the store. The question ids in order and the host's time of the last; null when the item is not
   * on this host. Throws when the host refuses or did not apply it. Absent where writes are off.
   */
  askQuestions?(item: Ref, questions: QuestionWrite[]): Promise<{ ids: string[]; at: string; numbers?: number[] } | null>;
  /**
   * Question comments were deleted on the item's host: the host keeps them (with their numbers, never used again) so every
   * prompt names them, and withdraws the item's other open questions. Reads the item back.
   */
  withdrawQuestions?(item: Ref, deleted: { question: string; n?: number }[]): Promise<void>;
  /** Posts the answer to question `to` (null: to none) and reads the item back. Throws `AlreadyAnswered` for a second answer. */
  answerQuestion?(item: Ref, to: string | null, answer: AnswerWrite): Promise<{ open: number } | null>;
  /** Several answers posted together in one comment, then the item read back. */
  answerQuestions?(item: Ref, answers: { to: string | null; answer: AnswerWrite }[]): Promise<{ open: number } | null>;
  /** Posts a triage round's rewrite as a comment on the item's host; null when the item is not there. Throws `TooLarge` over the limit. */
  postRewrite?(item: Ref, rewrite: RewriteWrite): Promise<{ id: string; at: string } | null>;
  /**
   * The labels the triage may propose for the item, with their descriptions: the repository's (GitHub) or, on a host
   * that keeps no list, every label its items have (meta branch). Null when the item is not on this host. Absent where writes are off.
   */
  repoLabels?(item: Ref): Promise<RepoLabel[] | null>;
  /**
   * Applies a triage rewrite's label changes on the item's host at Accept, only those that still make sense, one call per
   * label (GitHub) or in the item's file (meta branch), and reads the item back. Returns what changed; null when the item is not on
   * this host. Throws when the host refuses or did not apply it.
   */
  changeLabels?(item: Ref, change: LabelChange): Promise<{ added: string[]; removed: string[] } | null>;
  /** Throws `BodyChanged` when the item's body changed since the rewrite comment `id` was written, `AlreadyAnswered` when it has an answer. */
  checkRewrite?(item: Ref, id: string): Promise<void>;
  /** Removes the needs-decision label once no question is open on the item (answered by a reply on the host). */
  settleQuestions?(item: Ref): Promise<void>;
  /**
   * Adds a line to the item's own log, on a host that keeps one (meta branch). On GitHub a `session`, `revision`, `review`,
   * `check` or `edited` line goes into the item's one log comment; a failed write there is `orchestrator.host_write_failed` and
   * does not throw. Elsewhere nothing.
   */
  appendLog(item: Ref, kind: string, fields: Record<string, unknown>): Promise<void>;
  /**
   * Closes the item on its host after its change merged, with a comment naming the commit (and batch).
   * "by-hand": the host keeps the item but writes are off; "not-needed": the host's own log already says it merged.
   */
  closeMerged?(item: Ref, merged: { sha: string; target: string; batch?: number }): Promise<"closed" | "by-hand" | "not-needed">;
  /** True where nothing closes an item when its change merges but Scope Soup itself (meta branch, writes on): a merge by a person is looked for too. */
  closesItself?: true;
  /**
   * Closes the item on its host as a duplicate of `of`, on the answer, written through; false when the item is not
   * this host's. Only where the host keeps items as issues (GitHub); elsewhere absent, and a person closes it.
   */
  closeDuplicate?(item: Ref, of: Ref): Promise<boolean>;
  /**
   * A person's picks on decisions an implementor took itself (`id` as the item's `assumptions` name it), sent together. After one
   * fresh look that every one is still open (else it throws before anything is written), each overturn that does not go into the
   * running work gets its Item first (rework, or revert where the change merged; one filed for it before, found by its mark, is
   * reused). Then all verdicts in one write: GitHub edits the decisions' comment (and the `scopesoup:assumption` label goes once none
   * is open), meta branch one commit of `accepted` / `overturned` lines. The re-read goes into the store. An overturn that goes into
   * the running work (the change has not merged and is in the implementor's hands) comes back as `work`: the caller keeps it for the
   * cycle (`keepOverturn`) in the transaction that records the picks. Throws when the host refuses; null when the item is not this host's.
   */
  settleAssumptions?(item: Ref, picks: AssumptionPick[], by: string): Promise<AssumptionOutcome[] | null>;
  /**
   * An overturn went into the work, but the change merged before the implementor was told: the new Item an Overturn after
   * merging files, for a decision settled already. An Item filed for it before (its mark) is returned instead. Null when the
   * item is not this host's.
   */
  reworkOverturn?(item: Ref, id: string, answer: string, by: string): Promise<Ref | null>;
}

/** `won`: this machine holds the item. Otherwise `why` says who does, or why the claim did not stand. */
export type ClaimResult = { won: true } | { won: false; why: string };

export const dryActions: Actions = {
  async claim() {
    return { won: true };
  },
  async release() {},
  async answerTurn() {},
  async appendLog() {},
  async closeMerged() {
    return "by-hand";
  },
};
