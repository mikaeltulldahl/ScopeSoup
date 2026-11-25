// The shapes the server sends to the board. Types only: `web/` imports them with `import type`.

import type { Actor, Assumption, BatchMemberState, DecisionOption, BatchStatus, ConflictVersions, HistoryLine, LinkType, LogWriter, OpenQuestion, OriginalFate, Priority, ProposedPart, Ref, ParkedDraft, ParkedKind, ParkedQuestion, RunStatus, SessionRole, SessionStatus, TurnActor, UsageWindowKind, VerdictValue, WorkState } from "../model/types.ts";
import type { BisectMark } from "./bisect.ts";
import type { AllowanceUse, AllowanceWords } from "./allowanceBudget.ts";
import type { ForecastPoint, UsageAttribution, UsagePlot } from "./usage.ts";
import type { UsageForecast } from "./forecast.ts";
import type { Progress } from "./estimates.ts";
import type { Lane } from "./lanes.ts";
import type { AgentsState, MergeQueueState, QueueHealth } from "./snapshot.ts";
import type { Tone } from "./turns.ts";

export type { BisectMark, Lane, Progress, Tone };

export interface ItemLink {
  ref: Ref;
  /** refKey of the item: what `/api/item?ref=` takes. */
  key: string;
  /** "#342". */
  label: string;
  title: string;
}

/** A decision an implementor took itself, with the Item it was taken on and, once overturned, the Item that reworks it. */
export interface AssumptionView extends Assumption {
  item: ItemLink;
  newItem?: ItemLink;
}

export interface ChangeLink {
  ref: Ref;
  label: string;
  title: string;
  /** Where the diff is, on the host. */
  url?: string;
  draft: boolean;
}

export interface SessionView {
  ref: Ref;
  role: SessionRole;
  status: SessionStatus;
  live: boolean;
  subject: Ref;
  model?: string;
  lastAction?: string;
  attempt: number;
  startedAt: string;
  lastEventAt?: string;
  finishedAt?: string;
  costUsd?: number;
  endReason?: string;
  /** A turn of a person's chat with the session, not a step. */
  chat?: true;
}

/** A review finding, or a failing check, in a Rounds row. The text is data from agents. */
export interface RoundFinding {
  severity?: "must" | "should";
  text: string;
}

/**
 * One row of the Item page's Rounds table: a step of the cycle (a session, the check at level 4) or the Item's outcome.
 * Every text in it was written by agents or read from a log: data, shown as text.
 */
export interface RoundRow {
  /** "step": a session; "check": the merge's check at level 4; "end": merged, or parked (escalated, waiting for you). */
  kind: "step" | "check" | "end";
  /** In words: "triage", "implement", "review", "check", "merged", "escalated", "waiting for you", "in the merge queue". */
  step: string;
  /** Why an implement step ran again: "with the review's findings", "with the failing check", "to merge it". */
  resumed?: string;
  /** For a review and an implement: the round, 1 for the first. */
  round?: number;
  /** The model the session ran on; for a check, the command (or "every check on GitHub"). */
  model?: string;
  /** When the row's step ended (a session's log line, the check's line), or since when the Item parked. */
  at: string;
  /** What it found or decided, in a sentence. */
  found?: string;
  /** Each review finding with its severity, or the failing check. Passing rules are not listed. */
  findings: RoundFinding[];
  /** What it did, in a sentence: the implementor's summary. */
  did?: string;
  /** The commits it made (full ids), oldest first. */
  commits: string[];
  durationMs?: number;
  costUsd?: number;
  /** "good" (ready, approved, passed, merged), "bad" (changes asked, failed, escalated), "wait" (a person's turn, running). */
  tone?: "good" | "bad" | "wait";
  /** The session ended otherwise than it should: "failed", "cancelled", "limit". */
  outcome?: string;
  /** The session runs now. */
  live?: boolean;
  /** Scope Soup's session id: its details (`GET /api/session`). */
  session?: string;
  /** The agent's own session: the chat with it. */
  agentSession?: string;
}

