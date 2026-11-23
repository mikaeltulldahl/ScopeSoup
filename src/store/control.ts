// The switches over what Scope Soup runs (docs/RUNNING.md "Start, Pause and Stop"):
//   agents   Start agents / Pause agents: whether the orchestrator starts sessions. Pause lets running sessions
//            finish their step and starts nothing new.
//   merge queue  Start merge queue / Pause merge queue: whether Scope Soup merges (level 4: the merge queue).
//            Paused, no new merging or batch starts; a merge under way finishes (its check runs, it pushes if green).
//   Stop     the stop switch (core rule 3): pauses both, ends running sessions and cuts off a merge under way at its
//            next safe point, before any push. Both read "stopped" until their Start is pressed.
// Scope Soup comes up paused after every start-up. A missing value reads as paused, so nothing runs by accident.
// Every change writes its event in the same transaction.

import type { AgentsState, MergeQueueState } from "../model/types.ts";
import { KEYS } from "./keys.ts";
import type { Store } from "./store.ts";

export type { AgentsState, MergeQueueState };

export type ControlAction = "agents.start" | "agents.pause" | "mergeQueue.start" | "mergeQueue.pause" | "stop" | "pause" | "resume";

export interface ControlState {
  agents: AgentsState;
  mergeQueue: MergeQueueState;
}

export interface ControlResult extends ControlState {
  /** Whether anything changed (an event was written). */
  changed: boolean;
  /** For the old `/api/pause` and `/api/resume`: true while agents are not started. */
  paused: boolean;
}

export function agentsState(store: Pick<Store, "getValue">): AgentsState {
  const value = store.getValue(KEYS.agents);
  return value === "started" || value === "stopped" ? value : "paused";
}

export function mergeQueueState(store: Pick<Store, "getValue">): MergeQueueState {
  const value = store.getValue(KEYS.mergeQueue);
  return value === "started" || value === "stopped" ? value : "paused";
}

/** Sessions may start. */
export const agentsOn = (store: Pick<Store, "getValue">): boolean => agentsState(store) === "started";
/** Scope Soup may merge (hand changes to the queue, drive it, push). */
export const mergeQueueOn = (store: Pick<Store, "getValue">): boolean => mergeQueueState(store) === "started";
/** Stop was pressed: a merge under way is cut off at its next safe point, before any push. Pause merge queue lets it finish. */
export const mergeQueueStopped = (store: Pick<Store, "getValue">): boolean => mergeQueueState(store) === "stopped";

export function readControl(store: Pick<Store, "getValue">): ControlState {
  return { agents: agentsState(store), mergeQueue: mergeQueueState(store) };
}

/**
 * Applies one of the switches. `via` says where it came from (the board, an alias endpoint). Pause agents or
 * Pause merge queue after Stop keeps "stopped": what Stop ended is not let to run on.
 */
export function applyControl(store: Store, action: ControlAction, at: string, via: string, actor = "someone"): ControlResult {
  return store.tx(() => {
    const before = readControl(store);
    let changed = false;
    const setAgents = (to: AgentsState, kind: string, data: Record<string, unknown> = {}): void => {
      if (agentsState(store) === to) return;
      store.setValue(KEYS.agents, to);
      store.appendEvent({ kind, actor, data: { via, ...data } }, at);
      changed = true;
    };
    const setMergeQueue = (to: MergeQueueState, kind: string): void => {
      if (mergeQueueState(store) === to) return;
      store.setValue(KEYS.mergeQueue, to);
      store.appendEvent({ kind, actor, data: { via } }, at);
      changed = true;
    };
    const pauseAgents = (): void => {
      if (agentsState(store) === "started") setAgents("paused", "control.agents_paused");
    };
    const pauseMergeQueue = (): void => {
      if (mergeQueueState(store) === "started") setMergeQueue("paused", "control.merge_queue_paused");
    };
    switch (action) {
      case "agents.start":
        setAgents("started", "control.agents_started");
        break;
      case "agents.pause":
        pauseAgents();
        break;
      case "mergeQueue.start":
        setMergeQueue("started", "control.merge_queue_started");
        break;
      case "mergeQueue.pause":
        pauseMergeQueue();
        break;
      case "resume":
        setAgents("started", "control.agents_started");
        setMergeQueue("started", "control.merge_queue_started");
        break;
      case "pause":
        pauseAgents();
        pauseMergeQueue();
        break;
      case "stop":
        if (before.agents !== "stopped" || before.mergeQueue !== "stopped") {
          store.setValue(KEYS.agents, "stopped");
          store.setValue(KEYS.mergeQueue, "stopped");
          store.appendEvent({ kind: "control.stopped", actor, data: { via, agents: before.agents, mergeQueue: before.mergeQueue } }, at);
          changed = true;
        }
        break;
    }
    const after = readControl(store);
    return { ...after, changed, paused: after.agents !== "started" };
  });
}

/**
 * Scope Soup comes up paused after every start-up: nothing runs until Start agents (and, at level 4, Start merge queue) is
 * pressed. Work under way goes on from the items' logs when it is. Writes one event saying what it was before.
 */
export function pauseAtStartup(store: Store, at: string): void {
  store.tx(() => {
    const before = readControl(store);
    store.setValue(KEYS.agents, "paused");
    store.setValue(KEYS.mergeQueue, "paused");
    store.appendEvent({ kind: "control.startup_paused", actor: "scopesoup", data: { agents: before.agents, mergeQueue: before.mergeQueue, reason: "Scope Soup starts paused: press Start agents (and Start merge queue at level 4) to let it work." } }, at);
  });
}
