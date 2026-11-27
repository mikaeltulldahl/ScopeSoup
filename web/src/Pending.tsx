// The State menu's Undo wait (#154), kept at the app's level: a pick waits about 5 s with a toast and its Undo, then is sent.
// Closing the Item or going to another view keeps the timer; leaving the page sends what waits at once (one keepalive
// request per pick, which carries the board's person as every request does).

import { useEffect, useState } from "preact/hooks";
import { postPlace, postStep, reloadViews } from "./api.ts";
import type { Shown } from "./drag.ts";
import type { Pending, StateKey, Step } from "./stateMenu.ts";
import { addPending, cancelPending, duePending } from "./stateMenu.ts";
import { words } from "./theme.ts";

/** A pick that waits: the Item's key, the `updatedAt` its page showed, the calls to send in order, and the blocker for a `block` step. */
export interface Change extends Pending {
  itemKey: string;
  /** The state picked, which the menu shows while it waits. */
  state: StateKey;
  seen: string;
  steps: Step[];
  /** For `block`: the Item's blockers after the pick, as ids. */
  blockedBy?: string[];
  /** A move on the board (#222): where the board shows the card while it waits. With no steps it is a move within its lane. */
  shown?: Shown;
  /** Also place it in its lane's order, right above `shown.before` (null: last), after the steps (`/api/item/place`). */
  place?: boolean;
  /** Moves made together (multi-select, #235) share one toast and one Undo; sent one after the other, in the order queued. */
  group?: number;
}

let pending: Change[] = [];
let nextId = 1;
let failure: string | null = null;
/** What the server said of a move that went through differently than dropped (a place kept within its group). */
let notice: string | null = null;
const watchers = new Set<() => void>();
const tell = () => watchers.forEach((watcher) => watcher());

/** The pick as one request: the server runs its steps in order and checks `seen` once, before the first (`POST /api/item/pick`). */
const body = (change: Change): Record<string, unknown> => ({ ref: change.itemKey, seen: change.seen, steps: change.steps, ...(change.blockedBy ? { blockedBy: change.blockedBy } : {}) });

/** What is sending: a group's places must reach the server in order, so one send starts when the one before it is done. */
let sending: Promise<void> = Promise.resolve();

async function send(change: Change): Promise<void> {
  try {
    if (change.steps.length > 0) await postStep("/api/item/pick", body(change));
    if (change.place && change.shown) {
      const said = await postPlace(change.itemKey, change.shown.before ?? null, change.shown.lane);
      if (said) {
        notice = said;
        tell();
      }
    }
  } catch (problem) {
    failure = `${change.text}: ${problem instanceof Error ? problem.message : String(problem)}`;
    tell();
  } finally {
    reloadViews();
  }
}

let timer: number | undefined;
function schedule(): void {
  window.clearTimeout(timer);
  if (pending.length === 0) return;
  const next = Math.min(...pending.map((entry) => entry.at));
  timer = window.setTimeout(() => {
    const { due, rest } = duePending(pending, Date.now());
    pending = rest;
    due.forEach((change) => (sending = sending.then(() => send(change))));
    tell();
    schedule();
  }, Math.max(0, next - Date.now()));
}

/** Puts a pick in the wait. */
export function queueChange(change: Omit<Change, "id" | "at">): void {
  failure = null;
  notice = null;
  pending = addPending(pending, { ...change, id: nextId++ }, Date.now());
  tell();
  schedule();
}

/** Puts moves made together in the wait: one toast with `text`, one Undo for all of them. */
export function queueGroup(changes: readonly Omit<Change, "id" | "at" | "group" | "text">[], text: string): void {
  if (changes.length === 0) return;
  failure = null;
  notice = null;
  const group = nextId++;
  const now = Date.now();
  for (const change of changes) pending = addPending(pending, { ...change, text, group, id: nextId++ }, now);
  tell();
  schedule();
}

function undo(id: number): void {
  const group = pending.find((change) => change.id === id)?.group;
  pending = group === undefined ? cancelPending(pending, id) : pending.filter((change) => change.group !== group);
  tell();
  schedule();
}

/** Leaving the page: everything that waits goes now, each step as a keepalive request. */
function flush(): void {
  const now = pending;
  pending = [];
  window.clearTimeout(timer);
  for (const change of now) {
    if (change.steps.length > 0) void postStep("/api/item/pick", body(change), true).catch(() => undefined);
    else if (change.place && change.shown) void postStep("/api/item/place", { ref: change.itemKey, before: change.shown.before ?? null, lane: change.shown.lane }, true).catch(() => undefined);
  }
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flush);

/** The state picked for the Item that waits to be sent, if any; re-renders when the wait changes. */
export function usePendingState(itemKey: string): StateKey | undefined {
  const [, setTick] = useState(0);
  useEffect(() => {
    const watcher = () => setTick((count) => count + 1);
    watchers.add(watcher);
    return () => void watchers.delete(watcher);
  }, []);
  return pending.filter((change) => change.itemKey === itemKey).at(-1)?.state;
}

/** The moves waiting that the board shows already, oldest first; re-renders when the wait changes. */
export function usePendingMoves(): Shown[] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const watcher = () => setTick((count) => count + 1);
    watchers.add(watcher);
    return () => void watchers.delete(watcher);
  }, []);
  return pending.flatMap((change) => (change.shown ? [change.shown] : []));
}

/** A note in the toasts, for a move refused before it waits (the lane does not take the card). */
export function showNotice(text: string): void {
  notice = text;
  tell();
}

/** The toasts at the foot of the page: each pick that waits with its Undo, and a pick the server refused. */
export function Toasts() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const watcher = () => setTick((count) => count + 1);
    watchers.add(watcher);
    return () => void watchers.delete(watcher);
  }, []);
  if (pending.length === 0 && !failure && !notice) return null;
  const theme = words();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {pending.filter((change, at) => change.group === undefined || pending.findIndex((other) => other.group === change.group) === at).map((change) => (
        <div class="toast" key={change.id}>
          <span>{change.text}</span>
          <button type="button" onClick={() => undo(change.id)}>{theme.undo}</button>
        </div>
      ))}
      {notice && (
        <div class="toast" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => { notice = null; tell(); }} aria-label="Dismiss">×</button>
        </div>
      )}
      {failure && (
        <div class="toast toast-bad" role="alert">
          <span>{failure}</span>
          <button type="button" onClick={() => { failure = null; tell(); }} aria-label="Dismiss">×</button>
        </div>
      )}
    </div>
  );
}
