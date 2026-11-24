import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyControl, pauseAtStartup, pauseRemembering, readControl, startAgain } from "./control.ts";
import { KEYS } from "./keys.ts";
import { openStore } from "./store.ts";

const AT = "2026-11-24T10:00:00.000Z";

test("the four switches are kept in the store: each reads as it was set after the store is opened again", () => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-control-"));
  try {
    const path = join(dir, "scopesoup.sqlite");
    const first = openStore(path);
    applyControl(first, "triage.start", AT, "test");
    applyControl(first, "review.start", AT, "test");
    applyControl(first, "mergeQueue.start", AT, "test");
    first.close();
    const again = openStore(path);
    assert.deepEqual(readControl(again), { triage: "started", implement: "paused", review: "started", mergeQueue: "started", agents: "started" });
    // A start-up then pauses all four, and says what each was.
    pauseAtStartup(again, AT);
    assert.deepEqual(readControl(again), { triage: "paused", implement: "paused", review: "paused", mergeQueue: "paused", agents: "paused" });
    const event = again.eventsAfter(0, 100).find((each) => each.kind === "control.startup_paused");
    assert.deepEqual({ ...(event?.data as Record<string, unknown>), reason: undefined }, { triage: "started", implement: "paused", review: "started", mergeQueue: "started", reason: undefined });
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an upgrade's pause remembers each of the four, and starting again restores exactly those, one event per switch", () => {
  const store = openStore(":memory:");
  applyControl(store, "implement.start", AT, "test");
  applyControl(store, "mergeQueue.start", AT, "test");
  const was = pauseRemembering(store, AT, "upgrade", "scopesoup");
  assert.deepEqual(was, { triage: false, implement: true, review: false, mergeQueue: true });
  assert.equal(readControl(store).agents, "paused");
  // The new version comes up paused, then starts again what ran.
  pauseAtStartup(store, AT);
  const before = store.lastSeq();
  startAgain(store, was, AT, "upgrade", "scopesoup");
  assert.deepEqual(readControl(store), { triage: "paused", implement: "started", review: "paused", mergeQueue: "started", agents: "started" });
  assert.deepEqual(store.eventsAfter(before, 10).map((event) => event.kind), ["control.implement_started", "control.merge_queue_started"]);
});

test("pausing one switch leaves the others; a pause after Stop keeps it stopped", () => {
  const store = openStore(":memory:");
  applyControl(store, "resume", AT, "test");
  applyControl(store, "review.pause", AT, "test");
  assert.deepEqual(readControl(store), { triage: "started", implement: "started", review: "paused", mergeQueue: "started", agents: "started" });
  applyControl(store, "stop", AT, "test");
  applyControl(store, "triage.pause", AT, "test");
  assert.deepEqual(readControl(store), { triage: "stopped", implement: "stopped", review: "stopped", mergeQueue: "stopped", agents: "stopped" });
  applyControl(store, "implement.start", AT, "test");
  assert.equal(readControl(store).agents, "started");
});

test("a switch that changes takes the upgrade's note off; one that does not change leaves it", () => {
  const store = openStore(":memory:");
  const note = JSON.stringify({ text: "Upgraded to 0.2.0; triage, implementors, review and the merge queue were paused before and stay paused", at: AT });
  store.setValue(KEYS.upgradeNote, note);
  applyControl(store, "review.pause", AT, "test");
  assert.equal(store.getValue(KEYS.upgradeNote), note);
  applyControl(store, "review.start", AT, "test");
  assert.equal(store.getValue(KEYS.upgradeNote), "");
});
