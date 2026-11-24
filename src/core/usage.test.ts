import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageSample } from "../model/types.ts";
import { at, ref, T0 } from "./testing.ts";
import { attributeUsage, forecastLine, stackPlot, timeTicks, usageParts, usagePlot } from "./usage.ts";
import type { UsageSession } from "./usage.ts";

const t = (minutes: number) => Date.parse(at(minutes));
const reading = (minutes: number, utilization: number, resetsInMin = 300): UsageSample => ({ at: at(minutes), windows: [{ kind: "five_hour", utilization, resetsAt: at(resetsInMin) }] });
const run = (id: number, role: UsageSession["role"], from: number, to: number | undefined, tokens?: number): UsageSession => ({
  ref: ref("session", id, "scopesoup"),
  role,
  startedAt: at(from),
  ...(to === undefined ? {} : { finishedAt: at(to) }),
  ...(tokens === undefined ? {} : { tokens }),
});
const options = { from: t(0), to: t(60) };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("one session that ran the whole step gets all of it", () => {
  const result = attributeUsage([reading(0, 0.1), reading(60, 0.3)], [run(1, "implement", -10, 70)], "five_hour", options);
  near(result.shares.implement, 0.2);
  near(result.shares.outside, 0);
  near(result.methods.session, 0.2);
  assert.equal(result.sessions.implement, 1);
  near(result.total, 0.2);
});

test("overlapping sessions split by run time; a session that ran half the step gets half of its share", () => {
  // 0.4 over 60 min: 0-30 only A (0.2), 30-60 A and B together (0.2, half each).
  const result = attributeUsage([reading(0, 0), reading(60, 0.4)], [run(1, "implement", 0, 60), run(2, "review", 30, 60)], "five_hour", options);
  near(result.shares.implement, 0.3);
  near(result.shares.review, 0.1);
  near(result.methods.session, 0.2);
  near(result.methods.runtime, 0.2);
  near(result.methods.tokens, 0);
});

test("overlapping sessions with token counts split by tokens per run time", () => {
  // Same run time, 3 to 1 in tokens.
  const result = attributeUsage([reading(0, 0), reading(60, 0.4)], [run(1, "implement", 0, 60, 3000), run(2, "review", 0, 60, 1000)], "five_hour", options);
  near(result.shares.implement, 0.3);
  near(result.shares.review, 0.1);
  near(result.methods.tokens, 0.4);
  // One without a count: back to run time.
  const mixed = attributeUsage([reading(0, 0), reading(60, 0.4)], [run(1, "implement", 0, 60, 3000), run(2, "review", 0, 60)], "five_hour", options);
  near(mixed.shares.review, 0.2);
  near(mixed.methods.runtime, 0.4);
});

test("idle gaps and steps with no session count as outside Scope Soup", () => {
  const result = attributeUsage([reading(0, 0.5), reading(30, 0.6), reading(60, 0.7)], [run(1, "triage", 40, 50)], "five_hour", options);
  // Step 0-30 (0.1): nobody. Step 30-60 (0.1): the session ran 10 of 30 minutes.
  near(result.shares.triage, 0.1 / 3);
  near(result.shares.outside, 0.1 + (0.1 * 2) / 3);
  near(result.total, 0.2);
});

test("a reset in the middle: what is read after it counts from the reset, and a falling number is not negative use", () => {
  // Window resets at minute 30. Before: 0.8 to 0.9 in 0-20. After: reads 0.2 at minute 50.
  const samples = [reading(0, 0.8, 30), reading(20, 0.9, 30), reading(50, 0.2, 330)];
  const result = attributeUsage(samples, [run(1, "implement", 35, 50)], "five_hour", options);
  assert.equal(result.resets, 1);
  // A reset before the span is not one of the span's.
  assert.equal(attributeUsage(samples, [], "five_hour", { from: t(35), to: t(60) }).resets, 0);
  near(result.shares.implement, 0.2 * (15 / 20));
  near(result.shares.outside, 0.1 + 0.2 * (5 / 20));
  near(result.total, 0.3);
});

