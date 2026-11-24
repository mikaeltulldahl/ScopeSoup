// `scopesoup open` with fakes: no server, no browser, no clock.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardUrl, openBoard, serverSpec } from "./open.ts";
import type { OpenDeps, ServerSpec } from "./open.ts";

function fixture(run: (config: string, folder: string) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "scopesoup-open-"));
  const config = join(folder, "scopesoup.config.json");
  writeFileSync(config, "{}");
  return run(config, folder).finally(() => rmSync(folder, { recursive: true, force: true }));
}

/** Fakes: the board answers from `upAfter` probes on (Infinity: never); time moves only when `sleep` is called. */
function fakes(upAfter: number) {
  const calls = { probes: 0, spawned: [] as ServerSpec[], opened: [] as string[] };
  let time = 0;
  const deps: OpenDeps = {
    probe: async () => ++calls.probes > upAfter,
    spawnServer: (spec) => void calls.spawned.push(spec),
    openBrowser: (url) => void calls.opened.push(url),
    sleep: async (ms) => void (time += ms),
    now: () => time,
  };
  return { calls, deps };
}

test("when the board answers, open only opens the browser", () => fixture(async (config, folder) => {
  const { calls, deps } = fakes(0);
  const result = await openBoard({ cwd: folder, env: { SCOPESOUP_CONFIG: config }, home: null, platform: "win32" }, deps);
  assert.deepEqual(result.ok && [result.started, result.url], [false, "http://127.0.0.1:4310"]);
  assert.equal(calls.spawned.length, 0);
  assert.deepEqual(calls.opened, ["http://127.0.0.1:4310"]);
}));

test("when the board is down, open starts Scope Soup with this config, waits for the board, then opens the browser", () => fixture(async (config, folder) => {
  const { calls, deps } = fakes(3);
  const result = await openBoard({ cwd: folder, env: { SCOPESOUP_CONFIG: config, SCOPESOUP_PORT: "4999" }, home: null, platform: "win32" }, deps);
  assert.ok(result.ok && result.started);
  assert.equal(calls.spawned.length, 1);
  const spec = calls.spawned[0]!;
  assert.equal(spec.env.SCOPESOUP_CONFIG, config);
  assert.equal(spec.env.SCOPESOUP_DATA, join(folder, "data"));
  assert.equal(spec.logFile, join(folder, "data", "scopesoup.log"));
  assert.equal(spec.cwd, folder);
  assert.deepEqual(calls.opened, ["http://127.0.0.1:4999"]);
}));

test("a board that never answers is an error naming the log, and no browser opens", () => fixture(async (config, folder) => {
  const { calls, deps } = fakes(Infinity);
  const result = await openBoard({ cwd: folder, env: { SCOPESOUP_CONFIG: config }, home: null, platform: "win32", timeoutMs: 5000 }, deps);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /did not answer on http:\/\/127\.0\.0\.1:4310 within 5 seconds\. See .*scopesoup\.log/);
  assert.equal(calls.opened.length, 0);
}));

test("with the launcher in Scope Soup's home, the server is started through it", () => fixture(async (config, folder) => {
  const home = join(folder, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "scopesoup.cmd"), "@echo off");
  const win = serverSpec({ cwd: folder, env: {}, home, platform: "win32" }, config, "log", "data");
  assert.deepEqual([win.command, win.args], ["cmd.exe", ["/d", "/c", join(home, "bin", "scopesoup.cmd"), "start"]]);
}));

test("the board's address follows SCOPESOUP_HOST and SCOPESOUP_PORT", async () => {
  assert.equal(boardUrl({}), "http://127.0.0.1:4310");
  assert.equal(boardUrl({ SCOPESOUP_HOST: "0.0.0.0", SCOPESOUP_PORT: "8080" }), "http://127.0.0.1:8080");
});
