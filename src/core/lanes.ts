// Lanes are derived, never dragged: from the item, its changes, live sessions and batches.

import type { Batch, BatchMember, Change, Ref, Session, Verdict, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Index, JobStage } from "./snapshot.ts";
import { parkedForPerson as isParkedForPerson } from "./phase.ts";

// Backlog: what a person has not chosen yet, which no agent starts; To do: what agents may start (decision 121).
export const LANES = ["backlog", "todo", "blocked", "in-progress", "in-review", "queued", "checking", "done"] as const;
export type Lane = (typeof LANES)[number];

export const LANE_TITLES: Record<Lane, string> = {
  backlog: "Backlog",
  todo: "To do",
  blocked: "Blocked",
  "in-progress": "In progress",
  "in-review": "In review",
  queued: "Queued",
  checking: "Checking",
  done: "Done",
};

/** Everything about one item that the lane and the turn are decided from. */
export interface Situation {
  item: WorkItem;
  /** Null for abandoned items: they are not on the board. */
  lane: Lane | null;
  /** The change that matters now: the newest open one, else the newest merged one. */
  change?: Change;
  /** The batch the change is in, or the failed batch it was named the culprit of. */
  batch?: Batch;
  member?: BatchMember;
  /** A session that is live, or cut off by a usage limit and due to resume. */
  session?: Session;
  approved: boolean;
}

const LIVE = new Set(["starting", "running", "stalled"]);
// "fix" is a stored session of the role removed.
const WORKING_ROLES = new Set(["implement", "fix"]);

function isOpen(item: WorkItem): boolean {
  return item.state !== "done" && item.state !== "abandoned";
}

/** Blockers that still hold the item back. A blocker the snapshot does not know is not counted. */
export function openBlockers(item: WorkItem, index: Index): WorkItem[] {
  const blockers: WorkItem[] = [];
  for (const ref of item.blockedBy) {
    const blocker = index.work.get(refKey(ref));
    if (blocker && isOpen(blocker)) blockers.push(blocker);
  }
  return blockers;
}

export function isLive(session: Session): boolean {
  return LIVE.has(session.status);
}

/** Verdicts that count for the current revision: not stale, and given on it or on no revision in particular. */
export function currentVerdicts(change: Change): Verdict[] {
  const current = change.revisions[change.revisions.length - 1]?.id;
  return change.verdicts.filter((verdict) => !verdict.stale && (verdict.revision === undefined || verdict.revision === current));
}

/** Approved for the queue: a passing review on the current revision, and nothing failing. */
export function isApproved(change: Change, index: Index): boolean {
  if (change.state !== "open" || change.draft) return false;
  const verdicts = currentVerdicts(change);
  if (verdicts.some((verdict) => verdict.value === "fail")) return false;
  const passes = verdicts.filter((verdict) => verdict.dimension === "review" && verdict.value === "pass");
  return passes.length > 0;
}

/** Parked for a person (a question, a hand-over, an escalation, not ready): not waiting in the merge queue, whatever its verdicts. */
export function parkedForPerson(work: Ref, index: Index): boolean {
  const phase = index.jobByWork.get(refKey(work))?.phase;
  return !!phase && isParkedForPerson(phase);
}

