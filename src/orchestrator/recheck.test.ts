// A waiting Item's triage again when its paths changed on main, its text was edited, or a blocker or linked Item finished (age alone
// is no input, #217), before its implement step and within the re-triage share; and the pacing of triages (priority first, a few at
// a time, within the usage reserve). A fake runner; no claude.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fixedConfig } from "../config/loader.ts";
import type { ProjectConfig } from "../config/types.ts";
import { validateConfig } from "../config/validate.ts";
import type { Ref, Session, SessionStatus, UsageSample, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { KEYS } from "../store/keys.ts";
import { setRolesForTest } from "../store/control.ts";
import { conflictQuestion, GO_ON_WITH_BOTH, itemTextHash } from "../core/answerReuse.ts";
import { addAnswer } from "../store/answers.ts";
import type { Actions, AgentRunner, SessionRequest } from "./ports.ts";
import { adoptWritten, loadJobs, saveJobs, stepAt, atStep, markMerged } from "./jobs.ts";
import type { Job, Recheck } from "./jobs.ts";
import { realGit } from "./process.ts";
import { triagedNow, triagedText, staleWithoutGit, usablePaths } from "./recheck.ts";
import { sessionResultKey } from "./runner.ts";
import { tick } from "./tick.ts";
import { changeStat, commitsTouching } from "./worktree.ts";
import { withoutTriageKeys } from "../server/triage.ts";
import { loadSnapshot } from "../server/snapshot.ts";

/** Why the triage the job is at runs again. */
const recheckIn = (job: Job | undefined): Recheck | undefined => (job?.at.kind === "triage" ? job.at.recheck : undefined);

const T0 = Date.parse("2026-11-18T10:00:00.000Z");
const DAY = 24 * 3600_000;
const MAIN_A = "a".repeat(40);
const MAIN_B = "b".repeat(40);
const TRIAGE_OK = { ready: true, size: "small", questions: [], blockers: [], paths: ["src/a.ts"], links: [] };

function config(raw: Record<string, unknown> = {}): ProjectConfig {
  const result = validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", level: 1, ...raw }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return { ref: { host: "fake", kind: "work", id }, title: `Item ${id}`, body: `Do ${id}.`, state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-01T00:00:00Z", ...over };
}

const ref = (id: string): Ref => ({ host: "fake", kind: "work", id });

interface World {
  store: Store;
  clock: { ms: number };
  requests: SessionRequest[];
  /** Where the remote's main is. */
  main: { at: string };
  /** What the fake `commitsTouching` finds since a commit, by the commit it is asked from; absent: nothing. */
  touching: Map<string, { sha: string; subject: string }[]>;
  touchCalls: string[];
  cfg: { config: ProjectConfig };
  end(id: string, status: SessionStatus, output?: unknown): void;
  run(): ReturnType<typeof tick>;
  job(id: string): Job | undefined;
  events(kind: string): string[];
  put(work: WorkItem): void;
}

