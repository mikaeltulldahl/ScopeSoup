import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createConfigLoader } from "./loader.ts";
import { recommendations } from "./recommend.ts";
import { overlaps, validateConfig, within } from "./validate.ts";
import { type SharedSettings, validateFiles } from "./shared.ts";

/** Shared settings in memory, as the meta ref would give them. */
function sharedText(text: () => string): SharedSettings {
  return { read: () => ({ ok: true, text: text(), commit: "c0ffee" }) };
}

const BASE = resolve("/srv/scopesoup");

function good(raw: unknown) {
  const result = validateConfig(raw, BASE);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

function bad(raw: unknown): string {
  const result = validateConfig(raw, BASE);
  if (result.ok) assert.fail("expected the configuration to be rejected");
  return result.errors.join("\n");
}

test("a blank project has only the core: no rule switch and the level is 0", () => {
  const config = good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone" });
  assert.equal(config.level, 0);
  assert.equal(config.keepAwake, true);
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", keepAwake: false }).keepAwake, false);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", keepAwake: "no" }), /keepAwake must be true or false/);
  // Multiplayer unless this machine says singleplayer.
  assert.equal(config.multiplayer, true);
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", multiplayer: false }).multiplayer, false);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", multiplayer: "solo" }), /multiplayer must be true or false/);
  assert.equal(config.mainBranch, "main");
  assert.equal(config.remote, "origin");
  assert.equal("rules" in config, false);
  assert.equal(config.workspacesDir, resolve(BASE, "data/workspaces"));
  assert.equal(config.settings.maxParallelSessions.value, 1);
  assert.equal("parallelSessions" in config.settings, false);
  assert.ok(config.promptsDir.endsWith("prompts"));
});

test("removed rule switches in an old file load, are dropped by the migration, and come with a notice each", () => {
  const off = { on: true, reason: "old" };
  const result = validateConfig({
    project: "p", machineName: "laptop-a", repoPath: "/srv/clone",
    rules: { isolatedResources: off, oneCoordinator: off, toolVerification: off, queueOnlyWriter: off, pinnedApproval: off },
  }, BASE);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  assert.equal(result.notices.length, 5);
  assert.match(result.notices.join("\n"), /rules\.toolVerification was dropped/);
  assert.match(result.notices.join("\n"), /rules\.pinnedApproval was dropped: there is no approval step any more/);
  assert.equal("rules" in result.config, false);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", rules: { noSuchRule: off } }), /unknown key "noSuchRule"/);
});

test("waitingCap, changePerItem and weeklyPacing in an old file load, are dropped by the migration, and come with a notice each", () => {
  const result = validateConfig({
    project: "p", machineName: "laptop-a", repoPath: "/srv/clone",
    rules: { changePerItem: { on: true, reason: "old" }, weeklyPacing: { on: true, reason: "old" }, waitingCap: { on: true, reason: "old", max: 0 } },
  }, BASE);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  assert.equal(result.notices.length, 3);
  for (const name of ["changePerItem", "weeklyPacing", "waitingCap"]) {
    assert.ok(result.notices.some((notice) => notice.startsWith(`rules.${name} was dropped: `)), name);
  }
  assert.equal("rules" in result.config, false);
});