test("only the part of a step inside the span counts, and an unfinished session runs to the end", () => {
  const result = attributeUsage([reading(-60, 0), reading(60, 0.4)], [run(1, "review", 20, undefined)], "five_hour", options);
  // 0.4 over 120 min; the span has the last 60 min of it (0.2), the session ran 20-60 of 0-60.
  near(result.total, 0.2);
  near(result.shares.review, 0.2 * (40 / 60));
  near(result.shares.outside, 0.2 * (20 / 60));
});

test("no readings, or readings without the window, give nothing", () => {
  const none = attributeUsage([], [run(1, "implement", 0, 60)], "seven_day", options);
  assert.equal(none.total, 0);
  assert.equal(attributeUsage([reading(0, 0.1), reading(60, 0.2)], [], "seven_day", options).readings, 0);
  assert.equal(T0.length > 0, true);
});

test("a stored session of the removed check-review role counts as review, not as an unknown role", () => {
  const old = run(1, "check-review" as UsageSession["role"], -10, 70);
  const result = attributeUsage([reading(0, 0.1), reading(60, 0.3)], [old], "five_hour", options);
  near(result.shares.review, 0.2);
  assert.equal(result.sessions.review, 1);
  assert.equal("check-review" in result.shares, false);
  near(result.total, 0.2);
});

const plot = (samples: UsageSample[], sessions: UsageSession[], steps = 6, from = t(0), to = t(60)) => usagePlot(samples, sessions, "five_hour", { from, to, steps });
const sum = (parts: Record<string, number | undefined>) => Object.values(parts).reduce<number>((x, y) => x + (y ?? 0), 0);

test("the plot rises with the readings, split the same way as the shares, and holds after the last reading", () => {
  // 0.1 at the start was used before anything was read; then 0.3 more in 0-30, a triage session ran 10-20.
  const result = plot([reading(0, 0.1), reading(30, 0.4)], [run(1, "triage", 10, 20)]);
  assert.equal(result.firstAt, at(0));
  assert.deepEqual(result.points.map((point) => point.at), [0, 10, 20, 30, 40, 50, 60].map((minutes) => at(minutes)));
  assert.deepEqual(result.points[0]!.parts, { earlier: 0.1 });
  assert.deepEqual(result.points[2]!.parts, { earlier: 0.1, outside: 0.1, triage: 0.1 });
  assert.deepEqual(result.points[3]!.parts, { earlier: 0.1, outside: 0.2, triage: 0.1 });
  assert.deepEqual(result.points[6]!.parts, result.points[3]!.parts);
  const shares = attributeUsage([reading(0, 0.1), reading(30, 0.4)], [run(1, "triage", 10, 20)], "five_hour", options).shares;
  near(result.points[6]!.parts.triage!, shares.triage);
});

test("the plot drops to empty at a reset, with the full level and the empty one at the reset's time", () => {
  const result = plot([reading(0, 0.5, 30), reading(20, 0.7, 30), reading(40, 0.2, 330)], []);
  assert.deepEqual(result.resets, [at(30)]);
  const atReset = result.points.filter((point) => point.at === at(30));
  // The step at minute 30 falls on the reset: full, empty, then the step's own (empty) point.
  assert.ok(atReset.length >= 2);
  near(sum(atReset[0]!.parts), 0.7);
  assert.deepEqual(atReset[1]!.parts, {});
  // After the reset only what was used since counts: 0.2 by minute 40, nothing of before.
  const forty = result.points.find((point) => point.at === at(40))!;
  assert.deepEqual(forty.parts, { outside: 0.2 });
});

test("the plot starts at the first reading inside the span, and empties at the last reading's reset when it passed", () => {
  const late = plot([reading(30, 0.2, 45), reading(40, 0.3, 45)], [], 3);
  assert.equal(late.points[0]!.at, at(30));
  assert.deepEqual(late.resets, [at(45)]);
  assert.deepEqual(late.points.at(-1)!.parts, {});
  assert.deepEqual(plot([], []), { points: [], resets: [] });
});

