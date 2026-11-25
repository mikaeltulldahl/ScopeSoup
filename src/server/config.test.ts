// The Settings page's API. A real repository holds the project's shared settings on its meta ref (refs/scopesoup/meta),
// shared with a bare remote; a project setting saved here is one commit there, in effect at once, and this machine's own settings
// go into its private file.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { T0 } from "../core/testing.ts";
import { createConfigLoader } from "../config/loader.ts";
import { type MetaSettings, metaSettings } from "../config/metaSettings.ts";
import { memorySettings } from "../config/shared.ts";
import { git, isolateGitConfig } from "../orchestrator/fixtures/git-env.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

const restore = isolateGitConfig();
let store: Store;
let server: ScopeSoupServer;
let bare: ScopeSoupServer;
let base: string;
let bareBase: string;
let dir: string;
let file: string;
let origin: string;
let repo: string;
let settings: MetaSettings;
let changes = 0;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "scopesoup-config-api-"));
  origin = join(dir, "origin.git");
  repo = join(dir, "repo");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, repo);
  file = join(dir, "scopesoup.config.json");
  writeFileSync(file, JSON.stringify({ version: 1, machineName: "laptop-a", repoPath: "repo" }, null, 2) + "\n");
  settings = metaSettings({ now: () => new Date(T0).toISOString() });
  // The first person's onboarding wrote the shared settings.
  const first = await settings.save({ repoPath: repo, remote: "origin", machine: "laptop-a", by: "Ada", update: () => ({ project: "demo", checkCommand: ["node", "--test"] }) });
  assert.ok(first.ok);
  store = openStore(":memory:");
  server = createServer({ store, now: () => new Date(T0), port: 0, configFile: file, onConfigChanged: () => changes++, programFound: () => true, sharedSettings: settings, settingsLog: () => settings.log(repo) });
  bare = createServer({ store, now: () => new Date(T0), port: 0 });
  base = (await server.start()).url;
  bareBase = (await bare.start()).url;
});

