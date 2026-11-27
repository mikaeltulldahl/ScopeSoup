// Merging through the merge queue, as the cycle sees it: a reviewed change is handed to the queue
// (`queueDriver.ts`) and parked as "queued"; each tick the queue is driven, and what it decides about
// a change (merged, sent back) is applied to that change's job and item log here.

import { mergeQueueCi } from "../config/types.ts";
import type { WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { SendBackReason } from "../queue/index.ts";
import { mergeQueueOn, mergeQueueStopped } from "../store/control.ts";
import type { Context } from "./context.ts";
import { createLog, errorText } from "./context.ts";
import { park, sendBack } from "./cycle.ts";
import type { Job } from "./jobs.ts";
import { itemRepository } from "./workspaces.ts";
import type { Notice, QueueDriver, QueueSink } from "./queueDriver.ts";
import { closeMerged } from "./mergedClose.ts";
import { giveLease, takeLease } from "./mergeQueueLease.ts";
import { clearResumeRequest, recordFlakyTests, recordQueueNote, resumeRequestedBy, shortExcerpt } from "./queueHealth.ts";
import { phaseOf } from "./phase.ts";
import { markMerged, parkedOf, release } from "./jobs.ts";

/** Hands a reviewed change to the queue and lets the item be parked as "queued". */
export async function handOverToQueue(ctx: Context, job: Job): Promise<void> {
  const { queue, store, runner } = ctx.deps;
  const config = ctx.config;
  const key = refKey(job.item);
  const github = mergeQueueCi(config) === "github";
  // With CI on GitHub only the queue knows whether it was given a GitHub host to write to.
  const missing = github ? (queue?.checkMissing() ?? null) : config.checkCommand ? null : "the project names no checkCommand";
  if (missing) {
    await park(
      ctx, job, "escalated",
      `The change on ${job.branch} is ready, but ${missing}, so nothing merges through the queue. ${github ? "Give Scope Soup a GitHub host with writes on" : "Set checkCommand in the project's configuration"} and answer here to merge it, or merge it by hand.`,
      "escalation", "hand-over",
    );
    return;
  }
  if (!queue) {
    await park(ctx, job, "escalated", "The project merges through the merge queue, but this Scope Soup was started without one.", "escalation", "hand-over");
    return;
  }
  let enqueued;
  try {
    // A change parked for a person has no worktree any more (park removes it); its branch is still in the main clone.
    const repo = itemRepository(store, config, job.item) ?? (config.workspaces.kind === "pool" ? null : config.repoPath);
    enqueued = await queue.enqueue(job.item, job.branch, repo, await runner.changedPaths(job.branch));
  } catch (error) {
    enqueued = { ok: false as const, reason: errorText(error) };
  }
  if (!enqueued.ok) {
    await park(ctx, job, "escalated", `${job.branch} could not be handed to the merge queue: ${enqueued.reason} Answering here makes Scope Soup try again.`, "escalation", "hand-over");
    return;
  }
  job.queued = enqueued.sha;
  delete job.sentBack;
  await park(ctx, job, "queued", `The change on ${job.branch} (${enqueued.sha.slice(0, 7)}) is reviewed and waits in the merge queue: it is built into a batch with others, ${github ? "the project's CI on GitHub checks the chain on a pull request" : "the check command runs on the chain"}, and the checked commit is pushed to ${config.mainBranch}.`);
}

/** A full commit id: a `check` line needs one (the meta branch's fold drops a line without). */
const isFullSha = (sha: string): boolean => /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha);
/** The failing check's text in a `check` line is cut to this, as a review's findings are in the log comment. */
const FINDING_CHARS = 2000;
const clip = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars - 3)}...` : text);

/**
 * What makes two merging failures the same failure: a conflict with the same change, or the check failing in the same files
 * (in the same output when it names none).
 */
export function failureKey(reason: SendBackReason): string {
  if (reason.kind === "conflict") return `conflict ${reason.with ? refKey(reason.with) : "-"}`;
  if (reason.kind === "culprit") return reason.files.length > 0 ? `check ${[...reason.files].sort().join(" ")}` : `check ${reason.excerpt.trim().replace(/\s+/g, " ")}`;
  return "sent back";
}

function sendBackText(ctx: Context, reason: SendBackReason, command: string): { finding: string; what: string } {
  const { remote, mainBranch } = ctx.config;
  switch (reason.kind) {
    case "conflict":
      return {
        finding: `The change does not apply on ${mainBranch} (${reason.base.slice(0, 7)})${reason.ahead.length > 0 ? ` plus the changes ahead of it in its batch (${reason.ahead.map((r) => r.id).join(", ")})` : ""}${reason.with ? `; it conflicts with ${reason.with.id}` : ""}. Scope Soup did not resolve it. Rebase the branch on ${remote}/${mainBranch} (\`git fetch ${remote}\`, then \`git rebase ${remote}/${mainBranch}\`) and resolve each conflict so both sides keep what they meant; this finding allows rewriting the branch's commits.`,
        what: "The change conflicts in the merge queue",
      };
    case "culprit":
      if (mergeQueueCi(ctx.config) === "github") {
        // The excerpt names the failing check, its conclusion and the end of its log (or its link).
        return {
          finding: `The checks on GitHub failed with this change in the batch: the changes ahead of it passed together, and the chain up to and including it (${reason.chainSha.slice(0, 7)}) failed. ${reason.excerpt || "(GitHub said nothing more)"}`,
          what: "The checks on GitHub failed with this change in a batch",
        };
      }
      return {
        finding: `The check command \`${command}\` failed with this change in the batch: the changes ahead of it passed together, and the chain up to and including it (${reason.chainSha.slice(0, 7)}) failed${reason.files.length > 0 ? `, in ${reason.files.join(", ")}` : ""}. The end of its output:\n${reason.excerpt || "(no output)"}`,
        what: "The check failed with this change in a batch",
      };
    default:
      // A reason an older Scope Soup stored (the pinned approval's "changed-after-approval", removed).
      return { finding: "The merge queue sent the change back. Merge the newest main in, check the change and commit.", what: "The merge queue sent the change back" };
  }
}

