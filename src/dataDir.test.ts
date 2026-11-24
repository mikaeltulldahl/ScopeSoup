// Where `scopesoup start` keeps its data (src/dataDir.ts), with a real temporary git repository for the working-tree check.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { execFileSyncRetrying } from "./hosts/spawnRetry.ts";
import { startDataDir, workingTreeOf } from "./dataDir.ts";

const none = (): null => null;

test("without SCOPESOUP_DATA the data folder is `data` beside the config file, as `scopesoup open` has it", () => {
  const config = join(resolve("/somewhere"), "soup", "scopesoup.config.json");
  assert.deepEqual(startDataDir({}, config, none), { ok: true, dir: join(resolve("/somewhere"), "soup", "data") });
  assert.deepEqual(startDataDir({ SCOPESOUP_DATA: "  " }, config, none), { ok: true, dir: join(resolve("/somewhere"), "soup", "data") });
  assert.deepEqual(startDataDir({ SCOPESOUP_DATA: resolve("/elsewhere") }, config, none), { ok: true, dir: resolve("/elsewhere") });
  // No config found: the old default.
  assert.deepEqual(startDataDir({}, null, none), { ok: true, dir: resolve("data") });
});

test("a data folder inside a git working tree is refused, one outside is not", () => {
  const root = mkdtempSync(join(tmpdir(), "scopesoup-datadir-"));
  try {
    const clone = join(root, "clone");
    mkdirSync(clone);
    execFileSyncRetrying("git", ["init", "--quiet", "-b", "main", clone], { windowsHide: true });
    const outside = join(root, "config");
    mkdirSync(outside);
    const refused = startDataDir({}, join(clone, "scopesoup.config.json"));
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /is inside the git working tree .*SCOPESOUP_DATA/s);
    assert.equal(startDataDir({ SCOPESOUP_DATA: join(clone, "deeper", "data") }, null).ok, false);
    assert.deepEqual(startDataDir({}, join(outside, "scopesoup.config.json")), { ok: true, dir: join(outside, "data") });
    assert.notEqual(workingTreeOf(join(clone, "x")), null);
    assert.equal(workingTreeOf(join(outside, "data")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
