// What the board shows about the merge queue beyond its batches: why it is paused, the flakes and
// problems it reported, and what it has measured about its own runs. Kept in the store next to the
// queue's state, so the board reads it without the driver.

import type { QueueHealth, QueueNoteView } from "../core/snapshot.ts";
import type { QueueState } from "../queue/index.ts";
import type { Store } from "../store/store.ts";

/** The queue's state, as `queueDriver.ts` stores it. */
export const QUEUE_KEY = "orchestrator.queue";
/** The recent flakes and problems, newest last. */
const NOTES_KEY = "orchestrator.queue.notes";
/** Set by the board to ask the next tick to resume the paused queue; holds who asked. */
const RESUME_KEY = "orchestrator.queue.resume";
const KEEP = 20;

function parse<T>(text: string | null, ok: (value: unknown) => boolean, fallback: T): T {
  if (text === null) return fallback;
  try {
    const value: unknown = JSON.parse(text);
    return ok(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function queueNotes(store: Store): QueueNoteView[] {
  return parse<QueueNoteView[]>(store.getValue(NOTES_KEY), Array.isArray, []);
}

/** Keeps a flake or a problem for the board. The same text twice in a row is kept once. */
export function recordQueueNote(store: Store, at: string, kind: QueueNoteView["kind"], text: string): void {
  const notes = queueNotes(store);
  if (notes.at(-1)?.text === text && notes.at(-1)?.kind === kind) return;
  store.setValue(NOTES_KEY, JSON.stringify([...notes, { at, kind, text }].slice(-KEEP)));
}

/** How often each test file failed and then passed on a rerun. */
const FLAKY_KEY = "orchestrator.queue.flaky";
const FLAKY_KEEP = 50;

type FlakyCount = { test: string; count: number; at: string };

function flakyCounts(store: Store): FlakyCount[] {
  return parse<FlakyCount[]>(store.getValue(FLAKY_KEY), Array.isArray, []);
}

/** Counts one more flaky failure for each test. The most recent ones are kept. */
export function recordFlakyTests(store: Store, at: string, tests: readonly string[]): void {
  const all = flakyCounts(store);
  for (const test of new Set(tests)) {
    const found = all.find((entry) => entry.test === test);
    if (found) {
      found.count++;
      found.at = at;
    } else all.push({ test, count: 1, at });
  }
  all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  store.setValue(FLAKY_KEY, JSON.stringify(all.slice(-FLAKY_KEEP)));
}

/** The end of a failure excerpt, short enough for a note. */
export function shortExcerpt(excerpt: string | undefined, chars = 300): string {
  const text = (excerpt ?? "").trim();
  if (text === "") return "";
  return text.length > chars ? `...${text.slice(-chars)}` : text;
}

function stateOf(store: Store): QueueState | null {
  return parse<{ state?: QueueState } | null>(store.getValue(QUEUE_KEY), (value) => typeof value === "object" && value !== null, null)?.state ?? null;
}

/** What the board shows. Absent when the queue never ran. */
export function readQueueHealth(store: Store): QueueHealth | undefined {
  const state = stateOf(store);
  const notes = queueNotes(store);
  const flaky = flakyCounts(store);
  if (!state && notes.length === 0 && flaky.length === 0) return undefined;
  const health: QueueHealth = { notes };
  if (flaky.length > 0) health.flaky = [...flaky].reverse();
  if (state?.paused) health.paused = { reason: state.paused.reason, at: state.paused.at };
  const m = state?.measured;
  if (m) {
    health.measured = {
      timedRuns: m.d.n,
      reruns: m.f.n,
      ...(m.f.fullMs > 0 ? { rerunCost: m.f.rerunMs / m.f.fullMs } : {}),
      culpritBatches: m.s.n,
      culpritNamed: m.s.named,
    };
  }
  return health;
}

/** Whether the board asked to resume the paused queue and the tick has not done it yet. */
/** Who asked for the resume (the board's picked person, or "board"), or null when nobody did. */
export function resumeRequestedBy(store: Store): string | null {
  const value = store.getValue(RESUME_KEY);
  return value !== null && value !== "" ? value : null;
}

export function resumeRequested(store: Store): boolean {
  const value = store.getValue(RESUME_KEY);
  return value !== null && value !== "";
}

export function clearResumeRequest(store: Store): void {
  if (resumeRequested(store)) store.setValue(RESUME_KEY, "");
}

/**
 * The board's resume: asks the next tick to let the paused queue go on. Refused when the queue is
 * not paused. The request and its event are one transaction, like the switches.
 */
export function requestQueueResume(store: Store, at: string, by: string): { ok: true } | { ok: false; reason: string } {
  const state = stateOf(store);
  if (!state?.paused) return { ok: false, reason: "The merge queue is not paused." };
  const why = state.paused.reason;
  store.tx(() => {
    store.setValue(RESUME_KEY, by);
    store.appendEvent({ kind: "control.queue_resume", actor: by, data: { via: "board", reason: `${by} asked to resume the merge queue. It had stopped because: ${why}` } }, at);
  });
  return { ok: true };
}
