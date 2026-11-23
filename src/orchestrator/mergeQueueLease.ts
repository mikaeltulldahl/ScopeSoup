// The merge queue lease as the merge queue uses it (mergeQueue.ts has the mechanism): the queue takes it
// before anything is pushed to the main branch and lets it go afterwards.
// Without a merge queue (one machine, or the lease switched off) every call lets the merge go ahead.

import { KEYS } from "../store/keys.ts";
import type { Context } from "./context.ts";

/** What this machine last saw of the lease, for the board. */
export interface MergeQueueNote {
  /** The machine that holds it, or null when nobody does. */
  holder: string | null;
  until?: string;
  /** This machine holds it. */
  mine: boolean;
  /** When this machine looked. */
  at: string;
}

/** The lease is a little longer than the check may take, so it lapses only if its holder died. */
export const leaseMinutes = (ctx: Context): number => ctx.config.settings.checkTimeoutMinutes.value + 15;

export function readMergeQueueNote(read: (key: string) => string | undefined | null): MergeQueueNote | null {
  const text = read(KEYS.mergeQueueNote);
  if (!text) return null;
  try {
    return JSON.parse(text) as MergeQueueNote;
  } catch {
    return null;
  }
}

function note(ctx: Context, value: Omit<MergeQueueNote, "at">): void {
  const text = JSON.stringify({ ...value, at: ctx.at } satisfies MergeQueueNote);
  const before = ctx.deps.store.getValue(KEYS.mergeQueueNote);
  // Only a change is written, so that a lease renewed every merging does not rewrite it every tick.
  const old = before ? (JSON.parse(before) as MergeQueueNote) : null;
  if (old && old.holder === value.holder && old.mine === value.mine && old.until === value.until) return;
  ctx.deps.store.setValue(KEYS.mergeQueueNote, text);
}

/**
 * Takes the lease. False: another machine merges now, and `why` is said once on the board; the caller
 * leaves the merge for a later tick.
 */
export async function takeLease(ctx: Context, subject: string, what: string): Promise<boolean> {
  const { mergeQueue } = ctx.deps;
  if (!mergeQueue) return true;
  const lease = await mergeQueue.acquire(ctx.at, leaseMinutes(ctx));
  if (lease.held) {
    note(ctx, { holder: "this machine", mine: true, until: lease.until });
    ctx.forget("orchestrator.merge_queue_wait", subject);
    return true;
  }
  note(ctx, { holder: lease.holder ?? null, mine: false, ...(lease.until ? { until: lease.until } : {}) });
  ctx.say("orchestrator.merge_queue_wait", `${what} waits: ${lease.why}.`, subject);
  return false;
}

export async function giveLease(ctx: Context): Promise<void> {
  const { mergeQueue } = ctx.deps;
  if (!mergeQueue) return;
  await mergeQueue.release(ctx.at);
  note(ctx, { holder: null, mine: false });
}
