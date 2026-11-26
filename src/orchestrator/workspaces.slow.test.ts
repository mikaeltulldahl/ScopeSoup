// Workspaces from a pool of clones, against throwaway repositories shaped like the real ones: an
// outer repository with the project as a git submodule, and two full clones of it in the pool.
// Sessions are the fake `claude` (providers/claude/fake-claude.ts); nothing calls a host.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fixedConfig } from "../config/loader.ts";
import type { ProjectConfig } from "../config/types.ts";
import { validateConfig } from "../config/validate.ts";
import type { LogRecord, Ref, Session, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { KEYS } from "../store/keys.ts";
import { setRolesForTest } from "../store/control.ts";
import { openStore as openStoreAs } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { PathRefused, workBranch, workspaceKey } from "./paths.ts";
import { dryActions } from "./ports.ts";
import { realGit } from "./process.ts";
import type { SessionRequest } from "./ports.ts";
import { createRunner } from "./runner.ts";
import type { Runner } from "./runner.ts";
import { tick } from "./tick.ts";
import { HOLDINGS_KEY, itemRepository, loadHoldings, prepareClone, releaseClone, takeClone } from "./workspaces.ts";
import type { PoolDeps } from "./workspaces.ts";
import { isolateGitConfig } from "./fixtures/git-env.ts";
import { followRestore } from "./fixtures/restore.ts";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";

/** A store with agents and the merge queue started, as after a person pressed both Start buttons. */
const openStore = (path: string): ReturnType<typeof openStoreAs> => {
  const store = openStoreAs(path);
  setRolesForTest(store, "started");
  store.setValue(KEYS.mergeQueue, "started");
  return store;
};

const FAKE = join(import.meta.dirname, "providers", "claude", "fake-claude.ts");
const SUBDIR = join("modules", "project");
const T0 = Date.parse("2026-11-18T10:00:00Z");

// The tests' git, the code's git and the fake claude's git see none of this machine's git settings.
const restoreGitConfig = isolateGitConfig();
const dirs: string[] = [];
const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restoreGitConfig();
});

/** Git with a fixed identity and no help from the machine's own settings on line endings. Local paths may be cloned as submodules. */
function git(cwd: string, ...args: string[]): string {
  return gitWith({}, cwd, ...args);
}

function gitWith(env: Record<string, string>, cwd: string, ...args: string[]): string {
  return execFileSyncRetrying("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", ...args], {
    cwd, stdio: "pipe", encoding: "utf8", env: { ...process.env, ...env },
  }).trim();
}

interface Repos {
  dir: string;
  /** The bare remote of the project's repository. */
  project: string;
  clones: { a: string; b: string };
  /** The project's repository inside each clone. */
  repo: (clone: string) => string;
}

/** The project (a bare remote), an outer repository with it as a submodule, and two clones of the outer one. */
function repos(): Repos {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-pool-"));
  dirs.push(dir);
  const seed = join(dir, "seed-project");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "synthetic project\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "project: first");
  const project = join(dir, "project.git");
  git(dir, "clone", "-q", "--bare", seed, project);

  const seedOuter = join(dir, "seed-outer");
  mkdirSync(seedOuter);
  git(seedOuter, "init", "-q", "-b", "main");
  writeFileSync(join(seedOuter, "tool.txt"), "the outer tool\n");
  git(seedOuter, "add", ".");
  git(seedOuter, "submodule", "add", "-q", project, "modules/project");
  git(seedOuter, "commit", "-q", "-m", "outer: with the project as a submodule");
  const outer = join(dir, "outer.git");
  git(dir, "clone", "-q", "--bare", seedOuter, outer);

  const clones = { a: join(dir, "pool", "a"), b: join(dir, "pool", "b") };
  mkdirSync(join(dir, "pool"));
  for (const clone of Object.values(clones)) {
    git(dir, "clone", "-q", "-c", "core.autocrlf=false", "--recurse-submodules", outer, clone);
    git(join(clone, SUBDIR), "config", "core.autocrlf", "false");
  }
  return { dir, project, clones, repo: (clone) => join(clone, SUBDIR) };
}

function poolConfig(r: Repos, raw: Record<string, unknown> = {}): ProjectConfig {
  const result = validateConfig({
    project: "synthetic", machineName: "laptop-a", repoPath: "seed-project", level: 2,
    workspaces: { kind: "pool", paths: ["pool/a", "pool/b"], projectSubdir: "modules/project" },
    claude: { path: process.execPath, prefixArgs: ["--disable-warning=ExperimentalWarning", FAKE] },
    settings: { maxParallelSessions: { value: 3, reason: "test" } },
    ...raw,
  }, r.dir);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

const ANSWER = { ready: true, size: "small", paths: ["work.txt"], hidesDecision: false, risk: "low", riskReason: "synthetic", done: true, summary: "Did it." };

function makeRunner(store: Store, config: ProjectConfig, clock: { ms: number }, env: Record<string, string> = {}): Runner {
  const runner = createRunner({
    store, config: () => config, now: () => clock.ms,
    env: { ...process.env, FAKE_CLAUDE_MODE: "ok", FAKE_CLAUDE_OUTPUT: JSON.stringify(ANSWER), FAKE_CLAUDE_COMMIT: "work.txt", ...env },
  });
  cleanups.push(() => runner.stopAll("test over"));
  return runner;
}

function ref(id: string): Ref {
  return { host: "fake", kind: "work", id };
}

function item(id: string): WorkItem {
  return { ref: ref(id), title: `Item ${id}`, state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: `2026-11-0${id}T00:00:00Z` };
}

function request(id: string): SessionRequest {
  return {
    role: "implement", subject: ref(id), attempt: 1, workspace: workspaceKey(ref(id)), branch: workBranch(ref(id)),
    vars: {
      project: "synthetic", mainBranch: "main", branch: workBranch(ref(id)), attempt: "1", itemId: id, itemTitle: `Item ${id}`,
      itemBody: "A body.", verification: "none", effects: "- none", summary: "", findings: "", allowedCommands: "- `git ...`", finish: "Commit and stop.",
    },
  };
}

/** What a clone's two repositories look like, to prove nothing was changed. */
function snapshot(r: Repos, clone: string): Record<string, string> {
  const repo = r.repo(clone);
  return {
    outerHead: git(clone, "rev-parse", "HEAD"),
    outerBranch: git(clone, "symbolic-ref", "--short", "HEAD"),
    outerIndex: git(clone, "ls-files", "--stage"),
    outerStaged: git(clone, "diff", "--cached", "--name-only"),
    gitmodules: readFileSync(join(clone, ".gitmodules"), "utf8"),
    tool: readFileSync(join(clone, "tool.txt"), "utf8"),
    repoHead: git(repo, "rev-parse", "HEAD"),
    repoStatus: git(repo, "status", "--porcelain"),
    repoBranches: git(repo, "branch", "--format=%(refname:short)"),
  };
}

// Every test starts at once: the three sets of tests at the end take longest and must not wait for a slot.
describe("workspaces", { concurrency: 12 }, () => {
test("two items get different clones, a third waits for one, and each item keeps its clone across its steps", async () => {
  const r = repos();
  const config = poolConfig(r);
  const store = openStore(":memory:");
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms).toISOString();
  for (const id of ["1", "2", "3"]) store.put(item(id), "sync", now());
  // A usage reading with room to spare, so the budget lets more than one session start.
  const resetsAt = new Date(T0 + 3600_000).toISOString();
  store.addUsageSample({ at: now(), status: "allowed", windows: [{ kind: "five_hour", utilization: 0.1, resetsAt }, { kind: "seven_day", utilization: 0.1, resetsAt }] });
  // The triage names no paths, so items 1 and 2 do not wait for each other over the same file (core/sameFiles.ts).
  const runner = makeRunner(store, config, clock, { FAKE_CLAUDE_OUTPUT: JSON.stringify({ ...ANSWER, paths: [] }) });
  const outerBefore = { a: snapshot(r, r.clones.a), b: snapshot(r, r.clones.b) };
  const run = () => tick({ store, runner, config: fixedConfig(config), actions: dryActions, now });
  const finish = async (report: Awaited<ReturnType<typeof run>>) => {
    for (const started of report.started) assert.equal((await runner.finished(started.sessionId)).status, "succeeded");
  };
  const holder = (id: string) => loadHoldings(store)[workspaceKey(ref(id))];

  // Triage: items 1 and 2 take the two clones; 3 does not start.
  const first = await run();
  assert.deepEqual(first.started.map((entry) => entry.item), [refKey(ref("1")), refKey(ref("2"))]);
  assert.equal(holder("1")?.clone, r.clones.a);
  assert.equal(holder("2")?.clone, r.clones.b);
  assert.equal(holder("3"), undefined);
  await finish(first);

  // Between steps the clones stay held, and the third item waits with that as the reason.
  const between = await run();
  assert.equal(between.started.length, 0);
  assert.equal(between.idle?.includes("3 waits: no clone of the pool is free (2 of 2 held by items under way)"), true, between.idle);
  assert.equal(holder("1")?.held, true);

  // Implement, in the same clones.
  clock.ms += 1000;
  const second = await run();
  assert.deepEqual(second.started.map((entry) => `${entry.item} ${entry.role}`), [`${refKey(ref("1"))} implement`, `${refKey(ref("2"))} implement`]);
  await finish(second);
  assert.equal(holder("1")?.clone, r.clones.a);
  assert.equal(holder("2")?.clone, r.clones.b);

  // The session's commits are on the item's branch inside the submodule; the outer repository is untouched.
  const repoA = r.repo(r.clones.a);
  assert.match(git(repoA, "log", "--format=%s", "scopesoup/1"), /fake: work\.txt/);
  assert.equal(git(repoA, "merge-base", "scopesoup/1", "refs/remotes/origin/main"), git(r.project, "rev-parse", "main"));
  assert.equal(git(repoA, "symbolic-ref", "--short", "HEAD"), "scopesoup/1");
  assert.match(git(r.repo(r.clones.b), "log", "--format=%s", "scopesoup/2"), /fake: work\.txt/);
  for (const name of ["a", "b"] as const) {
    const now = snapshot(r, r.clones[name]);
    for (const key of ["outerHead", "outerBranch", "outerIndex", "outerStaged", "gitmodules", "tool"]) {
      assert.equal(now[key], outerBefore[name][key], `${name}: ${key}`);
    }
  }
  assert.equal(git(r.clones.a, "branch", "--list", "scopesoup/*"), "", "no item branch in the outer repository");
  assert.equal(itemRepository(store, config, ref("1")), realpathSync(repoA));

  // Implemented (no reviewer). The fake committed but did not merge and names no pull request, so the items are parked for a
  // person; their clones are free, and item 3 takes one.
  const third = await run();
  assert.equal(loadJobs(store, "1"), "escalated");
  assert.equal(holder("1")?.held, false);
  assert.equal(holder("2")?.held, false);
  assert.deepEqual(third.started.map((entry) => entry.item), [refKey(ref("3"))]);
  assert.equal(holder("3")?.clone, r.clones.a);
  await finish(third);
  // The new item's branch starts from the project's main, not from the item before it.
  assert.equal(git(repoA, "merge-base", "scopesoup/3", "scopesoup/1"), git(r.project, "rev-parse", "main"));
  assert.match(git(repoA, "log", "--format=%s", "scopesoup/1"), /fake: work\.txt/);
  const kinds = store.eventsAfter(0, 10_000).map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "orchestrator.workspace_taken").length, 3);
  assert.equal(kinds.filter((kind) => kind === "orchestrator.workspace_freed").length, 2);
});

