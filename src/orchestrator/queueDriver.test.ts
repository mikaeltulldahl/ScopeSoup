// The queue driver against throwaway repositories: a bare remote, one clone holding the items'
// branches, and the check command as node itself. Batches are built, checked, bisected and pushed
// by the real driver with real git; the engine's own behaviour is tested in src/queue.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import type { ProjectConfig } from "../config/types.ts";
import type { Ref } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import { git, isolateGitConfig } from "./fixtures/git-env.ts";
import { createCheckRunner } from "./checkRunner.ts";
import { realGit, realProcesses } from "./process.ts";
import { createQueueDriver, failedFiles, filesCommand, safeFile, WHOLE_CHECK } from "./queueDriver.ts";
import type { Notice, QueueDriver, QueueSink } from "./queueDriver.ts";
import { CHECK_HOLDER, createResources } from "./resources.ts";
import type { Resources } from "./resources.ts";

const restoreGitConfig = isolateGitConfig();
const dir = mkdtempSync(join(tmpdir(), "scopesoup-queue-"));
const stores: { close(): void }[] = [];
after(() => {
  stores.forEach((store) => store.close());
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restoreGitConfig();
});

const seed = join(dir, "seed");
mkdirSync(seed);
git(seed, "init", "-q", "-b", "main");
writeFileSync(join(seed, "README.md"), "synthetic project\n");
mkdirSync(join(seed, "test"));
writeFileSync(join(seed, "test", "flaky.test.js"), "// synthetic\n");
git(seed, "add", ".");
git(seed, "commit", "-q", "-m", "first");

/**
 * Fails, naming a test file, when the repository has broken.txt; fails once when it has flaky.txt
 * (the first run leaves a marker outside the repository); passes otherwise.
 */
function checkCommand(marker: string): string[] {
  const script = `const fs = require('fs');
if (fs.existsSync('broken.txt')) { console.log('FAIL test/broken.test.js'); process.exit(1); }
if (fs.existsSync('flaky.txt') && !fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); console.log('FAIL test/flaky.test.js'); process.exit(1); }
console.log('all good');`;
  return [process.execPath, "-e", script];
}

