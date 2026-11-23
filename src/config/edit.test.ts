import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type EditOptions, editConfig, readConfigView, splitChange } from "./edit.ts";
import { createConfigLoader } from "./loader.ts";
import { fileSettings, type SaveRequest, SaveRefused, type SaveResult, type SharedSettings } from "./shared.ts";
import { settingChanges } from "../hosts/metaBranch/settings.ts";

const dirs: string[] = [];
/** claude counts as found, so the level's needs depend only on the file. */
const found = { programFound: () => true };
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 3 })));

/** The shared settings of each test's configuration (a plain file standing in for the meta ref), and the saves made. */
const sharedPath = (file: string): string => join(file, "..", "project.json");
const saves = new Map<string, SaveRequest[]>();
/**
 * The test's shared settings, read from and saved to a plain file as the meta writer would: `update` on the settings as they
 * stand at the save. `before` runs first, as another machine's save that came in since the read.
 */
function fileStore(file: string, before?: () => void): SharedSettings {
  const path = sharedPath(file);
  return {
    read: fileSettings(path).read,
    async save(request): Promise<SaveResult> {
      saves.set(file, [...(saves.get(file) ?? []), request]);
      before?.();
      const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      let next: Record<string, unknown>;
      try {
        next = request.update(structuredClone(current));
      } catch (error) {
        return { ok: false, refused: error instanceof SaveRefused, error: error instanceof Error ? error.message : String(error) };
      }
      const changes = settingChanges(current, next);
      if (changes.length === 0) return { ok: true, commit: null, changed: false, changes, sharing: { state: "local" } };
      writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
      return { ok: true, commit: "0123456789abcdef0123456789abcdef01234567", changed: true, changes, sharing: { state: "shared" } };
    },
  };
}
function sharedOptions(file: string): EditOptions {
  return { shared: fileStore(file), by: "Ada" };
}
const edit = (file: string, change: unknown, options: EditOptions = {}) => editConfig(file, change, { ...sharedOptions(file), ...options });
const viewOf = (file: string, options: EditOptions = {}) => readConfigView(file, { ...sharedOptions(file), ...options });
const loaderOf = (file: string) => createConfigLoader(file, undefined, { shared: fileSettings(sharedPath(file)) });
/** Both files as one object, as the Settings page shows them. */
const both = (file: string): Record<string, any> => {
  const own = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  const shared = JSON.parse(readFileSync(sharedPath(file), "utf8")) as Record<string, any>;
  return { ...shared, ...own, settings: { ...shared.settings, ...own.settings } };
};
/** Both files' text, to see that nothing was written. */
const texts = (file: string): string => `${readFileSync(file, "utf8")}\n---\n${readFileSync(sharedPath(file), "utf8")}`;

/**
 * A small valid configuration in a folder of its own: each key in its file. Keys in an order validate does not use.
 * An `undefined` in `extra` leaves the key out.
 */
function setup(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-edit-"));
  dirs.push(dir);
  const file = join(dir, "scopesoup.config.json");
  const raw: Record<string, unknown> = {
    version: 1,
    project: "demo",
    machineName: "laptop-a",
    repoPath: "repo",
    checkCommand: ["node", "--test"],
    level: 0,
    settings: { maxParallelSessions: { value: 1, reason: "One at a time." } },
    roles: { implement: { model: "haiku", allowedTools: ["Read"] } },
    ...extra,
  };
  for (const key of Object.keys(raw)) if (raw[key] === undefined) delete raw[key];
  const { own, shared } = splitChange(raw);
  writeFileSync(file, JSON.stringify(own, null, 2) + "\n");
  writeFileSync(sharedPath(file), JSON.stringify(shared, null, 2) + "\n");
  return file;
}