function world(cfg: ProjectConfig, items: WorkItem[], withCommits = true): World {
  const store = openStore(":memory:");
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms).toISOString();
  setRolesForTest(store, "started");
  store.setValue(KEYS.mergeQueue, "started");
  for (const entry of items) store.put(entry, "sync", now());
  let count = 0;
  const sessions = new Map<string, Session>();
  const requests: SessionRequest[] = [];
  const main = { at: MAIN_A };
  const touching = new Map<string, { sha: string; subject: string }[]>();
  const touchCalls: string[] = [];
  const runner: AgentRunner = {
    async start(request) {
      const session: Session = { ref: { host: "scopesoup", kind: "session", id: `s${++count}` }, role: request.role, subject: request.subject, status: "running", attempt: request.attempt, startedAt: now(), pid: 1000 + count, model: "m" };
      requests.push(request);
      sessions.set(request.subject.id, session);
      store.put(session, "orchestrator", now());
      return session;
    },
    async reconcile() {},
    stopAll: () => 0,
    running: () => [...sessions.values()].filter((session) => session.status === "running").length,
    async takeWorkspace() {
      return null;
    },
    async releaseWorkspace() {},
    async deleteBranch() {},
    async changedPaths() {
      return ["src/a.ts"];
    },
    async head() {
      return "3".repeat(40);
    },
    async fetchMain() {
      return { repo: "/srv/clone", main: main.at };
    },
    async contains(_branch, ancestor, descendant) {
      return ancestor === descendant || (ancestor === MAIN_A && descendant === MAIN_B);
    },
    ...(withCommits ? {
      async commitsTouching(_branch: string, since: string, until: string, paths: readonly string[]) {
        touchCalls.push(`${since.slice(0, 1)}..${until.slice(0, 1)} ${paths.join(",")}`);
        const found = touching.get(since) ?? [];
        return { commits: found, count: found.length };
      },
    } : {}),
  };
  const actions: Actions = {
    async claim() {
      return { won: true };
    },
    async release() {},
    async answerTurn() {},
    async appendLog() {},
  };
  const holder = { config: cfg };
  const source = { load: () => fixedConfig(holder.config).load() };
  const out: World = {
    store, clock, requests, main, touching, touchCalls, cfg: holder,
    end(id, status, output) {
      const session = sessions.get(id)!;
      const over: Session = { ...session, status, finishedAt: now(), endReason: status, agentSessionId: `agent-${session.ref.id}` };
      sessions.set(id, over);
      store.setValue(sessionResultKey(session.ref.id), JSON.stringify({ output }));
      store.put(over, "orchestrator", now());
    },
    run: () => tick({ store, runner, config: source, actions, now }),
    job: (id) => loadJobs(store)[refKey(ref(id))],
    events: (kind) => store.eventsAfter(0, 10_000).filter((event) => event.kind === kind).map((event) => (event.data as { reason: string }).reason),
    put: (work) => store.put(work, "sync", now()),
  };
  return out;
}

/** Level 1: the triage runs and its answer is taken; the Item waits at its implement step. */
async function triaged(w: World, id: string): Promise<void> {
  await w.run();
  assert.equal(w.requests.at(-1)?.role, "triage");
  w.end(id, "succeeded", TRIAGE_OK);
  await w.run();
  assert.equal(stepAt(w.job(id)!), "implement");
  assert.ok(w.job(id)?.triaged, "what the triage saw is kept");
}

/** Raises the level to 2 and ticks: the Item's next session starts. */
async function front(w: World): Promise<SessionRequest> {
  w.cfg.config = { ...w.cfg.config, level: 2 };
  // Past the short delay before the next step.
  w.clock.ms += 1000;
  const before = w.requests.length;
  await w.run();
  assert.equal(w.requests.length, before + 1, "a session started");
  return w.requests.at(-1)!;
}

