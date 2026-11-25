// The State menu's Undo wait (#154), kept at the app's level: a pick waits about 5 s with a toast and its Undo, then is sent.
// Closing the Item or going to another view keeps the timer; leaving the page sends what waits at once (keepalive requests,
// which carry the board's person as every request does).

import { useEffect, useState } from "preact/hooks";
import { postStep, reloadViews } from "./api.ts";
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
}

let pending: Change[] = [];
let nextId = 1;
let failure: string | null = null;
const watchers = new Set<() => void>();
const tell = () => watchers.forEach((watcher) => watcher());

/** The request for one step. Only the first carries `seen`: the Item changes with each step. */
function request(change: Change, step: Step, first: boolean): { path: string; body: Record<string, unknown> } {
  const seen = first ? { seen: change.seen } : {};
  switch (step.kind) {
    case "release":
      return { path: "/api/item/release", body: { id: change.itemKey, ...seen } };
    case "claim":
      return { path: "/api/item/claim", body: { id: change.itemKey, ...seen } };
    case "state":
      return { path: "/api/item/edit", body: { ref: change.itemKey, state: step.state, ...seen } };
    case "block":
      return { path: "/api/item/edit", body: { ref: change.itemKey, blockedBy: change.blockedBy ?? [], ...seen } };
    case "move":
      return { path: "/api/item/move", body: { ref: change.itemKey, to: step.to, ...seen } };
  }
}

async function send(change: Change): Promise<void> {
  try {
    for (const [index, step] of change.steps.entries()) {
      const { path, body } = request(change, step, index === 0);
      await postStep(path, body);
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
    due.forEach((change) => void send(change));
    tell();
    schedule();
  }, Math.max(0, next - Date.now()));
}

/** Puts a pick in the wait. */
export function queueChange(change: Omit<Change, "id" | "at">): void {
  failure = null;
  pending = addPending(pending, { ...change, id: nextId++ }, Date.now());
  tell();
  schedule();
}

function undo(id: number): void {
  pending = cancelPending(pending, id);
  tell();
  schedule();
}

/** Leaving the page: everything that waits goes now, each step as a keepalive request. */
function flush(): void {
  const now = pending;
  pending = [];
  window.clearTimeout(timer);
  for (const change of now) change.steps.forEach((step, index) => {
    const { path, body } = request(change, step, index === 0);
    void postStep(path, body, true).catch(() => undefined);
  });
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

/** The toasts at the foot of the page: each pick that waits with its Undo, and a pick the server refused. */
export function Toasts() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const watcher = () => setTick((count) => count + 1);
    watchers.add(watcher);
    return () => void watchers.delete(watcher);
  }, []);
  if (pending.length === 0 && !failure) return null;
  const theme = words();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {pending.map((change) => (
        <div class="toast" key={change.id}>
          <span>{change.text}</span>
          <button type="button" onClick={() => undo(change.id)}>{theme.undo}</button>
        </div>
      ))}
      {failure && (
        <div class="toast toast-bad" role="alert">
          <span>{failure}</span>
          <button type="button" onClick={() => { failure = null; tell(); }} aria-label="Dismiss">×</button>
        </div>
      )}
    </div>
  );
}