test("a valid change is merged into each file, keeping the other fields and their order: the project's part is a commit, this machine's is written", async () => {
  const file = setup();
  const result = await edit(file, { level: 3, settings: { maxParallelSessions: { value: 2 } }, roles: { implement: { model: "sonnet" } } }, found);
  assert.equal(result.ok, true);
  const own = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  assert.deepEqual(Object.keys(own), ["version", "machineName", "repoPath", "settings"]);
  assert.deepEqual(own.settings, { maxParallelSessions: { value: 2 } });
  const shared = JSON.parse(readFileSync(sharedPath(file), "utf8")) as Record<string, any>;
  assert.deepEqual(Object.keys(shared), ["project", "checkCommand", "level", "roles"]);
  assert.equal(shared.level, 3);
  assert.deepEqual(shared.checkCommand, ["node", "--test"]);
  assert.deepEqual(shared.roles.implement, { model: "sonnet", allowedTools: ["Read"] });
  assert.ok(readFileSync(file, "utf8").endsWith("}\n"));
  // One save of the shared settings, named after the person, saying what changed; in effect at once.
  const asked = saves.get(file) ?? [];
  assert.deepEqual(asked.map((each) => [each.by, each.machine]), [["Ada", "laptop-a"]]);
  if (result.ok) assert.deepEqual(result.shared?.changes, [{ key: "level", from: 0, to: 3 }, { key: "roles.implement.model", from: "haiku", to: "sonnet" }]);
  assert.equal(loaderOf(file).load().config?.level, 3);
  assert.deepEqual(readdirSync(join(file, "..")).sort(), ["project.json", "scopesoup.config.json"]);
});

test("a change of this machine's settings only is written to its file, with no commit", async () => {
  const file = setup();
  const result = await edit(file, { settings: { maxParallelSessions: { value: 3 }, budgetReserve: { value: 4 } } }, { ...found, by: undefined });
  assert.ok(result.ok && result.changed && result.shared === undefined);
  assert.equal(saves.get(file), undefined);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).settings, { maxParallelSessions: { value: 3 }, budgetReserve: { value: 4 } });
});

test("a save of a shared setting names a person: without one it is refused and nothing is written", async () => {
  const file = setup();
  const before = texts(file);
  const result = await edit(file, { level: 2, settings: { budgetReserve: { value: 5 } } }, { ...found, by: undefined });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors[0] ?? "", /level is a project setting, shared by every machine, and a save names who made it: pick who you are/);
  assert.equal(texts(file), before);
});

test("compare-and-swap: a save is made on the settings as they stand, keeping another save that came in since the read", async () => {
  const file = setup();
  const other = (): void => {
    const raw = JSON.parse(readFileSync(sharedPath(file), "utf8")) as Record<string, any>;
    writeFileSync(sharedPath(file), JSON.stringify({ ...raw, roles: { implement: { model: "opus", allowedTools: ["Read"] } } }, null, 2) + "\n");
  };
  const saved = await edit(file, { level: 2 }, { ...found, shared: fileStore(file, other) });
  assert.ok(saved.ok);
  assert.deepEqual([both(file).level, both(file).roles.implement.model], [2, "opus"]);
  // A change that is not valid on the newest settings is refused there, and nothing is written.
  const ready = setup({ checkCommand: undefined, remoteUrl: "git@example.invalid:demo.git", level: 3 });
  const withCheck = (): void => {
    const raw = JSON.parse(readFileSync(sharedPath(ready), "utf8")) as Record<string, any>;
    writeFileSync(sharedPath(ready), JSON.stringify({ ...raw, checkCommand: [] }, null, 2) + "\n");
  };
  const refused = await edit(ready, { level: 2 }, { ...found, shared: fileStore(ready, withCheck) });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.errors[0] ?? "", /were not saved, and nothing was changed: .*checkCommand must be a list/);
  assert.equal(both(ready).level, 3);
});

