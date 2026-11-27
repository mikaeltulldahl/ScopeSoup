// W, what an Item waits for (#211): one value from the job's phase, the Item and what the caller knows of the world. The board and
// the tick read it instead of working it out each on their own. Pure. The simulator's checker has its own on purpose (src/sim/waits.ts).

import type { Phase, Pick, Run, Step } from "./phase.ts";

export type PersonWhy = "answer" | "rewrite" | "restructuring" | "not-ready" | "escalated" | "merge" | "holds";

/**
 * Why a known next step has not started, in the order of decision 3. `backlog`: in Backlog, the implement step waits for a person's move
 * to To do; `text`: the description Scope Soup wrote is not read back yet; `next`: nothing holds it, the next tick does it (an owed
 * hand-over needs no session).
 */
export type StartCause = "backlog" | "text" | "same-files" | "switch" | "level" | "usage" | "pace" | "timer" | "claim" | "cap" | "slot" | "next";

export type Wait =
  | { kind: "nothing" }
  /** A person moved the job back (To do, Backlog): the next tick drops it, and nothing of it waits. */
  | { kind: "not-started" }
  | { kind: "session"; role: Step }
  /** `n`: the questions still unanswered, when it asks several. */
  | { kind: "person"; why: PersonWhy; n?: number }
  | { kind: "blocker"; on: string[] }
  | { kind: "queue" }
  | { kind: "start"; role: Step | "hand-over"; cause: StartCause };

/** What `waitsFor` reads of the Item. */
export interface WaitFacts {
  closed: boolean;
  /** A person (not an agent) holds it. */
  heldByPerson: boolean;
  backlog: boolean;
  /** The keys of its open blockers, the host's and Scope Soup's own. */
  blockers: readonly string[];
  /** `itemTextHash` of the Item as read now. */
  textHash: string;
}

/**
 * What the caller knows of the world, for the causes that are not the job's own. A cause the caller leaves out is not checked: the board
 * knows fewer than the tick, and says those with words of its own.
 */
export interface WaitWorld {
  now: string;
  /** The busy Items it waits for before its first implement step (the same files, or a conflict). */
  sameFiles?: readonly string[];
  switches?: Record<Step, string>;
  level?: number;
  usageReserve?: boolean;
  paceHolds?: boolean;
  /** An agent's claim from another machine stands on it. */
  claimedElsewhere?: boolean;
  /** As many things wait for a person as the cap on new work, or more (decision 133). */
  workCapped?: boolean;
}

export interface WaitInput {
  phase: Phase;
  pick?: Pick;
  facts: WaitFacts;
  world: WaitWorld;
}

/** How long a job waits at most for the description Scope Soup wrote to be read back from the host (`Run.text`). */
export const WRITING_WAIT_MS = 30 * 60_000;

/** The level from which a role runs by itself. */
export const STEP_LEVEL: Record<Step, number> = { triage: 1, implement: 2, review: 3 };

export function waitsFor(input: WaitInput): Wait {
  const { phase, facts } = input;
  if (facts.closed) return { kind: "nothing" };
  // Decision 3: a person's hold comes first, then the job's own state.
  const held = (): Wait | null => (facts.heldByPerson ? { kind: "person", why: "holds" } : null);
  switch (phase.at) {
    case "merged":
      return { kind: "nothing" };
    case "triage":
    case "implement":
    case "review":
      return held() ?? (phase.run.is === "running" ? { kind: "session", role: phase.at } : startWait(phase.at, phase.run, phase.at === "implement" && phase.why === "first", input));
    case "asked":
      return held() ?? (phase.posting ? { kind: "person", why: "escalated" }
        : phase.ask.is === "questions" ? { kind: "person", why: "answer", n: Math.max(0, phase.ask.n - phase.ask.answered) }
        : phase.ask.is === "question" ? { kind: "person", why: "answer", n: 1 }
        : { kind: "person", why: phase.ask.is });
    case "not-ready":
      return held() ?? { kind: "person", why: "not-ready" };
    case "stuck":
      return held() ?? { kind: "person", why: "escalated" };
    case "with-person":
      return held() ?? { kind: "person", why: "merge" };
    case "queued":
      return held() ?? { kind: "queue" };
    case "hand-over":
      return held() ?? { kind: "start", role: "hand-over", cause: "next" };
  }
}

/** A step that has not started: the first cause in the order of decision 3 that holds, else a free slot. */
function startWait(role: Step, run: Extract<Run, { is: "waiting" }>, first: boolean, input: WaitInput): Wait {
  const { pick, facts, world } = input;
  const picked = pick?.to === role;
  // A person's Triage pick runs on a blocked Item too (decision 104).
  if (facts.blockers.length > 0 && !(picked && role === "triage")) return { kind: "blocker", on: [...facts.blockers] };
  // Put back by a person: the next tick drops it.
  if (pick?.to === "drop") return { kind: "not-started" };
  const start = (cause: StartCause): Wait => ({ kind: "start", role, cause });
  // In Backlog after a one-off triage, new work waits for a person's move to To do (decision 121).
  if (facts.backlog && first && !picked) return start("backlog");
  if (run.text && run.text.from === facts.textHash && Date.parse(world.now) - Date.parse(run.text.at) < WRITING_WAIT_MS) return start("text");
  if (first && (world.sameFiles?.length ?? 0) > 0) return start("same-files");
  // A pick runs whatever the level, but from the level that shows the role's switch the switch decides (decision 104).
  if (world.switches && world.switches[role] !== "started" && (!picked || (world.level ?? 0) >= STEP_LEVEL[role])) return start("switch");
  if (world.level !== undefined && STEP_LEVEL[role] > world.level && !picked) return start("level");
  if (world.usageReserve) return start("usage");
  if (world.paceHolds) return start("pace");
  if (run.timer && Date.parse(run.timer.time) > Date.parse(world.now)) return start("timer");
  if (world.claimedElsewhere) return start("claim");
  if (world.workCapped && first && !picked) return start("cap");
  return start("slot");
}
