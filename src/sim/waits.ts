// W, what an Item waits for, worked out by the checker on its own from the job, the sessions and the switches (the table in
// issue #211). It shares no code with the product's views on purpose: when the two disagree, rule A1 says so.

import type { Job } from "../orchestrator/jobs.ts";
import type { WorkItem } from "../model/types.ts";
import { itemTextHash } from "../core/answerReuse.ts";
import { where, stepAt } from "../orchestrator/jobs.ts";

export type Role = "triage" | "implement" | "review";
export type PersonWait = "answer" | "rewrite" | "restructuring" | "not-ready" | "escalated" | "merge" | "holds";
export type StartCause = "backlog" | "switch" | "level" | "usage" | "pace" | "timer" | "text" | "same-files" | "claim" | "cap" | "slot";

export type W =
  | { kind: "nothing" }
  | { kind: "not-started" }
  | { kind: "session"; role: Role; settling?: true }
  | { kind: "person"; why: PersonWait; n?: number }
  | { kind: "blocker"; on: string[] }
  | { kind: "queue" }
  | { kind: "start"; role: Role; cause: StartCause };

export interface WaitInput {
  item: WorkItem;
  job: Job | undefined;
  /** The roles of the item's live sessions. */
  live: Role[];
  /** The job names a session that is over and the tick has not settled yet. */
  settling?: boolean;
  /** That session's role, which may differ from the job's step: a person's pick over it changed the step (#268). */
  settlingRole?: Role;
  /** Open items by ref key, for blockers. */
  open: ReadonlyMap<string, WorkItem>;
  /** Scope Soup's own blockers of the item (ref keys). */
  ownBlockers: string[];
  switches: Record<Role, string>;
  level: number;
  usageReserve: boolean;
  /** Nothing runs and a window is over its pace line and not fresh: no session starts (decision 133). */
  paceHolds?: boolean;
  /** As many things wait for a person as the cap on new work, or more (decision 133). */
  workCapped?: boolean;
  now: string;
  /** Live sessions in all, and the limit. */
  liveCount: number;
  slots: number;
  /** Other items that are busy (implement begun, change not on main), with the paths their triage named. */
  busy: { key: string; paths: string[]; conflicts: string[] }[];
  /** This machine's claimant id. */
  claimant: string;
}

const STEP_LEVEL: Record<Role, number> = { triage: 1, implement: 2, review: 3 };

const closed = (item: WorkItem): boolean => item.state === "done" || item.state === "abandoned";

export function personHolds(item: WorkItem, claimant: string): boolean {
  const holder = item.holder;
  return !!holder && holder.actor.bot !== true && holder.actor.id !== claimant;
}

