import assert from "node:assert/strict";
import { test } from "node:test";
import { countWaiting, waitingCapWait } from "./waitingCaps.ts";

test("countWaiting: an Item with an ask or decisions to look at counts once, and each draft counts", () => {
  assert.equal(countWaiting([], 0), 0);
  assert.equal(countWaiting([{ asks: true, openDecisions: 2 }, { asks: false, openDecisions: 1 }, { asks: false, openDecisions: 0 }], 3), 5);
});

test("waitingCapWait: new triage stops at its cap, new work at its own; under them nothing waits", () => {
  const caps = { triage: 2, work: 5 };
  assert.equal(waitingCapWait("triage", 1, caps), null);
  assert.equal(waitingCapWait("triage", 2, caps), "new triage waits: 2 things wait for you (it starts below 2)");
  assert.equal(waitingCapWait("work", 4, caps), null);
  assert.equal(waitingCapWait("work", 6, caps), "new work waits: 6 things wait for you (it starts below 5)");
  assert.equal(waitingCapWait("work", 1, { triage: 1, work: 1 }), "new work waits: 1 thing waits for you (it starts below 1)");
});
