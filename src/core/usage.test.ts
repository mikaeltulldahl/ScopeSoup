import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageSample } from "../model/types.ts";
import { at, ref, T0 } from "./testing.ts";
import { attributeUsage } from "./usage.ts";
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
const options = { from: t(0), to: t(60), buckets: 2 };
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
  assert.equal(result.buckets.length, 2);
  near(result.buckets[0]!.parts.outside ?? 0, 0.1);
});

test("a reset in the middle: what is read after it counts from the reset, and a falling number is not negative use", () => {
  // Window resets at minute 30. Before: 0.8 to 0.9 in 0-20. After: reads 0.2 at minute 50.
  const samples = [reading(0, 0.8, 30), reading(20, 0.9, 30), reading(50, 0.2, 330)];
  const result = attributeUsage(samples, [run(1, "implement", 35, 50)], "five_hour", options);
  assert.equal(result.resets, 1);
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