/** For the rerun: writes the files it was given to `log`, and passes. */
function rerunCommand(log: string): string[] {
  return [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(log)}, process.argv.slice(1).join(',') + '|');`, "{files}"];
}

interface World {
  remote: string;
  /** The clone the items' branches are made in. */
  work: string;
  driver: QueueDriver;
  notes: string[];
  /** The data each note was written with. */
  noteData: { kind: string; data?: Record<string, unknown> }[];
  notices: Notice[];
  sink: QueueSink;
  config: ProjectConfig;
  /** Where the rerun command wrote its files. */
  rerunLog: string;
  /** The limited resources, and the extra environment each check was given. */
  resources: Resources;
  checkEnvs: (Record<string, string> | undefined)[];
}

let count = 0;
/** Pause merge queue and Stop, as the driver reads them; `onCheck` runs as each check starts (to press one mid-check). */
interface Switches {
  paused: boolean;
  stopped: boolean;
  onCheck?: () => void;
}

function world(over: { remoteUrl?: string; rerunFiles?: boolean; settings?: Record<string, number>; ambient?: Record<string, string>; switches?: Switches; setup?: string[]; resources?: Record<string, unknown>[] } = {}): World {
  const name = `w${++count}`;
  const remote = join(dir, `${name}.git`);
  git(dir, "clone", "-q", "--bare", seed, remote);
  const work = join(dir, `${name}-work`);
  git(dir, "clone", "-q", remote, work);
  const result = validateConfig({
    project: "p", machineName: "laptop-a", repoPath: work, workspacesDir: join(dir, `${name}-spaces`), level: 4,
    remoteUrl: over.remoteUrl ?? remote, checkCommand: checkCommand(join(dir, `${name}-marker`)),
    ...(over.setup ? { setupCommand: over.setup } : {}),
    ...(over.resources ? { resources: over.resources } : {}),
    ...(over.rerunFiles ? { rerunFilesCommand: rerunCommand(join(dir, `${name}-rerun.txt`)) } : {}),
    ...(over.settings ? { settings: Object.fromEntries(Object.entries(over.settings).map(([key, value]) => [key, { value, reason: "test" }])) } : {}),
  }, dir);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const config = result.config;
  const store = openStore(join(dir, `${name}.sqlite`));
  stores.push(store);
  const notes: string[] = [];
  const notices: Notice[] = [];
  let minute = 0;
  const resources = createResources({ store, config: () => config, now: () => new Date(Date.UTC(2030, 0, 1)).toISOString() });
  const checkEnvs: (Record<string, string> | undefined)[] = [];
  const driver = createQueueDriver({
    resources,
    store, config: () => config,
    // `ambient` stands for the server's own environment, given to this driver's git calls only.
    git: over.ambient ? (args, cwd, input, env) => realGit(args, cwd, input, { ...over.ambient, ...env }) : realGit,
    runCheck: (command, cwd, timeoutMs, stop, extraEnv) => {
      over.switches?.onCheck?.();
      checkEnvs.push(extraEnv);
      return createCheckRunner(realProcesses)(command, cwd, timeoutMs, stop, extraEnv);
    },
    now: () => new Date(Date.UTC(2030, 0, 1, 0, minute++)).toISOString(),
    paused: () => over.switches?.paused ?? false,
    stopped: () => over.switches?.stopped ?? false,
  });
  const noteData: { kind: string; data?: Record<string, unknown> }[] = [];
  const sink: QueueSink = { note: (kind, reason, data) => { notes.push(`${kind}: ${reason}`); noteData.push({ kind, data }); }, deliver: async (notice) => void notices.push(notice) };
  return { remote, work, driver, notes, noteData, notices, sink, config, rerunLog: join(dir, `${name}-rerun.txt`), resources, checkEnvs };
}

const item = (id: string): Ref => ({ host: "test", kind: "work", id });

/** A branch with one commit that adds `file`, made from the remote's main branch. */
function branch(w: World, id: string, file: string, text = `${id}\n`): string {
  const name = `scopesoup/${id}`;
  git(w.work, "checkout", "-q", "-B", name, "origin/main");
  writeFileSync(join(w.work, file), text);
  git(w.work, "add", ".");
  git(w.work, "commit", "-q", "-m", `item ${id}`);
  return name;
}

async function ready(w: World, id: string, file: string): Promise<void> {
  const result = await w.driver.enqueue(item(id), branch(w, id, file), w.work, [file]);
  assert.deepEqual(result.ok, true, JSON.stringify(result));
}

const remoteFiles = (w: World): string[] => git(w.remote, "ls-tree", "--name-only", "main").split("\n");
const checks = (w: World): string[] => w.notes.filter((note) => note.startsWith("orchestrator.queue_check"));
const merged = (w: World): string[] => w.notices.flatMap((n) => (n.kind === "mark-merged" ? n.members.map((m) => m.change.id) : []));
const sentBack = (w: World): string[] => w.notices.flatMap((n) => (n.kind === "send-back" ? [n.change.id] : []));

describe("queueDriver", { concurrency: 4 }, () => {
test("failedFiles reads node's report and FAIL lines, and names the whole check when it finds none", () => {
  const out = "\u2716 failing tests:\n\ntest at file:///C:/work/queue/test/a.test.js:3:1\n\u2716 x (1ms)\nFAIL src/b.spec.ts > thing\n";
  assert.deepEqual(failedFiles(out, "C:\\work\\queue"), ["test/a.test.js", "src/b.spec.ts"]);
  assert.deepEqual(failedFiles("Segmentation fault"), [WHOLE_CHECK]);
});

test("failedFiles reads the N failed: block of Scope Soup's own runner", () => {
  const out = [
    "100 passed",
    "2 failed:",
    "  src/hosts/metaBranch/writer.test.ts:38  a local write (no remote) starts at most 5 git processes, result included",
    "    spawn EPERM",
    "  src/orchestrator/mergeQueue.test.ts:97  a rebased merging keeps the session as author ...",
    "    spawnSync git EPERM",
    "",
  ].join("\n");
  assert.deepEqual(failedFiles(out), ["src/hosts/metaBranch/writer.test.ts", "src/orchestrator/mergeQueue.test.ts"]);
});

test("a green batch merges: three changes are built into one chain, checked once, and pushed fast-forward", async () => {
  const w = world();
  for (const id of ["1", "2", "3"]) await ready(w, id, `f${id}.txt`);
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w).sort(), ["1", "2", "3"]);
  assert.deepEqual(sentBack(w), []);
  assert.equal(checks(w).length, 1, w.notes.join("\n"));
  assert.deepEqual(remoteFiles(w).filter((file) => file.startsWith("f")), ["f1.txt", "f2.txt", "f3.txt"]);
  // What was pushed is the commit the check passed on: the last member's commit of the chain.
  const last = w.notices.flatMap((n) => (n.kind === "mark-merged" ? n.members : [])).at(-1);
  assert.equal(git(w.remote, "rev-parse", "main"), last?.sha);
  // The remote history is a straight line on top of the old main: nothing was rewritten.
  assert.equal(git(w.remote, "rev-list", "--merges", "--count", "main"), "0");
  assert.equal(git(w.remote, "rev-list", "--count", "main"), "4");
  assert.equal(w.driver.state().batches.at(-1)?.status, "done");
});

test("the setup runs in the queue's clone once before the first check, not again while nothing watched changes", async () => {
  const log = join(dir, `setup-${count + 1}.log`);
  const w = world({ setup: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(log)}, 'ran ' + process.cwd() + '|')`] });
  await ready(w, "1", "f1.txt");
  await w.driver.drain(w.sink);
  await ready(w, "2", "f2.txt");
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), ["1", "2"], w.notes.join("\n"));
  assert.equal(readFileSync(log, "utf8").split("|").filter((entry) => entry !== "").length, 1);
  assert.equal(w.notes.filter((note) => note.startsWith("orchestrator.setup_ran")).length, 1);
});