/** Applies what the queue decided about one change; false when the notice was not for a waiting item. */
async function apply(ctx: Context, notice: Notice): Promise<void> {
  const { actions } = ctx.deps;
  const config = ctx.config;
  const main = config.mainBranch;
  const command = mergeQueueCi(config) === "github" ? "every check on GitHub" : (config.checkCommand ?? []).join(" ");
  switch (notice.kind) {
    case "mark-merged":
      for (const member of notice.members) {
        const key = refKey(member.change);
        const job = ctx.jobs[key];
        if (!job) continue;
        // Applied only to the job that waits in the queue with this revision: one that moved on is not marked from an old notice. A
        // notice delivered again (a restart before the outbox let it go) finds the job merged as it says, and is carried out again
        // without merging it twice; one that names another commit for a merged job is stale.
        const merged = job.at.kind === "merged" ? job.at.sha : undefined;
        if (parkedOf(job)?.as !== "queued" || (merged !== undefined && merged !== member.sha) || (job.queued !== undefined && member.head !== undefined && job.queued !== member.head)) {
          ctx.commit("orchestrator.queue_notice_stale", `The merge queue says ${job.branch} merged as ${member.sha.slice(0, 7)} (batch ${notice.batch}), but ${key.split(":").pop()} no longer waits in the queue with that revision: the notice is not applied to it.`, key, { sha: member.sha, batch: notice.batch });
          continue;
        }
        if (merged === undefined) markMerged(job, member.sha);
        ctx.commit("orchestrator.merged", `${job.branch} merged through the queue (batch ${notice.batch}): ${member.sha.slice(0, 7)} is on ${main} of ${config.remote}${notice.outside ? " (the main branch was moved to it by someone else; the queue did not test it)" : `; ${command} passed on ${(notice.tested ?? member.sha).slice(0, 7)}, the tip of the tested chain`}.`, key, { sha: member.sha, batch: notice.batch });
        await ctx.act("write the revision to the item's log", key, () => actions.appendLog(job.item, "revision", { sha: member.sha, branch: job.branch }));
        // The check that let it merge (not when someone else moved the main branch: the queue tested nothing then).
        if (!notice.outside && isFullSha(member.sha)) {
          await ctx.act("write the check to the item's log", key, () => actions.appendLog(job.item, "check", { sha: member.sha, verdict: "pass", command, batch: notice.batch }));
        }
        await ctx.act("write the merge to the item's log", key, () => actions.appendLog(job.item, "merged", { sha: member.sha, target: main, batch: notice.batch }));
        await park(ctx, job, "queued", `Merged on ${main} as ${member.sha.slice(0, 7)} in batch ${notice.batch}.`);
        await closeMerged(ctx, job, member.sha, notice.batch);
      }
      return;
    case "send-back": {
      const key = refKey(notice.change);
      const job = ctx.jobs[key];
      if (!job || phaseOf(job).at !== "queued") return;
      const { finding, what } = sendBackText(ctx, notice.reason, command);
      // A red batch is a failed check on this change's commit; a conflict is not a check and has no line.
      if (notice.reason.kind === "culprit" && isFullSha(notice.sha)) {
        const failing = clip(notice.reason.excerpt.trim() || (notice.reason.files.length > 0 ? `Failed in ${notice.reason.files.join(", ")}.` : "No output."), FINDING_CHARS);
        await ctx.act("write the check to the item's log", key, () => actions.appendLog(job.item, "check", { sha: notice.sha, verdict: "fail", command, findings: [failing], ...(notice.batch !== undefined ? { batch: notice.batch } : {}) }));
      }
      release(job);
      // The revision the queue found red or conflicting: it is not handed over again until the implementor made a new one.
      job.sentBack = job.queued ?? notice.sha;
      delete job.queued;
      await sendBack(ctx, job, finding, what, failureKey(notice.reason));
      return;
    }
    case "file-flake": {
      const why = shortExcerpt(notice.excerpt);
      recordFlakyTests(ctx.deps.store, ctx.at, notice.files);
      recordQueueNote(ctx.deps.store, ctx.at, "flake", `Batch ${notice.batch}: ${notice.files.join(", ")} failed and passed on a rerun of ${notice.sha.slice(0, 7)}. The batch was merged. A flaky test is the project's to fix.${why ? ` The failure ended: ${why}` : ""}`);
      ctx.commit("orchestrator.queue_flake", `Batch ${notice.batch}: ${notice.files.join(", ")} failed and then passed on a rerun of the same commit ${notice.sha.slice(0, 7)}. The batch was merged. A flaky test is the project's to fix.`, undefined, { files: notice.files, ...(why ? { excerpt: why } : {}) });
      return;
    }
    case "suspect-order-dependence": {
      const why = shortExcerpt(notice.excerpt);
      recordFlakyTests(ctx.deps.store, ctx.at, notice.files);
      const text = `${notice.files.join(", ")} failed in the suite and passed alone in batches ${notice.batches.join(" and ")}: this looks like test order or shared state, not a flake.`;
      recordQueueNote(ctx.deps.store, ctx.at, "problem", `${text}${why ? ` The failure ended: ${why}` : ""}`);
      ctx.commit("orchestrator.queue_problem", text, undefined, { files: notice.files, ...(why ? { excerpt: why } : {}) });
      return;
    }
    case "report-outside-write":
      recordQueueNote(ctx.deps.store, ctx.at, "problem", `The main branch moved to ${notice.sha.slice(0, 7)} without the queue.`);
      ctx.commit("orchestrator.queue_problem", `The main branch moved to ${notice.sha.slice(0, 7)} without the queue.`, undefined, { sha: notice.sha });
      return;
    case "report-problem":
      recordQueueNote(ctx.deps.store, ctx.at, "problem", notice.message);
      ctx.commit("orchestrator.queue_problem", notice.message);
      return;
    case "parked":
      // CI on GitHub did not finish in time, or never ran: the change parked for a person; an answer hands it over again.
      for (const change of notice.changes) {
        const job = ctx.jobs[refKey(change)];
        if (!job || phaseOf(job).at !== "queued") continue;
        delete job.queued;
        await park(ctx, job, "escalated", notice.message, "escalation", "hand-over");
      }
      return;
  }
}

