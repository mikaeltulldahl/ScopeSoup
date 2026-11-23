// The queue engine: (state, input) -> (state, effects). No I/O and no clock; the caller performs
// the effects and feeds what happened back as inputs.

import { advance } from "./advance.ts";
import { fold } from "./fold.ts";
import { type Ctx, current } from "./state.ts";
import type { QueueConfig, QueueInput, QueueState, StepRecord, StepResult } from "./types.ts";

export function step(state: QueueState, input: QueueInput, config: QueueConfig, now: string): StepResult {
  const ctx: Ctx = { s: structuredClone(state), config, now, effects: [], did: [] };
  fold(ctx, input);
  if (!ctx.s.paused) advance(ctx);
  if (ctx.effects.length === 0) ctx.effects.push({ kind: "idle", reason: waitingFor(ctx.s) });
  record(ctx, input);
  return { state: ctx.s, effects: ctx.effects };
}

/** Why the queue has nothing to do, in words. */
export function waitingFor(s: QueueState): string {
  if (s.paused) return `paused: ${s.paused.reason}`;
  const b = current(s);
  if (!b) return s.main === undefined ? "the main branch head is not known" : "no change is ready";
  if (b.status === "building") return `waiting for the chain of batch ${b.id}`;
  if (b.merge) return `waiting for the fast-forward of batch ${b.id}`;
  const run = b.probes.find((p) => p.status === "queued" || p.status === "running");
  return run ? `waiting for run ${run.id} of batch ${b.id}` : `batch ${b.id} is waiting`;
}

/** Writes what set the step off and what it did: for the queue, and for each batch it touched. */
function record(ctx: Ctx, input: QueueInput): void {
  const { s } = ctx;
  const limit = ctx.config.historyLimit;
  const trigger = input.by ? `${input.kind} (${input.by})` : input.kind;
  const idle = ctx.effects.find((e) => e.kind === "idle");
  const all = ctx.did.map((d) => d.text);
  if (idle) all.push(`nothing to do: ${idle.reason}`);
  s.steps = [...s.steps, { at: ctx.now, trigger, did: all }].slice(-limit);
  for (const b of s.batches) {
    const did = ctx.did.filter((d) => d.batch === b.id).map((d) => d.text);
    if (did.length === 0) continue;
    const entry: StepRecord = { at: ctx.now, trigger, did };
    b.history = [...b.history, entry].slice(-limit);
  }
}
