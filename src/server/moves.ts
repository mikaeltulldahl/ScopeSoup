// A person sets an Item's state on its page (#154): the moves that change what Scope Soup's agents do with it. Triage again,
// back to To do (the work under way dropped), the review step now, and the merge queue now. Each acts on this machine's
// job for the Item, the way the orchestrator's own steps do. The level limits only what Scope Soup does on its own: a person may
// pick In review or Merge queue at any level when what they need is there (decision 104). A move that replaces the step that runs
// marks the job (`interrupt`): the tick ends that session at once, as Stop does, and does not settle its result. When the Item's
// work runs on another machine, the server writes the pick as a request on the meta ref instead (`elsewhere`), and that machine
// decides with these same rules. The other states are the existing actions (claim, release, the state edit). Implement anyway is
// not a state but a button by triage's not-ready verdict (decision 105): the implement step now, with triage's notes as they are.
// The rules are pure (`moveWhys`), so the server and its tests read the same ones.

import type { Lane } from "../core/lanes.ts";
import { holdStands } from "../model/people.ts";
import type { WorkItem } from "../model/types.ts";
import type { Job, Jobs } from "../orchestrator/jobs.ts";
import { workBranch, workspaceKey } from "../orchestrator/paths.ts";
import { sessionOf, stepOf, waitsForAnswer as answerAwaited } from "../core/phase.ts";
import { phaseOf } from "../orchestrator/phase.ts";
import { atStep, stepAt, mergeApproved, sessionIdOf, parkedOf, release, nextStep, handOverTaken, toReview } from "../orchestrator/jobs.ts";

export const MOVES = ["triage", "todo", "in-review", "merge-queue", "implement"] as const;
export type Move = (typeof MOVES)[number];

export const isMove = (value: unknown): value is Move => typeof value === "string" && (MOVES as readonly string[]).includes(value);

export interface MoveInput {
  item: WorkItem;
  /** This machine's job for the Item. */
  job?: Job;
  lane: Lane | null;
  level: number;
  /** Whether the merge queue's switch is on. */
  mergeQueueOn: boolean;
  /** Milliseconds, for whether a claim stands. */
  at: number;
  /**
   * The role of a step session the store has as live on the Item. The runner stores a session when it starts it, before the tick
   * saves the job's `sessionId`, so this counts a session that is starting as running.
   */
  liveRole?: string;
  /** What Triage, In review and Implement anyway lack here, as a person reads it: the agents' program. */
  needs?: { triage?: string; review?: string; implement?: string };
  /** The machine whose agent holds the Item's work, when it is another and a request can reach it: that machine decides the rest. */
  elsewhere?: string;
}

/** Each move, with why it cannot be made now; absent where the move does nothing for this Item (the page uses another action). */
export type MoveWhys = Partial<Record<Move, { why?: string }>>;

/** The merge queue is Scope Soup's own, from level 4 (decision 104): no person hands a change to it below. */
const QUEUE_OFF = "the merge queue runs from level 4";

export const ROLE_WORDS: Record<string, string> = { triage: "the triage", implement: "the implementor", review: "the reviewer" };

/** The role of the step session that runs on the Item here, if one does. */
export const runningRole = (input: Pick<MoveInput, "job" | "liveRole">): string | undefined => {
  const phase = input.job ? phaseOf(input.job) : undefined;
  return (phase && sessionOf(phase) ? stepOf(phase) : undefined) ?? input.liveRole;
};

/** Why no move can touch the Item now: an agent of another machine holds it (and no request reaches it), or a person does. */
function busy(input: MoveInput): { why: string; person?: string } | undefined {
  const { item, job, at } = input;
  const holder = item.holder;
  if (holder && holdStands(holder, at)) {
    if (holder.actor.bot && !job && !input.elsewhere) return { why: `an agent on ${holder.actor.name} is on it` };
    if (!holder.actor.bot) return { why: `held by ${holder.actor.name}`, person: holder.actor.name };
  }
  return undefined;
}