/**
 * One tick of the queue: changes that are no longer waiting leave it, a queue the engine paused goes on when a person
 * resumed it on the Queue page, then the queue is driven until it waits for nothing. While merging is paused (Pause
 * merging, Stop, start-up) nothing is driven. Resuming the merge queue switch does not resume a queue the engine paused itself: that is
 * the queue's own health pause, with its own Resume.
 */
export async function driveQueue(ctx: Context, items: readonly WorkItem[]): Promise<void> {
  const { queue, store } = ctx.deps;
  if (!queue) return;
  const key = (item: WorkItem): string => refKey(item.ref);
  // A drain started by an earlier tick may still be checking: this tick only serves it and moves on. The queue's state is not touched meanwhile.
  const running = runs.get(queue);
  if (running) {
    // Pause merge queue lets the drain under way finish and its notices be applied; only Stop ends it.
    await pump(ctx, running, mergeQueueStopped(store));
    if (!running.done) return;
    runs.delete(queue);
  }
  const live = new Set(items.filter((item) => item.state !== "done" && item.state !== "abandoned").map(key));
  const waiting = new Set(Object.entries(ctx.jobs).filter(([k, job]) => live.has(k) && parkedOf(job)?.as === "queued" && job.queued !== undefined).map(([k]) => k));
  queue.reconcile(waiting);

  if (!mergeQueueOn(store)) return;
  const why = queue.pausedWhy();
  const asker = resumeRequestedBy(store);
  if (why !== null && asker !== null) {
    queue.resume(asker);
    ctx.commit("orchestrator.queue_resumed", `${asker} resumed the paused queue from the board. It had stopped because: ${why}`);
  }
  clearResumeRequest(store);

  // The queue pushes to the main branch: it runs only while this machine holds the merge queue lease, and only when it has something to do.
  const busy = ctx.deps.mergeQueue !== undefined && (waiting.size > 0 || queue.state().entries.length > 0 || queue.state().batches.some((batch) => batch.status !== "done"));
  let leased = false;
  if (busy) {
    leased = await takeLease(ctx, "queue", "The merge queue");
    if (!leased) return;
  }
  // The drain runs beside the tick. It holds the lease until it has ended; what it decides is applied by the ticks, with their jobs.
  const run = launch(ctx, queue, leased);
  await settleFor(ctx, run, ctx.deps.queueWaitMs ?? QUEUE_WAIT_MS);
  const still = queue.pausedWhy();
  if (still !== null && run.done) ctx.say("orchestrator.queue_paused", `The merge queue is paused: ${still} Resume it on the Queue page of the board to let it go on (the lane's Resume does not).`);
}