test("hardBudgetStop and claims in an old file load, are dropped by the migration, and come with a notice each", () => {
  const result = validateConfig({
    project: "p", machineName: "laptop-a", repoPath: "/srv/clone",
    rules: { hardBudgetStop: { on: false, reason: "old" }, claims: { on: true, reason: "old", expiryMinutes: 30 } },
  }, BASE);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  assert.equal(result.notices.length, 2);
  assert.match(result.notices.join("\n"), /^rules\.hardBudgetStop was dropped: from level 1 the usage stop at settings\.budgetReserve is always on/m);
  assert.match(result.notices.join("\n"), /^rules\.claims was dropped: Scope Soup claims the Items it starts by itself .* fixed expiry of 120 minutes/m);
  assert.equal("rules" in result.config, false);
  // Even values the earlier loader refused (no reason, an expiry of 0) only give the notice now.
  const odd = validateConfig({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", rules: { hardBudgetStop: { on: true }, claims: { expiryMinutes: 0 } } }, BASE);
  assert.equal(odd.ok, true);
});

test("the two parallel settings are one: migrating an old file with both keeps the smaller, with a notice naming the removed key", () => {
  const load = (settings: Record<string, unknown>) => {
    const result = validateConfig({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", settings }, BASE);
    if (!result.ok) return assert.fail(result.errors.join("\n"));
    return result;
  };
  const both = load({ maxParallelSessions: { value: 4, reason: "room" }, parallelSessions: { value: 2, reason: "two builders" } });
  assert.deepEqual(both.config.settings.maxParallelSessions, { value: 2, reason: "two builders" });
  assert.equal(both.notices.length, 1);
  assert.match(both.notices[0] ?? "", /^settings\.parallelSessions was merged into settings\.maxParallelSessions.*the smaller value, 2, is kept/);
  assert.equal("parallelSessions" in both.config.settings, false);
  const smallerMax = load({ maxParallelSessions: { value: 1, reason: "one" }, parallelSessions: { value: 3, reason: "three" } });
  assert.deepEqual(smallerMax.config.settings.maxParallelSessions, { value: 1, reason: "one" });
  assert.match(smallerMax.notices[0] ?? "", /the smaller value, 1, is kept/);
  // Only the old key: it is the one number now.
  assert.equal(load({ parallelSessions: { value: 3, reason: "three" } }).config.settings.maxParallelSessions.value, 3);
  // An unusable old value is only ignored.
  const broken = load({ maxParallelSessions: { value: 2, reason: "two" }, parallelSessions: { value: 0.5 } });
  assert.equal(broken.config.settings.maxParallelSessions.value, 2);
  assert.match(broken.notices[0] ?? "", /^settings\.parallelSessions was merged into settings\.maxParallelSessions, which caps every session\.$/);
});

test("the removed rebase and situation roles and irreversibleActions in an old file load, are dropped by the migration, and come with a notice each", () => {
  const result = validateConfig({
    project: "p", machineName: "laptop-a", repoPath: "/srv/clone",
    irreversibleActions: ["publish a package"],
    roles: { rebase: { model: "sonnet", maxTurns: 30 }, situation: { model: "haiku" }, implement: { model: "opus" } },
  }, BASE);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  assert.equal(result.notices.length, 3);
  assert.match(result.notices.join("\n"), /^irreversibleActions was dropped/m);
  assert.match(result.notices.join("\n"), /^roles\.rebase was dropped/m);
  assert.match(result.notices.join("\n"), /^roles\.situation was dropped/m);
  assert.equal(result.config.roles.implement.model, "opus");
  assert.deepEqual(Object.keys(result.config.roles).sort(), ["implement", "review", "triage"]);
  assert.equal("irreversibleActions" in result.config, false);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", roles: { noSuchRole: {} } }), /unknown key "noSuchRole"/);
});

test("the removed checklist stage in an old file loads: review.checklist, roles.check-review and settings.reviewDepth are dropped by the migration with a notice each", () => {
  const result = validateConfig({
    project: "p", machineName: "laptop-a", repoPath: "/srv/clone",
    review: { checklist: ["The change has a test."] },
    roles: { "check-review": { model: "haiku", maxTurns: 15 }, review: { model: "opus" } },
    settings: { reviewDepth: { value: 2, reason: "old" }, persistence: { value: 4, reason: "kept" } },
  }, BASE);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  assert.equal(result.notices.length, 3);
  const notices = result.notices.join("\n");
  assert.match(notices, /^review\.checklist was dropped/m);
  assert.match(notices, /^roles\.check-review was dropped/m);
  assert.match(notices, /^settings\.reviewDepth was dropped/m);
  assert.equal(result.config.roles.review.model, "opus");
  assert.equal(result.config.settings.persistence.value, 4);
  assert.equal("review" in result.config, false);
  assert.equal("check-review" in result.config.roles, false);
  assert.equal("reviewDepth" in result.config.settings, false);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", settings: { noSuchSetting: { value: 1, reason: "x" } } }), /unknown key "noSuchSetting"/);
});

test("the loader returns notices only on the read that replaces the configuration", () => {
  let text = JSON.stringify({ machineName: "laptop-a", repoPath: "/srv/clone", rules: { oneCoordinator: { on: true, reason: "old" } } });
  const loader = createConfigLoader("/srv/scopesoup/scopesoup.config.json", () => text, { write: (_path, out) => { text = out; return null; }, shared: sharedText(() => JSON.stringify({ project: "p" })) });
  const first = loader.load();
  assert.equal(first.changed, true);
  assert.equal(first.notices?.length, 2);
  assert.match(first.notices?.[0] ?? "", /was migrated from format 0 to format 1/);
  assert.match(first.notices?.[1] ?? "", /rules\.oneCoordinator was dropped/);
  const second = loader.load();
  assert.equal(second.changed, false);
  assert.equal(second.notices, undefined);
});

test("the example files are valid together", () => {
  const own = JSON.parse(readFileSync(join(import.meta.dirname, "example.config.json"), "utf8")) as unknown;
  const shared = JSON.parse(readFileSync(join(import.meta.dirname, "example.settings.json"), "utf8")) as unknown;
  const result = validateFiles(own, shared, BASE);
  if (!result.ok) return assert.fail(result.errors.join(" "));
  const config = result.config;
  // {{ownClone}} in the shared setup command is this machine's own clone.
  assert.deepEqual(config.setupCommand, ["node", ".scopesoup/scopesoup-setup.mjs", "--from-clone", resolve("/home/sam/example").replace(/\\/g, "/")]);
  assert.equal(config.level, 0);
  assert.equal("rules" in config, false);
  assert.equal(config.repoPath, resolve(BASE, "../example-clone"));
  assert.equal(config.roles.implement.maxTurns, 80);
});

test("an old inviteLabel loads, whatever its value, and is dropped by the migration with a notice: Scope Soup picks from the whole backlog", () => {
  for (const value of ["scopesoup", "", 5, null]) {
    const result = validateConfig({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", inviteLabel: value }, BASE);
    if (!result.ok) return assert.fail(result.errors.join("\n"));
    assert.deepEqual(result.notices, ["inviteLabel was dropped: Scope Soup picks from the whole backlog in order; there is no invite label any more."]);
    assert.equal("inviteLabel" in result.config, false);
  }
});

test("level: a whole number from 0 to 4; level 4 needs remoteUrl, a level below it does not", () => {
  const url = "git@example.invalid:team/project.git";
  for (const level of [0, 1, 2, 3, 4]) assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", level, remoteUrl: url }).level, level);
  for (const level of [5, -1, 2.5, "2", null]) {
    assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", level }), /level must be a whole number from 0 to 4: 0 Watch, 1 Triage, 2 Implement, 3 Review, 4 Autopilot/);
  }
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", level: 4 }), /level 4 \((Autopilot)\) needs remoteUrl/);
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", level: 3 }).level, 3);
});

test("an old mergeQueue string loads, whatever its value, and is dropped by the migration with a notice: the level decides", () => {
  for (const mergeQueue of ["person", "push", "queue", "merge", 5]) {
    const result = validateConfig({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", level: 4, mergeQueue, remoteUrl: "git@example.invalid:team/project.git" }, BASE);
    if (!result.ok) return assert.fail(result.errors.join("\n"));
    assert.equal("mergeQueue" in result.config, false);
    assert.match(result.notices.join("\n"), /^mergeQueue [^ ]+ was dropped: the level decides/m);
  }
});

test("mergeQueue.ci and mergeQueue.ciTimeoutMinutes: the object form is read and checked; absent means the local check", () => {
  const base = { project: "p", machineName: "laptop-a", repoPath: "/srv/clone", level: 4, remoteUrl: "git@example.invalid:team/project.git" };
  assert.equal("mergeQueue" in good(base), false);
  const github = good({ ...base, host: { kind: "github", repo: "acme/widgets", write: true }, mergeQueue: { ci: "github" } });
  assert.deepEqual(github.mergeQueue, { ci: "github", ciTimeoutMinutes: 60 });
  assert.equal(github.checkCommand, undefined, "level 4 with CI on GitHub needs no checkCommand");
  assert.deepEqual(good({ ...base, mergeQueue: { ci: "github", ciTimeoutMinutes: 15 } }).mergeQueue, { ci: "github", ciTimeoutMinutes: 15 }, "the host may come from the environment");
  assert.deepEqual(good({ ...base, mergeQueue: {} }).mergeQueue, { ci: "local", ciTimeoutMinutes: 60 });
  assert.match(bad({ ...base, mergeQueue: { ci: "jenkins" } }), /mergeQueue.ci must be "local" .* or "github"/);
  for (const ciTimeoutMinutes of [0, -5, 2000, "60"]) assert.match(bad({ ...base, mergeQueue: { ci: "github", ciTimeoutMinutes } }), /mergeQueue.ciTimeoutMinutes must be a number from 1 to 1440/);
  assert.match(bad({ ...base, mergeQueue: { ci: "github", timeout: 5 } }), /mergeQueue: unknown key "timeout"\. Known keys: ci, ciTimeoutMinutes/);
  assert.match(bad({ ...base, host: { kind: "metaBranch", write: false }, mergeQueue: { ci: "github" } }), /mergeQueue.ci is "github", but the host is metaBranch/);
});

test("an old config with riskClasses loads, with a notice that no change waits for an Approve", () => {
  const result = validateConfig({
    project: "p", machineName: "laptop-a", repoPath: "/srv/clone", level: 4, remoteUrl: "git@example.invalid:team/project.git",
    rules: { riskClasses: { on: true, reason: "old", effects: [{ name: "schema", paths: ["**/migrations/**"] }] }, hardBudgetStop: { on: true, reason: "old" } },
  }, BASE);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  assert.equal(result.notices[0], "rules.riskClasses was dropped: there is no approval step any more: no change waits for an Approve, whatever paths it touches.");
  assert.equal(result.notices.length, 2);
  assert.equal("rules" in result.config, false);
  // Even an old riskClasses that the earlier loader refused (on, with no effects) loads now.
  const empty = validateConfig({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", rules: { riskClasses: { on: true, reason: "old", effects: [] } } }, BASE);
  assert.equal(empty.ok, true);
});

test("checkCommand is a program and its arguments; the check timeout defaults to 60 minutes", () => {
  const plain = good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone" });
  assert.equal(plain.checkCommand, undefined);
  assert.equal(plain.settings.checkTimeoutMinutes.value, 60);
  const merges = good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", level: 4, remoteUrl: "git@example.invalid:team/project.git", checkCommand: ["node", "check.js"] });
  assert.deepEqual(merges.checkCommand, ["node", "check.js"]);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", dryRun: false, mergeQueue: "queue" }), /level 4 \((Autopilot)\) needs remoteUrl/);
  for (const value of [[], "node check.js", [""], [5]]) {
    assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", checkCommand: value }), /checkCommand must be a list/);
  }
});

test("problems are reported together, in words", () => {
  const errors = bad({
    repoPath: "/srv/clone",
    colour: "red",
    rules: { hardBudgetStop: { on: true }, noSuchRule: { on: true, reason: "x" } },
    settings: { maxParallelSessions: { value: 1.5, reason: "x" }, reserveFiveHour: { value: 0.1 } },
    roles: { review: { permissionMode: "bypassPermissions" } },
  });
  assert.match(errors, /project must be a non-empty string/);
  assert.match(errors, /unknown key "colour"/);
  assert.match(errors, /rules: unknown key "noSuchRule"/);
  assert.match(errors, /settings\.maxParallelSessions\.value must be a whole number/);
  assert.match(errors, /bypassPermissions.*refused/);
});

test("any role may run on any model; the same model for reviewer and implementor is only advised against, from level 3", () => {
  const raw = { project: "p", machineName: "laptop-a", repoPath: "/srv/clone", level: 3, roles: { review: { model: "sonnet" } } };
  const result = validateConfig(raw, "/srv/scopesoup");
  assert.ok(result.ok);
  assert.match(recommendations(result.config).join(" "), /reviewer and the implementor both run on "sonnet"/);
  const below = validateConfig({ ...raw, level: 2 }, "/srv/scopesoup");
  assert.ok(below.ok);
  assert.deepEqual(recommendations(below.config), []);
  const apart = validateConfig({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", level: 3 }, "/srv/scopesoup");
  assert.ok(apart.ok);
  assert.deepEqual(recommendations(apart.config), []);
});

test("workspaces and the repository may not overlap a real path", () => {
  const errors = bad({ project: "p", machineName: "laptop-a", repoPath: "/real/app/clone", realPaths: ["/real/app", "/srv/scopesoup/data"] });
  assert.match(errors, /repoPath .* is inside the real path/);
  assert.match(errors, /workspacesDir .* overlaps the real path/);
});

test("workspaces: worktrees by default, or a pool of clones with the project in a subfolder that stays inside each clone", () => {
  assert.deepEqual(good({ project: "p", machineName: "laptop-a", repoPath: "/c" }).workspaces, { kind: "worktree" });
  assert.deepEqual(good({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "worktree" } }).workspaces, { kind: "worktree" });
  const pool = good({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "pool", paths: ["../pool/one", resolve("/pool/two")], projectSubdir: "libs/project" } }).workspaces;
  assert.deepEqual(pool, { kind: "pool", paths: [resolve(BASE, "../pool/one"), resolve("/pool/two")], projectSubdir: "libs/project" });
  assert.deepEqual(good({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "pool", paths: ["/pool/one"] } }).workspaces, { kind: "pool", paths: [resolve("/pool/one")], projectSubdir: "." });

  for (const projectSubdir of ["..", "../outside", "libs/../../outside", "libs\\..\\..", "/abs", "C:\\abs", "C:rel", ""]) {
    assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "pool", paths: ["/pool/one"], projectSubdir } }), /workspaces\.projectSubdir/, projectSubdir);
  }
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "pool", paths: [] } }), /workspaces\.paths must be a non-empty list/);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "pool", paths: ["/pool", "/pool/one"] } }), /overlap\. Each clone is a folder of its own/);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "pool", paths: ["/pool/one"], size: 2 } }), /workspaces: unknown key "size"/);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "clones" } }), /workspaces\.kind must be "worktree" or "pool"/);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "worktree", paths: ["/x"] } }), /unknown key "paths" for kind "worktree"/);
  // A clone is never the repository Scope Soup works from, nor above or below it.
  for (const paths of [["/c"], ["/c/sub"], ["/"], ["/pool/one", "/c/../c"]]) {
    assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "pool", paths } }), /the clone .* equals, contains or is inside repoPath \(.*c\)/, paths.join(","));
  }
  good({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "pool", paths: ["/cc", "/pool/c"] } });
  // Core rule 1 holds for every clone.
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/c", realPaths: ["/pool/two/data"], workspaces: { kind: "pool", paths: ["/pool/one", "/pool/two"] } }), /the clone .*two overlaps the real path/);
});