describe("a waiting Item's triage again", { concurrency: 8 }, () => {
  test("an unchanged Item is not triaged again: its implement step starts", async () => {
    const w = world(config(), [item("1")]);
    await triaged(w, "1");
    w.clock.ms += 29 * DAY;
    const next = await front(w);
    assert.equal(next.role, "implement");
    assert.equal(w.events("orchestrator.triage_again").length, 0);
    assert.equal(w.touchCalls.length, 0, "main has not moved, so no commits are listed");
  });

  test("an old triage with nothing changed is not taken again: age alone is no input (#217)", async () => {
    const w = world(config(), [item("1")]);
    await triaged(w, "1");
    w.clock.ms += 400 * DAY;
    assert.equal((await front(w)).role, "implement");
    assert.equal(w.events("orchestrator.triage_again").length, 0);
  });

  test("a triage taken again is told why and what it said before; its answer is taken as a triage's", async () => {
    const w = world(config(), [item("1")]);
    await triaged(w, "1");
    w.put(item("1", { body: "Do 1, and also the export." }));
    const next = await front(w);
    assert.equal(next.role, "triage");
    assert.match(next.vars.recheck ?? "", /<previous-triage>\nready: true\nsize: small\npaths: src\/a\.ts/);
    assert.equal(w.events("orchestrator.triage_again").length, 1);
    w.end("1", "succeeded", TRIAGE_OK);
    await w.run();
    w.clock.ms += 1000;
    await w.run();
    assert.equal(w.requests.at(-1)?.role, "implement");
    assert.equal(recheckIn(w.job("1")), undefined);
  });

  test("an edited text has the triage again, shown the text it read before", async () => {
    const w = world(config(), [item("1")]);
    await triaged(w, "1");
    w.put(item("1", { body: "Do 1, and also the export." }));
    const next = await front(w);
    assert.equal(next.role, "triage");
    assert.match(next.vars.recheck ?? "", /its text was edited/);
    assert.match(next.vars.recheck ?? "", /<text-then[^>]*>\nTitle: Item 1\n\nDo 1\.\n/);
    assert.match(next.vars.itemBody ?? "", /also the export/);
  });

  test("commits on main that touch the paths it named have the triage again, with the commits listed", async () => {
    const w = world(config(), [item("1")]);
    await triaged(w, "1");
    assert.equal(w.job("1")?.triaged?.main, MAIN_A);
    w.main.at = MAIN_B;
    w.touching.set(MAIN_A, [{ sha: "c".repeat(40), subject: "Rework a.ts" }]);
    const next = await front(w);
    assert.equal(next.role, "triage");
    assert.deepEqual(w.touchCalls, ["a..b src/a.ts"]);
    assert.match(next.vars.recheck ?? "", /1 commit on main changed the paths it named/);
    assert.match(next.vars.recheck ?? "", /cccccccccccc Rework a\.ts/);
  });

  test("main moved without touching its paths: no triage again", async () => {
    const w = world(config(), [item("1")]);
    await triaged(w, "1");
    w.main.at = MAIN_B;
    assert.equal((await front(w)).role, "implement");
  });

  test("without a way to list commits the paths are not checked, and the other triggers still are", async () => {
    const w = world(config(), [item("1")], false);
    await triaged(w, "1");
    w.main.at = MAIN_B;
    assert.equal((await front(w)).role, "implement");
  });

  test("a blocker it waited on that is done has the triage again", async () => {
    const w = world(config({ level: 2 }), [item("1"), item("2", { state: "done" })]);
    const text = triagedText(item("1"));
    const jobs = loadJobs(w.store);
    jobs[refKey(ref("1"))] = {
      item: ref("1"), workspace: "w1", branch: "scopesoup/1", failures: 0, fixRounds: 0, startedAt: new Date(T0).toISOString(),
      triage: { ready: true, size: "small", paths: [], hidesDecision: false, rewrite: "Do 1." },
      triaged: { at: new Date(T0).toISOString(), ...text, blockers: [refKey(ref("2"))] }, at: atStep("implement")
    };
    w.store.tx(() => saveJobs(w.store, jobs));
    await w.run();
    const next = w.requests.at(-1)!;
    assert.equal(next.role, "triage");
    assert.match(next.vars.recheck ?? "", /the Item it waited on is done \(2\)/);
  });

  test("an Item whose implement step has begun is not triaged again", async () => {
    const w = world(config(), [item("1")]);
    await triaged(w, "1");
    w.put(item("1", { body: "Do 1, and also the export." }));
    const jobs = loadJobs(w.store);
    jobs[refKey(ref("1"))]!.resumeWith = "The reviewer asked for changes.";
    w.store.tx(() => saveJobs(w.store, jobs));
    w.clock.ms += 5 * DAY;
    assert.equal((await front(w)).role, "implement");
  });

  test("at level 1 nothing is triaged again: nothing comes to the front of the implement line", async () => {
    const w = world(config({ settings: { retriageShare: { value: 0.5 } } }), [item("1")]);
    await triaged(w, "1");
    w.put(item("1", { body: "Do 1, and also the export." }));
    w.clock.ms += 5 * DAY;
    const before = w.requests.length;
    await w.run();
    assert.equal(w.requests.length, before);
    assert.equal(w.events("orchestrator.triage_again").length, 0);
  });
});