/**
 * Below level 4 the queue is not driven, and a change waiting in it leaves (the implementor merges at that level). What level 4
 * began is finished first: a drain under way in this process is served until it ends (it may still push the batch it was checking),
 * and what the queue decided already and has not delivered is applied; nothing new is built, checked or pushed. Returns true once
 * nothing is in flight and every change has left the queue, so the jobs parked in it may go on as the level says.
 */
export async function settleQueueBelowLevel4(ctx: Context): Promise<boolean> {
  const { queue, store } = ctx.deps;
  if (!queue) return true;
  const running = runs.get(queue);
  if (running) {
    await pump(ctx, running, mergeQueueStopped(store));
    if (!running.done) return false;
    runs.delete(queue);
  }
  try {
    await queue.deliverDecided({
      note: (kind, reason, data) => ctx.commit(kind, reason, undefined, data),
      deliver: (notice) => apply(ctx, notice),
    });
  } catch (error) {
    ctx.say("orchestrator.queue_problem", `What the merge queue decided could not be applied: ${errorText(error)}`);
    return false;
  }
  queue.reconcile(new Set());
  return true;
}

/**
 * How long the tick that starts the queue waits for it. 2 s is fine: it lets quick steps (taking in, building a chain)
 * and a short check finish within the tick, and a long check no longer blocks dispatch, because the tick goes on
 * after this wait while the drain keeps running beside it.
 */
