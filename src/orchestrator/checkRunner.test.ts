// The check command as a process, as the merge queue runs it: passed, failed, timed out, stopped, or not started.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createCheckRunner } from "./checkRunner.ts";
import { realProcesses } from "./process.ts";

const dir = mkdtempSync(join(tmpdir(), "scopesoup-check-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

/** Exits 0, or 1 when the folder has `broken.txt`. */
const CHECK = [process.execPath, "-e", "const fs = require('fs'); if (fs.existsSync('broken.txt')) { console.log('boom: broken.txt is there'); process.exit(1); } console.log('all good');"];
const SLEEP = [process.execPath, "-e", "setTimeout(() => {}, 60000)"];
const run = createCheckRunner(realProcesses);

describe("check runner", { concurrency: 4 }, () => {
  test("a passing check passes, with the end of its output", async () => {
    const result = await run(CHECK, dir, 60_000, () => false);
    assert.equal(result.outcome, "passed");
    assert.equal(result.code, 0);
    assert.match(result.tail, /all good/);
  });

  test("a failing check fails with its exit code and output", async () => {
    const broken = mkdtempSync(join(dir, "broken-"));
    writeFileSync(join(broken, "broken.txt"), "x");
    const result = await run(CHECK, broken, 60_000, () => false);
    assert.equal(result.outcome, "failed");
    assert.equal(result.code, 1);
    assert.match(result.tail, /boom/);
  });

  test("a check that runs past its time limit is ended", async () => {
    const result = await run(SLEEP, dir, 500, () => false);
    assert.equal(result.outcome, "timed-out");
  });

  test("Stop ends a running check well before its own time", async () => {
    const started = Date.now();
    let on = false;
    setTimeout(() => (on = true), 300);
    const result = await run(SLEEP, dir, 60_000, () => on);
    assert.equal(result.outcome, "stopped");
    assert.ok(Date.now() - started < 20_000);
  });

  test("a check command that cannot be started is not started, not a failed check", async () => {
    const result = await run([join(dir, "no-such-program")], dir, 60_000, () => false);
    assert.equal(result.outcome, "not-started");
    assert.match(result.tail, /no-such-program/);
  });
});