test("workspaces.keep: gitignore patterns inside the project's repository that can only keep more", () => {
  const pool = (keep: unknown) => ({ project: "p", machineName: "laptop-a", repoPath: "/c", workspaces: { kind: "pool", paths: ["/pool/one"], keep } });
  assert.deepEqual(good(pool(["build/", "**/*.cache", "out/cache-*.bin", "-rf"])).workspaces, { kind: "pool", paths: [resolve("/pool/one")], projectSubdir: ".", keep: ["build/", "**/*.cache", "out/cache-*.bin", "-rf"] });
  assert.deepEqual(good(pool([])).workspaces, { kind: "pool", paths: [resolve("/pool/one")], projectSubdir: ".", keep: [] });
  for (const pattern of ["..", "../outside", "build/../../x", "/abs", "C:\\abs", "C:rel", "\\\\server\\share", "build\\out", "!build/keep.me", "", " ", "a\nb"]) {
    assert.match(bad(pool([pattern])), /workspaces\.keep/, JSON.stringify(pattern));
  }
  assert.match(bad(pool("build/")), /workspaces\.keep must be a list of patterns/);
  assert.match(bad(pool([3])), /workspaces\.keep must be a list of patterns/);
});

test("within and overlaps compare whole path segments", () => {
  assert.equal(within("/a/b", "/a/b/c"), true);
  assert.equal(within("/a/b", "/a/b"), true);
  assert.equal(within("/a/b", "/a/bc"), false);
  assert.equal(overlaps("/a/b/c", "/a/b"), true);
  assert.equal(overlaps("/a/x", "/a/b"), false);
});