const QUEUE_WAIT_MS = 2000;

/** Thrown into the drain to end it when Stop is pressed while it waits for a tick; the notice stays in the outbox. */
class Stopped extends Error {}

interface Delivery {
  notice: Notice;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** One drain of the queue that runs beside the ticks. At most one per queue. */
interface Run {
  done: boolean;
  promise: Promise<void>;
  deliveries: Delivery[];
  wake: (() => void) | null;
}

const runs = new WeakMap<QueueDriver, Run>();

function launch(ctx: Context, queue: QueueDriver, leased: boolean): Run {
  const run: Run = { done: false, promise: Promise.resolve(), deliveries: [], wake: null };
  const wake = (): void => {
    run.wake?.();
  };
  // Nothing here writes through the starting tick's `ctx.commit`: its jobs are out of date once the tick is over.
  // A note is written when it is made, with the time it is made: the log then shows a push before the Stop that came after it,
  // not after the tick that would have applied it. It carries no job, so it saves none.
  const write = (kind: string, reason: string, data?: Record<string, unknown>): void => {
    const at = ctx.deps.now();
    if (kind === "orchestrator.queue_problem") recordQueueNote(ctx.deps.store, at, "problem", reason);
    createLog(ctx.deps.store, at, () => null).commit(kind, reason, undefined, data);
  };
  const sink: QueueSink = {
    note: (kind, reason, data) => write(kind, reason, data),
    deliver: (notice) => new Promise<void>((resolve, reject) => {
      run.deliveries.push({ notice, resolve, reject });
      wake();
    }),
  };
  run.promise = (async () => {
    try {
      await queue.drain(sink);
    } catch (error) {
      if (!(error instanceof Stopped)) write("orchestrator.queue_problem", `The queue failed: ${errorText(error)}`);
    } finally {
      try {
        if (leased) await giveLease({ ...ctx, at: ctx.deps.now() });
      } finally {
        run.done = true;
        wake();
      }
    }
  })();
  runs.set(queue, run);
  return run;
}

/** Applies what the drain decided, in this tick (what it noted is already written). After Stop nothing is applied and the drain is ended. */
async function pump(ctx: Context, run: Run, stopped: boolean): Promise<void> {
  for (let next = run.deliveries.shift(); next; next = run.deliveries.shift()) {
    if (stopped) {
      next.reject(new Stopped());
      continue;
    }
    try {
      await apply(ctx, next.notice);
      next.resolve();
    } catch (error) {
      next.reject(error);
    }
  }
}

/** Serves the drain for up to `ms`, or until it ends. */
async function settleFor(ctx: Context, run: Run, ms: number): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    await pump(ctx, run, false);
    if (run.done) {
      runs.delete(ctx.deps.queue as QueueDriver);
      return;
    }
    const left = until - Date.now();
    if (left <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolve) => {
        run.wake = resolve;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left);
      }),
    ]);
    clearTimeout(timer);
    run.wake = null;
  }
}