test("a failed setup in the queue's clone pauses the queue as the setup's failure: no red check, nothing sent back or pushed", async () => {
  const w = world({ setup: [process.execPath, "-e", "console.log('installing'); process.exit(3)"] });
  const before = git(w.remote, "rev-parse", "main");
  await ready(w, "1", "f1.txt");
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), []);
  assert.deepEqual(sentBack(w), []);
  assert.equal(checks(w).length, 0);
  assert.equal(git(w.remote, "rev-parse", "main"), before);
  // The pause reason names the outcome only; the output stays in the local note (the Queue page on this machine).
  assert.match(w.driver.pausedWhy() ?? "", /^The check could not be run: Setup failed in the queue's clone on [0-9a-f]{7} \(exit 3\); the output is on Scope Soup's board on laptop-a\. This is the project's setup, not a red check\.$/);
  assert.equal((w.driver.pausedWhy() ?? "").includes("installing"), false);
  assert.ok(w.notes.some((note) => note.startsWith("orchestrator.queue_problem") && /it has not run in this folder yet\) The setup exited with code 3\. The end of its output:\ninstalling/.test(note)));
});

test("a check that needs a resource held by a session waits without pausing the queue, and runs with the unit once it is free", async () => {
  const w = world({ resources: [{ name: "rig", units: 1, neededBy: ["check"], env: { RIG: "rig-{{unit}}" } }] });
  assert.equal((await w.resources.take("test:work:9", "implement for 9", "check")).ok, true);
  await ready(w, "1", "f1.txt");
  await w.driver.drain(w.sink);
  assert.deepEqual(checks(w), []);
  assert.equal(w.driver.pausedWhy(), null);
  assert.deepEqual(w.notes.filter((note) => note.startsWith("orchestrator.queue_resource_wait")), ["orchestrator.queue_resource_wait: The check of batch 1 waits: all 1 unit(s) of rig are held: implement for 9."]);
  await w.driver.drain(w.sink);
  assert.equal(w.notes.filter((note) => note.startsWith("orchestrator.queue_resource_wait")).length, 1);
  await w.resources.give("test:work:9");
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), ["1"], w.notes.join(" | "));
  assert.deepEqual(w.checkEnvs, [{ RIG: "rig-1" }]);
  // The check gave its unit back.
  assert.equal((await w.resources.take(CHECK_HOLDER, "the next check", "check")).ok, true);
});