test("a bad reload keeps the last good configuration and reports the error", () => {
  let text = JSON.stringify({ version: 1, machineName: "laptop-a", repoPath: "/srv/clone" });
  let shared = JSON.stringify({ project: "one" });
  const loader = createConfigLoader("/srv/scopesoup/scopesoup.config.json", () => text, { shared: sharedText(() => shared) });

  const first = loader.load();
  assert.equal(first.config?.project, "one");
  assert.equal(first.changed, true);
  assert.equal(loader.load().changed, false);

  text = "{ not json";
  const second = loader.load();
  assert.equal(second.config?.project, "one");
  assert.match(second.error ?? "", /not valid JSON/);

  text = JSON.stringify({ version: 1, machineName: "laptop-a", repoPath: "/srv/clone" });
  shared = JSON.stringify({ project: "" });
  const third = loader.load();
  assert.equal(third.config?.project, "one");
  assert.match(third.error ?? "", /project must be/);

  shared = JSON.stringify({ project: "two" });
  const fourth = loader.load();
  assert.equal(fourth.config?.project, "two");
  assert.equal(fourth.changed, true);
  assert.equal(fourth.error, undefined);
});

test("with no good configuration yet, the loader says so", () => {
  const loader = createConfigLoader("/nowhere/scopesoup.config.json", () => {
    throw new Error("ENOENT");
  });
  const state = loader.load();
  assert.equal(state.config, null);
  assert.match(state.error ?? "", /Cannot read/);
});