function currentChange(item: WorkItem, index: Index): Change | undefined {
  const changes = [...(index.changesByWork.get(refKey(item.ref)) ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return changes.find((change) => change.state === "open") ?? changes.find((change) => change.state === "merged");
}

function sessionFor(item: WorkItem, change: Change | undefined, index: Index): Session | undefined {
  const sessions = [...(index.sessionsBySubject.get(refKey(item.ref)) ?? [])];
  if (change) sessions.push(...(index.sessionsBySubject.get(refKey(change.ref)) ?? []));
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const live = sessions.find(isLive);
  if (live) return live;
  // Cut off by a usage limit: it resumes after the reset, unless something newer replaced it.
  return sessions[0]?.status === "limit" ? sessions[0] : undefined;
}

function batchFor(change: Change, index: Index): { batch: Batch; member: BatchMember } | undefined {
  const key = refKey(change.ref);
  const sha = change.revisions[change.revisions.length - 1]?.sha;
  const batches = [...(index.batchesByChange.get(key) ?? [])].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  const pick = (test: (batch: Batch, member: BatchMember) => boolean) => {
    for (const batch of batches) {
      const member = batch.members.find((candidate) => refKey(candidate.change) === key);
      if (member && test(batch, member)) return { batch, member };
    }
    return undefined;
  };
  return (
    pick((batch) => batch.status === "testing" || batch.status === "bisecting" || batch.status === "forming") ??
    // A culprit stays marked until the change gets a new revision.
    pick((batch, member) => batch.status === "failed" && member.state === "culprit" && member.sha === sha)
  );
}

/** The lane of a session's role: a triage in To do (or Backlog, when a person asked for one there), an implementor In progress, a reviewer In review. */
function roleLane(role: string, item: WorkItem): Lane {
  if (WORKING_ROLES.has(role)) return "in-progress";
  if (role === "review") return "in-review";
  return item.backlog ? "backlog" : "todo";
}

/**
 * With a job (Scope Soup's store), the lane follows what the Item waits for, in the order of decision 3: a session that runs is in its role's
 * lane; a wait for a person is in the lane of the stage its work is at (decision 2), never Queued or Checking; a blocker is Blocked; anything
 * else waits at its stage (a change from before, with the job back at its start, is not looked at). Null in the merge queue's hands.
 */
function jobLane(job: JobStage, situation: Situation, index: Index): Lane | null {
  const { item, session } = situation;
  const atStage = (): Lane | null => {
    if (job.stage === "implement") return "in-progress";
    if (job.stage === "review") return "in-review";
    if (job.stage === "queue") return null;
    return item.backlog ? "backlog" : "todo";
  };
  const held = item.holder !== undefined && !item.holder.actor.bot;
  if (held) return atStage();
  if (session && isLive(session)) return roleLane(session.role, item);
  if (job.phase.at === "with-person") return "in-review";
  if (parkedForPerson(item.ref, index)) return atStage() ?? "in-review";
  if (job.stage === "start" && item.backlog) return "backlog";
  if (!item.needsDecision && openBlockers(item, index).length > 0) return "blocked";
  return atStage();
}

export function situate(item: WorkItem, index: Index): Situation {
  const change = currentChange(item, index);
  const session = sessionFor(item, change, index);
  const base: Situation = { item, lane: null, change, session, approved: false };
  if (item.state === "abandoned") return base;
  // A merged change is Done even while the host still shows the issue open (the close failed or writes are off).
  if (item.state === "done" || index.mergedWork.has(refKey(item.ref))) return { ...base, lane: "done" };
  const job = index.jobByWork.get(refKey(item.ref));
  if (job && change?.state !== "merged") {
    const found = change && change.state === "open" ? batchFor(change, index) : undefined;
    const situation: Situation = { ...base, batch: found?.batch, member: found?.member, approved: change ? isApproved(change, index) : false };
    const lane = jobLane(job, situation, index);
    if (lane) return { ...situation, lane };
    // In the merge queue's hands: waiting for a batch, or in one being checked.
    if (job.stage === "queue") {
      const testing = found && found.batch.status !== "failed" && found.batch.status !== "forming" && found.member.state !== "requeued" && found.member.state !== "culprit";
      return { ...situation, lane: testing ? "checking" : "queued" };
    }
  }
  const working = session !== undefined && WORKING_ROLES.has(session.role);
  // Reviewed and handed to a person to merge: it waits in review, whether or not a pull request exists.
  const handedOver = job?.phase.at === "with-person";
  if (!change && handedOver && !working) return { ...base, lane: "in-review" };
  if (!change) {
    if (working || item.state === "doing") return { ...base, lane: "in-progress" };
    // Backlog until a person moves it to To do, whatever else holds it back.
    if (item.state === "todo" && item.backlog) return { ...base, lane: "backlog" };
    // An item that itself waits for an answer stays in Your turn, in the To do lane as before.
    if (item.state === "todo" && !item.needsDecision && openBlockers(item, index).length > 0) return { ...base, lane: "blocked" };
    return { ...base, lane: "todo" };
  }
  if (change.state === "merged") return { ...base, lane: "done" };

  const found = batchFor(change, index);
  const situation: Situation = { ...base, batch: found?.batch, member: found?.member, approved: isApproved(change, index) };
  if (found && found.batch.status !== "failed") {
    const testing = found.batch.status !== "forming" && found.member.state !== "requeued" && found.member.state !== "culprit";
    return { ...situation, lane: testing ? "checking" : found.member.state === "culprit" ? "in-progress" : "queued" };
  }
  if (working || found || change.draft) return { ...situation, lane: "in-progress" };
  if (session?.role === "review" && isLive(session)) return { ...situation, lane: "in-review" };
  // A change from before and no job (its work was dropped, or a store lost): an open blocker holds it in Blocked, as it holds an Item
  // with no change (decision 3: a blocker comes before the stage).
  if (!job && index.snapshot.level !== undefined && item.state === "todo" && !item.needsDecision && !parkedForPerson(item.ref, index) && openBlockers(item, index).length > 0) return { ...situation, lane: "blocked" };
  // Parked for a person (a question from a fix round after review, say): it waits in review for them, not in the queue. Where Scope Soup
  // runs, an Item with no job is not in its merge queue (its work was dropped, or not taken up yet), whatever the change's verdicts.
  const queueHasIt = situation.approved && !parkedForPerson(item.ref, index) && !(index.snapshot.level !== undefined && !job);
  return { ...situation, lane: queueHasIt ? "queued" : "in-review" };
}

export function laneOf(item: WorkItem, index: Index): Lane | null {
  return situate(item, index).lane;
}

/** True when the host's own state says something the lane does not: open on the host in the Done lane, or closed outside it. */
export function hostDiffers(lane: Lane | null, hostState: string): boolean {
  const closed = hostState.startsWith("closed") || hostState === "done" || hostState === "abandoned";
  const open = hostState === "open" || ["todo", "doing", "waiting"].includes(hostState);
  if (!closed && !open) return true;
  return closed !== (lane === "done" || lane === null);
}