function loadJobs(store: Store, id: string): string | undefined {
  const jobs = JSON.parse(store.getValue("orchestrator.jobs") ?? "{}") as Record<string, { parked?: { as: string } }>;
  return jobs[refKey(ref(id))]?.parked?.as;
}

test("at level 3, implement is followed by review and nothing else: no checklist session", async () => {
  const r = repos();
  const config = poolConfig(r, { level: 3 });
  const store = openStore(":memory:");
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms).toISOString();
  store.put(item("1"), "sync", now());
  const resetsAt = new Date(T0 + 3600_000).toISOString();
  store.addUsageSample({ at: now(), status: "allowed", windows: [{ kind: "five_hour", utilization: 0.1, resetsAt }, { kind: "seven_day", utilization: 0.1, resetsAt }] });
  // One answer that every role's reading accepts: triage's, the implementer's and an approving review.
  const runner = makeRunner(store, config, clock, { FAKE_CLAUDE_OUTPUT: JSON.stringify({ ...ANSWER, verdict: "approve", findings: [] }) });
  const run = () => tick({ store, runner, config: fixedConfig(config), actions: dryActions, now });
  const roles: string[] = [];
  for (let round = 0; round < 8 && loadJobs(store, "1") === undefined; round++) {
    const report = await run();
    for (const started of report.started) {
      roles.push(started.role);
      assert.equal((await runner.finished(started.sessionId)).status, "succeeded");
    }
    clock.ms += 1000;
  }
  // The approval resumes the implementor to merge; the fake does not, so the item parked for a person.
  assert.deepEqual(roles, ["triage", "implement", "review", "implement"]);
  assert.equal(loadJobs(store, "1"), "escalated");
});