test("Pause merge queue during a running check lets that batch merge, and then no new batch starts", async () => {
  const switches: Switches = { paused: false, stopped: false };
  switches.onCheck = () => void (switches.paused = true);
  const w = world({ switches });
  await ready(w, "1", "f1.txt");
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), ["1"], w.notes.join("\n"));
  assert.ok(remoteFiles(w).includes("f1.txt"), "the checked commit was pushed");
  // Still paused: a change handed over earlier waits; no chain is built and nothing is checked or pushed.
  await ready(w, "2", "f2.txt");
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), ["1"]);
  assert.equal(checks(w).length, 1);
  assert.ok(!remoteFiles(w).includes("f2.txt"));
  // Start merge queue: it goes on.
  switches.paused = false;
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), ["1", "2"]);
});

test("Stop during a running check cuts it off: nothing is pushed, and the batch goes on after Start merge queue", async () => {
  const switches: Switches = { paused: false, stopped: false };
  switches.onCheck = () => void (switches.stopped = switches.paused = true);
  const w = world({ switches });
  const before = git(w.remote, "rev-parse", "main");
  await ready(w, "1", "f1.txt");
  await w.driver.drain(w.sink);
  // The check is stopped (or, when it beat the stop, its result is not pushed).
  assert.deepEqual(merged(w), []);
  assert.equal(git(w.remote, "rev-parse", "main"), before, "nothing was pushed");
  switches.onCheck = undefined;
  switches.stopped = switches.paused = false;
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), ["1"]);
});

test("a queued change keeps the session as author and has Scope Soup as committer, with no personal email", async () => {
  const w = world({ ambient: { GIT_COMMITTER_NAME: "A Person", GIT_COMMITTER_EMAIL: "person@example.com" } });
  const session = "Scope Soup implement 1 (sonnet) <scopesoup@box.invalid>";
  git(w.work, "config", "user.name", "A Person");
  git(w.work, "config", "user.email", "person@example.com");
  const name = branch(w, "1", "a.txt");
  git(w.work, "commit", "-q", "--amend", "--no-edit", `--author=${session}`);
  assert.equal((await w.driver.enqueue(item("1"), name, w.work, ["a.txt"])).ok, true);
  // A committer set in the server's own environment must not win over Scope Soup. It is given to this
  // driver's git calls only (never through process.env, which the tests running beside this one share).
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), ["1"], w.notes.join("\n"));
  const ids = git(w.remote, "log", "-1", "--format=%an|%ae|%cn|%ce", "main");
  assert.equal(ids, "Scope Soup implement 1 (sonnet)|scopesoup@box.invalid|Scope Soup|scopesoup@queue.invalid");
  assert.doesNotMatch(ids, /person|A Person/);
});

