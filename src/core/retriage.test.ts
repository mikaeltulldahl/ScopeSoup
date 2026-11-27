import assert from "node:assert/strict";
import { test } from "node:test";
import { pastFloor, retriageBudget, staleness, stalest } from "./retriage.ts";

const E = { five_hour: 0.05, seven_day: 0.01 };
const times = (n: number) => ({ five_hour: n * E.five_hour, seven_day: n * E.seven_day });

test("the share: one more triage again fits only while, with it, it is at most the share of all use in each window", () => {
  // 5 %: with none taken yet, all other use must be 19 triages' worth.
  assert.equal(retriageBudget({ share: 0.05, retriage: times(0), all: times(18), next: E }).allow, false);
  assert.equal(retriageBudget({ share: 0.05, retriage: times(0), all: times(19), next: E }).allow, true);
  // One taken: 39 more triages' worth before the second.
  assert.equal(retriageBudget({ share: 0.05, retriage: times(1), all: times(38), next: E }).allow, false);
  const room = retriageBudget({ share: 0.05, retriage: times(1), all: times(39), next: E });
  assert.equal(room.allow, true);
  assert.match(room.reason, /used 3 % of what Scope Soup used in the last week; its share is 5 %: one more fits/);
  const off = retriageBudget({ share: 0, retriage: times(0), all: times(1000), next: E });
  assert.deepEqual([off.allow, off.reason], [false, "triage again on Scope Soup's own choice is off (its share is 0 %)"]);
});

test("staleness: no input, none (age alone is no input); input weighted by age; the stalest wins, ties to the first", () => {
  const at = "2026-11-18T10:00:00.000Z";
  assert.equal(staleness({ commits: 0, others: 0 }, at, "2027-11-18T10:00:00.000Z"), 0);
  assert.equal(staleness({ commits: 2, others: 1 }, at, "2026-11-20T10:00:00.000Z"), 9);
  assert.equal(stalest([{ staleness: 0 }]), undefined);
  const a = { staleness: 3, id: "a" };
  assert.equal(stalest([{ staleness: 1, id: "x" }, a, { staleness: 3, id: "b" }]), a);
  assert.equal(pastFloor(at, "2026-11-19T09:59:59.000Z"), false);
  assert.equal(pastFloor(at, "2026-11-19T10:00:00.000Z"), true);
});