test("the remote must look like a git remote name", () => {
  for (const remote of ["", "my remote", "-x"]) assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/c", remote }), /remote/);
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/c", remote: "upstream" }).remote, "upstream");
});

test("claude.path with a directory is resolved against the configuration file; a bare name is left alone", () => {
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/c", claude: { path: "claude" } }).claude.path, "claude");
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/c", claude: { path: join("tools", "claude.exe") } }).claude.path, resolve(BASE, "tools", "claude.exe"));
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/c", claude: { path: "tools/claude" } }).claude.path, resolve(BASE, "tools", "claude"));
  const absolute = resolve("/opt/claude/bin/claude");
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/c", claude: { path: absolute } }).claude.path, absolute);
});

test("host: a meta branch host is the meta ref of the project's repository, shared with its remote", () => {
  const plain = good({ project: "p", machineName: "laptop-a", repoPath: "clone", host: { kind: "metaBranch" } });
  assert.deepEqual(plain.host, { kind: "metaBranch", repoPath: resolve(BASE, "clone"), write: false, remote: "origin", fetchSeconds: 60 });
  const full = good({
    project: "p", machineName: "laptop-a", repoPath: "/srv/clone", remote: "upstream",
    host: { kind: "metaBranch", write: true, authorName: "Test Person", authorEmail: "test.person@example.invalid", prefix: "A", fetchSeconds: 30 },
  });
  assert.deepEqual(full.host, { kind: "metaBranch", repoPath: resolve("/srv/clone"), write: true, authorName: "Test Person", authorEmail: "test.person@example.invalid", prefix: "A", remote: "upstream", fetchSeconds: 30 });
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone" }).host, undefined);
  // The ref's name is fixed, and the folder and remote are this machine's: none of them is a host setting.
  for (const key of ["ref", "repoPath", "remote"]) assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", host: { kind: "metaBranch", [key]: "x" } }), new RegExp(`unknown key "${key}" for kind "metaBranch"`));
});

test("host: a github host takes the repository and the write switch", () => {
  const config = good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", host: { kind: "github", repo: "owner/name", write: true } });
  assert.deepEqual(config.host, { kind: "github", repo: "owner/name", write: true });
});

test("host: mistakes are refused in words", () => {
  const base = { project: "p", machineName: "laptop-a", repoPath: "/srv/clone" };
  assert.match(bad({ ...base, host: "metaBranch" }), /host must be an object with "kind": "github", "metaBranch" or "jira"/);
  assert.match(bad({ ...base, host: { kind: "gitlab" } }), /host must be an object with "kind"/);
  assert.match(bad({ ...base, host: { kind: "github" } }), /host.repo must be the repository as "owner\/name"/);
  assert.match(bad({ ...base, host: { kind: "github", repo: "name-only" } }), /host.repo \(name-only\) must be/);
  assert.match(bad({ ...base, host: { kind: "github", repo: "owner/name", token: "x" } }), /a token is never kept in the configuration file/);
  assert.match(bad({ ...base, host: { kind: "metaBranch", write: true } }), /host.authorName and host.authorEmail are required/);
  assert.match(bad({ ...base, host: { kind: "metaBranch", write: "yes" } }), /host.write must be true or false/);
  assert.match(bad({ ...base, host: { kind: "metaBranch", fetchSeconds: -1 } }), /host.fetchSeconds must be a whole number/);
  assert.match(bad({ ...base, host: { kind: "metaBranch", repo: "owner/name" } }), /unknown key "repo" for kind "metaBranch"/);
});

