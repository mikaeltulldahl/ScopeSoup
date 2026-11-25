import assert from "node:assert/strict";
import { test } from "node:test";
import { allowanceCheck, allowanceLimit, allowancePeriod, allowanceUse } from "./allowanceBudget.ts";

const WORDS = { label: "Acme", unit: "credits", setting: "acme.monthly" };
const utc = (text: string) => Date.parse(text);

test("the period runs from the last reset day to the next, in UTC", () => {
  assert.deepEqual(allowancePeriod(utc("2026-11-25T10:00:00Z"), 1), { start: utc("2026-11-01T00:00:00Z"), end: utc("2026-12-01T00:00:00Z") });
  assert.deepEqual(allowancePeriod(utc("2026-11-10T10:00:00Z"), 15), { start: utc("2026-10-15T00:00:00Z"), end: utc("2026-11-15T00:00:00Z") });
  assert.deepEqual(allowancePeriod(utc("2026-11-15T00:00:00Z"), 15), { start: utc("2026-11-15T00:00:00Z"), end: utc("2026-12-15T00:00:00Z") });
});

test("the period crosses a year, and the reset day is kept from 1 to 28", () => {
  assert.deepEqual(allowancePeriod(utc("2027-01-05T00:00:00Z"), 20), { start: utc("2026-12-20T00:00:00Z"), end: utc("2027-01-20T00:00:00Z") });
  assert.deepEqual(allowancePeriod(utc("2026-12-31T00:00:00Z"), 31), { start: utc("2026-12-28T00:00:00Z"), end: utc("2027-01-28T00:00:00Z") });
  assert.deepEqual(allowancePeriod(utc("2026-12-31T00:00:00Z"), 0), { start: utc("2026-12-01T00:00:00Z"), end: utc("2027-01-01T00:00:00Z") });
});

test("use adds up the sessions that started in the period, by role", () => {
  const period = allowancePeriod(utc("2026-11-25T00:00:00Z"), 1);
  const use = allowanceUse(
    [
      { role: "triage", startedAt: "2026-11-02T08:00:00Z", used: 1 },
      { role: "implement", startedAt: "2026-11-20T08:00:00Z", used: 3 },
      { role: "fix", startedAt: "2026-11-21T08:00:00Z", used: 2 },
      { role: "review", startedAt: "2026-11-22T08:00:00Z" },
      { role: "implement", startedAt: "2026-10-31T23:59:00Z", used: 50 },
      { role: "implement", startedAt: "2026-12-01T00:00:00Z", used: 50 },
    ],
    period,
  );
  assert.equal(use.used, 6);
  assert.equal(use.sessions, 4);
  assert.deepEqual(use.byRole.implement, { used: 5, sessions: 2 });
  assert.deepEqual(use.byRole.triage, { used: 1, sessions: 1 });
  assert.deepEqual(use.byRole.review, { used: 0, sessions: 1 });
});

test("no session starts once the use reaches the allowance minus the reserve", () => {
  const period = allowancePeriod(utc("2026-11-25T00:00:00Z"), 1);
  assert.equal(allowanceLimit(300, 0.2), 240);
  assert.equal(allowanceCheck({ ...WORDS, allowance: 300, used: 239, reserve: 0.2, period }).allow, true);
  const stop = allowanceCheck({ ...WORDS, allowance: 300, used: 240, reserve: 0.2, period });
  assert.equal(stop.allow, false);
  assert.equal(stop.resumeAt, "2026-12-01T00:00:00.000Z");
  assert.match(stop.reason, /240 of 300/);
  assert.equal(allowanceCheck({ ...WORDS, allowance: 300, used: 0, reserve: 0, period }).allow, true);
  assert.equal(allowanceCheck({ ...WORDS, allowance: 300, used: 300, reserve: 0, period }).allow, false);
});

test("without an allowance nothing is paced", () => {
  const period = allowancePeriod(utc("2026-11-25T00:00:00Z"), 1);
  const open = allowanceCheck({ ...WORDS, used: 9999, reserve: 0.2, period });
  assert.equal(open.allow, true);
  assert.match(open.reason, /acme.monthly/);
});