/** `GET /api/session`: one session with what its stream shows. Text from agents: data. */
export interface SessionDetailsView {
  session: SessionView & { agentSession?: string; streamName?: string };
  /** The tools it called, most used first. */
  tools: { name: string; count: number }[];
  /** What it did, in a few words each, oldest first; the last `ACTIONS_SHOWN` when there were more. */
  actions: string[];
  /** How many actions were left out at the start. */
  actionsOmitted: number;
  /** The stream could not be read (moved, deleted, never written): why. */
  missing?: string;
}

export interface CardView extends ItemLink {
  lane: Lane;
  /** Whose turn it is. */
  actor: TurnActor;
  /** For actor "person": the person's name, and whether it is this board's person (then it is in `yourTurn`). */
  person?: { name: string; mine: boolean };
  /** Why it is where it is and what it waits for, in words. Always set. */
  reason: string;
  /** In "Your turn": only what waits and how many ("2 questions", "a draft to accept", "escalated"). Absent when the reason is short already. */
  waits?: string;
  /** Who holds the Item, by name. */
  heldBy?: string;
  /** How many of the implementors' decisions on the Item nobody has accepted or overturned yet. */
  openDecisions?: number;
  tone: Tone;
  since?: string;
  /** Open items transitively blocked behind this one. */
  unblocks: number;
  priority?: Priority;
  needsDecision: boolean;
  /** Backlog only: 1 is the item the orchestrator starts next. */
  position?: number;
  /** Backlog only: the place and the reasons for it in words ("2nd: major bug, ...; behind #41 because ..."). */
  why?: string;
  /** Backlog only: why Vote up or Vote down is off (the Item is at the edge of its group), in a few words. */
  voteOff?: { up?: string; down?: string };
  change?: ChangeLink;
  session?: SessionView;
  batch?: { ref: Ref; name: string; status: BatchStatus };
  url?: string;
}

export interface LaneView {
  lane: Lane;
  title: string;
  /** All items in the lane; `cards` may be cut short (done). */
  total: number;
  cards: CardView[];
  /**
   * Backlog only, from level 1: how many of its cards (the last ones) are Items not triaged yet (no triage). The board
   * draws a divider above them. Left out at level 0.
   */
  notTriaged?: number;
}

export interface BatchMemberView {
  change: ChangeLink;
  /** The items the change is for: what a person follows. */
  items: ItemLink[];
  sha: string;
  state: BatchMemberState;
  /** Set while or after a bisect. */
  mark?: BisectMark;
  /** The member the failure report points at. */
  suspect: boolean;
}

export interface ProbeView {
  /** The probe tested the first `prefix` members of the chain. */
  prefix: number;
  status: RunStatus;
  /** "first 2 of 4: passed". */
  words: string;
  /** For a probe that is queued or running. */
  progress?: Progress;
}

export interface BatchView {
  ref: Ref;
  key: string;
  /** "batch 6". */
  name: string;
  status: BatchStatus;
  /** The state in words: "checking", "bisecting: culprit is among #316 and #340". */
  words: string;
  base: string;
  note?: string;
  startedAt?: string;
  finishedAt?: string;
  members: BatchMemberView[];
  /** One bar for the whole batch. */
  progress: Progress;
  bisect?: { goodPrefix: number; badPrefix: number; culprit?: ChangeLink; probes: ProbeView[] };
}

export interface WaitingView {
  position: number;
  change: ChangeLink;
  items: ItemLink[];
  since: string;
}

/** What the merge queue lease said when this machine last asked: only one machine merges at a time. */
export interface MergeQueueView {
  /** The machine that holds it; null when nobody did. */
  holder: string | null;
  mine: boolean;
  until?: string;
  at: string;
}

export interface QueueView {
  /** Checking or bisecting. */
  batches: BatchView[];
  forming: BatchView[];
  waiting: WaitingView[];
  /** The last few finished batches, newest first. */
  recent: BatchView[];
  /** Why it is paused, its flakes and problems, what it measured. Absent when it never ran. */
  health?: QueueHealth;
  /** Set by the server on a project that several machines share: which machine merges now. */
  mergeQueue?: MergeQueueView;
}

