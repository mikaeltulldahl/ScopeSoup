// The empty state, and the small helpers the fold and the advance share.

import { refKey } from "../model/types.ts";
import type { Ref } from "../model/types.ts";
import type { Measured, QueueBatch, QueueConfig, QueueEffect, QueueEntry, QueueState } from "./types.ts";

export function initialState(main?: string): QueueState {
  const state: QueueState = {
    v: 1,
    entries: [],
    leaders: [],
    batches: [],
    nextBatch: 1,
    outcomes: [],
    known: [],
    steps: [],
    counters: { batches: 0, merged: 0, culprits: 0, bisections: 0, runs: 0, reruns: 0, runsReused: 0, flakes: 0, conflicts: 0 },
  };
  if (main !== undefined) state.main = main;
  return state;
}

export function emptyMeasured(): Measured {
  return { d: { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 }, f: { n: 0, rerunMs: 0, fullMs: 0 }, s: { n: 0, named: 0 } };
}

/** What one step works with: the state it may change, and what it has decided and done so far. */
export interface Ctx {
  s: QueueState;
  config: QueueConfig;
  now: string;
  effects: QueueEffect[];
  /** What the step did, in words, with the batch it concerns (0 for the queue itself). */
  did: { batch: number; text: string }[];
}

export function note(ctx: Ctx, batch: QueueBatch | null, text: string): void {
  ctx.did.push({ batch: batch?.id ?? 0, text });
}

/** The batch that is being built or tested, if any. */
export function current(s: QueueState): QueueBatch | null {
  const last = s.batches[s.batches.length - 1];
  return last && last.status !== "done" ? last : null;
}

export function entryOf(s: QueueState, change: Ref): QueueEntry | undefined {
  const key = refKey(change);
  return s.entries.find((e) => refKey(e.change) === key);
}

export function removeEntry(s: QueueState, change: Ref): void {
  const key = refKey(change);
  s.entries = s.entries.filter((e) => refKey(e.change) !== key);
}

export function pause(ctx: Ctx, reason: string, by: string): void {
  ctx.s.paused = { reason, by, at: ctx.now };
}

export const short = (sha: string): string => sha.slice(0, 7);

export const names = (refs: readonly Ref[]): string => refs.map((r) => r.id).join(", ");

/** The main branch commit a batch expects: its base, or the last member it merged. */
export function expectedMain(b: QueueBatch): string {
  return b.good === 0 ? b.base : (b.members[b.good - 1]?.sha ?? b.base);
}

/** Ends a batch. `leaders` are the refKeys that lead the next one. */
export function endBatch(ctx: Ctx, b: QueueBatch, why: string, leaders: readonly string[]): void {
  const { s } = ctx;
  for (const p of b.probes) {
    if (p.status !== "queued" && p.status !== "running") continue;
    ctx.effects.push({ kind: "cancel-run", batch: b.id, run: p.id, sha: p.sha });
    p.status = "cancelled";
    p.handled = true;
    p.finishedAt = ctx.now;
  }
  for (const m of b.members) if (m.state === "waiting" || m.state === "testing") m.state = "requeued";
  b.status = "done";
  b.note = why;
  b.finishedAt = ctx.now;
  delete b.toMerge;
  delete b.merge;
  s.leaders = [...new Set([...leaders, ...s.leaders])];
  // Only a batch that learned something from a run says what was flaky "last time".
  if (b.probes.some((p) => !p.reused && (p.status === "passed" || p.status === "failed"))) s.flaky = { batch: b.id, files: [...b.passedOnRerun] };
  s.counters.batches++;
  if (s.batches.length > ctx.config.keepBatches) s.batches = s.batches.slice(-ctx.config.keepBatches);
  note(ctx, b, `ended: ${why}`);
}

/** Members good+1..upTo are in the main branch now. */
export function markMerged(ctx: Ctx, b: QueueBatch, upTo: number, outside: boolean): void {
  const { s } = ctx;
  const fresh = b.members.slice(b.good, upTo);
  if (fresh.length === 0) return;
  for (const m of fresh) {
    m.state = "merged";
    removeEntry(s, m.change);
  }
  const tested = b.members[upTo - 1]?.sha ?? "";
  const members = fresh.map((m) => ({ change: m.change, sha: m.sha, head: m.head }));
  if (outside) {
    ctx.effects.push({ kind: "mark-merged", batch: b.id, members, outside: true });
  } else {
    const run = [...b.probes].reverse().find((p) => p.sha === tested && p.status === "passed")?.run;
    ctx.effects.push({ kind: "mark-merged", batch: b.id, members, tested, ...(run ? { run } : {}) });
    s.outcomes = [...s.outcomes, ...fresh.map((m) => ({ change: refKey(m.change), ok: true }))].slice(-ctx.config.batch.window);
    s.counters.merged += fresh.length;
  }
  b.good = upTo;
  if (b.bad !== null && b.bad <= b.good) b.bad = null;
  if (b.suspect !== null && b.suspect <= b.good) b.suspect = null;
  note(ctx, b, `${names(fresh.map((m) => m.change))} merged${outside ? " outside the queue" : ` (prefix ${upTo}, ${short(tested)})`}`);
}