test("the forecast line runs from now to full and on to the reset, or to the level expected at the reset", () => {
  const now = t(0);
  assert.deepEqual(forecastLine(now, 0.6, t(120), { outcome: "used_up", at: at(60) }), [
    { at: at(0), value: 0.6 },
    { at: at(60), value: 1 },
    { at: at(120), value: 1 },
  ]);
  assert.deepEqual(forecastLine(now, 0.3, t(120), { outcome: "lasts", atReset: 0.5 }), [
    { at: at(0), value: 0.3 },
    { at: at(120), value: 0.5 },
  ]);
  assert.deepEqual(forecastLine(now, 0.3, t(120), undefined), []);
  assert.deepEqual(forecastLine(now, 0.3, t(-5), { outcome: "lasts", atReset: 0.5 }), []);
});

test("time ticks fall on whole local hours or midnights, at a step that keeps the labels apart", () => {
  const utc = () => 0;
  const day = Date.parse("2026-11-20T00:00:00.000Z");
  const hours = timeTicks(day + 30 * 60_000, day + 5.5 * 3600_000, 10, utc);
  assert.deepEqual(hours.map((tick) => tick.label), ["01:00", "02:00", "03:00", "04:00", "05:00"]);
  // A day with room for 8 labels: every 3 hours; the midnight says its day.
  assert.deepEqual(timeTicks(day, day + 24 * 3600_000 - 1, 8, utc).map((tick) => tick.label), ["Fri 20", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"]);
  // Local time two hours ahead of UTC: the ticks are on its hours.
  const ahead = timeTicks(day, day + 3 * 3600_000, 10, () => 2 * 3600_000);
  assert.deepEqual(ahead.map((tick) => [tick.at - day, tick.label]), [[0, "02:00"], [3600_000, "03:00"], [7200_000, "04:00"], [10_800_000, "05:00"]]);
  // A week by days with weekday names (2026-11-20 is a Friday), 30 days by dates at a wider step.
  assert.deepEqual(timeTicks(day, day + 3 * 24 * 3600_000 - 1, 4, utc).map((tick) => tick.label), ["Fri 20", "Sat 21", "Sun 22"]);
  const month = timeTicks(day - 30 * 24 * 3600_000, day, 8, utc);
  assert.ok(month.length <= 8 && month.length >= 4, `${month.length} labels`);
  assert.match(month[0]!.label, /^\d{1,2} (Oct|Nov)$/);
});

test("the plot's parts stack bottom to top in the order given, and a part never used gets no band", () => {
  const points = [
    { at: at(0), parts: { implement: 0.2 } },
    { at: at(10), parts: { implement: 0.3, outside: 0.1 } },
  ];
  assert.deepEqual(stackPlot(points, ["implement", "review", "outside"]), [
    { key: "implement", lo: [0, 0], hi: [0.2, 0.3] },
    { key: "outside", lo: [0.2, 0.3], hi: [0.2, 0.4] },
  ]);
});

test("usageParts: over several windows the shares are of all use and sum to 100, with the windows' worth", () => {
  const shares = { implement: 4.66, review: 2.0, triage: 1.01, outside: 0.5 };
  const parts = usageParts({ total: 8.17, resets: 7, shares }, ["implement", "review", "triage", "outside"]);
  assert.equal(parts.several, true);
  assert.equal(parts.windows, 8);
  assert.deepEqual(parts.percents, { implement: 57, review: 25, triage: 12, outside: 6 });
  assert.equal(Object.values(parts.percents).reduce((sum, each) => sum + each, 0), 100);
  // Thirds do not round to 100 by themselves: the largest remainders take the spare points.
  const thirds = usageParts({ total: 3, resets: 2, shares: { implement: 1, review: 1, triage: 1, outside: 0 } }, ["implement", "review", "triage"]);
  assert.deepEqual(thirds.percents, { implement: 34, review: 33, triage: 33 });
});

test("usageParts: one window keeps its own shares; a small total is still one window's worth", () => {
  const one = usageParts({ total: 0.4, resets: 0, shares: { implement: 0.4, review: 0, triage: 0, outside: 0 } }, ["implement"]);
  assert.equal(one.several, false);
  assert.deepEqual(one.percents, {});
  assert.equal(one.windows, 1);
  assert.equal(usageParts({ total: 0, resets: 1, shares: { implement: 0, review: 0, triage: 0, outside: 0 } }, ["implement"]).several, false);
});
