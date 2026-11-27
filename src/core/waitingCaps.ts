// Don't outrun the person (decision 132): what waits for a person caps new work. Pure.
//
// Everything that waits for a person counts: an Item parked for a person (questions, a rewrite, a restructuring, not ready, escalated,
// a change handed over to merge), on this machine or read from another, an Item with decisions to look at, and each Item draft. An
// Item counts once however many of these it has. At `triage` things waiting no new Item's triage starts; at `work` no new work (a
// first implement step) starts. Work under way, its fix rounds, the steps an answer resumes and the questions themselves go on.

import { plural } from "../model/plural.ts";

export interface WaitingItem {
  /** Parked for a person here (not in the merge queue's hands), or read as waiting for a decision by a person from another machine. */
  asks: boolean;
  /** Decisions (assumptions) on it a person has not looked at. */
  openDecisions: number;
}

/** How many things wait for a person: the Items with an ask or decisions to look at, and the drafts. */
export function countWaiting(items: readonly WaitingItem[], drafts: number): number {
  return items.filter((item) => item.asks || item.openDecisions > 0).length + drafts;
}

export interface WaitingCaps {
  triage: number;
  work: number;
}

/** "new triage waits: 2 things wait for you", or null when a start of that kind may go. */
export function waitingCapWait(kind: "triage" | "work", waiting: number, caps: WaitingCaps): string | null {
  const cap = kind === "triage" ? caps.triage : caps.work;
  if (waiting < cap) return null;
  return `new ${kind === "triage" ? "triage" : "work"} waits: ${plural(waiting, "thing")} ${waiting === 1 ? "waits" : "wait"} for you (it starts below ${cap})`;
}
