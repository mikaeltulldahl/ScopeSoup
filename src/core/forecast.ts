// Where a usage window is heading. Pure: the readings and the time come in as arguments.
// Per account from the start: pass one account's readings (today there is one account).

import type { UsageSample, UsageWindowKind } from "../model/types.ts";

/** How far back the rate is taken from: the last hour (5-hour window) or the last day (weekly). */
export const FORECAST_LOOKBACK_MS: Record<UsageWindowKind, number> = {
  five_hour: 3600_000,
  seven_day: 24 * 3600_000,
};

/** The readings must span at least this share of the lookback, or the rate is noise. */
const MIN_SPAN_SHARE = 0.1;

export interface UsageForecast {
  /** "used_up": at the recent rate the window is full before the reset. "lasts": it is not. */
  outcome: "used_up" | "lasts";
  /** When the window would be used up; only for "used_up". */
  at?: string;
  /** "used up about 21:40" or "lasts to the reset". */
  words: string;
  /** For "lasts": how full the window is expected to be at the reset (0 to 1). */
  atReset?: number;
}

/** What is planned: while paused or idle Scope Soup starts nothing, so the forecast expects no more use. */
export interface ForecastLoad {
  paused: boolean;
  /** Whether work is ready, or sessions run. False means idle. */
  workReady: boolean;
}

/** One window's level at a time, and when that window resets (NaN when not reported). */
export interface WindowReading {
  at: number;
  utilization: number;
  resetsAt: number;
}

/**
 * Whether the window started over between two of its readings: the earlier reading's reset time has passed, or a later one is
 * reported. A drop without that is the reported level wobbling, not a reset. The plot (`usagePlot`) and the forecast use the same rule.
 */
export function resetBetween(before: WindowReading, now: WindowReading): boolean {
  if (Number.isNaN(before.resetsAt)) return false;
  return before.resetsAt <= now.at || (!Number.isNaN(now.resetsAt) && now.resetsAt > before.resetsAt);
}

