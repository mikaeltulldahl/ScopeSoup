import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createKeepAwake, shouldStayAwake, startWindowsHold } from "./keepAwake.ts";
import type { AwakeInput, Hold } from "./keepAwake.ts";
import { realProcesses } from "./process.ts";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";

const windowsOnly = { skip: process.platform !== "win32" && "Windows only" };
const idle: AwakeInput = { enabled: true, level: 2, paused: false, running: 0, queued: 0, waitingForTime: false };

test("awake while a session runs, work is queued, or something waits for a time; not when idle", () => {
  assert.equal(shouldStayAwake(idle), false);
  assert.equal(shouldStayAwake({ ...idle, running: 1 }), true);
  assert.equal(shouldStayAwake({ ...idle, queued: 2 }), true);
  assert.equal(shouldStayAwake({ ...idle, waitingForTime: true }), true);
});

test("the setting and level 0 win over work; paused agents keep it awake only while a session finishes", () => {
  const busy = { ...idle, running: 2, queued: 1, waitingForTime: true };
  assert.equal(shouldStayAwake(busy), true);
  assert.equal(shouldStayAwake({ ...busy, enabled: false }), false);
  assert.equal(shouldStayAwake({ ...busy, level: 0 }), false);
  assert.equal(shouldStayAwake({ ...busy, paused: true }), true, "Pause agents lets running sessions finish");
  assert.equal(shouldStayAwake({ ...busy, paused: true, running: 0 }), false, "waiting work does not keep a paused Scope Soup awake");
});

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((ok, fail) => ((resolve = ok), (reject = fail)));
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeHold(ready: Promise<void> = Promise.resolve()) {
  const log: string[] = [];
  let end: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => (end = resolve));
  const hold: Hold = {
    ready,
    ended,
    async release() {
      log.push("release");
      end();
    },
  };
  return { hold, log, die: () => end() };
}

test("the controller starts one hold, keeps it while awake is asked for, and releases it when not", async () => {
  const started: ReturnType<typeof fakeHold>[] = [];
  const changes: boolean[] = [];
  const awake = createKeepAwake({ platform: "win32", start: () => (started.push(fakeHold()), started.at(-1)!.hold), onChange: (holding) => changes.push(holding) });
  awake.set(true);
  awake.set(true);
  assert.equal(started.length, 1);
  assert.equal(awake.holding, true);
  await tick();
  awake.set(false);
  assert.equal(awake.holding, false);
  awake.set(false);
  await awake.stop();
  assert.deepEqual(started[0]?.log, ["release"]);
  assert.deepEqual(changes, [true, false]);
});

test("onChange(true) comes when the hold is in force, and a hold released before that is never announced", async () => {
  const changes: boolean[] = [];
  const first = deferred();
  const holds = [fakeHold(first.promise), fakeHold()];
  let next = 0;
  const awake = createKeepAwake({ platform: "win32", start: () => holds[next++]!.hold, onChange: (holding) => changes.push(holding) });
  awake.set(true);
  await tick();
  assert.equal(awake.holding, true);
  assert.deepEqual(changes, []);
  awake.set(false);
  first.resolve();
  await tick();
  assert.deepEqual(changes, []);
  awake.set(true);
  await tick();
  assert.deepEqual(changes, [true]);
  await awake.stop();
  assert.deepEqual(changes, [true, false]);
});

test("a hold released while it was starting, and then failing, does not block the next one or report", async () => {
  const problems: string[] = [];
  const late = deferred();
  const holds = [fakeHold(late.promise), fakeHold()];
  let next = 0;
  const awake = createKeepAwake({ platform: "win32", start: () => holds[next++]!.hold, onProblem: (message) => problems.push(message) });
  awake.set(true);
  awake.set(false);
  late.reject(new Error("killed while starting"));
  await tick();
  awake.set(true);
  assert.equal(next, 2);
  assert.deepEqual(problems, []);
  await awake.stop();
});

test("stop releases a live hold and later requests are ignored", async () => {
  const one = fakeHold();
  let starts = 0;
  const awake = createKeepAwake({ platform: "win32", start: () => (starts++, one.hold) });
  awake.set(true);
  await awake.stop();
  assert.deepEqual(one.log, ["release"]);
  awake.set(true);
  assert.equal(starts, 1);
});

