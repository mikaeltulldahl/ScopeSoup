// The board reads Scope Soup's version and the update check from `GET /api/upgrade`, and presses Look again, Get latest,
// Go back and Cancel through `POST /api/upgrade/*`. Here over the demo's made-up release: no network, no files.

import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "../store/store.ts";
import type { UpgradeView } from "../upgrade/view.ts";
import { demoUpgrader } from "./demo.ts";
import { createServer } from "./server.ts";

test("the version, the newer release, Get latest and Go back over the demo's release", async () => {
  const store = openStore(":memory:");
  const server = createServer({ store, port: 0, upgrade: demoUpgrader(() => new Date("2026-11-20T10:00:00Z"), 5) });
  const bare = createServer({ store, port: 0 });
  const { url } = await server.start();
  const other = await bare.start();
  try {
    const read = async (): Promise<UpgradeView> => (await (await fetch(`${url}/api/upgrade`)).json()) as UpgradeView;
    const post = async (what: string): Promise<Response> => fetch(`${url}/api/upgrade/${what}`, { method: "POST", headers: { Origin: url } });
    const first = await read();
    assert.match(first.version, /^\d+\.\d+\.\d+$/);
    assert.equal(first.available, false);
    const checked = (await (await post("check")).json()) as UpgradeView;
    assert.equal(checked.available, true);
    const next = checked.latest!.version;
    assert.equal((await post("get")).status, 202);
    for (let at = 0; at < 100 && (await read()).version !== next; at++) await new Promise((resolve) => setTimeout(resolve, 10));
    const upgraded = await read();
    assert.equal(upgraded.version, next);
    assert.equal(upgraded.back?.version, first.version);
    assert.equal((await post("back")).status, 202);
    for (let at = 0; at < 100 && (await read()).version !== first.version; at++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await read()).version, first.version);
    // Another origin may not press it; a server without an upgrade says so.
    assert.equal((await fetch(`${url}/api/upgrade/get`, { method: "POST", headers: { Origin: "http://evil.example" } })).status, 403);
    assert.equal((await fetch(`${other.url}/api/upgrade`)).status, 404);
  } finally {
    await server.stop();
    await bare.stop();
    store.close();
  }
});
