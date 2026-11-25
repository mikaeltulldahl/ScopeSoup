// The host-neutral model. Nothing here knows about GitHub, Gerrit or any other host.
// Times are ISO 8601 strings in UTC. Durations are milliseconds.

export type RefKind = "work" | "change" | "run" | "batch" | "session";

/** Points at one object on one host (or in Scope Soup itself, host "scopesoup"). */
export interface Ref {
  host: string;
  kind: RefKind;
  id: string;
  url?: string;
}

export function refKey(ref: Ref): string {
  return `${ref.host}:${ref.kind}:${ref.id}`;
}

export interface Actor {
  id: string;
  name: string;
  bot?: boolean;
}

// --- Work items ---

/** Normalised position of an item in its life. The board's lanes are derived from this plus changes and batches. */
export type WorkState = "todo" | "doing" | "waiting" | "done" | "abandoned";

/** How urgent an item is. An item may have none. */
export type Priority = "blocker" | "critical" | "major" | "minor";

export interface WorkItem {
  ref: Ref;
  title: string;
  body?: string;
  state: WorkState;
  /** The host's own status or label set, kept for display and for conventions. */
  hostState: string;
  labels: string[];
  blockedBy: Ref[];
  parent?: Ref;
  openChildren: number;
  /** How many sub-items the item has in all, open or done; absent when the host did not say. */
  children?: number;
  /** A claim or an assignee. */
  holder?: { actor: Actor; until?: string };
  /** How the item is proved done, when the project uses verification. */
  verification?: string;
  priority?: Priority;
  /** The vote, a score offset in points (2 decimals), added to the Item's score; absent is 0. */
  vote?: number;
  /** True when the item waits for a decision by a person. */
  needsDecision?: boolean;
  updatedAt: string;
  /** What has happened to the item, oldest first, on a host that keeps a log per item (meta branch). */
  history?: HistoryLine[];
  /** The same log as lines with their fields, oldest first (meta branch). The orchestrator rebuilds its jobs from it. */
  log?: LogRecord[];
  /** Questions in the item's log with no answer yet, oldest first (meta branch). An answer names one by its `at` and `by`. */
  openQuestions?: OpenQuestion[];
  /** Answers kept on the host, oldest first (GitHub: answer comments and `A1:` replies). */
  answers?: RecordedAnswer[];
  /** Scope Soup's own record in the item's comments (GitHub), from which `recover.ts` rebuilds a job after the store is lost. */
  hostRecord?: HostRecord;
  /**
   * Scope Soup's `merged` marker on the item (GitHub): the closing comment's commit, main branch and batch, and when it was
   * written. `reopened`: the time of a `reopened` event newer than the marker, which undoes it (the Item is work again).
   */
  merged?: { sha: string; target: string; batch?: number; at: string; reopened?: string };
  /** The Item was closed as a duplicate of this one (GitHub: the `duplicate` line in Scope Soup's log comment). */
  duplicateOf?: Ref;
  /**
   * A person's hand-back on a host with no pull requests (Jira: Scope Soup's hand-back comment), when it is newer than Scope Soup's
   * own newest revision of the Item: the branch and its tip, for review, check and merging.
   */
  handedBack?: { sha: string; branch: string; by: Actor; at: string; note?: string };
  /**
   * The decisions an implementor took itself as cheap to change later, oldest first, settled or not (GitHub: Scope Soup's
   * `assumption` comments; metaBranch: `assumption` lines and the `accepted` and `overturned` lines that name them).
   */
  assumptions?: Assumption[];
}

/** A decision an implementor took itself and recorded, for a person to accept or overturn. Text from an agent: data. */
export interface Assumption {
  /** The host's id of the decision: GitHub `<comment id>-<n>`, meta branch `<line at>#<n>` (n counts from 0 in its record). */
  id: string;
  /** When it was recorded. */
  at: string;
  /** What had to be decided. */
  question: string;
  chosen: string;
  /** The other options it weighed. */
  others: string[];
  why: string;
  /** Absent while it is open. */
  settled?: AssumptionSettled;
}

export interface AssumptionSettled {
  verdict: "accepted" | "overturned";
  at: string;
  by: string;
  /** With "overturned": the person's answer, the decision the new Item carries. */
  answer?: string;
  /** With "overturned": the Item made to rework or revert it. */
  item?: Ref;
  /** With "overturned": the change had not merged, so the answer went into the running work and no Item was made. */
  work?: true;
}

