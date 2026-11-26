import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SharingReport } from "../hosts/metaBranch/writer.ts";
import { KEYS } from "../store/keys.ts";
import { openStore } from "../store/store.ts";
import { recordShare } from "./shareState.ts";

const report = (state: SharingReport["state"], waiting = 0, problem?: string): SharingReport => ({
  at: "x", state, pushes: 0, refusedPushes: 0, replayed: 0, waiting, conflicts: [], renamed: [], locks: [], ...(problem ? { problem } : {}),
});

test("sharing is recorded: a failure keeps the last good time and the waiting count, a good round clears it, singleplayer clears all", () => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-share-"));
  try {
    const store = openStore(join(dir, "scopesoup.sqlite"));
    const read = () => JSON.parse(store.getValue(KEYS.share) || "null");
    recordShare(store, report("shared"), "2026-11-26T10:00:00.000Z");
    assert.deepEqual(read(), { lastOkAt: "2026-11-26T10:00:00.000Z" });
    recordShare(store, report("pending", 2, "no route to host"), "2026-11-26T10:01:00.000Z");
    assert.deepEqual(read(), { lastOkAt: "2026-11-26T10:00:00.000Z", failed: { at: "2026-11-26T10:01:00.000Z", reason: "no route to host", waiting: 2 } });
    recordShare(store, report("pending", 3, "no route to host"), "2026-11-26T10:02:00.000Z");
    assert.equal(read().failed.waiting, 3);
    recordShare(store, report("shared"), "2026-11-26T10:03:00.000Z");
    assert.deepEqual(read(), { lastOkAt: "2026-11-26T10:03:00.000Z" });
    recordShare(store, report("local"), "2026-11-26T10:04:00.000Z");
    assert.equal(store.getValue(KEYS.share), "");
    const kinds = store.eventsOfKinds(["share.failed", "share.recovered", "share.cleared"], 10).map((event) => event.kind).reverse();
    assert.deepEqual(kinds, ["share.failed", "share.failed", "share.recovered", "share.cleared"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
