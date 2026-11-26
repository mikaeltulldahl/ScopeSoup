// Who used the usage windows. Pure: readings, sessions and the span come in as arguments.
//
// Between two readings of one window the window rose by some share. That share is spread evenly over
// the time between the readings and handed to whoever ran in each moment:
//  - nobody ran: "outside" Scope Soup (a person's own use, or another tool);
//  - one session ran: it gets the moment ("session");
//  - several ran: split by run time ("runtime"), or, when every one of them has a token count from its
//    stream, by tokens per second of run time ("tokens"), so a chatty session counts for more.
// A reset is the reset time passing (or a later one being reported): the new window's reading is what was used since the reset.
// A small drop without one is no change.

import { refKey } from "../model/types.ts";
import type { Session, SessionRole, UsageSample, UsageWindowKind } from "../model/types.ts";
import { overlapMs } from "./forecast.ts";

export type UsageKey = SessionRole | "outside";
export type UsageMethod = "session" | "runtime" | "tokens" | "outside";

export const USAGE_ROLES: readonly SessionRole[] = ["triage", "implement", "review"];

/**
 * The role a session's use is counted under. Sessions of a role since removed count where that work went: the fix role's
 * as implement, since the implementor now fixes its own change; the checklist's "check-review" as review.
 */
export function usageRole(role: string): SessionRole {
  if (role === "fix") return "implement";
  return (USAGE_ROLES as readonly string[]).includes(role) ? (role as SessionRole) : "review";
}

export type UsageSession = Pick<Session, "ref" | "role" | "startedAt" | "finishedAt"> & {
  /** Tokens the session's stream reported in all; absent when the stream said none. */
  tokens?: number;
};

export interface UsageAttribution {
  kind: UsageWindowKind;
  /** Total share of the window used in the span (above 1 when it reset in the span). */
  total: number;
  /** Share per role, and "outside". */
  shares: Record<UsageKey, number>;
  /** Share by how it was split. */
  methods: Record<UsageMethod, number>;
  /** Sessions that took a part, per role. */
  sessions: Record<SessionRole, number>;
  /** How many resets fell in the span. */
  resets: number;
  /** Readings that were used. */
  readings: number;
}

export interface AttributeOptions {
  from: number;
  to: number;
}

function zeros<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

interface Reading {
  at: number;
  utilization: number;
  resetsAt: number;
}

/** One window's readings, oldest first. */
function readingsOf(samples: readonly UsageSample[], kind: UsageWindowKind): Reading[] {
  return samples
    .flatMap((sample) => {
      const window = sample.windows.find((each) => each.kind === kind);
      const at = Date.parse(sample.at);
      if (!window || window.utilization === undefined || Number.isNaN(at)) return [];
      return [{ at, utilization: window.utilization, resetsAt: Date.parse(window.resetsAt) }];
    })
    .sort((a, b) => a.at - b.at);
}

/** A rise of the window between two readings, or the window emptying at its reset. */
type Change = { kind: "rise"; from: number; to: number; delta: number } | { kind: "reset"; at: number };

/** What happened to one window between its readings, oldest first. After a reset, what is read counts from the reset. */
function changesOf(readings: readonly Reading[]): Change[] {
  const changes: Change[] = [];
  for (let i = 1; i < readings.length; i++) {
    const before = readings[i - 1]!;
    const now = readings[i]!;
    // A reset is the window really starting over: the earlier reading's reset time has passed, or a later one is reported.
    // A drop without that is the reported level wobbling, read as no change.
    const passed = !Number.isNaN(before.resetsAt) && before.resetsAt <= now.at;
    const moved = !Number.isNaN(before.resetsAt) && !Number.isNaN(now.resetsAt) && now.resetsAt > before.resetsAt;
    if (passed || moved) {
      // The window emptied at its reset time; what is read now was used after that.
      const resetAt = Math.min(Math.max(before.resetsAt, before.at), now.at);
      changes.push({ kind: "reset", at: resetAt });
      if (now.utilization > 0) changes.push({ kind: "rise", from: resetAt, to: now.at, delta: now.utilization });
    } else if (now.utilization > before.utilization) {
      changes.push({ kind: "rise", from: before.at, to: now.at, delta: now.utilization - before.utilization });
    }
  }
  return changes;
}

type Give = (a: number, b: number, key: UsageKey, amount: number, method: UsageMethod, session?: UsageSession) => void;