export interface RunnerView {
  id: string;
  name: string;
  online: boolean;
  busy: boolean;
  /** Since when it has been in this state. */
  since?: string;
  /** "online, busy 4 min", "away for 2 h". */
  words: string;
}

export interface UsageWindowView {
  kind: UsageWindowKind;
  /** "5 h" or "week". */
  label: string;
  /** 0 to 1; absent when the agent did not report it. */
  utilization?: number;
  resetsAt: string;
  /** Where it is heading at the recent rate; absent with too few readings. */
  forecast?: { outcome: "used_up" | "lasts"; at?: string; words: string };
}

export interface StatusLine {
  /** No agent role is started: no new session starts. */
  paused: boolean;
  /** The three agent roles together: "started" while any is. */
  agents: AgentsState;
  /** Resume / Pause on the Backlog lane (from level 1). */
  triage: AgentsState;
  /** Resume / Pause on the In progress lane (from level 2). */
  implement: AgentsState;
  /** Resume / Pause on the In review lane (from level 3). */
  review: AgentsState;
  /** Resume / Pause on the Queued lane; means something only at level 4. */
  mergeQueue: MergeQueueState;
  /** The project's level; absent with no project configuration (board only: no orchestrator, no Start). */
  level?: number;
  runners: { online: number; busy: number; total: number; list: RunnerView[] };
  usage: { at: string; status?: string; windows: UsageWindowView[] } | null;
  queue: { waiting: number; forming: number; testing: number; bisecting: number };
  sync: { lastAt?: string; error?: string };
  /** Why nothing runs: the orchestrator's idle reason. Absent while it starts work. */
  idle?: string;
  /** Something a person should look at: runner away with work waiting, a red batch with no suspect. */
  alerts: string[];
}

/** `resources` of the board: each limited resource, who holds its units and what waits for one. */
export interface ResourcesView {
  resources: {
    name: string;
    units: number;
    /** Held across machines on the project's remote. */
    shared: boolean;
    neededBy: string[];
    /** `who`: the session ("implement for A-12") or the check here, or the machine that holds it (`elsewhere`). */
    held: { unit: number; who: string; since?: string; until?: string; elsewhere?: true }[];
    waiting: { who: string; since: string }[];
  }[];
}

/** An Item draft waiting for a person (decision 95), shown in Your turn. Its text came from an agent and was made inert. */
export interface DraftView {
  id: string;
  title: string;
  description: string;
  verification: string;
  role: "triage" | "implementor" | "reviewer";
  at: string;
  /** The Item it was found while working on. */
  from: { key: string; id: string; title?: string };
  /** Why Approve is not offered here (the source Item's host cannot be written from this board). Absent: it is. */
  readOnly?: string;
}

export interface BoardView {
  /** The server's clock when the view was built. The browser animates from it. */
  now: string;
  lanes: LaneView[];
  yourTurn: CardView[];
  queue: QueueView;
  status: StatusLine;
  /** Set by the server: items can be created here (the project's host can be written to). */
  canWrite?: boolean;
  /** Set by the server: the Item drafts waiting for a person, oldest first. In every person's Your turn. */
  drafts?: DraftView[];
  /** Set by the server when the project declares limited resources. */
  resources?: ResourcesView;
  /** Set by the server: the people Scope Soup knows (holds, log lines, answers), for the board's person picker. */
  people?: string[];
  /** Set by the server: a Jira holder's display name by the account id in `people`, for the picker to show (the id stays the value). */
  peopleNames?: Record<string, string>;
  /**
   * Set by the server with a project configuration at level 0: how many ready Items have no triage (no triage
   * `session` line in their log, no stored triage result). Left out when there are none.
   */
  withoutTriage?: number;
  /** Set by the server: which project this board belongs to. */
  project?: ProjectView;
}

