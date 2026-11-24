// The shortcut maker with a fake PowerShell: no real shortcut is written.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { manifestPath, parseManifest } from "./config/manifest.ts";
import { makeShortcuts, parseArgs, shortcutName } from "./shortcut.ts";

function fixture(run: (folder: string, home: string, configFile: string) => void): void {
  const folder = mkdtempSync(join(tmpdir(), "scopesoup-shortcut-"));
  try {
    const home = join(folder, "home");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "scopesoup.cmd"), "@echo off");
    mkdirSync(join(folder, "project"));
    mkdirSync(join(folder, "config"));
    run(folder, home, join(folder, "config", "scopesoup.config.json"));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test("a shortcut per place runs the launcher's `open` in the project, and each is recorded on the manifest", () => fixture((folder, home, configFile) => {
  let seen: Record<string, string> = {};
  const result = makeShortcuts({ project: "shop", repo: join(folder, "project"), places: ["Programs", "Desktop", "Startup"], home, platform: "win32", configFile }, (_script, env) => {
    seen = env;
    return ["C:/Menu/x.lnk", "C:/Desk/x.lnk", "C:/Start/x.lnk"].join("\r\n");
  });
  assert.ok(result.ok);
  assert.equal(seen.SS_PLACES, "Programs,Desktop,Startup");
  assert.equal(seen.SS_NAME, "Scope Soup \u2013 shop");
  assert.equal(seen.SS_TARGET, join(home, "bin", "scopesoup.cmd"));
  assert.equal(seen.SS_REPO, join(folder, "project"));
  const manifest = parseManifest(readFileSync(manifestPath(configFile), "utf8"));
  assert.deepEqual(manifest.map((entry) => entry.kind === "folder" && entry.path), ["C:/Menu/x.lnk", "C:/Desk/x.lnk", "C:/Start/x.lnk"]);
  assert.match(manifest[2]!.kind === "folder" ? manifest[2]!.what : "", /Startup folder, starts at login/);
}));

test("on another system it says so and writes nothing", () => fixture((folder, home, configFile) => {
  const result = makeShortcuts({ project: "shop", repo: join(folder, "project"), places: ["Programs"], home, platform: "linux", configFile }, () => assert.fail("must not run"));
  assert.match(result.ok ? "" : result.error, /not supported on this system yet/);
}));

test("without a launcher it asks for setup-home", () => fixture((folder, _home, configFile) => {
  const result = makeShortcuts({ project: "shop", repo: join(folder, "project"), places: ["Programs"], home: null, platform: "win32", configFile }, () => assert.fail("must not run"));
  assert.match(result.ok ? "" : result.error, /setup-home/);
}));

test("names and options", () => {
  assert.equal(shortcutName('a/b:"c"'), "Scope Soup \u2013 a b c");
  assert.deepEqual(parseArgs(["--name", "shop", "--desktop"]), { name: "shop", desktop: true, startup: false });
  assert.equal(parseArgs(["--bogus"]), null);
});
