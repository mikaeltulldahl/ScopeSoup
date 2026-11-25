// The switches over what Scope Soup runs (docs/RUNNING.md "Start, Pause and Stop"), each Resume / Pause, on the overview's
// lane it feeds:
//   triage       whether triage sessions start (Backlog, from level 1).
//   implement    whether implementor sessions start (In progress, from level 2).
//   review       whether review sessions start, and hand-backs are taken on (In review, from level 3).
//   merge queue  whether Scope Soup merges (Queued, level 4). Paused, no new merging or batch starts; a merge under way
//                finishes (its check runs, it pushes if green).
// Pausing one lets its running sessions finish their step (or its check under way finish) and starts nothing new of that
// kind; the others go on. "agents" names the three agent roles at once (Pause agents, the main guard, the old endpoints).
//   Stop     the stop switch (core rule 3): pauses all four, ends running sessions and cuts off a merge under way at its
//            next safe point, before any push. Each reads "stopped" until it is resumed.
// Scope Soup comes up paused after every start-up. A missing value reads as paused, so nothing runs by accident.
// Every change writes its event in the same transaction: one per switch that changed. A change takes the upgrade's note
// (what an upgrade started again or left paused) off the board.

import type { AgentsState, MergeQueueState, SessionRole } from "../model/types.ts";
import { KEYS } from "./keys.ts";
import type { Store } from "./store.ts";

export type { AgentsState, MergeQueueState };

/** One switch's state. */
export type SwitchState = AgentsState;
/** The four switches. */
export type SwitchName = SessionRole | "mergeQueue";
export const ROLES: readonly SessionRole[] = ["triage", "implement", "review"];
export const SWITCHES: readonly SwitchName[] = [...ROLES, "mergeQueue"];

const KEY: Record<SwitchName, string> = { triage: KEYS.triage, implement: KEYS.implement, review: KEYS.review, mergeQueue: KEYS.mergeQueue };
/** The event names' part for each switch: `control.<part>_started`, `control.<part>_paused`. */
const EVENT: Record<SwitchName, string> = { triage: "triage", implement: "implement", review: "review", mergeQueue: "merge_queue" };
/** In words, for the idle reason, the banner and the upgrade note. */
export const SWITCH_WORDS: Record<SwitchName, string> = { triage: "triage", implement: "implementors", review: "review", mergeQueue: "the merge queue" };

export type ControlAction = `${SwitchName}.start` | `${SwitchName}.pause` | "agents.start" | "agents.pause" | "stop" | "pause" | "resume";

export function isControlAction(value: string): value is ControlAction {
  const [name, verb] = value.split(".");
  if (verb === undefined) return value === "stop" || value === "pause" || value === "resume";
  return (verb === "start" || verb === "pause") && (name === "agents" || (SWITCHES as readonly string[]).includes(name ?? ""));
}

export interface ControlState {
  triage: SwitchState;
  implement: SwitchState;
  review: SwitchState;
  mergeQueue: MergeQueueState;
  /** The three agent roles together: "started" while any of them is, "stopped" when all three are, else "paused". */
  agents: AgentsState;
}

export interface ControlResult extends ControlState {
  /** Whether anything changed (an event was written). */
  changed: boolean;
  /** For the old `/api/pause` and `/api/resume`: true while no agent role is started. */
  paused: boolean;
}

export function switchState(store: Pick<Store, "getValue">, name: SwitchName): SwitchState {
  const value = store.getValue(KEY[name]);
  return value === "started" || value === "stopped" ? value : "paused";
}

/** The three agent roles together (see `ControlState.agents`). */
export function agentsState(store: Pick<Store, "getValue">): AgentsState {
  return combine(ROLES.map((role) => switchState(store, role)));
}

function combine(states: readonly SwitchState[]): AgentsState {
  if (states.includes("started")) return "started";
  return states.every((state) => state === "stopped") ? "stopped" : "paused";
}

export function mergeQueueState(store: Pick<Store, "getValue">): MergeQueueState {
  return switchState(store, "mergeQueue");
}

/** Sessions of this role may start. */
export const roleOn = (store: Pick<Store, "getValue">, role: SessionRole): boolean => switchState(store, role) === "started";
/** Stop was pressed and this role was not resumed since: its running sessions are ended. */
export const roleStopped = (store: Pick<Store, "getValue">, role: SessionRole): boolean => switchState(store, role) === "stopped";
/** Scope Soup may merge (hand changes to the queue, drive it, push). */
export const mergeQueueOn = (store: Pick<Store, "getValue">): boolean => mergeQueueState(store) === "started";
/** Stop was pressed: a merge under way is cut off at its next safe point, before any push. Pause merge queue lets it finish. */
/** The level from which the board shows each switch (`web/src/switches.ts`). */
export const SWITCH_LEVEL: Record<SwitchName, number> = { triage: 1, implement: 2, review: 3, mergeQueue: 4 };

