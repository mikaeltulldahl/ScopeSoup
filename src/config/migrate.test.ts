// The configuration file's format, and the migration of older files. Fixtures in ./fixtures, one per released
// format: format-0.json is shaped like what release 0.5.0 wrote (its example file, with the machineName it asks for
// and a meta branch host); format-1.json is what migrating it gives. Synthetic values only.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { checkConfigFile } from "./check.ts";
import { editConfig } from "./edit.ts";
import { createConfigLoader } from "./loader.ts";
import { CONFIG_VERSION, migrateConfig, NEWER_CONFIG } from "./migrate.ts";
import { MACHINE_NAME_MISSING, validateConfig } from "./validate.ts";
import { fileSettings, PRIVATE_SETTINGS, SHARED_KEYS, SHARED_SETTINGS, SHARED_WHERE, validateFiles } from "./shared.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const FORMAT_0 = join(FIXTURES, "format-0.json");
const FORMAT_1 = join(FIXTURES, "format-1.json");
const read = (path: string): string => readFileSync(path, "utf8");

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 3 })));

/**
 * The fixtures are whole files, as earlier releases wrote them. The private file of today is the part of them that is not a
 * project setting (dryRun and the older string mergeQueue become the level, a project setting too); the project's part goes into a
 * shared file, read here from a plain file instead of git.
 */
type Obj = Record<string, unknown>;
function ownPart(raw: Obj): Obj {
  const own: Obj = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((SHARED_KEYS.includes(key) && key !== "settings") || key === "dryRun" || key === "mergeQueue") continue;
    if (key === "settings") own.settings = Object.fromEntries(Object.entries(value as Obj).filter(([name]) => !SHARED_SETTINGS.includes(name)));
    else own[key] = value;
  }
  return own;
}
function sharedPart(raw: Obj): Obj {
  const shared: Obj = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "settings") {
      const ours = Object.entries(value as Obj).filter(([name]) => !PRIVATE_SETTINGS.includes(name));
      if (ours.length > 0) shared.settings = Object.fromEntries(ours);
    } else if (SHARED_KEYS.includes(key)) shared[key] = value;
  }
  return shared;
}
const asText = (raw: Obj): string => JSON.stringify(raw, null, 2) + "\n";
const OLD_OWN = asText(ownPart(JSON.parse(read(FORMAT_0)) as Obj));
const NEW_OWN = asText(ownPart(JSON.parse(read(FORMAT_1)) as Obj));
const SHARED_RAW = sharedPart(JSON.parse(read(FORMAT_1)) as Obj);
const sharedDir = mkdtempSync(join(tmpdir(), "scopesoup-migrate-shared-"));
dirs.push(sharedDir);
writeFileSync(join(sharedDir, "project.json"), asText(SHARED_RAW));
const SHARED = fileSettings(join(sharedDir, "project.json"));

/** A folder of its own with `scopesoup.config.json` holding `text`. */
function place(text: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-migrate-"));
  dirs.push(dir);
  const file = join(dir, "scopesoup.config.json");
  writeFileSync(file, text);
  return { dir, file };
}