test("a project setting that cannot be saved changes nothing, this machine's part included", async () => {
  const file = setup();
  const before = texts(file);
  const failing = await edit(file, { level: 1, settings: { budgetReserve: { value: 5 } } }, { ...found, shared: { read: fileSettings(sharedPath(file)).read, save: async () => ({ ok: false, refused: false, error: "the ref was moved by another writer on each of 5 tries." }) } });
  assert.equal(failing.ok, false);
  if (!failing.ok) assert.match(failing.errors[0] ?? "", /were not saved, and nothing was changed: the ref was moved/);
  const without = await editConfig(file, { level: 1 }, { ...found, shared: fileSettings(sharedPath(file)), by: "Ada" });
  assert.equal(without.ok, false);
  if (!without.ok) assert.match(without.errors[0] ?? "", /level is a project setting in the project's shared settings \(settings\/settings\.json on refs\/scopesoup\/meta\), and this Scope Soup cannot write them/);
  assert.equal(texts(file), before);
});

test("a save of a format-0 file writes it migrated, with \"version\": 1 and a copy of the old file beside it", async () => {
  const file = setup();
  writeFileSync(file, JSON.stringify({ machineName: "laptop-a", repoPath: "repo", settings: { maxParallelSessions: { value: 4, reason: "Room." }, parallelSessions: { value: 2, reason: "Two builders." } } }, null, 2) + "\n");
  const old = readFileSync(file, "utf8");
  const saved = await edit(file, { settings: { budgetReserve: { value: 2 } } }, found);
  assert.equal(saved.ok, true);
  if (saved.ok) assert.equal(saved.config.settings.maxParallelSessions.value, 2);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  assert.deepEqual([raw.version, raw.settings], [1, { maxParallelSessions: { value: 2, reason: "Two builders." }, budgetReserve: { value: 2 } }]);
  assert.equal(readFileSync(join(file, "..", "scopesoup.config.v0.json"), "utf8"), old);
  assert.deepEqual(readdirSync(join(file, "..")).sort(), ["project.json", "scopesoup.config.json", "scopesoup.config.v0.json"]);
});

test("a null or empty role model removes it from the file, so the role runs on its default model", async () => {
  const file = setup({ roles: { implement: { model: "opus", allowedTools: ["Read"] }, review: { model: "haiku" } } });
  const first = await edit(file, { roles: { implement: { model: null }, review: { model: "" } } });
  assert.equal(first.ok, true);
  const raw = both(file) as Record<string, any>;
  assert.deepEqual(raw.roles, { implement: { allowedTools: ["Read"] } });
  if (first.ok) {
    assert.equal(first.config.roles.implement.model, "sonnet");
    assert.equal(first.config.roles.review.model, "opus");
  }
  // Clearing a model the file does not set changes nothing.
  const second = await edit(file, { roles: { implement: { model: null } } });
  assert.equal(second.ok && !second.changed, true);
});

test("an invalid result is refused with the errors and the file unchanged", async () => {
  const file = setup();
  const before = texts(file);
  const result = await edit(file, { settings: { maxParallelSessions: { value: 99 } }, level: 5 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.ok(result.errors.some((error) => error.includes("maxParallelSessions")));
    assert.ok(result.errors.some((error) => error.includes("level must be")));
  }
  assert.equal(texts(file), before);
});

test("unsafe fields are refused, at the top and inside the safe ones", async () => {
  const file = setup();
  const before = texts(file);
  for (const change of [
    { repoPath: "elsewhere" },
    { host: { kind: "github", repo: "a/b" } },
    { claude: { path: "evil" } },
    { mergeQueue: "push" },
    { dryRun: false },
    { inviteLabel: "scopesoup" },
    { roles: { implement: { allowedTools: ["Bash"] } } },
    { roles: { implement: { permissionMode: "acceptEdits" } } },
    { rules: { riskClasses: { effects: [] } } },
    { rules: { claims: { on: false } } },
    { keepAwake: false },
    { bugLabels: ["defect"] },
    { settings: { tickSeconds: { value: 5 } } },
    { settings: { persistence: { value: 2 } } },
    { roles: { situation: { model: "haiku" } } },
  ]) {
    const result = await edit(file, change);
    assert.equal(result.ok, false, JSON.stringify(change));
    if (!result.ok) assert.ok(result.errors[0]?.includes("cannot be changed from the board"), result.errors[0]);
  }
  assert.equal(texts(file), before);
});

test("prototype names are refused, top level and nested, and the file is unchanged", async () => {
  const file = setup();
  const before = texts(file);
  // Parsed, as a request body is: "__proto__" is then an own key, not the prototype.
  for (const text of [
    '{"toString": 1}',
    '{"__proto__": {"level": 4}}',
    '{"constructor": {"prototype": {}}}',
    '{"rules": {"__proto__": {"on": false}}}',
    '{"rules": {"toString": {"on": false}}}',
    '{"settings": {"constructor": {"value": 1}}}',
    '{"roles": {"implement": {"__proto__": {"model": "x"}}}}',
  ]) {
    const result = await edit(file, JSON.parse(text));
    assert.equal(result.ok, false, text);
  }
  assert.equal(texts(file), before);
  assert.equal(({} as Record<string, unknown>).level, undefined);
});

test("the next load returns a written change", async () => {
  const file = setup();
  const loader = loaderOf(file);
  assert.equal(loader.load().config?.level, 0);
  assert.equal((await edit(file, { level: 2, settings: { budgetReserve: { value: 4 } } }, found)).ok, true);
  const state = loader.load();
  assert.equal(state.changed, true);
  assert.deepEqual([state.config?.level, state.config?.settings.budgetReserve.value], [2, 4]);
});

test("a key in the wrong file is refused with where it belongs, and an old file whose migration makes a project setting is refused too", async () => {
  const file = setup();
  writeFileSync(file, JSON.stringify({ version: 1, machineName: "laptop-a", repoPath: "repo", level: 2, settings: { persistence: { value: 2 } } }, null, 2) + "\n");
  let state = loaderOf(file).load();
  assert.equal(state.config, null);
  assert.match(state.error ?? "", /level is a project setting, the same on every machine: it belongs in the project's shared settings \(settings\/settings\.json on refs\/scopesoup\/meta\), saved on the Settings page, not in this machine's scopesoup\.config\.json\./);
  assert.match(state.error ?? "", /settings\.persistence is a project setting/);
  writeFileSync(file, JSON.stringify({ machineName: "laptop-a", repoPath: "repo", dryRun: false, mergeQueue: "person" }, null, 2) + "\n");
  state = loaderOf(file).load();
  assert.match(state.error ?? "", /level is a project setting/);
  writeFileSync(file, JSON.stringify({ version: 1, machineName: "laptop-a", repoPath: "repo" }, null, 2) + "\n");
  writeFileSync(sharedPath(file), JSON.stringify({ project: "demo", machineName: "desk", workspacesDir: "w", settings: { maxParallelSessions: { value: 2 } }, host: { kind: "metaBranch", prefix: "A" } }, null, 2) + "\n");
  state = loaderOf(file).load();
  assert.match(state.error ?? "", /machineName is this machine's own setting: it belongs in its scopesoup\.config\.json, not in the project's shared settings \(settings\/settings\.json on refs\/scopesoup\/meta\), which every machine shares\./);
  assert.match(state.error ?? "", /workspacesDir is this machine's own setting/);
  assert.match(state.error ?? "", /settings\.maxParallelSessions is this machine's own setting/);
  assert.match(state.error ?? "", /host\.prefix belongs to one machine: it goes in that machine's scopesoup\.config\.json as meta\.prefix/);
});

test("saving the level keeps the mergeQueue object: only an older mergeQueue that is not an object goes", async () => {
  const file = setup({ mergeQueue: { ci: "github", ciTimeoutMinutes: 20 } });
  const saved = await edit(file, { level: 2 }, found);
  assert.equal(saved.ok, true);
  assert.deepEqual(both(file).mergeQueue, { ci: "github", ciTimeoutMinutes: 20 });
});

test("a change that changes nothing does not write", async () => {
  const file = setup();
  const result = await edit(file, { level: 0 });
  assert.equal(result.ok && result.changed, false);
});

test("readConfigView: none without a file; the raw file and the resolved configuration with one", async () => {
  assert.deepEqual(readConfigView(undefined), { present: false });
  const file = setup();
  const view = viewOf(file);
  assert.equal(view.present && view.config?.project, "demo");
  assert.equal(view.present && (view.raw as { level: number }).level, 0);
});

test("a level or a number is saved without a reason: the level change comes back for the event; a number's old reason goes", async () => {
  const file = setup();
  const saved = await edit(file, { level: 2, settings: { maxParallelSessions: { value: 3 } } }, found);
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.deepEqual(saved.level, { from: 0, to: 2 });
    assert.deepEqual(saved.config.settings.maxParallelSessions, { value: 3, reason: "" });
  }
  const raw = both(file) as Record<string, any>;
  assert.deepEqual([raw.level, raw.settings.maxParallelSessions], [2, { value: 3 }]);
  // The same level again is no level change.
  const same = await edit(file, { level: 2, settings: { budgetReserve: { value: 4 } } }, found);
  assert.equal(same.ok && same.level, undefined);
  // The board takes no reason, at the top or with a number.
  assert.equal((await edit(file, { level: 3, reason: "Why not." }, found)).ok, false);
  assert.equal((await edit(file, { settings: { budgetReserve: { value: 2, reason: "Room." } } })).ok, false);
});

test("a level whose needs are missing is refused: level 4 without checkCommand or remoteUrl, level 1 and up without claude", async () => {
  const file = setup({ checkCommand: undefined, remoteUrl: "git@example.invalid:demo.git" });
  const before = texts(file);
  const four = await edit(file, { level: 4 }, found);
  assert.equal(four.ok, false);
  if (!four.ok) assert.deepEqual(four.errors, ["Level 4 needs a check command (checkCommand)."]);
  const one = await edit(file, { level: 1 }, { programFound: () => false });
  assert.equal(one.ok, false);
  if (!one.ok) assert.match(one.errors[0] ?? "", /^Level 1 needs claude \(the program "claude" was not found\)\.$/);
  assert.equal(texts(file), before);
  // With a check command level 4 can be picked; going back down is always possible.
  const ready = setup({ remoteUrl: "git@example.invalid:demo.git" });
  assert.equal((await edit(ready, { level: 4 }, found)).ok, true);
  assert.equal((await edit(ready, { level: 0 }, { programFound: () => false })).ok, true);
});

test("readConfigView gives the five levels with their sentences and what each lacks", async () => {
  const file = setup({ checkCommand: undefined });
  const view = viewOf(file, { programFound: () => false });
  assert.ok(view.present);
  if (!view.present) return;
  assert.deepEqual(view.levels.map((choice) => [choice.level, choice.name]), [[0, "Watch"], [1, "Triage"], [2, "Implement"], [3, "Review"], [4, "Autopilot"]]);
  assert.ok(view.levels.every((choice) => choice.text.length > 0));
  assert.equal(view.levels[0]?.blocked, null);
  assert.match(view.levels[3]?.blocked ?? "", /^Level 3 needs claude/);
  assert.equal(view.levels[4]?.blocked, `Level 4 needs claude (the program "claude" was not found), a check command (checkCommand) and the remote's URL (remoteUrl).`);
  assert.deepEqual(view.safeFields, ["level", "settings", "roles", "checkCommand", "remoteUrl", "setupCommand", "setupWatch", "resources", "sharedResources"]);
});

test("level 4 saved with its check command and remote URL writes all three; the check command must be startable; below level 4 they are refused", async () => {
  const file = setup({ checkCommand: undefined, level: 3 });
  const before = texts(file);
  const problems: string[][] = [];
  const options = { ...found, checkCommandProblem: (command: readonly string[]) => (problems.push([...command]), command[0] === "absent" ? "Could not find absent on PATH." : null) };
  const bad = await edit(file, { level: 4, checkCommand: ["absent", "run", "check"], remoteUrl: "git@example.invalid:demo.git" }, options);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.errors, ["checkCommand cannot be run: Could not find absent on PATH."]);
  const malformed = await edit(file, { level: 4, checkCommand: [], remoteUrl: "git@example.invalid:demo.git" }, options);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.errors[0] ?? "", /checkCommand must be a list/);
  const below = await edit(file, { checkCommand: ["node", "--test"] }, options);
  assert.equal(below.ok, false);
  if (!below.ok) assert.match(below.errors[0] ?? "", /only with level 4/);
  assert.equal(texts(file), before);

  const good = await edit(file, { level: 4, checkCommand: ["npm", "run", "check"], remoteUrl: "git@example.invalid:demo.git" }, options);
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.level, { from: 3, to: 4 });
  const raw = both(file) as Record<string, unknown>;
  assert.deepEqual([raw.level, raw.checkCommand, raw.remoteUrl], [4, ["npm", "run", "check"], "git@example.invalid:demo.git"]);
  assert.deepEqual(problems.at(-1), ["npm", "run", "check"]);
});

test("readConfigView proposes level 4's missing needs, and reads no git for them once the file has both", async () => {
  const file = setup({ checkCommand: undefined });
  let reads = 0;
  const mergeQueue = { platform: "linux" as const, remoteUrlOf: () => (reads++, "git@example.invalid:demo.git") };
  const view = viewOf(file, { ...found, mergeQueue });
  assert.ok(view.present);
  if (!view.present) return;
  assert.deepEqual(view.levels[4]?.asks, ["checkCommand", "remoteUrl"]);
  // repoPath has no package.json: nothing is proposed, and the page says why.
  assert.deepEqual([view.mergeQueue?.checkCommand, view.mergeQueue?.checkCommandFrom, view.mergeQueue?.remoteUrl], [null, "the project has no package.json to propose one from", "git@example.invalid:demo.git"]);
  const ready = viewOf(setup({ remoteUrl: "git@example.invalid:demo.git" }), { ...found, mergeQueue });
  // The check question is still shown (with the file's command), but git is not read for a URL the file has.
  assert.equal(ready.present && ready.mergeQueue?.checkCommandFrom, "the configuration file");
  assert.equal(reads, 1);
});

test("the setup is saved from the board at any level, the view shows it, and null removes it", async () => {
  const file = setup();
  const saved = await edit(file, { setupCommand: ["node", "C:/work/shop-scopesoup/scopesoup-setup.mjs", "--from-clone", "C:/work/shop"], setupWatch: ["pnpm-lock.yaml", "web/pnpm-lock.yaml"] }, found);
  assert.ok(saved.ok, saved.ok ? "" : saved.errors.join("; "));
  let raw = both(file) as Record<string, unknown>;
  assert.deepEqual([raw.level, raw.setupCommand, raw.setupWatch], [0, ["node", "C:/work/shop-scopesoup/scopesoup-setup.mjs", "--from-clone", "C:/work/shop"], ["pnpm-lock.yaml", "web/pnpm-lock.yaml"]]);
  const view = viewOf(file, found);
  assert.ok(view.present && view.config);
  if (view.present && view.config) {
    assert.deepEqual(view.config.setupWatch, ["pnpm-lock.yaml", "web/pnpm-lock.yaml"]);
    assert.ok(view.setupWatchDefault.includes("pnpm-lock.yaml"));
  }
  const bad = await edit(file, { setupWatch: ["../outside.lock"] }, found);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.errors[0] ?? "", /setupWatch: "\.\.\/outside\.lock" must be relative/);
  const removed = await edit(file, { setupCommand: null, setupWatch: null }, found);
  assert.ok(removed.ok);
  raw = both(file) as Record<string, unknown>;
  assert.equal("setupCommand" in raw || "setupWatch" in raw, false);
});