/**
 * A folder of the project the server opens in the file manager, named, never given as a path: "checkout" is the person's
 * own clone (`ownClone`, else the first of `realPaths`), "clone" is Scope Soup's clone (`repoPath`), "config" the folder of
 * `scopesoup.config.json`.
 */
export type FolderName = "checkout" | "clone" | "config";

/** The project a board belongs to, for its header and tab. */
export interface ProjectView {
  /** The configured `project`, or the repository's name without a configuration. */
  name: string;
  /** "owner/name" from the GitHub host or the remote's URL, else the remote's name; null when there is none. */
  repository: string | null;
  /** The repository's page on GitHub, when the host or the remote is GitHub. */
  github: string | null;
  /** The folders that are configured and there, which `POST /api/open-folder` opens. */
  folders: FolderName[];
}

/** The filters of the item list (`GET /api/items`); all optional, all combined with "and". */
export interface ItemListQuery {
  /** Text in the title, the id or the description. */
  q?: string;
  /** Work states, or "open" for everything not done or abandoned. */
  state?: string[];
  /** Lanes (the board's words), or "abandoned" for items that are on no lane. */
  lane?: string[];
  priority?: Priority[];
  /** Whose turn it is. */
  turn?: TurnActor[];
  label?: string;
  /** Who holds it, or "none". */
  holder?: string;
  /** Whether the item has a change. */
  change?: "yes" | "no";
  /** Done, and last changed within this many days. */
  doneDays?: number;
  /** A person's name or id, or "me". */
  createdBy?: string;
  /** Only these items (their ref keys), in this order. */
  keys?: string[];
}

export interface ItemListRow {
  key: string;
  /** "#342". */
  label: string;
  title: string;
  state: WorkState;
  /** Null for an abandoned item. */
  lane: Lane | null;
  actor: TurnActor;
  reason: string;
  tone: Tone;
  priority?: Priority;
  labels: string[];
  holder?: string;
  change?: { label: string; state: "open" | "merged" | "closed" };
  updatedAt: string;
}

/** `GET /api/items`: the matching items, newest change first; `total` counts all of them, `items` stops at a bound. */
export interface ItemListView {
  now: string;
  total: number;
  items: ItemListRow[];
  /** Every label in use, for the filter. */
  labels: string[];
  /** Who "me" is on this board. */
  me?: string;
}

/** `GET /api/status`: the board, compact, for scripts and agents. */
export interface StatusView {
  now: string;
  /** No agent role is started (kept for scripts written for `/api/pause` and `/api/resume`). */
  paused: boolean;
  agents: AgentsState;
  triage: AgentsState;
  implement: AgentsState;
  review: AgentsState;
  mergeQueue: MergeQueueState;
  level?: number;
  lanes: Record<Lane, number>;
  yourTurn: { ref: string; label: string; title: string; reason: string; unblocks: number }[];
  batches: { name: string; status: BatchStatus; words: string; members: string[]; progress: string }[];
  queue: StatusLine["queue"];
  runners: { name: string; words: string }[];
  usage: { kind: UsageWindowKind; utilization?: number; resetsAt: string; forecast?: { outcome: "used_up" | "lasts"; at?: string; words: string } }[];
  sync: StatusLine["sync"];
  alerts: string[];
}

export interface VerdictView {
  dimension: string;
  value: VerdictValue;
  score?: number;
  by?: Actor;
  stale: boolean;
  url?: string;
}

export interface ItemChangeView extends ChangeLink {
  state: "open" | "merged" | "closed";
  target: string;
  author: Actor;
  /** How many revisions; the last one is current. */
  revisions: number;
  sha: string;
  verdicts: VerdictView[];
  mergeable?: boolean;
  blockers: string[];
  updatedAt: string;
}

export interface RunView {
  ref: Ref;
  pipeline: string;
  status: RunStatus;
  sha: string;
  runner?: string;
  startedAt?: string;
  finishedAt?: string;
  progress: Progress;
  url?: string;
}

