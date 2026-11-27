// Where an Item's job is, as one value (#211, section 4): each case carries only what that case needs, so a combination nobody
// meant (parked and running, owed and parked, merged at a step) cannot be written down. Read from the stored job in one place
// (`phaseOf`, src/orchestrator/phase.ts); everything that asks "where is it" or "what does it wait for" reads this.

/** The steps that run as an agent session. */
export type Step = "triage" | "implement" | "review";

/** A retry timer after `failures` failed attempts, the short pause between steps, or a usage limit's reset (`limit`): not before `time`. */
export type Timer = { time: string; failures: number; limit: boolean };

/** The description Scope Soup wrote on the host at `at`, while the store may still read the text before it (`from`, its hash). */
export type TextWait = { from: string; at: string };

/** A step's session: not started yet (with the timed waits that may hold it back), or running. */
export type Run = { is: "waiting"; text?: TextWait; timer?: Timer } | { is: "running"; session: string };

/** What a person is asked while the job is parked on a question. */
export type Ask =
  /** Several triage questions, answered one by one: `n` of them, `answered` so far. */
  | { is: "questions"; n: number; answered: number }
  /** One question (a triage's single question, an implementor's, a stop with a reason). */
  | { is: "question" }
  /** The triage's rewrite of the description, with its questions. */
  | { is: "rewrite" }
  /** A restructuring triage proposed. */
  | { is: "restructuring" };

/** Where a parked state came from: a step, or the change itself (its hand-over, its merging, a person closing it). */
export type From = Step | "change";

export type Phase =
  /** `again`: a triage taken again (a recheck); `settled`: a person settled the rewrite, and the next tick goes on from it. */
  | { at: "triage"; run: Run; why: "first" | "again" | "settled" }
  /**
   * Parked on a question for a person. `posting`: what it asks (its questions, or a not-ready or escalated reason as one question)
   * could not be posted on the host yet; each tick tries again.
   */
  | { at: "asked"; from: From; ask: Ask; posting: boolean }
  /** Parked as not ready: by triage's verdict (`verdict`, which Implement anyway overrules) or by a person's stop. */
  | { at: "not-ready"; verdict: boolean }
  /** `first`: nothing of the implement step has begun (no change, no attempt, nothing to resume). */
  | { at: "implement"; run: Run; why: "first" | "again" }
  | { at: "review"; run: Run }
  /** Escalated to a person. `hand-over`: the work is done and only its hand-over failed; an answer repeats just that. */
  | { at: "stuck"; from: From | "hand-over" }
  /** The hand-over is owed (a person said try again, or picked Merge queue): the next tick hands over without a session. */
  | { at: "hand-over" }
  /** The merge queue has the change. */
  | { at: "queued" }
  /** Handed over to a person to merge. */
  | { at: "with-person" }
  /** The change is on main. `closeOwed`: closing the Item on the host failed, and each tick tries again. */
  | { at: "merged"; sha: string; closeOwed: boolean };

/** A person's pick on the board that the job carries out (decision 104): a step that runs whatever the level, the queue, or a drop. */
export type Pick = { by: string; to: Step | "queue" | "drop" };

/** The step a phase runs (or would run next), for the phases that have one. */
export function stepOf(phase: Phase): Step | null {
  switch (phase.at) {
    case "triage":
    case "implement":
    case "review":
      return phase.at;
    case "asked":
    case "not-ready":
    case "stuck":
    case "hand-over":
    case "queued":
    case "with-person":
    case "merged":
      return null;
  }
}

/** The step that waits to start: a step phase with no session running. Null for a running or parked phase. */
export function waitingStep(phase: Phase): Step | null {
  return (phase.at === "triage" || phase.at === "implement" || phase.at === "review") && phase.run.is === "waiting" ? phase.at : null;
}

/** The session the phase runs now, if any. */
export function sessionOf(phase: Phase): string | undefined {
  return (phase.at === "triage" || phase.at === "implement" || phase.at === "review") && phase.run.is === "running" ? phase.run.session : undefined;
}

/**
 * Parked for a person's answer on the Item's page (a question, a rewrite, a restructuring, not ready, escalated). A failed hand-over is
 * not: its answer only repeats the hand-over.
 */
export function waitsForAnswer(phase: Phase): boolean {
  return phase.at === "asked" || phase.at === "not-ready" || (phase.at === "stuck" && phase.from !== "hand-over");
}

/** The implement step has not begun: no change, no attempt, nothing to resume. Its start is new work (decision 133). */
export function firstImplement(phase: Phase): boolean {
  return phase.at === "implement" && phase.why === "first";
}

/** An answer to this parked phase goes on with the implement step that asked, keeping its round, findings and branch. */
export function resumesStep(phase: Phase): boolean {
  return (phase.at === "asked" && phase.from === "implement" && phase.ask.is !== "restructuring") || (phase.at === "stuck" && phase.from === "implement");
}

/** The change is out of the steps' hands: owed to the hand-over, in the merge queue, with a person to merge, or merged. */
export function changeHandedOn(phase: Phase): boolean {
  return phase.at === "hand-over" || phase.at === "queued" || phase.at === "with-person" || phase.at === "merged" || (phase.at === "stuck" && phase.from === "hand-over");
}