test("resources declared in the file load; one added on the Settings page is written to this machine's file, a shared one to the shared settings", async () => {
  const file = setup({ resources: [{ name: "phone", units: 1, neededBy: ["implement", "check"], env: { ANDROID_SERIAL: "phone-{{unit}}" } }] });
  const loaded = loaderOf(file).load();
  assert.deepEqual(loaded.config?.resources, [{ name: "phone", units: 1, shared: false, neededBy: ["implement", "check"], env: { ANDROID_SERIAL: "phone-{{unit}}" } }]);

  const saved = await edit(file, {
    resources: [{ name: "phone", units: 1, neededBy: ["implement", "check"], env: { ANDROID_SERIAL: "phone-{{unit}}" } }, { name: "emulator", units: 2, neededBy: ["review"] }],
    sharedResources: [{ name: "seat", units: 3, neededBy: ["implement"] }],
  }, found);
  assert.ok(saved.ok, saved.ok ? "" : saved.errors.join("; "));
  const own = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const shared = JSON.parse(readFileSync(sharedPath(file), "utf8")) as Record<string, unknown>;
  assert.deepEqual((own.resources as { name: string }[]).map((each) => each.name), ["phone", "emulator"]);
  assert.deepEqual(shared.sharedResources, [{ name: "seat", units: 3, neededBy: ["implement"] }]);
  assert.equal("sharedResources" in own || "resources" in shared, false);
  assert.deepEqual(loaderOf(file).load().config?.resources?.map((each) => `${each.name} ${each.units} ${each.shared}`), ["phone 1 false", "emulator 2 false", "seat 3 true"]);

  // A name used twice, or a bad one, is refused and nothing is written.
  const before = texts(file);
  const twice = await edit(file, { sharedResources: [{ name: "phone", units: 1, neededBy: ["review"] }] }, found);
  assert.equal(twice.ok, false);
  if (!twice.ok) assert.match(twice.errors.join(" "), /"phone" is used twice/);
  const bad = await edit(file, { resources: [{ name: "a phone", units: 0, neededBy: ["deploy"] }] }, found);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.errors.join(" "), /resources\[0\]\.name must be letters/);
  assert.equal(texts(file), before);

  // null removes a list.
  const removed = await edit(file, { resources: null, sharedResources: null }, found);
  assert.ok(removed.ok);
  assert.equal("resources" in both(file) || "sharedResources" in both(file), false);
});
