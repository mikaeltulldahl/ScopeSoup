import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkConfigFile } from "./check.ts";
import { fileSettings, PRIVATE_SETTINGS, SHARED_KEYS } from "./shared.ts";

/** The shared settings beside the private file in a test, standing in for the meta ref. */
const sharedOf = (file: string): string => join(file, "..", "project.json");
/** Writes each key into its file; a key neither file knows stays in the private file, where an older format may migrate it. */
function writeBoth(file: string, raw: Record<string, unknown>): void {
  const own: Record<string, unknown> = {};
  const shared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "settings" && typeof value === "object" && value !== null) {
      const entries = Object.entries(value);
      const mine = entries.filter(([name]) => PRIVATE_SETTINGS.includes(name));
      const ours = entries.filter(([name]) => !PRIVATE_SETTINGS.includes(name));
      if (mine.length > 0) own.settings = Object.fromEntries(mine);
      if (ours.length > 0) shared.settings = Object.fromEntries(ours);
    } else if (SHARED_KEYS.includes(key)) shared[key] = value;
    else own[key] = value;
  }
  writeFileSync(file, JSON.stringify(own));
  writeFileSync(sharedOf(file), JSON.stringify(shared));
}
import { spawnSyncRetrying } from "../hosts/spawnRetry.ts";

function inTemp(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-check-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config:check: a valid file is reported valid, with the recommendations", () => {
  inTemp((dir) => {
    const file = join(dir, "scopesoup.config.json");
    writeBoth(file, ({
      project: "shop",
      machineName: "laptop-a",
      repoPath: "./clone",
      level: 3,
      roles: { review: { model: "sonnet" } },
    }));
    const result = checkConfigFile(file, undefined, fileSettings(sharedOf(file)));
    assert.equal(result.ok, true);
    const text = result.lines.join("\n");
    assert.match(text, /is valid\./);
    assert.match(text, /level 3$/m);
    assert.match(text, new RegExp(`repoPath ${join(dir, "clone").replace(/\\/g, "\\\\")}`));
    assert.match(text, /Recommendations:\n- The reviewer and the implementor both run on "sonnet"/);
  });
});

test("config:check: a valid file without advice says so", () => {
  inTemp((dir) => {
    const file = join(dir, "scopesoup.config.json");
    writeBoth(file, ({ project: "shop", machineName: "laptop-a", repoPath: "./clone" }));
    const result = checkConfigFile(file, undefined, fileSettings(sharedOf(file)));
    assert.equal(result.ok, true);
    assert.equal(result.lines.at(-1), "No recommendations.");
  });
});

test("config:check: a file naming removed rule switches is valid and prints a notice for each", () => {
  inTemp((dir) => {
    const file = join(dir, "scopesoup.config.json");
    const old = { on: true, reason: "old" };
    writeBoth(file, ({ project: "shop", machineName: "laptop-a", repoPath: "./clone", rules: { oneCoordinator: old, toolVerification: old } }));
    const result = checkConfigFile(file, undefined, fileSettings(sharedOf(file)));
    assert.equal(result.ok, true);
    const notices = result.lines.filter((line) => line.startsWith("  Notice: "));
    assert.equal(notices.length, 2);
    assert.match(notices.join("\n"), /rules\.oneCoordinator was dropped/);
    assert.match(notices.join("\n"), /rules\.toolVerification was dropped/);
  });
});

test("config:check: an invalid file lists every problem", () => {
  inTemp((dir) => {
    const file = join(dir, "scopesoup.config.json");
    writeBoth(file, ({ project: "shop", machineName: "laptop-a", repoPath: "./clone", level: 4, keepAwake: "no", mergeQueue: "push", colour: "red" }));
    const result = checkConfigFile(file, undefined, fileSettings(sharedOf(file)));
    assert.equal(result.ok, false);
    const text = result.lines.join("\n");
    // The older string mergeQueue is in the shared file, which no migration reads: refused as it stands.
    assert.match(text, /is not valid\. 4 problem\(s\):/);
    assert.match(text, /- mergeQueue must be an object/);
    assert.match(text, /- Top level: unknown key "colour"/);
    assert.match(text, /- keepAwake must be true or false/);
    assert.match(text, /- level 4 \((Autopilot)\) needs remoteUrl/);
  });
});

test("config:check: a file that is not JSON is refused", () => {
  inTemp((dir) => {
    const file = join(dir, "scopesoup.config.json");
    writeFileSync(file, "{ project: shop }");
    const result = checkConfigFile(file, undefined, fileSettings(sharedOf(file)));
    assert.equal(result.ok, false);
    assert.match(result.lines[0] ?? "", /is not valid JSON/);
  });
});

test("config:check: a missing file is refused", () => {
  inTemp((dir) => {
    const result = checkConfigFile(join(dir, "nothing.json"));
    assert.equal(result.ok, false);
    assert.match(result.lines[0] ?? "", /^Cannot read .*nothing\.json/);
  });
});

test("config:check: the command exits 0 for a valid file and 1 for a missing one", () => {
  inTemp((dir) => {
    const script = fileURLToPath(new URL("./check.ts", import.meta.url));
    const file = join(dir, "scopesoup.config.json");
    writeBoth(file, ({ project: "shop", machineName: "laptop-a", repoPath: "./clone" }));
    const run = (arg: string) => spawnSyncRetrying(process.execPath, ["--disable-warning=ExperimentalWarning", script, arg, "--shared", sharedOf(file)], { encoding: "utf8" });
    const valid = run(file);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /is valid\./);
    const missing = run(join(dir, "nothing.json"));
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /Cannot read/);
  });
});