/**
 * Hands a rise of `perMs` over [lo, hi] to whoever ran, in pieces cut at the sessions' starts and ends. `end` is where a
 * session without an end is taken to have stopped, for its tokens per run time.
 */
function splitRise(lo: number, hi: number, perMs: number, sessions: readonly UsageSession[], end: number, give: Give): void {
  const active = sessions.filter((session) => overlapMs(session, lo, hi) > 0);
  const cuts = new Set<number>([lo, hi]);
  for (const session of active) {
    for (const text of [session.startedAt, session.finishedAt]) {
      const ms = text === undefined ? Number.NaN : Date.parse(text);
      if (ms > lo && ms < hi) cuts.add(ms);
    }
  }
  const edges = [...cuts].sort((a, b) => a - b);
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1]!;
    const b = edges[i]!;
    const share = (b - a) * perMs;
    const running = active.filter((session) => overlapMs(session, a, b) > 0);
    if (running.length === 0) {
      give(a, b, "outside", share, "outside");
      continue;
    }
    const useTokens = running.length > 1 && running.every((session) => (session.tokens ?? 0) > 0);
    // Tokens per ms of the session's whole run, so a session is not favoured for running long.
    const weights = running.map((session) => {
      if (!useTokens) return 1;
      const stop = session.finishedAt === undefined ? end : Date.parse(session.finishedAt);
      return session.tokens! / Math.max(1, stop - Date.parse(session.startedAt));
    });
    const sum = weights.reduce((x, y) => x + y, 0);
    const method: UsageMethod = running.length === 1 ? "session" : useTokens ? "tokens" : "runtime";
    running.forEach((session, index) => give(a, b, usageRole(session.role), (share * weights[index]!) / sum, method, session));
  }
}

export function attributeUsage(samples: readonly UsageSample[], sessions: readonly UsageSession[], kind: UsageWindowKind, options: AttributeOptions): UsageAttribution {
  const result: UsageAttribution = {
    kind,
    total: 0,
    shares: zeros<UsageKey>([...USAGE_ROLES, "outside"]),
    methods: zeros<UsageMethod>(["session", "runtime", "tokens", "outside"]),
    sessions: zeros(USAGE_ROLES),
    resets: 0,
    readings: 0,
  };
  const took = new Set<string>();
  const readings = readingsOf(samples, kind);
  result.readings = readings.length;
  for (const change of changesOf(readings)) {
    if (change.kind === "reset") {
      if (change.at > options.from && change.at <= options.to) result.resets++;
      continue;
    }
    // Only the part of the rise inside the span counts; the rise is taken as even over the step.
    const lo = Math.max(change.from, options.from);
    const hi = Math.min(change.to, options.to);
    if (hi <= lo) continue;
    const perMs = change.delta / Math.max(1, change.to - change.from);
    splitRise(lo, hi, perMs, sessions, options.to, (_a, _b, key, amount, method, session) => {
      if (session) took.add(refKey(session.ref));
      result.shares[key] += amount;
      result.methods[method] += amount;
      result.total += amount;
    });
  }
  for (const session of sessions) if (took.has(refKey(session.ref))) result.sessions[usageRole(session.role)]++;
  return result;
}

/** A plotted part: a role, "outside", or "earlier" for what the first reading already showed (used before anything was read). */
export type UsagePlotKey = UsageKey | "earlier";

export interface UsagePlotPoint {
  /** ISO time. */
  at: string;
  /** How full the window was then, per part (0 to 1); parts at 0 are left out. */
  parts: Partial<Record<UsagePlotKey, number>>;
}

export interface UsagePlot {
  /** The window's first reading, when there is one; before it nothing is known. */
  firstAt?: string;
  /** From the first reading (or the span's start) to its end, oldest first; at a reset two points share the time: full, then empty. */
  points: UsagePlotPoint[];
  /** The resets inside the span (ISO). */
  resets: string[];
}

export interface PlotOptions {
  from: number;
  to: number;
  /** How many even steps the span is sampled in; the resets come on top. */
  steps: number;
}

export const USAGE_PLOT_KEYS: readonly UsagePlotKey[] = ["earlier", ...USAGE_ROLES, "outside"];

type Level = Record<UsagePlotKey, number>;

/**
 * How full one window was over the span, split by who filled it with the same split as `attributeUsage`: since each reset,
 * each part adds up what that role used. Between readings the level rises evenly; after the last reading it holds, and it
 * empties at that reading's reset when the reset is before `to`.
 */
