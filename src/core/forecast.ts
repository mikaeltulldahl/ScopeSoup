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