test("budgetReserve: a slider from 1 to 5; the older reserve names are still accepted", () => {
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone" }).settings.budgetReserve.value, 3);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", settings: { budgetReserve: { value: 6, reason: "x" } } }), /budgetReserve\.value/);
  const old = good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", settings: { reserveFiveHour: { value: 0.3, reason: "old" }, reserveSevenDay: { value: 0.25, reason: "old" } } });
  assert.equal(old.settings.reserveFiveHour?.value, 0.3);
  assert.equal(old.settings.reserveSevenDay?.value, 0.25);
});

test("role models default to opus for triage and review and sonnet for implement; a model in roles wins", () => {
  const cfg = good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone" });
  assert.deepEqual(Object.fromEntries(Object.entries(cfg.roles).map(([role, r]) => [role, r.model])), {
    triage: "opus", implement: "sonnet", review: "opus",
  });
  const set = good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", roles: { triage: { model: "haiku" } } });
  assert.deepEqual(Object.fromEntries(Object.entries(set.roles).map(([role, r]) => [role, r.model])), {
    triage: "haiku", implement: "sonnet", review: "opus",
  });
});

test("the removed fix role in an old file loads, is dropped by the migration, and comes with a notice", () => {
  const result = validateConfig({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", roles: { fix: { model: "opus", allowedTools: ["Bash(git *)"] }, implement: { model: "haiku" } } }, BASE);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  assert.deepEqual(result.notices, ["roles.fix was dropped: review findings and merging failures go back to the implementor's own session."]);
  assert.deepEqual(Object.keys(result.config.roles).sort(), ["implement", "review", "triage"]);
  assert.equal(result.config.roles.implement.model, "haiku");
});

test("the removed autonomy, triageDepth and modelStrength sliders in an old file load, are dropped by the migration, and come with a notice each", () => {
  const result = validateConfig({
    project: "p", machineName: "laptop-a", repoPath: "/srv/clone",
    settings: { autonomy: { value: 3, reason: "old" }, triageDepth: { value: 1, reason: "old" }, modelStrength: { value: 5, reason: "old" }, persistence: { value: 4, reason: "kept" } },
  }, BASE);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  assert.equal(result.notices.length, 3);
  const notices = result.notices.join("\n");
  assert.match(notices, /^settings\.autonomy was dropped: the setting was removed \(questions always go to a person/m);
  assert.match(notices, /^settings\.triageDepth was dropped/m);
  assert.match(notices, /^settings\.modelStrength was dropped/m);
  assert.equal(result.config.settings.persistence.value, 4);
  for (const name of ["autonomy", "triageDepth", "modelStrength"]) assert.equal(name in result.config.settings, false);
  // Position 5 used to put implement on opus; the defaults stand now.
  assert.equal(result.config.roles.implement.model, "sonnet");
  assert.equal(result.config.roles.triage.model, "opus");
});

test("the queue's numbers are settings: defaults match the engine, an old file loads, a file can set them, min above max is refused", () => {
  const blank = good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone" });
  assert.deepEqual([blank.settings.queueMinBatch.value, blank.settings.queueMaxBatch.value, blank.settings.queueRerunCost.value, blank.settings.queueMinOutcomes.value], [2, 12, 0.15, 10]);
  const set = good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", settings: { queueMaxBatch: { value: 6, reason: "short chains" }, queueRerunCost: { value: 0.3, reason: "slow reruns" } } });
  assert.deepEqual([set.settings.queueMinBatch.value, set.settings.queueMaxBatch.value, set.settings.queueRerunCost.value], [2, 6, 0.3]);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", settings: { queueMinBatch: { value: 5, reason: "x" }, queueMaxBatch: { value: 3, reason: "x" } } }), /queueMinBatch \(5\) is larger than settings.queueMaxBatch \(3\)/);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", settings: { queueMinOutcomes: { value: 0, reason: "x" } } }), /queueMinOutcomes/);
});