export function usagePlot(samples: readonly UsageSample[], sessions: readonly UsageSession[], kind: UsageWindowKind, options: PlotOptions): UsagePlot {
  const readings = readingsOf(samples, kind).filter((reading) => reading.at <= options.to);
  const first = readings[0];
  if (!first) return { points: [], resets: [] };
  // The level at every change, as running totals per part, oldest first.
  const marks: { at: number; level: Level }[] = [];
  const level = zeros(USAGE_PLOT_KEYS);
  level.earlier = first.utilization;
  marks.push({ at: first.at, level: { ...level } });
  const hold = (at: number) => {
    if (marks[marks.length - 1]!.at < at) marks.push({ at, level: { ...level } });
  };
  const resets: { at: number; before: Level }[] = [];
  const empty = (at: number) => {
    hold(at);
    resets.push({ at, before: { ...level } });
    for (const key of USAGE_PLOT_KEYS) level[key] = 0;
    marks.push({ at, level: { ...level } });
  };
  for (const change of changesOf(readings)) {
    if (change.kind === "reset") {
      empty(change.at);
      continue;
    }
    const perMs = change.delta / Math.max(1, change.to - change.from);
    splitRise(change.from, change.to, perMs, sessions, options.to, (a, b, key, amount) => {
      hold(a);
      level[key] += amount;
      const last = marks[marks.length - 1]!;
      if (last.at === b) last.level[key] = level[key];
      else marks.push({ at: b, level: { ...level } });
    });
  }
  const last = readings[readings.length - 1]!;
  if (last.utilization > 0 && last.resetsAt > last.at && last.resetsAt < options.to) empty(last.resetsAt);
  hold(options.to);

  const start = Math.max(options.from, first.at);
  const count = Math.max(1, options.steps);
  const width = (options.to - start) / count;
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  const point = (at: number, values: Level): UsagePlotPoint => {
    const parts: UsagePlotPoint["parts"] = {};
    for (const key of USAGE_PLOT_KEYS) if (round(values[key]) > 0) parts[key] = round(values[key]);
    return { at: new Date(at).toISOString(), parts };
  };
  let j = 0;
  /** The level at `at`, rising evenly between marks; at a reset's own time, the emptied level. */
  const levelAt = (at: number): Level => {
    while (j + 1 < marks.length && marks[j + 1]!.at <= at) j++;
    const a = marks[j]!;
    const b = marks[j + 1];
    if (!b || at <= a.at) return a.level;
    const share = (at - a.at) / (b.at - a.at);
    return Object.fromEntries(USAGE_PLOT_KEYS.map((key) => [key, a.level[key] + (b.level[key] - a.level[key]) * share])) as Level;
  };
  const inSpan = resets.filter((reset) => reset.at > start && reset.at < options.to);
  const points: UsagePlotPoint[] = [];
  let r = 0;
  for (let i = 0; i <= count; i++) {
    const at = i === count ? options.to : start + i * width;
    while (r < inSpan.length && inSpan[r]!.at <= at) {
      const reset = inSpan[r++]!;
      points.push(point(reset.at, reset.before), point(reset.at, zeros(USAGE_PLOT_KEYS)));
    }
    points.push(point(at, levelAt(at)));
  }
  return { firstAt: new Date(first.at).toISOString(), points, resets: inSpan.map((reset) => new Date(reset.at).toISOString()) };
}

/** A point of the forecast line: how full the window is expected to be (0 to 1) at a time (ISO). */
export interface ForecastPoint {
  at: string;
  value: number;
}

/**
 * The dashed line from now to the reset: from the level now to full at the forecast's time and full to the reset, or to the
 * level expected at the reset. Empty without a forecast or with the reset passed.
 */
export function forecastLine(
  now: number,
  utilization: number,
  resetsAt: number,
  forecast: { outcome: "used_up" | "lasts"; at?: string; atReset?: number } | undefined,
): ForecastPoint[] {
  if (!forecast || Number.isNaN(resetsAt) || resetsAt <= now) return [];
  const iso = (ms: number) => new Date(ms).toISOString();
  if (forecast.outcome === "lasts") return [{ at: iso(now), value: utilization }, { at: iso(resetsAt), value: Math.min(1, forecast.atReset ?? utilization) }];
  const full = Math.min(resetsAt, Math.max(now, forecast.at === undefined ? now : Date.parse(forecast.at)));
  const line = [{ at: iso(now), value: Math.min(1, utilization) }];
  if (full > now) line.push({ at: iso(full), value: 1 });
  if (resetsAt > full) line.push({ at: iso(resetsAt), value: 1 });
  return line;
}