/** What Scope Soup's comments on an issue say about where it stands. */
export interface HostRecord {
  /** The lines of the one log comment, oldest first, all Scope Soup's. */
  log: LogRecord[];
  /** How many older lines the log comment dropped to stay under the comment limit. */
  dropped: number;
  /** How many triage draft comments the issue has: the rounds so far. */
  draftRounds: number;
  /** The ids of the question comments that belong to a draft (they do not park the Item on their own). */
  draftQuestions: string[];
  /** The newest triage draft, while it waits: unanswered and no other Scope Soup question after it. */
  draft?: HostDraft;
  /** Scope Soup's questions deleted on the host, a person's "don't ask that": every prompt names them. */
  deletedQuestions?: string[];
}

/** A triage draft comment and its question comments, answered or not. */
export interface HostDraft {
  id: string;
  round: number;
  at: string;
  /** The proposed description, as the comment shows it. */
  text: string;
  /** True when the issue's body is still the one the draft read (its sha256 is the marker's `bodySha`). */
  bodyKnown: boolean;
  questions: OpenQuestion[];
  /** The label changes the draft's marker proposes. */
  labels?: LabelChange;
}

/** Who wrote a log line, as the log has it. */
export interface LogWriter {
  who: string;
  machine?: string;
  agent: boolean;
}

/** One readable line of an item's log. The fields are data from people and agents. */
export interface LogRecord {
  at: string;
  by: LogWriter;
  kind: string;
  /** The line's own fields, without `at`, `by` and `kind`. */
  fields: Record<string, unknown>;
}

/**
 * One option of a decision: a short label and what choosing it means and why. Older lines and answers
 * carry plain text, which stays valid.
 */
export type DecisionOption = string | { label: string; description: string };

/** An option as one line of text: the plain text, or "label: description". */
export function optionText(option: DecisionOption): string {
  if (typeof option === "string") return option;
  return option.description ? `${option.label}: ${option.description}` : option.label;
}

/** The options of an agent's answer or a log line: plain text or `{ label, description }`, anything else dropped. */
export function asOptions(value: unknown): DecisionOption[] {
  if (!Array.isArray(value)) return [];
  const out: DecisionOption[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry.trim() !== "") out.push(entry);
    } else if (typeof entry === "object" && entry !== null && typeof (entry as { label?: unknown }).label === "string" && (entry as { label: string }).label.trim() !== "") {
      const { label, description } = entry as { label: string; description?: unknown };
      out.push({ label: label.trim(), description: typeof description === "string" ? description.trim() : "" });
    }
  }
  return out;
}

/** The parts of a proposed split: each needs a title; a part without one is dropped. Texts are trimmed. */
export function asParts(value: unknown): ProposedPart[] {
  if (!Array.isArray(value)) return [];
  const parts: ProposedPart[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const { title, description, verification } = entry as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim()) continue;
    parts.push({
      title: title.trim(),
      description: typeof description === "string" ? description.trim() : "",
      verification: typeof verification === "string" ? verification.trim() : "",
    });
  }
  return parts;
}

export interface OpenQuestion {
  /** The host's own id for the question, where it has one (GitHub: the question comment's id). */
  id?: string;
  /** The question line's `at`: an answer's `to`. */
  at: string;
  /** The question line's writer: an answer's `toBy`. */
  by: LogWriter;
  question: string;
  options: DecisionOption[];
  recommendation?: string;
  /** What the asker said beyond the options. */
  context?: string;
  /** Several options may be picked. */
  multiSelect?: true;
  /** Set when the question is a proposed split of the item. */
  proposal?: TextProposal;
}

/** An item whose text was changed on two machines: what it says now and each version put aside (`id` names it in a resolution). */
export interface ConflictVersions {
  current: string | null;
  aside: { id: string; name: string; text: string }[];
}

/** One line of an item's log, in words. The text is data from people and agents. */
export interface HistoryLine {
  at: string;
  by: Actor;
  /** The log's kind: `created`, `edited`, `question`, `answer`... */
  kind: string;
  text: string;
}

// --- Changes ---

export interface Revision {
  id: string;
  sha: string;
  number?: number;
  createdAt: string;
  author?: Actor;
}

export type VerdictValue = "pass" | "fail" | "pending" | "none";

/** One judgement of one revision in one dimension. */
export interface Verdict {
  /** "review", "ci", or a host's own label name. */
  dimension: string;
  value: VerdictValue;
  /** Numeric vote where the host has one (Gerrit). */
  score?: number;
  by?: Actor;
  /** The revision id the verdict was given on. */
  revision?: string;
  /** Given on an older revision and not carried forward. */
  stale: boolean;
  url?: string;
}

export interface Change {
  ref: Ref;
  title: string;
  author: Actor;
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** Target branch. */
  target: string;
  /** The branch the change's commits are on, when the host keeps one per change. */
  branch?: string;
  /** Oldest first; the last one is current. At least one. */
  revisions: Revision[];
  verdicts: Verdict[];
  labels: string[];
  /** The work items this change is for. */
  works: Ref[];
  stack?: { parent?: Ref; position?: number };
  mergeable?: boolean;
  /** Why it cannot merge, in words. */
  blockers?: string[];
  updatedAt: string;
}