describe("what counts as a change", () => {
  test("a description Scope Soup wrote from the accepted rewrite is no edit; another text is", () => {
    const work = item("1");
    const job: Job = {
      item: ref("1"), workspace: "w", branch: "scopesoup/1", failures: 0, fixRounds: 0, startedAt: new Date(T0).toISOString(),
      triage: { ready: true, size: "small", paths: [], hidesDecision: false, rewrite: "Do 1 well." },
      triaged: adoptWritten({ at: new Date(T0).toISOString(), ...triagedText(work), blockers: [] }, ["Do 1 well."]), at: atStep("implement")
    };
    assert.deepEqual(staleWithoutGit(job, work, [work]).reasons, []);
    assert.deepEqual(staleWithoutGit(job, item("1", { body: "Do 1 well." }), []).reasons, []);
    assert.deepEqual(staleWithoutGit(job, item("1", { body: "Do 1 badly." }), []).reasons, ["its text was edited"]);
    assert.equal(itemTextHash(work), job.triaged!.textHash);
  });

  test("a triage from earlier has no record of what it saw: nothing counts, not its age either", () => {
    const job: Job = { item: ref("1"), workspace: "w", branch: "scopesoup/1", failures: 0, fixRounds: 0, startedAt: new Date(T0).toISOString(), triage: { ready: true, size: "small", paths: [], hidesDecision: false, rewrite: "" }, at: atStep("implement") };
    assert.deepEqual(staleWithoutGit(job, item("1", { body: "Changed." }), []).reasons, []);
  });

  test("an Item its triage linked to that is closed since is new input; the links are kept as the open Items they named", () => {
    const work = item("1");
    const other = item("2");
    const triaged = triagedNow(triagedText(work), work, [work, other, item("3", { state: "done" })], new Date(T0).toISOString(), MAIN_A, [{ type: "related", item: "#2" }, { type: "related", item: "3" }, { type: "related", item: "#9" }]);
    assert.deepEqual(triaged.linked, [refKey(ref("2"))]);
    const job: Job = { item: ref("1"), workspace: "w", branch: "scopesoup/1", failures: 0, fixRounds: 0, startedAt: new Date(T0).toISOString(), triage: { ready: true, size: "small", paths: [], hidesDecision: false, rewrite: "Do 1." }, triaged, at: atStep("implement") };
    assert.deepEqual(staleWithoutGit(job, work, [work, other]).reasons, []);
    assert.deepEqual(staleWithoutGit(job, work, [work, item("2", { state: "abandoned" })]).reasons, ["an Item it is linked to is closed (2)"]);
  });

  test("only plain relative paths from the answer are looked up in git", () => {
    assert.deepEqual(usablePaths(["./src/a.ts", "src/a.ts", "/docs/", ":(exclude)x", "--all", "a/../../etc", "", "src\\b.ts"]), ["src/a.ts", "docs/", "src/b.ts"]);
  });
});