export interface TimeTick {
  /** Time in ms. */
  at: number;
  label: string;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Ticks on whole local hours or local midnights, at the smallest step that gives at most `most` labels: "14:00" (a midnight
 * among hours says its day: "Mon 23"), "Mon 23" a day apart, "23 Nov" further apart. `offset(ms)` is the local time's
 * offset from UTC at that time, in ms.
 */
export function timeTicks(from: number, to: number, most: number, offset: (ms: number) => number): TimeTick[] {
  const steps = [...[1, 2, 3, 4, 6, 12].map((n) => n * HOUR), ...[1, 2, 3, 5, 7, 14].map((n) => n * DAY)];
  const ticksAt = (step: number): number[] => {
    const list: number[] = [];
    // Walk in local time from the first whole step at or after `from`; weeks start on Mondays (1970-01-05 was one).
    const anchor = step === 7 * DAY || step === 14 * DAY ? 4 * DAY : 0;
    for (let local = Math.ceil((from + offset(from) - anchor) / step) * step + anchor; ; local += step) {
      const at = local - offset(local - offset(local));
      if (at > to) break;
      if (at >= from) list.push(at);
    }
    return list;
  };
  const step = steps.find((each) => ticksAt(each).length <= Math.max(1, most)) ?? steps[steps.length - 1]!;
  const two = (n: number) => String(n).padStart(2, "0");
  return ticksAt(step).map((at) => {
    const local = new Date(at + offset(at));
    const midnight = local.getUTCHours() === 0 && local.getUTCMinutes() === 0;
    const label =
      step < DAY && !midnight
        ? `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`
        : step <= DAY
          ? `${WEEKDAYS[local.getUTCDay()]} ${local.getUTCDate()}`
          : `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}`;
    return { at, label };
  });
}

export interface StackedBand {
  key: UsagePlotKey;
  /** Per plot point, the band's bottom and top (0 to 1), stacked in the order of the keys given. */
  lo: number[];
  hi: number[];
}

/** The plot's points as bands stacked bottom to top in `keys` order; a key with nothing at any point gets no band. */
export function stackPlot(points: readonly UsagePlotPoint[], keys: readonly UsagePlotKey[]): StackedBand[] {
  const base = points.map(() => 0);
  const bands: StackedBand[] = [];
  for (const key of keys) {
    const lo = [...base];
    const hi = points.map((point, index) => base[index]! + (point.parts[key] ?? 0));
    if (hi.some((value, index) => value > lo[index]!)) bands.push({ key, lo, hi });
    hi.forEach((value, index) => (base[index] = value));
  }
  return bands;
}

export interface UsageParts {
  /** More than one window's use is in the span (it reset in it): shares are of all use, not of one window. */
  several: boolean;
  /** About how many windows' worth was used in all (at least 1 once anything was used). */
  windows: number;
  /** Per key, in the order given: its share of all use as whole percents, summing to 100 when anything was used. */
  percents: Partial<Record<UsageKey, number>>;
}

/**
 * Who used it, for a span: over several windows each key's share of all use in whole percents (largest remainder, so they sum
 * to exactly 100), and the number of windows' worth; within one window the shares stay what they are, of the window.
 */
export function usageParts(window: Pick<UsageAttribution, "total" | "resets" | "shares">, keys: readonly UsageKey[]): UsageParts {
  const several = window.resets > 0 && window.total > 0;
  const percents: Partial<Record<UsageKey, number>> = {};
  if (several) {
    const exact = keys.map((key) => (window.shares[key] / window.total) * 100);
    const floors = exact.map(Math.floor);
    let left = 100 - floors.reduce((sum, each) => sum + each, 0);
    const order = exact.map((value, index) => ({ index, rest: value - floors[index]! })).sort((a, b) => b.rest - a.rest || a.index - b.index);
    for (const { index } of order) if (left-- > 0) floors[index]!++;
    keys.forEach((key, index) => (percents[key] = floors[index]!));
  }
  return { several, windows: Math.max(1, Math.round(window.total)), percents };
}

/** How long each usage window lasts, in ms. */
export const WINDOW_MS: Record<UsageWindowKind, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY };

/**
 * The resets to mark in a plot: the ones in the plotted span and the coming one, those after `from` and up to `to`, oldest
 * first, with resets less than a minute apart counted as one.
 */