// --- CI ---

export type RunStatus = "queued" | "running" | "passed" | "failed" | "cancelled";

export interface RunStep {
  name: string;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
}

export interface Run {
  ref: Ref;
  /** The kind of run, used to group history for estimates: "full suite", "light check". */
  pipeline: string;
  sha: string;
  branch?: string;
  status: RunStatus;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  /** The host's own estimate when it has one (Jenkins). */
  estimateMs?: number;
  runner?: string;
  steps?: RunStep[];
}

export interface Runner {
  id: string;
  name: string;
  online: boolean;
  busy: boolean;
  labels: string[];
  current?: Ref;
}

// --- Batches ---

export type BatchStatus = "forming" | "testing" | "bisecting" | "merged" | "failed";

export type BatchMemberState = "waiting" | "testing" | "merged" | "culprit" | "requeued";

export interface BatchMember {
  change: Ref;
  sha: string;
  state: BatchMemberState;
}

/** One test of a prefix of the batch during a bisect. */
export interface BisectProbe {
  /** How many members from the start of the chain the probe covers. */
  prefix: number;
  status: RunStatus;
  run?: Ref;
}

export interface Batch {
  ref: Ref;
  status: BatchStatus;
  /** The commit on the main branch the chain was built on. */
  base: string;
  /** In chain order. */
  members: BatchMember[];
  runs: Ref[];
  probes: BisectProbe[];
  /** The member the failure report points at, if any. */
  suspect?: Ref;
  note?: string;
  startedAt?: string;
  finishedAt?: string;
}

// --- Sessions ---

/** The three roles: triage (`triage`), implement, review. A stored session of the removed "fix" role keeps its role string. */
export type SessionRole = "triage" | "implement" | "review";

export type SessionStatus = "starting" | "running" | "stalled" | "succeeded" | "failed" | "cancelled" | "limit";

export interface Session {
  ref: Ref;
  role: SessionRole;
  subject: Ref;
  status: SessionStatus;
  model?: string;
  /** The agent provider that ran it (`src/orchestrator/providers`), whose format its stream file is in. */
  provider?: string;
  /** The agent's own session id, used to resume. */
  agentSessionId?: string;
  pid?: number;
  attempt: number;
  startedAt: string;
  lastEventAt?: string;
  finishedAt?: string;
  /** The last thing the agent did, for the card. */
  lastAction?: string;
  costUsd?: number;
  /** Exactly one reason once the session is over. */
  endReason?: string;
  /** Where the raw stream is kept. */
  streamPath?: string;
  /** The folder the agent ran in (the worktree, or the project's repository in a clone of the pool). A chat turn resumes there: the agent CLI keeps a session per folder. */
  cwd?: string;
  /** A turn of a person's chat with an earlier session of the item (`agentSessionId`); never a step of the cycle. */
  chat?: true;
  /** The project's setup failed in the folder, so no agent ran: the setup's failure, not the agent's. */
  setupFailed?: true;
  /** With `setupFailed`: what happened, in a few words and without the setup's output ("exit 1"). What leaves the machine is built from it. */
  setupOutcome?: string;
}

// --- Turns ---

/**
 * "person" is one named person (`Turn.person`): an item they hold, or a parked Item on their hand-back. "anyone" is every
 * person's turn: a question Scope Soup asks, in everyone's list until someone answers it (people are equals).
 */
export type TurnActor = "anyone" | "person" | "agent" | "queue" | "runner" | "nobody";

/** Who must act next on a subject, and why, in words. */
export interface Turn {
  subject: Ref;
  actor: TurnActor;
  /** For actor "person": who (`who@machine` on the meta branch, the login on GitHub). */
  person?: Actor;
  reason: string;
  /** Only what waits and how many ("2 questions", "a draft to accept"), for "Your turn". */
  waits?: string;
  since?: string;
  /** How many other items wait behind this one. Used to order the "Your turn" list. */
  unblocks?: number;
}

// --- Parked and answers ---

/** "handed-over": left to a person to merge (a pull request the session opened, or a change that waited for an approval that was removed). */
export type ParkedKind = "queued" | "handed-over" | "needs-decision" | "not-ready" | "escalated";