test("a clone with uncommitted changes in the project's repository is refused and left as it was", async () => {
  const r = repos();
  const config = poolConfig(r);
  const store = openStore(":memory:");
  const clock = { ms: T0 };
  const runner = makeRunner(store, config, clock);
  const repoA = r.repo(r.clones.a);
  writeFileSync(join(repoA, "README.md"), "a person's edit, not committed\n");
  writeFileSync(join(repoA, "notes.txt"), "a person's new file\n");
  const before = snapshot(r, r.clones.a);

  // The first item passes the dirty clone over and takes the other one.
  assert.equal(await runner.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1"))), null);
  assert.equal(loadHoldings(store)[workspaceKey(ref("1"))]?.clone, r.clones.b);
  const taken = store.eventsAfter(0, 100).find((event) => event.kind === "orchestrator.workspace_taken");
  assert.match(JSON.stringify(taken?.data), /Passed over: the clone .* has uncommitted changes/);

  // The second finds none: it waits, and the reason names the clone.
  const wait = await runner.takeWorkspace(ref("2"), workspaceKey(ref("2")), workBranch(ref("2")));
  assert.ok(wait);
  assert.ok(wait.includes(`the clone ${r.clones.a} is refused: it has uncommitted changes in modules/project`), wait);
  assert.match(wait, /README\.md/);
  // Started anyway, the session does not start, with the same reason.
  const session = await runner.start(request("2"));
  assert.equal(session.status, "failed");
  assert.equal(session.pid, undefined);
  assert.ok(session.endReason?.includes(r.clones.a), session.endReason);
  assert.deepEqual(snapshot(r, r.clones.a), before);
  assert.equal(readFileSync(join(repoA, "README.md"), "utf8"), "a person's edit, not committed\n");

  // A clone the item holds that a person switched to another branch and left changes in is refused too.
  const repoB = r.repo(r.clones.b);
  assert.equal((await runner.finished((await runner.start(request("1"))).ref.id)).status, "succeeded");
  git(repoB, "checkout", "-q", "-b", "someone-else");
  writeFileSync(join(repoB, "README.md"), "someone else's edit\n");
  const beforeB = snapshot(r, r.clones.b);
  const refused = await runner.start(request("1"));
  assert.match(refused.endReason ?? "", /^Refused: The clone .* has uncommitted changes in .* that do not belong to 1 \(it is on someone-else, not scopesoup\/1\)/);
  assert.deepEqual(snapshot(r, r.clones.b), beforeB);
});

test("which clone an item holds survives a restart, and deleting its branch forgets it", async () => {
  const r = repos();
  const config = poolConfig(r);
  const path = join(r.dir, "scopesoup.sqlite");
  const clock = { ms: T0 };
  const opened: Store[] = [];
  cleanups.push(() => {
    for (const each of opened) {
      try {
        each.close();
      } catch {
        // Closed already.
      }
    }
  });
  let store = openStore(path);
  opened.push(store);
  let runner = makeRunner(store, config, clock);
  assert.equal(await runner.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1"))), null);
  assert.equal((await runner.finished((await runner.start(request("1"))).ref.id)).status, "succeeded");
  store.close();

  store = openStore(path);
  opened.push(store);
  runner = makeRunner(store, config, clock);
  const events = store.lastSeq();
  assert.equal(await runner.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1"))), null);
  assert.equal(store.lastSeq(), events, "no new event: the item still holds its clone");
  assert.equal(loadHoldings(store)[workspaceKey(ref("1"))]?.clone, r.clones.a);
  assert.equal(await runner.takeWorkspace(ref("2"), workspaceKey(ref("2")), workBranch(ref("2"))), null);
  assert.equal(loadHoldings(store)[workspaceKey(ref("2"))]?.clone, r.clones.b);
  assert.deepEqual(await runner.changedPaths("scopesoup/1"), ["work.txt"]);

  // Parked: freed, the branch stays; then the item is finished and its branch deleted.
  await runner.releaseWorkspace(workspaceKey(ref("1")));
  const repoA = r.repo(r.clones.a);
  assert.equal(git(repoA, "status", "--porcelain"), "");
  assert.equal(itemRepository(store, config, ref("1")), realpathSync(repoA));
  await runner.deleteBranch("scopesoup/1");
  assert.equal(git(repoA, "branch", "--list", "scopesoup/1"), "");
  assert.equal(itemRepository(store, config, ref("1")), null);
  assert.equal(JSON.parse(store.getValue(HOLDINGS_KEY) ?? "{}")[workspaceKey(ref("1"))], undefined);
  await assert.rejects(() => runner.deleteBranch("main"), /Refusing to delete main/);
});

test("a review in a pool clone compares with the fetched main branch, so commits that merged meanwhile are not part of the change", async () => {
  const r = repos();
  const config = poolConfig(r);
  const store = openStore(":memory:");
  const runner = makeRunner(store, config, { ms: T0 });
  const other = join(r.dir, "other");
  git(r.dir, "clone", "-q", r.project, other);
  const mergeElsewhere = (name: string): void => {
    writeFileSync(join(other, name), "merged\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", `merged: ${name}`);
    git(other, "push", "-q", "origin", "main");
  };
  const repo = r.repo(r.clones.a);
  const staleMain = git(repo, "rev-parse", "main");

  // Earlier items merged after the clone was made; the item's branch starts from the fetched main.
  mergeElsewhere("earlier.txt");
  assert.equal((await runner.finished((await runner.start(request("1"))).ref.id)).status, "succeeded");
  // More merges while the item waits for review.
  mergeElsewhere("meanwhile.txt");
  // The reviewer changes nothing.
  const reviewer = makeRunner(store, config, { ms: T0 }, { FAKE_CLAUDE_COMMIT: "" });
  const review = await reviewer.finished((await reviewer.start({ ...request("1"), role: "review" })).ref.id);
  assert.equal(review.status, "succeeded");

  const prompt = String(readFileSync(review.streamPath ?? "", "utf8").split("\n").filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>).find((event) => event.subtype === "fake")?.prompt);
  const base = /git diff (\S+)\.\.\.HEAD/.exec(prompt)?.[1] ?? "";
  assert.equal(base, "origin/main");
  assert.equal(git(repo, "rev-parse", base), git(r.project, "rev-parse", "main"), "the base is the remote's newest main, fetched before the session");
  assert.equal(git(repo, "log", "--format=%s", `${base}..${workBranch(ref("1"))}`), "fake: work.txt", "only the item's own commit is the change");
  assert.notEqual(staleMain, git(r.project, "rev-parse", "main"));
  assert.equal(git(repo, "rev-parse", "main"), git(r.project, "rev-parse", "main"), "the clone's local main branch follows the remote's, so `git log main` is not stale");
});

test("the core rule on real paths applies to every clone of the pool", async () => {
  const r = repos();
  // In the configuration: a clone inside a real path is rejected.
  const rejected = validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "seed-project", workspaces: { kind: "pool", paths: ["pool/a", "pool/b"], projectSubdir: "modules/project" }, realPaths: ["pool/b"] }, r.dir);
  assert.equal(rejected.ok, false);
  assert.match(rejected.ok ? "" : rejected.errors.join("\n"), /the clone .*b overlaps the real path/);

  // At run time: a path marked real later is passed over.
  const config = poolConfig(r);
  config.realPaths = [r.clones.a];
  const store = openStore(":memory:");
  const runner = makeRunner(store, config, { ms: T0 });
  assert.equal(await runner.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1"))), null);
  assert.equal(loadHoldings(store)[workspaceKey(ref("1"))]?.clone, r.clones.b);
  assert.match((await runner.takeWorkspace(ref("2"), workspaceKey(ref("2")), workBranch(ref("2")))) ?? "", /marked as real\. Sessions never run there/);

  // A subfolder that is a link out of its clone is refused (a junction on Windows needs no privilege).
  const linked = join(r.dir, "pool", "c");
  mkdirSync(join(linked, "modules"), { recursive: true });
  symlinkSync(r.repo(r.clones.b), join(linked, SUBDIR), process.platform === "win32" ? "junction" : "dir");
  const config2 = poolConfig(r, { workspaces: { kind: "pool", paths: ["pool/c"], projectSubdir: "modules/project" } });
  const store2 = openStore(":memory:");
  const runner2 = makeRunner(store2, config2, { ms: T0 });
  assert.match((await runner2.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1")))) ?? "", /is not inside the clone/);
  const session = await runner2.start(request("1"));
  assert.match(session.endReason ?? "", /is not inside the clone/);
});

test("a subfolder that is a plain folder of the outer repository is refused, so git never runs in the outer one", async () => {
  const r = repos();
  const config = poolConfig(r, { workspaces: { kind: "pool", paths: ["pool/a"], projectSubdir: "modules" } });
  const store = openStore(":memory:");
  const runner = makeRunner(store, config, { ms: T0 });
  const before = snapshot(r, r.clones.a);
  const wait = await runner.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1")));
  assert.match(wait ?? "", /modules is not a repository of its own/);
  assert.deepEqual(snapshot(r, r.clones.a), before);
});

// --- After the local store is rebuilt from the items' logs ---------------------------------

/** The item as the store rebuilt from its log sees it: implemented at `sha`, next step review. */
function implementedAt(id: string, sha: string): WorkItem {
  const by = { who: "scopesoup", machine: "laptop-a", agent: true };
  const log: LogRecord[] = [
    { at: "2026-11-18T09:00:00.000Z", by, kind: "session", fields: { role: "implement", outcome: "succeeded", summary: "Did it.", next: "review" } },
    { at: "2026-11-18T09:00:01.000Z", by, kind: "revision", fields: { sha, branch: workBranch(ref(id)) } },
  ];
  return { ...item(id), log };
}

test("after the store is deleted and rebuilt from the log, the review runs in the clone that holds the item's newest revision", async () => {
  const r = repos();
  const config = poolConfig(r, { level: 3 });
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms).toISOString();
  const repoA = r.repo(r.clones.a);
  const repoB = r.repo(r.clones.b);

  // Implemented in clone b (clone a was held by item 2 meanwhile, then freed).
  const before = openStore(":memory:");
  const first = makeRunner(before, config, clock);
  assert.equal(await first.takeWorkspace(ref("2"), workspaceKey(ref("2")), workBranch(ref("2"))), null);
  assert.equal(await first.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1"))), null);
  assert.equal(loadHoldings(before)[workspaceKey(ref("1"))]?.clone, r.clones.b);
  assert.equal((await first.finished((await first.start(request("1"))).ref.id)).status, "succeeded");
  await first.releaseWorkspace(workspaceKey(ref("2")));
  const sha = git(repoB, "rev-parse", "scopesoup/1");

  // data/ deleted, Scope Soup started again: clone a comes first and is free, but clone b holds the work.
  const store = openStore(":memory:");
  store.put(implementedAt("1", sha), "sync", now());
  const runner = makeRunner(store, config, clock);
  const report = await tick({ store, runner, config: fixedConfig(config), actions: dryActions, now });
  assert.deepEqual(report.started.map((entry) => `${entry.item} ${entry.role}`), [`${refKey(ref("1"))} review`]);
  assert.equal(loadHoldings(store)[workspaceKey(ref("1"))]?.clone, r.clones.b);
  assert.equal(loadHoldings(store)[workspaceKey(ref("1"))]?.held, true);
  const started = report.started[0];
  if (!started) return;
  await runner.finished(started.sessionId);
  assert.equal(git(repoB, "merge-base", "--is-ancestor", sha, "scopesoup/1"), "", "the review ran on the branch with the work");
  assert.equal(git(repoA, "branch", "--list", "scopesoup/1"), "", "no fresh branch in the other clone");
  const taken = store.eventsAfter(0, 1000).find((event) => event.kind === "orchestrator.workspace_taken");
  assert.match(JSON.stringify(taken?.data), /holds 1's newest revision [0-9a-f]{12} \(from the item's log\), so it is the item's own/);
  assert.equal(store.eventsAfter(0, 1000).some((event) => event.kind === "orchestrator.back_to_implement"), false);

  // A detached HEAD at the revision, with the branch gone, is the item's too: the branch is made there again.
  git(repoB, "checkout", "-q", "--detach", sha);
  git(repoB, "branch", "-D", "scopesoup/1");
  const again = openStore(":memory:");
  assert.equal(await takeClone({ store: again, config, git: realGit, at: now() }, ref("1"), workspaceKey(ref("1")), workBranch(ref("1")), sha), null);
  assert.equal(loadHoldings(again)[workspaceKey(ref("1"))]?.clone, r.clones.b);
  assert.equal(git(repoB, "rev-parse", "scopesoup/1"), sha);
});

test("after a rebuild, when no clone has the item's newest revision, the item goes back to implement instead of a review on a fresh branch", async () => {
  const r = repos();
  const config = poolConfig(r, { level: 3 });
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms).toISOString();
  const store = openStore(":memory:");
  store.put(implementedAt("1", "1".repeat(40)), "sync", now());
  const runner = makeRunner(store, config, clock);
  const run = () => tick({ store, runner, config: fixedConfig(config), actions: dryActions, now });

  const first = await run();
  assert.equal(first.started.length, 0);
  assert.equal(loadHoldings(store)[workspaceKey(ref("1"))], undefined, "no clone taken");
  for (const clone of [r.clones.a, r.clones.b]) assert.equal(git(r.repo(clone), "branch", "--list", "scopesoup/1"), "");
  const back = store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.back_to_implement");
  assert.equal(back.length, 1);
  assert.match((back[0]?.data as { reason: string }).reason, /^review for 1 "Item 1" does not start: no clone of the pool has 1's newest revision 111111111111 on scopesoup\/1 or as its detached HEAD, so its work is not there to review or merge\. Nothing is reviewed or merged; next: implement\.$/);

  clock.ms += 1000;
  const second = await run();
  assert.deepEqual(second.started.map((entry) => entry.role), ["implement"]);
  const started = second.started[0];
  if (started) await runner.finished(started.sessionId);
});

// --- What Scope Soup passes over, and what it hands over ---------------------------------------------

const sets = new Map<string, Repos>();
/** One set of repositories for each group of tests below (a group runs one after the other); each test puts the clones back as it found them. */
function fixture(set: string): Repos {
  let r = sets.get(set);
  if (!r) sets.set(set, (r = repos()));
  return r;
}

function only(r: Repos, ...clones: string[]): ProjectConfig {
  return poolConfig(r, { workspaces: { kind: "pool", paths: clones.map((clone) => join("pool", clone)), projectSubdir: "modules/project" } });
}

function take(config: ProjectConfig, store: Store, id: string): Promise<string | null> {
  return takeClone({ store, config, git: realGit, at: new Date(T0).toISOString() }, ref(id), workspaceKey(ref(id)), workBranch(ref(id)));
}

function prepare(config: ProjectConfig, store: Store, id: string): Promise<string> {
  return prepareClone({ store, config, git: realGit, at: new Date(T0).toISOString() }, {
    item: ref(id), workspace: workspaceKey(ref(id)), branch: workBranch(ref(id)), mainBranch: "main", remote: "origin",
  });
}

/** The project's repository as a person left it: HEAD, branch, which operations are under way, status. */
function repoState(repo: string): string {
  let branch = "(detached)";
  try {
    branch = git(repo, "symbolic-ref", "--short", "HEAD");
  } catch {
    // Detached.
  }
  const operations = ["rebase-merge", "MERGE_HEAD"].map((name) => `${name}=${existsSync(resolve(repo, git(repo, "rev-parse", "--git-path", name)))}`);
  return [git(repo, "rev-parse", "HEAD"), branch, ...operations, git(repo, "status", "--porcelain"), git(repo, "branch", "--format=%(refname:short)")].join("\n");
}

function holding(id: string, clone: string, held: boolean): string {
  return JSON.stringify({ [workspaceKey(ref(id))]: { item: refKey(ref(id)), clone, branch: workBranch(ref(id)), held, at: new Date(T0).toISOString() } });
}

function escaped(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}


// --- Decision 34: a session's leftovers are discarded when its clone is freed ----------------------

/** Every file under `dir` with its content, without `.git` and the folders in `skip`. */
function files(dir: string, skip: string[] = [], base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const name = relative(base, full).split("\\").join("/");
    if (entry.name === ".git" || skip.includes(name)) continue;
    if (entry.isDirectory()) files(full, skip, base, out);
    else out[name] = readFileSync(full, "latin1");
  }
  return out;
}

/** The outer repository of a clone: HEAD, branch, index, status (its submodule aside) and every file outside the submodule. */
function outerState(clone: string): string {
  return JSON.stringify({
    head: git(clone, "rev-parse", "HEAD"), branch: git(clone, "symbolic-ref", "--short", "HEAD"), index: git(clone, "ls-files", "--stage"),
    status: git(clone, "status", "--porcelain", "--ignore-submodules=all"), files: files(clone, ["modules/project"]),
  }, null, 1);
}

/** The project's repository's index, files and stash, as a restore from the record must bring them back. */
function content(repo: string): string {
  return `${git(repo, "ls-files", "--stage")}\n${git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored")}\n${JSON.stringify(files(repo), null, 1)}`;
}

/** Everything a person could see in a clone: the outer repository, and the project's repository with its operations, stash, index and every file's content. */
function exactly(r: Repos, clone: string): string {
  const repo = r.repo(clone);
  const markers = ["rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"].map((name) => `${name}=${existsSync(resolve(repo, git(repo, "rev-parse", "--git-path", name)))}`);
  return [outerState(clone), repoState(repo), ...markers, git(repo, "stash", "list"), content(repo)].join("\n");
}

async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done(); waited += 20) {
    if (waited > 15_000) assert.fail("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function eventsOf(store: Store, kind: string): Record<string, unknown>[] {
  return store.eventsAfter(0, 1000).filter((event) => event.kind === kind).map((event) => event.data as Record<string, unknown>);
}

/** Ignores `*.ignored` in the project's repository of a clone, without touching a tracked file; returns how to undo it. */
function ignoreInRepo(repo: string): () => void {
  const exclude = resolve(repo, git(repo, "rev-parse", "--git-path", "info/exclude"));
  const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : null;
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, `${before ?? ""}\n*.ignored\n`);
  return () => (before === null ? rmSync(exclude) : writeFileSync(exclude, before));
}

/** A session record of item 1, as the runner leaves it. */
function sessionOf(id: string, status: Session["status"], startedMs: number, pid?: number): Session {
  return {
    ref: { host: "scopesoup", kind: "session", id }, role: "implement", subject: ref("1"), status, attempt: 1, startedAt: new Date(startedMs).toISOString(),
    ...(status === "running" ? {} : { finishedAt: new Date(startedMs).toISOString() }), ...(pid ? { pid } : {}),
  };
}



// Three sets of repositories, so that the tests below run three at a time; inside a set they run one after the other.
describe("on one set of repositories (a)", { concurrency: 1 }, () => {
test("an unreadable record of the holdings hands out no clone, keeps the last good one in use, and says so once", async () => {
  const r = fixture("a");
  const config = only(r, "a", "b");
  const store = openStore(":memory:");
  const kinds = () => store.eventsAfter(0, 100).map((event) => event.kind);

  // Never readable: nothing is handed out, nothing is written over it.
  store.setValue(HOLDINGS_KEY, "{not json");
  const wait = await take(config, store, "1");
  assert.match(wait ?? "", /cannot be read, so no clone is handed out/);
  await take(config, store, "2");
  assert.equal(store.getValue(HOLDINGS_KEY), "{not json");
  assert.equal(kinds().filter((kind) => kind === "orchestrator.workspaces_unreadable").length, 1);
  assert.match(JSON.stringify(store.eventsAfter(0, 10)[0]?.data), /not valid JSON/);
  await assert.rejects(prepare(config, store, "1"), /cannot be read/);

  // Readable again: handed out, and the event says so.
  store.setValue(HOLDINGS_KEY, "{}");
  assert.equal(await take(config, store, "1"), null);
  assert.equal(kinds().filter((kind) => kind === "orchestrator.workspaces_readable").length, 1);

  // Corrupted after a good write: the item holding a clone keeps it, a new item gets none, the record is not rewritten.
  store.setValue(HOLDINGS_KEY, "[1,2");
  assert.equal(await take(config, store, "1"), null);
  assert.match((await take(config, store, "2")) ?? "", /cannot be read/);
  assert.equal(loadHoldings(store)[workspaceKey(ref("1"))]?.clone, r.clones.a);
  assert.equal(store.getValue(HOLDINGS_KEY), "[1,2");
  assert.equal(kinds().filter((kind) => kind === "orchestrator.workspaces_unreadable").length, 2);
  // Valid JSON of the wrong shape is no better.
  store.setValue(HOLDINGS_KEY, "null");
  assert.match((await take(config, store, "2")) ?? "", /cannot be read/);
});

test("a freed clone is left exactly as it was when no session ran in the hold, it is on a person's branch, in a rebase, a session may still run, or the record cannot be written or is too large", async () => {
  const r = fixture("a");
  const repo = r.repo(r.clones.a);
  const home = git(repo, "rev-parse", "HEAD");
  const config = poolConfig(r, { workspaces: { kind: "pool", paths: ["pool/a"], projectSubdir: "modules/project" }, streamsDir: "streams-34" });
  const alive = new Set<number>();
  const free = async (sessions: Session[], extra: Partial<PoolDeps> = {}, cfg = config) => {
    const store = openStore(":memory:");
    store.setValue(HOLDINGS_KEY, holding("1", r.clones.a, true));
    for (const session of sessions) store.put(session, "test", session.startedAt);
    const before = exactly(r, r.clones.a);
    await releaseClone({ store, config: cfg, git: realGit, at: new Date(T0 + 5000).toISOString(), processes: { isAlive: (pid) => alive.has(pid) }, ...extra }, workspaceKey(ref("1")));
    assert.equal(exactly(r, r.clones.a), before, "left exactly as it was");
    assert.equal(loadHoldings(store)[workspaceKey(ref("1"))]?.held, false, "freed all the same");
    assert.equal(eventsOf(store, "orchestrator.workspace_discarded").length, 0);
    const reasons = eventsOf(store, "orchestrator.workspace_not_discarded").map((data) => String(data.reason));
    assert.equal(reasons.length, 1, reasons.join("\n"));
    return reasons[0] ?? "";
  };
  const ran = [sessionOf("s0", "succeeded", T0 + 1000, 1111)];
  const dirty = () => {
    writeFileSync(join(repo, "README.md"), "a person's edit\n");
    writeFileSync(join(repo, "notes.txt"), "a person's notes\n");
  };
  const clean = () => {
    git(repo, "checkout", "--", "README.md");
    rmSync(join(repo, "notes.txt"), { force: true });
  };

  // The item's branch, detached at its tip as a freed clone is left, with changes: but no session ran in this hold.
  git(repo, "checkout", "-q", "-b", "scopesoup/1");
  writeFileSync(join(repo, "work.txt"), "the item's work\n");
  git(repo, "add", "work.txt");
  git(repo, "commit", "-q", "-m", "the item's work");
  git(repo, "checkout", "-q", "--detach", "scopesoup/1");
  dirty();
  assert.match(await free([]), /no session of fake:work:1 ran in the clone since it was taken, so the changes are not a session's\. Nothing was touched/);
  // A session before the clone was taken (in another hold) does not count.
  assert.match(await free([sessionOf("s9", "succeeded", T0 - 1000, 1112)]), /no session of fake:work:1 ran in the clone/);
  // Nor does one that never got a process.
  assert.match(await free([sessionOf("s8", "failed", T0 + 1000)]), /no session of fake:work:1 ran in the clone/);

  // A session may still be running: by its record, or its root process is still there.
  assert.match(await free([...ran, sessionOf("s1", "running", T0 + 2000)]), /the session s1 of fake:work:1 is still running/);
  alive.add(4242);
  assert.match(await free([sessionOf("s2", "cancelled", T0 + 2000, 4242)]), /process 4242 of the session s2 is still there/);
  assert.match(await free(ran, { processes: undefined }), /there is no way to check that the item's sessions have ended/);

  // The record cannot be written, or would be too large: nothing goes, and a person must clean the clone.
  writeFileSync(join(r.dir, "not-a-folder"), "a file where the streams would go\n");
  const blocked = poolConfig(r, { workspaces: { kind: "pool", paths: ["pool/a"], projectSubdir: "modules/project" }, streamsDir: "not-a-folder" });
  assert.match(await free(ran, {}, blocked), /the record of what would go could not be written or verified .*a person must clean the clone/);
  assert.match(await free(ran, { recordCapBytes: 10 }), /the leftovers are too large to record \(the files to remove and the diffs come to 17 bytes, more than the 10 bytes a record may hold\), so a person must clean the clone/);
  assert.equal(existsSync(join(r.dir, "streams-34", "discarded")) ? readdirSync(join(r.dir, "streams-34", "discarded")).length : 0, 0, "no record was left");
  // The record would merge inside the clone.
  const inside = poolConfig(r, { workspaces: { kind: "pool", paths: ["pool/a"], projectSubdir: "modules/project" }, streamsDir: "pool/a/streams" });
  assert.match(await free(ran, {}, inside), /the record would be written inside the clone/);
  // Also when only the real path shows it: streamsDir reaches the clone through a link (a junction on Windows).
  symlinkSync(r.clones.a, join(r.dir, "streams-link"), process.platform === "win32" ? "junction" : "dir");
  const linked = poolConfig(r, { workspaces: { kind: "pool", paths: ["pool/a"], projectSubdir: "modules/project" }, streamsDir: "streams-link" });
  assert.match(await free(ran, {}, linked), /the record would be written inside the clone/);
  clean();

  // A person's branch.
  git(repo, "checkout", "-q", "-b", "my-work", home);
  dirty();
  assert.match(await free(ran), /the project's repository is on my-work, not on scopesoup\/1 or at its tip, so the changes may be a person's/);
  clean();
  git(repo, "checkout", "-q", "--detach", home);
  git(repo, "branch", "-D", "my-work");

  // The item's branch, but a person is in the middle of a rebase there (detached at the branch's tip).
  git(repo, "checkout", "-q", "scopesoup/1");
  gitWith({ GIT_SEQUENCE_EDITOR: 'sed -i -e "s/^pick/edit/"', GIT_EDITOR: "true" }, repo, "rebase", "-q", "-i", "HEAD~1");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "scopesoup/1"));
  dirty();
  assert.match(await free(ran), /a rebase is in progress \(rebase-merge\), so a person is working there\. Nothing was touched/);
  clean();
  git(repo, "rebase", "--abort");

  git(repo, "checkout", "-q", "--detach", home);
  git(repo, "branch", "-D", "scopesoup/1");
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("a clone freed by the sweep, where no session ever ran, keeps a person's edits exactly as they were", async () => {
  const r = fixture("a");
  const config = only(r, "a");
  const repo = r.repo(r.clones.a);
  const store = openStore(":memory:");
  const clock = { ms: T0 };
  const runner = makeRunner(store, config, clock);
  // Taken for an item that then never started; a person edits there (the clone looks free: detached at a commit a branch contains).
  assert.equal(await runner.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1"))), null);
  writeFileSync(join(repo, "README.md"), "a person's edit\n");
  writeFileSync(join(repo, "notes.txt"), "a person's notes\n");
  const before = exactly(r, r.clones.a);
  clock.ms += 1000;
  await tick({ store, runner, config: fixedConfig(config), actions: dryActions, now: () => new Date(clock.ms).toISOString() });
  assert.equal(loadHoldings(store)[workspaceKey(ref("1"))]?.held, false, "the sweep freed it");
  assert.equal(exactly(r, r.clones.a), before);
  assert.match(String(eventsOf(store, "orchestrator.workspace_not_discarded")[0]?.reason), /no session of fake:work:1 ran in the clone since it was taken/);
  assert.equal(eventsOf(store, "orchestrator.workspace_discarded").length, 0);
  git(repo, "checkout", "--", "README.md");
  rmSync(join(repo, "notes.txt"));
});

test("a discard that fails partway says exactly what was restored, removed and left, and where the full record is", async () => {
  const r = fixture("a");
  const repo = r.repo(r.clones.a);
  const home = git(repo, "rev-parse", "HEAD");
  const config = poolConfig(r, { workspaces: { kind: "pool", paths: ["pool/a"], projectSubdir: "modules/project" }, streamsDir: "streams-partway" });
  const store = openStore(":memory:");
  assert.equal(await prepare(config, store, "1"), realpathSync(repo));
  store.put(sessionOf("s0", "succeeded", T0, 1111), "test", new Date(T0).toISOString());
  writeFileSync(join(repo, "README.md"), "edited\n");
  writeFileSync(join(repo, "held-open.txt"), "a file another program holds open\n");
  writeFileSync(join(repo, "scratch.txt"), "scratch\n");
  await releaseClone({
    store, config, git: realGit, at: new Date(T0 + 1000).toISOString(), processes: { isAlive: () => false },
    removeFile: (path) => {
      if (path.endsWith("held-open.txt")) throw new Error("EBUSY: resource busy or locked, unlink");
      rmSync(path);
    },
  }, workspaceKey(ref("1")));
  const [discarded] = eventsOf(store, "orchestrator.workspace_discarded");
  const reason = String(discarded?.reason);
  assert.match(reason, /Restored from HEAD: README\.md\. Removed: scratch\.txt\. Left as they are: held-open\.txt \(it could not be removed: EBUSY: resource busy or locked, unlink\)\. A full copy is in .*streams-partway.*\. Still there, so the clone is passed over until a person cleans it: \?\? held-open\.txt\./);
  assert.doesNotMatch(reason, /Nothing was touched/);
  assert.deepEqual([discarded?.restored, discarded?.removed, discarded?.left], [1, 1, 1]);
  // The record describes what was discarded: the left file has no copy there (it is still in the clone), the removed one has.
  assert.equal(existsSync(join(String(discarded?.record), "files", "held-open.txt")), false);
  assert.equal(readFileSync(join(String(discarded?.record), "files", "scratch.txt"), "utf8"), "scratch\n");
  assert.deepEqual(JSON.parse(readFileSync(join(String(discarded?.record), "discarded.json"), "utf8")).left, [{ path: "held-open.txt", why: "it could not be removed: EBUSY: resource busy or locked, unlink" }]);
  assert.equal(eventsOf(store, "orchestrator.workspace_not_discarded").length, 0);
  rmSync(join(repo, "held-open.txt"));
  git(repo, "checkout", "-q", "--detach", home);
  git(repo, "branch", "-D", "scopesoup/1");
});
});
describe("on one set of repositories (b)", { concurrency: 1 }, () => {
test("a clean clone is handed out only when it is on the main branch, on an item branch, or on a detached HEAD that a branch contains", async () => {
  const r = fixture("b");
  const config = only(r, "a");
  const repo = r.repo(r.clones.a);
  const home = git(repo, "rev-parse", "HEAD");
  const branches = () => git(repo, "branch", "--format=%(refname:short)").split("\n").filter((branch) => branch !== "" && !branch.startsWith("("));
  const initial = branches();
  const back = () => {
    git(repo, "checkout", "-q", "--detach", home);
    for (const branch of branches()) if (!initial.includes(branch)) git(repo, "branch", "-D", branch);
  };
  const outcome = async () => {
    const before = repoState(repo);
    const wait = await take(config, openStore(":memory:"), "1");
    assert.equal(repoState(repo), before, "the clone is left as it was");
    return wait;
  };

  // As cloned: detached at a commit that origin/main contains.
  assert.equal(await outcome(), null);
  // On the main branch, and on an item branch of another item.
  git(repo, "checkout", "-q", "-B", "main", "refs/remotes/origin/main");
  assert.equal(await outcome(), null);
  git(repo, "checkout", "-q", "-b", "scopesoup/9");
  assert.equal(await outcome(), null);
  // On a person's own branch.
  git(repo, "checkout", "-q", "-b", "my-experiment");
  assert.match((await outcome()) ?? "", /the clone .* is refused: in modules\/project it is on the branch my-experiment, which looks like a person's work; it is left as it is/);
  back();
  // Detached at commits that no branch contains.
  git(repo, "commit", "-q", "--allow-empty", "-m", "loose");
  assert.match((await outcome()) ?? "", /is refused: in modules\/project it is on a detached HEAD at [0-9a-f]+ that no local or remote-tracking branch contains, which looks like a person's work/);
  // The same commit once a local branch holds it, and once only a remote-tracking branch does.
  git(repo, "branch", "kept");
  assert.equal(await outcome(), null);
  git(repo, "branch", "-D", "kept");
  git(repo, "update-ref", "refs/remotes/origin/kept", "HEAD");
  assert.equal(await outcome(), null);
  git(repo, "update-ref", "-d", "refs/remotes/origin/kept");
  back();
  assert.equal(git(repo, "rev-parse", "HEAD"), home);

  // The same check when the item already holds the clone and a person has put it on a branch of their own.
  const store = openStore(":memory:");
  store.setValue(HOLDINGS_KEY, holding("1", r.clones.a, true));
  git(repo, "checkout", "-q", "-b", "my-experiment");
  await assert.rejects(prepare(config, store, "1"), (error) => error instanceof PathRefused && /in modules\/project it is on the branch my-experiment, which looks like a person's work\. It is left as it is/.test(error.message));
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "my-experiment");
  back();
});

test("a clone taken for an item that has no work under way is freed at the next tick", async () => {
  const r = fixture("b");
  const config = only(r, "a", "b");
  const store = openStore(":memory:");
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms).toISOString();
  const runner = makeRunner(store, config, clock);
  const before = repoState(r.repo(r.clones.a));
  // Taken, but the item is not in the store (closed, or gone) and no job was ever written.
  assert.equal(await runner.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1"))), null);
  assert.equal(loadHoldings(store)[workspaceKey(ref("1"))]?.held, true);
  const report = await tick({ store, runner, config: fixedConfig(config), actions: dryActions, now });
  assert.equal(report.started.length, 0);
  assert.equal(loadHoldings(store)[workspaceKey(ref("1"))]?.held, false);
  const freed = store.eventsAfter(0, 100).filter((event) => event.kind === "orchestrator.workspace_freed");
  assert.equal(freed.length, 1);
  assert.match(JSON.stringify(freed[0]?.data), /was taken for fake:work:1, which has no work under way/);
  await tick({ store, runner, config: fixedConfig(config), actions: dryActions, now });
  assert.equal(store.eventsAfter(0, 100).filter((event) => event.kind === "orchestrator.workspace_freed").length, 1, "freed once");
  assert.equal(repoState(r.repo(r.clones.a)), before);
});

test("a stopped session's leftovers go when its clone is freed, ignored and kept build output stays, the record gives the diff back, the outer repository is untouched, and the next item claims the clone", async () => {
  const r = fixture("b");
  const repo = r.repo(r.clones.a);
  const home = git(repo, "rev-parse", "HEAD");
  const unignore = ignoreInRepo(repo);
  const config = poolConfig(r, { workspaces: { kind: "pool", paths: ["pool/a"], projectSubdir: "modules/project", keep: ["build/"] }, streamsDir: "streams-42" });
  const outerBefore = outerState(r.clones.a);
  const store = openStore(":memory:");
  const runner = makeRunner(store, config, { ms: T0 }, {
    FAKE_CLAUDE_MODE: "hang",
    FAKE_CLAUDE_LEAVE: JSON.stringify({ "README.md": "edited by the session\n", "notes/new.txt": "a new file\n", "out/model.ignored": "compiled\n", "build/cache.bin": "kept cache\n" }),
  });

  // The session works, leaves its changes, and is stopped.
  assert.equal(await runner.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1"))), null);
  const session = await runner.start(request("1"));
  assert.equal(session.status, "running", session.endReason);
  await until(() => existsSync(join(repo, "build", "cache.bin")));
  runner.stopAll("Stopped by a person.");
  assert.equal((await runner.finished(session.ref.id)).status, "cancelled");
  const tip = git(repo, "rev-parse", "scopesoup/1");
  assert.equal(git(repo, "status", "--porcelain"), "M README.md\n?? build/\n?? notes/");

  // Freed: its own changes are gone, the ignored file and the kept one are there with the same content.
  await runner.releaseWorkspace(workspaceKey(ref("1")), "The item parked.");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "synthetic project\n");
  assert.equal(existsSync(join(repo, "notes", "new.txt")), false);
  assert.equal(readFileSync(join(repo, "out", "model.ignored"), "utf8"), "compiled\n");
  assert.equal(readFileSync(join(repo, "build", "cache.bin"), "utf8"), "kept cache\n");
  assert.equal(git(repo, "status", "--porcelain"), "?? build/");
  assert.equal(git(repo, "rev-parse", "HEAD"), tip);
  assert.equal(outerState(r.clones.a), outerBefore, "the outer repository is identical");
  const [discarded] = eventsOf(store, "orchestrator.workspace_discarded");
  assert.ok(discarded, "an event names the discard");
  assert.equal(discarded.clone, r.clones.a);
  assert.deepEqual([discarded.restored, discarded.removed, discarded.left], [1, 1, 0]);
  assert.match(String(discarded.reason), /freed by fake:work:1\. Restored from HEAD: README\.md\. Removed: notes\/new\.txt\. Kept: build\/cache\.bin\. A full copy is in /);

  // The record on the laptop, beside the streams, gives it all back.
  const record = String(discarded.record);
  assert.ok(record.startsWith(join(r.dir, "streams-42", "discarded")), record);
  const manifest = JSON.parse(readFileSync(join(record, "discarded.json"), "utf8"));
  assert.deepEqual([manifest.restored, manifest.removed, manifest.left], [["README.md"], ["notes/new.txt"], []]);
  assert.match(String(discarded.reason), /discarded\.json there lists every path and what happened to it, and RESTORE\.md says how to bring back what was discarded/);
  followRestore(record);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "edited by the session\n");
  assert.equal(readFileSync(join(repo, "notes", "new.txt"), "utf8"), "a new file\n");
  git(repo, "checkout", "--", "README.md");
  rmSync(join(repo, "notes", "new.txt"));

  // The next item claims the clone (the kept build output does not count as a person's changes).
  assert.equal(await runner.takeWorkspace(ref("2"), workspaceKey(ref("2")), workBranch(ref("2"))), null);
  assert.equal(loadHoldings(store)[workspaceKey(ref("2"))]?.clone, r.clones.a);

  for (const folder of ["build", "out", "notes"]) rmSync(join(repo, folder), { recursive: true, force: true });
  unignore();
  git(repo, "checkout", "-q", "--detach", home);
  git(repo, "branch", "-D", "scopesoup/1");
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("a changed tracked file that matches workspaces.keep is left as it is, the rest goes, and the clone is then passed over", async () => {
  const r = fixture("b");
  const repo = r.repo(r.clones.a);
  const home = git(repo, "rev-parse", "HEAD");
  const config = poolConfig(r, { workspaces: { kind: "pool", paths: ["pool/a"], projectSubdir: "modules/project", keep: ["README.md"] }, streamsDir: "streams-keep" });
  const store = openStore(":memory:");
  assert.equal(await prepare(config, store, "1"), realpathSync(repo));
  store.put(sessionOf("s0", "succeeded", T0, 1111), "test", new Date(T0).toISOString());
  writeFileSync(join(repo, "README.md"), "rebuilt by the session\n");
  writeFileSync(join(repo, "scratch.txt"), "the session's scratch file\n");
  const outerBefore = outerState(r.clones.a);
  await releaseClone({ store, config, git: realGit, at: new Date(T0 + 1000).toISOString(), processes: { isAlive: () => false } }, workspaceKey(ref("1")));
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "rebuilt by the session\n");
  assert.equal(existsSync(join(repo, "scratch.txt")), false);
  assert.equal(outerState(r.clones.a), outerBefore);
  const [discarded] = eventsOf(store, "orchestrator.workspace_discarded");
  assert.match(String(discarded?.reason), /Restored from HEAD: nothing\. Removed: scratch\.txt\. Kept: README\.md\. A full copy is in .*\. Still there, so the clone is passed over until a person cleans it: M README\.md\./);
  assert.match((await take(config, openStore(":memory:"), "2")) ?? "", /has uncommitted changes in modules\/project that belong to no item \(M README\.md\)/);

  git(repo, "checkout", "--", "README.md");
  git(repo, "checkout", "-q", "--detach", home);
  git(repo, "branch", "-D", "scopesoup/1");
});
});
describe("on one set of repositories (c)", { concurrency: 1 }, () => {
test("a clone in the middle of a person's operation is passed over or refused, even with a clean tree, and left exactly as it was", async () => {
  const r = fixture("c");
  const config = only(r, "a");
  const repo = r.repo(r.clones.a);
  const home = git(repo, "rev-parse", "HEAD");
  const store = openStore(":memory:");

  // A rebase paused at an `edit`: the tree is clean, HEAD is detached at a commit a branch contains.
  const editing = { GIT_SEQUENCE_EDITOR: 'sed -i -e "s/^pick/edit/"', GIT_EDITOR: "true" };
  gitWith(editing, repo, "rebase", "-q", "-i", "--root");
  assert.equal(git(repo, "status", "--porcelain"), "");
  let before = repoState(repo);
  assert.match(before, /rebase-merge=true/);
  assert.match((await take(config, store, "1")) ?? "", new RegExp(`the clone ${escaped(r.clones.a)} is refused: a rebase is in progress \\(rebase-merge\\) in modules/project, so a person is working there`));
  assert.deepEqual(loadHoldings(store), {});
  assert.equal(repoState(repo), before);
  git(repo, "rebase", "--abort");

  // The item holds the clone; then a person starts a rebase in it: the session is refused, and nothing changes.
  assert.equal(await take(config, store, "1"), null);
  gitWith(editing, repo, "rebase", "-q", "-i", "--root");
  before = repoState(repo);
  await assert.rejects(prepare(config, store, "1"), (error) => error instanceof PathRefused && /rebase is in progress \(rebase-merge\).*It is left as it is/.test(error.message) && error.message.includes(r.clones.a));
  assert.equal(repoState(repo), before);
  git(repo, "rebase", "--abort");
  assert.equal(repoState(repo).includes("rebase-merge=true"), false);
  // Back to normal, the same item gets its branch.
  assert.equal(await prepare(config, store, "1"), realpathSync(repo));
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "scopesoup/1");
  git(repo, "checkout", "-q", "--detach", home);
  git(repo, "branch", "-D", "scopesoup/1");

  // A merge stopped before its commit, with nothing to show in the tree.
  git(repo, "checkout", "-q", "-b", "side");
  git(repo, "commit", "-q", "--allow-empty", "-m", "side");
  git(repo, "checkout", "-q", "-b", "base", home);
  git(repo, "merge", "-q", "-s", "ours", "--no-commit", "--no-ff", "side");
  assert.equal(git(repo, "status", "--porcelain"), "");
  before = repoState(repo);
  assert.match(before, /MERGE_HEAD=true/);
  const second = openStore(":memory:");
  assert.match((await take(config, second, "2")) ?? "", /is refused: a merge is in progress \(MERGE_HEAD\) in modules\/project/);
  assert.equal(repoState(repo), before);
  // Held already, the session is refused in the same way.
  second.setValue(HOLDINGS_KEY, holding("2", r.clones.a, true));
  await assert.rejects(prepare(config, second, "2"), /a merge is in progress \(MERGE_HEAD\)/);
  assert.equal(repoState(repo), before);
  git(repo, "merge", "--abort");
  git(repo, "checkout", "-q", "--detach", home);
  git(repo, "branch", "-D", "side", "base");
  assert.equal(await take(config, openStore(":memory:"), "3"), null);
});

test("a branch of the item's name that this item did not make in a clone is not continued on; its own clone and its own branch still are", async () => {
  const r = fixture("c");
  const repoA = r.repo(r.clones.a);
  const repoB = r.repo(r.clones.b);
  const homeA = git(repoA, "rev-parse", "HEAD");
  // Old commits on scopesoup/1 in clone a; the clone is left detached at its tip, as Scope Soup leaves a freed one.
  git(repoA, "checkout", "-q", "-b", "scopesoup/1");
  git(repoA, "commit", "-q", "--allow-empty", "-m", "old work");
  const tip = git(repoA, "rev-parse", "HEAD");
  git(repoA, "checkout", "-q", "--detach");

  // A new item (no record): clone a is refused with the clone and the branch named; clone b is taken instead.
  assert.match((await take(only(r, "a"), openStore(":memory:"), "1")) ?? "", /the clone .*a is refused: modules\/project already has a branch scopesoup\/1 that 1 did not start there/);
  const fresh = openStore(":memory:");
  assert.equal(await take(only(r, "a", "b"), fresh, "1"), null);
  assert.equal(loadHoldings(fresh)[workspaceKey(ref("1"))]?.clone, r.clones.b);
  assert.match(JSON.stringify(fresh.eventsAfter(0, 10).find((event) => event.kind === "orchestrator.workspace_taken")?.data), /Passed over: the clone .*a is refused: modules\/project already has a branch scopesoup\/1/);

  // The item that held clone a comes back to it, and its work continues on the branch.
  const returning = openStore(":memory:");
  returning.setValue(HOLDINGS_KEY, holding("1", r.clones.a, false));
  assert.equal(await take(only(r, "b", "a"), returning, "1"), null);
  assert.equal(loadHoldings(returning)[workspaceKey(ref("1"))]?.clone, r.clones.a);
  assert.equal(await prepare(only(r, "b", "a"), returning, "1"), realpathSync(repoA));
  assert.equal(git(repoA, "rev-parse", "HEAD"), tip);
  git(repoA, "checkout", "-q", "--detach");

  // Clone a has a person's changes now: the item moves to clone b and takes its branch along (not the changes).
  writeFileSync(join(repoA, "README.md"), "a person's edit\n");
  const moving = openStore(":memory:");
  moving.setValue(HOLDINGS_KEY, holding("1", r.clones.a, false));
  assert.equal(await take(only(r, "a", "b"), moving, "1"), null);
  assert.equal(loadHoldings(moving)[workspaceKey(ref("1"))]?.clone, r.clones.b);
  assert.equal(git(repoB, "rev-parse", "scopesoup/1"), tip);
  assert.equal(git(repoA, "status", "--porcelain"), "M README.md");
  assert.equal(readFileSync(join(repoA, "README.md"), "utf8"), "a person's edit\n");

  git(repoA, "checkout", "--", "README.md");
  git(repoA, "checkout", "-q", "--detach", homeA);
  git(repoA, "branch", "-D", "scopesoup/1");
  git(repoB, "branch", "-D", "scopesoup/1");
});

test("a person's edits in a held clone after a session ran are discarded too, and the record brings every byte and the index back", async () => {
  const r = fixture("c");
  const repo = r.repo(r.clones.a);
  const home = git(repo, "rev-parse", "HEAD");
  const config = poolConfig(r, { workspaces: { kind: "pool", paths: ["pool/a"], projectSubdir: "modules/project" }, streamsDir: "streams-person" });
  const store = openStore(":memory:");
  const runner = makeRunner(store, config, { ms: T0 });
  assert.equal(await runner.takeWorkspace(ref("1"), workspaceKey(ref("1")), workBranch(ref("1"))), null);
  assert.equal((await runner.finished((await runner.start(request("1"))).ref.id)).status, "succeeded");
  // A person edits in the clone the item still holds: a staged change, an unstaged one on top, a binary file larger than 1 MB.
  writeFileSync(join(repo, "README.md"), "staged by a person\n");
  git(repo, "add", "README.md");
  writeFileSync(join(repo, "README.md"), "and changed again\n");
  writeFileSync(join(repo, "work.txt"), "the person rewrote the item's file\n");
  const big = Buffer.alloc(1024 * 1024 + 17);
  for (let index = 0; index < big.length; index++) big[index] = (index * 31) % 256;
  mkdirSync(join(repo, "person"));
  writeFileSync(join(repo, "person", "data.bin"), big);
  const before = content(repo);

  await runner.releaseWorkspace(workspaceKey(ref("1")));
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "", "discarded: the code cannot tell a person's edits from a session's");
  const [discarded] = eventsOf(store, "orchestrator.workspace_discarded");
  assert.deepEqual([discarded?.restored, discarded?.removed, discarded?.left], [2, 1, 0]);
  followRestore(String(discarded?.record));
  assert.equal(content(repo), before, "the record gives back every byte and the index");

  git(repo, "reset", "-q", "--hard");
  rmSync(join(repo, "person"), { recursive: true, force: true });
  git(repo, "checkout", "-q", "--detach", home);
  git(repo, "branch", "-D", "scopesoup/1");
  assert.equal(git(repo, "status", "--porcelain"), "");
});
});
});