test("a hold that dies by itself is made again at the next request", async () => {
  const holds: ReturnType<typeof fakeHold>[] = [];
  const awake = createKeepAwake({ platform: "win32", start: () => (holds.push(fakeHold()), holds.at(-1)!.hold) });
  awake.set(true);
  holds[0]?.die();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(awake.holding, false);
  awake.set(true);
  assert.equal(holds.length, 2);
  await awake.stop();
});

test("a hold that cannot be made is reported once, not at every request", async () => {
  const problems: string[] = [];
  let starts = 0;
  const failing = (): Hold => {
    starts++;
    const ended = Promise.resolve();
    return { ready: Promise.reject(new Error("no powershell")), ended, release: async () => undefined };
  };
  const awake = createKeepAwake({ platform: "win32", start: failing, onProblem: (message) => problems.push(message) });
  awake.set(true);
  await new Promise((resolve) => setImmediate(resolve));
  awake.set(true);
  await new Promise((resolve) => setImmediate(resolve));
  awake.set(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(problems, ["no powershell"]);
  // Not started again at every request either, only after there was nothing to do in between.
  assert.equal(starts, 1);
  awake.set(false);
  awake.set(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);
  assert.deepEqual(problems, ["no powershell", "no powershell"]);
  await awake.stop();
});

test("a hold that never takes the request is ended after the start timeout and reported once", async () => {
  const problems: string[] = [];
  const awake = createKeepAwake({
    platform: "win32",
    start: () => startWindowsHold({ powershell: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], startTimeoutMs: 300, killTree: (pid) => realProcesses.killTree(pid) }),
    onProblem: (message) => problems.push(message),
  });
  awake.set(true);
  assert.equal(awake.holding, true);
  await until(() => !awake.holding, "the stuck hold to be ended");
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /did not take the request within/);
  awake.set(true);
  assert.equal(awake.holding, false);
  await awake.stop();
});

test("off Windows nothing is ever started", async () => {
  let starts = 0;
  const awake = createKeepAwake({ platform: "linux", start: () => (starts++, fakeHold().hold) });
  awake.set(true);
  assert.equal(awake.holding, false);
  await awake.stop();
  assert.equal(starts, 0);
});

async function until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** `powercfg /requests` lists what is keeping the system awake; null when it cannot be read (it may need elevation). */
function powerRequests(): string | null {
  try {
    const text = execFileSyncRetrying("powercfg", ["/requests"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return /SYSTEM:/i.test(text) ? text : null;
  } catch {
    return null;
  }
}

test("the real Windows hold: requested, visible to powercfg when readable, gone after release", windowsOnly, async (t) => {
  const hold = startWindowsHold({ killTree: (pid) => realProcesses.killTree(pid) });
  try {
    try {
      await hold.ready;
    } catch (error) {
      t.skip(`powershell cannot hold the request on this machine: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const pid = hold.pid ?? 0;
    assert.equal(realProcesses.isAlive(pid), true);
    const requests = powerRequests();
    if (requests === null) t.diagnostic("powercfg /requests could not be read here (needs elevation); the request itself was confirmed by SetThreadExecutionState succeeding");
    else {
      const system = /SYSTEM:\s*([\s\S]*?)(?:\r?\n\r?\n[A-Z]+:|$)/i.exec(requests)?.[1] ?? "";
      t.diagnostic(`powercfg SYSTEM section: ${system.trim().replace(/\s+/g, " ")}`);
    }
    await hold.release();
    await until(() => !realProcesses.isAlive(pid), "the holder to be gone");
  } finally {
    await hold.release();
  }
});

test("the real Windows hold ends by itself when its parent dies without releasing it", windowsOnly, async (t) => {
  const parent = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./fixtures/hold-and-wait.ts", import.meta.url))], {
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  let out = "";
  parent.stdout.setEncoding("utf8");
  parent.stdout.on("data", (chunk: string) => (out += chunk));
  try {
    await until(() => /holder \d+|failed/.test(out), "the helper to take the hold");
    if (/failed/.test(out)) {
      t.skip(`powershell cannot hold the request on this machine: ${out.trim()}`);
      return;
    }
    assert.match(out, /holder \d+/);
    const holder = Number(/holder (\d+)/.exec(out)?.[1]);
    assert.equal(realProcesses.isAlive(holder), true);
    // Kill the helper alone, with no tree kill: only the pipe to the holder tells it to end.
    process.kill(parent.pid ?? 0);
    await until(() => !realProcesses.isAlive(holder), "the holder to end after its parent died");
  } finally {
    try {
      process.kill(parent.pid ?? 0);
    } catch {
      // Already gone.
    }
  }
});
