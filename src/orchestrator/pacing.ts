// Pacing and the waiting caps at dispatch (decision 132): reads the sessions, the readings and what waits for a person from the store,
// and asks core (`core/forecast.ts`, `core/waitingCaps.ts`) whether one more session may start. What it decided is kept for the Usage
// tab (`KEYS.pacing`).

import type { ProjectConfig } from "../config/types.ts";
import { estimateSession, paceCheck, sessionsThatFit } from "../core/forecast.ts";
import type { PaceDecision, PastSession, SessionEstimate } from "../core/forecast.ts";
import { sessionUse, usageRole } from "../core/usage.ts";
import { countWaiting } from "../core/waitingCaps.ts";
import type { WaitingCaps } from "../core/waitingCaps.ts";
import type { Session, SessionRole, UsageWindowKind, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { KEYS } from "../store/keys.ts";
import type { Store } from "../store/store.ts";
import { openDrafts } from "./drafts.ts";
import type { Jobs } from "./jobs.ts";
import { providerFor } from "./providers/index.ts";

/** How far back the sessions a role's expected use is the median of are looked for. */
const HISTORY_MS = 2 * 24 * 3600_000;
const OVER: readonly Session["status"][] = ["succeeded", "failed", "cancelled", "limit"];

/** Each window's budget, a share of its even pace: the pace line ends there at the reset, and the usage stop is at it (at most 100 %). */
export function usageBudget(config: ProjectConfig): Record<UsageWindowKind, number> {
  return { five_hour: config.settings.budgetFiveHour.value, seven_day: config.settings.budgetSevenDay.value };
}

/** A session that still runs (a step's or a person's chat turn). */
export function isLive(session: Session): boolean {
  return !session.finishedAt && !OVER.includes(session.status);
}

/** The pacing state the Usage tab shows: sessions running by role, the cap in use and why, and what waits for a person. */
export interface PacingState {
  at: string;
  running: Record<SessionRole, number>;
  ceiling: number;
  /** How many at once the pace allows now (at most the ceiling), and why no more. */
  cap: number;
  why: string;
  /** Things waiting for a person, and the caps on new triage and new work. */
  waiting: number;
  caps: WaitingCaps;
  /** Why starts waited in the last tick that wanted to start something ("new triage waits: ..."). */
  waits: string[];
}

export interface Pacer {
  /** Whether one more session of `role` may start by the pace. Roles on a provider with a monthly allowance are not paced by the windows. */
  check(role: SessionRole): PaceDecision;
  /** A session of `role` started now: it counts as running for the next check. */
  started(role: SessionRole): void;
  /** How many at once the pace allows now, at most `ceiling`. */
  fits(ceiling: number): { count: number; reason: string };
}

/** The pace for this tick, from the store's readings and sessions. Estimates are worked out once, on the first check. */
export function pacer(store: Store, config: ProjectConfig, at: string): Pacer {
  const now = Date.parse(at);
  const sample = store.latestUsageSample();
  const budget = usageBudget(config);
  const sessions = store.list<Session>("session");
  let estimates: Record<SessionRole, SessionEstimate> | undefined;
  const estimate = (role: SessionRole): SessionEstimate => {
    if (!estimates) {
      const from = now - HISTORY_MS;
      const recent = sessions.filter((session) => !session.setupFailed && Date.parse(session.startedAt) >= from && Date.parse(session.startedAt) <= now);
      const samples = store.usageSamplesSince(new Date(from).toISOString()).filter((each) => Date.parse(each.at) <= now);
      const spans = recent.map((session) => ({ ref: session.ref, role: session.role, startedAt: session.startedAt, ...(session.finishedAt ? { finishedAt: session.finishedAt } : {}) }));
      const used = { five_hour: sessionUse(samples, spans, "five_hour", { from, to: now }), seven_day: sessionUse(samples, spans, "seven_day", { from, to: now }) };
      const maxMs = config.settings.sessionTimeoutMinutes.value * 60_000;
      const past = (role: SessionRole): PastSession[] => recent.filter((session) => session.finishedAt && !session.chat && usageRole(session.role) === role).map((session) => {
        const key = refKey(session.ref);
        return {
          startedAt: Date.parse(session.startedAt), finishedAt: Date.parse(session.finishedAt!),
          use: { ...(used.five_hour.has(key) ? { five_hour: used.five_hour.get(key)! } : {}), ...(used.seven_day.has(key) ? { seven_day: used.seven_day.get(key)! } : {}) },
        };
      });
      estimates = { triage: estimateSession(past("triage"), maxMs), implement: estimateSession(past("implement"), maxMs), review: estimateSession(past("review"), maxMs) };
    }
    return estimates[role];
  };
  const running = sessions.filter(isLive).map((session) => ({ role: usageRole(session.role), startedAt: Date.parse(session.startedAt) }));
  const runningNow = () => running.map((each) => ({ estimate: estimate(each.role), startedAt: each.startedAt }));
  return {
    check(role) {
      if (providerFor(config, role).allowance) return { allow: true, reason: "Paced by its monthly allowance." };
      // The kick needs no estimate: with nothing running one session may start.
      if (running.length === 0) return paceCheck({ sample, now, budget, running: [], next: estimate(role) });
      return paceCheck({ sample, now, budget, running: runningNow(), next: estimate(role) });
    },
    started(role) {
      running.push({ role, startedAt: now });
    },
    fits(ceiling) {
      return sessionsThatFit({ sample, now, budget, running: runningNow(), next: estimate("implement") }, ceiling);
    },
  };
}

/** How many things wait for a person (decision 132): Items parked for one here or read as such from another machine, Items with decisions to look at, drafts. */
export function waitingForPerson(store: Store, items: readonly WorkItem[], jobs: Jobs): number {
  const open = items.filter((item) => item.state !== "done" && item.state !== "abandoned");
  return countWaiting(open.map((item) => {
    const job = jobs[refKey(item.ref)];
    return {
      asks: job ? !!job.parked && job.parked.as !== "queued" : item.needsDecision === true,
      openDecisions: (item.assumptions ?? []).filter((each) => !each.settled).length,
    };
  }), openDrafts(store).length);
}

/** The caps on new triage and new work from the configuration. */
export function waitingCaps(config: ProjectConfig): WaitingCaps {
  return { triage: config.settings.waitingCapTriage.value, work: config.settings.waitingCapWork.value };
}

/** Keeps the pacing state for the Usage tab; written only when something other than its time changed. */
export function writePacing(store: Store, state: PacingState): void {
  const { at: _at, ...rest } = state;
  const before = store.getValue(KEYS.pacing);
  if (before) {
    try {
      const { at: _was, ...old } = JSON.parse(before) as PacingState;
      if (JSON.stringify(old) === JSON.stringify(rest)) return;
    } catch {
      // Rewritten below.
    }
  }
  store.setValue(KEYS.pacing, JSON.stringify(state));
}

/** The pacing state the tick last kept, or undefined. */
export function readPacing(store: Store): PacingState | undefined {
  const text = store.getValue(KEYS.pacing);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as PacingState;
  } catch {
    return undefined;
  }
}

/** Live sessions by role, for the Usage tab. */
export function runningByRole(store: Store): Record<SessionRole, number> {
  const count: Record<SessionRole, number> = { triage: 0, implement: 0, review: 0 };
  for (const session of store.list<Session>("session")) if (isLive(session)) count[usageRole(session.role)]++;
  return count;
}
