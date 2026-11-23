import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageSample, UsageWindow } from "../model/types.ts";
import type { UsageCheckInput } from "./usageCheck.ts";
import { decide, resetAfterRejection } from "./usageCheck.ts";

// The week runs from Monday 00:00 to the next Monday 00:00; "now" is Thursday 12:00, half-way.
const NOW = "2026-06-04T12:00:00.000Z";
const WEEK_RESET = "2026-06-08T00:00:00.000Z";
const FIVE_RESET = "2026-06-04T14:00:00.000Z";

function five(utilization?: number, resetsAt = FIVE_RESET): UsageWindow {
  return { kind: "five_hour", utilization, resetsAt };
}
function week(utilization?: number, resetsAt = WEEK_RESET): UsageWindow {
  return { kind: "seven_day", utilization, resetsAt };
}
function sample(windows: UsageWindow[], extra: Partial<UsageSample> = {}): UsageSample {
  return { at: NOW, windows, status: "allowed", ...extra };
}
function input(over: Partial<UsageCheckInput>): UsageCheckInput {
  return { sample: null, now: NOW, reserve: { five_hour: 0.2, seven_day: 0.2 }, runningSessions: 0, ...over };
}

interface Row {
  name: string;
  in: Partial<UsageCheckInput>;
  allow: boolean;
  resumeAt?: string;
  reason: RegExp;
  stopRunning?: boolean;
}

const rows: Row[] = [
  { name: "no sample, nothing running: probe", in: {}, allow: true, reason: /No usage reading yet; starting one session/ },
  { name: "no sample, one running: wait for it", in: { runningSessions: 1 }, allow: false, reason: /waiting for a reading/ },
  { name: "well within both windows", in: { sample: sample([five(0.1), week(0.3)]) }, allow: true, reason: /Within budget/ },
  {
    name: "5-hour window at the reserve line",
    in: { sample: sample([five(0.8), week(0.1)]) },
    allow: false, resumeAt: FIVE_RESET, reason: /5-hour window is at 80 %.*limit.*80 %/,
  },
  {
    name: "week over the reserve line",
    in: { sample: sample([five(0.1), week(0.85)]) },
    allow: false, resumeAt: WEEK_RESET, reason: /weekly window is at 85 %/,
  },
  // No pacing: a week used early is within budget while it is under the reserve line.
  { name: "half the week gone, 60 % used", in: { sample: sample([five(0.1), week(0.6)]) }, allow: true, reason: /Within budget/ },
  {
    name: "no reserve: only a full window stops",
    in: { sample: sample([five(0.99), week(0.5)]), reserve: { five_hour: 0, seven_day: 0 } },
    allow: true, reason: /Within budget/,
  },
  { name: "allowed with no figures, nothing running: probe", in: { sample: sample([five(), week()]) }, allow: true, reason: /gave no figure.*starting one session/ },
  { name: "allowed with no figures, one running: no more", in: { sample: sample([five(), week()]), runningSessions: 1 }, allow: false, reason: /gave no figure/ },
  {
    name: "one figure missing, the known one is fine: still a probe only",
    in: { sample: sample([five(0.1), week()]), runningSessions: 2 }, allow: false, reason: /no figure for the weekly window/,
  },
  {
    name: "one figure missing, the known one is over: wait for its reset",
    in: { sample: sample([five(0.9), week()]) }, allow: false, resumeAt: FIVE_RESET, reason: /5-hour window is at 90 %/,
  },
  {
    name: "warning without a figure: wait for the nearest reset",
    in: { sample: sample([five()], { status: "allowed_warning" }) }, allow: false, resumeAt: FIVE_RESET, reason: /warned that a limit is near/,
  },
  {
    name: "rejected with a full 5-hour window",
    in: { sample: sample([five(1), week(0.5)], { status: "rejected" }) }, allow: false, resumeAt: FIVE_RESET, reason: /limit is hit/,
  },
  {
    name: "rejected with a full week",
    in: { sample: sample([five(0.4), week(1)], { status: "rejected" }) }, allow: false, resumeAt: WEEK_RESET, reason: /limit is hit/,
  },
  {
    name: "rejected without figures: the nearest reset, then probe",
    in: { sample: sample([five(), week()], { status: "rejected" }) }, allow: false, resumeAt: FIVE_RESET, reason: /limit is hit/,
  },
  {
    name: "rejected, but the reset has passed: probe, no deadlock",
    in: { sample: sample([five(1, "2026-06-04T11:00:00.000Z")], { status: "rejected" }) }, allow: true, reason: /has reset; starting one session/,
  },
  {
    name: "every window has reset since the reading",
    in: { sample: sample([five(0.9, "2026-06-04T11:00:00.000Z"), week(0.9, "2026-06-04T11:30:00.000Z")]) }, allow: true, reason: /has reset/,
  },
  {
    name: "a reset 5-hour window is ignored, the week still counts",
    in: { sample: sample([five(0.95, "2026-06-04T11:00:00.000Z"), week(0.9)]) }, allow: false, resumeAt: WEEK_RESET, reason: /weekly window/,
  },
  { name: "a reading with no window at all: probe", in: { sample: sample([]) }, allow: true, reason: /named no window/ },
  {
    name: "paid extra usage: stop everything, no resume time",
    in: { sample: sample([five(0.1), week(0.1)], { usingOverage: true }), runningSessions: 2 },
    allow: false, reason: /Paid extra usage/, stopRunning: true,
  },
];

for (const row of rows) {
  test(`usageCheck: ${row.name}`, () => {
    const decision = decide(input(row.in));
    assert.equal(decision.allow, row.allow, decision.reason);
    assert.equal(decision.resumeAt, row.resumeAt);
    assert.match(decision.reason, row.reason);
    assert.equal(decision.stopRunning, row.stopRunning);
  });
}

test("resetAfterRejection is undefined once every reset has passed", () => {
  assert.equal(resetAfterRejection(sample([five(1, "2026-06-04T11:00:00.000Z")]), NOW), undefined);
  assert.equal(resetAfterRejection(sample([five(1), week(1)]), NOW), WEEK_RESET);
});
