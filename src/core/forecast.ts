// Where a usage window is heading. Pure: the readings and the time come in as arguments.
// Per account from the start: pass one account's readings (today there is one account).

import type { Session, UsageSample, UsageWindowKind } from "../model/types.ts";

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
}

/** Fewer session-hours than this in the span, and the per-session rate is noise: use the raw rate. */
const MIN_SESSION_HOURS = 0.25;

/** What is planned, so the forecast follows the settings and not only the past rate. */
export interface ForecastLoad {
  /** Sessions that ran (started and finished times); only their overlap with the readings counts. */
  sessions: readonly Pick<Session, "startedAt" | "finishedAt">[];
  /** Sessions planned at once: maxParallelSessions. */
  planned: number;
  paused: boolean;
  /** Whether work is ready, or sessions run. False means idle. */
  workReady: boolean;
}

/** How long one session ran inside [from, to], in ms. A session without an end runs to `to`. */
export function overlapMs(session: Pick<Session, "startedAt" | "finishedAt">, from: number, to: number): number {
  const start = Date.parse(session.startedAt);
  const end = session.finishedAt === undefined ? to : Date.parse(session.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

/** Session-hours that ran between two instants. */
function sessionHours(sessions: ForecastLoad["sessions"], from: number, to: number): number {
  let total = 0;
  for (const session of sessions) total += overlapMs(session, from, to);
  return total / 3600_000;
}

function clock(then: Date, now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const time = `${two(then.getHours())}:${two(then.getMinutes())}`;
  if (then.toDateString() === now.toDateString()) return time;
  return `${then.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
}

/**
 * The forecast for one window, or null when there are too few readings.
 * `samples` are one account's readings in any order.
 * With `load`, the rate is the use per session-hour times the planned sessions (zero while paused or idle);
 * with too few session-hours, or without `load`, it is the raw rate.
 */
export function forecastWindow(samples: readonly UsageSample[], kind: UsageWindowKind, now: Date, load?: ForecastLoad): UsageForecast | null {
  const lookback = FORECAST_LOOKBACK_MS[kind];
  const nowMs = now.getTime();
  let readings = samples
    .flatMap((sample) => {
      const window = sample.windows.find((each) => each.kind === kind);
      const at = Date.parse(sample.at);
      if (!window || window.utilization === undefined || Number.isNaN(at) || at > nowMs) return [];
      return [{ at, utilization: window.utilization, resetsAt: Date.parse(window.resetsAt) }];
    })
    .sort((a, b) => a.at - b.at);
  // A reset starts a new window: only readings after the last drop belong together.
  for (let i = readings.length - 1; i > 0; i--) {
    if (readings[i]!.utilization < readings[i - 1]!.utilization) {
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

  let rate = (last.utilization - first.utilization) / span; // share per ms
  if (load) {
    const hours = sessionHours(load.sessions, first.at, last.at);
    if (hours >= MIN_SESSION_HOURS) rate = ((last.utilization - first.utilization) / hours / 3600_000) * load.planned;
    if (load.paused || !load.workReady) rate = 0;
  }
  if (last.utilization >= 1) return { outcome: "used_up", at: new Date(last.at).toISOString(), words: "used up" };
  if (rate <= 0) return { outcome: "lasts", words: "lasts to the reset" };
  const full = last.at + (1 - last.utilization) / rate;
  if (full >= last.resetsAt) return { outcome: "lasts", words: "lasts to the reset" };
  const when = new Date(Math.max(full, nowMs));
  return { outcome: "used_up", at: when.toISOString(), words: `used up about ${clock(when, now)}` };
}