export interface ItemPage {
  now: string;
  item: ItemLink & {
    body?: string;
    state: WorkState;
    hostState: string;
    labels: string[];
    verification?: string;
    priority?: Priority;
    holder?: { actor: Actor; until?: string; since?: string; from?: string; quiet?: boolean };
    parent?: ItemLink | { ref: Ref; label: string };
    openChildren: number;
    updatedAt: string;
    url?: string;
    /** The link to `url` in words, naming the host: "Open on GitHub", "Open in Jira". */
    openWords?: string;
  };
  /** Null for an abandoned item. */
  lane: Lane | null;
  actor: TurnActor;
  /** For actor "person": the person's name, and whether it is this board's person. */
  person?: { name: string; mine: boolean };
  reason: string;
  /** What waits on a person, short, as on the card ("2 questions"). */
  waits?: string;
  /** Who holds the Item, by name, as on the card. */
  heldBy?: string;
  /** A backlog Item's place and why, as on its card. */
  why?: string;
  /** Vote up and Vote down are offered: the Item is open and its host can keep a vote. */
  canVote?: boolean;
  /** Why Vote up or Vote down is off, as on the card. */
  voteOff?: { up?: string; down?: string };
  tone: Tone;
  unblocks: number;
  /** The decision the item waits for. On a host without a log the discussion lives on the host (`item.url`). */
  decision: { needed: boolean; words: string };
  /** Questions in the item's log with no answer yet, oldest first (meta branch). Answered with `to: at`. The text is data. */
  questions: OpenQuestion[];
  /**
   * Triage's proposed restructuring, waiting for a person (Accept, Edit, Reject). It comes from an open question line (meta branch;
   * `at` and `by` name it) or from the orchestrator's parked state (GitHub, kept in Scope Soup's store): what becomes of the Item,
   * the parts and where each goes, the answers carried over into each new one, and the parts made so far (a failed accept made
   * some), each with its part's index. Accepting makes the rest when `canCreate` (set by the server: the host can be written here);
   * otherwise it is for a person to carry out by hand, and accepting only records it. The text is data.
   */
  proposal?: {
    reason: string; at?: string; by?: LogWriter;
    original: OriginalFate; parts: ProposedPart[]; carried?: string; created?: (ItemLink & { part: number })[]; canCreate?: boolean;
    /** Per part: the existing Item it goes into as it stands (`busy`: an open change or an agent on it), or null. */
    targets?: ((ItemLink & { state: WorkState; busy?: string }) | null)[];
  };
  /** Set by the server when the item is in conflict: `item.md` as it stands and the versions put aside. The text is data. */
  conflict?: ConflictVersions;
  /** Set when the orchestrator has put the item down. `canAnswer` is true when an answer from a person picks it up again. */
  parked?: { as: ParkedKind; reason: string; at: string; canAnswer: boolean; /** Offers "Start over": drop the work so far and start at triage. */ canStartOver?: boolean; decision?: { question: string; options: DecisionOption[]; recommendation: string; context?: string; multiSelect?: true }; /** Several open questions, each answered on its own (by its index); the item is picked up once all have an answer. */ questions?: ParkedQuestion[]; /** The triage's draft and its questions, settled together (`POST /api/draft`). */ refine?: ParkedDraft };
  /** The triage's typed links to other Items: the other Item when it is known here, else the id as written. Text from an agent: data. */
  links?: { type: LinkType; item: ItemLink | { label: string }; reason?: string }[];
  /** What a person has answered on this item, oldest first. */
  answers: { question?: string; answer: string; by: string; at: string }[];
  blockedBy: (ItemLink & { open: boolean })[];
  blocks: ItemLink[];
  changes: ItemChangeView[];
  runs: RunView[];
  batches: { batch: BatchView; memberState: BatchMemberState; position: number }[];
  sessions: { live: SessionView[]; finished: SessionView[] };
  /** One row per step of the cycle, oldest first, then the outcome. Built from the item's log (`src/core/rounds.ts`). */
  rounds: RoundRow[];
  /** The item's log in words, oldest first. Empty on a host without a log. */
  history: HistoryLine[];
  /** The decisions implementors took themselves on this Item, newest first, open or settled. */
  assumptions: AssumptionView[];
  /** Set by the server: they can be accepted and overturned here. */
  canSettle?: boolean;
  /** Set by the server: the item can be edited here. */
  canEdit?: boolean;
  /**
   * Set by the server when the Item has images agents attached (`src/core/media.ts`): their names, and whether they are pushed
   * to the project's remote (`media.push`), so that everyone with the repository sees them, or stay on this machine.
   */
  media?: { names: string[]; shared: boolean };
  /**
   * Set by the server where the Item's hold can be changed here: the board's buttons. Claim is there unless the board's person
   * holds the Item, Hand back when they do, Release while a person holds it (anyone releases anyone's hold, the log names
   * both). `why` says why a button cannot be pressed now. `branch` is there for the holder: where to work and push.
   */
  hold?: { claim?: HoldAction; handBack?: HoldAction; release?: HoldAction; branch?: ItemBranch };
  /** Set by the server: the states an edit may choose (a GitHub Item has no `waiting`). */
  states?: string[];
}

