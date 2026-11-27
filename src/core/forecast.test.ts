import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ESTIMATE, estimateSession, forecastWindow, paceCheck, paceLevel, sessionsThatFit } from "./forecast.ts";
import type { ForecastLoad, PaceInput, SessionEstimate } from "./forecast.ts";
import type { UsageSample, UsageWindowKind } from "../model/types.ts";

const now = new Date("2026-11-19T12:00:00");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const sample = (minutes: number, utilization: number, resetsInMin: number, kind: UsageWindowKind = "five_hour"): UsageSample => ({
  at: at(minutes),
  windows: [{ kind, utilization, resetsAt: at(resetsInMin) }],
});

test("a steady rate gives the time the window is used up", () => {
  // 0.2 per hour from 0.4 now: full in 3 h, the reset is in 4 h.
  const forecast = forecastWindow([sample(-60, 0.2, 240), sample(0, 0.4, 240)], "five_hour", now);
  assert.equal(forecast?.outcome, "used_up");
  assert.equal(forecast?.at, at(180));
  assert.equal(forecast?.words, "used up about 15:00");
});

test("a rate that will not reach 100 % before the reset lasts to the reset", () => {
  const forecast = forecastWindow([sample(-60, 0.2, 60), sample(0, 0.3, 60)], "five_hour", now);
  // 0.1 per hour from 0.3, one hour to the reset: about 0.4 then.
  assert.equal(forecast?.outcome, "lasts");
  assert.equal(forecast?.words, "lasts to the reset");
  assert.ok(Math.abs((forecast?.atReset ?? 0) - 0.4) < 1e-9);
});

test("no use lasts to the reset", () => {
  const flat = forecastWindow([sample(-60, 0.3, 120), sample(0, 0.3, 120)], "five_hour", now);
  assert.deepEqual([flat?.outcome, flat?.atReset], ["lasts", 0.3]);
});

test("too few readings give no forecast", () => {
  assert.equal(forecastWindow([], "five_hour", now), null);
  assert.equal(forecastWindow([sample(0, 0.3, 120)], "five_hour", now), null);
  // Two readings a minute apart say nothing about a rate.
  assert.equal(forecastWindow([sample(-1, 0.3, 120), sample(0, 0.31, 120)], "five_hour", now), null);
  // Readings older than the lookback do not count.
  assert.equal(forecastWindow([sample(-300, 0.1, 120), sample(-200, 0.2, 120)], "five_hour", now), null);
  // The other window's readings do not count.
  assert.equal(forecastWindow([sample(-60, 0.2, 240, "seven_day"), sample(0, 0.4, 240, "seven_day")], "five_hour", now), null);
});

test("readings from before a reset are left out", () => {
  const forecast = forecastWindow([sample(-50, 0.9, 10), sample(-30, 0.05, 280), sample(0, 0.06, 280)], "five_hour", now);
  assert.equal(forecast?.outcome, "lasts");
});

test("the weekly window uses the last day", () => {
  const day = 24 * 60;
  const forecast = forecastWindow([sample(-day, 0.1, 3 * day, "seven_day"), sample(0, 0.3, 3 * day, "seven_day")], "seven_day", now);
  // 0.2 per day: full in 4 days, after the reset in 3 days.
  assert.equal(forecast?.outcome, "lasts");
  const heavy = forecastWindow([sample(-day, 0.1, 3 * day, "seven_day"), sample(0, 0.6, 3 * day, "seven_day")], "seven_day", now);
  assert.equal(heavy?.outcome, "used_up");
  assert.match(heavy?.words ?? "", /^used up about \w{3} \d\d:\d\d$/);
});

test("a small drop without a reset is a wobble: the readings before it still count", () => {
  // 0.2 an hour, with one reading 0.001 low on the way.
  const forecast = forecastWindow([sample(-60, 0.2, 240), sample(-30, 0.3, 240), sample(-20, 0.299, 240), sample(0, 0.4, 240)], "five_hour", now);
  assert.equal(forecast?.at, at(180));
});

// --- Paused or idle ---

// 0.2 used in the last hour.
const history = [sample(-60, 0.2, 240), sample(0, 0.4, 240)];
const load = (over: Partial<ForecastLoad>): ForecastLoad => ({ paused: false, workReady: true, ...over });

test("with work ready the rate is the one the readings show, whatever is planned", () => {
  assert.equal(forecastWindow(history, "five_hour", now, load({}))?.at, at(180));
});

test("paused or idle lasts to the reset", () => {
  // Nothing more is used: the window stays at its last reading.
  const lasts = { outcome: "lasts", words: "lasts to the reset", atReset: 0.4 };
  assert.deepEqual(forecastWindow(history, "five_hour", now, load({ paused: true })), lasts);
  assert.deepEqual(forecastWindow(history, "five_hour", now, load({ workReady: false })), lasts);
});

