// The one reading of the stored job's flags as a `Phase` (src/core/phase.ts). Every other place asks the phase, so a combination
// of the flags is decoded here only, in the order the tick acts on them: merged, a session, an owed hand-over, parked, the step.

import type { Ask, From, Phase, Pick, Run, Step } from "../core/phase.ts";
import type { Job } from "./jobs.ts";
import { where } from "./jobs.ts";

export function phaseOf(job: Job): Phase {
  const at = where(job);
  if (at.merged !== undefined) return { at: "merged", sha: at.merged, closeOwed: at.closeOwed !== undefined };
  if (at.sessionId !== undefined) return stepPhase(job, { is: "running", session: at.sessionId });
  if (where(job).owes) return { at: "hand-over" };
  const parked = where(job).parked;
  if (parked) {
    if (parked.retry === "hand-over") return { at: "stuck", from: "hand-over" };
    // What could not be posted is asked all the same: a not-ready or escalated reason as one question.
    if (parked.retry === "post") {
      const asked = parked.postingAs === undefined || parked.postingAs === "needs-decision";
      return { at: "asked", from: fromOf(job), ask: asked ? askOf(job) : { is: "question" }, posting: true };
    }
    switch (parked.as) {
      case "queued":
        return { at: "queued" };
      case "handed-over":
        return { at: "with-person" };
      case "not-ready":
        return { at: "not-ready", verdict: parked.verdict === true };
      case "escalated":
        return { at: "stuck", from: fromOf(job) };
      case "needs-decision":
        return { at: "asked", from: fromOf(job), ask: askOf(job), posting: false };
    }
  }
  return stepPhase(job, waiting(job));
}

/** The person's pick the job carries out, if any: a drop first, then the pick of the step it is at, then the queue. */
export function pickOf(job: Job): Pick | undefined {
  if (job.dropAskedBy !== undefined) return { by: job.dropAskedBy, to: "drop" };
  const own = where(job).step === "triage" ? job.triageAskedBy : where(job).step === "implement" ? job.implementAskedBy : job.reviewAskedBy;
  if (own !== undefined) return { by: own, to: where(job).step };
  if (job.queueAskedBy !== undefined) return { by: job.queueAskedBy, to: "queue" };
  return undefined;
}

function stepPhase(job: Job, run: Run): Phase {
  switch (where(job).step) {
    case "triage":
      return { at: "triage", run, why: job.rewrite?.settled ? "settled" : where(job).recheck ? "again" : "first" };
    case "implement":
      return { at: "implement", run, why: begun(job) ? "again" : "first" };
    case "review":
      return { at: "review", run };
  }
}

/** Something of the implement step has begun: a change, an answer, a session to resume, a failed attempt, an approval to merge. */
function begun(job: Job): boolean {
  return job.head !== undefined || job.implement !== undefined || job.agentSession !== undefined || where(job).resume !== undefined || job.resumeWith !== undefined || job.failures > 0 || where(job).merge === true;
}

function waiting(job: Job): Run {
  const { writing, notBefore, resume } = where(job);
  return {
    is: "waiting",
    ...(writing ? { text: { from: writing.from, at: writing.at } } : {}),
    ...(notBefore ? { timer: { time: notBefore, failures: job.failures, limit: resume !== undefined } } : {}),
  };
}

function fromOf(job: Job): From {
  const step: Step = where(job).step;
  if (step === "triage") return "triage";
  if (where(job).parked?.byStep && step === "implement") return "implement";
  return step === "review" ? "review" : "change";
}

function askOf(job: Job): Ask {
  if (job.proposal) return { is: "restructuring" };
  if (job.rewrite && !job.rewrite.settled) return { is: "rewrite" };
  const n = where(job).step === "triage" && !job.decision && !job.rewrite ? (job.triage?.decisions ?? []).filter((decision) => decision.question.trim()).length : 0;
  return n > 1 ? { is: "questions", n, answered: (job.answered ?? []).length } : { is: "question" };
}