test("a flaky red batch merges after the failed files pass on a rerun of the same commit", async () => {
  const w = world();
  await ready(w, "1", "a.txt");
  await ready(w, "2", "flaky.txt");
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w).sort(), ["1", "2"]);
  assert.deepEqual(sentBack(w), []);
  assert.equal(checks(w).length, 2, w.notes.join("\n"));
  assert.match(checks(w)[0] ?? "", /failed/);
  assert.match(checks(w)[1] ?? "", /Rerun.*passed/);
  const flake = w.notices.find((n) => n.kind === "file-flake");
  assert.deepEqual(flake?.kind === "file-flake" ? flake.files : [], ["test/flaky.test.js"]);
  assert.ok(remoteFiles(w).includes("flaky.txt"));
  // The failed run's event names the test and keeps an excerpt, though the batch merged.
  const failed = w.noteData.filter((n) => n.kind === "orchestrator.queue_check" && n.data?.passed === false);
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0]?.data?.files, ["test/flaky.test.js"]);
  assert.match(String(failed[0]?.data?.excerpt), /FAIL test\/flaky\.test\.js/);
  // A passing run carries neither.
  const green = w.noteData.find((n) => n.kind === "orchestrator.queue_check" && n.data?.passed === true);
  assert.equal(green?.data && "files" in green.data, false);
});

test("a bad change is bisected out and sent back; the others merge and the bad one never reaches the main branch", async () => {
  const w = world();
  await ready(w, "1", "a.txt");
  await ready(w, "2", "broken.txt");
  await ready(w, "3", "c.txt");
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w).sort(), ["1", "3"]);
  assert.deepEqual(sentBack(w), ["2"]);
  const back = w.notices.find((n) => n.kind === "send-back");
  assert.ok(back?.kind === "send-back" && back.reason.kind === "culprit");
  if (back?.kind === "send-back" && back.reason.kind === "culprit") assert.ok(back.reason.files.includes("test/broken.test.js"), JSON.stringify(back.reason));
  const files = remoteFiles(w);
  assert.ok(files.includes("a.txt") && files.includes("c.txt"));
  assert.ok(!files.includes("broken.txt"));
  // Every pushed commit was checked: no push without a passing check on that very commit.
  const passed = w.notes.filter((note) => /Check.*passed/.test(note)).length;
  assert.ok(passed >= 1);
  assert.equal(git(w.remote, "rev-list", "--merges", "--count", "main"), "0");
});

test("a change that conflicts with the one ahead of it is sent back as a conflict", async () => {
  const w = world();
  await ready(w, "1", "same.txt");
  await ready(w, "2", "same.txt");
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), ["1"]);
  const back = w.notices.find((n) => n.kind === "send-back");
  assert.ok(back?.kind === "send-back" && back.change.id === "2" && back.reason.kind === "conflict");
  if (back?.kind === "send-back" && back.reason.kind === "conflict") assert.equal(back.reason.with?.id, "1");
});

test("a main branch that moved before the push means a new chain on the new main, never a push of the old one", async () => {
  const w = world();
  await ready(w, "1", "a.txt");
  // Someone else pushes before the queue runs.
  const other = join(dir, `other-${count}`);
  git(dir, "clone", "-q", w.remote, other);
  writeFileSync(join(other, "outside.txt"), "x\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "outside");
  git(other, "push", "-q", "origin", "main");
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), ["1"]);
  const files = remoteFiles(w);
  assert.ok(files.includes("outside.txt") && files.includes("a.txt"));
  assert.equal(git(w.remote, "rev-list", "--count", "main"), "3");
});

test("nothing is pushed to a repository other than the configured one, and nothing is queued", async () => {
  const w = world({ remoteUrl: join(dir, "does-not-exist.git") });
  const result = await w.driver.enqueue(item("1"), branch(w, "1", "a.txt"), w.work, ["a.txt"]);
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(w.config.workspacesDir, "queue", ".git")), false);
  assert.deepEqual(w.driver.state().entries, []);
});

test("a change that left the queue is not built", async () => {
  const w = world();
  await ready(w, "1", "a.txt");
  w.driver.reconcile(new Set());
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w), []);
  assert.ok(!remoteFiles(w).includes("a.txt"));
});

