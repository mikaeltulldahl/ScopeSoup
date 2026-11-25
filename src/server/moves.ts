// A person sets an Item's state on its page (#154): the moves that change what Scope Soup's agents do with it. Triage again,
// back to the backlog (the work under way dropped), the review step now, and the merge queue now. Each acts on this machine's
// job for the Item, the way the orchestrator's own steps do, and never on a session that runs: Scope Soup stops nothing that
// runs, so a move waits for the session to end. The other states are the existing actions (claim, release, the state edit).
// The rules are pure (`moveWhys`), so the server and its tests read the same ones.
// One gap is left: a session the tick is preparing (its workspace, before the runner stores it as starting) is not seen yet, and
// the tick's save keeps a person's change over its own (`saveJobs`), so that session's result would not be taken. Back to the
// backlog avoids it: the tick itself drops the job, after its session (`dropAskedBy`).

import type { Lane } from "../core/lanes.ts";
import { holdStands } from "../model/people.ts";
import type { WorkItem } from "../model/types.ts";
import type { Job, Jobs } from "../orchestrator/jobs.ts";

export const MOVES = ["triage", "backlog", "in-review", "merge-queue"] as const;
export type Move = (typeof MOVES)[number];

export const isMove = (value: unknown): value is Move => typeof value === "string" && (MOVES as readonly string[]).includes(value);

export interface MoveInput {
  item: WorkItem;
  /** This machine's job for the Item. */
  job?: Job;
  lane: Lane | null;
  level: number;
  mergeQueueOn: boolean;
  /** Milliseconds, for whether a claim stands. */
  at: number;
  /**
   * The role of a step session the store has as live on the Item. The runner stores a session when it starts it, before the tick
   * saves the job's `sessionId`, so this closes most of the gap in which a move could change a job whose session is starting.
   */
  liveRole?: string;
}

/** Each move, with why it cannot be made now; absent where the move does nothing for this Item (the page uses another action). */
export type MoveWhys = Partial<Record<Move, { why?: string }>>;

const ROLE_WORDS: Record<string, string> = { triage: "the triage", implement: "the implementor", review: "the reviewer" };

/** Why no move can touch the Item now: a session runs on it here, an agent of another machine holds it, or a person does. */
function busy(input: MoveInput): { why: string; person?: string } | undefined {
  const { item, job, at } = input;
  if (job?.sessionId) return { why: `${ROLE_WORDS[job.step] ?? "an agent"} is on it now; wait for it to finish` };
  if (input.liveRole) return { why: `${ROLE_WORDS[input.liveRole] ?? "an agent"} is on it now; wait for it to finish` };
  const holder = item.holder;
  if (holder && holdStands(holder, at)) {
    if (holder.actor.bot && !job) return { why: `an agent on ${holder.actor.name} is on it` };
    if (!holder.actor.bot) return { why: `held by ${holder.actor.name}`, person: holder.actor.name };
  }
  return undefined;
}