/**
 * Whether work a person picked for a role (review, the merge queue) may run now (decision 104). From the level that shows the
 * role's switch, the switch decides, as for Scope Soup's own work. Below it the board has no button for it, so the hidden switch
 * holds nothing: only Stop in force (all four switches stopped, not resumed since) does.
 */
export function switchOnFor(store: Pick<Store, "getValue">, name: SwitchName, level: number): boolean {
  if (level >= SWITCH_LEVEL[name]) return switchState(store, name) === "started";
  return !SWITCHES.every((each) => switchState(store, each) === "stopped");
}

export const mergeQueueStopped = (store: Pick<Store, "getValue">): boolean => mergeQueueState(store) === "stopped";

export function readControl(store: Pick<Store, "getValue">): ControlState {
  const triage = switchState(store, "triage");
  const implement = switchState(store, "implement");
  const review = switchState(store, "review");
  return { triage, implement, review, mergeQueue: mergeQueueState(store), agents: combine([triage, implement, review]) };
}

/**
 * Applies one of the switches. `via` says where it came from (the board, an alias endpoint). A pause after Stop keeps
 * "stopped": what Stop ended is not let to run on.
 */
export function applyControl(store: Store, action: ControlAction, at: string, via: string, actor = "someone"): ControlResult {
  return store.tx(() => {
    const before = readControl(store);
    let changed = false;
    const start = (name: SwitchName): void => {
      if (switchState(store, name) === "started") return;
      store.setValue(KEY[name], "started");
      store.appendEvent({ kind: `control.${EVENT[name]}_started`, actor, data: { via } }, at);
      changed = true;
    };
    const pause = (name: SwitchName): void => {
      if (switchState(store, name) !== "started") return;
      store.setValue(KEY[name], "paused");
      store.appendEvent({ kind: `control.${EVENT[name]}_paused`, actor, data: { via } }, at);
      changed = true;
    };
    if (action === "stop") {
      if (SWITCHES.some((name) => before[name] !== "stopped")) {
        for (const name of SWITCHES) store.setValue(KEY[name], "stopped");
        store.appendEvent({ kind: "control.stopped", actor, data: { via, triage: before.triage, implement: before.implement, review: before.review, mergeQueue: before.mergeQueue } }, at);
        changed = true;
      }
    } else if (action === "resume") {
      for (const name of SWITCHES) start(name);
    } else if (action === "pause") {
      for (const name of SWITCHES) pause(name);
    } else {
      const [name, verb] = action.split(".") as [SwitchName | "agents", "start" | "pause"];
      const names = name === "agents" ? ROLES : [name];
      for (const each of names) (verb === "start" ? start : pause)(each);
    }
    // The upgrade's note says which switches were started again or stay paused: once one changes, it is no longer true.
    if (changed) store.setValue(KEYS.upgradeNote, "");
    const after = readControl(store);
    return { ...after, changed, paused: after.agents !== "started" };
  });
}

/**
 * Scope Soup comes up paused after every start-up: nothing runs until a switch is resumed. Work under way goes on from the
 * items' logs when it is. Writes one event saying what each was before.
 */
export function pauseAtStartup(store: Store, at: string): void {
  store.tx(() => {
    const before = readControl(store);
    for (const name of SWITCHES) store.setValue(KEY[name], "paused");
    store.appendEvent({ kind: "control.startup_paused", actor: "scopesoup", data: { triage: before.triage, implement: before.implement, review: before.review, mergeQueue: before.mergeQueue, reason: "Scope Soup starts paused: press Resume on the lanes (triage, implementors, review, the merge queue) to let it work." } }, at);
  });
}

/** Which of the four switches are started. */
export type Running = Record<SwitchName, boolean>;

/** Pauses all four (as `pause`) and says which were started before, so they can be started again (Get latest, Go back). */
export function pauseRemembering(store: Store, at: string, via: string, actor: string): Running {
  const before = readControl(store);
  applyControl(store, "pause", at, via, actor);
  return { triage: before.triage === "started", implement: before.implement === "started", review: before.review === "started", mergeQueue: before.mergeQueue === "started" };
}

/** Starts again the switches that are true; the others stay as they are. */
export function startAgain(store: Store, what: Running, at: string, via: string, actor: string): void {
  for (const name of SWITCHES) if (what[name]) applyControl(store, `${name}.start`, at, via, actor);
}

/** For tests: sets the three agent roles (no event; a test arranges the store). */
export function setRolesForTest(store: Pick<Store, "setValue">, to: SwitchState): void {
  for (const role of ROLES) store.setValue(KEY[role], to);
}
