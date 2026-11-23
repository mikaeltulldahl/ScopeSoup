// The flaky-test counts the queue keeps for the board.

import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "../store/store.ts";
import { readQueueHealth, recordFlakyTests, shortExcerpt } from "./queueHealth.ts";

test("flaky tests are counted across runs and listed most recent first", () => {
  const store = openStore(":memory:");
  try {
    recordFlakyTests(store, "2030-01-01T00:00:00Z", ["a.test.ts", "b.test.ts", "a.test.ts"]);
    recordFlakyTests(store, "2030-01-02T00:00:00Z", ["a.test.ts"]);
    recordFlakyTests(store, "2030-01-03T00:00:00Z", ["c.test.ts"]);
    const flaky = readQueueHealth(store)?.flaky;
    assert.deepEqual(flaky?.map((f) => [f.test, f.count]), [["c.test.ts", 1], ["a.test.ts", 2], ["b.test.ts", 1]]);
  } finally {
    store.close();
  }
});

test("only the 50 most recently failed tests are kept", () => {
  const store = openStore(":memory:");
  try {
    for (let i = 0; i < 60; i++) recordFlakyTests(store, `2030-01-01T00:${String(i).padStart(2, "0")}:00Z`, [`t${i}.test.ts`]);
    const flaky = readQueueHealth(store)?.flaky ?? [];
    assert.equal(flaky.length, 50);
    assert.equal(flaky[0]?.test, "t59.test.ts");
    assert.equal(flaky.at(-1)?.test, "t10.test.ts");
  } finally {
    store.close();
  }
});

test("shortExcerpt keeps the end of a long excerpt", () => {
  assert.equal(shortExcerpt(undefined), "");
  assert.equal(shortExcerpt("  short  "), "short");
  assert.equal(shortExcerpt("x".repeat(400) + "END", 10), "...xxxxxxxEND");
});