/** An item the orchestrator has put down, and why. Most parked wait for a person. */
export interface Parked {
  subject: Ref;
  as: ParkedKind;
  reason: string;
  at: string;
  /** An answer goes on with the implement or fix step that asked; "Start over" (back to triage) is offered as a separate action. */
  canStartOver?: boolean;
  /** For "needs-decision": the question as triage phrased it. */
  decision?: { question: string; options: DecisionOption[]; recommendation: string; context?: string; multiSelect?: true };
  /** For "needs-decision": triage's proposed split of the item (a person accepts, edits or rejects it). */
  proposal?: TextProposal;
  /**
   * For "needs-decision" on several questions from triage: every one, in order, with the answer once given. An answer
   * names its question by its place in this list (`question` in `POST /api/answer`); the item is picked up once all have one.
   * Absent for a single question (`decision`).
   */
  questions?: ParkedQuestion[];
  /** The triage's draft of the description, with its questions (recommendations pre-selected on the Item page). */
  refine?: ParkedDraft;
}

/** How the triage says an Item relates to another. */
export type LinkType = "blockedBy" | "blocks" | "duplicateOf" | "conflictsWith" | "related";

/** One typed link from a triage: the other Item's id as the session wrote it, and why. Text from an agent: data. */
export interface ItemLinkAnswer {
  type: LinkType;
  item: string;
  reason?: string;
}

/** The triage's draft description parked for a person. Text from an agent: data. */
export interface ParkedDraft {
  /** The description as the triage read it. */
  original: string;
  draft: string;
  /** Round of the refinement loop, from 1; there is no cap. */
  round: number;
  questions: { question: string; options: DecisionOption[]; recommendation: string; context?: string; multiSelect?: true }[];
  /** The label changes proposed with the draft (existing labels only, never `scopesoup:*`), applied with it at Accept. */
  labels?: LabelChange;
  /** Labels the triage named that the repository does not have: dropped, and noted here. */
  droppedLabels?: string[];
}

/** Labels to add to and remove from an Item, by name. */
export interface LabelChange {
  add: string[];
  remove: string[];
}

/** One of the repository's labels, as the triage is shown them. Text from the host: data. */
export interface RepoLabel {
  name: string;
  description?: string;
}

/** One of several open questions an item parked on, and the answer to it so far. */
export interface ParkedQuestion {
  question: string;
  options: DecisionOption[];
  recommendation: string;
  context?: string;
  /** Several options may be picked. */
  multiSelect?: true;
  answer?: string;
}

/**
 * A proposed split, with the reason: triage found the item too large and names its parts. Accepting creates them as children of
 * the item (where the host can be written), and the item becomes an umbrella. Text from an agent: data. (A proposed rewrite of
 * the item's text was removed; an old one in a log is no longer an open question.)
 */
export interface TextProposal {
  reason: string;
  parts: ProposedPart[];
  /** The answers recorded on the item when the split was proposed, carried over into each part's text. */
  carried?: string;
  /** The children made so far (Scope Soup's store only; also found on the host by their marker line). A retry links and creates the rest. */
  created?: CreatedPart[];
}

/** A child made for part `part` (0-based) of a split. `linked` is false while it is not under its parent yet (a failed sub-issue link). */
export interface CreatedPart {
  part: number;
  ref: Ref;
  linked: boolean;
}

/** One part of a proposed split: a child item's title, description and verification. Text from an agent: data. */
export interface ProposedPart {
  title: string;
  description: string;
  verification: string;
}

/** What a person answered on an item (`by` names who). Kept by Scope Soup; sessions on the item are given it. */
export interface RecordedAnswer {
  subject: Ref;
  /** The host's id of the question it answers, where it has one (GitHub: the question comment's id). */
  to?: string;
  /** The question it answers, when it answered one. */
  question?: string;
  /** The option texts of that question, when it had options. */
  options?: string[];
  /** Hash of the item's text when the answer was given: the answer is reused for a reworded question only while it is the same. */
  textHash?: string;
  answer: string;
  by: string;
  at: string;
}

// --- Budget ---

export type UsageWindowKind = "five_hour" | "seven_day";

export interface UsageWindow {
  kind: UsageWindowKind;
  /** 0 to 1. Undefined when the source did not say. */
  utilization?: number;
  resetsAt: string;
}

export interface UsageSample {
  at: string;
  windows: UsageWindow[];
  /** "allowed", "allowed_warning" or "rejected", as the agent reported it. */
  status?: string;
  usingOverage?: boolean;
}

// --- Events ---

/** One row of the append-only log. */
export interface ScopeSoupEvent {
  seq: number;
  at: string;
  /** Dotted, object first: "work.updated", "session.started", "batch.probe". */
  kind: string;
  /** refKey of the subject, when there is one. */
  subject?: string;
  /** Who or what did it: "sync", "orchestrator", "queue", or the person's name. */
  actor: string;
  data: unknown;
}

/** One of the people's switches over an agent role (triage, implementors, review): Resume, Pause, or Stop (store/control.ts). */
export type AgentsState = "started" | "paused" | "stopped";
/** The people's switch over mergeQueue: Resume, Pause (a merge under way finishes), or Stop (it is cut off). */
export type MergeQueueState = "started" | "paused" | "stopped";
