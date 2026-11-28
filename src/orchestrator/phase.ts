// The stored case of a job (`Job.at`) read as its `Phase` (src/core/phase.ts): one switch over the case, with what the phase derives
// from the job's data (whether the implement step has begun, what a parked job asks) and nothing stored twice.

import type { Ask, From, Phase, Pick, Run } from "../core/phase.ts";
import type { Ask as JobAsk, Job, JobParked, JobStep, StepRun } from "./jobs.ts";
import { STEP_PICK, stepAt } from "./jobs.ts";

export function phaseOf(job: Job): Phase {
  const at = job.at;
  switch (at.kind) {
    case "merged":
      return { at: "merged", sha: at.sha, closeOwed: at.closeOwed !== undefined };
    case "hand-over":
      return { at: "hand-over" };
    case "parked":
      return parkedPhase(at.step, at.parked, at.ask);
    case "triage":
      return { at: "triage", run: runOf(job, at.run), why: at.settled ? "settled" : at.recheck ? "again" : "first" };
    case "implement":
      return { at: "implement", run: runOf(job, at.run), why: begun(job, at.run, at.merge) ? "again" : "first" };
    case "review":
      return { at: "review", run: runOf(job, at.run) };
  }
}

function parkedPhase(step: JobStep, parked: JobParked, asks: JobAsk | undefined): Phase {
  const from: From = step === "triage" ? "triage" : parked.byStep && step === "implement" ? "implement" : step === "review" ? "review" : "change";
  if (parked.retry === "hand-over") return { at: "stuck", from: "hand-over" };
  // What could not be posted is asked all the same: a not-ready or escalated reason as one question.
  if (parked.retry === "post") {
    const asked = parked.postingAs === undefined || parked.postingAs === "needs-decision";
    return { at: "asked", from, ask: asked ? askPhase(asks) : { is: "question" }, posting: true };
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
      return { at: "asked", from, ask: askPhase(asks), posting: false };
  }
}

/**
 * The job only waits for a person's answers to what it posted: asked (posted), not ready, or stuck (escalated, or its hand-over failed).
 * Such a wait belongs to no machine (#271): every machine reads its questions in the Item's log, so it holds no claim.
 */
export function waitsForAnswer(job: Job): boolean {
  const phase = phaseOf(job);
  return (phase.at === "asked" && !phase.posting) || phase.at === "not-ready" || phase.at === "stuck";
}

/** The person's pick the job carries out, if any: a drop, the pick of the step it is at, or the queue. */
export function pickOf(job: Job): Pick | undefined {
  const picked = job.pick;
  if (!picked) return undefined;
  const step = stepAt(job);
  if (picked.to === "todo") return { by: picked.by, to: "drop" };
  if (picked.to === STEP_PICK[step]) return { by: picked.by, to: step };
  if (picked.to === "merge-queue") return { by: picked.by, to: "queue" };
  return undefined;
}

/** Something of the implement step has begun: a change, an answer, a session to resume, a failed attempt, an approval to merge. */
function begun(job: Job, run: StepRun, merge: true | undefined): boolean {
  return job.head !== undefined || job.implement !== undefined || job.agentSession !== undefined || (run.is === "waiting" && run.resume !== undefined) || job.resumeWith !== undefined || job.failures > 0 || merge === true;
}

function runOf(job: Job, run: StepRun): Run {
  if (run.is === "running") return { is: "running", session: run.session };
  return {
    is: "waiting",
    ...(run.writing ? { text: { from: run.writing.from, at: run.writing.at } } : {}),
    ...(run.notBefore ? { timer: { time: run.notBefore, failures: job.failures, limit: run.resume !== undefined } } : {}),
  };
}

function askPhase(asks: JobAsk | undefined): Ask {
  switch (asks?.is) {
    case undefined:
    case "question":
      return { is: "question" };
    case "questions":
      return { is: "questions", n: asks.list.length, answered: (asks.answered ?? []).length };
    case "rewrite":
      return { is: "rewrite" };
    case "restructuring":
      return { is: "restructuring" };
  }
}