export function resetMarks(resets: readonly (string | number)[], from: number, to: number): number[] {
  const times = resets.map((reset) => (typeof reset === "number" ? reset : Date.parse(reset))).filter((ms) => !Number.isNaN(ms) && ms > from && ms <= to);
  times.sort((a, b) => a - b);
  return times.filter((ms, index) => index === 0 || ms - times[index - 1]! >= 60_000);
}

export interface PaceSegment {
  /** The window's start and its reset, in ms. */
  from: number;
  to: number;
  /** The level at the reset (0 to 1): the share Scope Soup may fill, 1 minus the reserve. */
  level: number;
}

/**
 * The pace of each window that has a reset in `resets`: a straight line from 0 at the window's start (its reset minus its
 * length) to `level` at its reset. Above the line a window is ahead of pace, below it there is room left.
 */
export function paceLines(resets: readonly number[], windowMs: number, level: number): PaceSegment[] {
  const clamped = Math.min(1, Math.max(0, level));
  return resets.map((reset) => ({ from: reset - windowMs, to: reset, level: clamped }));
}

/** A pace line's level at a time, or undefined outside its window. */
export function paceAt(segment: PaceSegment, at: number): number | undefined {
  if (at < segment.from || at > segment.to) return undefined;
  return (segment.level * (at - segment.from)) / Math.max(1, segment.to - segment.from);
}

/** A stretch of a bar, as shares of the window (0 to 1). */
export interface BarSpan {
  from: number;
  to: number;
}

export interface UsageBar {
  /** The used part split by who used it, in the order of the keys given, from 0; always ends at the (capped) level used. */
  used: (BarSpan & { key: UsagePlotKey })[];
  /** From what is used to the level expected at the reset; `warn` is the part past the reserve limit. Empty when nothing more is expected. */
  forecast: (BarSpan & { warn: boolean })[];
  /** The reserve, from the limit to the end: the part Scope Soup keeps for people. Absent without a limit or with none kept. */
  reserve?: BarSpan;
}

/**
 * The "Now" bar of a usage window as segments: the used part split by role (`parts` as the plot's last point gives them; scaled to
 * `utilization`, and what they leave out counts as "earlier"), then the forecast up to `expected` (how full it should be at the
 * reset), in warning past `limit` (1 minus the reserve), and the reserve from `limit` to the end.
 */
export function usageBar(parts: Partial<Record<UsagePlotKey, number>>, utilization: number, keys: readonly UsagePlotKey[], limit: number | undefined, expected: number | undefined): UsageBar {
  const level = Math.min(1, Math.max(0, utilization));
  const sum = keys.reduce((total, key) => total + (parts[key] ?? 0), 0);
  // Parts that add up to more than the reading are scaled down; less, the rest was used before anything was read.
  const scale = sum > level && sum > 0 ? level / sum : 1;
  const used: UsageBar["used"] = [];
  let at = 0;
  const add = (key: UsagePlotKey, width: number) => {
    if (width <= 1e-9) return;
    const to = Math.min(level, at + width);
    if (to > at) used.push({ key, from: at, to });
    at = to;
  };
  for (const key of keys) add(key, (parts[key] ?? 0) * scale);
  if (level - at > 0.005) add("earlier", level - at);
  const reach = expected === undefined ? level : Math.min(1, Math.max(level, expected));
  const forecast: UsageBar["forecast"] = [];
  if (reach - level > 1e-9) {
    const split = limit === undefined ? reach : Math.min(reach, Math.max(level, limit));
    if (split > level) forecast.push({ from: level, to: split, warn: false });
    if (reach > split) forecast.push({ from: split, to: reach, warn: true });
  }
  const bar: UsageBar = { used, forecast };
  if (limit !== undefined && limit < 1) bar.reserve = { from: Math.max(0, limit), to: 1 };
  return bar;
}

/** The share the forecast expects at the reset: 1 when the window is used up before it, else the level expected then. */
export function expectedAtReset(utilization: number, forecast: { outcome: "used_up" | "lasts"; atReset?: number } | undefined): number | undefined {
  if (!forecast) return undefined;
  return forecast.outcome === "used_up" ? 1 : Math.min(1, forecast.atReset ?? utilization);
}

/** The slider position (1-based) whose reserve is nearest to `reserve`; the lower position when two are equally near. */
export function nearestPosition(reserves: readonly number[], reserve: number): number {
  let best = 0;
  reserves.forEach((value, index) => {
    if (Math.abs(value - reserve) < Math.abs(reserves[best]! - reserve) - 1e-12) best = index;
  });
  return best + 1;
}
