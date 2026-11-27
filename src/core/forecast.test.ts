import assert from "node:assert/strict";
import { test } from "node:test";
import { forecastWindow } from "./forecast.ts";
import type { ForecastLoad } from "./forecast.ts";
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
