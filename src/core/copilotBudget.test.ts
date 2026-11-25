import assert from "node:assert/strict";
import { test } from "node:test";
import { copilotCheck, copilotLimit, copilotPeriod, copilotUse } from "./copilotBudget.ts";

const utc = (text: string) => Date.parse(text);

test("the period runs from the last reset day to the next, in UTC", () => {
  assert.deepEqual(copilotPeriod(utc("2026-11-25T10:00:00Z"), 1), { start: utc("2026-11-01T00:00:00Z"), end: utc("2026-12-01T00:00:00Z") });
  assert.deepEqual(copilotPeriod(utc("2026-11-10T10:00:00Z"), 15), { start: utc("2026-10-15T00:00:00Z"), end: utc("2026-11-15T00:00:00Z") });
  assert.deepEqual(copilotPeriod(utc("2026-11-15T00:00:00Z"), 15), { start: utc("2026-11-15T00:00:00Z"), end: utc("2026-12-15T00:00:00Z") });
});

test("the period crosses a year, and the reset day is kept from 1 to 28", () => {
  assert.deepEqual(copilotPeriod(utc("2027-01-05T00:00:00Z"), 20), { start: utc("2026-12-20T00:00:00Z"), end: utc("2027-01-20T00:00:00Z") });
  assert.deepEqual(copilotPeriod(utc("2026-12-31T00:00:00Z"), 31), { start: utc("2026-12-28T00:00:00Z"), end: utc("2027-01-28T00:00:00Z") });
  assert.deepEqual(copilotPeriod(utc("2026-12-31T00:00:00Z"), 0), { start: utc("2026-12-01T00:00:00Z"), end: utc("2027-01-01T00:00:00Z") });
});

test("use adds up the sessions that started in the period, by role", () => {
  const period = copilotPeriod(utc("2026-11-25T00:00:00Z"), 1);
  const use = copilotUse(
    [
      { role: "triage", startedAt: "2026-11-02T08:00:00Z", premiumRequests: 1, aiCredits: 0.05 },
      { role: "implement", startedAt: "2026-11-20T08:00:00Z", premiumRequests: 3 },
      { role: "fix", startedAt: "2026-11-21T08:00:00Z", premiumRequests: 2 },
      { role: "review", startedAt: "2026-11-22T08:00:00Z" },
      { role: "implement", startedAt: "2026-10-31T23:59:00Z", premiumRequests: 50 },
      { role: "implement", startedAt: "2026-12-01T00:00:00Z", premiumRequests: 50 },
    ],
    period,
  );
  assert.equal(use.requests, 6);
  assert.equal(use.credits, 0.05);
  assert.equal(use.sessions, 4);
  assert.deepEqual(use.byRole.implement, { requests: 5, sessions: 2 });
  assert.deepEqual(use.byRole.triage, { requests: 1, sessions: 1 });
  assert.deepEqual(use.byRole.review, { requests: 0, sessions: 1 });
});

test("no session starts once the use reaches the allowance minus the reserve", () => {
  const period = copilotPeriod(utc("2026-11-25T00:00:00Z"), 1);
  assert.equal(copilotLimit(300, 0.2), 240);
  assert.equal(copilotCheck({ allowance: 300, used: 239, reserve: 0.2, period }).allow, true);
  const stop = copilotCheck({ allowance: 300, used: 240, reserve: 0.2, period });
  assert.equal(stop.allow, false);
  assert.equal(stop.resumeAt, "2026-12-01T00:00:00.000Z");
  assert.match(stop.reason, /240 of 300/);
  assert.equal(copilotCheck({ allowance: 300, used: 0, reserve: 0, period }).allow, true);
  assert.equal(copilotCheck({ allowance: 300, used: 300, reserve: 0, period }).allow, false);
});

test("without an allowance nothing is paced", () => {
  const period = copilotPeriod(utc("2026-11-25T00:00:00Z"), 1);
  const open = copilotCheck({ used: 9999, reserve: 0.2, period });
  assert.equal(open.allow, true);
  assert.match(open.reason, /monthlyRequests/);
});
