import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSyncRetrying, isSpawnRefused, retrySpawn, retrySpawnSync, spawnSyncRetrying } from "./spawnRetry.ts";

/** An error like the one Node gives when Windows refuses to create the process. */
function refused(syscall = "spawn git", code = "EPERM", pid?: number): NodeJS.ErrnoException & { pid?: number } {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall, errno: -4048, ...(pid === undefined ? {} : { pid }) });
}

const fast = { delaysMs: [1, 1, 1, 1] };

test("only a refused start counts as one: EPERM or EACCES from the spawn call, with no pid", () => {
  assert.equal(isSpawnRefused(refused("spawn")), true);
  assert.equal(isSpawnRefused(refused("spawn git")), true);
  assert.equal(isSpawnRefused(refused("spawn git", "EACCES")), true);
  assert.equal(isSpawnRefused(refused("spawnSync git", "EPERM", 0)), true);
  assert.equal(isSpawnRefused(refused("spawn git", "EPERM", 1234)), false, "it started");
  assert.equal(isSpawnRefused(refused("write")), false, "an EPERM after the start");
  assert.equal(isSpawnRefused(refused("kill")), false);
  assert.equal(isSpawnRefused(refused("spawn git", "ENOENT")), false);
  assert.equal(isSpawnRefused(Object.assign(new Error("exit 1"), { code: 1 })), false);
  assert.equal(isSpawnRefused(null), false);
});

test("a fake spawn refused twice with pid 0, then started, gives one successful call and one log line", async () => {
  const lines: string[] = [];
  let tries = 0;
  const result = await retrySpawn("git status", async () => {
    tries++;
    if (tries <= 2) throw refused("spawnSync git", "EPERM", 0);
    return { code: 0, pid: 4321 };
  }, { ...fast, log: (line) => lines.push(line) });
  assert.deepEqual(result, { code: 0, pid: 4321 });
  assert.equal(tries, 3);
  assert.deepEqual(lines, ["git status: Windows refused to start the process 2 times (EPERM); it started on try 3"]);
});

test("a process that started and exited non-zero is not tried again", async () => {
  let tries = 0;
  const lines: string[] = [];
  const result = await retrySpawn("git", async () => {
    tries++;
    return { code: 128, pid: 99 };
  }, { ...fast, log: (line) => lines.push(line) });
  assert.deepEqual(result, { code: 128, pid: 99 });
  assert.equal(tries, 1);
  assert.deepEqual(lines, []);
  // The same when the failure of a started process arrives as an error (execFile's way).
  tries = 0;
  await assert.rejects(retrySpawn("git", async () => {
    tries++;
    throw Object.assign(new Error("Command failed"), { code: 1, pid: 99 });
  }, fast), /Command failed/);
  assert.equal(tries, 1);
});

test("an EPERM after the process started is not tried again", async () => {
  for (const error of [refused("spawn git", "EPERM", 4321), refused("write")]) {
    let tries = 0;
    await assert.rejects(retrySpawn("git", async () => {
      tries++;
      throw error;
    }, fast), (thrown) => thrown === error);
    assert.equal(tries, 1);
  }
});

test("a start refused every time is given up after the last wait, with one log line", async () => {
  let tries = 0;
  const lines: string[] = [];
  const error = refused();
  await assert.rejects(retrySpawn("git", async () => {
    tries++;
    throw error;
  }, { ...fast, log: (line) => lines.push(line) }), (thrown) => thrown === error);
  assert.equal(tries, 5);
  assert.deepEqual(lines, ["git: Windows refused to start the process 5 times (EPERM); gave up"]);
});

test("the synchronous form retries the same way and nothing else", () => {
  let tries = 0;
  const lines: string[] = [];
  assert.equal(retrySpawnSync("node", () => {
    tries++;
    if (tries === 1) throw refused("spawn");
    return "started";
  }, { ...fast, log: (line) => lines.push(line) }), "started");
  assert.equal(tries, 2);
  assert.deepEqual(lines, ["node: Windows refused to start the process once (EPERM); it started on try 2"]);

  tries = 0;
  assert.throws(() => retrySpawnSync("node", () => {
    tries++;
    throw refused("spawn", "EPERM", 7);
  }, fast), /EPERM/);
  assert.equal(tries, 1);
});

test("the drop-in forms behave like execFileSync and spawnSync", () => {
  assert.equal(execFileSyncRetrying(process.execPath, ["-e", "process.stdout.write('hi')"], { encoding: "utf8" }), "hi");
  assert.throws(() => execFileSyncRetrying(process.execPath, ["-e", "process.exit(3)"], { stdio: "pipe" }), (error: { status?: number }) => error.status === 3);
  const result = spawnSyncRetrying(process.execPath, ["-e", "process.exit(2)"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.error, undefined);
});