/** What each move would say now. Pure. */
export function moveWhys(input: MoveInput): MoveWhys {
  const { item, job, lane, level } = input;
  const phase = job ? phaseOf(job) : undefined;
  const closed = item.state === "done" || item.state === "abandoned";
  const off = busy(input);
  const running = runningRole(input);
  const why = (text: string | undefined) => (text === undefined ? {} : { why: text });

  // Implement anyway: only over triage's own not-ready verdict (not a person's stop), on this machine's job.
  const overrule: MoveWhys = phase?.at === "not-ready" && phase.verdict && !closed
    ? { implement: why(input.needs?.implement ?? off?.why ?? (job?.dropAskedBy ? "back to To do already" : undefined)) }
    : {};

  // The work runs on another machine: that machine has the job, so it decides; here only what is known everywhere refuses.
  if (input.elsewhere && !job) {
    if (closed) return { triage: { why: "reopen it first" }, "in-review": { why: "reopen it first" }, ...(level >= 4 ? { "merge-queue": { why: "reopen it first" } } : {}) };
    return {
      triage: why(input.needs?.triage ?? off?.why),
      todo: why(off && !off.person ? off.why : undefined),
      "in-review": why(input.needs?.review ?? off?.why),
      ...(level >= 4 ? { "merge-queue": why(off?.why) } : {}),
    };
  }

  // The merge queue holds the branch (waiting, in a batch, or merged by it): the job is not taken from under it.
  const queued = phase?.at === "queued" || phase?.at === "merged" || job?.queued !== undefined || lane === "queued" || lane === "checking";
  const queuedWhy = lane === "checking" ? "the merge queue is checking it" : "it is in the merge queue";
  // A job parked for a person (a question, an escalation, a rewrite, a restructuring) waits for their answer on the page.
  const waitsForAnswer = !!phase && answerAwaited(phase);
  const result: MoveWhys = { ...overrule };

  // Triage again: the old triage is dropped and the job starts at triage, ahead of new Items. A step that runs is interrupted.
  result.triage = why(
    closed ? "reopen it first"
      : input.needs?.triage ? input.needs.triage
      : off ? off.why
      : running === "triage" ? "the triage is on it now"
      // From level 1 Scope Soup triages Items in To do itself; at level 0, or in Backlog (which nothing triages on its own, decision
      // 120), a person's pick makes the job (decision 104).
      : !job ? (level >= 1 && !item.backlog ? "in line for triage already" : undefined)
      : job.dropAskedBy ? "back to To do already"
      : phase?.at === "triage" && !running ? "next for triage already"
      : queued ? queuedWhy
      : undefined,
  );

  // Back to To do: the job is dropped (its branch stays), so the agents start it again from triage.
  if (!closed && job) result.todo = why(off && !off.person ? off.why : job.dropAskedBy ? "back to To do already" : queued ? queuedWhy : undefined);

  // The review step now: needs a revision on the Item's branch and the agent program, at any level (decision 104).
  result["in-review"] = why(
    closed ? "reopen it first"
      : off ? off.why
      : running === "review" ? "in review already"
      : !job || job.head === undefined || stepAt(job) === "triage" ? "nothing to review yet"
      : input.needs?.review ? input.needs.review
      : job.dropAskedBy ? "back to To do already"
      : queued ? queuedWhy
      : waitsForAnswer ? "it waits for an answer on this page"
      : phase?.at === "review" && !running ? "in review already"
      : undefined,
  );

  // The merge queue now: a reviewed change, at any level when the queue can run (decision 104). The tick hands it over as after an
  // approval. Approved on the revision the branch is at now: a newer one (a fix round after an approval) is not reviewed yet.
  const approved = job?.review?.verdict === "approve" && !job.review.findings.some((finding) => finding.severity === "must")
    && job.head !== undefined && job.reviewedHead === job.head && (stepAt(job) === "review" || mergeApproved(job));
  // Below level 4 the merge queue is not offered at all (decision 104): it is Scope Soup's own, not a person's.
  if (level < 4) return result;
  result["merge-queue"] = why(
    closed ? "reopen it first"
      : off ? off.why
      : queued ? "in the merge queue already"
      : job?.dropAskedBy ? "back to To do already"
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
  if (!said) return { ok: false, why: move === "merge-queue" ? QUEUE_OFF : move === "implement" ? "only triage's not-ready verdict can be overruled" : "nothing under way to drop" };
  if (said.why) return { ok: false, why: said.why };
  const id = input.item.ref.id;
  if (!jobs[key] && move === "triage" && !input.elsewhere) {
    // Level 0, or in Backlog: no job yet. The person's pick makes one at triage, which the tick runs whatever the level (decision 104).
    const ref = input.item.ref;
    jobs[key] = { item: ref, workspace: workspaceKey(ref), branch: workBranch(ref), at: atStep("triage"), failures: 0, fixRounds: 0, startedAt: at, triageAskedBy: by };
    return { ok: true, reason: `${by} set ${id} to triage: its triage runs next${input.item.backlog ? "; it stays in Backlog, and nothing more starts until a person moves it to To do" : ""}.` };
  }
  const job = jobs[key];
  if (!job) return { ok: false, why: `its work runs on ${input.elsewhere ?? "another machine"}; pick it on the Item page, which asks that machine` };
  // The step that runs is replaced: the tick ends its session at once and does not settle it (`interrupt` in the tick).
  const running = runningRole(input);
  const interrupt = running ? { interrupt: { by, at, to: move } } : {};
  const role = running ? (ROLE_WORDS[running] ?? "the agent") : "";
  const ends = running ? ` ${role.charAt(0).toUpperCase()}${role.slice(1)}'s session is ended now; its result is not taken.` : "";
  if (move === "triage") {
    // The session that runs goes on until the tick ends it. As decision 68's triage again: the one that runs is told the answer before, as data.
    const session = sessionIdOf(job);
    const recheck = job.triage ? { reasons: [`${by} asked for it on the board`], previous: job.triage, previousAt: job.triaged?.at ?? job.startedAt, commits: [], commitCount: 0, finished: [] } : undefined;
    jobs[key] = {
      item: job.item, workspace: job.workspace, branch: job.branch, failures: 0, fixRounds: 0, startedAt: at,
      ...(job.triaged ? { triaged: job.triaged } : {}), ...interrupt, triageAskedBy: by,
      at: { kind: "triage", run: session ? { is: "running", session } : { is: "waiting" }, ...(recheck ? { recheck } : {}) },
    };
    return { ok: true, reason: `${by} set ${id} to triage: its triage is taken again, next; the one before and the work since are dropped (the branch stays).${ends}` };
  }
  if (move === "implement") {
    // Triage's verdict is overruled: the implement step runs next whatever the level, with triage's notes as they are.
    release(job);
    nextStep(job, "implement");
    delete job.resumeWith;
    delete job.reviewAskedBy;
    delete job.queueAskedBy;
    job.failures = 0;
    // A fresh start of the work: no review send-backs yet, so no step-up of the implementor's model (decision 105).
    delete job.reviewSendBacks;
    job.implementAskedBy = by;
    return { ok: true, reason: `${by} overruled triage's verdict on ${id} (Implement anyway): its implement step starts next, with triage's notes as they are.` };
  }
  Object.assign(job, interrupt);
  if (move === "todo") {
    // The tick drops it: only it can give back this machine's claim on the host and the workspace (`dropAsked` in the tick).
    job.dropAskedBy = by;
    // What it was parked on is answered in its log with the move, and a hand-over it owed is not made: it waits for nothing but the drop
    // (#268: an owed hand-over left the product's wait saying hand-over while the tick drops the job).
    if (parkedOf(job)) release(job);
    handOverTaken(job);
    return { ok: true, reason: `${by} put ${id} back in To do: the work under way is dropped (the branch stays) and the agents start it again from triage.${ends}` };
  }
  // A hand-over is undone here (a reviewed change handed to a person, or one whose hand-over failed), or the step that runs is
  // replaced; no answer is pending. The session id stays until the tick has ended that session.
  job.failures = 0;
  toReview(job, move !== "in-review");
  delete job.resumeWith;
  if (move === "in-review") {
    // One ask at a time: the queue is not asked for any more (decision 104).
    delete job.queueAskedBy;
    delete job.implementAskedBy;
    // Whatever the level: the tick runs a review step a person asked for (decision 104).
    job.reviewAskedBy = by;
    return { ok: true, reason: `${by} set ${id} to review: its review step starts next.${ends}` };
  }
  job.owesAskedBy = by;
  // Whatever the level: the hand-over goes to the merge queue (decision 104).
  job.queueAskedBy = by;
  delete job.reviewAskedBy;
  delete job.implementAskedBy;
  return { ok: true, reason: `${by} queued ${id}'s reviewed change for the merge queue: it is handed over next.${ends}` };
}