test("a week of readings: the weekly forecast continues the rate of the last day", () => {
  // Hourly readings since the reset 6 days ago: slow for 5 days (0.01 a day), then 0.12 a day; the reset is in a day.
  const day = 24 * 60;
  const readings: UsageSample[] = [];
  for (let minutes = -6 * day; minutes <= 0; minutes += 60) {
    const level = minutes <= -day ? 0.01 * ((minutes + 6 * day) / day) : 0.05 + 0.12 * ((minutes + day) / day);
    readings.push(sample(minutes, Math.round(level * 1000) / 1000, day, "seven_day"));
  }
  const forecast = forecastWindow(readings, "seven_day", now, load({ paused: false }));
  // 0.17 now, 0.12 more by the reset.
  assert.equal(forecast?.outcome, "lasts");
  assert.ok(Math.abs((forecast?.atReset ?? 0) - 0.29) < 0.002, String(forecast?.atReset));
});

// --- Pacing (decision 133) ---

const MIN = 60_000;
const nowMs = now.getTime();
/** A reading now: the 5-hour window resets in 2 h (3 h of 5 gone), the week in 3.5 days (half gone). */
const reading = (five: number, week: number): UsageSample => ({
  at: at(0),
  windows: [{ kind: "five_hour", utilization: five, resetsAt: at(120) }, { kind: "seven_day", utilization: week, resetsAt: at(3.5 * 24 * 60) }],
});
const est = (five: number, week: number, minutes = 20): SessionEstimate => ({ use: { five_hour: five, seven_day: week }, durationMs: minutes * MIN, from: 5 });
const pace = (over: Partial<PaceInput>): PaceInput => ({ sample: reading(0.2, 0.2), now: nowMs, budget: { five_hour: 0.8, seven_day: 0.8 }, running: [{ estimate: est(0.05, 0.01), startedAt: nowMs - 30 * MIN }], next: est(0.05, 0.01), ...over });

test("paceLevel: 0 at the window's start, the budget at its reset, a straight line between, and held there", () => {
  const reset = nowMs + 2 * 3600_000;
  assert.equal(paceLevel(0.8, reset, "five_hour", reset - 5 * 3600_000), 0);
  assert.ok(Math.abs(paceLevel(0.8, reset, "five_hour", nowMs) - 0.48) < 1e-9);
  assert.equal(paceLevel(0.8, reset, "five_hour", reset + 3600_000), 0.8);
  // Above 100 % it paces faster than the window lasts.
  assert.ok(Math.abs(paceLevel(1.5, reset, "five_hour", nowMs) - 0.9) < 1e-9);
});

test("paceCheck: under the pace line by the session's end one more starts; over it, it waits and names the stricter window", () => {
  // 5-hour line by 20 min from now: 0.8 * 200/300 = 0.533; week: 0.8 * (84 h + 20 min) / 168 h = 0.4016.
  assert.equal(paceCheck(pace({})).allow, true);
  const week = paceCheck(pace({ sample: reading(0.2, 0.394) }));
  assert.equal(week.allow, false);
  assert.equal(week.window, "seven_day");
  assert.match(week.reason, /^the weekly window is at 39 %; one more session would put it at about 40 % by 12:20, over its pace line \(40 % then\)$/);
  // Both over: the one furthest over decides.
  assert.equal(paceCheck(pace({ sample: reading(0.6, 0.394) })).window, "five_hour");
  // A higher budget raises the line: the same use fits.
  assert.equal(paceCheck(pace({ sample: reading(0.2, 0.394), budget: { five_hour: 0.8, seven_day: 1 } })).allow, true);
});

test("paceCheck: what the running sessions have not shown in the reading yet counts, and a session just started counts in full", () => {
  // 5-hour: 0.45 + one more 0.05 = 0.50 under 0.533; a session started just now adds its 0.05 and goes over.
  assert.equal(paceCheck(pace({ sample: reading(0.45, 0.1) })).allow, true);
  assert.equal(paceCheck(pace({ sample: reading(0.45, 0.1), running: [{ estimate: est(0.05, 0.01), startedAt: nowMs }] })).allow, false);
  // Half of a 20-minute session's run is ahead of the reading: half its use.
  assert.equal(paceCheck(pace({ sample: reading(0.455, 0.1), running: [{ estimate: est(0.05, 0.01), startedAt: nowMs - 10 * MIN }] })).allow, true);
  assert.equal(paceCheck(pace({ sample: reading(0.46, 0.1), running: [{ estimate: est(0.05, 0.01), startedAt: nowMs - 10 * MIN }] })).allow, false);
});

