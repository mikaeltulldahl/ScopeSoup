import assert from "node:assert/strict";
import { test } from "node:test";
import type { SharingReport } from "../hosts/metaBranch/writer.ts";
import { nextShareState } from "./shareState.ts";

const report = (state: SharingReport["state"], waiting = 0, problem?: string): SharingReport => ({
  at: "x", state, pushes: 0, refusedPushes: 0, replayed: 0, waiting, conflicts: [], renamed: [], locks: [], ...(problem ? { problem } : {}),
});

test("sharing state: a failure keeps the last good time and the waiting count, a good round clears it, singleplayer has none", () => {
  const ok = nextShareState(undefined, report("shared"), "2026-11-26T10:00:00.000Z");
  assert.deepEqual(ok, { lastOkAt: "2026-11-26T10:00:00.000Z" });
  const bad = nextShareState(ok, report("pending", 2, "no route to host"), "2026-11-26T10:01:00.000Z");
  assert.deepEqual(bad, { lastOkAt: "2026-11-26T10:00:00.000Z", failed: { at: "2026-11-26T10:01:00.000Z", reason: "no route to host", waiting: 2 } });
  assert.deepEqual(nextShareState(bad, report("shared"), "2026-11-26T10:03:00.000Z"), { lastOkAt: "2026-11-26T10:03:00.000Z" });
  assert.equal(nextShareState(bad, report("local"), "2026-11-26T10:04:00.000Z"), undefined);
});