describe("the config format", { concurrency: 4 }, () => {
  test("this Scope Soup writes format 1; the fixture of the current format is that format", () => {
    assert.equal(CONFIG_VERSION, 1);
    assert.equal(JSON.parse(read(FORMAT_1)).version, CONFIG_VERSION);
    assert.equal("version" in JSON.parse(read(FORMAT_0)), false);
  });

  test("an old config migrates: the file is rewritten as format 1, a copy of the old file is kept, and the notice says what changed", () => {
    const old = OLD_OWN;
    const { dir, file } = place(old);
    const state = createConfigLoader(file, undefined, { shared: SHARED }).load();
    assert.equal(state.error, undefined);
    assert.equal(state.config?.level, 0);
    assert.equal(state.config?.settings.maxParallelSessions.value, 1);
    // The file is now exactly the format-1 fixture, and the old one is kept beside it.
    assert.deepEqual(JSON.parse(read(file)), JSON.parse(NEW_OWN));
    assert.equal(read(join(dir, "scopesoup.config.v0.json")), old);
    assert.deepEqual(readdirSync(dir).sort(), ["scopesoup.config.json", "scopesoup.config.v0.json"]);
    const notices = state.notices ?? [];
    assert.equal(notices[0], `${file} was migrated from format 0 to format 1; the old file is kept as ${join(dir, "scopesoup.config.v0.json")}.`);
    const said = notices.slice(1).join("\n");
    for (const line of [
      /^irreversibleActions was dropped: no code read it\.$/m,
      /^inviteLabel was dropped: /m,
      /^agentCheckCommand was dropped: /m,
      /^review\.checklist was dropped: /m,
      /^rules\.riskClasses was dropped: there is no approval step any more/m,
      /^rules\.claims was dropped: /m,
      /^settings\.modelStrength was dropped: the setting was removed/m,
      /^settings\.parallelSessions was merged into settings\.maxParallelSessions, which caps every session; the smaller value, 1, is kept\.$/m,
    ]) assert.match(said, line);
    // DryRun, the older mergeQueue, roles and host were project settings: they are not in the private file to migrate.
    assert.equal(notices.length, 1 + 12, said);
    // The notice is shown once: a later start finds format 1 and changes nothing.
    const again = createConfigLoader(file, undefined, { shared: SHARED }).load();
    assert.deepEqual([again.error, again.notices], [undefined, undefined]);
    assert.deepEqual(readdirSync(dir).sort(), ["scopesoup.config.json", "scopesoup.config.v0.json"]);
  });

  test("a fixture from the current format still loads, with no notice, and the file is not touched", () => {
    const text = NEW_OWN;
    const { dir, file } = place(text);
    const state = createConfigLoader(file, undefined, { shared: SHARED }).load();
    assert.deepEqual([state.error, state.notices, state.config?.project], [undefined, undefined, "example"]);
    assert.equal(read(file), text);
    assert.deepEqual(readdirSync(dir), ["scopesoup.config.json"]);
    const result = validateFiles(JSON.parse(text), SHARED_RAW, dir);
    assert.ok(result.ok);
    assert.deepEqual([result.from, result.notices], [1, []]);
  });

  test("a config with a newer version is refused with the upgrade message, and the file is not changed", async () => {
    const text = JSON.stringify({ ...JSON.parse(NEW_OWN), version: CONFIG_VERSION + 1, somethingNew: true }, null, 2) + "\n";
    const { dir, file } = place(text);
    const state = createConfigLoader(file, undefined, { shared: SHARED }).load();
    assert.equal(state.config, null);
    assert.ok(state.error?.includes(NEWER_CONFIG), state.error);
    assert.equal(NEWER_CONFIG, "this project's config is from a newer Scope Soup; upgrade Scope Soup");
    const saved = await editConfig(file, { level: 1 }, { shared: SHARED });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.match(saved.errors.join(" "), /from a newer Scope Soup; upgrade Scope Soup/);
    assert.equal(checkConfigFile(file, undefined, SHARED).ok, false);
    assert.equal(read(file), text);
    assert.deepEqual(readdirSync(dir), ["scopesoup.config.json"]);
  });

  test("a format-0 file without machineName fails to start with today's message, and is not changed until it loads", () => {
    const raw = JSON.parse(OLD_OWN) as Record<string, unknown>;
    delete raw.machineName;
    const text = JSON.stringify(raw, null, 2) + "\n";
    const { dir, file } = place(text);
    const state = createConfigLoader(file, undefined, { shared: SHARED }).load();
    assert.equal(state.config, null);
    assert.equal(state.error, `${file} with ${SHARED_WHERE}: ${MACHINE_NAME_MISSING} The file is format 0: it was not changed, and is migrated to format 1 once it loads.`);
    assert.equal(read(file), text);
    assert.deepEqual(readdirSync(dir), ["scopesoup.config.json"]);
    // The person adds the name to the old file; the next start migrates it.
    writeFileSync(file, JSON.stringify({ ...raw, machineName: "desk" }, null, 2) + "\n");
    const fixed = createConfigLoader(file, undefined, { shared: SHARED }).load();
    assert.equal(fixed.error, undefined);
    assert.equal(JSON.parse(read(file)).version, 1);
  });

  test("a migration that cannot be written fails with a clear message and changes nothing", { skip: process.getuid?.() === 0 ? "root may write a read-only file" : false }, () => {
    const old = OLD_OWN;
    const { dir, file } = place(old);
    chmodSync(file, 0o444);
    try {
      const state = createConfigLoader(file, undefined, { shared: SHARED }).load();
      assert.equal(state.config, null);
      assert.match(state.error ?? "", /is format 0 and must be migrated to format 1, but .* cannot be written .*; it was not changed\. Make it writable and start again\. The migration would change: irreversibleActions was dropped/);
      assert.equal(read(file), old);
      assert.deepEqual(readdirSync(dir), ["scopesoup.config.json"]);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test("only the newest copy is kept: an older scopesoup.config.v*.json goes when a new copy is written", () => {
    const old = OLD_OWN;
    const { dir, file } = place(old);
    writeFileSync(join(dir, "scopesoup.config.v0.json"), "an older copy\n");
    writeFileSync(join(dir, "scopesoup.config.v3.json"), "a stray copy\n");
    writeFileSync(join(dir, "other.v0.json"), "not a copy of this file\n");
    assert.equal(createConfigLoader(file, undefined, { shared: SHARED }).load().error, undefined);
    assert.deepEqual(readdirSync(dir).sort(), ["other.v0.json", "scopesoup.config.json", "scopesoup.config.v0.json"]);
    assert.equal(read(join(dir, "scopesoup.config.v0.json")), old);
  });

  test("a file with another name keeps its copy under its own name", () => {
    const { dir } = place("{}");
    const file = join(dir, "project-a.json");
    writeFileSync(file, OLD_OWN);
    assert.equal(createConfigLoader(file, undefined, { shared: SHARED }).load().error, undefined);
    assert.ok(existsSync(join(dir, "project-a.v0.json")));
  });

  test("the item commands read an old file migrated and leave it alone; config:check says it will be migrated", () => {
    const old = OLD_OWN;
    const { dir, file } = place(old);
    const state = createConfigLoader(file, undefined, { write: false, shared: SHARED }).load();
    assert.equal(state.config?.level, 0);
    assert.match(state.notices?.[0] ?? "", /is format 0: it is read as format 1, and Scope Soup writes it so when it starts/);
    const check = checkConfigFile(file, undefined, SHARED);
    assert.equal(check.ok, true);
    assert.ok(check.lines.some((line) => line.includes("The file is format 0: Scope Soup migrates it to format 1 when it starts")));
    assert.ok(check.lines.some((line) => line === "  Notice: inviteLabel was dropped: Scope Soup picks from the whole backlog in order; there is no invite label any more."));
    assert.equal(read(file), old);
    assert.deepEqual(readdirSync(dir), ["scopesoup.config.json"]);
  });

  test("migrateConfig: pure, one step per version; the given object is never changed and a bad version is refused", () => {
    const given = JSON.parse(read(FORMAT_0)) as Record<string, unknown>;
    const copy = structuredClone(given);
    const result = migrateConfig(given);
    assert.ok(result.ok);
    assert.deepEqual(given, copy);
    assert.equal(result.from, 0);
    assert.deepEqual(Object.keys(result.raw)[0], "version");
    const current = JSON.parse(read(FORMAT_1)) as Record<string, unknown>;
    const same = migrateConfig(current);
    assert.ok(same.ok && same.raw === current && same.changes.length === 0);
    for (const version of [-1, 0.5, "1", null]) {
      const bad = migrateConfig({ ...current, version });
      assert.equal(bad.ok, false);
      if (!bad.ok) assert.match(bad.errors[0] ?? "", /^version must be a whole number/);
    }
    // Keys format 1 no longer has are errors in a format-1 file: the migration is where they are known.
    const stale = validateConfig({ ...current, dryRun: true, rules: {} }, FIXTURES);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.match(stale.errors.join("\n"), /unknown key "dryRun"[\s\S]*unknown key "rules"/);
  });

  test("the repository's own config and the example file are the current format and load without a notice", () => {
    // The example with its shared settings; this repository's own file with a plain project's (its own are on its meta ref).
    const root = join(import.meta.dirname, "..", "..");
    const plain = JSON.stringify({ project: "scopesoup", mainBranch: "main", level: 0, bugLabels: ["bug"] });
    for (const [path, shared] of [[join(root, "scopesoup.config.json"), plain], [join(import.meta.dirname, "example.config.json"), read(join(import.meta.dirname, "example.settings.json"))]] as const) {
      const raw = JSON.parse(read(path)) as Record<string, unknown>;
      assert.equal(raw.version, CONFIG_VERSION, path);
      const result = validateFiles(raw, JSON.parse(shared), FIXTURES);
      if (!result.ok) return assert.fail(result.errors.join("\n"));
      assert.deepEqual(result.notices, [], path);
    }
  });
});