test("paceCheck with nothing running (the kick): only at or under the pace line now, or in a fresh window", () => {
  // Line now: 5-hour 48 %, week 40 %.
  assert.equal(paceCheck(pace({ sample: reading(0.48, 0.4), running: [] })).allow, true);
  const over = paceCheck(pace({ sample: reading(0.5, 0.1), running: [] }));
  assert.equal(over.allow, false);
  assert.match(over.reason, /^the 5-hour window is at 50 %, over its pace line \(48 % now\)/);
  // Just reset: the line is near 0, but a window that has had about one session's worth (the default guess) is fresh.
  const fresh: UsageSample = { at: at(0), windows: [{ kind: "five_hour", utilization: 0.05, resetsAt: at(299) }, { kind: "seven_day", utilization: 0.01, resetsAt: at(7 * 24 * 60 - 1) }] };
  assert.equal(paceCheck(pace({ sample: fresh, running: [] })).allow, true);
  const used: UsageSample = { at: at(0), windows: [{ kind: "five_hour", utilization: 0.06, resetsAt: at(299) }] };
  assert.equal(paceCheck(pace({ sample: used, running: [] })).allow, false);
});

test("paceCheck without a live reading (none, or every window's reset passed): only the one session that gets a reading", () => {
  const passed: UsageSample = { at: at(-300), windows: [{ kind: "five_hour", utilization: 0.9, resetsAt: at(-10) }] };
  assert.equal(paceCheck(pace({ sample: passed, running: [] })).allow, true);
  assert.equal(paceCheck(pace({ sample: passed })).allow, false);
  assert.equal(paceCheck(pace({ sample: null, running: [] })).allow, true);
  assert.equal(paceCheck(pace({ sample: null })).allow, false);
});

test("paceCheck: a session that would end after the reset is held to the line at the reset", () => {
  // The 5-hour window resets in 2 h; a 3-hour session is held to the budget, 0.8.
  assert.equal(paceCheck(pace({ sample: reading(0.7, 0.1), next: est(0.05, 0.001, 180), running: [{ estimate: est(0.05, 0.001), startedAt: nowMs - 60 * MIN }] })).allow, true);
  assert.equal(paceCheck(pace({ sample: reading(0.78, 0.1), next: est(0.05, 0.001, 180), running: [{ estimate: est(0.05, 0.001), startedAt: nowMs - 60 * MIN }] })).allow, false);
});

test("sessionsThatFit: as many at once as the pace allows, at most the ceiling", () => {
  // 5-hour: 0.2 + n * 0.05 <= 0.533 gives 6 more beside the running one; the ceiling holds it at 4.
  assert.deepEqual(sessionsThatFit(pace({}), 4), { count: 4, reason: "the ceiling is 4 sessions" });
  const tight = sessionsThatFit(pace({ sample: reading(0.42, 0.1) }), 8);
  assert.equal(tight.count, 3);
  assert.match(tight.reason, /5-hour window/);
  // Over the line already: the running ones, no more.
  assert.equal(sessionsThatFit(pace({ sample: reading(0.6, 0.1) }), 8).count, 1);
  // Nothing runs: the kick lets one only under the line now (48 %), and none above it.
  assert.equal(sessionsThatFit(pace({ sample: reading(0.45, 0.1), running: [] }), 8).count, 1);
  assert.equal(sessionsThatFit(pace({ sample: reading(0.6, 0.1), running: [] }), 8).count, 0);
});

test("estimateSession: the median of the role's newest sessions per window, the default until there are three, the run time held to the timeout", () => {
  const past = (minutes: number, five?: number, week?: number, endsAgo = 0) => ({ startedAt: nowMs - (endsAgo + minutes) * MIN, finishedAt: nowMs - endsAgo * MIN, use: { ...(five === undefined ? {} : { five_hour: five }), ...(week === undefined ? {} : { seven_day: week }) } });
  assert.deepEqual(estimateSession([], 60 * MIN), DEFAULT_ESTIMATE);
  const two = estimateSession([past(10, 0.1), past(30, 0.2)], 60 * MIN);
  assert.deepEqual([two.use, two.durationMs, two.from], [DEFAULT_ESTIMATE.use, DEFAULT_ESTIMATE.durationMs, 0]);
  const three = estimateSession([past(10, 0.1, 0.02), past(30, 0.3), past(50, 0.2, 0.04), past(200, undefined, 0.03)], 60 * MIN);
  assert.deepEqual(three.use, { five_hour: 0.2, seven_day: 0.03 });
  // Coarse readings show no rise for most sessions: a median of 0 is held at the default, so a burst cannot start.
  assert.deepEqual(estimateSession([past(10, 0, 0), past(10, 0, 0), past(10, 0.2, 0)], 60 * MIN).use, DEFAULT_ESTIMATE.use);
  assert.equal(three.from, 3);
  // Run times 10, 30, 50, 200 minutes: median 40, under the 60-minute timeout; held to a 30-minute one.
  assert.equal(three.durationMs, 40 * MIN);
  assert.equal(estimateSession([past(10, 0.1), past(30, 0.3), past(50, 0.2), past(200)], 30 * MIN).durationMs, 30 * MIN);
  // Only the newest ten count.
  const many = [...Array.from({ length: 10 }, (_, i) => past(10, 0.07, undefined, i)), ...Array.from({ length: 5 }, (_, i) => past(10, 0.9, undefined, 100 + i))];
  assert.equal(estimateSession(many, 60 * MIN).use.five_hour, 0.07);
});
