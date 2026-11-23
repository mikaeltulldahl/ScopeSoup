// The real process control, on whatever platform runs the tests: a harmless tree of `node`
// processes that only sleep, started and killed through realProcesses. On Windows this runs the
// listing-and-creation-time branch (src/hosts/processTree.ts); elsewhere the process-group branch.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { realProcesses } from "./process.ts";

const TREE = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
process.stdout.write("grandchild " + grandchild.pid + "\\n");
setInterval(() => {}, 1000);
`;

const pids: number[] = [];
const dirs: string[] = [];
after(() => {
  // Tree kills, so a grandchild goes too when a test failed before its pid was read.
  for (const pid of pids) realProcesses.killTree(pid);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("killTree ends the process and the process it started, and a second call is harmless", async () => {
  const child = realProcesses.spawn(process.execPath, ["-e", TREE], { cwd: tmpdir(), env: process.env, stdin: false });
  const parent = child.pid ?? 0;
  pids.push(parent);
  let out = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (out += chunk));
  await until(() => /grandchild \d+/.test(out), "the grandchild to start");
  const grandchild = Number(/grandchild (\d+)/.exec(out)?.[1]);
  pids.push(grandchild);
  assert.equal(realProcesses.isAlive(parent), true);
  assert.equal(realProcesses.isAlive(grandchild), true);

  realProcesses.killTree(parent);

  await until(() => !realProcesses.isAlive(grandchild) && !realProcesses.isAlive(parent), "the whole tree to be gone");
  realProcesses.killTree(parent);
});

test("killTree of a process that is gone does not throw", async () => {
  const child = realProcesses.spawn(process.execPath, ["-e", "0"], { cwd: tmpdir(), env: process.env, stdin: false });
  await new Promise((resolve) => child.on("close", resolve));
  realProcesses.killTree(child.pid ?? 0);
});

test("isAlive tells this process from one that is not there, and the boot time is in the past", () => {
  assert.equal(realProcesses.isAlive(process.pid), true);
  assert.equal(realProcesses.isAlive(2 ** 22 + 12345), false);
  assert.ok(realProcesses.bootTimeMs() < Date.now());
});

test("startTimeMs of a just-started node child is close to now, and of a pid that is not there is null", async () => {
  const child = realProcesses.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: tmpdir(), env: process.env, stdin: false });
  const pid = child.pid ?? 0;
  pids.push(pid);
  const before = Date.now();
  const created = await realProcesses.startTimeMs(pid);
  assert.notEqual(created, null);
  // Seconds in ps, finer on Windows; the process was created a moment ago.
  assert.ok(Math.abs((created ?? 0) - before) < 15_000, `created ${created}, now ${before}`);
  assert.equal(await realProcesses.startTimeMs(2 ** 22 + 12345), null);
});

test("on Windows a .cmd shim is refused with a clear error instead of EINVAL", { skip: process.platform !== "win32" && "Windows only" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-shim-"));
  dirs.push(dir);
  const shim = join(dir, "claude.cmd");
  writeFileSync(shim, "@echo off\r\n");
  assert.throws(() => realProcesses.spawn(shim, [], { cwd: dir, env: process.env, stdin: false }), /shim/);
  assert.throws(() => realProcesses.spawn("claude", [], { cwd: dir, env: { Path: dir }, stdin: false, advice: { shim: "Set agent.path.", missing: "Install it." } }), /shim[\s\S]*Set agent\.path\./);
});