export function waitsFor(input: WaitInput): W {
  const { item, job } = input;
  const at = where(job);
  if (closed(item) || at?.merged) return { kind: "nothing" };
  // Decision 3: a person's hold; a running session; parked for a person; blocker; text; same files; switch or level; usage; timer;
  // claim; slot.
  if (personHolds(item, input.claimant)) return { kind: "person", why: "holds" };
  const role = (at?.step ?? "triage") as Role;
  if (input.live.length > 0) return { kind: "session", role: input.live[input.live.length - 1]! };
  // A session that ended and that the tick has not read yet is still the step's session.
  if (input.settling) return { kind: "session", role: input.settlingRole ?? role, settling: true };
  const parked = at?.parked;
  if (job && at && parked) {
    if (parked.as === "queued") return { kind: "queue" };
    if (parked.as === "handed-over") return { kind: "person", why: "merge" };
    if (parked.as === "not-ready") return { kind: "person", why: "not-ready" };
    if (parked.as === "escalated") return { kind: "person", why: "escalated" };
    if (job.proposal) return { kind: "person", why: "restructuring" };
    if (job.rewrite && !job.rewrite.settled) return { kind: "person", why: "rewrite" };
    const asked = job.triage?.decisions?.length && at.step === "triage" ? job.triage.decisions.length : job.decision ? 1 : 1;
    const answered = job.answered?.length ?? 0;
    return { kind: "person", why: "answer", n: Math.max(0, asked - answered) };
  }
  // In Backlog with no work under way, nothing starts until a person moves it to To do, whatever else holds it back (decision 121): the
  // board shows it in Backlog, blocked or not (a person's Triage pick there that found a blocker, say).
  if (!job && item.backlog) return { kind: "not-started" };
  const blockers = [...item.blockedBy.map((ref) => `${ref.host}:${ref.kind}:${ref.id}`), ...input.ownBlockers].filter((key) => input.open.has(key));
  // A person's Triage pick runs on a blocked Item too (decision 104): they asked for a look at it as it is, blockers and all (#243, A4).
  const pickedTriage = role === "triage" && job?.triageAskedBy !== undefined;
  if (blockers.length > 0 && !pickedTriage) return { kind: "blocker", on: [...new Set(blockers)] };
  // A job a person put back (To do, Backlog) is dropped by the next tick: nothing of it waits.
  if (!job || !at || job.dropAskedBy) return { kind: "not-started" };
  const start = (cause: StartCause): W => ({ kind: "start", role, cause });
  // In Backlog after a person's one-off triage, the implement step waits for a person to move it to To do (decision 121); work with a
  // revision or something to resume is never held there.
  if (item.backlog && role === "implement" && !job.implementAskedBy && !job.head && !job.resumeWith && !at.resume) return start("backlog");
  const writing = at.writing;
  if (writing && writing.from === itemTextHash(item) && Date.parse(input.now) - Date.parse(writing.at) < 30 * 60_000) return start("text");
  const begun = implementBegun(job);
  if (role === "implement" && !begun) {
    const paths = job.triage?.paths ?? [];
    const mine = (job.triage?.links ?? []).filter((l) => l.type === "conflictsWith").map((l) => l.item.replace(/^#/, ""));
    const id = item.ref.id;
    if (input.busy.some((other) => other.paths.some((p) => paths.includes(p)) || mine.includes(other.key.split(":").pop()!) || other.conflicts.includes(id))) return start("same-files");
  }
  const picked = (role === "triage" && job.triageAskedBy) || (role === "review" && job.reviewAskedBy) || (role === "implement" && job.implementAskedBy);
  // A pick runs whatever the level, but from the level that shows the role's switch the switch decides (decision 104).
  if (input.switches[role] !== "started" && (!picked || input.level >= STEP_LEVEL[role])) return start("switch");
  if (STEP_LEVEL[role] > input.level && !picked) return start("level");
  if (input.usageReserve) return start("usage");
  if (input.paceHolds) return start("pace");
  if (at.notBefore && at.notBefore > input.now) return start("timer");
  const holder = item.holder;
  if (holder && holder.actor.bot === true && holder.actor.id !== input.claimant && (!holder.until || holder.until > input.now)) return start("claim");
  // New work waits while too much waits for a person; a person's pick does not (decision 133).
  if (input.workCapped && newWork(job) && !job.implementAskedBy) return start("cap");
  return start("slot");
}

/**
 * Something of the implement step has begun, as the product counts it (#268): a change, an answer, a session to resume (one a limit cut
 * off), a failed attempt, an approval to merge. Only a first implement step waits for the same files; work under way has its files in hand.
 */
export function implementBegun(job: Job): boolean {
  const at = where(job);
  return !!(job.head || job.implement || job.agentSession || at?.resume || job.resumeWith !== undefined || job.failures > 0 || at?.merge);
}

/**
 * Busy, for same-files waits (#187): its implement step has begun or runs, or its change is with review, the queue or a person,
 * and it is not on main.
 */
export function isBusy(job: Job, onMain: boolean): boolean {
  const at = where(job);
  if (at.merged || onMain) return false;
  if (at.parked) return at.parked.as === "queued" || at.parked.as === "handed-over" || !!job.head || !!job.queued || (at.parked.byStep === true && at.step === "implement");
  return at.step === "review" || (at.step === "implement" && (!!at.sessionId || !!job.head || !!job.implement || !!job.agentSession || !!job.resumeWith || !!at.resume || job.failures > 0));
}

export function wText(w: W): string {
  switch (w.kind) {
    case "session":
      return `session(${w.role})`;
    case "person":
      return `person(${w.why}${w.n !== undefined ? ` ${w.n}` : ""})`;
    case "blocker":
      return `blocker(${w.on.map((key) => key.split(":").pop()).join(",")})`;
    case "start":
      return `start(${w.role}, ${w.cause})`;
    default:
      return w.kind;
  }
}

/** The lane a person's wait is in under decision 2 (a): the stage the work is at; with no change yet, To do (or Backlog, #221). */
export function stageLane(item: WorkItem, job: Job | undefined): string {
  if (job && (stepAt(job) === "review" || job.reviewedHead)) return "in-review";
  if (job && (job.head || (stepAt(job) === "implement" && job.implement))) return "in-progress";
  return item.backlog ? "backlog" : "todo";
}

/** The implement step is new work: it has not begun (no change, no session of it, nothing to resume, no attempt yet). */
export function newWork(job: Job): boolean {
  return stepAt(job) === "implement" && !job.head && !job.implement && !job.agentSession && job.resumeWith === undefined && !where(job).resume && job.failures === 0 && !where(job).merge;
}