describe("triage again within its share (#217)", { concurrency: 4 }, () => {
  /** A triaged Item waiting at its implement step in To do (or Backlog), its triage taken at `at` and naming `paths`. */
  function waitingAt(id: string, at: number): Job {
    return {
      item: ref(id), workspace: `w${id}`, branch: `scopesoup/${id}`, failures: 0, fixRounds: 0, startedAt: new Date(at).toISOString(), seenInTodo: true,
      triage: { ready: true, size: "small", paths: [], hidesDecision: false, rewrite: `Do ${id}.` },
      triaged: { at: new Date(at).toISOString(), ...triagedText(item(id)), blockers: [] }, at: atStep("implement"),
    };
  }
  /** Sessions that ran in the last week: what the share is measured against (each counts its role's expected use). */
  function ran(w: World, n: number): void {
    for (let i = 0; i < n; i++) {
      const at = new Date(T0 + DAY + i * 60_000).toISOString();
      w.store.put({ ref: { host: "scopesoup", kind: "session", id: `old${i}` }, role: "implement", subject: ref("9"), status: "succeeded", attempt: 1, startedAt: at, finishedAt: at } as Session, "orchestrator", at);
    }
  }
  /** Two Items wait in To do, 1 first in line; 2's text was edited since its triage two days ago. One session slot. */
  function setUp(share: number, sessions: number, over: { backlog?: boolean; triagedAt?: number; edited?: boolean } = {}): World {
    const w = world(config({ level: 2, settings: { retriageShare: { value: share } } }), [item("1", { priority: "critical" }), item("2", over.backlog ? { backlog: true } : {})]);
    w.clock.ms = T0 + 2 * DAY;
    const jobs = loadJobs(w.store);
    jobs[refKey(ref("1"))] = waitingAt("1", T0);
    jobs[refKey(ref("2"))] = waitingAt("2", over.triagedAt ?? T0);
    w.store.tx(() => saveJobs(w.store, jobs));
    if (over.edited !== false) w.put(item("2", { body: "Do 2, and the export too.", ...(over.backlog ? { backlog: true } : {}) }));
    ran(w, sessions);
    return w;
  }
  const started = (w: World): string[] => w.requests.map((request) => `${request.role} ${request.subject.id}`);

  test("with room in the share, the stale To do Item is triaged again ahead of new work, told what changed", async () => {
    const w = setUp(0.5, 2);
    await w.run();
    assert.deepEqual(started(w), ["triage 2"]);
    assert.match(w.requests[0]!.vars.recheck ?? "", /its text was edited/);
    const event = w.store.eventsAfter(0, 10_000).find((each) => each.kind === "orchestrator.triage_again");
    assert.equal((event?.data as Record<string, unknown>).background, true);
    assert.match(w.events("orchestrator.triage_again")[0] ?? "", /while it waits in To do, the stalest there, within the share for triage again/);
    // The Usage tab names re-triage use against its share.
    const pacing = JSON.parse(w.store.getValue(KEYS.pacing)!) as { retriage: { share: number; used: number } };
    assert.equal(pacing.retriage.share, 0.5);
  });

  test("without room in the share it waits: new work goes first, and the Item is triaged again only just before its own start", async () => {
    const w = setUp(0.05, 2);
    await w.run();
    assert.deepEqual(started(w), ["implement 1"]);
    assert.equal(w.events("orchestrator.triage_again").length, 0);
    const pacing = JSON.parse(w.store.getValue(KEYS.pacing)!) as { retriage: { reason: string } };
    assert.match(pacing.retriage.reason, /one more would go past it/);
  });

  test("the share is a share: about one triage taken again per (1 / share) sessions' worth of use", async () => {
    // 5 %: one more fits once all use, with it, is 20 triages' worth (each session counts the same default guess here).
    assert.deepEqual(started(await runOnce(setUp(0.05, 18))), ["implement 1"]);
    assert.deepEqual(started(await runOnce(setUp(0.05, 19))), ["triage 2"]);
  });
  async function runOnce(w: World): Promise<World> {
    await w.run();
    return w;
  }

  test("nothing changed since its triage, or a triage newer than the floor, or an Item in Backlog: not chosen", async () => {
    assert.deepEqual(started(await runOnce(setUp(0.5, 2, { edited: false }))), ["implement 1"]);
    assert.deepEqual(started(await runOnce(setUp(0.5, 2, { triagedAt: T0 + 2 * DAY - 3600_000 }))), ["implement 1"]);
    const backlog = await runOnce(setUp(0.5, 2, { backlog: true }));
    assert.deepEqual(started(backlog), ["implement 1"]);
    assert.equal(backlog.events("orchestrator.triage_again").length, 0);
  });

  test("one at a time: while one chosen within the share is under way, no other is chosen", async () => {
    const w = setUp(0.5, 2);
    w.cfg.config = { ...w.cfg.config, settings: { ...w.cfg.config.settings, maxParallelSessions: { value: 3, reason: "test" } } };
    w.put(item("1", { priority: "critical", body: "Do 1, edited." }));
    w.store.addUsageSample({
      at: new Date(w.clock.ms).toISOString(), status: "allowed",
      windows: [{ kind: "five_hour", utilization: 0.01, resetsAt: new Date(w.clock.ms + 4 * 3600_000).toISOString() }, { kind: "seven_day", utilization: 0.01, resetsAt: new Date(w.clock.ms + 6 * DAY).toISOString() }],
    });
    await w.run();
    const background = w.store.eventsAfter(0, 10_000).filter((each) => each.kind === "orchestrator.triage_again" && (each.data as Record<string, unknown>).background === true);
    assert.equal(background.length, 1, started(w).join(", "));
  });
});