after(async () => {
  await server.stop();
  await bare.stop();
  await settings.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  restore();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/config`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada", ...headers }, body: JSON.stringify(body) });
/** This machine's file and every ref of the remote: what a refused change must leave as it was. */
const state = (): string => `${readFileSync(file, "utf8")}\n${git(origin, "for-each-ref")}`;

test("GET /api/config returns both files as one and the configuration; board-only mode says there is none", async () => {
  const view = (await (await fetch(`${base}/api/config`)).json()) as { present: boolean; raw: Record<string, unknown>; config: { project: string; level: number }; safeFields: string[]; sharedFields: string[]; sliders: { budgetReserve: unknown[] }; defaultModels: Record<string, string>; levels: { level: number; blocked: string | null }[] };
  assert.equal(view.sliders.budgetReserve.length, 5);
  // The shared file names a check command but this machine's file no remoteUrl, so level 4 is shown but cannot be picked.
  assert.deepEqual(view.levels.map((choice) => choice.blocked), [null, null, null, null, "Level 4 needs the remote's URL (remoteUrl)."]);
  assert.deepEqual(view.defaultModels, { triage: "opus", implement: "sonnet", review: "opus" });
  assert.deepEqual([view.present, view.config.project, view.config.level], [true, "demo", 0]);
  assert.deepEqual(view.raw, { version: 1, machineName: "laptop-a", repoPath: "repo", project: "demo", checkCommand: ["node", "--test"] });
  assert.ok(view.safeFields.includes("level"));
  assert.deepEqual(view.sharedFields, ["level", "roles", "checkCommand", "setupCommand", "setupWatch", "sharedResources", "media", "settings.triageMaxAgeDays"]);
  assert.deepEqual(await (await fetch(`${bareBase}/api/config`)).json(), { present: false });
  assert.equal((await fetch(`${bareBase}/api/config`, { method: "POST", body: "{}" })).status, 404);
});

test("POST /api/config saves a project setting as one commit on the meta ref, named after the person, in effect at once and pushed", async () => {
  const loader = createConfigLoader(file, undefined, { shared: settings, sharedTtlMs: 0 });
  assert.equal(loader.load().config?.level, 0);
  const own = readFileSync(file, "utf8");
  const tip = git(repo, "rev-parse", "refs/scopesoup/meta");
  const response = await post({ level: 2 });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { changed: boolean; shared: string; config: { level: number } };
  assert.deepEqual([body.changed, body.config.level], [true, 2]);
  assert.match(body.shared, /^Saved for every machine as [0-9a-f]{7} by Ada, and in effect now; the other machines take it at their next fetch\.$/);
  assert.equal(readFileSync(file, "utf8"), own, "this machine's file is not touched");
  assert.equal(loader.load().config?.level, 2);
  // One commit on top of the meta ref, by Ada, changing only the settings and their log, and on the remote.
  const commit = git(repo, "rev-parse", "refs/scopesoup/meta");
  assert.equal(git(repo, "rev-parse", "refs/scopesoup/meta^"), tip);
  assert.equal(git(repo, "log", "-1", "--format=%an", commit), "Ada");
  assert.deepEqual(git(repo, "diff", "--name-only", tip, commit).split("\n"), ["settings/log.jsonl", "settings/settings.json"]);
  assert.equal(git(origin, "rev-parse", "refs/scopesoup/meta"), commit);
  assert.deepEqual(JSON.parse(git(repo, "show", `${commit}:settings/settings.json`)), { project: "demo", checkCommand: ["node", "--test"], level: 2 });
  // The log line says who changed what; History shows it.
  const log = (await (await fetch(`${base}/api/settings/log`)).json()) as { entries: { who: string; machine: string; changes: unknown[] }[] };
  assert.deepEqual(log.entries.map((each) => [each.who, each.machine, each.changes]), [["Ada", "laptop-a", [{ key: "level", to: 2 }]], ["Ada", "laptop-a", [{ key: "project", to: "demo" }, { key: "checkCommand", to: ["node", "--test"] }]]]);
  const event = store.eventsAfter(0, 100).find((each) => each.kind === "config.changed");
  assert.equal((event?.data as { shared: { commit: string } }).shared.commit, commit);
  assert.equal(changes, 1);
});

test("POST /api/config refuses a project setting when nobody is picked at the board, and changes nothing", async () => {
  const before = state();
  const response = await fetch(`${base}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level: 1 }) });
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { errors: string[] }).errors[0] ?? "", /pick who you are at the top of the board first/);
  assert.equal(state(), before);
});

test("POST /api/config saves this machine's own setting into its file, with no commit", async () => {
  const refs = git(origin, "for-each-ref");
  const response = await post({ settings: { maxParallelSessions: { value: 3 } } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { changed: boolean; shared?: string; config: { settings: { maxParallelSessions: { value: number } } } };
  assert.deepEqual([body.changed, body.shared, body.config.settings.maxParallelSessions.value], [true, undefined, 3]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).settings, { maxParallelSessions: { value: 3 } });
  assert.equal(git(origin, "for-each-ref"), refs);
});

test("POST /api/config refuses level 4 while a need is missing, and leaves both files", async () => {
  const before = state();
  const response = await post({ level: 4 });
  assert.equal(response.status, 400);
  // Validation names the missing remoteUrl first; the level's own need (a check command) is tested in src/config/edit.test.ts.
  assert.match(((await response.json()) as { errors: string[] }).errors[0] ?? "", /needs remoteUrl/);
  assert.equal(state(), before);
});

test("POST /api/config refuses an invalid change with the errors and leaves both files", async () => {
  const before = state();
  const response = await post({ settings: { triageMaxAgeDays: { value: 0 } } });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { errors: string[] };
  assert.ok(body.errors.some((error) => error.includes("settings.triageMaxAgeDays")));
  assert.equal(state(), before);
});

test("POST /api/config refuses an unsafe field, and level 4's fields below level 4, and leaves both files", async () => {
  const before = state();
  const response = await post({ repoPath: "elsewhere" });
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { errors: string[] }).errors[0] ?? "", /repoPath cannot be changed/);
  const below = await post({ checkCommand: ["node", "evil.js"] });
  assert.equal(below.status, 400);
  assert.match(((await below.json()) as { errors: string[] }).errors[0] ?? "", /only with level 4/);
  assert.equal(state(), before);
});

