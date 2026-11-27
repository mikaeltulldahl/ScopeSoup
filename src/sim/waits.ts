// W, what an Item waits for, worked out by the checker on its own from the job, the sessions and the switches (the table in
// issue #211). It shares no code with the product's views on purpose: when the two disagree, rule A1 says so.

import type { Job } from "../orchestrator/jobs.ts";
import type { WorkItem } from "../model/types.ts";
import { itemTextHash } from "../core/answerReuse.ts";

export type Role = "triage" | "implement" | "review";
export type PersonWait = "answer" | "rewrite" | "restructuring" | "not-ready" | "escalated" | "merge" | "holds";
export type StartCause = "switch" | "level" | "usage" | "timer" | "text" | "same-files" | "claim" | "slot";

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
  /** Open items by ref key, for blockers. */
  open: ReadonlyMap<string, WorkItem>;
  /** Scope Soup's own blockers of the item (ref keys). */
  ownBlockers: string[];
  switches: Record<Role, string>;
  level: number;
  usageReserve: boolean;
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
  if (closed(item) || job?.merged) return { kind: "nothing" };
  // Decision 3: a person's hold; a running session; parked for a person; blocker; text; same files; switch or level; usage; timer;
  // claim; slot.
  if (personHolds(item, input.claimant)) return { kind: "person", why: "holds" };
  const role = (job?.step ?? "triage") as Role;
  if (input.live.length > 0) return { kind: "session", role: input.live[input.live.length - 1]! };
  // A session that ended and that the tick has not read yet is still the step's session.
  if (input.settling) return { kind: "session", role, settling: true };
  if (job?.parked) {
    const parked = job.parked;
    if (parked.as === "queued") return { kind: "queue" };
    if (parked.as === "handed-over") return { kind: "person", why: "merge" };
    if (parked.as === "not-ready") return { kind: "person", why: "not-ready" };
    if (parked.as === "escalated") return { kind: "person", why: "escalated" };
    if (job.proposal) return { kind: "person", why: "restructuring" };
    if (job.rewrite && !job.rewrite.settled) return { kind: "person", why: "rewrite" };
    const asked = job.triage?.decisions?.length && job.step === "triage" ? job.triage.decisions.length : job.decision ? 1 : 1;
    const answered = job.answered?.length ?? 0;
    return { kind: "person", why: "answer", n: Math.max(0, asked - answered) };
  }
  const blockers = [...item.blockedBy.map((ref) => `${ref.host}:${ref.kind}:${ref.id}`), ...input.ownBlockers].filter((key) => input.open.has(key));
  if (blockers.length > 0) return { kind: "blocker", on: [...new Set(blockers)] };
  if (!job) return { kind: "not-started" };
  const start = (cause: StartCause): W => ({ kind: "start", role, cause });
  if (job.writing && job.writing.from === itemTextHash(item) && Date.parse(input.now) - Date.parse(job.writing.at) < 30 * 60_000) return start("text");
  const begun = !!(job.head || job.implement);
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
  if (job.notBefore && job.notBefore > input.now) return start("timer");
  const holder = item.holder;
  if (holder && holder.actor.bot === true && holder.actor.id !== input.claimant && (!holder.until || holder.until > input.now)) return start("claim");
  return start("slot");
}

/**
 * Busy, for same-files waits (#187): its implement step has begun or runs, or its change is with review, the queue or a person,
 * and it is not on main.
 */
export function isBusy(job: Job, onMain: boolean): boolean {
  if (job.merged || onMain) return false;
  if (job.parked) return job.parked.as === "queued" || job.parked.as === "handed-over" || !!job.head || !!job.queued;
  return job.step === "review" || (job.step === "implement" && (!!job.sessionId || !!job.head || !!job.implement || !!job.agentSession || !!job.resumeWith || job.failures > 0));
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

/** The lane a person's wait is in under decision 2 (a): the stage the work is at. */
export function stageLane(job: Job | undefined): string {
  if (!job) return "backlog";
  if (job.step === "review" || job.reviewedHead) return "in-review";
  if (job.head || job.step === "implement" && job.implement) return "in-progress";
  return "backlog";
}