/**
 * The Item's branch, for the person who holds it: its name is fixed (`scopesoup/<item>`), and the commands to copy start it
 * from the main branch, or switch to it when it is on the remote already (`GET /api/item/branch` says which), then push it.
 */
export interface ItemBranch {
  name: string;
  remote: string;
  mainBranch: string;
  start: string;
  resume: string;
  push: string;
}

/** `GET /api/item/branch`: whether the Item's branch is on the remote now; `problem` when the remote could not be asked. */
export interface ItemBranchState {
  branch: string;
  onRemote?: boolean;
  problem?: string;
}

/** One of the hold buttons on the Item page. */
export interface HoldAction {
  /** Why it cannot be pressed now, in words; absent when it can. */
  why?: string;
}

/** One file of an item's change. `diff` is plain text and is absent when the file is binary, too large, or past the bounds. */
export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  diff?: string;
  /** Why there is no `diff`. */
  note?: string;
}

/** The item's branch against where it left the main branch (`GET /api/diff`). Everything in it is data, never markup. */
export type DiffView =
  | { now: string; available: false; reason: string }
  | {
      now: string;
      available: true;
      branch: string;
      /** The commit the branch left the main branch at. */
      base: string;
      /** The commit the branch points at, proposed by the board's hand-back form. */
      tip: string;
      files: DiffFile[];
      /** Files past the list's bound: counted, not named. */
      omitted: number;
      totalAdded: number;
      totalRemoved: number;
    };

/** One commit of the project's history (`GET /api/history`). Text is data, never markup. */
export interface HistoryCommit {
  sha: string;
  parents: string[];
  author: string;
  at: string;
  /** First line of the message. */
  subject: string;
  /** Branch names that point at this commit. */
  refs: string[];
  onMain: boolean;
  /** refKey of the item whose branch this commit is the tip of, or whose number the subject names. */
  item?: string;
  /** A main commit that an item merged. */
  merged?: boolean;
  /** Item branches that point at this main commit but have no commits of their own yet: they start here, nothing merged. */
  starts?: string[];
  /** Where the commit sits in the graph (src/core/graph.ts). */
  graph: LaneRow;
}

/** Lines in the half above a commit's dot and the half below: lane to lane. */
export interface LaneRow {
  lane: number;
  top: { from: number; to: number }[];
  bottom: { from: number; to: number }[];
}

export type HistoryView =
  | { now: string; available: false; reason: string }
  | { now: string; available: true; mainBranch: string; commits: HistoryCommit[]; lanes: number; limit: number; more: boolean };

/** What a row of the activity timeline is about, for its filter: one word each. */
export type ActivityKind = "item" | "triage" | "question" | "decision" | "session" | "merge" | "batch" | "switch" | "upgrade" | "settings";

/** An Item a row links to. The title is data from people and agents. */
export interface ActivityItem {
  key: string;
  id: string;
  title?: string;
  /** No Item with this key is known here (removed, or never synced): named, not linked. */
  gone?: true;
}