test("level 4 with no check command: the view proposes one and the remote URL; saving them saves level 4 and checkCommand for every machine and writes remoteUrl into this machine's file; a command that cannot be run is refused", async () => {
  const mergeQueueDir = mkdtempSync(join(tmpdir(), "scopesoup-config-merge-queue-"));
  const repo = join(mergeQueueDir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", scripts: { check: "node --test", test: "node --test" } }));
  writeFileSync(join(repo, "pnpm-lock.yaml"), "");
  const mergeQueueFile = join(mergeQueueDir, "scopesoup.config.json");
  writeFileSync(mergeQueueFile, JSON.stringify({ machineName: "laptop-a", repoPath: "repo" }, null, 2) + "\n");
  // The shared settings in memory: a save is in effect at once, as on the meta ref.
  const shared = memorySettings({ project: "demo", level: 3 });
  const asked: string[] = [];
  const mergeQueueServer = createServer({
    store, now: () => new Date(T0), port: 0, configFile: mergeQueueFile, programFound: () => true,
    // No real git or PATH: the remote's URL and whether a program can be started are fakes.
    mergeQueue: { platform: "linux", remoteUrlOf: (_repo, remote) => (asked.push(remote), "git@example.invalid:demo.git") },
    checkCommandProblem: (command) => (command[0] === "absent-tool" ? "Could not find absent-tool on PATH." : null),
    sharedSettings: shared,
  });
  const url = (await mergeQueueServer.start()).url;
  try {
    const view = (await (await fetch(`${url}/api/config`)).json()) as { levels: { asks: string[]; pickable: boolean }[]; mergeQueue: { checkCommand: string[]; checkCommandFrom: string; remoteUrl: string } };
    assert.deepEqual([view.levels[4]?.asks, view.levels[4]?.pickable], [["checkCommand", "remoteUrl"], true]);
    assert.deepEqual(view.mergeQueue.checkCommand, ["pnpm", "run", "check"]);
    assert.match(view.mergeQueue.checkCommandFrom, /check script/);
    assert.equal(view.mergeQueue.remoteUrl, "git@example.invalid:demo.git");
    assert.deepEqual(asked, ["origin"]);
    const save = (body: unknown) => fetch(`${url}/api/config`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });

    const before = readFileSync(mergeQueueFile, "utf8") + JSON.stringify(shared.current());
    const refused = await save({ level: 4, checkCommand: ["absent-tool", "check"], remoteUrl: "git@example.invalid:demo.git" });
    assert.equal(refused.status, 400);
    assert.deepEqual(((await refused.json()) as { errors: string[] }).errors, ["checkCommand cannot be run: Could not find absent-tool on PATH."]);
    assert.equal(readFileSync(mergeQueueFile, "utf8") + JSON.stringify(shared.current()), before);

    const saved = await save({ level: 4, checkCommand: view.mergeQueue.checkCommand, remoteUrl: view.mergeQueue.remoteUrl });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { config: { level: number }; mergeQueue: { checkCommand: string[]; checkCommandFrom: string; checkCandidates: { command: string[] }[] } | null };
    // The check question stays on the page with the file's command and the candidates found; git is not asked again.
    assert.deepEqual([body.config.level, body.mergeQueue?.checkCommandFrom, body.mergeQueue?.checkCandidates.map((each) => each.command.join(" "))], [4, "the configuration file", ["pnpm run check", "pnpm run test"]]);
    assert.deepEqual(asked, ["origin"]);
    const own = JSON.parse(readFileSync(mergeQueueFile, "utf8")) as Record<string, unknown>;
    const now = shared.current() as Record<string, unknown>;
    assert.deepEqual([now.level, now.checkCommand, own.remoteUrl], [4, ["pnpm", "run", "check"], "git@example.invalid:demo.git"]);
    assert.equal("level" in own || "remoteUrl" in now, false);
  } finally {
    await mergeQueueServer.stop();
    rmSync(mergeQueueDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("POST /api/config from another origin is refused", async () => {
  const before = state();
  const response = await post({ level: 3 }, { Origin: "https://elsewhere.example" });
  assert.equal(response.status, 403);
  assert.equal(state(), before);
});