/** What each move would say now. Pure. */
export function moveWhys(input: MoveInput): MoveWhys {
  const { item, job, lane, level } = input;
  const closed = item.state === "done" || item.state === "abandoned";
  const off = busy(input);
  // The merge queue holds the branch (waiting, in a batch, or merged by it): the job is not taken from under it.
  const queued = !!job && (job.parked?.as === "queued" || job.queued !== undefined || job.merged !== undefined) || lane === "queued" || lane === "checking";
  const queuedWhy = lane === "checking" ? "the merge queue is checking it" : "it is in the merge queue";
  // A job parked for a person (a question, an escalation, a rewrite, a restructuring) waits for their answer on the page.
  const waitsForAnswer = !!job?.parked && job.parked.as !== "queued" && job.parked.as !== "handed-over" && job.parked.retry !== "hand-over";
  const why = (text: string | undefined) => (text === undefined ? {} : { why: text });
  const result: MoveWhys = {};

  // Triage again: the old triage is dropped and the job starts at triage, ahead of new Items.
  result.triage = why(
    closed ? "reopen it first"
      : level < 1 ? "triage is off at level 0"
      : off ? off.why
      : !job ? "in line for triage already"
      : job.dropAskedBy ? "back to the backlog already"
      : job.step === "triage" && !job.parked ? "next for triage already"
      : queued ? queuedWhy
      : undefined,
  );

  // Back to the backlog: the job is dropped (its branch stays), so the agents start it again from triage.
  if (!closed && job) result.backlog = why(off && !off.person ? off.why : job.dropAskedBy ? "back to the backlog already" : queued ? queuedWhy : undefined);

  // The review step now: needs a revision on the Item's branch and review at this level.
  result["in-review"] = why(
    closed ? "reopen it first"
      : level < 3 ? "review is off below level 3"
      : off ? off.why
      : !job || job.head === undefined || job.step === "triage" ? "nothing to review yet"
      : job.dropAskedBy ? "back to the backlog already"
      : queued ? queuedWhy
      : waitsForAnswer ? "it waits for an answer on this page"
      : job.step === "review" && !job.parked && !job.owes ? "in review already"
      : undefined,
  );

  // The merge queue now: a reviewed change, at level 4, with the queue running. The tick hands it over as after an approval.
  // Approved on the revision the branch is at now: a newer one (a fix round after an approval) is not reviewed yet.
  const approved = job?.review?.verdict === "approve" && !job.review.findings.some((finding) => finding.severity === "must")
    && job.head !== undefined && job.reviewedHead === job.head && (job.step === "review" || job.merge === true);
  result["merge-queue"] = why(
    closed ? "reopen it first"
      : level < 4 ? "the merge queue is off below level 4"
      : off ? off.why
      : queued ? "in the merge queue already"
      : job?.dropAskedBy ? "back to the backlog already"
      : waitsForAnswer ? "it waits for an answer on this page"
      : !job || !approved ? "not reviewed yet"
      : job.sentBack !== undefined && job.sentBack === job.head ? "the merge queue sent it back; it needs a fix"
      : !input.mergeQueueOn ? "the merge queue is paused"
      : undefined,
  );
  return result;
}

/**
 * Makes the move on the jobs (the caller saves them with the event, in one transaction). Returns the event's words, or why not.
 * `by` is the person.
 */
export function applyMove(jobs: Jobs, key: string, move: Move, input: MoveInput, by: string, at: string): { ok: true; reason: string } | { ok: false; why: string } {
  const said = moveWhys(input)[move];
  if (!said) return { ok: false, why: "nothing under way to drop" };
  if (said.why) return { ok: false, why: said.why };
  const job = jobs[key]!;
  const id = input.item.ref.id;
  if (move === "triage") {
    const fresh: Job = { item: job.item, workspace: job.workspace, branch: job.branch, step: "triage", failures: 0, fixRounds: 0, startedAt: at, ...(job.triaged ? { triaged: job.triaged } : {}) };
    // As decision 68's triage again: the one that runs is told the answer before, as data.
    if (job.triage) fresh.recheck = { reasons: [`${by} asked for it on the board`], previous: job.triage, previousAt: job.triaged?.at ?? job.startedAt, commits: [], commitCount: 0, finished: [] };
    jobs[key] = fresh;
    return { ok: true, reason: `${by} set ${id} to triage: its triage is taken again, next; the one before and the work since are dropped (the branch stays).` };
  }
  if (move === "backlog") {
    // The tick drops it: only it can give back this machine's claim on the host and the workspace (`dropAsked` in the tick).
    job.dropAskedBy = by;
    return { ok: true, reason: `${by} put ${id} back in the backlog: the work under way is dropped (the branch stays) and the agents start it again from triage.` };
  }
  // Only a hand-over is undone here (a reviewed change handed to a person, or one whose hand-over failed): no answer is pending.
  job.failures = 0;
  delete job.parked;
  delete job.sessionId;
  delete job.resume;
  delete job.notBefore;
  if (move === "in-review") {
    job.step = "review";
    delete job.merge;
    delete job.owes;
    return { ok: true, reason: `${by} set ${id} to review: its review step starts next.` };
  }
  job.step = "review";
  delete job.merge;
  job.owes = "hand-over";
  job.owesAskedBy = by;
  return { ok: true, reason: `${by} queued ${id}'s reviewed change for the merge queue: it is handed over next.` };
}
