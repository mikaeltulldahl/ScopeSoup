import assert from "node:assert/strict";
import { test } from "node:test";
import { KEYS } from "../store/keys.ts";
import { openStore } from "../store/store.ts";
import { loadSnapshot } from "./snapshot.ts";

test("the snapshot carries the orchestrator's idle reason, and has none when it is empty", () => {
  const store = openStore(":memory:");
  assert.equal("idle" in loadSnapshot(store), false);
  store.setValue(KEYS.idle, "Nothing would be started because the queue is empty");
  assert.equal(loadSnapshot(store).idle, "Nothing would be started because the queue is empty");
  store.setValue(KEYS.idle, "");
  assert.equal("idle" in loadSnapshot(store), false);
  store.close();
});