test("rerunFilesCommand is a program with exactly one {files} argument, and is optional", () => {
  assert.equal(good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone" }).rerunFilesCommand, undefined);
  assert.deepEqual(good({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", rerunFilesCommand: ["node", "--test", "{files}"] }).rerunFilesCommand, ["node", "--test", "{files}"]);
  for (const given of [[], ["node", "--test"], ["node", "{files}", "{files}"], ["{files}"], "node", [1]]) {
    assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", rerunFilesCommand: given }), /rerunFilesCommand/);
  }
});

test("testsWithChange and agentCheckCommand in an old file load, are dropped by the migration, and come with a notice each", () => {
  const result = validateConfig({
    project: "p", machineName: "laptop-a", repoPath: "/srv/clone",
    agentCheckCommand: "pnpm check",
    rules: { testsWithChange: { on: true, reason: "old" } },
  }, BASE);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  assert.equal(result.notices.length, 2);
  const notices = result.notices.join("\n");
  assert.match(notices, /^agentCheckCommand was dropped/m);
  assert.match(notices, /^rules\.testsWithChange was dropped: the project's own CLAUDE\.md says/m);
  assert.equal("rules" in result.config, false);
  assert.equal("agentCheckCommand" in result.config, false);
});

// --- the migration of old files to a level (docs/RUNNING.md "Levels"): one test per row ---

const URL = "git@example.invalid:team/project.git";
const migrated = (raw: Record<string, unknown>) => {
  const result = validateConfig({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", ...raw }, BASE);
  if (!result.ok) return assert.fail(result.errors.join("\n"));
  return { level: result.config.level, notices: result.notices.join("\n") };
};

test("migration: dryRun true is level 0, with a notice naming the level the rest of the file describes", () => {
  const person = migrated({ dryRun: true, mergeQueue: "person" });
  assert.equal(person.level, 0);
  assert.match(person.notices, /^dryRun true became "level": 0: a dry run is level 0 \((Watch)\).*The rest of the file describes level 1 \(Triage\); set "level": 1/m);
  const push = migrated({ dryRun: true, mergeQueue: "push", remoteUrl: URL });
  assert.equal(push.level, 0);
  assert.match(push.notices, /The rest of the file describes level 4 \((Autopilot)\); set "level": 4/);
  // A dry run that names a merge without its remoteUrl loads: nothing merges at level 0.
  assert.equal(migrated({ dryRun: true, mergeQueue: "queue" }).level, 0);
});

test("migration: no configuration file is level 0, board only; a file with no dryRun and no level is level 0 without a notice", () => {
  const loader = createConfigLoader("/srv/scopesoup/scopesoup.config.json", () => {
    throw new Error("ENOENT: no such file");
  });
  const state = loader.load();
  assert.equal(state.config, null);
  assert.match(state.error ?? "", /Cannot read/);
  const plain = migrated({});
  assert.deepEqual([plain.level, plain.notices], [0, ""]);
});

test("migration: dryRun false with mergeQueue person (or none) is level 1, with a notice that agents used to hand changes to a person", () => {
  for (const raw of [{ dryRun: false, mergeQueue: "person" }, { dryRun: false }]) {
    const result = migrated(raw);
    assert.equal(result.level, 1);
    assert.match(result.notices, /^dryRun false with mergeQueue "person" became "level": 1, level 1 \(Triage\): agents used to hand changes to a person/m);
  }
});

test("migration: dryRun false with mergeQueue push or queue is level 4, which merges through the queue; with riskClasses on, a notice says changes no longer wait for approval", () => {
  for (const mergeQueue of ["push", "queue"]) {
    const result = migrated({ dryRun: false, mergeQueue, remoteUrl: URL });
    assert.equal(result.level, 4);
    assert.ok(result.notices.includes(`dryRun false with mergeQueue "${mergeQueue}" became "level": 4, level 4 (Autopilot)`), result.notices);
    assert.doesNotMatch(result.notices, /no longer wait/);
  }
  const risky = migrated({ dryRun: false, mergeQueue: "push", remoteUrl: URL, rules: { riskClasses: { on: true, reason: "old", effects: [{ name: "x", paths: ["x/**"] }] } } });
  assert.equal(risky.level, 4);
  assert.match(risky.notices, /Risk classes were on: changes no longer wait for an approval/);
  assert.match(risky.notices, /^rules\.riskClasses was dropped/m);
});

test("migration: a file that sets level wins; its dryRun is dropped by the migration with a notice, and an old reviewer rule too", () => {
  const result = migrated({ level: 2, dryRun: false, mergeQueue: "push", remoteUrl: URL, rules: { reviewer: { on: true, reason: "old" } } });
  assert.equal(result.level, 2);
  assert.match(result.notices, /^dryRun was dropped: the file sets level 2/m);
  assert.match(result.notices, /^rules\.reviewer was dropped: the level decides: from level 3 \(Review\) every built change is reviewed/m);
  assert.equal(migrated({ level: 0, dryRun: false, mergeQueue: "queue", remoteUrl: URL }).level, 0);
  assert.match(bad({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", dryRun: "yes" }), /dryRun must be true or false\. It is an older key: set level instead/);
});

test("a number in settings needs no reason: without one it loads with an empty reason; a reason that is not text is refused", () => {
  const config = good({ project: "demo", machineName: "laptop-a", repoPath: "repo", settings: { maxParallelSessions: { value: 2 }, budgetReserve: { value: 4, reason: " Room. " } } });
  assert.deepEqual(config.settings.maxParallelSessions, { value: 2, reason: "" });
  assert.deepEqual(config.settings.budgetReserve, { value: 4, reason: "Room." });
  assert.match(bad({ project: "demo", machineName: "laptop-a", repoPath: "repo", settings: { budgetReserve: { value: 4, reason: 3 } } }), /settings\.budgetReserve\.reason must be text/);
});

test("setupCommand and setupWatch are optional keys of format 1, checked for their form", () => {
  const core = { version: 1, project: "demo", machineName: "laptop-a", repoPath: "/srv/clone" };
  const plain = good(core);
  assert.equal(plain.setupCommand, undefined);
  assert.equal(plain.setupWatch, undefined);
  const set = good({ ...core, setupCommand: ["node", "/srv/demo-scopesoup/scopesoup-setup.mjs", "--from-clone", "/home/sam/demo"], setupWatch: ["pnpm-lock.yaml", "requirements*.txt", "web/pnpm-lock.yaml"] });
  assert.deepEqual(set.setupWatch, ["pnpm-lock.yaml", "requirements*.txt", "web/pnpm-lock.yaml"]);
  assert.match(bad({ ...core, setupCommand: "pnpm install" }), /setupCommand must be a list/);
  assert.match(bad({ ...core, setupCommand: [] }), /setupCommand must be a list/);
  assert.match(bad({ ...core, setupWatch: "pnpm-lock.yaml" }), /setupWatch must be a list/);
  const watch = bad({ ...core, setupWatch: ["/etc/passwd", "../up.lock", "a\\b.lock", "**/x.lock", ""] });
  for (const word of [/"\/etc\/passwd" must be relative/, /"\.\.\/up\.lock" must be relative/, /must use "\/" between folders/, /not "\*\*"/, /must be a non-empty path/]) assert.match(watch, word);
});

test("the implement and review roles may always run the check command", () => {
  const result = validateConfig({ project: "p", machineName: "laptop-a", repoPath: "/srv/clone", checkCommand: ["cmd.exe", "/d", "/c", "npm", "run", "check"], roles: { implement: { allowedTools: ["Read"] } } }, BASE);
  assert.ok(result.ok);
  assert.deepEqual(result.config.roles.implement.allowedTools, ["Read", "Bash(npm run check*)"]);
  assert.ok(result.config.roles.review.allowedTools.includes("Bash(npm run check*)"));
  assert.ok(!result.config.roles.triage.allowedTools.includes("Bash(npm run check*)"));
});

test("media: images stay on this machine and are kept unless the project says otherwise; a wrong value is refused", () => {
  const base = { project: "p", machineName: "laptop-a", repoPath: "/srv/clone" };
  assert.equal(good(base).media, undefined);
  assert.deepEqual(good({ ...base, media: { push: true, keepDaysAfterClose: 30 } }).media, { push: true, keepDaysAfterClose: 30 });
  assert.deepEqual(good({ ...base, media: { keepDaysAfterClose: null } }).media, { push: false, keepDaysAfterClose: null });
  assert.match(bad({ ...base, media: { push: "yes" } }), /media\.push must be true or false/);
  assert.match(bad({ ...base, media: { keepDaysAfterClose: 1.5 } }), /keepDaysAfterClose must be a whole number/);
  assert.match(bad({ ...base, media: { upload: true } }), /media: unknown key "upload"/);
  // A project setting: in this machine's private file it is refused with where it belongs.
  const files = validateFiles({ ...base, media: { push: true } }, {}, BASE);
  assert.equal(files.ok, false);
  if (!files.ok) assert.match(files.errors.join(" "), /media is a project setting/);
});

test("review.shouldFindings: \"fix\" (the default) or \"draft\"; anything else is refused with what it may be", () => {
  const base = { project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", version: 1 };
  const read = (review: unknown) => validateConfig({ ...base, review }, "/srv/scopesoup");
  const fine = read({ shouldFindings: "draft" });
  assert.deepEqual(fine.ok ? fine.config.review : fine.errors, { shouldFindings: "draft" });
  const none = validateConfig(base, "/srv/scopesoup");
  assert.equal(none.ok ? none.config.review : "refused", undefined);
  const wrong = read({ shouldFindings: "later", other: 1 });
  assert.deepEqual(wrong.ok ? [] : wrong.errors, ['review: unknown key "other". Known keys: shouldFindings.', 'review.shouldFindings must be one of "fix", "draft".']);
});

test("labels.aiGenerated: false (the default), true (\"ai-generated\") or a label name; anything else is refused", () => {
  const base = { project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", version: 1 };
  const read = (labels: unknown) => validateConfig({ ...base, labels }, "/srv/scopesoup");
  assert.deepEqual((read({ aiGenerated: true }) as { config: { labels: unknown } }).config.labels, { aiGenerated: "ai-generated" });
  assert.deepEqual((read({ aiGenerated: " by-ai " }) as { config: { labels: unknown } }).config.labels, { aiGenerated: "by-ai" });
  assert.deepEqual((read({ aiGenerated: false }) as { config: { labels: unknown } }).config.labels, { aiGenerated: false });
  assert.equal((validateConfig(base, "/srv/scopesoup") as { config: { labels?: unknown } }).config.labels, undefined);
  for (const bad of ["", "two words", "a,b", "scopesoup:x", 3]) assert.equal(read({ aiGenerated: bad }).ok, false, String(bad));
  const unknown = read({ other: 1, aiGenerated: false });
  assert.deepEqual(unknown.ok ? [] : unknown.errors, ['labels: unknown key "other". Known keys: aiGenerated.']);
});