test("commitsTouching lists the commits since a commit that touch the paths, newest first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-recheck-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "1");
    git("add", ".");
    git("commit", "-q", "-m", "start");
    const since = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "b.txt"), "1");
    git("add", ".");
    git("commit", "-q", "-m", "other file");
    writeFileSync(join(dir, "a.txt"), "2");
    git("add", ".");
    git("commit", "-q", "-m", "change a");
    writeFileSync(join(dir, "a.txt"), "3");
    git("add", ".");
    git("commit", "-q", "-m", "change a again");
    const tip = git("rev-parse", "HEAD");
    const found = await commitsTouching(realGit, dir, since, tip, ["a.txt"], 1);
    assert.equal(found?.count, 2);
    assert.deepEqual(found?.commits.map((each) => each.subject), ["change a again"]);
    assert.deepEqual(await commitsTouching(realGit, dir, since, tip, ["c.txt"], 5), { commits: [], count: 0 });
    assert.equal(await commitsTouching(realGit, dir, "d".repeat(40), tip, ["a.txt"], 5), null);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("changeStat: each path the branch changes against where it left main, with its added and removed lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-fence-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n");
    git("add", ".");
    git("commit", "-q", "-m", "start");
    git("checkout", "-q", "-b", "scopesoup/1");
    writeFileSync(join(dir, "a.txt"), "1\ntwo\n3\n4\n");
    writeFileSync(join(dir, "b c.txt"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "work");
    git("checkout", "-q", "main");
    writeFileSync(join(dir, "main.txt"), "on main since\n");
    git("add", ".");
    git("commit", "-q", "-m", "main moves on");
    const stat = await changeStat(realGit, dir, "main", "origin", "scopesoup/1");
    assert.deepEqual(stat.sort((a, b) => a.path.localeCompare(b.path)), [{ path: "a.txt", lines: 3 }, { path: "b c.txt", lines: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe("pacing of triages with a big backlog", { concurrency: 4 }, () => {
  const backlog = (): WorkItem[] => [
    item("1", { priority: "minor" }), item("2", { priority: "blocker" }), item("3"), item("4", { priority: "critical" }), item("5", { priority: "minor" }),
  ];
  const sample = (week: number): UsageSample => ({
    at: new Date(T0).toISOString(), status: "allowed",
    windows: [{ kind: "five_hour", utilization: 0.1, resetsAt: new Date(T0 + 2 * 3600_000).toISOString() }, { kind: "seven_day", utilization: week, resetsAt: new Date(T0 + 3 * DAY).toISOString() }],
  });

  test("a few at a time (the parallel sessions), highest priority first", async () => {
    const w = world(config({ settings: { maxParallelSessions: { value: 2 } } }), backlog());
    w.store.addUsageSample(sample(0.1));
    await w.run();
    assert.deepEqual(w.requests.map((request) => `${request.role} ${request.subject.id}`), ["triage 2", "triage 4"]);
    w.end("2", "succeeded", TRIAGE_OK);
    await w.run();
    assert.deepEqual(w.requests.map((request) => request.subject.id), ["2", "4", "3"]);
  });

  test("none start once the usage reaches the reserve; the rest wait below the backlog's divider", async () => {
    const w = world(config({ settings: { maxParallelSessions: { value: 2 } } }), backlog());
    w.store.addUsageSample(sample(0.1));
    await w.run();
    w.end("2", "succeeded", TRIAGE_OK);
    w.store.addUsageSample(sample(0.95));
    await w.run();
    assert.deepEqual(w.requests.map((request) => request.subject.id), ["2", "4"]);
    const works = w.store.list<WorkItem>("work");
    // 2 had its triage; 4's is running, so it is not triaged yet.
    assert.deepEqual([...withoutTriageKeys(works, loadJobs(w.store))].map((key) => key.split(":").pop()).sort(), ["1", "3", "4", "5"]);
  });
});

describe("Items that change the same files", { concurrency: 4 }, () => {
  /** A triaged Item about to start its implement step, its triage naming `paths`. */
  function waitingJob(id: string, paths: string[]): Job {
    return {
      item: ref(id), workspace: `w${id}`, branch: `scopesoup/${id}`, failures: 0, fixRounds: 0, startedAt: new Date(T0).toISOString(),
      triage: { ready: true, size: "small", paths, hidesDecision: false, rewrite: `Do ${id}.` },
      triaged: { at: new Date(T0).toISOString(), ...triagedText(item(id)), blockers: [] }, at: atStep("implement")
    };
  }

  test("two Items with overlapping paths do not run at once; one without overlap, or without paths, starts instead", async () => {
    const w = world(config({ level: 3, settings: { maxParallelSessions: { value: 4 } } }), [item("1"), item("2"), item("3"), item("4")]);
    const jobs = loadJobs(w.store);
    jobs[refKey(ref("1"))] = waitingJob("1", ["src/core"]);
    jobs[refKey(ref("2"))] = waitingJob("2", ["./src/core/a.ts"]);
    jobs[refKey(ref("3"))] = waitingJob("3", ["src/web/b.ts"]);
    jobs[refKey(ref("4"))] = waitingJob("4", []);
    w.store.tx(() => saveJobs(w.store, jobs));
    // A usage reading, so more than one session may start at once.
    w.store.addUsageSample({
      at: new Date(T0).toISOString(), status: "allowed",
      windows: [{ kind: "five_hour", utilization: 0.1, resetsAt: new Date(T0 + 2 * 3600_000).toISOString() }, { kind: "seven_day", utilization: 0.1, resetsAt: new Date(T0 + 3 * DAY).toISOString() }],
    });
    await w.run();
    const started = w.requests.map((request) => `${request.role} ${request.subject.id}`).sort();
    assert.equal(started.filter((each) => each === "implement 1" || each === "implement 2").length, 1, "only one of the overlapping Items starts");
    assert.ok(started.includes("implement 3") && started.includes("implement 4"), started.join(", "));
    const first = started.includes("implement 1") ? "1" : "2";
    const other = first === "1" ? "2" : "1";
    // The board says why the other waits.
    assert.deepEqual(loadSnapshot(w.store).sameFiles, [{ subject: ref(other), waitsFor: [ref(first)] }]);
    // Once the first is in review, the other still waits for it.
    w.end(first, "succeeded", { done: true, summary: "Done." });
    await w.run();
    w.clock.ms += 1000;
    await w.run();
    assert.equal(stepAt(w.job(first)!), "review");
    assert.equal(w.requests.filter((request) => request.subject.id === other).length, 0);
  });

  test("an Item in review holds back one whose paths overlap", async () => {
    const w = world(config({ level: 3 }), [item("1"), item("2")]);
    const jobs = loadJobs(w.store);
    jobs[refKey(ref("1"))] = { ...waitingJob("1", ["src/a.ts"]), head: "3".repeat(40), at: atStep("review") };
    jobs[refKey(ref("2"))] = waitingJob("2", ["src/a.ts", "docs/RUNNING.md"]);
    w.store.tx(() => saveJobs(w.store, jobs));
    await w.run();
    assert.equal(w.requests.filter((request) => request.subject.id === "2").length, 0);
    assert.deepEqual(loadSnapshot(w.store).sameFiles, [{ subject: ref("2"), waitsFor: [ref("1")] }]);
  });

  test("an Item in the merge queue holds back one whose paths overlap until its change is merged", async () => {
    // Level 4: below it a change leaves the queue (#238).
    const w = world(config({ level: 4, remoteUrl: "git@git.example.invalid:team/project.git", checkCommand: ["node", "check.js"] }), [item("1"), item("2")]);
    const jobs = loadJobs(w.store);
    const at = new Date(T0).toISOString();
    jobs[refKey(ref("1"))] = { ...waitingJob("1", ["src/a.ts"]), head: "3".repeat(40), queued: "3".repeat(40), at: { kind: "parked", step: "implement", parked: { as: "queued", reason: "In the merge queue.", at } } };
    jobs[refKey(ref("2"))] = waitingJob("2", ["src/a.ts"]);
    w.store.tx(() => saveJobs(w.store, jobs));
    await w.run();
    assert.equal(w.requests.filter((request) => request.subject.id === "2").length, 0);
    assert.deepEqual(loadSnapshot(w.store).sameFiles, [{ subject: ref("2"), waitsFor: [ref("1")] }]);
    const merged = loadJobs(w.store);
    markMerged(merged[refKey(ref("1"))]!, "4".repeat(40));
    w.store.tx(() => saveJobs(w.store, merged));
    w.clock.ms += 1000;
    await w.run();
    assert.deepEqual(w.requests.map((request) => `${request.role} ${request.subject.id}`), ["implement 2"]);
  });

  test("an Item parked for a person before any change exists holds nothing back", async () => {
    const w = world(config({ level: 3 }), [item("1"), item("2")]);
    const jobs = loadJobs(w.store);
    jobs[refKey(ref("1"))] = { ...waitingJob("1", ["src/a.ts"]), at: { kind: "parked", step: "implement", parked: { as: "needs-decision", reason: "Old or new?", at: new Date(T0).toISOString() } } };
    jobs[refKey(ref("2"))] = waitingJob("2", ["src/a.ts"]);
    w.store.tx(() => saveJobs(w.store, jobs));
    await w.run();
    assert.deepEqual(w.requests.map((request) => `${request.role} ${request.subject.id}`), ["implement 2"]);
  });

  test("a conflictsWith link holds the Item back while the other is busy, until a person says to go on with both", async () => {
    const w = world(config({ level: 3, settings: { maxParallelSessions: { value: 2 } } }), [item("1"), item("2")]);
    // A usage reading, so more than one session may start at once.
    w.store.addUsageSample({
      at: new Date(T0).toISOString(), status: "allowed",
      windows: [{ kind: "five_hour", utilization: 0.1, resetsAt: new Date(T0 + 2 * 3600_000).toISOString() }, { kind: "seven_day", utilization: 0.1, resetsAt: new Date(T0 + 3 * DAY).toISOString() }],
    });
    const jobs = loadJobs(w.store);
    jobs[refKey(ref("1"))] = { ...waitingJob("1", ["src/a.ts"]), head: "3".repeat(40), at: atStep("review") };
    const second = waitingJob("2", ["web/b.ts"]);
    jobs[refKey(ref("2"))] = { ...second, triage: { ...second.triage!, links: [{ type: "conflictsWith", item: "#1" }] } };
    w.store.tx(() => saveJobs(w.store, jobs));
    await w.run();
    assert.equal(w.requests.filter((request) => request.subject.id === "2").length, 0);
    assert.deepEqual(loadSnapshot(w.store).sameFiles, [{ subject: ref("2"), waitsFor: [], mayConflict: [ref("1")] }]);
    addAnswer(w.store, { subject: ref("2"), question: conflictQuestion("2", "1", "Item 1"), answer: GO_ON_WITH_BOTH, by: "Ada", at: new Date(T0).toISOString() });
    w.clock.ms += 1000;
    await w.run();
    assert.deepEqual(w.requests.filter((request) => request.subject.id === "2").map((request) => request.role), ["implement"]);
  });

  test("a conflictsWith link the busy Item's triage made holds back the Item it names", async () => {
    const w = world(config({ level: 3 }), [item("1"), item("2")]);
    const jobs = loadJobs(w.store);
    const first = waitingJob("1", ["src/a.ts"]);
    jobs[refKey(ref("1"))] = { ...first, head: "3".repeat(40), triage: { ...first.triage!, links: [{ type: "conflictsWith", item: "2" }] }, at: atStep("review") };
    jobs[refKey(ref("2"))] = waitingJob("2", ["web/b.ts"]);
    w.store.tx(() => saveJobs(w.store, jobs));
    await w.run();
    assert.equal(w.requests.filter((request) => request.subject.id === "2").length, 0);
    assert.deepEqual(loadSnapshot(w.store).sameFiles, [{ subject: ref("2"), waitsFor: [], mayConflict: [ref("1")] }]);
  });
});