/** One thing that happened (`GET /api/activity`), in words. Text from people and agents is data, never markup. */
export interface ActivityRow {
  /** Unique in the view, the same on every read. */
  id: string;
  at: string;
  kind: ActivityKind;
  /** The person, the agent's role ("implementor"), "merge queue" or "Scope Soup". */
  who: string;
  agent: boolean;
  text: string;
  /** A quote under the line: a session's summary, the decisions taken. */
  detail?: string;
  /** The Items it is about; the first is the main one. */
  items: ActivityItem[];
  tone?: "good" | "bad";
  /** A session row's role, duration and cost, for folding sessions together. */
  session?: { role: string; ms?: number; usd?: number };
}

/** A row as shown: consecutive sessions on one Item folded into one row that holds them (newest first). */
export interface FoldedActivityRow extends ActivityRow {
  folded?: ActivityRow[];
}

export interface ActivityView {
  now: string;
  /** Newest first. */
  rows: ActivityRow[];
  /** Older rows were left out to keep the view bounded. */
  more: boolean;
}

/** One commit's full message and the files it changed (`GET /api/commit`). */
export type CommitView =
  | { now: string; available: false; reason: string }
  | { now: string; available: true; sha: string; message: string; files: DiffFile[]; omitted: number; totalAdded: number; totalRemoved: number };

/** Who used the usage windows over a span (`GET /api/usage`). */
/** One usage window on the Usage page. */
export interface UsagePageWindow extends UsageAttribution {
  /** The newest reading, with the status line's forecast; absent before the first reading. */
  current?: { utilization: number; resetsAt: string; at: string; forecast?: UsageForecast };
  /** The share kept for people's own use: Scope Soup starts nothing once the window is at 1 minus this. Absent without a configuration. */
  reserve?: number;
  /** How full the window got over the span, split by role. */
  plot: UsagePlot;
  /** The forecast from now to the reset; empty without one. */
  forecastLine: ForecastPoint[];
}

/** A provider's monthly allowance on the Usage page, for a provider that reports no window: the month's use against the allowance. */
export interface AllowanceView extends AllowanceWords {
  /** The provider's name. */
  provider: string;
  /** The month's start and the next reset (ISO). */
  from: string;
  resetsAt: string;
  /** The plan's monthly allowance; absent when none is set. */
  allowance?: number;
  /** The share of the allowance kept for people's own use. */
  reserve: number;
  /** Used this month, in all and per role. */
  used: number;
  byRole: AllowanceUse["byRole"];
  sessions: number;
}

export interface UsageView {
  now: string;
  /** "5h", "7d" or "<N>d". */
  span: string;
  from: string;
  to: string;
  /** One per usage window: how full it is now, how full it got over the span, and how much went to each role. */
  windows: UsagePageWindow[];
  /** Sessions that ran in the span, and how many had token counts in their stream. */
  sessions: number;
  withTokens: number;
  /** One per provider some role runs on that counts a monthly allowance instead of reporting windows; absent when none does. */
  allowances?: AllowanceView[];
}

/** One turn of a person's chat with a session: the message, and the reply as far as it is written. */
export interface ChatTurnView {
  id: string;
  at: string;
  message: string;
  /** The reply's text so far; empty until the session writes. Plain text: never set as HTML. */
  reply: string;
  live: boolean;
  /** While live: what the session is doing now ("reading README.md"). */
  lastAction?: string;
  /** Set when the turn ended without a reply that counts: why. */
  failed?: string;
  finishedAt?: string;
}

/** A session of the item that a person can talk to (its own `agentSessionId`), with the chat so far. */
export interface ChatSessionView {
  agentSession: string;
  role: SessionRole;
  model?: string;
  /** When its newest step session (not a chat turn) started. */
  startedAt: string;
  turns: ChatTurnView[];
}

/** `GET /api/chat`: the item's sessions, newest first, and why a message cannot be sent now. */
export interface ChatView {
  now: string;
  sessions: ChatSessionView[];
  /** Why no message can be sent now (a session runs on the item, the usage stop, ...); absent when one can. */
  blocked?: string;
}
