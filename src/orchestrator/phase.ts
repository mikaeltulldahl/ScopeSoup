// The stored case of a job (`Job.at`) read as its `Phase` (src/core/phase.ts): one switch over the case, with what the phase derives
// from the job's data (whether the implement step has begun, what a parked job asks) and nothing stored twice.

import type { Ask, From, Phase, Pick, Run } from "../core/phase.ts";
import type { Job, JobParked, JobStep, StepRun } from "./jobs.ts";
import { stepAt } from "./jobs.ts";

export function phaseOf(job: Job): Phase {
  const at = job.at;
  switch (at.kind) {
    case "merged":
      return { at: "merged", sha: at.sha, closeOwed: at.closeOwed !== undefined };
    case "hand-over":
      return { at: "hand-over" };
    case "parked":
      return parkedPhase(job, at.step, at.parked);
    case "triage":
      return { at: "triage", run: runOf(job, at.run), why: job.rewrite?.settled ? "settled" : at.recheck ? "again" : "first" };
    case "implement":
      return { at: "implement", run: runOf(job, at.run), why: begun(job, at.run, at.merge) ? "again" : "first" };
    case "review":
      return { at: "review", run: runOf(job, at.run) };
  }
}

function parkedPhase(job: Job, step: JobStep, parked: JobParked): Phase {
  const from: From = step === "triage" ? "triage" : parked.byStep && step === "implement" ? "implement" : step === "review" ? "review" : "change";
  if (parked.retry === "hand-over") return { at: "stuck", from: "hand-over" };
  // What could not be posted is asked all the same: a not-ready or escalated reason as one question.
  if (parked.retry === "post") {
    const asked = parked.postingAs === undefined || parked.postingAs === "needs-decision";
    return { at: "asked", from, ask: asked ? askOf(job, step) : { is: "question" }, posting: true };
  }
  switch (parked.as) {
    case "queued":
      return { at: "queued" };
    case "handed-over":
      return { at: "with-person" };
    case "not-ready":
      return { at: "not-ready", verdict: parked.verdict === true };
    case "escalated":
      return { at: "stuck", from };
    case "needs-decision":
      return { at: "asked", from, ask: askOf(job, step), posting: false };
  }
}

/** The person's pick the job carries out, if any: a drop first, then the pick of the step it is at, then the queue. */
export function pickOf(job: Job): Pick | undefined {
  if (job.dropAskedBy !== undefined) return { by: job.dropAskedBy, to: "drop" };
  const step = stepAt(job);
  const own = step === "triage" ? job.triageAskedBy : step === "implement" ? job.implementAskedBy : job.reviewAskedBy;
  if (own !== undefined) return { by: own, to: step };
  if (job.queueAskedBy !== undefined) return { by: job.queueAskedBy, to: "queue" };
  return undefined;
}

/** Something of the implement step has begun: a change, an answer, a session to resume, a failed attempt, an approval to merge. */
function begun(job: Job, run: StepRun, merge: true | undefined): boolean {
  return job.head !== undefined || job.implement !== undefined || job.agentSession !== undefined || run.resume !== undefined || job.resumeWith !== undefined || job.failures > 0 || merge === true;
}

function runOf(job: Job, run: StepRun): Run {
  if (run.is === "running") return { is: "running", session: run.session };
  return {
    is: "waiting",
    ...(run.writing ? { text: { from: run.writing.from, at: run.writing.at } } : {}),
    ...(run.notBefore ? { timer: { time: run.notBefore, failures: job.failures, limit: run.resume !== undefined } } : {}),
  };
}

function askOf(job: Job, step: JobStep): Ask {
  if (job.proposal) return { is: "restructuring" };
  if (job.rewrite && !job.rewrite.settled) return { is: "rewrite" };
  const n = step === "triage" && !job.decision && !job.rewrite ? (job.triage?.decisions ?? []).filter((decision) => decision.question.trim()).length : 0;
  return n > 1 ? { is: "questions", n, answered: (job.answered ?? []).length } : { is: "question" };
}