test("a rerun runs only the failed files when the project names a command that takes files", async () => {
  const w = world({ rerunFiles: true });
  await ready(w, "1", "a.txt");
  await ready(w, "2", "flaky.txt");
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w).sort(), ["1", "2"], w.notes.join("\n"));
  assert.equal(readFileSync(w.rerunLog, "utf8"), "test/flaky.test.js|");
  assert.match(checks(w)[1] ?? "", /Rerun of the failed files.*passed/);
  assert.ok(w.notices.some((n) => n.kind === "file-flake"));
});

test("a rerun runs the whole check when a failing file is not a file of the repository", async () => {
  const w = world({ rerunFiles: true });
  await ready(w, "1", "broken.txt");
  await w.driver.drain(w.sink);
  assert.match(checks(w)[1] ?? "", /Rerun of the whole check.*failed/, w.notes.join("\n"));
  assert.equal(existsSync(w.rerunLog), false);
  assert.deepEqual(sentBack(w), ["1"]);
});

test("without a command that takes files, the whole check is run again", async () => {
  const w = world();
  await ready(w, "1", "flaky.txt");
  await w.driver.drain(w.sink);
  assert.match(checks(w)[1] ?? "", /Rerun of the whole check.*passed/, w.notes.join("\n"));
  assert.deepEqual(merged(w), ["1"]);
});

test("safeFile accepts a plain file of the repository only, and filesCommand spreads the files", () => {
  assert.equal(safeFile(seed, "test/flaky.test.js"), true);
  for (const bad of ["", "-x", "../README.md", "/etc/passwd", "C:/x", "a\b", "test//flaky.test.js", "missing.test.js"]) assert.equal(safeFile(seed, bad), false, bad);
  assert.deepEqual(filesCommand(["node", "--test", "{files}"], ["a", "b"]), ["node", "--test", "a", "b"]);
  assert.equal(filesCommand(undefined, ["a"]), undefined);
});

test("the queue's settings give the batch size limits", async () => {
  const w = world({ settings: { queueMaxBatch: 2, queueMinBatch: 1 } });
  for (const id of ["1", "2", "3"]) await ready(w, id, `f${id}.txt`);
  await w.driver.drain(w.sink);
  assert.deepEqual(merged(w).sort(), ["1", "2", "3"]);
  assert.deepEqual(w.driver.state().batches.map((b) => b.members.length), [2, 1]);
});

test("the queue measures its own runs: durations, the rerun against the red run, and whether the report named the culprit", async () => {
  const w = world();
  await ready(w, "1", "flaky.txt");
  await ready(w, "2", "a.txt");
  await w.driver.drain(w.sink);
  const flaky = w.driver.state().measured;
  assert.equal(flaky?.f.n, 1, JSON.stringify(flaky));
  assert.ok((flaky?.f.rerunMs ?? 0) > 0 && (flaky?.f.fullMs ?? 0) > 0);
  assert.ok((flaky?.d.n ?? 0) >= 1);
  const v = world();
  await ready(v, "1", "broken.txt");
  await v.driver.drain(v.sink);
  assert.equal(v.driver.state().measured?.s.n, 1);
});

test("level 4 with one waiting change merges it through the queue as a batch of one: checked once, pushed fast-forward", async () => {
  const w = world();
  assert.equal(w.config.level, 4);
  await ready(w, "1", "a.txt");
  await w.driver.drain(w.sink);
  const batches = w.notices.filter((n) => n.kind === "mark-merged");
  assert.equal(batches.length, 1, w.notes.join("\n"));
  assert.deepEqual(merged(w), ["1"]);
  assert.equal(checks(w).length, 1, w.notes.join("\n"));
  const member = batches[0]?.kind === "mark-merged" ? batches[0].members[0] : undefined;
  assert.equal(git(w.remote, "rev-parse", "main"), member?.sha);
  assert.ok(remoteFiles(w).includes("a.txt"));
  assert.equal(git(w.remote, "rev-list", "--merges", "--count", "main"), "0");
});
});