function clock(then: Date, now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const time = `${two(then.getHours())}:${two(then.getMinutes())}`;
  if (then.toDateString() === now.toDateString()) return time;
  return `${then.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
}

/**
 * The forecast for one window, or null when there are too few readings or the newest reading's reset has passed.
 * `samples` are one account's readings in any order. The rate is the one the readings show over the lookback, since the window's
 * last reset: the slope the Usage plot draws. With `load`, paused or idle expects no more use.
 */
export function forecastWindow(samples: readonly UsageSample[], kind: UsageWindowKind, now: Date, load?: ForecastLoad): UsageForecast | null {
  const lookback = FORECAST_LOOKBACK_MS[kind];
  const nowMs = now.getTime();
  let readings: WindowReading[] = samples
    .flatMap((sample) => {
      const window = sample.windows.find((each) => each.kind === kind);
      const at = Date.parse(sample.at);
      if (!window || window.utilization === undefined || Number.isNaN(at) || at > nowMs) return [];
      return [{ at, utilization: window.utilization, resetsAt: Date.parse(window.resetsAt) }];
    })
    .sort((a, b) => a.at - b.at);
  // Only readings since the last reset belong to this window.
  for (let i = readings.length - 1; i > 0; i--) {
    if (resetBetween(readings[i - 1]!, readings[i]!)) {
      readings = readings.slice(i);
      break;
    }
  }
  readings = readings.filter((reading) => reading.at >= nowMs - lookback);
  const first = readings[0];
  const last = readings[readings.length - 1];
  if (!first || !last || readings.length < 2 || Number.isNaN(last.resetsAt)) return null;
  const span = last.at - first.at;
  if (span < lookback * MIN_SPAN_SHARE) return null;
  if (last.resetsAt <= nowMs) return null;

  let rate = Math.max(0, last.utilization - first.utilization) / span; // share per ms
  if (load && (load.paused || !load.workReady)) rate = 0;
  if (last.utilization >= 1) return { outcome: "used_up", at: new Date(last.at).toISOString(), words: "used up" };
  if (rate <= 0) return { outcome: "lasts", words: "lasts to the reset", atReset: last.utilization };
  const full = last.at + (1 - last.utilization) / rate;
  if (full >= last.resetsAt) return { outcome: "lasts", words: "lasts to the reset", atReset: Math.min(1, last.utilization + rate * (last.resetsAt - last.at)) };
  const when = new Date(Math.max(full, nowMs));
  return { outcome: "used_up", at: when.toISOString(), words: `used up about ${clock(when, now)}` };
}

// --- Pacing (decision 133): a session starts only while the window's use stays at or under its pace line. ---

const PACE_WINDOW_MS: Record<UsageWindowKind, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 24 * 3600_000 };
const PACE_NAMES: Record<UsageWindowKind, string> = { five_hour: "5-hour window", seven_day: "weekly window" };

/** What one more session of a role is expected to use of each window, and for how long it runs. */
export interface SessionEstimate {
  use: Record<UsageWindowKind, number>;
  durationMs: number;
  /** How many recent sessions the use is the median of; 0 while the default stands in. */
  from: number;
}

/** Until a role has history: a guess, about a twentieth of a 5-hour window and a hundredth of the week in 20 minutes. */
export const DEFAULT_ESTIMATE: SessionEstimate = { use: { five_hour: 0.05, seven_day: 0.01 }, durationMs: 20 * 60_000, from: 0 };

/** The sessions the median is taken of: the newest this many of the role, and at least `MIN_HISTORY` of them. */
export const RECENT_SESSIONS = 10;
export const MIN_HISTORY = 3;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** One finished session of the role, with what it used of each window (as the Usage tab attributes it) when the readings cover it. */
export interface PastSession {
  startedAt: number;
  finishedAt: number;
  use: Partial<Record<UsageWindowKind, number>>;
}

/**
 * The expected session of a role: per window the median use of its newest `RECENT_SESSIONS` finished sessions that have that
 * window's use, and the median run time of its newest sessions, held to `maxMs` (no session runs longer than its timeout). Each
 * part takes the default until there are `MIN_HISTORY` sessions for it.
 */
export function estimateSession(past: readonly PastSession[], maxMs: number): SessionEstimate {
  const newest = [...past].sort((a, b) => b.finishedAt - a.finishedAt);
  const use = { ...DEFAULT_ESTIMATE.use };
  let from = 0;
  for (const kind of ["five_hour", "seven_day"] as const) {
    const known = newest.flatMap((each) => (each.use[kind] === undefined ? [] : [each.use[kind]!])).slice(0, RECENT_SESSIONS);
    if (known.length >= MIN_HISTORY) {
      use[kind] = median(known);
      from = Math.max(from, known.length);
    }
  }
  const runs = newest.slice(0, RECENT_SESSIONS).map((each) => Math.max(0, each.finishedAt - each.startedAt));
  const durationMs = Math.min(maxMs, runs.length >= MIN_HISTORY ? median(runs) : DEFAULT_ESTIMATE.durationMs);
  return { use, durationMs: Math.max(60_000, durationMs), from };
}

/** The pace line of a window at a time: 0 at the window's start, `budget` at its reset, a straight line between. */
export function paceLevel(budget: number, resetsAt: number, kind: UsageWindowKind, at: number): number {
  const length = PACE_WINDOW_MS[kind];
  const start = resetsAt - length;
  return (Math.max(0, budget) * Math.min(length, Math.max(0, at - start))) / length;
}

export interface PaceInput {
  /** The newest usage reading; pacing needs one (the usage check probes without it). */
  sample: UsageSample | null;
  now: number;
  /** Each window's budget, a share of its even pace (0 to 2). */
  budget: Record<UsageWindowKind, number>;
  /** The sessions running now, each with its estimate and start; their use since the reading is expected to come on top. */
  running: readonly { estimate: SessionEstimate; startedAt: number }[];
  /** The session that would start. */
  next: SessionEstimate;
}

export interface PaceDecision {
  allow: boolean;
  reason: string;
  /** The window that decided a refusal (the one furthest over its line). */
  window?: UsageWindowKind;
}

function pct(share: number): string {
  return `${Math.round(share * 100)} %`;
}

/**
 * Whether one more session may start by the pace: with it, each window's use (the reading, what the running sessions are still
 * expected to add, and the new session's expected use) stays at or under the window's pace line by the time the new session would
 * end (at most the reset). Both windows are checked; the one furthest over decides. With nothing running, one session may always
 * start (the kick: a fresh window's line starts at 0); the usage check's stop at the budget stays the limit then.
 */
export function paceCheck(input: PaceInput): PaceDecision {
  if (input.running.length === 0) return { allow: true, reason: "Nothing runs: one session may start while the windows are under their budgets." };
  const sample = input.sample;
  if (!sample) return { allow: true, reason: "No usage reading to pace by." };
  const readAt = Date.parse(sample.at);
  let worst: { kind: UsageWindowKind; over: number; expect: number; line: number; end: number; used: number } | undefined;
  const parts: string[] = [];
  for (const window of sample.windows) {
    const resetsAt = Date.parse(window.resetsAt);
    if (window.utilization === undefined || Number.isNaN(resetsAt) || resetsAt <= input.now) continue;
    const kind = window.kind;
    // What the running sessions have not shown in the reading yet: the share of each one's expected run still ahead of the reading.
    const ahead = input.running.reduce((sum, each) => sum + each.estimate.use[kind] * Math.min(1, Math.max(0, 1 - (readAt - each.startedAt) / each.estimate.durationMs)), 0);
    const end = Math.min(input.now + input.next.durationMs, resetsAt);
    const line = paceLevel(input.budget[kind], resetsAt, kind, end);
    const expect = window.utilization + ahead + input.next.use[kind];
    parts.push(`${PACE_NAMES[kind]} ${pct(expect)} of its ${pct(line)}`);
    if (expect > line && (!worst || expect - line > worst.over)) worst = { kind, over: expect - line, expect, line, end, used: window.utilization };
  }
  if (!worst) return { allow: true, reason: parts.length > 0 ? `Within the pace: with one more session ${parts.join(", ")}.` : "No window to pace by." };
  const when = clock(new Date(worst.end), new Date(input.now));
  return {
    allow: false,
    window: worst.kind,
    reason: `the ${PACE_NAMES[worst.kind]} is at ${pct(worst.used)}; one more session would put it at about ${pct(worst.expect)} by ${when}, over its pace line (${pct(worst.line)} then)`,
  };
}

/**
 * How many sessions at once the pace allows now, at most `ceiling`: the running ones, and more of `next` while each still passes
 * `paceCheck`. With the reason the count stops there.
 */
export function sessionsThatFit(input: PaceInput, ceiling: number): { count: number; reason: string } {
  const running = [...input.running];
  while (running.length < ceiling) {
    const decision = paceCheck({ ...input, running });
    if (!decision.allow) return { count: Math.max(running.length, input.running.length), reason: decision.reason };
    running.push({ estimate: input.next, startedAt: input.now });
  }
  return { count: running.length, reason: ceiling === 1 ? "the ceiling is 1 session" : `the ceiling is ${ceiling} sessions` };
}
