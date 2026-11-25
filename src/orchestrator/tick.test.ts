// The tick against an in-memory store and a fake runner. No process is started, no clock is read.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { budgetReserve } from "../config/budgetReserve.ts";
import { persistenceLimits } from "../config/persistence.ts";
import { buildCommand } from "./providers/claude/command.ts";
import type { ConfigSource } from "../config/loader.ts";
import { fixedConfig } from "../config/loader.ts";
import type { ProjectConfig } from "../config/types.ts";
import { validateConfig } from "../config/validate.ts";
import type { Change, ScopeSoupEvent, Ref, Session, SessionStatus, UsageSample, WorkItem } from "../model/types.ts";
import { optionText, refKey } from "../model/types.ts";
import { buildBoard } from "../core/board.ts";
import { loadSnapshot } from "../server/snapshot.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { compareItems, readyItems } from "./candidates.ts";
import { backoffMs } from "./cycle.ts";
import { openDrafts } from "./drafts.ts";
import type { MergeQueue } from "./mergeQueue.ts";
import { createLoop } from "./loop.ts";
import { workspaceKey } from "./paths.ts";
import { answerQuestion, asImplement, asTriage, loadJobs, jobQuestions, releaseJob, resumesStep, saveJobs, settleRewrite } from "./jobs.ts";
import { loadOwnBlockers } from "../store/blockers.ts";
import { buildItemPage } from "../core/item-page.ts";
import { addAnswer } from "../store/answers.ts";
import { itemTextHash, reusableAnswer } from "../core/answerReuse.ts";
import { dryActions } from "./ports.ts";
import type { Actions, AgentRunner, ClaimResult, SessionRequest } from "./ports.ts";
import type { Notice, QueueDriver, QueueSink } from "./queueDriver.ts";
import { sessionResultKey } from "./runner.ts";
import { tick } from "./tick.ts";
import { overturnIntoWork, overturnsFor, takesOverturn } from "./overturns.ts";
import { syncHost } from "../sync/syncHost.ts";
import { createHostActions } from "./hostActions.ts";
import { writable } from "../hosts/jira/testHost.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { createHash } from "node:crypto";
import { agentsState, applyControl, mergeQueueState, setRolesForTest } from "../store/control.ts";
import type { ControlAction } from "../store/control.ts";
import { KEYS } from "../store/keys.ts";
import { QUEUE_KEY, readQueueHealth, requestQueueResume } from "./queueHealth.ts";
import { defaultConfig, initialState, step as queueStep } from "../queue/index.ts";

const T0 = Date.parse("2026-11-18T10:00:00.000Z");
/** The fake remote's main before and after a session merged, and the head of every item branch. */
const MAIN_START = "1".repeat(40);
const MAIN_MERGED = "2".repeat(40);
const HEAD = "3".repeat(40);

/**
 * The tests' configuration. Without a level of its own it is the level the rest says, as the tests were written before
 * levels: merging by push or queue is 4, the old reviewer rule on is 3, else 2. The reviewer rule itself is left out.
 */
function config(raw: Record<string, unknown> = {}): ProjectConfig {
  const { reviewer, ...rules } = (raw.rules ?? {}) as Record<string, unknown>;
  const reviewed = (reviewer as { on?: boolean } | undefined)?.on === true;
  const level = raw.level ?? (raw.mergeQueue === "push" || raw.mergeQueue === "queue" ? 4 : reviewed ? 3 : 2);
  const result = validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", ...raw, rules, level }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

const STAGE1 = {
  // Read by config() as level 3 (Review), and left out of the file.
  reviewer: { on: true, reason: "test" },
};

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    ref: { host: "fake", kind: "work", id }, title: `Item ${id}`, state: "todo", hostState: "open", labels: [], blockedBy: [],
    openChildren: 0, updatedAt: "2026-11-01T00:00:00Z", ...over,
  };
}

function ref(id: string): Ref {
  return { host: "fake", kind: "work", id };
}

interface FakeRunner extends AgentRunner {
  requests: SessionRequest[];
  released: string[];
  deleted: string[];
  stops: string[];
  paths: string[];
  /**
   * Whether an implementor told to merge (level 2, or level 3 after the approval) merges when it ends done: the remote's main
   * then moves from MAIN_START to MAIN_MERGED, which contains the branch head HEAD. Default true.
   */
  merges: boolean;
  /** Where the remote's main is now. */
  main: string;
  /** The branch head the fake reports, when a test moves it (a commit); HEAD otherwise. */
  headSha?: string;
  /** Ends the newest session of an item. */
  end(itemId: string, status: SessionStatus, output?: unknown, extra?: { resumeAt?: string; endReason?: string; denied?: string[]; costUsd?: number; setupFailed?: true; setupOutcome?: string; cwd?: string }): void;
}

interface World {
  store: Store;
  runner: FakeRunner;
  clock: { ms: number };
  calls: string[];
  /** Every text the fake host was given (claims, a person's turns, log lines), in full, to check what leaves the machine. */
  hostWrites: string[];
  /** `session` and `question` lines written to items' logs. */
  lines: string[];
  /** What the fake `claim` answers, and the actor id the fake host writes claims as. */
  claim: ClaimResult;
  claimant?: string;
  /** Whether the fake host is one Scope Soup claims on (a shared meta branch, or GitHub with writes). */
  claims?: boolean;
  /** The merge queue lease, when a test needs one. */
  mergeQueue?: MergeQueue;
  /** The merge queue's driver, when a test merges through the queue. */
  queue?: QueueDriver;
  /** The fake `closeMerged`: what it answers (or "throw"), and the closes it was asked for. */
  closeResult: "closed" | "by-hand" | "not-needed" | "throw";
  closes: string[];
  run(): ReturnType<typeof tick>;
  /** The dependencies `run` passes to the tick, for a test that adds one. */
  depsFor(): Parameters<typeof tick>[0];
  events(prefix?: string): ScopeSoupEvent[];
  reasons(kind: string): string[];
  job(id: string): ReturnType<typeof loadJobs>[string] | undefined;
}

function world(cfg: ProjectConfig | ConfigSource, items: WorkItem[] = []): World {
  const store = openStore(":memory:");
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms).toISOString();
  // Agents and merging started, as after a person pressed both Start buttons (no events, so counts stay as they were).
  setRolesForTest(store, "started");
  store.setValue(KEYS.mergeQueue, "started");
  for (const entry of items) store.put(entry, "sync", now());
  let count = 0;
  const sessions = new Map<string, Session>();
  const runner: FakeRunner = {
    requests: [], released: [], deleted: [], stops: [], paths: ["src/a.ts"], merges: true, main: MAIN_START,
    async start(request) {
      const session: Session = {
        ref: { host: "scopesoup", kind: "session", id: `s${++count}` }, role: request.role, subject: request.subject, status: "running",
        attempt: request.attempt, startedAt: now(), pid: 1000 + count, model: `model-of-${request.role}`,
      };
      runner.requests.push(request);
      sessions.set(request.subject.id, session);
      store.put(session, "orchestrator", now());
      return session;
    },
    async reconcile() {},
    stopAll(reason, only) {
      runner.stops.push(reason);
      let stopped = 0;
      for (const [id, session] of sessions) {
        if (session.status === "running" && (!only || only.includes(session.role))) {
          runner.end(id, "cancelled", undefined, { endReason: reason });
          stopped++;
        }
      }
      return stopped;
    },
    stopFor(subject, reason) {
      const session = sessions.get(subject.id);
      if (!session || session.status !== "running") return 0;
      runner.stops.push(reason);
      runner.end(subject.id, "cancelled", undefined, { endReason: reason });
      return 1;
    },
    running: () => [...sessions.values()].filter((session) => session.status === "running").length,
    async takeWorkspace() {
      return null;
    },
    async releaseWorkspace(workspace) {
      runner.released.push(workspace);
    },
    async deleteBranch(branch) {
      runner.deleted.push(branch);
    },
    async changedPaths() {
      return runner.paths;
    },
    async head() {
      return runner.headSha ?? HEAD;
    },
    async fetchMain() {
      return { repo: "/srv/clone", main: runner.main };
    },
    async contains(_branch, ancestor, descendant) {
      if (ancestor === descendant) return true;
      return descendant === MAIN_MERGED && (ancestor === HEAD || ancestor === MAIN_START);
    },
    end(itemId, status, output, extra = {}) {
      const session = sessions.get(itemId);
      if (!session || session.status !== "running") assert.fail(`no running session for ${itemId}`);
      const asked = [...runner.requests].reverse().find((request) => request.subject.id === itemId);
      const told = /merge it to/.test(asked?.vars.finish ?? "");
      if (runner.merges && told && session.role === "implement" && status === "succeeded" && (output as { done?: boolean } | undefined)?.done === true) runner.main = MAIN_MERGED;
      const over: Session = { ...session, status, finishedAt: now(), endReason: extra.endReason ?? status, agentSessionId: `agent-${session.ref.id}`, ...(extra.costUsd !== undefined ? { costUsd: extra.costUsd } : {}), ...(extra.setupFailed ? { setupFailed: true as const } : {}), ...(extra.setupOutcome ? { setupOutcome: extra.setupOutcome } : {}), ...(extra.cwd ? { cwd: extra.cwd } : {}) };
      sessions.set(itemId, over);
      store.setValue(sessionResultKey(session.ref.id), JSON.stringify({ output, resumeAt: extra.resumeAt, denied: extra.denied }));
      store.put(over, "orchestrator", now());
    },
  };
  const calls: string[] = [];
  const lines: string[] = [];
  const hostWrites: string[] = [];
  const actions: Actions = {
    get claimant() {
      return out.claimant;
    },
    get claims() {
      return out.claims ? (true as const) : undefined;
    },
    async claim(target, until) {
      calls.push(`claim ${target.id} until ${until}`);
      return out.claim;
    },
    async release(target, reason) {
      hostWrites.push(`release ${target.id} ${reason ?? ""}`);
      calls.push(`release ${target.id}`);
    },
    async answerTurn(target, kind, reason) {
      hostWrites.push(`answerTurn ${target.id} ${kind} ${reason ?? ""}`);
      calls.push(`answerTurn ${target.id} ${kind}`);
    },
    async closeMerged(target, merged) {
      out.closes.push(`${target.id} ${merged.sha} ${merged.batch ?? "-"}`);
      if (out.closeResult === "throw") throw new Error("GitHub refused: 403");
      return out.closeResult;
    },
    async appendLog(target, kind, fields) {
      hostWrites.push(`appendLog ${target.id} ${kind} ${JSON.stringify(fields)}`);
      // The progress lines are kept apart, so the tests of the other actions read as before.
      if (kind === "session" || kind === "question" || kind === "assumption") lines.push(`${target.id} ${kind} ${JSON.stringify(fields)}`);
      else calls.push(`appendLog ${target.id} ${kind} ${JSON.stringify(fields)}`);
    },
  };
  const source = "load" in cfg ? cfg : fixedConfig(cfg);
  const events = (prefix = "orchestrator.") => store.eventsAfter(0, 10_000).filter((event) => event.kind.startsWith(prefix));
  const out: World = {
    store, runner, clock, calls, hostWrites, lines, events, claim: { won: true }, closeResult: "closed", closes: [],
    depsFor: () => ({ store, runner, config: source, actions, now, ...(out.queue ? { queue: out.queue } : {}), ...(out.mergeQueue ? { mergeQueue: out.mergeQueue } : {}) }),
    run: () => tick(out.depsFor()),
    reasons: (kind) => events(kind).map((event) => (event.data as { reason: string }).reason),
    job: (id) => loadJobs(store)[refKey(ref(id))],
  };
  return out;
}

const TRIAGE_OK = { ready: true, size: "small", questions: [], blockers: [], paths: ["src/a.ts"] };
const IMPLEMENT_OK = { done: true, summary: "Did it." };
const REVIEW_OK = { verdict: "approve", findings: [] };
const REVIEW_CHANGES = { verdict: "changes", findings: [{ severity: "must", file: "src/a.ts", text: "Off by one." }] };

/** Ends the item's session, moves past the continuation delay and ticks. */
async function step(w: World, id: string, status: SessionStatus, output?: unknown, extra?: { resumeAt?: string; endReason?: string; denied?: string[] }) {
  w.runner.end(id, status, output, extra);
  await w.run();
  w.clock.ms += 1000;
  return w.run();
}

function usage(five: number | undefined, week: number | undefined, extra: Partial<UsageSample> = {}): UsageSample {
  return {
    at: new Date(T0).toISOString(), status: "allowed", ...extra,
    windows: [
      { kind: "five_hour", utilization: five, resetsAt: new Date(T0 + 2 * 3600_000).toISOString() },
      // Half the week is gone.
      { kind: "seven_day", utilization: week, resetsAt: new Date(T0 + 3.5 * 24 * 3600_000).toISOString() },
    ],
  };
}

// --- pure parts ---

test("ready items: todo, not blocked, not held, no decision pending, no open change, no job", () => {
  const items = [
    item("1"),
    item("2", { state: "doing" }),
    item("3", { blockedBy: [ref("1")] }),
    item("4", { blockedBy: [ref("99")] }),
    item("5", { holder: { actor: { id: "a", name: "Ada" }, until: "2026-11-18T11:00:00Z" } }),
    item("6", { holder: { actor: { id: "scopesoup@b", name: "scopesoup on b", bot: true }, until: "2026-11-18T09:00:00Z" } }),
    item("7", { needsDecision: true }),
    item("8", { openChildren: 2 }),
    item("9", { state: "done" }),
    item("10", { blockedBy: [ref("9")] }),
    item("11"),
    item("12"),
    // A person's hold has no stall timer: a passed `until` does not free it.
    item("13", { holder: { actor: { id: "a", name: "Ada" }, until: "2026-11-18T09:00:00Z" } }),
  ];
  const change = { ref: { host: "fake", kind: "change", id: "c1" }, state: "open", works: [ref("11")] } as Change;
  const jobs = { [refKey(ref("12"))]: { item: ref("12"), step: "implement" } as ReturnType<typeof loadJobs>[string] };
  const { ready, held } = readyItems(items, [change], jobs, new Date(T0).toISOString());
  assert.deepEqual(ready.map((entry) => entry.ref.id), ["1", "6", "10"]);
  assert.deepEqual(held.map((entry) => `${entry.item.ref.id}: ${entry.reason}`), [
    "3: blocked by 1", "4: blocked by 99", "5: held by Ada", "7: waits for a decision by a person", "8: has 2 open child item(s)",
    "11: an open change already covers it", "12: already in work (implement)", "13: held by Ada",
  ]);
});

test("order: Items with a triage first, bugs first by label, then smaller, then older; the rest oldest first", () => {
  const triaged = { log: [{ at: new Date(T0).toISOString(), by: { who: "scopesoup", agent: true as const }, kind: "session" as const, fields: { role: "triage" } }] };
  const items = [item("30", triaged), item("7", { ...triaged, labels: ["Bug"] }), item("4"), item("12"), item("5", { ...triaged, labels: ["bug"] }), item("2", { labels: ["bug"] }), item("1")];
  const jobs = { [refKey(ref("12"))]: { triage: { size: "small" } }, [refKey(ref("4"))]: { triage: { size: "large" } } } as unknown as ReturnType<typeof loadJobs>;
  assert.deepEqual(items.sort(compareItems(["bug"], jobs, items)).map((entry) => entry.ref.id), ["5", "7", "12", "30", "4", "1", "2"]);
  const named = [item("b", { updatedAt: "2026-11-02T00:00:00Z" }), item("a", { updatedAt: "2026-11-03T00:00:00Z" })];
  assert.deepEqual(named.sort(compareItems([], {}, named)).map((entry) => entry.ref.id), ["b", "a"]);
});

test("backoff: 10 s doubling up to the cap", () => {
  assert.deepEqual([1, 2, 3, 4, 10].map((n) => backoffMs(n, 60_000)), [10_000, 20_000, 40_000, 60_000, 60_000]);
});

// --- the tick ---

// --- the levels: one test per level, each showing which steps start ---

const STATED_EARLY = { labels: ["size:small"] };
const roles = (w: World): string[] => w.runner.requests.map((request) => request.role);
const MERGES = { remoteUrl: "git@git.example.invalid:team/project.git", checkCommand: ["node", "check.js"] };

test("level 0 (Watch): no session starts, nothing is handed over, and the idle line says why; there is no would-start event", async () => {
  const w = world(config({ level: 0, settings: { maxParallelSessions: { value: 2, reason: "test" } } }), [item("1"), item("2", { labels: ["bug"] }), item("3", STATED_EARLY)]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const report = await w.run();
  assert.deepEqual([report.started, roles(w), loadJobs(w.store)], [[], [], {}]);
  assert.equal(report.idle, "Nothing was started because the project is at level 0 (Watch): Scope Soup shows the work and starts nothing (raise the level to let it work).");
  assert.equal("would" in report, false);
  await w.run();
  assert.deepEqual([w.events("orchestrator.would").length, roles(w)], [0, []]);
});

test("level 1 (Triage): only triage starts, a stated size gets its triage too, and a triaged item waits at implement", async () => {
  const w = world(config({ level: 1, settings: { maxParallelSessions: { value: 2, reason: "test" } } }), [item("1"), item("2", STATED_EARLY)]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  assert.deepEqual(roles(w), ["triage", "triage"]);
  await step(w, "1", "succeeded", TRIAGE_OK);
  w.clock.ms += 5000;
  await w.run();
  assert.equal(w.job("1")?.step, "implement");
  assert.deepEqual(roles(w), ["triage", "triage"]);
  assert.ok(w.reasons("orchestrator.idle").some((reason) => /1 item\(s\) wait at a step above level 1 \(Triage\) \(1 at implement\)/.test(reason)));
});

test("level 2 (Implement): triage and implement start, a stated size skips triage, and the session's own merge without review finishes it", async () => {
  const w = world(config({ level: 2, ...MERGES }), [item("1")]);
  w.queue = fakeQueue();
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.deepEqual(roles(w), ["triage", "implement"]);
  assert.equal(w.job("1")?.parked?.as, "queued");
  assert.match(w.reasons("orchestrator.merged")[0] ?? "", /The implementing session merged it/);
  assert.deepEqual((w.queue as ReturnType<typeof fakeQueue>).enqueued, []);
  const stated = world(config({ level: 2 }), [item("1", STATED_EARLY)]);
  await stated.run();
  assert.deepEqual(roles(stated), ["implement"]);
});

test("level 3 (Review): triage, implement and review start; an approved change goes back to the implementor to merge, and Scope Soup merges nothing", async () => {
  const w = world(config({ level: 3, ...MERGES }), [item("1")]);
  w.queue = fakeQueue();
  await toHandOver(w);
  assert.deepEqual(roles(w), ["triage", "implement", "review", "implement"]);
  assert.equal(w.job("1")?.parked?.as, "queued");
  assert.equal(w.job("1")?.merged, HEAD);
  assert.deepEqual((w.queue as ReturnType<typeof fakeQueue>).enqueued, []);
});

test("level 4 (Autopilot): triage, implement and review start, and the reviewed change goes to the merge queue, with no Approve", async () => {
  const queue = fakeQueue();
  const w = world(config({ level: 4, ...MERGES }), [item("1")]);
  w.queue = queue;
  await toHandOver(w);
  assert.deepEqual(roles(w), ["triage", "implement", "review"]);
  assert.deepEqual(queue.enqueued, ["1 scopesoup/1"]);
  assert.equal(w.job("1")?.parked?.as, "queued");
  // The approval is tied to the revision it was given on (the board's Merge queue reads it).
  assert.equal(w.job("1")?.reviewedHead, w.job("1")?.head);
  assert.ok(w.job("1")?.head);
  assert.equal(w.runner.main, MAIN_START, "the session did not merge: Scope Soup merges at level 4");
});

test("a level change is an event, and a change built after the level went below 3 goes to the session-merge check without review", async () => {
  let state: ReturnType<ConfigSource["load"]> = { config: config({ level: 3 }), changed: true };
  const w = world({ load: () => state }, [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  state = { config: config({ level: 2 }), changed: true };
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  // The session was started at level 3 and told not to merge, so main does not contain it: a person is told, nothing is lost.
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.match(w.job("1")?.parked?.reason ?? "", /does not contain scopesoup\/1/);
  assert.deepEqual(roles(w), ["triage", "implement"]);
  assert.deepEqual(w.reasons("orchestrator.level_changed"), ["The level changed from level 3 (Review) to level 2 (Implement)."]);
});

/** A person presses one of the switches (store/control.ts). */
const press = (w: World, action: ControlAction): void => void applyControl(w.store, action, new Date(w.clock.ms).toISOString(), "test");

test("a triage request stored earlier is ignored: with agents paused nothing starts; started at level 1, every Item gets its triage", async () => {
  const w = world(config({ level: 1, settings: { maxParallelSessions: { value: 3, reason: "test" } } }), [item("1"), item("2", STATED_EARLY)]);
  setRolesForTest(w.store, "paused");
  w.store.setValue("orchestrator.triages", JSON.stringify([refKey(ref("1"))]));
  w.store.addUsageSample(usage(0.1, 0.1));
  const paused = await w.run();
  assert.deepEqual(roles(w), [], "no triage runs while agents are paused");
  assert.equal(paused.paused, true);
  press(w, "agents.start");
  w.clock.ms += 1000;
  await w.run();
  assert.deepEqual(roles(w), ["triage", "triage"], "a stated size gets its triage too at level 1");
  press(w, "stop");
  assert.equal((w.events("control.stopped")[0]?.data as Record<string, unknown>).triagesCancelled, undefined);
});

test("Stop: nothing starts and running sessions are ended, then continued after Start agents", async () => {
  const w = world(config(), [item("1")]);
  await w.run();
  assert.equal(w.runner.requests.length, 1);

  press(w, "stop");
  const stopped = await w.run();
  assert.deepEqual(w.runner.stops, ["Stopped: a person pressed Stop."]);
  assert.match(stopped.idle ?? "", /because Stop was pressed/);
  assert.equal(stopped.paused, true);
  assert.match(w.reasons("orchestrator.stopped")[0] ?? "", /Ended 1 running session/);
  w.clock.ms += 60_000;
  await w.run();
  assert.equal(w.runner.requests.length, 1);
  assert.match(w.reasons("orchestrator.interrupted")[0] ?? "", /not counted as a failure/);
  assert.equal(w.job("1")?.failures, 0);

  // Pause agents after Stop keeps it stopped; Start merge queue alone starts no session.
  press(w, "agents.pause");
  press(w, "mergeQueue.start");
  assert.equal(agentsState(w.store), "stopped");
  w.clock.ms += 1000;
  await w.run();
  assert.equal(w.runner.requests.length, 1);

  press(w, "agents.start");
  w.clock.ms += 1000;
  await w.run();
  assert.equal(w.runner.requests.length, 2);
  assert.equal(w.runner.requests[1]?.resume, "agent-s1");
  assert.equal(w.runner.requests[1]?.attempt, 1);
});

test("Pause agents: a running session finishes its step and is settled, and nothing new starts until Start agents", async () => {
  const w = world(config(), [item("1"), item("2")]);
  await w.run();
  assert.equal(w.runner.requests.length, 1);

  press(w, "agents.pause");
  const paused = await w.run();
  assert.deepEqual(w.runner.stops, [], "Pause agents ends no session");
  assert.equal(paused.paused, true);
  assert.equal(paused.running, 1);
  assert.match(paused.idle ?? "", /because triage and implementors are paused \(press Resume on their lanes to go on\); 1 running session\(s\) finish their step/);

  // The session finishes: its answer is settled and the item moves to its next step, which does not start.
  w.runner.end("1", "succeeded", TRIAGE_OK);
  w.clock.ms += 60_000;
  await w.run();
  assert.equal(w.job("1")?.step, "implement");
  assert.equal(w.runner.requests.length, 1, "neither the next step nor a new item starts");
  assert.deepEqual(w.runner.stops, []);

  press(w, "agents.start");
  w.clock.ms += 1000;
  await w.run();
  assert.equal(w.runner.requests[1]?.role, "implement");
});

describe("each role's switch", { concurrency: 4 }, () => {
  const at = (w: World): string => new Date(w.clock.ms).toISOString();

  test("triage paused: a running triage finishes its step, no new triage starts, and the implementors go on", async () => {
    const w = world(config({ settings: { maxParallelSessions: { value: 3, reason: "test" } } }), [item("1")]);
    w.store.addUsageSample(usage(0.1, 0.1));
    await w.run();
    press(w, "triage.pause");
    w.store.put(item("2"), "sync", at(w));
    await step(w, "1", "succeeded", TRIAGE_OK);
    assert.deepEqual(roles(w), ["triage", "implement"], "the triage under way was settled; 2 gets no triage");
    assert.deepEqual(w.runner.stops, [], "pausing ends nothing");
    const idle = await w.run();
    assert.match(idle.idle ?? "", /^Nothing was started because triage is paused \(1 item\(s\) wait for it\)/);
    assert.equal(idle.paused, undefined, "the other roles go on");
    press(w, "triage.start");
    w.clock.ms += 1000;
    await w.run();
    assert.deepEqual(roles(w), ["triage", "implement", "triage"]);
  });

  test("implementors paused: triages go on, no implement step starts until resumed", async () => {
    const w = world(config({ settings: { maxParallelSessions: { value: 3, reason: "test" } } }), [item("1"), item("2")]);
    w.store.addUsageSample(usage(0.1, 0.1));
    press(w, "implement.pause");
    await w.run();
    assert.deepEqual(roles(w), ["triage", "triage"]);
    const idle = await step(w, "1", "succeeded", TRIAGE_OK);
    assert.deepEqual(roles(w), ["triage", "triage"], "1's implement step waits");
    assert.equal(w.job("1")?.step, "implement");
    assert.match(idle.idle ?? "", /because implementors are paused \(1 item\(s\) wait for them\)/);
    assert.equal(idle.queued, 0, "a step waiting for a paused role is not work to stay awake for");
    press(w, "implement.start");
    w.clock.ms += 1000;
    await w.run();
    assert.deepEqual(roles(w), ["triage", "triage", "implement"]);
  });

  test("review paused: the review step waits while a new Item's triage starts", async () => {
    const w = world(config({ rules: STAGE1, settings: { maxParallelSessions: { value: 3, reason: "test" } } }), [item("1")]);
    w.store.addUsageSample(usage(0.1, 0.1));
    press(w, "review.pause");
    await w.run();
    await step(w, "1", "succeeded", TRIAGE_OK);
    const idle = await step(w, "1", "succeeded", IMPLEMENT_OK);
    assert.deepEqual(roles(w), ["triage", "implement"]);
    assert.equal(w.job("1")?.step, "review");
    assert.match(idle.idle ?? "", /^Nothing was started because review is paused \(1 item\(s\) wait for it\)/);
    w.store.put(item("2"), "sync", at(w));
    w.clock.ms += 1000;
    await w.run();
    assert.deepEqual(roles(w), ["triage", "implement", "triage"]);
    press(w, "review.start");
    w.clock.ms += 1000;
    await w.run();
    assert.deepEqual(roles(w), ["triage", "implement", "triage", "review"]);
  });

  test("a role's switch is named in the idle reason only from its level; Stop and resuming one role ends nothing of it", async () => {
    // Level 1: implementors and review do not run there, so their paused switches are not named.
    const low = world(config({ level: 1 }), []);
    press(low, "implement.pause");
    press(low, "review.pause");
    const quiet = await low.run();
    assert.equal(quiet.idle, "Nothing was started because no item is ready.");

    const w = world(config(), [item("1")]);
    await w.run();
    press(w, "stop");
    await w.run();
    assert.equal(w.runner.running(), 0, "Stop ended the triage");
    press(w, "triage.start");
    w.clock.ms += 1000;
    await w.run();
    assert.equal(w.runner.requests.at(-1)?.role, "triage");
    w.clock.ms += 1000;
    await w.run();
    assert.equal(w.runner.running(), 1, "the implementors are still stopped, but a resumed triage is not ended");
  });
});

test("after a restart nothing starts until Start agents: the loop comes up paused", async () => {
  const w = world(config(), [item("1")]);
  const timers: { run: () => void; ms: number }[] = [];
  const reports: { started: number; paused: boolean }[] = [];
  let settled: () => void = () => undefined;
  const loop = createLoop({
    store: w.store, runner: w.runner, config: fixedConfig(config()), actions: dryActions,
    now: () => new Date(w.clock.ms).toISOString(),
    setTimer: (run, ms) => timers.push({ run, ms }),
    clearTimer: (handle) => void (timers[(handle as number) - 1] = { run: () => undefined, ms: -1 }),
    onTick: (report) => {
      reports.push({ started: report.started.length, paused: report.paused === true });
      settled();
    },
  });
  const fire = async () => {
    const done = new Promise<void>((resolve) => (settled = resolve));
    timers.at(-1)?.run();
    await done;
    await new Promise((resolve) => setImmediate(resolve));
  };
  // Both were started before the restart.
  assert.deepEqual([agentsState(w.store), mergeQueueState(w.store)], ["started", "started"]);
  loop.start();
  assert.deepEqual([agentsState(w.store), mergeQueueState(w.store)], ["paused", "paused"]);
  const startup = w.events("control.startup_paused");
  assert.equal(startup.length, 1);
  assert.deepEqual(startup[0]?.data, { triage: "started", implement: "started", review: "started", mergeQueue: "started", reason: "Scope Soup starts paused: press Resume on the lanes (triage, implementors, review, the merge queue) to let it work." });
  await fire();
  assert.deepEqual(reports, [{ started: 0, paused: true }]);
  assert.equal(w.runner.requests.length, 0);

  press(w, "agents.start");
  loop.refresh();
  await fire();
  assert.deepEqual(reports.at(-1), { started: 1, paused: false });
  await loop.stop();
});

test("the budget: over the reserve nothing starts, and the event says until when", async () => {
  const w = world(config({ rules: STAGE1 }), [item("1")]);
  w.store.addUsageSample(usage(0.85, 0.1));
  const report = await w.run();
  assert.equal(w.runner.requests.length, 0);
  assert.equal(report.wakeAt, "2026-11-18T12:00:00.000Z");
  assert.deepEqual([report.running, report.queued], [0, 1]);
  assert.match(report.idle ?? "", /5-hour window is at 85 %/);
  assert.match(w.reasons("orchestrator.budget_wait")[0] ?? "", /Waiting until the reset at 2026-11-18T12:00:00.000Z/);
  await w.run();
  assert.equal(w.events("orchestrator.budget_wait").length, 1);

});

test("at level 1 with the default config the stop at the 20 % reserve is always on: no session starts when less than 20 % is left", async () => {
  const cfg = config({ level: 1 });
  assert.equal(cfg.settings.budgetReserve.value, 3, "the default position keeps 20 %");
  const tight = world(cfg, [item("1")]);
  tight.store.addUsageSample(usage(0.85, 0.1));
  const report = await tight.run();
  assert.equal(tight.runner.requests.length, 0);
  assert.match(report.idle ?? "", /5-hour window is at 85 %/);
  const weekly = world(cfg, [item("1")]);
  weekly.store.addUsageSample(usage(0.1, 0.81));
  await weekly.run();
  assert.equal(weekly.runner.requests.length, 0);
  // With more than 20 % left the triage starts.
  const room = world(cfg, [item("1")]);
  room.store.addUsageSample(usage(0.79, 0.1));
  await room.run();
  assert.deepEqual(room.runner.requests.map((request) => request.role), ["triage"]);
});

test("the budget: the reserve is the one usage control; a week used ahead of an even pace still starts work", async () => {
  // Half the week gone, 60 % used: inside the reserve, but ahead of an even pace.
  const without = world(config({ rules: STAGE1 }), [item("1")]);
  without.store.addUsageSample(usage(0.1, 0.6));
  await without.run();
  assert.equal(without.runner.requests.length, 1);

  // An old file that still switches pacing on loads with a notice and changes nothing.
  const paced = world(config({ rules: { ...STAGE1, weeklyPacing: { on: true, reason: "test" } } }), [item("1")]);
  paced.store.addUsageSample(usage(0.1, 0.6));
  await paced.run();
  assert.equal(paced.runner.requests.length, 1);
});

test("the budget: an unknown reading allows one probe, not a second session", async () => {
  const w = world(config({ settings: { maxParallelSessions: { value: 3, reason: "test" } } }), [item("1"), item("2")]);
  const report = await w.run();
  assert.equal(report.started.length, 1);
  assert.match(w.reasons("orchestrator.started")[0] ?? "", /No usage reading yet; starting one session to get a reading/);
  assert.match(w.reasons("orchestrator.budget_wait")[0] ?? "", /waiting for a reading from the 1 running session/);
  w.store.addUsageSample(usage(0.1, 0.1));
  assert.equal((await w.run()).started.length, 1);
});

test("the budget: paid extra usage stops running sessions too", async () => {
  const w = world(config(), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  w.store.addUsageSample(usage(0.1, 0.1, { usingOverage: true }));
  await w.run();
  assert.equal(w.runner.stops.length, 1);
  assert.match(w.reasons("orchestrator.budget_stop")[0] ?? "", /Paid extra usage.*Stopped 1 running session/);
  w.clock.ms += 5000;
  await w.run();
  assert.equal(w.runner.requests.length, 1);
});

test("dispatch order and slots: triages oldest first; the rest waits for a slot", async () => {
  const w = world(config({ settings: { maxParallelSessions: { value: 2, reason: "test" } } }), [
    item("3"), item("2", { labels: ["bug"] }), item("1"), item("4", { needsDecision: true }),
  ]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const report = await w.run();
  assert.deepEqual(report.started.map((entry) => `${entry.role} ${entry.item}`), ["triage fake:work:1", "triage fake:work:2"]);
  // What the keep-awake decision reads: two running, the third item ready but without a slot.
  assert.deepEqual([report.running, report.queued, report.paused], [2, 1, undefined]);
  const again = await w.run();
  assert.equal(again.idle, "Nothing was started because 2 session(s) are running; all 2 session slot(s) are in use.");
  assert.equal(w.reasons("orchestrator.idle").at(-1), again.idle);
});

test("start picks from the whole backlog: an old inviteLabel was dropped with a notice, and every ready item is a candidate", async () => {
  const result = validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", level: 2, inviteLabel: "scopesoup", settings: { maxParallelSessions: { value: 3, reason: "test" } } }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  assert.ok(result.notices.some((notice) => notice.startsWith("inviteLabel was dropped: Scope Soup picks from the whole backlog")));
  const w = world(result.config, [item("1"), item("2", { labels: ["scopesoup"] }), item("3")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  assert.deepEqual((await w.run()).started.map((entry) => entry.item), ["fake:work:1", "fake:work:2", "fake:work:3"]);
  const jobs = { [refKey(ref("1"))]: { item: ref("1"), step: "implement" } as ReturnType<typeof loadJobs>[string] };
  const { ready, held } = readyItems([item("1"), item("2")], [], jobs, new Date(T0).toISOString());
  assert.deepEqual([ready.map((each) => each.ref.id), held.map((entry) => `${entry.item.ref.id}: ${entry.reason}`)], [["2"], ["1: already in work (implement)"]]);
});

test("nothing to do says why", async () => {
  const w = world(config(), [item("1", { needsDecision: true }), item("2", { blockedBy: [ref("1")] })]);
  const report = await w.run();
  assert.equal(report.idle, "Nothing was started because no item is ready (2 held: 1 waits for a decision by a person, 2 blocked by 1).");
  await w.run();
  assert.equal(w.events("orchestrator.idle").length, 1);
  assert.equal((await world(config()).run()).idle, "Nothing was started because no item is ready.");
  assert.equal(w.store.getValue("orchestrator.idle_reason"), report.idle, "the board reads the reason from the store");
});

test("the idle reason is emptied once something starts", async () => {
  const w = world(config(), [item("1", { blockedBy: [ref("9")] })]);
  await w.run();
  assert.match(w.store.getValue("orchestrator.idle_reason") ?? "", /^Nothing was started because/);
  const started = world(config(), [item("1")]);
  started.store.setValue("orchestrator.idle_reason", "old");
  await started.run();
  assert.equal(started.store.getValue("orchestrator.idle_reason"), "");
});

test("the triage-to-implement handover writes a store event at once, so a board that reloads on events follows it", async () => {
  const w = world(config({ rules: STAGE1 }), [item("1", { body: "Do the thing.", verification: "pnpm test" })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  const seen: { kind: string; subject?: string; next?: unknown; step?: string }[] = [];
  w.store.onEvent((event) => seen.push({ kind: event.kind, subject: event.subject, next: (event.data as { next?: unknown } | null)?.next, step: w.job("1")?.step }));
  w.runner.end("1", "succeeded", TRIAGE_OK);
  await w.run();
  // The delay before implement starts is no reason to wait for a poll: the handover itself is an event, and the job it describes is already saved.
  assert.deepEqual(seen.filter((event) => event.kind === "orchestrator.step"), [{ kind: "orchestrator.step", subject: refKey(ref("1")), next: "implement", step: "implement" }]);
  assert.equal(w.runner.requests.length, 1);
});

test("the job cycle: triage, implement, review, the implementor resumed with the findings, review, then merged by the session; nothing waits for an Approve", async () => {
  const w = world(config({ rules: STAGE1 }), [item("1", { body: "Do the thing.", verification: "pnpm test" })]);
  w.claims = true;
  w.store.addUsageSample(usage(0.1, 0.1));
  w.runner.paths = ["src/a.ts", "apps/api/migrations/0007_x.sql"];

  await w.run();
  assert.equal(w.runner.requests[0]?.role, "triage");
  assert.equal(w.runner.requests[0]?.branch, "scopesoup/1");
  assert.equal(w.runner.requests[0]?.vars.itemBody, "Do the thing.");

  // The next step waits out the one-second continuation delay.
  w.runner.end("1", "succeeded", TRIAGE_OK);
  const between = await w.run();
  assert.equal(between.started.length, 0);
  assert.equal(between.wakeAt, new Date(T0 + 1000).toISOString());
  w.clock.ms += 1000;
  await w.run();
  assert.equal(w.runner.requests[1]?.role, "implement");

  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.equal(w.runner.requests[2]?.role, "review");
  assert.equal(w.job("1")?.agentSession, "agent-s2");

  // A changes verdict resumes the implementor's own agent session with only the findings.
  await step(w, "1", "succeeded", REVIEW_CHANGES);
  assert.equal(w.runner.requests[3]?.role, "implement");
  assert.equal(w.runner.requests[3]?.resume, "agent-s2");
  assert.equal(w.runner.requests[3]?.message, "The reviewer asked for these changes:\n- [must] src/a.ts: Off by one.\nFix them and commit. Answer as before.");

  await step(w, "1", "succeeded", { done: true, summary: "Fixed." });
  assert.equal(w.runner.requests[4]?.role, "review");

  // The approval resumes the implementor's own session to merge it.
  await step(w, "1", "succeeded", REVIEW_OK);
  assert.equal(w.runner.requests[5]?.role, "implement");
  assert.equal(w.runner.requests[5]?.resume, "agent-s4");
  assert.equal(w.runner.requests[5]?.message, "Approved. Merge now as CLAUDE.md says. Answer as before.");
  await step(w, "1", "succeeded", { done: true, summary: "Merged." });
  assert.equal(w.runner.requests.length, 6);
  // A change that touches a migration does not wait for an answer any more: the session merged it, and it is done.
  const job = w.job("1");
  assert.equal(job?.parked?.as, "queued");
  assert.equal(job?.merged, HEAD);
  assert.equal(w.reasons("orchestrator.waiting_person").length, 0);
  assert.match(w.reasons("orchestrator.merged")[0] ?? "", /scopesoup\/1 is merged: origin\/main at 2222222 contains its head 3333333\. The implementing session merged it/);
  assert.deepEqual(w.closes, [`1 ${HEAD} -`]);
  assert.ok(w.calls.some((call) => call.startsWith("appendLog 1 merged")), w.calls.join("\n"));
  assert.equal(w.calls.filter((call) => call.startsWith("answerTurn")).length, 0);
  for (const event of w.events()) assert.ok((event.data as { reason: string }).reason.length > 10, event.kind);

  // A finished job is not picked again.
  w.clock.ms += 3600_000;
  await w.run();
  assert.equal(w.runner.requests.length, 6);
});

test("level 2: Scope Soup's claim is released once the implementing session merged", async () => {
  const w = world(config({}), [item("1")]);
  w.claims = true;
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  assert.ok(!w.calls.includes("release 1"));
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.equal(w.job("1")?.merged, HEAD);
  assert.equal(w.calls.filter((call) => call === "release 1").length, 1);
  assert.ok(w.hostWrites.includes("release 1 merged on main as 3333333"), w.hostWrites.join(" | "));
});

async function toHandOver(w: World): Promise<void> {
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  await step(w, "1", "succeeded", REVIEW_OK);
  // Below level 4 an approval resumes the implementor to merge it.
  if (w.job("1")?.merge) await step(w, "1", "succeeded", IMPLEMENT_OK);
}

test("a session that said done but did not merge and named no pull request: a person is told where the branch is; nothing is lost or merged", async () => {
  const w = world(config({ rules: STAGE1 }), [item("1")]);
  w.runner.merges = false;
  await toHandOver(w);
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.equal(w.job("1")?.parked?.retry, "hand-over");
  assert.deepEqual(w.calls.filter((call) => call.startsWith("answerTurn")), ["answerTurn 1 escalation"]);
  const said = w.reasons("orchestrator.escalated")[0] ?? "";
  assert.match(said, /does not contain scopesoup\/1/);
  assert.match(said, /no pull request/);
  assert.match(said, /in the clone [^ ]*clone\./);
  assert.match(said, /git -C "[^"]*clone" push origin scopesoup\/1/);
  assert.equal(w.reasons("orchestrator.merged").length, 0);
  assert.equal(w.reasons("orchestrator.handed_over").length, 0);
});

test("a failed setup parks the Item for a person with the setup's reason, not counted as a failed attempt; its output never reaches the host", async () => {
  const w = world(config({ level: 2 }), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  assert.equal(w.runner.requests.at(-1)?.role, "implement");
  // The session's own reason (local: the board's Item page shows it) has the end of the output, which may hold a secret.
  w.runner.end("1", "failed", undefined, {
    endReason: "Setup failed in /srv/ws/slot-1 (it has not run in this folder yet), so no implement session started. The setup exited with code 1. The end of its output:\nAPI_TOKEN=synthetic-leaked-value",
    setupFailed: true, setupOutcome: "exit 1", cwd: "/srv/ws/slot-1",
  });
  await w.run();
  const job = w.job("1");
  assert.equal(job?.parked?.as, "escalated");
  assert.equal(job?.failures, 0);
  assert.equal(job?.parked?.reason, "Setup failed in /srv/ws/slot-1 (exit 1); the output is on Scope Soup's board on laptop-a. This is the project's setup, not the agent's work, and it is not counted as a failed attempt. Fix the setup (setupCommand on the Settings page, or the setup script it runs) and answer here to try again.");
  assert.equal(w.reasons("orchestrator.retry_scheduled").length, 0);
  assert.ok(w.calls.includes("answerTurn 1 escalation"));
  // What went to the host: a person's turn, the question and the session line in the item's log. None carries the output.
  const written = w.hostWrites.join("\n");
  assert.match(written, /answerTurn 1 escalation Setup failed in \/srv\/ws\/slot-1 \(exit 1\); the output is on Scope Soup's board on laptop-a\./);
  assert.match(written, /appendLog 1 session .*Setup failed in \/srv\/ws\/slot-1 \(exit 1\); the output is on Scope Soup's board on laptop-a\./);
  assert.equal(written.includes("synthetic-leaked-value"), false);
  assert.equal(written.includes("The end of its output"), false);
});

test("a session that opened a pull request instead of merging is handed over with the link, in Your turn", async () => {
  const w = world(config({ level: 2 }), [item("1")]);
  w.runner.merges = false;
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, mergedAs: "https://git.example.invalid/team/project/pull/7" });
  assert.equal(w.job("1")?.parked?.as, "handed-over");
  assert.match(w.reasons("orchestrator.handed_over")[0] ?? "", /opened a pull request instead of merging: https:\/\/git\.example\.invalid\/team\/project\/pull\/7/);
  const board = buildBoard(loadSnapshot(w.store), new Date(w.clock.ms));
  assert.deepEqual(board.yourTurn.map((card) => [card.key, card.actor]), [[refKey(ref("1")), "anyone"]]);
  assert.match(board.yourTurn[0]?.reason ?? "", /^Merge branch scopesoup\/1: handed over to you/);
});

test("pool workspaces: a branch the session did not merge is named in the pool's clones, not one path", async () => {
  const w = world(config({ rules: STAGE1, workspaces: { kind: "pool", paths: ["/pool/one", "/pool/two"] } }), [item("1")]);
  w.runner.merges = false;
  await toHandOver(w);
  assert.equal(w.job("1")?.parked?.as, "escalated");
  const said = w.reasons("orchestrator.escalated")[0] ?? "";
  assert.match(said, /no pull request/);
  assert.match(said, /in one of the pool's clones/);
  assert.match(said, /git push origin scopesoup\/1/);
  assert.doesNotMatch(said, /git -C/);
});

test("a released failed hand-over starts over when the branch is gone", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  (queue as unknown as { failWith: string }).failWith = "the remote is not the configured repository";
  w.queue = queue;
  await toHandOver(w);
  assert.equal(w.job("1")?.parked?.retry, "hand-over");
  w.runner.changedPaths = async () => {
    throw new Error("unknown revision");
  };
  releaseJob(w.store, ref("1"), "Ada", new Date(w.clock.ms).toISOString(), "Try again.");
  await w.run();
  assert.equal(w.runner.requests.at(-1)?.role, "triage");
  assert.equal(w.job("1")?.step, "triage");
});

test("triage that finds a decision, or an item that is not ready, goes to a person", async () => {
  const w = world(config({ settings: { maxParallelSessions: { value: 3, reason: "test" } } }), [item("1"), item("2"), item("3")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, hidesDecision: true, decision: { question: "Round up or down?", options: ["up", "down"], recommendation: "down" } });
  w.runner.end("2", "succeeded", { ...TRIAGE_OK, ready: false, notReadyReason: "No acceptance criteria." });
  w.runner.end("3", "succeeded", { ...TRIAGE_OK, size: "large" });
  await w.run();
  assert.equal(w.reasons("orchestrator.needs_decision")[0], "Round up or down? Options: up | down. Recommended: down.");
  assert.deepEqual(w.reasons("orchestrator.not_ready"), ["Triage: not ready. No acceptance criteria.", "Triage: too large for one change. Split it into smaller items first."]);
  assert.deepEqual(w.calls, ["answerTurn 1 decision", "answerTurn 2 not-ready", "answerTurn 3 not-ready"]);
  // In the item's log: the question with its options and why the item parked, then the session, with no next step.
  assert.equal(w.lines[0], '1 question {"question":"Round up or down?","options":["up","down"],"recommendation":"down","parked":"needs-decision"}');
  assert.match(w.lines[1] ?? "", /^1 session \{"role":"triage","model":"model-of-triage","outcome":"succeeded",/);
  assert.doesNotMatch(w.lines[1] ?? "", /"next"/);
  assert.match(w.lines[2] ?? "", /^2 question \{"question":"Triage: not ready\. No acceptance criteria\.","parked":"not-ready"\}$/);
  // The triage's verdict in words, `ready`, and the session's id, which links the step to its cost, stream and chat.
  assert.match(w.lines[1] ?? "", /"summary":"Ready, small\. 1 question for a person\.".*"sessionId":"s1".*"ready":true/);
  assert.match(w.lines[3] ?? "", /^2 session .*"summary":"Not ready, small\. No acceptance criteria\.".*"sessionId":"s2".*"ready":false/);
  w.clock.ms += 60_000;
  await w.run();
  assert.equal(w.runner.requests.length, 3);
});

test("a session line carries the session's id and its cost, rounded to a hundredth of a cent", async () => {
  const w = world(config(), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  w.runner.end("1", "succeeded", TRIAGE_OK, { costUsd: 0.123456 });
  await w.run();
  assert.equal(w.lines.length, 1);
  assert.match(w.lines[0]!, /^1 session \{"role":"triage",.*"summary":"Ready, small\.",.*"sessionId":"s1","costUsd":0\.1235,"ready":true,"next":"implement"/);
});

test("triage that finds three decisions keeps all three, writes one question each and says three wait", async () => {
  const w = world(config(), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  const decisions = ["Round up or down?", "Which currency?", "Keep the old format?"].map((question) => ({ question, options: ["a", "b"], recommendation: "a" }));
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, hidesDecision: true, decisions });
  await w.run();
  assert.equal(w.job("1")?.triage?.decisions?.length, 3);
  assert.deepEqual(w.job("1")?.triage?.decisions?.map((d) => d.question), decisions.map((d) => d.question));
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.match(w.reasons("orchestrator.needs_decision")[0] ?? "", /^Triage found 3 decisions for a person/);
  assert.equal(w.lines.filter((line) => line.startsWith("1 question ")).length, 3);
});

test("decisions with a blank question are not counted: not in the reason, the log, the job's questions or the single decision", async () => {
  const w = world(config(), [item("1"), item("2")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  const blank = { question: "  ", options: ["a"], recommendation: "a" };
  const two = [blank, { question: "Round up or down?", options: ["a", "b"], recommendation: "a" }, blank, { question: "Which currency?", options: ["a", "b"], recommendation: "a" }];
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, hidesDecision: true, decisions: two });
  await w.run();
  assert.equal(w.job("1")?.triage?.decisions?.length, 2);
  assert.equal(w.job("1")?.triage?.decision?.question, "Round up or down?");
  assert.equal(jobQuestions(w.job("1")!).length, 2);
  assert.match(w.reasons("orchestrator.needs_decision").find((reason) => reason.startsWith("Triage found")) ?? "", /^Triage found 2 decisions for a person before the work can start: 1\. Round up or down\? 2\. Which currency\?$/);
  assert.equal(w.lines.filter((line) => line.startsWith("1 question ")).length, 2);
  // One real question among blanks is a single question, asked as before.
  if (!w.runner.requests.some((request) => request.vars.itemId === "2")) await w.run();
  w.runner.end("2", "succeeded", { ...TRIAGE_OK, hidesDecision: true, decisions: [blank, { question: "Keep the old format?", options: ["a", "b"], recommendation: "a" }] });
  await w.run();
  assert.deepEqual(jobQuestions(w.job("2")!), []);
  assert.equal(w.job("2")?.triage?.decision?.question, "Keep the old format?");
  assert.equal(w.lines.filter((line) => line.startsWith("2 question ")).length, 1);
});

test("two open questions from triage: the first answer leaves the item parked, the second picks it up, and the next session gets both", async () => {
  const w = world(config(), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  const decisions = ["Round up or down?", "Which currency?"].map((question) => ({ question, options: ["a", "b"], recommendation: "a" }));
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, hidesDecision: true, decisions });
  await w.run();
  assert.equal(jobQuestions(w.job("1")!).length, 2);
  const answer = (index: number, text: string) => {
    const at = new Date(w.clock.ms).toISOString();
    return w.store.tx(() => {
      addAnswer(w.store, { subject: ref("1"), answer: text, by: "Ada", at, question: decisions[index]!.question });
      return answerQuestion(w.store, ref("1"), index, text, "Ada", at);
    });
  };
  assert.deepEqual(answer(0, "Round down."), { released: false, open: 1 });
  w.clock.ms += 60_000;
  await w.run();
  assert.equal(w.job("1")?.parked?.as, "needs-decision", "still waits for the second answer");
  assert.equal(w.runner.requests.length, 1, "no session starts on one answer");
  assert.deepEqual(answer(1, "Swedish kronor."), { released: true, open: 0 });
  w.clock.ms += 60_000;
  await w.run();
  assert.equal(w.runner.requests.length, 2);
  assert.equal(w.runner.requests[1]?.role, "triage");
  assert.match(w.runner.requests[1]?.vars.itemBody ?? "", /Decided by a person.*Asked: Round up or down\?\n  Answered: Round down\.\n- Asked: Which currency\?\n  Answered: Swedish kronor\./s);
});

test("an implementer that stops for a decision is not retried", async () => {
  const w = world(config(), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, done: false, summary: "Which currency?" });
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.equal(w.reasons("orchestrator.needs_decision")[0], "The implementer stopped: Which currency?");
});

test("an implementer that stopped after a refused command is escalated, not put to a person as a decision", async () => {
  const w = world(config(), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  // The refusal is read from the session's result (permission denials), not from the answer.
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, done: false, summary: "I could not run node." }, { denied: ["node -e \"1\""] });
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.match(w.reasons("orchestrator.escalated")[0] ?? "", /tool was refused: node -e "1"\. Add the command to allowedTools of the implement role .* answer here to try again/);
  assert.equal(w.reasons("orchestrator.needs_decision").length, 0);
  assert.deepEqual(w.calls, ["answerTurn 1 escalation"]);
});

test("a refused git commit with $(...) in a role that allows git is a refused shape, not a missing program", async () => {
  const w = world(config({ roles: { implement: { allowedTools: ["Read", "Bash(git *)"] } } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, done: false, summary: "The commit was refused." }, { denied: ['git commit -m "$(cat <<EOF ...)"'] });
  const text = w.reasons("orchestrator.escalated")[0] ?? "";
  assert.match(text, /`git` is already allowed for the implement role, so what was refused was the shape of the command/);
  assert.match(text, /git commit -F/);
  assert.doesNotMatch(text, /Add the command to allowedTools/);
});

test("a refused pnpm exec is not allowed because pnpm check is", async () => {
  const w = world(config({ roles: { implement: { allowedTools: ["Read", "Bash(pnpm check*)"] } } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, done: false, summary: "Stopped." }, { denied: ['pnpm exec node -e "1"'] });
  const text = w.reasons("orchestrator.escalated")[0] ?? "";
  assert.match(text, /Add the command to allowedTools of the implement role/);
  assert.doesNotMatch(text, /shape of the command/);
});

test("a triage answer with markup in a string is retried and the failure carries the raw answer", async () => {
  const w = world(config(), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  // Markup that is not whole `<parameter>` blocks: nothing can be taken out of it.
  const broken = { ...TRIAGE_OK, ready: false, riskReason: "r</notReadyReason>\nSize is large" };
  w.runner.end("1", "succeeded", broken);
  await w.run();
  assert.equal(w.job("1")?.parked, undefined);
  const reason = w.reasons("orchestrator.retry_scheduled")[0] ?? "";
  assert.match(reason, /triage step failed \(1 of 3\)/);
  assert.match(reason, /The answer was: .*notReadyReason/);
  w.clock.ms += 10_000;
  await w.run();
  assert.equal(w.runner.requests[1]?.attempt, 2);
});

test("failures are retried with backoff, then escalated to a person", async () => {
  const w = world(config(), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();

  w.runner.end("1", "failed", undefined, { endReason: "The agent exited with code 3 and no result." });
  const first = await w.run();
  assert.equal(first.wakeAt, new Date(T0 + 10_000).toISOString());
  assert.match(w.reasons("orchestrator.retry_scheduled")[0] ?? "", /triage step failed \(1 of 3\): The agent exited with code 3 and no result\. Trying again in 10 s/);
  w.clock.ms += 9000;
  assert.equal((await w.run()).started.length, 0);
  w.clock.ms += 1000;
  await w.run();
  assert.equal(w.runner.requests[1]?.attempt, 2);
  assert.equal(w.runner.requests[1]?.resume, undefined);

  w.runner.end("1", "stalled", undefined, { endReason: "Stalled: no event for 5 minutes. Killed." });
  await w.run();
  assert.match(w.reasons("orchestrator.retry_scheduled")[1] ?? "", /\(2 of 3\).*Trying again in 20 s/);
  w.clock.ms += 20_000;
  await w.run();
  assert.equal(w.runner.requests[2]?.attempt, 3);

  // An answer of the wrong shape is a failure too.
  w.runner.end("1", "succeeded", { ready: "yes" });
  await w.run();
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.match(w.reasons("orchestrator.escalated")[0] ?? "", /triage step failed 3 times; the limit is 3\. Last failure: The triage answer does not have the expected shape/);
  assert.deepEqual(w.calls, ["answerTurn 1 escalation"]);
  w.clock.ms += 3600_000;
  await w.run();
  assert.equal(w.runner.requests.length, 3);
});

test("a success resets the failure count for the next step", async () => {
  const w = world(config(), [item("1")]);
  await w.run();
  w.runner.end("1", "failed");
  await w.run();
  w.clock.ms += 10_000;
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  assert.equal(w.runner.requests.at(-1)?.role, "implement");
  assert.equal(w.runner.requests.at(-1)?.attempt, 1);
});

test("review rounds are bounded", async () => {
  const w = world(config({ rules: STAGE1, settings: { persistence: { value: 2, reason: "test" } } }), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  await step(w, "1", "succeeded", REVIEW_CHANGES);
  await step(w, "1", "succeeded", { done: true, summary: "Tried." });
  await step(w, "1", "succeeded", REVIEW_CHANGES);
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.match(w.reasons("orchestrator.escalated")[0] ?? "", /still asks for changes after 1 round\(s\) back to the implementor; the limit is 1\. Open findings: Off by one\./);
  assert.deepEqual(w.runner.requests.map((request) => request.role), ["triage", "implement", "review", "implement", "review"]);
});

// --- the fence and the progress guards ---

/** Level 3 with fix rounds to spare (persistence 4: four rounds), up to the first review's start. */
async function toReview(paths: string[], triage: Record<string, unknown> = TRIAGE_OK, extra: Record<string, unknown> = {}): Promise<World> {
  const w = world(config({ rules: STAGE1, settings: { persistence: { value: 4, reason: "test" } }, ...extra }), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  w.runner.paths = paths;
  await w.run();
  await step(w, "1", "succeeded", triage);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  return w;
}

const OUTSIDE = ["lib/one/a.ts", "lib/one/b.ts", "lib/two/c.ts", "tools/d.ts", "web/e/f.ts", "web/e/g.ts"];
const musts = (...texts: string[]) => ({ verdict: "changes", findings: texts.map((text) => ({ severity: "must", text })) });

test("the fence: a change with files far outside the triage's paths parked with the report and a proposed split, not review", async () => {
  const w = await toReview(["src/a.ts", "src/a.test.ts", ...OUTSIDE]);
  const job = w.job("1");
  assert.deepEqual([job?.parked?.as, job?.parked?.byStep, job?.step, roles(w)], ["needs-decision", true, "implement", ["triage", "implement"]]);
  const reason = job?.parked?.reason ?? "";
  assert.match(reason, /^This grew beyond the Item\. 6 changed files are outside the paths its triage named \(5 are allowed\): lib\/one\/a\.ts, lib\/one\/b\.ts, lib\/two\/c\.ts, tools\/d\.ts, web\/e\/f\.ts, web\/e\/g\.ts\. The triage said small and named: src\/a\.ts\./);
  assert.match(reason, /Proposed split: 1\. the triage's paths: src\/a\.ts, src\/a\.test\.ts\. 2\. lib\/one: lib\/one\/a\.ts, lib\/one\/b\.ts\. 3\. web\/e: web\/e\/f\.ts, web\/e\/g\.ts\. 4. the rest: lib\/two\/c\.ts, tools\/d\.ts\./);
  assert.match(reason, /Recommended: Cut it back\.$/);
  assert.deepEqual(job?.decision?.options.map((option) => (typeof option === "string" ? option : option.label)), ["Cut it back", "Go on as it is"]);
  assert.equal(w.events("orchestrator.fenced").length, 1);
  // A person's answer resumes the implementor's own session with the report; what they saw widens the fence, so it goes to review.
  assert.ok(releaseJob(w.store, ref("1"), "Ada", new Date(w.clock.ms).toISOString(), "Go on as it is."));
  await w.run();
  const resumed = w.runner.requests.at(-1);
  assert.deepEqual([resumed?.role, resumed?.resume], ["implement", "agent-s2"]);
  assert.match(resumed?.message ?? "", /^Scope Soup stopped the change before review\. This grew beyond the Item\./);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.equal(roles(w).at(-1), "review");
});

test("the fence: a change well beyond its size parked with how much larger it is", async () => {
  const w = world(config({ rules: STAGE1 }), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  w.runner.changeStat = async () => [{ path: "src/a.ts", lines: 520 }, { path: "src/a.test.ts", lines: 230 }];
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.match(w.job("1")?.parked?.reason ?? "", /^This grew beyond the Item\. It changes 750 lines, 2\.5 times the 300 a small Item is held to\. .*Proposed split: 1\. src: src\/a\.ts, src\/a\.test\.ts \(750 lines\)\./);
});

test("the fence: a change inside the paths and size goes on to review; with no paths named the fence does not apply", async () => {
  const inside = await toReview(["src/a.ts", "src/a.test.ts", "docs/A.md", "docs/B.md", "README.md", "lib/x.ts", "tools/y.ts"]);
  assert.deepEqual([inside.job("1")?.parked, roles(inside).at(-1)], [undefined, "review"]);
  const unnamed = await toReview(["src/a.ts", ...OUTSIDE, "more/1.ts", "more/2.ts"], { ...TRIAGE_OK, paths: [] });
  assert.deepEqual([unnamed.job("1")?.parked, roles(unnamed).at(-1), unnamed.events("orchestrator.fenced").length], [undefined, "review", 0]);
});

test("progress: a review round that does not lower the must findings escalates before the round limit", async () => {
  const w = await toReview(["src/a.ts"]);
  await step(w, "1", "succeeded", musts("Off by one.", "No test."));
  await step(w, "1", "succeeded", { done: true, summary: "Tried." });
  await step(w, "1", "succeeded", musts("Wrong time zone.", "Name is unclear."));
  const job = w.job("1");
  assert.equal(job?.parked?.as, "escalated");
  assert.equal(job?.fixRounds, 1);
  assert.match(w.reasons("orchestrator.escalated")[0] ?? "", /^The review round left 2 `must` finding\(s\), not fewer than the 2 of the round before: a round that gets nowhere ends the run\. After 1 round\(s\) back to the implementor \(the limit is 4\)\. Open findings: Wrong time zone\. \/ Name is unclear\./);
  assert.deepEqual(roles(w), ["triage", "implement", "review", "implement", "review"]);
});

test("progress: fewer must findings go on; the same finding twice in a row escalates", async () => {
  const w = await toReview(["src/a.ts"]);
  await step(w, "1", "succeeded", musts("Off by one.", "No test.", "Wrong time zone."));
  await step(w, "1", "succeeded", { done: true, summary: "Tried." });
  await step(w, "1", "succeeded", musts("Missing doc.", "Name is unclear."));
  assert.deepEqual([w.job("1")?.parked, roles(w).at(-1), w.job("1")?.progress?.must], [undefined, "implement", 2]);
  await step(w, "1", "succeeded", { done: true, summary: "Tried again." });
  await step(w, "1", "succeeded", musts("name  is UNCLEAR."));
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.match(w.reasons("orchestrator.escalated")[0] ?? "", /^The review gives the same finding as the round before: name {2}is UNCLEAR\. The same failure twice in a row ends the run\. After 2 round\(s\)/);
});

test("should findings with review.shouldFindings \"fix\" (the default): back to the implementor once, not counted as a round; what is left after it becomes a draft", async () => {
  const w = await toReview(["src/a.ts"]);
  const approve = { verdict: "approve", findings: [{ severity: "should", file: "src/a.ts", text: "Name the helper after what it returns." }] };
  await step(w, "1", "succeeded", approve);
  assert.deepEqual([w.job("1")?.merge, w.job("1")?.fixRounds, roles(w).at(-1)], [undefined, 0, "implement"]);
  assert.match(w.job("1")?.resumeWith ?? "", /^The reviewer approves, and asks for these smaller changes before the merge:\n- \[should\] src\/a\.ts: Name the helper/);
  assert.deepEqual(openDrafts(w.store), []);
  w.runner.headSha = "4".repeat(40);
  await step(w, "1", "succeeded", { done: true, summary: "Renamed." });
  assert.equal(roles(w).at(-1), "review");
  // The second approval still says it: the merge goes on, and it becomes one draft.
  await step(w, "1", "succeeded", approve);
  assert.deepEqual([w.job("1")?.merge, w.job("1")?.fixRounds, w.job("1")?.parked], [true, 0, undefined]);
  const drafts = openDrafts(w.store);
  assert.deepEqual(drafts.map((each) => [each.from.id, each.role, each.title]), [["1", "reviewer", "After #1: Name the helper after what it returns."]]);
  assert.equal(w.events("orchestrator.escalated").length, 0);
});

test("a round for should findings that commits nothing is not \"nothing to change\": the approved change goes on to the merge and they become a draft", async () => {
  const w = await toReview(["src/a.ts"]);
  w.runner.commitsAhead = async () => 0;
  await step(w, "1", "succeeded", { verdict: "approve", findings: [{ severity: "should", text: "Shorter name." }] });
  assert.equal(roles(w).at(-1), "implement");
  await step(w, "1", "succeeded", { done: true, summary: "The name is fine as it is." });
  assert.deepEqual([w.job("1")?.parked, w.job("1")?.merge, w.job("1")?.shouldRound, roles(w).at(-1)], [undefined, true, undefined, "implement"]);
  assert.equal(w.runner.requests.filter((request) => request.role === "review").length, 1, "not reviewed again");
  assert.deepEqual(openDrafts(w.store).map((each) => each.title), ["After #1: Shorter name."]);
  assert.equal(w.events("orchestrator.escalated").length, 0);
});

test("should findings with review.shouldFindings \"draft\": the change merges and they become one draft, filed once; no should finding files nothing", async () => {
  const w = await toReview(["src/a.ts"], TRIAGE_OK, { review: { shouldFindings: "draft" } });
  await step(w, "1", "succeeded", { verdict: "approve", findings: [{ severity: "should", file: "src/a.ts", text: "Name the helper @bob likes; fixes #8." }, { severity: "should", text: "Add a test for the empty list." }] });
  assert.deepEqual([w.job("1")?.merge, roles(w).at(-1)], [true, "implement"]);
  const drafts = openDrafts(w.store);
  assert.equal(drafts.length, 1);
  assert.doesNotMatch(`${drafts[0]!.title} ${drafts[0]!.description}`, /@bob|fixes #8/);
  assert.match(drafts[0]!.description, /these findings should still change:\n\n- `src\/a\.ts`: Name the helper/);
  assert.match(w.reasons("orchestrator.drafts_filed")[0] ?? "", /^The reviewer of 1 proposed a new Item: .* It waits in Your turn as a draft for a person to approve or deny\./);
  const quiet = await toReview(["src/a.ts"], TRIAGE_OK, { review: { shouldFindings: "draft" } });
  await step(quiet, "1", "succeeded", REVIEW_OK);
  assert.deepEqual(openDrafts(quiet.store), []);
});

test("drafts in the triage's, the implementor's and the reviewer's answers are filed for a person, linked to the Item; nothing goes to the host", async () => {
  const draft = (title: string) => ({ title, description: "Found it while reading.", verification: "It is done." });
  const w = await toReview(["src/a.ts"], { ...TRIAGE_OK, drafts: [draft("Tidy the parser")] });
  await step(w, "1", "succeeded", { ...REVIEW_OK, drafts: [draft("Document the cache"), draft("tidy  the PARSER")] });
  const drafts = openDrafts(w.store);
  assert.deepEqual(drafts.map((each) => [each.role, each.title, each.from.id]), [["triage", "Tidy the parser", "1"], ["reviewer", "Document the cache", "1"]]);
  assert.match(w.reasons("orchestrator.drafts_known")[0] ?? "", /proposed "tidy the PARSER" again: filed as a draft before, not filed twice\./);
  assert.equal(w.hostWrites.some((write) => write.includes("Tidy the parser")), false);
});

test("a session cut off by the limit is resumed after the reset, not counted as a failure", async () => {
  const w = world(config(), [item("1")]);
  await w.run();
  const resumeAt = new Date(T0 + 3600_000).toISOString();
  w.runner.end("1", "limit", undefined, { resumeAt });
  w.store.addUsageSample({ at: new Date(T0).toISOString(), status: "rejected", windows: [{ kind: "five_hour", resetsAt: resumeAt }] });
  const report = await w.run();
  assert.equal(report.wakeAt, resumeAt);
  assert.match(w.reasons("orchestrator.limit")[0] ?? "", /cut off by the usage limit\. It is resumed after 2026-11-18T11:00:00.000Z/);
  w.clock.ms += 3599_000;
  assert.equal((await w.run()).started.length, 0);
  w.clock.ms += 1000;
  await w.run();
  assert.equal(w.runner.requests[1]?.resume, "agent-s1");
  assert.equal(w.runner.requests[1]?.attempt, 1);
  assert.equal(w.job("1")?.failures, 0);
});

test("a hand-over to the queue with an empty branch is a failure, not a change", async () => {
  const w = world(config(QUEUE), [item("1")]);
  w.queue = fakeQueue();
  w.runner.paths = [];
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  w.runner.end("1", "succeeded", REVIEW_OK);
  await w.run();
  assert.match(w.reasons("orchestrator.retry_scheduled")[0] ?? "", /scopesoup\/1 changes nothing/);
});

test("a finished item closes its job", async () => {
  const w = world(config(), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", { ...TRIAGE_OK, ready: false, notReadyReason: "Needs criteria." });
  w.store.put(item("1", { state: "done" }), "sync", new Date(w.clock.ms).toISOString());
  await w.run();
  assert.equal(w.job("1"), undefined);
  assert.equal(w.events("orchestrator.job_closed").length, 1);
  assert.deepEqual(w.runner.deleted, ["scopesoup/1"]);
});

/** An item the session handed over as a pull request: its job parked as "handed-over" until the host calls the item done. */
async function handedOver(over: Partial<WorkItem> = {}): Promise<World> {
  const w = world(config({}), [item("1", over)]);
  w.runner.merges = false;
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, mergedAs: "https://git.example.invalid/team/project/pull/1" });
  assert.equal(w.job("1")?.parked?.as, "handed-over");
  return w;
}

test("a handed-over item stays put until the host calls it done; then it finishes: job gone, branch deleted, event written", async () => {
  const w = await handedOver();
  await w.run();
  assert.equal(w.job("1")?.parked?.as, "handed-over");
  assert.equal((await w.run()).started.length, 0);
  w.store.put(item("1", { state: "done" }), "sync", new Date(w.clock.ms).toISOString());
  await w.run();
  assert.equal(w.job("1"), undefined);
  assert.deepEqual(w.runner.deleted, ["scopesoup/1"]);
  assert.equal(w.events("orchestrator.finished").length, 1);
  assert.equal(w.events("orchestrator.job_closed").length, 0);
});

test("a handed-over item gone from the store finishes too", async () => {
  const w = await handedOver();
  w.store.remove(item("1").ref, "sync", new Date(w.clock.ms).toISOString());
  await w.run();
  assert.equal(w.job("1"), undefined);
  assert.deepEqual(w.runner.deleted, ["scopesoup/1"]);
  assert.equal(w.events("orchestrator.finished").length, 1);
});

test("a branch that cannot be deleted is logged and never keeps the job", async () => {
  const w = await handedOver();
  w.runner.deleteBranch = async () => {
    throw new Error("branch is busy");
  };
  w.store.put(item("1", { state: "done" }), "sync", new Date(w.clock.ms).toISOString());
  await w.run();
  assert.equal(w.job("1"), undefined);
  assert.deepEqual(w.reasons("orchestrator.action_failed"), ["Could not delete the branch: branch is busy"]);
});

test("configuration: none means no work; a bad reload keeps the last good one; changes are events", async () => {
  let state: ReturnType<ConfigSource["load"]> = { config: null, error: "Cannot read scopesoup.config.json: ENOENT", changed: false };
  const w = world({ load: () => state }, [item("1")]);
  assert.equal((await w.run()).idle, "Nothing to do because there is no valid configuration.");
  assert.deepEqual(w.reasons("orchestrator.config_error"), ["Cannot read scopesoup.config.json: ENOENT"]);

  state = { config: config({ level: 0 }), changed: true };
  await w.run();

  state = { ...state, error: "scopesoup.config.json is not valid JSON", changed: false };
  const report = await w.run();
  assert.deepEqual(report.started, []);
  assert.match(w.reasons("orchestrator.config_error")[1] ?? "", /rejected; the last good one stays in use/);

  state = { config: config({ level: 2, settings: { persistence: { value: 4, reason: "Flaky network." } } }), changed: true };
  await w.run();
  // No rule switch is left, so there is no rule event.
  assert.equal(w.events("orchestrator.rule_switched").length, 0);
  assert.deepEqual(w.reasons("orchestrator.setting_changed"), ['Setting "persistence" changed from 3 to 4: Flaky network.']);
  assert.deepEqual(w.reasons("orchestrator.level_changed"), ["The level changed from level 0 (Watch) to level 2 (Implement)."]);
  assert.equal(w.runner.requests.length, 1);
});

test("a failing host action is logged and does not stop the cycle", async () => {
  const w = world(config({}), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  w.runner.releaseWorkspace = async () => {
    throw new Error("worktree is locked");
  };
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.equal(w.job("1")?.parked?.as, "queued");
  assert.deepEqual(w.reasons("orchestrator.action_failed"), ["Could not remove the worktree: worktree is locked"]);
});

test("an item with no workspace to take waits with the reason, unclaimed, and the next item may still start", async () => {
  const w = world(config({ settings: { maxParallelSessions: { value: 2, reason: "test" } } }), [item("1"), item("2")]);
  w.claims = true;
  w.runner.takeWorkspace = async (target) => (target.id === "1" ? "no clone of the pool is free (2 of 2 held by items under way)" : null);
  const report = await w.run();
  assert.deepEqual(report.started.map((entry) => entry.item), [refKey(ref("2"))]);
  assert.equal(w.job("1"), undefined);
  assert.equal(w.calls.some((call) => call.startsWith("claim 1 ")), false);
  assert.deepEqual(w.reasons("orchestrator.workspace_wait"), ['triage for 1 "Item 1" waits: no clone of the pool is free (2 of 2 held by items under way).']);
  assert.equal(w.events("orchestrator.workspace_wait")[0]?.subject, refKey(ref("1")));
  // Nothing else to start: the reason is the wait.
  w.runner.end("2", "succeeded", TRIAGE_OK);
  w.runner.takeWorkspace = async (target) => (target.id === "1" ? "no clone of the pool is free (1 of 1 held by items under way)" : null);
  w.store.put(item("2", { state: "done" }), "sync", new Date(w.clock.ms).toISOString());
  const idle = await w.run();
  assert.equal(idle.idle, "Nothing was started because 1 waits: no clone of the pool is free (1 of 1 held by items under way).");
  assert.equal(idle.queued, 0);
});

// --- the loop ---

// --- level 4 merges through the merge queue ---

/** Level 4: the reviewer on, the queue merges. */
const QUEUE = { rules: STAGE1, level: 4, remoteUrl: "git@git.example.invalid:team/project.git", checkCommand: ["node", "check.js"] };
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function logCalls(w: World): string[] {
  return w.calls.filter((call) => call.startsWith("appendLog"));
}

test("a first build with nothing committed is \"nothing to change\" for a person; a branch with no commits over main is never reviewed or merged", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  w.store.addUsageSample(usage(0.1, 0.1));
  let ahead = 0;
  w.runner.commitsAhead = async () => ahead;
  const roles = () => w.runner.requests.map((request) => request.role);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);

  // Implemented with nothing committed on the first build: nothing to change, for a person to close; no retry and no review.
  await step(w, "1", "succeeded", { done: true, summary: "Item 1 is already done on main." });
  assert.deepEqual(roles(), ["triage", "implement"]);
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.equal(w.job("1")?.failures, 0);
  assert.deepEqual(w.reasons("orchestrator.retry_scheduled"), []);
  assert.match(w.reasons("orchestrator.escalated")[0] ?? "", /^Nothing to change: the implementer reported the work done, but The branch scopesoup\/1 has no commits over main, .* It said: Item 1 is already done on main\. If that is right, close the Item; answer here to have it try again\.$/);
  w.clock.ms += 10_000;
  await w.run();
  assert.deepEqual(roles(), ["triage", "implement"], "it waits for a person");
  // A person answers instead of closing it: the implement step runs again.
  assert.ok(releaseJob(w.store, ref("1"), "Ada", new Date(w.clock.ms).toISOString(), "Try again."));
  await w.run();
  assert.deepEqual(roles(), ["triage", "implement", "implement"]);

  // Committed this time, but the branch is empty again when the review would start: back to implement instead.
  ahead = 1;
  w.runner.end("1", "succeeded", IMPLEMENT_OK);
  await w.run();
  assert.equal(w.job("1")?.step, "review");
  ahead = 0;
  w.clock.ms += 1000;
  await w.run();
  assert.deepEqual(roles(), ["triage", "implement", "implement"], "no review of an empty branch");
  assert.equal(w.job("1")?.step, "implement");
  assert.match(w.reasons("orchestrator.back_to_implement")[0] ?? "", /^review for 1 "Item 1" does not start: The branch scopesoup\/1 has no commits over main, so there is no change to review or merge\. Nothing is reviewed or merged; next: implement\.$/);
  ahead = 1;
  w.clock.ms += 1000;
  await w.run();
  assert.deepEqual(roles(), ["triage", "implement", "implement", "implement"]);

  // Reviewed and approved, but empty when it would merge: nothing merges, back to implement.
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.equal(roles().at(-1), "review");
  ahead = 0;
  w.runner.end("1", "succeeded", REVIEW_OK);
  await w.run();
  assert.deepEqual(queue.enqueued, []);
  assert.equal(w.job("1")?.step, "implement");
  assert.equal(w.job("1")?.parked, undefined);
  assert.equal(w.reasons("orchestrator.back_to_implement").length, 2);
  assert.ok(!w.events().some((event) => event.kind === "orchestrator.mergeQueue" || event.kind === "orchestrator.merged"));
});

test("the loop runs one tick at a time, wakes early for due work and folds refreshes", async () => {
  const w = world(config(), [item("1")]);
  const timers: { run: () => void; ms: number }[] = [];
  const reports: number[] = [];
  let settled: () => void = () => undefined;
  const loop = createLoop({
    store: w.store, runner: w.runner, config: fixedConfig(config()), actions: dryActions,
    now: () => new Date(w.clock.ms).toISOString(),
    setTimer: (run, ms) => timers.push({ run, ms }),
    clearTimer: (handle) => void (timers[(handle as number) - 1] = { run: () => undefined, ms: -1 }),
    onTick: (report) => {
      reports.push(report.started.length);
      settled();
    },
  });
  const fire = async () => {
    const done = new Promise<void>((resolve) => (settled = resolve));
    timers.at(-1)?.run();
    await done;
    await new Promise((resolve) => setImmediate(resolve));
  };

  loop.refresh();
  assert.equal(timers.length, 0);
  loop.start();
  // The loop comes up paused; a person starts the agents.
  press(w, "agents.start");
  assert.equal(timers.at(-1)?.ms, 0);
  await fire();
  assert.deepEqual(reports, [1]);
  assert.equal(timers.at(-1)?.ms, 30_000);

  // A finished session: the next tick settles it and asks to be woken after the continuation delay.
  w.runner.end("1", "succeeded", TRIAGE_OK);
  loop.refresh();
  assert.equal(timers.at(-1)?.ms, 0);
  timers.at(-1)?.run();
  loop.refresh();
  loop.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.at(-1)?.ms, 0);
  await fire();
  assert.equal(timers.at(-1)?.ms, 1000);

  await loop.stop();
  const count = timers.length;
  loop.refresh();
  assert.equal(timers.length, count);
});

test("maxParallelSessions: no more sessions run at once than the setting, whatever their role", async () => {
  for (const limit of [1, 2]) {
    const w = world(config({ settings: { maxParallelSessions: { value: limit, reason: "test" } } }), [item("1"), item("2"), item("3")]);
    w.store.addUsageSample(usage(0.1, 0.1));
    await w.run();
    const again = await w.run();
    assert.equal(w.runner.requests.length, limit);
    assert.match(again.idle ?? "", /all \d session slot\(s\) are in use/);
  }
});

test("persistence: each slider position sets the attempts per step and the fix rounds", async () => {
  const expected: [number, number][] = [[1, 0], [2, 1], [3, 2], [5, 4], [8, 6]];
  for (const [index, [attempts, rounds]] of expected.entries()) {
    const position = index + 1;
    assert.deepEqual(persistenceLimits(position), { maxAttempts: attempts, maxFixRounds: rounds });
    const setting = { persistence: { value: position, reason: "test" } };

    // Failed attempts: the triage step fails until the limit, then the item goes to a person.
    const f = world(config({ settings: setting }), [item("1")]);
    f.store.addUsageSample(usage(0.1, 0.1));
    await f.run();
    for (let n = 1; n <= attempts; n++) {
      f.runner.end("1", "failed", undefined, { endReason: "The agent exited with code 3 and no result." });
      await f.run();
      if (n < attempts) {
        f.clock.ms += 600_000;
        await f.run();
        assert.equal(f.runner.requests.length, n + 1, `position ${position}, attempt ${n + 1} starts`);
      }
    }
    assert.equal(f.job("1")?.parked?.as, "escalated", `position ${position} escalates after ${attempts} attempts`);
    assert.match(f.reasons("orchestrator.escalated")[0] ?? "", new RegExp(`failed ${attempts} times; the limit is ${attempts}`));

    // Fix rounds: the review keeps asking for changes.
    const w = world(config({ rules: STAGE1, settings: setting }), [item("1")]);
    w.store.addUsageSample(usage(0.1, 0.1));
    await w.run();
    await step(w, "1", "succeeded", TRIAGE_OK);
    await step(w, "1", "succeeded", IMPLEMENT_OK);
    // Each round leaves one `must` finding fewer, and never the same one, so only the round limit stops it.
    const findings = (round: number) => ({ verdict: "changes", findings: Array.from({ length: rounds + 1 - round }, (_, n) => ({ severity: "must", text: `Finding ${round}.${n}.` })) });
    await step(w, "1", "succeeded", findings(0));
    for (let r = 0; r < rounds; r++) {
      await step(w, "1", "succeeded", { done: true, summary: "Tried." });
      await step(w, "1", "succeeded", findings(r + 1));
    }
    assert.equal(w.job("1")?.parked?.as, "escalated", `position ${position} escalates after ${rounds} fix rounds`);
    // Each round resumes the implementor's own session; there is no fix role.
    assert.equal(w.runner.requests.filter((request) => request.role === "implement" && request.resume !== undefined).length, rounds);
  }
});

test("budgetReserve: each slider position keeps its share of both windows for a person", async () => {
  const expected: [number, number][] = [[0, 0], [0.1, 0.1], [0.2, 0.2], [0.35, 0.35], [0.5, 0.5]];
  for (const [index, [five, week]] of expected.entries()) {
    const position = index + 1;
    assert.deepEqual(budgetReserve(position), { fiveHour: five, sevenDay: week });
    const settings = { budgetReserve: { value: position, reason: "test" } };
    const starts = async (fiveUsed: number, weekUsed: number): Promise<boolean> => {
      const w = world(config({ rules: STAGE1, settings }), [item("1")]);
      w.store.addUsageSample(usage(fiveUsed, weekUsed));
      await w.run();
      return w.runner.requests.length === 1;
    };
    assert.equal(await starts(0.98 - five, 0.1), true, `position ${position}: just under the 5-hour limit starts`);
    assert.equal(await starts(1 - five, 0.1), false, `position ${position}: at the 5-hour limit waits`);
    assert.equal(await starts(0.1, 0.98 - week), true, `position ${position}: just under the weekly limit starts`);
    assert.equal(await starts(0.1, 1 - week), false, `position ${position}: at the weekly limit waits`);
  }
});

test("budgetReserve: the older reserve settings still load and replace the slider's values", async () => {
  const w = world(config({ rules: STAGE1, settings: { reserveFiveHour: { value: 0.6, reason: "old file" } } }), [item("1")]);
  w.store.addUsageSample(usage(0.5, 0.1));
  await w.run();
  assert.equal(w.runner.requests.length, 0);
  assert.match(w.reasons("orchestrator.budget_wait")[0] ?? "", /limit with the reserve is 40 %/);
});

test("role models: each session runs on its role's model, opus for triage and review and sonnet for implement by default", async () => {
  const cfg = config({ rules: STAGE1 });
  const w = world(cfg, [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  await step(w, "1", "succeeded", REVIEW_CHANGES);
  await step(w, "1", "succeeded", { done: true, summary: "Tried." });
  assert.deepEqual(w.runner.requests.map((request) => request.role), ["triage", "implement", "review", "implement", "review"]);
  const want = { triage: "opus", implement: "sonnet", review: "opus" };
  for (const request of w.runner.requests) {
    const built = buildCommand(cfg, { role: request.role }, "p");
    assert.equal(built.args[built.args.indexOf("--model") + 1], want[request.role], request.role);
  }
  // A model the file sets for a role is used; an old modelStrength setting is ignored.
  const set = config({ settings: { modelStrength: { value: 1, reason: "old" } }, roles: { review: { model: "haiku" } } });
  assert.equal(set.roles.review.model, "haiku");
  assert.equal(set.roles.implement.model, "sonnet");
});

/** Runs one item through triage and implement, then reports which roles started and where the item ended up. */
async function buildRun(over: { paths?: string[]; rules?: Record<string, unknown> }) {
  const w = world(config({ rules: over.rules ?? STAGE1 }), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  w.runner.paths = over.paths ?? ["src/a.ts"];
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  if (w.runner.requests.some((request) => request.role === "review")) await step(w, "1", "succeeded", REVIEW_OK);
  // Approved below level 4: the implementor is resumed to merge it.
  if (w.job("1")?.merge) await step(w, "1", "succeeded", IMPLEMENT_OK);
  return { roles: w.runner.requests.map((request) => request.role as string), parked: w.job("1")?.parked?.as, w };
}

test("after implement the change goes straight to review: no checklist session, and a change to any path is merged without waiting for an Approve", async () => {
  const plain = await buildRun({});
  assert.deepEqual(plain.roles, ["triage", "implement", "review", "implement"]);
  assert.ok(!plain.roles.includes("check-review"));
  assert.equal(plain.parked, "queued");
  const migration = await buildRun({ paths: ["db/migrations/001.sql"] });
  assert.deepEqual(migration.roles, ["triage", "implement", "review", "implement"]);
  assert.equal(migration.parked, "queued");
  assert.equal(migration.w.reasons("orchestrator.waiting_person").length, 0);
});

test("at level 2 the built change is merged by the session without a review session", async () => {
  const off = await buildRun({ rules: {} });
  assert.deepEqual(off.roles, ["triage", "implement"]);
  assert.equal(off.parked, "queued");
  assert.match(off.w.reasons("orchestrator.merged")[0] ?? "", /merged by|The implementing session merged it/);
});

/** A store written before the checklist stage was removed: one job at the old `check-review` step, its session gone. */
function storedAt(step: string, rules: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const w = world(config({ rules }), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const job = {
    item: ref("1"), workspace: workspaceKey(ref("1")), branch: "scopesoup/1", step, sessionId: "gone", failures: 1, fixRounds: 0,
    startedAt: new Date(T0).toISOString(), implement: { done: true, summary: "Did it.", risk: "low", riskReason: "plain code" }, ...extra,
  };
  saveJobs(w.store, { [refKey(ref("1"))]: job as never });
  return w;
}

test("a stored check-review job goes to review after the upgrade from level 3", async () => {
  const w = storedAt("check-review", STAGE1);
  await w.run();
  assert.deepEqual(w.runner.requests.map((request) => request.role), ["review"]);
  assert.equal(w.job("1")?.step, "review");
  assert.equal(w.job("1")?.failures, 0);
  assert.match(w.reasons("orchestrator.step_migrated")[0] ?? "", /check-review step was removed/);
  await step(w, "1", "succeeded", REVIEW_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.equal(w.job("1")?.parked?.as, "queued");
});

test("a stored check-review job is released after the upgrade below level 3; the item starts over", async () => {
  const w = storedAt("check-review", {});
  await w.run();
  assert.match(w.reasons("orchestrator.job_released")[0] ?? "", /level 2 has no review/);
  assert.deepEqual(w.runner.requests.map((request) => request.role), ["triage"]);
  assert.equal(w.job("1")?.step, "triage");
});

test("a stored fix job keeps the findings a failed checklist left, as the findings the implementor works from", async () => {
  const w = storedAt("fix", STAGE1, { sessionId: undefined, fixRounds: 1, fixFindings: [{ severity: "must", text: "Checklist rule failed: no debug output." }] });
  await w.run();
  assert.deepEqual(w.runner.requests.map((request) => request.role), ["implement"]);
  assert.match(w.runner.requests[0]!.message ?? "", /no debug output/);
  assert.equal("fixFindings" in (w.job("1") ?? {}), false);
  assert.equal(w.events("orchestrator.job_migrated").length, 1);
});

test("a stored fix job (role removed) resumes the implementor's own session with the review's findings", async () => {
  const findings = [{ severity: "must", file: "src/a.ts", text: "Off by one." }];
  const w = storedAt("fix", STAGE1, { sessionId: undefined, fixRounds: 1, review: { verdict: "changes", findings, risk: "low", riskReason: "" } });
  const implement: Session = {
    ref: { host: "scopesoup", kind: "session", id: "old-implement" }, role: "implement", subject: ref("1"), status: "succeeded", attempt: 1,
    startedAt: new Date(T0 - 60_000).toISOString(), finishedAt: new Date(T0 - 30_000).toISOString(), agentSessionId: "agent-old",
  };
  w.store.put(implement, "orchestrator", new Date(T0).toISOString());
  await w.run();
  assert.match(w.reasons("orchestrator.step_migrated")[0] ?? "", /fix step was removed .*own session is resumed/);
  const request = w.runner.requests[0];
  assert.deepEqual([request?.role, request?.resume], ["implement", "agent-old"]);
  assert.equal(request?.message, "The reviewer asked for these changes:\n- [must] src/a.ts: Off by one.\nFix them and commit. Answer as before.");
  assert.equal(w.job("1")?.fixRounds, 1);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.equal(w.runner.requests.at(-1)?.role, "review");
});

test("a stored fix job whose implementor session is not known starts a fresh implementor with the findings; a parked one stays parked", async () => {
  const findings = [{ severity: "must", text: "Off by one." }];
  const w = storedAt("fix", STAGE1, { sessionId: undefined, review: { verdict: "changes", findings } });
  await w.run();
  assert.match(w.reasons("orchestrator.step_migrated")[0] ?? "", /not known, so a fresh implementor starts with the findings/);
  const request = w.runner.requests[0];
  assert.deepEqual([request?.role, request?.resume], ["implement", undefined]);
  assert.match(request?.message ?? "", /^Earlier work on this Item is on the branch already\.\nThe reviewer asked for these changes:\n- \[must\] Off by one\./);

  const held = storedAt("fix", STAGE1, { sessionId: undefined, review: { verdict: "changes", findings }, parked: { as: "escalated", reason: "git commit was refused", at: new Date(T0).toISOString(), byStep: true } });
  await held.run();
  assert.equal(held.runner.requests.length, 0);
  assert.deepEqual([held.job("1")?.step, held.job("1")?.parked?.as], ["implement", "escalated"]);
  const at = new Date(held.clock.ms).toISOString();
  assert.ok(releaseJob(held.store, ref("1"), "Ada", at, "try again"));
  held.clock.ms += 60_000;
  await held.run();
  assert.equal(held.runner.requests[0]?.role, "implement");
  assert.match(held.runner.requests[0]?.message ?? "", /Off by one\./);
});

const STATED = { labels: ["size:small"] };

test("an item that states its size (size:small or size:medium) goes straight to implement, with no triage session and no setting (no risk needed)", async () => {
  const w = world(config(), [item("1", STATED)]);
  await w.run();
  assert.deepEqual(w.runner.requests.map((request) => request.role), ["implement"]);
  assert.equal(w.job("1")?.triage?.size, "small");
  assert.equal("risk" in (w.job("1")?.triage ?? {}), false);
  const medium = world(config(), [item("1", { labels: ["size:medium"] })]);
  await medium.run();
  assert.deepEqual(medium.runner.requests.map((request) => request.role), ["implement"]);
  assert.equal(medium.job("1")?.triage?.size, "medium");
});

test("any other item gets the full triage with the role's turns, whatever an old triageDepth says", async () => {
  const question = { at: "2026-11-20T10:00:00.000Z", by: { who: "Ada", agent: false }, question: "Which format?", options: [] };
  const others: Partial<WorkItem>[] = [
    {},
    { labels: ["size:large"] },
    { ...STATED, openQuestions: [question] },
  ];
  for (const over of others) {
    const w = world(config(), [item("1", over)]);
    await w.run();
    assert.deepEqual(w.runner.requests.map((request) => request.role), ["triage"], JSON.stringify(over));
  }
  // An item that waits for an answer's decision is not started at all, so never skips to implement either.
  const waits = world(config(), [item("1", { ...STATED, needsDecision: true })]);
  await waits.run();
  assert.deepEqual(waits.runner.requests, []);
  for (const settings of [{ triageDepth: { value: 1, reason: "old" } }, { triageDepth: { value: 2, reason: "old" } }]) {
    const cfg = config({ settings });
    const w = world(cfg, [item("1")]);
    await w.run();
    assert.deepEqual(w.runner.requests.map((request) => request.role), ["triage"]);
    const args = buildCommand(cfg, { role: "triage" }, "P").args;
    assert.equal(args[args.indexOf("--max-turns") + 1], "15");
  }
});

const ASKS = { ...TRIAGE_OK, hidesDecision: true, decision: { question: "Round up or down?", options: ["up", "down"], recommendation: "down" } };

async function asksRun(settings: Record<string, unknown>, triage: unknown) {
  const w = world(config({ settings }), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", triage);
  return w;
}

test("a recommended answer on a low-risk item still parked for a person, and no assumption line is written, whatever an old autonomy says", async () => {
  for (const settings of [{}, { autonomy: { value: 3, reason: "old" } }]) {
    const w = await asksRun(settings, ASKS);
    assert.equal(w.job("1")?.parked?.as, "needs-decision");
    assert.deepEqual(w.runner.requests.map((request) => request.role), ["triage"]);
    assert.equal("autonomy" in (w.runner.requests[0]?.vars ?? {}), false);
    assert.equal(w.lines.filter((line) => line.includes(" assumption ")).length, 0);
    assert.equal(w.reasons("orchestrator.decision_taken").length, 0);
    assert.match(w.reasons("orchestrator.needs_decision")[0] ?? "", /^Round up or down\? Options: up \| down\. Recommended: down\.$/);
  }
});

test("a set of several decisions from triage is not reused; a person is asked all of them", async () => {
  const decisions = ["Round up or down?", "Which currency?", "Keep the old format?"].map((question) => ({ question, options: ["a", "b"], recommendation: "a" }));
  const w = await asksRun({}, { ...TRIAGE_OK, risk: "low", hidesDecision: true, decisions });
  assert.deepEqual(w.runner.requests.map((request) => request.role), ["triage"]);
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.equal(w.reasons("orchestrator.answer_reused").length, 0);
  assert.match(w.reasons("orchestrator.needs_decision")[0] ?? "", /^Triage found 3 decisions for a person/);
  assert.equal(w.lines.filter((line) => line.startsWith("1 question ")).length, 3);
});

// --- merging through the merge queue ---


/** A queue that only records what it is told and delivers what a test puts in `notices`. */
function fakeQueue(): QueueDriver & { enqueued: string[]; notices: Notice[]; kept: string[][]; resumed: string[]; paused: string | null; missing: string | null } {
  const fake = {
    resumed: [] as string[], paused: null as string | null, missing: null as string | null,
    enqueued: [] as string[], notices: [] as Notice[], kept: [] as string[][], failWith: undefined as string | undefined,
    // The head the real driver reads from the branch; SHA unless a test gives the branch's head.
    sha: undefined as (() => string) | undefined,
    repos: [] as (string | null)[],
    // Like the real driver: no repository holding the branch, no hand-over.
    async enqueue(target: Ref, branch: string, repo: string | null) {
      fake.repos.push(repo);
      if (!repo) return { ok: false as const, reason: `the item has no workspace holding ${branch}` };
      fake.enqueued.push(`${target.id} ${branch}`);
      return fake.failWith ? { ok: false as const, reason: fake.failWith } : { ok: true as const, sha: fake.sha?.() ?? SHA };
    },
    reconcile(keep: ReadonlySet<string>) {
      fake.kept.push([...keep]);
    },
    async drain(sink: QueueSink) {
      for (const notice of fake.notices.splice(0)) await sink.deliver(notice);
    },
    state: () => { throw new Error("not used"); },
    pausedWhy: () => fake.paused,
    checkMissing: () => fake.missing,
    resume(by: string) {
      fake.resumed.push(by);
      fake.paused = null;
    },
  };
  return fake as unknown as QueueDriver & { enqueued: string[]; notices: Notice[]; kept: string[][]; resumed: string[]; paused: string | null; missing: string | null };
}

test("merging by queue: a reviewed change is handed to the queue and parked as queued; nothing is pushed by the tick", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  assert.deepEqual(queue.enqueued, ["1 scopesoup/1"]);
  const job = w.job("1");
  assert.equal(job?.parked?.as, "queued");
  assert.equal(job?.queued, SHA);
  assert.match(job?.parked?.reason ?? "", /waits in the merge queue/);
  assert.equal(w.runner.main, MAIN_START, "nothing is pushed by the tick or the session");
  // The next tick tells the queue which changes still wait.
  await w.run();
  assert.deepEqual(queue.kept.at(-1), [refKey(ref("1"))]);
});

test("merging by queue: the queue is driven only while this machine holds the merge queue lease", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  queue.state = () => ({ entries: [], batches: [] }) as never;
  let free = false;
  const calls: string[] = [];
  w.mergeQueue = {
    async acquire() {
      calls.push("acquire");
      return free ? { held: true, until: "x" } : { held: false, why: "laptop-b merges until later" };
    },
    async release() {
      calls.push("release");
    },
    async peek() {
      return null;
    },
  };
  await toHandOver(w);
  const drained: string[] = [];
  const drain = queue.drain.bind(queue);
  queue.drain = async (sink) => {
    drained.push("drain");
    await drain(sink);
  };
  await w.run();
  assert.deepEqual(drained, []);
  assert.match(w.reasons("orchestrator.merge_queue_wait").at(-1) ?? "", /The merge queue waits: laptop-b merges until later/);
  free = true;
  await w.run();
  assert.deepEqual(drained, ["drain"]);
  assert.equal(calls.at(-1), "release");
});

test("merging by queue: a long check runs beside the ticks; a tick starts ready work meanwhile, one check runs at a time, and the next tick after it merges the batch", async () => {
  const w = world(config({ ...QUEUE, settings: { maxParallelSessions: { value: 2, reason: "test" } } }), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  const calls: string[] = [];
  w.mergeQueue = {
    async acquire() {
      calls.push("acquire");
      return { held: true, until: "x" };
    },
    async release() {
      calls.push("release");
    },
    async peek() {
      return null;
    },
  };
  queue.state = () => ({ entries: [{}], batches: [] }) as never;
  await toHandOver(w);
  calls.length = 0;
  // The check: it waits until the test opens the gate, then the queue has a merge to report.
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let running = 0;
  let most = 0;
  let drains = 0;
  queue.drain = async (sink) => {
    drains++;
    running++;
    most = Math.max(most, running);
    await gate;
    running--;
    await sink.deliver({ kind: "mark-merged", batch: 3, tested: SHA2, members: [{ change: ref("1"), sha: SHA2, head: SHA }] });
  };
  const slow = { queueWaitMs: 20 };
  const run = (): ReturnType<typeof tick> => tick({ ...w.depsFor(), ...slow });
  // A new ready item appears while the check runs: the tick returns without waiting and starts it.
  w.store.put(item("2"), "sync", new Date(w.clock.ms).toISOString());
  const first = await run();
  assert.deepEqual(first.started.map((s) => s.item), [refKey(ref("2"))]);
  assert.deepEqual(calls, ["acquire"], "the lease is still held while the check runs");
  await run();
  await run();
  assert.equal(drains, 1, "no second check starts while one runs");
  assert.equal(most, 1);
  assert.equal(w.job("1")?.merged, undefined);
  open();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await run();
  assert.equal(w.job("1")?.merged, SHA2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.at(-1), "release");
  assert.equal(calls.filter((call) => call === "acquire").length, 1);
});

test("merging by queue: Stop ends a running check's drain; its waiting notice is refused and not applied, and the lease is given back", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  const calls: string[] = [];
  w.mergeQueue = {
    async acquire() {
      calls.push("acquire");
      return { held: true, until: "x" };
    },
    async release() {
      calls.push("release");
    },
    async peek() {
      return null;
    },
  };
  queue.state = () => ({ entries: [{}], batches: [] }) as never;
  await toHandOver(w);
  calls.length = 0;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const outcome: string[] = [];
  queue.drain = async (sink) => {
    await gate;
    try {
      await sink.deliver({ kind: "mark-merged", batch: 3, tested: SHA2, members: [{ change: ref("1"), sha: SHA2, head: SHA }] });
      outcome.push("applied");
    } catch {
      outcome.push("refused");
    }
  };
  const run = (): ReturnType<typeof tick> => tick({ ...w.depsFor(), queueWaitMs: 20 });
  await run();
  assert.deepEqual(calls, ["acquire"]);
  press(w, "stop");
  open();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await run();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(outcome, ["refused"]);
  assert.equal(w.job("1")?.merged, undefined, "the notice was not applied");
  assert.equal(calls.at(-1), "release");
});

test("merging by queue: a note the drain makes carries the time it was made and is logged then, so a push before Stop reads as before it", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  w.mergeQueue = { async acquire() { return { held: true, until: "x" }; }, async release() {}, async peek() { return null; } };
  queue.state = () => ({ entries: [{}], batches: [] }) as never;
  await toHandOver(w);
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let pushedAt = "";
  queue.drain = async (sink) => {
    pushedAt = new Date(w.clock.ms).toISOString();
    sink.note("orchestrator.queue_pushed", "Batch 3: pushed.", { batch: 3 });
    await gate;
  };
  const run = (): ReturnType<typeof tick> => tick({ ...w.depsFor(), queueWaitMs: 20 });
  await run();
  w.clock.ms += 3000;
  press(w, "stop");
  w.clock.ms += 7000;
  open();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await run();
  const all = w.events("");
  const pushed = all.find((event) => event.kind === "orchestrator.queue_pushed");
  const stopped = all.find((event) => event.kind === "control.stopped");
  assert.ok(pushed && stopped);
  assert.equal(pushed.at, pushedAt, "the push has the time it was noted, not the later tick's");
  assert.ok(pushed.seq < stopped.seq, "and comes before the Stop that was pressed after it");
});

test("merging by queue: Pause merge queue lets a running check's drain finish; its notice is applied and the lease is given back", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  const calls: string[] = [];
  w.mergeQueue = {
    async acquire() {
      calls.push("acquire");
      return { held: true, until: "x" };
    },
    async release() {
      calls.push("release");
    },
    async peek() {
      return null;
    },
  };
  queue.state = () => ({ entries: [{}], batches: [] }) as never;
  await toHandOver(w);
  calls.length = 0;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const outcome: string[] = [];
  queue.drain = async (sink) => {
    await gate;
    try {
      await sink.deliver({ kind: "mark-merged", batch: 3, tested: SHA2, members: [{ change: ref("1"), sha: SHA2, head: SHA }] });
      outcome.push("applied");
    } catch {
      outcome.push("refused");
    }
  };
  const run = (): ReturnType<typeof tick> => tick({ ...w.depsFor(), queueWaitMs: 20 });
  await run();
  assert.deepEqual(calls, ["acquire"]);
  press(w, "mergeQueue.pause");
  open();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await run();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(outcome, ["applied"]);
  assert.equal(w.job("1")?.merged, SHA2, "the merge under way finished");
  assert.equal(calls.at(-1), "release");
});

test("merging by queue: a change the queue merged gets its revision and merged lines and stays queued until the host calls it done", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  queue.notices.push({ kind: "mark-merged", batch: 3, tested: SHA2, members: [{ change: ref("1"), sha: SHA2, head: SHA }] });
  await w.run();
  assert.equal(w.job("1")?.merged, SHA2);
  assert.deepEqual(logCalls(w), [
    `appendLog 1 revision {"sha":"${HEAD}","branch":"scopesoup/1"}`,
    `appendLog 1 review {"sha":"${HEAD}","verdict":"pass","findings":[],"model":"opus"}`,
    `appendLog 1 revision {"sha":"${SHA2}","branch":"scopesoup/1"}`,
    // The check that let it merge, for the Item page's Rounds table.
    `appendLog 1 check {"sha":"${SHA2}","verdict":"pass","command":"node check.js","batch":3}`,
    `appendLog 1 merged {"sha":"${SHA2}","target":"main","batch":3}`,
  ]);
  assert.match(w.reasons("orchestrator.merged")[0] ?? "", /merged through the queue \(batch 3\).*node check\.js passed on bbbbbbb/);
});

test("merging by queue: the merged item is closed on its host once", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  queue.notices.push({ kind: "mark-merged", batch: 3, tested: SHA2, members: [{ change: ref("1"), sha: SHA2, head: SHA }] });
  await w.run();
  await w.run();
  assert.deepEqual(w.closes, [`1 ${SHA2} 3`]);
  assert.match(w.reasons("orchestrator.item_closed")[0] ?? "", /1 was closed on its host.*bbbbbbb/);
});

test("merging by queue: Scope Soup's claim is released once the queue merged the change", async () => {
  const w = world(config(QUEUE), [item("1")]);
  w.claims = true;
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  assert.ok(!w.calls.includes("release 1"), "held while it waits in the queue");
  queue.notices.push({ kind: "mark-merged", batch: 3, tested: SHA2, members: [{ change: ref("1"), sha: SHA2, head: SHA }] });
  await w.run();
  assert.equal(w.calls.filter((call) => call === "release 1").length, 1);
  assert.ok(w.hostWrites.includes("release 1 merged on main as bbbbbbb"), w.hostWrites.join(" | "));
});

test("merging by queue: when the close fails the item is not started again; with writes off the board says to close it by hand", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  w.closeResult = "throw";
  await toHandOver(w);
  const startedBefore = w.events("orchestrator.started").length;
  queue.notices.push({ kind: "mark-merged", batch: 3, tested: SHA2, members: [{ change: ref("1"), sha: SHA2, head: SHA }] });
  await w.run();
  await w.run();
  // The issue is still open on the host, but the job parked as merged and nothing starts for it.
  assert.deepEqual(w.closes, [`1 ${SHA2} 3`]);
  assert.equal(w.job("1")?.merged, SHA2);
  assert.equal(w.job("1")?.parked?.as, "queued");
  assert.equal(w.events("orchestrator.started").length, startedBefore);
  assert.deepEqual(w.reasons("orchestrator.item_closed"), []);
  // The failure leaves a standing note on the board, once.
  assert.equal(w.reasons("orchestrator.close_failed").length, 1);
  assert.match(w.reasons("orchestrator.close_failed")[0] ?? "", /closing it on the host failed: close it on the host by hand/);

  const h = world(config(QUEUE), [item("1")]);
  const hq = fakeQueue();
  h.queue = hq;
  h.closeResult = "by-hand";
  await toHandOver(h);
  hq.notices.push({ kind: "mark-merged", batch: 4, tested: SHA2, members: [{ change: ref("1"), sha: SHA2, head: SHA }] });
  await h.run();
  assert.match(h.reasons("orchestrator.close_by_hand")[0] ?? "", /writes to the host are off: close it on the host by hand/);
});

test("merging by queue: a change sent back as the culprit of a batch returns to a fix step with the failing files and the output", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  queue.notices.push({ kind: "send-back", change: ref("1"), sha: SHA, batch: 2, reason: { kind: "culprit", prefix: 2, chainSha: SHA2, files: ["test/a.test.js"], excerpt: "1 test failed: adds" } });
  await w.run();
  const job = w.job("1");
  assert.equal(job?.step, "implement");
  assert.equal(job?.parked, undefined);
  assert.equal(job?.queued, undefined);
  await w.run();
  w.clock.ms += 1000;
  await w.run();
  const fix = w.runner.requests.at(-1);
  assert.equal(fix?.role, "implement");
  assert.match(fix?.message ?? "", /failed with this change in the batch.*test\/a\.test\.js.*1 test failed: adds/s);
  // The red batch is a failed check on the change's commit in the item's log.
  assert.ok(logCalls(w).includes(`appendLog 1 check {"sha":"${SHA}","verdict":"fail","command":"node check.js","findings":["1 test failed: adds"],"batch":2}`), logCalls(w).join(" | "));
});

test("merging by queue: the same failing check twice in a row escalates; another failure goes back to the implementor", async () => {
  const w = world(config({ ...QUEUE, settings: { persistence: { value: 5, reason: "test" } } }), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  const culprit = (files: string[], excerpt: string) => ({ kind: "send-back" as const, change: ref("1"), sha: SHA, batch: 2, reason: { kind: "culprit" as const, prefix: 1, chainSha: SHA2, files, excerpt } });
  const again = async () => {
    await w.run();
    w.clock.ms += 1000;
    await w.run();
    await step(w, "1", "succeeded", IMPLEMENT_OK);
    await step(w, "1", "succeeded", REVIEW_OK);
  };
  queue.notices.push(culprit(["test/a.test.js"], "1 test failed: adds"));
  await again();
  assert.equal(w.job("1")?.parked?.as, "queued");
  // Another failing file is another failure: back to the implementor.
  queue.notices.push(culprit(["test/b.test.js"], "1 test failed: subtracts"));
  await again();
  assert.equal(w.job("1")?.parked?.as, "queued");
  // The same files fail again, with other output: the same failure twice in a row.
  queue.notices.push(culprit(["test/b.test.js"], "1 test failed: subtracts (12 ms)"));
  await w.run();
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.match(w.reasons("orchestrator.escalated").at(-1) ?? "", /^The check failed with this change in a batch, the same failure as at the merge before\. The same failure twice in a row ends the run\. Nothing was pushed\./);
  assert.equal(w.job("1")?.fixRounds, 2);
});

test("merging by queue: a conflict in the batch is sent back with the rebase advice", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  queue.notices.push({ kind: "send-back", change: ref("1"), sha: SHA, batch: 2, reason: { kind: "conflict", with: ref("7"), ahead: [ref("7")], base: SHA2 } });
  await w.run();
  w.clock.ms += 1000;
  await w.run();
  assert.match(w.runner.requests.at(-1)?.message ?? "", /conflicts with 7.*git rebase origin\/main/s);
  assert.ok(!logCalls(w).some((call) => call.startsWith("appendLog 1 check")), "a conflict is not a check");
});

/** The branch's head after the implementor's fix round: a new revision. */
const FIXED = "c".repeat(40);

/**
 * As in the trial: the review approves while the merge queue is paused, the hand-over waits for it, and the queue takes the
 * change once it is resumed. The queue reads the branch's head, as the real driver does.
 */
async function toQueueAfterPause(w: World, queue: ReturnType<typeof fakeQueue>): Promise<void> {
  (queue as unknown as { sha: () => string }).sha = () => w.runner.headSha ?? HEAD;
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  w.store.setValue(KEYS.mergeQueue, "paused");
  await step(w, "1", "succeeded", REVIEW_OK);
  await w.run();
  assert.equal(w.reasons("orchestrator.merge_queue_paused").length, 1, "the hand-over waits, said once: the review session is not settled again each tick");
  w.store.setValue(KEYS.mergeQueue, "started");
  await w.run();
  assert.equal(w.job("1")?.parked?.as, "queued");
  assert.equal(w.job("1")?.queued, HEAD);
}

test("merging by queue: an approved change waiting through many ticks for a paused merge queue writes its review and session lines once", async () => {
  const w = world(config({ ...QUEUE, review: { shouldFindings: "draft" } }), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  w.store.setValue(KEYS.mergeQueue, "paused");
  await step(w, "1", "succeeded", { verdict: "approve", findings: [{ severity: "should", text: "Name the constant." }] });
  assert.equal(openDrafts(w.store).length, 1);
  const reviews = () => logCalls(w).filter((call) => call.startsWith("appendLog 1 review"));
  const reviewSessions = () => w.lines.filter((line) => line.startsWith("1 session") && line.includes('"role":"review"'));
  const drafts = w.store.list("draft").length;
  const events = w.events().length;
  for (let tick = 0; tick < 20; tick++) {
    w.clock.ms += 30_000;
    await w.run();
  }
  assert.equal(reviews().length, 1, reviews().join("\n"));
  assert.equal(reviewSessions().length, 1, reviewSessions().join("\n"));
  assert.equal(w.runner.requests.filter((request) => request.role === "review").length, 1);
  assert.equal(w.store.list("draft").length, drafts, "nothing more is filed while it waits");
  assert.ok(w.events().length - events <= 2, w.events().slice(events).map((event) => event.kind).join(", "));
  assert.deepEqual(queue.enqueued, []);
  // Once the queue is started, it takes the change; still one review line.
  w.store.setValue(KEYS.mergeQueue, "started");
  await w.run();
  assert.equal(w.job("1")?.parked?.as, "queued");
  assert.equal(reviews().length, 1);
});

const SEND_BACKS = {
  culprit: { kind: "send-back" as const, change: ref("1"), sha: HEAD, batch: 1, reason: { kind: "culprit" as const, prefix: 1, chainSha: SHA2, files: ["test/sum.test.js"], excerpt: "1 test failed: sums metres" } },
  conflict: { kind: "send-back" as const, change: ref("1"), sha: HEAD, batch: 1, reason: { kind: "conflict" as const, with: ref("7"), ahead: [ref("7")], base: SHA2 } },
};

for (const kind of ["culprit", "conflict"] as const) {
  for (const implementors of ["paused", "started"] as const) {
    test(`merging by queue: a change sent back as the ${kind}, implementors ${implementors}, is not queued again until its fix round made a new revision, reviewed`, async () => {
      const w = world(config(QUEUE), [item("1")]);
      const queue = fakeQueue();
      w.queue = queue;
      await toQueueAfterPause(w, queue);
      const enqueued = queue.enqueued.length;
      const queued = w.events("orchestrator.queued").length;
      const retries = w.reasons("orchestrator.handover_retry").length;
      const started = w.runner.requests.length;
      if (implementors === "paused") w.store.setValue(KEYS.implement, "paused");
      queue.notices.push(SEND_BACKS[kind]);
      for (let tick = 0; tick < 4; tick++) {
        await w.run();
        w.clock.ms += 30_000;
      }
      // Back with its implementor: the same revision is not handed to the queue again, nor escalated as the same failure twice.
      assert.equal(queue.enqueued.length, enqueued, "the revision the queue sent back is not handed to it again");
      assert.equal(w.events("orchestrator.queued").length, queued);
      assert.equal(w.reasons("orchestrator.handover_retry").length, retries);
      assert.deepEqual(w.reasons("orchestrator.escalated"), []);
      assert.equal(w.job("1")?.step, "implement");
      assert.equal(w.job("1")?.fixRounds, 1);
      if (implementors === "paused") {
        assert.equal(w.runner.requests.length, started, "no implementor runs while implementors are paused");
        w.store.setValue(KEYS.implement, "started");
        await w.run();
      }
      // The implementor's own session is resumed with what the queue found.
      const fix = w.runner.requests.at(-1);
      assert.equal(w.runner.requests.length, started + 1);
      assert.equal(fix?.role, "implement");
      assert.equal(fix?.resume, "agent-s2");
      assert.match(fix?.message ?? "", kind === "culprit" ? /Merging failed:.*test\/sum\.test\.js.*sums metres/s : /Merging failed:.*conflicts with 7/s);
      // Its fix is a new revision, reviewed (level 3 and up) and only then queued again.
      w.runner.headSha = FIXED;
      await step(w, "1", "succeeded", IMPLEMENT_OK);
      assert.equal(w.runner.requests.at(-1)?.role, "review");
      assert.equal(queue.enqueued.length, enqueued);
      await step(w, "1", "succeeded", REVIEW_OK);
      assert.equal(queue.enqueued.length, enqueued + 1);
      assert.equal(w.job("1")?.queued, FIXED);
      assert.equal(w.job("1")?.parked?.as, "queued");
    });
  }
}

test("merging by queue: the same failure again after a fix round that made a new revision still ends the run", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toQueueAfterPause(w, queue);
  queue.notices.push(SEND_BACKS.culprit);
  await w.run();
  w.clock.ms += 1000;
  await w.run();
  w.runner.headSha = FIXED;
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  await step(w, "1", "succeeded", REVIEW_OK);
  assert.equal(w.job("1")?.queued, FIXED);
  queue.notices.push({ ...SEND_BACKS.culprit, sha: FIXED });
  await w.run();
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.match(w.reasons("orchestrator.escalated").at(-1) ?? "", /the same failure as at the merge before/);
  assert.equal(w.job("1")?.fixRounds, 1);
});

test("merging by queue: a fix round that commits nothing is a failed attempt of the implement step, not a review or a hand-over of the same revision", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toQueueAfterPause(w, queue);
  const enqueued = queue.enqueued.length;
  queue.notices.push(SEND_BACKS.conflict);
  await w.run();
  w.clock.ms += 1000;
  await w.run();
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.equal(w.job("1")?.step, "implement");
  assert.equal(w.job("1")?.failures, 1);
  assert.match(w.reasons("orchestrator.retry_scheduled").at(-1) ?? "", /still at 3333333, the revision the merge queue sent back: nothing new was committed/);
  assert.equal(queue.enqueued.length, enqueued);
  assert.notEqual(w.runner.requests.at(-1)?.role, "review");
});

const GITHUB_CI = { ...QUEUE, checkCommand: undefined, host: { kind: "github", repo: "acme/widgets", write: true }, mergeQueue: { ci: "github" } };

test("merging by queue, CI on GitHub: a culprit resumes the implementor with the failing check's name, conclusion and log", async () => {
  const w = world(config(GITHUB_CI), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  assert.equal(w.job("1")?.parked?.as, "queued", "no checkCommand is needed");
  assert.match(w.job("1")?.parked?.reason ?? "", /the project's CI on GitHub checks the chain on a pull request/);
  const excerpt = `The check "test" on GitHub ended failure on ${SHA2.slice(0, 7)}.
The end of its log:
Error: expected 2, got 3`;
  queue.notices.push({ kind: "send-back", change: ref("1"), sha: SHA, batch: 2, reason: { kind: "culprit", prefix: 1, chainSha: SHA2, files: [], excerpt } });
  await w.run();
  w.clock.ms += 1000;
  await w.run();
  const fix = w.runner.requests.at(-1);
  assert.equal(fix?.role, "implement");
  assert.match(fix?.message ?? "", /The checks on GitHub failed with this change in the batch.*The check "test" on GitHub ended failure.*Error: expected 2, got 3/s);
  const check = logCalls(w).find((call) => call.startsWith("appendLog 1 check"));
  assert.ok(check?.includes('"verdict":"fail","command":"every check on GitHub"') && check.includes("ended failure"), check);
});

test("merging by queue, CI on GitHub: pending too long, or no CI: the Item is parked for a person; an answer hands it over again", async () => {
  const w = world(config(GITHUB_CI), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  const message = "The checks on batch 2 were still pending after 60 minutes (mergeQueue.ciTimeoutMinutes is 60): \"test\" (https://github.test/run/7).";
  queue.notices.push({ kind: "parked", batch: 2, changes: [ref("1")], message });
  await w.run();
  const job = w.job("1");
  assert.equal(job?.parked?.as, "escalated");
  assert.equal(job?.parked?.retry, "hand-over");
  assert.equal(job?.parked?.reason, message);
  assert.equal(job?.queued, undefined);
  assert.equal(w.runner.requests.filter((request) => request.role === "implement").length, 1, "no implementor is resumed");
  assert.ok(releaseJob(w.store, ref("1"), "Ada", new Date(w.clock.ms).toISOString(), "Look again."));
  await w.run();
  assert.equal(w.job("1")?.parked?.as, "queued");
  assert.deepEqual(queue.enqueued, ["1 scopesoup/1", "1 scopesoup/1"]);
});

test("merging by queue, CI on GitHub: without a GitHub host to write to nothing is queued, and a person is told why", async () => {
  const w = world(config(GITHUB_CI), [item("1")]);
  const queue = fakeQueue();
  queue.missing = 'mergeQueue.ci is "github", but Scope Soup has no GitHub host it may write to';
  w.queue = queue;
  await toHandOver(w);
  assert.deepEqual(queue.enqueued, []);
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.match(w.job("1")?.parked?.reason ?? "", /no GitHub host it may write to.*Give Scope Soup a GitHub host with writes on/);
});

test("merging by queue: an item that is not waiting any more leaves the queue; the queue is not driven while merging is paused", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  press(w, "mergeQueue.pause");
  queue.notices.push({ kind: "report-problem", message: "x" });
  await w.run();
  assert.equal(queue.notices.length, 1, "a notice stays while merging is paused");
  press(w, "mergeQueue.start");
  await w.run();
  assert.equal(queue.notices.length, 0);
  w.store.put(item("1", { state: "done" }), "sync", new Date(w.clock.ms).toISOString());
  await w.run();
  assert.deepEqual(queue.kept.at(-1), []);
});

test("merging by queue: a queue that cannot take the change escalates it, and answering tries again", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  (queue as unknown as { failWith: string }).failWith = "the remote is not the configured repository";
  w.queue = queue;
  await toHandOver(w);
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.match(w.job("1")?.parked?.reason ?? "", /could not be handed to the merge queue: the remote is not the configured repository/);
  assert.equal(w.job("1")?.parked?.retry, "hand-over");
});

/** A review stored by an older Scope Soup, with the risk fields nothing reads now. */
const OLD_REVIEW = { ...REVIEW_OK, risk: "high", riskReason: "changes what users are charged" };

test("a hand-over a person asked for (Try again) is logged as theirs, with who in the event data", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  (queue as unknown as { failWith: string | undefined }).failWith = "the remote is not the configured repository";
  w.queue = queue;
  await toHandOver(w);
  assert.equal(w.job("1")?.parked?.retry, "hand-over");
  (queue as unknown as { failWith: string | undefined }).failWith = undefined;
  assert.ok(releaseJob(w.store, ref("1"), "Ada", new Date(w.clock.ms).toISOString(), "Try again."));
  assert.equal(w.job("1")?.owesAskedBy, "Ada");
  await w.run();
  const retries = w.reasons("orchestrator.handover_retry");
  assert.match(retries.at(-1) ?? "", /again, as Ada asked\.$/);
  assert.equal(w.job("1")?.owesAskedBy, undefined, "cleared once logged");
  const event = w.events("orchestrator.handover_retry").at(-1);
  assert.deepEqual((event?.data as { by?: string } | undefined)?.by, "Ada");
});

test("a stored job that owed a hand-over during a pre-approval check is handed to the queue by the tick after the upgrade, its old risk ignored; old pre-check events still read", async () => {
  const w = world(config(QUEUE), [item("1")]);
  w.queue = fakeQueue();
  w.store.addUsageSample(usage(0.1, 0.1));
  const at = new Date(T0).toISOString();
  w.store.appendEvent({ kind: "orchestrator.precheck_started", subject: refKey(ref("1")), actor: "scopesoup", data: { reason: "The check command runs before the change is put to a person." } }, at);
  w.store.appendEvent({ kind: "orchestrator.precheck_failed", subject: refKey(ref("1")), actor: "scopesoup", data: { reason: "The check did not pass." } }, at);
  const job = {
    item: ref("1"), workspace: workspaceKey(ref("1")), branch: "scopesoup/1", step: "review", failures: 0, fixRounds: 0, startedAt: at,
    implement: { done: true, summary: "Did it.", risk: "low", riskReason: "plain code" }, review: OLD_REVIEW,
    owes: "hand-over", preCheckStarts: { count: 2, since: at },
  };
  saveJobs(w.store, { [refKey(ref("1"))]: job as never });
  await w.run();
  assert.equal(w.job("1")?.parked?.as, "queued");
  assert.equal((w.job("1") as { preCheckStarts?: unknown } | undefined)?.preCheckStarts, undefined);
  assert.match(w.reasons("orchestrator.job_migrated")[0] ?? "", /pre-approval check starts is dropped/);
  // Nobody asked for this hand-over: it is logged as the tick's own.
  assert.match(w.reasons("orchestrator.handover_retry")[0] ?? "", /by the tick itself: nobody asked/);
  assert.equal(w.events("orchestrator.precheck_failed").length, 1);
});

test("a reviewed change goes to the queue without a check before it; the queue does that", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  assert.equal(w.job("1")?.parked?.as, "queued");
  assert.deepEqual(queue.enqueued, ["1 scopesoup/1"]);
});

test("merging by queue: without a check command nothing is queued; a person is told, and an answer once it is set queues it", async () => {
  let cfg = config({ ...QUEUE, checkCommand: undefined });
  const w = world({ load: () => ({ config: cfg, changed: false }) }, [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  assert.deepEqual(queue.enqueued, []);
  assert.equal(w.job("1")?.parked?.as, "escalated");
  assert.equal(w.job("1")?.parked?.retry, "hand-over");
  assert.match(w.job("1")?.parked?.reason ?? "", /names no checkCommand/);
  cfg = config(QUEUE);
  assert.ok(releaseJob(w.store, ref("1"), "Ada", new Date(w.clock.ms).toISOString(), "Set it."));
  await w.run();
  assert.deepEqual(queue.enqueued, ["1 scopesoup/1"]);
  assert.equal(w.job("1")?.parked?.as, "queued");
});

test("merging by queue: the board's resume lets a paused queue go on at the next tick, once, and is refused when the queue is not paused", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  const at = new Date(w.clock.ms).toISOString();
  assert.equal(requestQueueResume(w.store, at, "board").ok, false, "no stored state: nothing is paused");
  const paused = queueStep(initialState("a".repeat(40)), { kind: "pause", reason: "the host refused the push", by: "queue" }, defaultConfig, at).state;
  w.store.setValue(QUEUE_KEY, JSON.stringify({ v: 1, state: paused, outbox: [], ready: [] }));
  queue.paused = "the host refused the push";
  assert.equal(requestQueueResume(w.store, at, "board").ok, true);
  await w.run();
  assert.deepEqual(queue.resumed, ["board"]);
  assert.match(w.reasons("orchestrator.queue_resumed")[0] ?? "", /resumed the paused queue from the board.*host refused/);
  await w.run();
  assert.deepEqual(queue.resumed, ["board"], "the request is used up");
});

test("merging by queue: Pause merge queue and Start merge queue do not resume a queue that paused itself; a resume asked while merging is paused waits for Start merge queue", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  const at = new Date(w.clock.ms).toISOString();
  const paused = queueStep(initialState("a".repeat(40)), { kind: "pause", reason: "the host refused the push", by: "queue" }, defaultConfig, at).state;
  w.store.setValue(QUEUE_KEY, JSON.stringify({ v: 1, state: paused, outbox: [], ready: [] }));
  queue.paused = "the host refused the push";
  press(w, "mergeQueue.pause");
  await w.run();
  press(w, "mergeQueue.start");
  await w.run();
  assert.deepEqual(queue.resumed, [], "the queue's own pause holds");
  press(w, "mergeQueue.pause");
  assert.equal(requestQueueResume(w.store, at, "board").ok, true);
  await w.run();
  assert.deepEqual(queue.resumed, [], "not while merging is paused");
  press(w, "mergeQueue.start");
  await w.run();
  assert.deepEqual(queue.resumed, ["board"]);
});

test("merging by queue: flakes and problems are kept for the board, and the board reads them with why the queue is paused", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  queue.notices.push({ kind: "file-flake", batch: 4, files: ["test/a.test.js"], sha: SHA, excerpt: "not ok 3 - spawn EPERM" });
  queue.notices.push({ kind: "report-problem", message: "The host refused to fast-forward." });
  await w.run();
  const health = readQueueHealth(w.store);
  assert.deepEqual(health?.notes.map((n) => n.kind), ["flake", "problem"]);
  assert.match(health?.notes[0]?.text ?? "", /test\/a\.test\.js failed and passed on a rerun/);
  assert.match(health?.notes[0]?.text ?? "", /spawn EPERM/, "the note carries the excerpt");
  assert.deepEqual(health?.flaky?.map((f) => [f.test, f.count]), [["test/a.test.js", 1]]);
  assert.match(health?.notes[1]?.text ?? "", /refused to fast-forward/);
});

test("merging by queue: an order-dependence problem names the files and carries the excerpt", async () => {
  const w = world(config(QUEUE), [item("1")]);
  const queue = fakeQueue();
  w.queue = queue;
  await toHandOver(w);
  queue.notices.push({ kind: "suspect-order-dependence", files: ["test/shared.test.js"], batches: [17, 18], sha: SHA, excerpt: "not ok 5 - unrelated remote is refused" });
  await w.run();
  const health = readQueueHealth(w.store);
  assert.deepEqual(health?.notes.map((n) => n.kind), ["problem"]);
  const text = health?.notes[0]?.text ?? "";
  assert.match(text, /test\/shared\.test\.js failed in the suite and passed alone in batches 17 and 18/);
  assert.match(text, /The failure ended: .*unrelated remote is refused/);
  assert.deepEqual(health?.flaky?.map((f) => [f.test, f.count]), [["test/shared.test.js", 1]]);
});


test("a host Scope Soup does not claim on gets no claim; one it claims on gets one with no rule in the file", async () => {
  const plain = world(config(), [item("1")]);
  await plain.run();
  assert.equal(plain.runner.requests.length, 1);
  assert.equal(plain.calls.some((call) => call.startsWith("claim")), false);
  const shared = world(config(), [item("1")]);
  shared.claims = true;
  await shared.run();
  assert.deepEqual(shared.calls.filter((call) => call.startsWith("claim")), [`claim 1 until ${new Date(shared.clock.ms + 120 * 60_000).toISOString()}`]);
});

test("claims across machines: an item whose claim another machine won is not started, and its workspace goes back", async () => {
  const w = world(config(), [item("1"), item("2")]);
  w.claims = true;
  w.claim = { won: false, why: "held by scopesoup on laptop-b" };
  const report = await w.run();
  assert.deepEqual(report.started, []);
  assert.equal(w.job("1"), undefined);
  assert.equal(w.runner.requests.length, 0);
  assert.deepEqual(w.runner.released, [workspaceKey(ref("1")), workspaceKey(ref("2"))]);
  assert.match(w.reasons("orchestrator.claim_lost")[0] ?? "", /does not start: held by scopesoup on laptop-b/);
});

test("claims across machines: an item another machine works on is not rebuilt from its log here, until its claim is gone", async () => {
  const other = { id: "scopesoup@laptop-b", name: "scopesoup on laptop-b", bot: true };
  const log = [{ at: "2026-11-18T09:00:00.000Z", by: { who: "scopesoup", machine: "laptop-b", agent: true }, kind: "session", fields: { role: "triage", outcome: "succeeded", next: "implement" } }];
  const w = world(config(), [item("1", { log, holder: { actor: other, until: new Date(T0 + 30 * 60_000).toISOString() } })]);
  w.claimant = "scopesoup@laptop-a";
  w.claims = true;
  await w.run();
  assert.equal(w.job("1"), undefined);
  assert.equal(w.events("orchestrator.recovered").length, 0);
  assert.equal(w.runner.requests.length, 0);
  // The claim ran out: the item is triaged now, and continues at the step its log names.
  w.clock.ms += 31 * 60_000;
  await w.run();
  assert.equal(w.events("orchestrator.recovered").length, 1);
  assert.equal(w.runner.requests[0]?.role, "implement");
});

test("claims across machines: a held item is renewed once less than half the time is left, not on every tick", async () => {
  const mine = { id: "scopesoup@laptop-a", name: "scopesoup on laptop-a", bot: true };
  const w = world(config(), [item("1")]);
  w.claimant = mine.id;
  w.claims = true;
  await w.run();
  const claims = (): string[] => w.calls.filter((call) => call.startsWith("claim"));
  assert.equal(claims().length, 1);
  // The expiry is fixed at 120 minutes.
  assert.equal(claims()[0], `claim 1 until ${new Date(w.clock.ms + 120 * 60_000).toISOString()}`);
  const hold = (until: number): void => {
    w.store.put(item("1", { holder: { actor: mine, until: new Date(until).toISOString() } }), "sync", new Date(w.clock.ms).toISOString());
  };
  // 70 minutes left of 120: nothing to renew.
  hold(w.clock.ms + 70 * 60_000);
  await w.run();
  assert.equal(claims().length, 1);
  // 50 minutes left: renewed for a whole period from now.
  hold(w.clock.ms + 50 * 60_000);
  await w.run();
  assert.equal(claims().at(-1), `claim 1 until ${new Date(w.clock.ms + 120 * 60_000).toISOString()}`);
  assert.equal(claims().length, 2);
  // Another machine's claim is left alone.
  w.store.put(item("1", { holder: { actor: { id: "scopesoup@laptop-b", name: "b" }, until: new Date(w.clock.ms + 1000).toISOString() } }), "sync", new Date(w.clock.ms).toISOString());
  await w.run();
  assert.equal(claims().length, 2);
});

test("claims across machines: a claim lost at renewal stops the Item's session and parks it, and so does another machine's live claim while work runs here", async () => {
  const mine = { id: "scopesoup@laptop-a", name: "scopesoup on laptop-a", bot: true };
  for (const how of ["renewal", "holder"] as const) {
    const w = world(config(), [item("1")]);
    w.claimant = mine.id;
    w.claims = true;
    await w.run();
    assert.deepEqual(roles(w), ["triage"]);
    if (how === "renewal") {
      w.store.put(item("1", { holder: { actor: mine, until: new Date(w.clock.ms + 50 * 60_000).toISOString() } }), "sync", new Date(w.clock.ms).toISOString());
      w.claim = { won: false, why: "scopesoup on laptop-b claimed it first" };
    } else {
      w.store.put(item("1", { holder: { actor: { id: "scopesoup@laptop-b", name: "scopesoup on laptop-b", bot: true }, until: new Date(w.clock.ms + 60 * 60_000).toISOString() } }), "sync", new Date(w.clock.ms).toISOString());
    }
    await w.run();
    assert.equal(w.job("1")?.parked?.as, "escalated", how);
    assert.match(w.job("1")?.parked?.reason ?? "", /^The claim on 1 was lost: (scopesoup on laptop-b claimed it first|scopesoup on laptop-b holds it)\./);
    assert.equal(w.runner.stops.length, 1, how);
    assert.match(w.reasons("orchestrator.claim_lost")[0] ?? "", /Its session here is stopped/);
    // Nothing starts again on its own: the Item waits for a person.
    w.clock.ms += 60_000;
    await w.run();
    assert.deepEqual(roles(w), ["triage"]);
  }
});

// --- agents push back: questions with options from the implementer and the fixer, and proposed rewrites of the item ---

const ASKED = { question: "Keep the old format?", options: ["keep", "migrate"], recommendation: "keep" };
const BLOCKED = { ...IMPLEMENT_OK, done: false, needs: "decision", blockedReason: "Needs a call.", decision: ASKED };

test("an implementer that stops with a question and options puts them to a person; an answer picks the item up again", async () => {
  const w = world(config(), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", BLOCKED);
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.deepEqual(w.job("1")?.decision, ASKED);
  assert.equal(w.reasons("orchestrator.needs_decision")[0], "Keep the old format? Options: keep | migrate. Recommended: keep.");
  assert.deepEqual(w.calls, ["answerTurn 1 decision"]);
  // The question is in the item's log with its options, as triage's is.
  assert.equal(w.lines.find((line) => line.includes(" question ")), '1 question {"question":"Keep the old format?","options":["keep","migrate"],"recommendation":"keep","parked":"needs-decision"}');
  // Not retried; the answer releases it and the implement step that asked runs again.
  w.clock.ms += 60_000;
  await w.run();
  assert.equal(w.runner.requests.length, 2);
  assert.ok(releaseJob(w.store, ref("1"), "Ada", new Date(w.clock.ms).toISOString(), "answered"));
  await w.run();
  assert.equal(w.runner.requests[2]?.role, "implement");
});

test("an answer to an escalation in a review round resumes the implementor in the same round with the answer, not triage; start over goes to triage", async () => {
  for (const startOver of [false, true]) {
    const w = world(config({ rules: { ...STAGE1 } }), [item("1")]);
    await w.run();
    await step(w, "1", "succeeded", TRIAGE_OK);
    await step(w, "1", "succeeded", IMPLEMENT_OK);
    await step(w, "1", "succeeded", REVIEW_CHANGES);
    await step(w, "1", "succeeded", { done: false, summary: "git commit was refused." }, { denied: ["git commit -m x"] });
    assert.equal(w.job("1")?.parked?.as, "escalated");
    const round = w.job("1")?.fixRounds;
    assert.ok(round);
    const at = new Date(w.clock.ms).toISOString();
    addAnswer(w.store, { subject: ref("1"), answer: "Use git commit -F.", by: "Ada", at, question: "The implementer could not finish." });
    assert.ok(releaseJob(w.store, ref("1"), "Ada", at, "answered", startOver));
    w.clock.ms += 60_000;
    await w.run();
    const last = w.runner.requests[w.runner.requests.length - 1];
    if (startOver) {
      assert.equal(last?.role, "triage");
      assert.equal(w.job("1")?.fixRounds, 0);
    } else {
      assert.equal(last?.role, "implement");
      assert.equal(w.job("1")?.fixRounds, round);
      // The implementor's session (the newest id it reported) is resumed with the findings, and the answer goes with them.
      assert.equal(last?.resume, "agent-s4");
      assert.match(last?.message ?? "", /Off by one\.[\s\S]*Decided by a person[\s\S]*Use git commit -F\./);
    }
  }
});

test("a question with { label, description } options and a context reads as 'label: description' in the reason and carries the context into the log", async () => {
  const asked = {
    question: "Keep the old format?",
    options: [{ label: "keep", description: "no migration needed" }, { label: "migrate", description: "one format to maintain" }],
    recommendation: "keep",
    context: "Also confirm the legacy reader stays.",
  };
  const w = world(config(), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { ...BLOCKED, decision: asked });
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.equal(w.reasons("orchestrator.needs_decision")[0], "Keep the old format? Options: keep: no migration needed | migrate: one format to maintain. Recommended: keep.");
  const line = w.lines.find((l) => l.includes(" question ")) ?? "";
  assert.match(line, /"options":\[\{"label":"keep","description":"no migration needed"\},\{"label":"migrate","description":"one format to maintain"\}\]/);
  assert.match(line, /"context":"Also confirm the legacy reader stays\."/);
});

test("an implementer's question parked for a person, whatever the risk, the recommendation or an old autonomy", async () => {
  const cases: unknown[] = [BLOCKED, { ...BLOCKED, risk: "high" }, { ...BLOCKED, decision: { ...ASKED, recommendation: "" } }];
  for (const settings of [{}, { autonomy: { value: 3, reason: "old" } }]) {
    for (const answer of cases) {
      const w = world(config({ settings }), [item("1")]);
      await w.run();
      await step(w, "1", "succeeded", TRIAGE_OK);
      await step(w, "1", "succeeded", answer);
      assert.equal(w.job("1")?.parked?.as, "needs-decision");
      assert.deepEqual(w.runner.requests.map((request) => request.role), ["triage", "implement"]);
      assert.equal(w.lines.filter((line) => line.includes(" assumption ")).length, 0);
    }
  }
});

test("a resumed implementor that stops with a question is asked like a fresh one", async () => {
  const w = world(config({ rules: { ...STAGE1 }, settings: { autonomy: { value: 3, reason: "old" } } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  await step(w, "1", "succeeded", REVIEW_CHANGES);
  await step(w, "1", "succeeded", { done: false, summary: "Two findings contradict.", question: ASKED });
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.deepEqual(w.job("1")?.decision, ASKED);
  assert.equal(w.lines.filter((line) => line.includes(" assumption ")).length, 0);
  // One that did not finish and asked nothing parked for a person with what it said, as a fresh implementor does.
  const f = world(config({ rules: { ...STAGE1 } }), [item("1")]);
  await f.run();
  await step(f, "1", "succeeded", TRIAGE_OK);
  await step(f, "1", "succeeded", IMPLEMENT_OK);
  await step(f, "1", "succeeded", REVIEW_CHANGES);
  await step(f, "1", "succeeded", { done: false, summary: "Gave up." });
  assert.equal(f.job("1")?.parked?.as, "needs-decision");
  assert.equal(f.reasons("orchestrator.needs_decision")[0], "The implementer stopped: Gave up.");
});

test("a resumed implementor that fails starts afresh with the findings after its prompt (a lost session)", async () => {
  const w = world(config({ rules: { ...STAGE1 } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  await step(w, "1", "succeeded", REVIEW_CHANGES);
  assert.equal(w.runner.requests.at(-1)?.resume, "agent-s2");
  w.runner.end("1", "failed", undefined, { endReason: "No conversation found with session ID: agent-s2" });
  await w.run();
  w.clock.ms += 600_000;
  await w.run();
  const fresh = w.runner.requests.at(-1);
  assert.equal(fresh?.role, "implement");
  assert.equal(fresh?.resume, undefined);
  assert.equal(fresh?.message, "Earlier work on this Item is on the branch already.\nThe reviewer asked for these changes:\n- [must] src/a.ts: Off by one.\nFix them and commit.");
  // Done: the next review sees the change, and nothing is left to tell the implementor.
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.equal(w.runner.requests.at(-1)?.role, "review");
  assert.equal(w.job("1")?.resumeWith, undefined);
});

test("a proposed rewrite of the item's text in an answer (removed) is dropped: nothing parks for it", async () => {
  const rewrite = { description: "New text.", verification: "new check", reason: "This should be X instead, because Y." };
  const w = world(config({ rules: { ...STAGE1 } }), [item("1", { body: "Old text.", verification: "old check" })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", { ...TRIAGE_OK, proposal: rewrite });
  assert.equal(w.job("1")?.parked, undefined);
  assert.equal(w.job("1")?.step, "implement");
  assert.equal(w.job("1")?.proposal, undefined);
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, proposal: rewrite });
  assert.equal(w.job("1")?.parked, undefined);
  assert.equal(w.job("1")?.step, "review");
  assert.equal(w.lines.filter((line) => line.includes(" question ")).length, 0);
});

test("a job stored parked on a proposed rewrite (removed) is released after the upgrade; the item starts over at triage", async () => {
  const at = new Date(T0).toISOString();
  const w = storedAt("implement", STAGE1, { sessionId: undefined, parked: { as: "needs-decision", reason: "A implement session proposes a new description for the item: Because.", at }, proposal: { description: "New text.", reason: "Because." } });
  await w.run();
  assert.match(w.reasons("orchestrator.job_released")[0] ?? "", /proposed rewrite of its text/);
  assert.deepEqual(w.runner.requests.map((request) => request.role), ["triage"]);
  assert.equal(w.job("1")?.step, "triage");
  assert.equal(w.job("1")?.proposal, undefined);
});

const PARTS = [
  { title: "Part one", description: "Do the first half.", verification: "Test one.", goes: "child" as const },
  { title: "Part two", description: "Do the second half.", verification: "Test two.", goes: "into" as const, into: "2" },
];
const RESTRUCTURE = { reason: "Two changes; the second belongs to item 2.", original: "umbrella", parts: PARTS.map((part) => (part.into ? { ...part, into: "#2" } : part)) };
const RESTRUCTURE_REASON = "Triage proposes to restructure the Item: 1 new child Item, 1 into #2; the Item becomes an umbrella. Two changes; the second belongs to item 2.";

test("a triage that proposes a restructuring parks it, with a person's recorded answers carried over; one that does not hold together is left out", async () => {
  const w = world(config(), [item("1")]);
  addAnswer(w.store, { subject: ref("1"), answer: "Keep the old format.", by: "Ada", at: "2026-11-18T08:00:00.000Z", question: "Which format?" });
  await w.run();
  // Proposed whatever the size: a duplicate can be small.
  await step(w, "1", "succeeded", { ...TRIAGE_OK, restructure: RESTRUCTURE });
  const job = w.job("1");
  assert.equal(job?.parked?.as, "needs-decision");
  assert.deepEqual(job?.proposal?.parts, PARTS, "the Item a part goes into is named by its id");
  assert.equal(job?.proposal?.original, "umbrella");
  assert.equal(job?.proposal?.carried, "- Asked: Which format?\n  Answered: Keep the old format.");
  assert.equal(job?.proposal?.reason, RESTRUCTURE_REASON);
  assert.deepEqual(w.calls, ["answerTurn 1 decision"]);
  // In the log too, so a restart (or another machine) puts it back.
  assert.match(w.lines[0] ?? "", /^1 question \{"question":"Triage proposes.*"proposal":\{"id":"[0-9a-f]{8}","reason":"Triage proposes.*","original":"umbrella","parts":\[\{"title":"Part one".*"goes":"child"\},\{.*"goes":"into","into":"2"\}\],"carried":"- Asked: Which format\?.*"\},"parked":"needs-decision"\}$/);
  // The board shows it as a person's turn.
  const held = loadSnapshot(w.store).parked?.find((each) => each.subject.id === "1");
  assert.deepEqual(held?.proposal?.parts, PARTS);

  // A verdict on an earlier proposal is not a decision to carry.
  const later = world(config(), [item("1")]);
  addAnswer(later.store, { subject: ref("1"), answer: "Rejected the proposed restructuring of the item.", by: "Ada", at: "2026-11-18T08:00:00.000Z", question: "Proposed restructuring: Triage proposes." });
  await later.run();
  await step(later, "1", "succeeded", { ...TRIAGE_OK, restructure: RESTRUCTURE });
  assert.equal(later.job("1")?.proposal?.carried, undefined);

  // The Item keeps a part but none goes to it, or a part has no title: left out, and the triage goes on as if none was given.
  for (const restructure of [{ ...RESTRUCTURE, original: "keeps" }, { ...RESTRUCTURE, parts: [...PARTS, { title: " ", description: "", verification: "", goes: "child" }] }]) {
    const odd = world(config(), [item("1")]);
    await odd.run();
    await step(odd, "1", "succeeded", { ...TRIAGE_OK, restructure });
    assert.equal(odd.job("1")?.step, "implement");
    assert.equal(odd.job("1")?.triage?.restructure, undefined);
  }
  // A large one without a restructuring is parked as "not ready".
  const bare = world(config(), [item("1")]);
  await bare.run();
  await step(bare, "1", "succeeded", { ...TRIAGE_OK, size: "large" });
  assert.equal(bare.job("1")?.parked?.as, "not-ready");
  assert.equal(bare.job("1")?.proposal, undefined);
});

// An answered question is not asked again after re-triage unless the item changed.
const REWORDED = { ...TRIAGE_OK, hidesDecision: true, decision: { question: "Should amounts be rounded upward or downward?", options: ["down", "up"], recommendation: "down" } };

async function answeredRun(changeText: boolean) {
  const w = world(config(), [item("1", { body: "Round the amounts." })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", ASKS);
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  const at = new Date(w.clock.ms).toISOString();
  addAnswer(w.store, { subject: ref("1"), answer: "Down.", by: "Ada", at, question: "Round up or down?", options: ["up", "down"], textHash: itemTextHash(item("1", { body: "Round the amounts." })) });
  assert.ok(releaseJob(w.store, ref("1"), "Ada", at, "answered"));
  if (changeText) w.store.put(item("1", { body: "Round the amounts, per line." }), "sync", at);
  w.clock.ms += 1000;
  await w.run();
  await step(w, "1", "succeeded", REWORDED);
  return w;
}

test("a reworded question on an unchanged item reuses the recorded answer", async () => {
  const w = await answeredRun(false);
  assert.equal(w.job("1")?.step, "implement");
  assert.equal(w.job("1")?.parked, undefined);
  assert.equal(w.reasons("orchestrator.needs_decision").length, 1);
  assert.equal(w.reasons("orchestrator.answer_reused").length, 1);
  // The reuse is an event in the store, not a line in the item's log.
  assert.equal(w.lines.filter((line) => line.includes(" assumption ")).length, 0);
});

test("the same question after the item's text changed is asked again", async () => {
  const w = await answeredRun(true);
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.equal(w.reasons("orchestrator.needs_decision").length, 2);
  assert.equal(w.reasons("orchestrator.answer_reused").length, 0);
});

test("an answer to a different decision, or kept without a text hash, is not reused", () => {
  const it = item("1", { body: "Text." });
  const base = { subject: it.ref, question: "Round up or down?", options: ["up", "down"], answer: "Down.", by: "Ada", at: "2026-11-20T10:00:00Z" };
  const asked = { question: "Which currency?", options: ["euro", "dollar"] };
  assert.equal(reusableAnswer([{ ...base, textHash: itemTextHash(it) }], it, asked), undefined);
  const again = { question: "Round upward or downward?", options: ["up", "down"] };
  assert.equal(reusableAnswer([base], it, again), undefined);
  assert.ok(reusableAnswer([{ ...base, textHash: itemTextHash(it) }], it, again));
});

// --- the triage rewrites the description and finds links ---

const QUESTION = { question: "Metric or imperial?", options: [{ label: "Metric", description: "Metres and knots." }, { label: "Imperial", description: "Feet." }], recommendation: "Metric", context: "The table shows both now." };
const REWRITE = "Show the tide table in metres. Done when the table shows metres only.";
const TRIAGE = { ...TRIAGE_OK, questions: [QUESTION], rewrite: REWRITE, links: [] };

/** What the server does for `POST /api/rewrite` in the store (the endpoint itself is tested in server/decisions.test.ts). */
function answerRewrite(w: World, id: string, answers: string[], action: "accept" | "edit" | "reject" = "accept") {
  const job = w.job(id)!;
  const at = new Date(w.clock.ms).toISOString();
  return w.store.tx(() => {
    job.rewrite!.questions.forEach((question, index) => addAnswer(w.store, { subject: ref(id), answer: answers[index]!, by: "Ada", at, question: question.question }));
    return settleRewrite(w.store, ref(id), answers, action, "Ada", at, job.parked!.at);
  });
}

test("a triage with a question and a rewrite parked with both on the Item page, and no implement session starts", async () => {
  const w = world(config({ level: 3 }), [item("1", { body: "Tide table units." })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE);
  for (let i = 0; i < 3; i++) {
    w.clock.ms += 60_000;
    await w.run();
  }
  assert.deepEqual(roles(w), ["triage"]);
  const job = w.job("1")!;
  assert.equal(job.parked?.as, "needs-decision");
  assert.deepEqual(job.rewrite, { original: "Tide table units.", text: REWRITE, questions: [QUESTION], round: 1 });
  // The rewrite's questions are not the old one-by-one questions, and the log has one line naming the parked state.
  assert.deepEqual(jobQuestions(job), []);
  assert.deepEqual(w.lines.filter((line) => line.startsWith("1 question ")).map((line) => JSON.parse(line.slice("1 question ".length)).rewrite), [1]);
  const page = buildItemPage(loadSnapshot(w.store), refKey(ref("1")), new Date(w.clock.ms))!;
  assert.equal(page.parked?.rewrite?.text, REWRITE);
  assert.equal(page.parked?.rewrite?.original, "Tide table units.");
  assert.deepEqual(page.parked?.rewrite?.questions.map((each) => each.recommendation), ["Metric"]);
  assert.equal(page.parked?.decision, undefined);
  assert.equal(page.actor, "anyone");
});

test("keeping every recommendation settles the rewrite in one action; then implement starts", async () => {
  const w = world(config(), [item("1", { body: "Tide table units." })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE);
  // The recommended label, or the label with its description as the page's other pickers send it, both keep it.
  assert.deepEqual(answerRewrite(w, "1", ["Metric: Metres and knots."]), { settled: "accepted" });
  assert.equal(w.events("orchestrator.rewrite_accepted").length, 1);
  await w.run();
  w.clock.ms += 1000;
  await w.run();
  assert.deepEqual(roles(w), ["triage", "implement"]);
  assert.match(w.reasons("orchestrator.step").at(-1) ?? "", /A person accepted the rewrite\. Next: implement\./);
  assert.equal(w.job("1")?.rewrite, undefined);
});

test("another answer runs the triage again with the answer in its prompt, round after round", async () => {
  const w = world(config(), [item("1", { body: "Tide table units." })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", TRIAGE);
  assert.deepEqual(answerRewrite(w, "1", ["Imperial"]), { rerun: true });
  await w.run();
  assert.deepEqual(roles(w), ["triage", "triage"]);
  const prompt = w.runner.requests[1]!.vars.itemBody!;
  assert.match(prompt, /Asked: Metric or imperial\?\n {2}Answered: Imperial/);
  // The second round asks a new question and writes a new rewrite.
  await step(w, "1", "succeeded", { ...TRIAGE, questions: [{ question: "Round to tenths?", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], recommendation: "Yes" }], rewrite: "Show the tide table in feet, to tenths." });
  assert.equal(w.job("1")?.rewrite?.round, 2);
  assert.match(w.reasons("orchestrator.needs_decision").at(-1) ?? "", /^Triage, round 2: a rewrite of the description and 1 question\(s\)/);
  assert.deepEqual(roles(w), ["triage", "triage"]);
  assert.deepEqual(answerRewrite(w, "1", ["Yes"], "reject"), { settled: "rejected" });
  await w.run();
  w.clock.ms += 1000;
  await w.run();
  assert.deepEqual(roles(w), ["triage", "triage", "implement"]);
});

test("a blockedBy link writes Scope Soup's own blocker; the job closes and the Item waits in Blocked", async () => {
  const w = world(config(), [item("1"), item("2", { title: "Harbour list" })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  // Only item 1 gets a triage now.
  w.store.put(item("2", { title: "Harbour list", holder: { actor: { id: "p", name: "Pat" } } }), "sync", new Date(w.clock.ms).toISOString());
  await w.run();
  const added: string[] = [];
  const deps = w.depsFor();
  deps.actions.addBlockers = async (target, blockers) => void added.push(`${target.id} <- ${blockers.map((each) => each.id).join(",")}`);
  w.runner.end("1", "succeeded", { ...TRIAGE, links: [{ type: "blockedBy", item: "#2", reason: "Needs the harbour list." }, { type: "related", item: "2", reason: "Same screen." }] });
  await tick(deps);
  w.clock.ms += 60_000;
  await tick(deps);
  assert.deepEqual(added, ["1 <- 2"]);
  assert.equal(w.job("1"), undefined);
  assert.deepEqual(roles(w), ["triage"]);
  assert.deepEqual(loadOwnBlockers(w.store)[refKey(ref("1"))]?.map((each) => each.id), ["2"]);
  assert.match(w.reasons("orchestrator.blocked")[0] ?? "", /1 is blocked by 2\. It waits in Blocked/);
  assert.match(w.reasons("orchestrator.idle").at(-1) ?? "", /1 blocked by 2/);
  const board = buildBoard(loadSnapshot(w.store), new Date(w.clock.ms));
  assert.ok(board.lanes.find((lane) => lane.lane === "blocked")?.cards.some((card) => card.ref.id === "1"));
  // Once the blocker is done, the triage runs again.
  w.store.put(item("2", { state: "done" }), "sync", new Date(w.clock.ms).toISOString());
  await tick(deps);
  assert.deepEqual(roles(w), ["triage", "triage"]);
});

// --- on GitHub the triage's blockers are issue dependencies, written through by the real adapter on a fake GitHub ---

const ghItem = (id: string, over: Partial<WorkItem> = {}): WorkItem => item(id, { ref: { host: "github", kind: "work", id }, ...over });
const ghKey = (id: string): string => `github:work:${id}`;
const ghRef = (id: string): Ref => ({ host: "github", kind: "work", id });
const DEPS = "/repos/harbour/tides/issues";

/** Item 1 gets a triage; item 2 is held by a person, so it does not; issue 3 is on GitHub only. Only `addBlockers` is the real one. */
async function githubWorld() {
  const w = world(config(), [ghItem("1"), ghItem("2", { title: "Harbour list", holder: { actor: { id: "p", name: "Pat" } } })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const fake = fakeIssues("harbour/tides", [1, 2, 3]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true });
  const real = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config(), store: w.store });
  const deps = w.depsFor();
  deps.actions.addBlockers = real.addBlockers;
  await w.run();
  assert.deepEqual(roles(w), ["triage"]);
  fake.clear();
  return { w, fake, deps };
}

test("a triage's blockedBy link on GitHub is one dependency call; the Item is Blocked from the re-read alone", async () => {
  const { w, fake, deps } = await githubWorld();
  w.runner.end("1", "succeeded", { ...TRIAGE, links: [{ type: "blockedBy", item: "#2", reason: "Needs the harbour list." }] });
  await tick(deps);
  w.clock.ms += 60_000;
  await tick(deps);
  assert.deepEqual(fake.sent, [{ call: `POST ${DEPS}/1/dependencies/blocked_by`, body: { issue_id: 9002 } }]);
  assert.equal(fake.calls.filter((call) => !call.startsWith("GET")).length, 1);
  assert.equal(loadJobs(w.store)[ghKey("1")], undefined);
  assert.deepEqual(roles(w), ["triage"]);
  // Nothing in Scope Soup's own record: the store's row is the re-read.
  assert.equal(w.store.getValue("scopesoup.blockedBy"), null);
  assert.equal(w.events("orchestrator.blockers_recorded").length, 0);
  assert.deepEqual(w.store.get<WorkItem>({ host: "github", kind: "work", id: "1" })?.blockedBy.map((each) => each.id), ["2"]);
  const board = buildBoard(loadSnapshot(w.store), new Date(w.clock.ms));
  assert.ok(board.lanes.find((lane) => lane.lane === "blocked")?.cards.some((card) => card.ref.id === "1"));
});

test("a dependency someone adds on GitHub between the triage's read and its write survives: a triage only adds", async () => {
  const { w, fake, deps } = await githubWorld();
  // At Scope Soup's first read of issue 1 a person makes it blocked by issue 3 too (database id 9003).
  fake.onCall = (call) => {
    if (/^GET \/repos\/harbour\/tides\/issues\/1(\/|$)/.test(call) && !fake.blockedBy.get("1")?.has(9003)) fake.blockedBy.set("1", new Set([9003]));
  };
  w.runner.end("1", "succeeded", { ...TRIAGE, links: [{ type: "blockedBy", item: "#2", reason: "Needs the harbour list." }] });
  await tick(deps);
  fake.onCall = undefined;
  assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET")), [`POST ${DEPS}/1/dependencies/blocked_by`]);
  assert.deepEqual([...fake.blockedBy.get("1")!].sort(), [9002, 9003]);
  assert.equal(loadJobs(w.store)[ghKey("1")], undefined);
});

test("a dependency write that GitHub answers OK to but does not keep it: parks the Item as escalated and keeps nothing", async () => {
  const { w, fake, deps } = await githubWorld();
  fake.dropsDependencies = true;
  w.runner.end("1", "succeeded", { ...TRIAGE, links: [{ type: "blockedBy", item: "2", reason: "Needs the harbour list." }] });
  await tick(deps);
  w.clock.ms += 60_000;
  await tick(deps);
  assert.match(w.reasons("orchestrator.host_write_failed")[0] ?? "", /^Could not write 1 blocked by 2: GitHub answered but did not apply it on #1 \(blocked by #2 not added\)/);
  assert.equal(loadJobs(w.store)[ghKey("1")]?.parked?.as, "escalated");
  assert.match(loadJobs(w.store)[ghKey("1")]?.parked?.reason ?? "", /the dependency could not be written on github/);
  assert.equal(w.store.getValue("scopesoup.blockedBy"), null);
  assert.deepEqual(w.store.get<WorkItem>({ host: "github", kind: "work", id: "1" })?.blockedBy, []);
  assert.deepEqual(roles(w), ["triage"]);
});

test("a blocks link on GitHub is written as blocked_by on the other issue, and the triage goes on", async () => {
  const { w, fake, deps } = await githubWorld();
  w.runner.end("1", "succeeded", { ...TRIAGE, links: [{ type: "blocks", item: "2", reason: "The list needs the units." }] });
  await tick(deps);
  assert.deepEqual(fake.sent, [{ call: `POST ${DEPS}/2/dependencies/blocked_by`, body: { issue_id: 9001 } }]);
  assert.equal(loadJobs(w.store)[ghKey("1")]?.parked?.as, "needs-decision");
  assert.deepEqual(w.store.get<WorkItem>({ host: "github", kind: "work", id: "2" })?.blockedBy.map((each) => each.id), ["1"]);
});

test("an entry of scopesoup.blockedBy from before is not read for a GitHub Item, and is left in the store", () => {
  const w = world(config(), [ghItem("1"), ghItem("2")]);
  const old = JSON.stringify({ [ghKey("1")]: [{ host: "github", kind: "work", id: "2" }] });
  w.store.setValue("scopesoup.blockedBy", old);
  assert.deepEqual(loadSnapshot(w.store).works.find((work) => work.ref.id === "1")?.blockedBy, []);
  assert.equal(w.store.getValue("scopesoup.blockedBy"), old);
});

test("a duplicateOf link becomes a question; keeping the recommendation parked the Item, and nothing is closed", async () => {
  const w = world(config(), [item("1"), item("2", { title: "Tide units", holder: { actor: { id: "p", name: "Pat" } } })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", { ...TRIAGE, questions: [], links: [{ type: "duplicateOf", item: "2", reason: "Both ask for metres." }] });
  const question = w.job("1")?.rewrite?.questions[0];
  assert.equal(question?.question, 'Close 1 as a duplicate of 2 "Tide units"?');
  assert.equal(question?.recommendation, "Close 1 as a duplicate of 2");
  assert.equal(question?.context, "Both ask for metres.");
  assert.deepEqual(answerRewrite(w, "1", ["Close 1 as a duplicate of 2"]), { settled: "accepted" });
  await w.run();
  w.clock.ms += 60_000;
  await w.run();
  assert.equal(w.job("1")?.parked?.as, "not-ready");
  assert.match(w.job("1")?.parked?.reason ?? "", /A person answered: Close 1 as a duplicate of 2\. Scope Soup closes nothing itself/);
  assert.deepEqual(roles(w), ["triage"]);
  assert.deepEqual(w.closes, []);
});

test("on GitHub the answer closes the Item as a duplicate, with the target's database id; nothing before the answer", async () => {
  const w = world(config(), [ghItem("1"), ghItem("2", { title: "Tide units", holder: { actor: { id: "p", name: "Pat" } } })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const fake = fakeIssues("harbour/tides", [1, 2]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  const real = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config(), store: w.store });
  const deps = w.depsFor();
  deps.actions.closeDuplicate = real.closeDuplicate;
  await tick(deps);
  w.runner.end("1", "succeeded", { ...TRIAGE, questions: [], links: [{ type: "duplicateOf", item: "2", reason: "Both ask for metres." }] });
  await tick(deps);
  const question = loadJobs(w.store)[ghKey("1")]?.rewrite?.questions[0];
  assert.match(optionText(question!.options[0]!), /Scope Soup closes 1 on the host as a duplicate of 2/);
  assert.equal(fake.calls.some((call) => call.startsWith("PATCH")), false);
  const job = loadJobs(w.store)[ghKey("1")]!;
  const at = new Date(w.clock.ms).toISOString();
  assert.deepEqual(w.store.tx(() => settleRewrite(w.store, ghRef("1"), ["Close 1 as a duplicate of 2"], "accept", "Ada", at, job.parked!.at)), { settled: "accepted" });
  await tick(deps);
  assert.deepEqual(fake.sent.find((each) => each.call === `PATCH ${DEPS}/1`)?.body, { state: "closed", state_reason: "duplicate", duplicate_issue_id: 9002 });
  assert.match(w.reasons("orchestrator.item_closed")[0] ?? "", /^1 was closed on its host as a duplicate of 2/);
  assert.equal(w.store.get<WorkItem>(ghRef("1"))?.duplicateOf?.id, "2");
  w.clock.ms += 60_000;
  await tick(deps);
  assert.equal(loadJobs(w.store)[ghKey("1")], undefined);
  assert.deepEqual(roles(w), ["triage"]);
});

test("a rewrite that keeps the description and asks nothing goes on at once; an answer from earlier is settled as before", async () => {
  const w = world(config({ settings: { maxParallelSessions: { value: 2, reason: "test" } } }), [item("1", { body: "Clear already." }), item("2")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, rewrite: "Clear already.", links: [] });
  // Another file, so the two do not wait for each other (core/sameFiles.ts).
  w.runner.end("2", "succeeded", { ...TRIAGE_OK, paths: ["src/b.ts"] });
  await w.run();
  w.clock.ms += 1000;
  await w.run();
  assert.deepEqual(roles(w), ["triage", "triage", "implement", "implement"]);
});

// --- on GitHub the questions an Item parked on are comments, and their answers are read from GitHub ---

const TWO_QUESTIONS = { ...TRIAGE_OK, hidesDecision: true, decisions: [{ question: "Round up or down?", options: ["up", "down"], recommendation: "down" }, { question: "Which unit?", options: ["metres", "feet"], recommendation: "metres" }] };

/** Item 1 gets a triage session on a fake GitHub; asking, settling and the re-reads are the real ones. `clocked`: the host reads the world's clock. */
async function questionWorld(clocked = false) {
  const w = world(config(), [ghItem("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const fake = fakeIssues("harbour/tides", [1]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot", ...(clocked ? { now: () => w.clock.ms } : {}) });
  const real = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config(), store: w.store });
  const deps = w.depsFor();
  deps.actions.askQuestions = real.askQuestions;
  deps.actions.settleQuestions = real.settleQuestions;
  deps.actions.postRewrite = real.postRewrite;
  deps.actions.checkRewrite = real.checkRewrite;
  deps.actions.withdrawQuestions = real.withdrawQuestions;
  await w.run();
  assert.deepEqual(roles(w), ["triage"]);
  const sync = async (): Promise<void> => {
    const item = await host.work.getWork({ host: "github", kind: "work", id: "1" });
    if (item) w.store.put(item, "sync", new Date(w.clock.ms).toISOString());
  };
  return { w, fake, host, deps, sync };
}

const labelsOn = (fake: ReturnType<typeof fakeIssues>): string[] => fake.issues.get("1")!.labels.map((label) => (typeof label === "string" ? label : label.name));

test("an Item parked on two questions posts two question comments and the label; A2: and A1: replies from trusted authors release it", async () => {
  const { w, fake, deps, sync } = await questionWorld();
  w.runner.end("1", "succeeded", TWO_QUESTIONS);
  await tick(deps);
  const job = loadJobs(w.store)[ghKey("1")];
  assert.equal(job?.parked?.as, "needs-decision");
  const ids = job?.parked?.questions ?? [];
  assert.deepEqual(ids, fake.comments.get("1")!.map((comment) => String(comment.id)));
  assert.match(fake.comments.get("1")![1]!.body!, /^\*\*Q2: Which unit\?\*\*/);
  assert.deepEqual(labelsOn(fake), ["scopesoup:needs-decision"]);
  // The comments tell a person: no separate person's comment.
  assert.deepEqual(w.calls.filter((call) => call.startsWith("answerTurn")), []);
  assert.equal(w.reasons("orchestrator.questions_asked").length, 1);

  // A stranger's A1: is a plain comment; a collaborator's A2: answers question 2.
  fake.reply(1, "stranger", "NONE", "A1: up");
  fake.reply(1, "kim", "COLLABORATOR", "A2: feet");
  await sync();
  await tick(deps);
  assert.deepEqual(loadJobs(w.store)[ghKey("1")]?.parked?.questions, ids);
  assert.deepEqual(w.store.get<WorkItem>({ host: "github", kind: "work", id: "1" })?.openQuestions?.map((each) => each.question), ["Round up or down?"]);
  // The board shows question 2 answered, from GitHub.
  assert.deepEqual(loadSnapshot(w.store).parked?.[0]?.questions?.map((each) => each.answer), [undefined, "feet"]);

  fake.reply(1, "robin", "OWNER", "A: down");
  await sync();
  await tick(deps);
  assert.match(w.reasons("orchestrator.job_released").at(-1) ?? "", /^Answered on github: Round up or down\? Answered: down Which unit\? Answered: feet$/);
  assert.deepEqual(labelsOn(fake), []);
  assert.equal(w.store.getValue("person.answers"), null);
  // The triage runs again in the same tick, with the answers in its prompt.
  assert.equal(loadJobs(w.store)[ghKey("1")]?.parked, undefined);
  assert.deepEqual(roles(w), ["triage", "triage"]);
  assert.match(w.runner.requests[1]?.vars?.itemBody ?? "", /Asked: Which unit\?\n  Answered: feet/);
});

test("a deleted question comment un-parks the Item, and it starts again at its triage; a quiet poll costs nothing", async () => {
  const { w, fake, host, deps } = await questionWorld();
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, hidesDecision: true, decision: { question: "Round up or down?", options: ["up", "down"], recommendation: "down" } });
  await tick(deps);
  const id = loadJobs(w.store)[ghKey("1")]?.parked?.questions?.[0];
  assert.ok(id);
  const put = (items: WorkItem[]): void => {
    for (const item of items) w.store.put(item, "sync", new Date(w.clock.ms).toISOString());
  };
  const first = await host.work.listWork();
  put(first.items);
  // While the Item parked on the question its comments are listed again each poll: a free 304 when nothing changed.
  const settled = await host.work.listWork(first.cursor);
  fake.clear();
  const before = fake.notModified;
  const quiet = await host.work.listWork(settled.cursor);
  assert.equal(quiet.unchanged, true);
  assert.equal(fake.calls.length, 3);
  assert.ok(fake.calls[2]?.endsWith("/issues/1/comments?per_page=100"));
  assert.equal(fake.notModified - before, 3);

  fake.deleteComment(Number(id));
  const after = await host.work.listWork(quiet.cursor);
  put(after.items);
  assert.equal(w.store.get<WorkItem>({ host: "github", kind: "work", id: "1" })?.needsDecision, undefined);
  await tick(deps);
  assert.match(w.reasons("orchestrator.job_released").at(-1) ?? "", /was deleted on github: the Item is no longer parked/);
  // A new triage starts in the same tick.
  assert.equal(loadJobs(w.store)[ghKey("1")]?.parked, undefined);
  assert.deepEqual(roles(w), ["triage", "triage"]);
});

test("questions GitHub does not take (the label is dropped) post nothing, write orchestrator.host_write_failed and escalate", async () => {
  const { w, fake, deps } = await questionWorld();
  fake.dropsLabels = true;
  w.runner.end("1", "succeeded", TWO_QUESTIONS);
  await tick(deps);
  assert.equal(fake.comments.get("1"), undefined);
  assert.match(w.reasons("orchestrator.host_write_failed")[0] ?? "", /^Could not post the questions on github: GitHub answered but did not apply it on #1 \(label scopesoup:needs-decision not added\)/);
  const parked = loadJobs(w.store)[ghKey("1")]?.parked;
  assert.equal(parked?.as, "escalated");
  assert.equal(parked?.questions, undefined);
  assert.match(parked?.reason ?? "", /^github could not be written: .* The questions were: Round up or down\? Which unit\?/);
});

// --- on GitHub each triage round's rewrite is a comment, and so is a proposed restructuring ---

test("a triage round posts its rewrite as a comment with the hash of the body it read, and its questions as question comments naming it", async () => {
  const { w, fake, deps } = await questionWorld();
  w.runner.end("1", "succeeded", TRIAGE);
  await tick(deps);
  const job = loadJobs(w.store)[ghKey("1")]!;
  assert.equal(job.parked?.as, "needs-decision");
  const [rewrite, question] = fake.comments.get("1")!;
  assert.deepEqual(job.parked?.rewrite, { id: String(rewrite!.id), questions: [String(question!.id)], texts: [{ question: "Metric or imperial?", n: 1 }], askedAt: question!.created_at });
  // The rewrite's questions are followed apart from the issue questions': their answers settle the rewrite only with Accept on the board, or start a new round.
  assert.equal(job.parked?.questions, undefined);
  assert.match(rewrite!.body!, /^<details><summary>Triage, round 1: proposed description<\/summary>\n\nShow the tide table in metres\. Done when the table shows metres only\.\n\n<\/details>\n\n<!-- scopesoup:rewrite /);
  assert.deepEqual(readMarker(rewrite!.body)?.data, { v: 1, round: 1, bodySha: createHash("sha256").update("Show the tides.").digest("hex") });
  assert.equal(readMarker(question!.body)?.data.rewrite, rewrite!.id);
  assert.match(question!.body!, /^\*\*Q1: Metric or imperial\?\*\*/);
  assert.deepEqual(labelsOn(fake), ["scopesoup:needs-decision"]);
  // The comments tell a person: no person's comment, no log line.
  assert.deepEqual(w.calls.filter((call) => call.startsWith("answerTurn")), []);
  assert.deepEqual(w.lines.filter((line) => line.startsWith("1 question ")), []);
  assert.equal(w.reasons("orchestrator.rewrite_posted").length, 1);
});

test("a rewrite over 60,000 characters stays on the board, and the parked Item says so", async () => {
  const { w, fake, deps } = await questionWorld();
  w.runner.end("1", "succeeded", { ...TRIAGE, rewrite: "Metres. ".repeat(7600) });
  await tick(deps);
  assert.equal(fake.comments.get("1"), undefined);
  const job = loadJobs(w.store)[ghKey("1")]!;
  assert.equal(job.parked?.rewrite, undefined);
  assert.match(job.parked?.reason ?? "", / The rewrite is over 60,000 characters, too large for a comment on github: it stays on Scope Soup's board\.$/);
  // As before: a person's list and the log line.
  assert.equal(w.calls.filter((call) => call.startsWith("answerTurn")).length, 1);
});

test("a proposed restructuring is a question comment with the restructuring in its marker", async () => {
  const { w, fake, deps } = await questionWorld();
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, restructure: RESTRUCTURE });
  await tick(deps);
  const job = loadJobs(w.store)[ghKey("1")]!;
  const [asked] = fake.comments.get("1")!;
  assert.deepEqual(job.parked?.questions, [String(asked!.id)]);
  assert.equal(asked!.body!.split("\n\n<!--")[0], `**Q1: Proposed restructuring: ${RESTRUCTURE_REASON}**\n\n1. **Part one** (new sub-issue): Do the first half.\n2. **Part two** (added to #2): Do the second half.\n\nThis Item becomes an umbrella over its sub-issues.\n\nAccept, edit or reject the restructuring on Scope Soup's board.`);
  assert.deepEqual(readMarker(asked!.body)?.data.proposal, { id: job.proposal!.id, reason: RESTRUCTURE_REASON, original: "umbrella", parts: PARTS });
  assert.match(job.proposal!.id, /^[0-9a-f]{8}$/, "its own id, carried by its marker lines");
  // The Item page reads it from the comment; the parts are found on GitHub, none yet.
  const page = buildItemPage(loadSnapshot(w.store), ghKey("1"), new Date(w.clock.ms))!;
  assert.deepEqual(page.proposal?.parts, PARTS);
  assert.equal(page.proposal?.original, "umbrella");
  assert.equal(page.proposal?.created, undefined);
  assert.deepEqual(w.calls.filter((call) => call.startsWith("answerTurn")), []);
});

test("a trusted A1: reply to a rewrite question other than the recommendation starts round 2; the recommendation leaves the rewrite for Accept", async () => {
  const other = await questionWorld();
  other.w.runner.end("1", "succeeded", TRIAGE);
  await tick(other.deps);
  other.fake.reply(1, "kim", "COLLABORATOR", "A1: Imperial");
  await other.sync();
  await tick(other.deps);
  assert.match(other.w.reasons("orchestrator.rewrite_answered").at(-1) ?? "", /^Answered on github otherwise than recommended in round 1 of the triage \(Metric or imperial\? Answered: Imperial\)/);
  assert.deepEqual(labelsOn(other.fake), []);
  const rerun = loadJobs(other.w.store)[ghKey("1")];
  assert.equal(rerun?.rewrite, undefined);
  assert.equal(rerun?.parked, undefined);
  // The next triage is round 2, with the answer in its prompt.
  other.w.clock.ms += 60_000;
  await tick(other.deps);
  assert.deepEqual(roles(other.w), ["triage", "triage"]);
  assert.match(other.w.runner.requests[1]?.vars?.itemBody ?? "", /Answered: Imperial/);
  other.w.runner.end("1", "succeeded", { ...TRIAGE, questions: [], rewrite: "Show the tide table in feet." });
  await tick(other.deps);
  assert.equal(loadJobs(other.w.store)[ghKey("1")]?.rewrite?.round, 2);

  const same = await questionWorld();
  same.w.runner.end("1", "succeeded", TRIAGE);
  await tick(same.deps);
  same.fake.reply(1, "robin", "OWNER", "A: Metric");
  await same.sync();
  await tick(same.deps);
  const waiting = loadJobs(same.w.store)[ghKey("1")]!;
  assert.equal(waiting.parked?.as, "needs-decision");
  assert.equal(waiting.parked?.rewrite?.answered, true);
  assert.equal(waiting.rewrite?.settled, undefined);
  // The label stays while the rewrite waits for Accept, Edit or Reject.
  assert.deepEqual(labelsOn(same.fake), ["scopesoup:needs-decision"]);
  assert.equal(same.w.reasons("orchestrator.rewrite_questions_answered").length, 1);
  same.w.clock.ms += 60_000;
  await tick(same.deps);
  assert.deepEqual(roles(same.w), ["triage"]);
});

// --- transfer, delete and rate limits; failed posts retried; deleted questions ---

const R1 = "/repos/harbour/tides/issues/1";
const questionsOn = (fake: ReturnType<typeof fakeIssues>) => (fake.comments.get("1") ?? []).filter((comment) => readMarker(comment.body)?.kind === "question");

test("a question post GitHub answers 502 after taking it is retried by the next tick on its own, with no second comment", async () => {
  const { w, fake, deps } = await questionWorld();
  fake.fail((call) => call === `POST ${R1}/comments`, 502, { applied: true });
  w.runner.end("1", "succeeded", TWO_QUESTIONS);
  await tick(deps);
  const parked = loadJobs(w.store)[ghKey("1")]?.parked;
  assert.equal(parked?.as, "escalated");
  assert.equal(parked?.retry, "post");
  assert.match(parked?.reason ?? "", /^github could not be written: GitHub 502 .* Scope Soup tries again at each tick by itself/);
  assert.equal(questionsOn(fake).length, 1);
  // Not a person's to answer: no person's comment on the host that could not be written.
  assert.deepEqual(w.calls.filter((call) => call.startsWith("answerTurn")), []);

  await tick(deps);
  const after = loadJobs(w.store)[ghKey("1")]?.parked;
  assert.equal(after?.as, "needs-decision");
  assert.equal(after?.retry, undefined);
  assert.match(after?.reason ?? "", /^Triage found 2 decisions/);
  // Q1 was found on GitHub, not posted again; Q2 is posted.
  const asked = questionsOn(fake);
  assert.deepEqual(asked.map((comment) => readMarker(comment.body)?.data.n), [1, 2]);
  assert.deepEqual(after?.questions, asked.map((comment) => String(comment.id)));
  assert.equal(w.reasons("orchestrator.host_write_failed").length, 1);
  assert.equal(w.reasons("orchestrator.questions_asked").length, 1);
  assert.deepEqual(roles(w), ["triage"]);
});

test("a post GitHub refuses for good (403, missing rights) stays an escalation and is not retried", async () => {
  const { w, fake, deps } = await questionWorld();
  fake.refusesComments = true;
  w.runner.end("1", "succeeded", TWO_QUESTIONS);
  await tick(deps);
  const parked = loadJobs(w.store)[ghKey("1")]?.parked;
  assert.equal(parked?.as, "escalated");
  assert.equal(parked?.retry, undefined);
  assert.match(parked?.reason ?? "", /Answer here to start again\.$/);
  fake.refusesComments = false;
  fake.clear();
  await tick(deps);
  assert.equal(fake.calls.some((call) => !call.startsWith("GET")), false);
  assert.equal(loadJobs(w.store)[ghKey("1")]?.parked?.as, "escalated");
});

test("a 429 with retry-after holds the writes: the tick finishes in under 1 s while they wait, sends nothing, and posts once the wait is over", async () => {
  const { w, fake, deps } = await questionWorld(true);
  fake.fail((call) => call === `POST ${R1}/labels`, 429, { headers: { "retry-after": "60" } });
  w.runner.end("1", "succeeded", TWO_QUESTIONS);
  let started = performance.now();
  await tick(deps);
  assert.ok(performance.now() - started < 1000, "the tick that met the rate limit waited");
  assert.equal(loadJobs(w.store)[ghKey("1")]?.parked?.retry, "post");
  assert.match(w.reasons("orchestrator.host_write_failed")[0] ?? "", /GitHub 429/);

  fake.clear();
  w.clock.ms += 30_000;
  started = performance.now();
  await tick(deps);
  assert.ok(performance.now() - started < 1000, "the tick waited for the rate limit");
  // Nothing is sent while the wait lasts, and the same failure again writes no new event.
  assert.deepEqual(fake.calls, []);
  const failed = w.reasons("orchestrator.host_write_failed");
  assert.match(failed.at(-1) ?? "", /rate limited until .*; no request sent/);
  w.clock.ms += 10_000;
  await tick(deps);
  assert.deepEqual(fake.calls, []);
  assert.equal(w.reasons("orchestrator.host_write_failed").length, failed.length);

  w.clock.ms += 21_000;
  await tick(deps);
  assert.equal(loadJobs(w.store)[ghKey("1")]?.parked?.as, "needs-decision");
  assert.equal(questionsOn(fake).length, 2);
});

test("after Q2 is deleted unanswered the next question is Q3: the log comment keeps the deleted question and its number", async () => {
  const { w, fake, deps, sync } = await questionWorld();
  w.runner.end("1", "succeeded", TWO_QUESTIONS);
  await tick(deps);
  const [, second] = loadJobs(w.store)[ghKey("1")]!.parked!.questions!;
  fake.reply(1, "robin", "OWNER", "A1: down");
  fake.deleteComment(Number(second));
  await sync();
  await tick(deps);
  assert.match(w.reasons("orchestrator.job_released").at(-1) ?? "", /was deleted on github: the Item is no longer parked/);
  const log = (fake.comments.get("1") ?? []).find((comment) => readMarker(comment.body)?.kind === "log");
  assert.deepEqual(readMarker(log?.body)?.data.deleted, [{ question: "Which unit?", n: 2 }]);
  assert.match(log?.body ?? "", /Questions deleted on GitHub, not to be asked again: Q2 "Which unit\?"/);
  assert.deepEqual(roles(w), ["triage", "triage"]);
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, hidesDecision: true, decision: { question: "Which tide datum?", options: ["chart datum", "mean sea level"], recommendation: "chart datum" } });
  await tick(deps);
  const asked = questionsOn(fake).at(-1)!;
  assert.match(asked.body!, /^\*\*Q3: Which tide datum\?\*\*/);
  assert.equal(readMarker(asked.body)?.data.n, 3);
});

test("deleting Q1 while Q2 is open withdraws Q2: edited to say so, and no longer open", async () => {
  const { w, fake, deps, sync } = await questionWorld();
  w.runner.end("1", "succeeded", TWO_QUESTIONS);
  await tick(deps);
  const [first, second] = loadJobs(w.store)[ghKey("1")]!.parked!.questions!;
  fake.deleteComment(Number(first));
  await sync();
  await tick(deps);
  const withdrawn = fake.comments.get("1")!.find((comment) => String(comment.id) === second)!;
  assert.match(withdrawn.body!, /^~~Q2~~ Withdrawn: Scope Soup asks again\./);
  assert.equal(readMarker(withdrawn.body)?.data.withdrawn, true);
  assert.equal(readMarker(withdrawn.body)?.data.n, 2);
  assert.equal(w.store.get<WorkItem>(ghRef("1"))?.openQuestions, undefined);
  assert.deepEqual(w.store.get<WorkItem>(ghRef("1"))?.hostRecord?.deletedQuestions, ["Round up or down?"]);
  // No question waits any more, so the label goes.
  assert.deepEqual(labelsOn(fake), []);
  // The triage runs again, and a withdrawn question cannot be answered.
  assert.deepEqual(roles(w), ["triage", "triage"]);
  fake.reply(1, "robin", "OWNER", "A2: feet");
  await sync();
  assert.equal(w.store.get<WorkItem>(ghRef("1"))?.answers, undefined);
});

test("after Q1 (\"Which unit?\") is deleted, the next triage's prompt names it and says not to ask it again; later prompts too", async () => {
  const { w, fake, deps, sync } = await questionWorld();
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, hidesDecision: true, decision: { question: "Which unit?", options: ["metres", "feet"], recommendation: "metres" } });
  await tick(deps);
  fake.deleteComment(Number(loadJobs(w.store)[ghKey("1")]!.parked!.questions![0]));
  await sync();
  await tick(deps);
  const told = /Questions a person deleted on the host \(do not ask them again; decide these points with your own judgement\):\n- Which unit\?/;
  assert.deepEqual(roles(w), ["triage", "triage"]);
  assert.match(w.runner.requests[1]?.vars.itemBody ?? "", told);
  // The log comment keeps it, so the next round is told too.
  w.runner.end("1", "succeeded", TRIAGE_OK);
  await tick(deps);
  w.clock.ms += 1000;
  await tick(deps);
  assert.deepEqual(roles(w), ["triage", "triage", "implement"]);
  assert.match(w.runner.requests[2]?.vars.itemBody ?? "", told);
});

test("a transferred issue (301) and a deleted one (410) leave the store with work.removed, and a job parked on one is closed", async () => {
  const { w, fake, host, deps } = await questionWorld();
  w.runner.end("1", "succeeded", TWO_QUESTIONS);
  await tick(deps);
  const only = { info: host.info, work: host.work };
  const options = { pipelines: [], recentLimit: 1, batchLimit: 1, full: false };
  const now = (): string => new Date(w.clock.ms).toISOString();
  assert.deepEqual(await syncHost(w.store, only, options, now), []);
  // The Item parked on its questions, so its comments are listed again each poll: the 301 shows at the next one.
  fake.transfer(1, `${ISSUES_API}/repositories/77/issues/12`);
  assert.deepEqual(await syncHost(w.store, only, options, now), []);
  assert.equal(w.store.get<WorkItem>(ghRef("1")), null);
  const removed = w.store.eventsAfter(0, 10_000).filter((event) => event.kind === "work.removed");
  assert.deepEqual(removed.map((event) => event.subject), [ghKey("1")]);
  assert.match((removed[0]?.data as { reason: string }).reason, /^1 was moved to https:\/\/api\.github\.test\/repositories\/77\/issues\/12 on github/);
  await tick(deps);
  assert.equal(loadJobs(w.store)[ghKey("1")], undefined);
  assert.match(w.reasons("orchestrator.job_closed").at(-1) ?? "", /no longer in the store/);
  assert.ok(w.runner.deleted.includes("scopesoup/1"));

  // An issue that is deleted answers 410: a full sync's look at it removes it, saying so.
  const other = fakeIssues("harbour/tides", [5, 6]);
  const store = openStore(":memory:");
  const second = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: other.fetch, conventions: true, login: "scopesoup-bot" });
  const pair = { info: second.info, work: second.work };
  await syncHost(store, pair, options, now);
  other.deleteIssue(5);
  other.transfer(6, `${ISSUES_API}/repositories/77/issues/13`);
  assert.deepEqual(await syncHost(store, pair, { ...options, full: true }, now), []);
  const gone = store.eventsAfter(0, 10_000).filter((event) => event.kind === "work.removed").map((event) => [event.subject, (event.data as { reason: string }).reason]);
  assert.deepEqual(gone, [["github:work:5", "#5 was deleted on GitHub."], ["github:work:6", `6 was moved to ${ISSUES_API}/repositories/77/issues/13 on github; it leaves the board.`]]);
  store.close();
});

// --- the triage proposes label changes in its rewrite ---

/** Item 1 is labelled `question` on a fake GitHub whose repository has `bug`, `question` and Scope Soup's own label; its triage starts. */
async function labelWorld() {
  const w = world(config(), [ghItem("1", { labels: ["question"] })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const fake = fakeIssues("harbour/tides", [1]);
  for (const name of ["bug", "question", "scopesoup:needs-decision"]) fake.labels.add(name);
  fake.labelDescriptions.set("bug", "Something does not work");
  fake.labelDescriptions.set("scopesoup:needs-decision", "A Scope Soup question waits for an answer");
  fake.issues.get("1")!.labels.push({ name: "question" });
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  const real = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config(), store: w.store });
  const deps = w.depsFor();
  Object.assign(deps.actions, { askQuestions: real.askQuestions, settleQuestions: real.settleQuestions, postRewrite: real.postRewrite, checkRewrite: real.checkRewrite, repoLabels: real.repoLabels });
  await w.run();
  assert.deepEqual(roles(w), ["triage"]);
  return { w, fake, deps };
}

test("the triage is shown the repository's labels and the Item's, never scopesoup:*; it proposes +bug, −question with its rewrite", async () => {
  const { w, fake, deps } = await labelWorld();
  const vars = w.runner.requests[0]!.vars!;
  assert.match(vars.labels!, /^The repository's labels \(name: description\):\n- bug: Something does not work\n- question\nThe Item's labels: question$/);
  assert.doesNotMatch(vars.labels!, /scopesoup/);
  w.runner.end("1", "succeeded", { ...TRIAGE, labels: { add: ["bug", "scopesoup:needs-decision", "tidal"], remove: ["question"] } });
  await tick(deps);
  const job = loadJobs(w.store)[ghKey("1")]!;
  assert.deepEqual(job.rewrite?.labels, { add: ["bug"], remove: ["question"] });
  // A label the repository does not have is dropped and noted, not an error; scopesoup:* is never proposed.
  assert.deepEqual(job.rewrite?.droppedLabels, ["tidal"]);
  assert.match(job.parked?.reason ?? "", / Labels: \+bug, −question\. The triage named label the repository does not have, dropped: tidal\.$/);
  const [rewrite] = fake.comments.get("1")!;
  assert.deepEqual(readMarker(rewrite!.body)?.data.labels, { add: ["bug"], remove: ["question"] });
  assert.match(rewrite!.body!, /<\/details>\n\nLabels: \+bug, −question\n\n<!-- scopesoup:rewrite /);
  // Nothing is applied before Accept.
  assert.deepEqual(labelsOn(fake), ["question", "scopesoup:needs-decision"]);
  // The board shows the proposal with the rewrite.
  const page = buildItemPage(loadSnapshot(w.store), ghKey("1"), new Date(w.clock.ms));
  assert.deepEqual(page?.parked?.rewrite?.labels, { add: ["bug"], remove: ["question"] });
  assert.deepEqual(page?.parked?.rewrite?.droppedLabels, ["tidal"]);
});

test("with no question and the description kept, a label proposal still waits for an answer's Accept or Reject", async () => {
  const { w, deps } = await labelWorld();
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, rewrite: "", links: [], labels: { add: ["bug"], remove: [] } });
  await tick(deps);
  const job = loadJobs(w.store)[ghKey("1")]!;
  assert.equal(job.parked?.as, "needs-decision");
  assert.deepEqual(job.rewrite?.labels, { add: ["bug"], remove: [] });
  assert.deepEqual(roles(w), ["triage"]);
});

// --- scopesoup:needs-decision is on while a rewrite waits for an answer, also with no question ---

test("a triage with no question and a changed description posts its rewrite and puts scopesoup:needs-decision on", async () => {
  const { w, fake, deps } = await labelWorld();
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, rewrite: REWRITE, links: [] });
  await tick(deps);
  const job = loadJobs(w.store)[ghKey("1")]!;
  assert.equal(job.parked?.as, "needs-decision");
  assert.deepEqual(job.parked?.rewrite?.questions, []);
  assert.deepEqual(fake.comments.get("1")!.map((comment) => readMarker(comment.body)?.kind), ["rewrite"]);
  assert.deepEqual(labelsOn(fake), ["question", "scopesoup:needs-decision"]);
});

test("a rewrite that parked only on a label proposal puts scopesoup:needs-decision on", async () => {
  const { w, fake, deps } = await labelWorld();
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, rewrite: "", links: [], labels: { add: ["bug"], remove: [] } });
  await tick(deps);
  assert.equal(loadJobs(w.store)[ghKey("1")]?.parked?.as, "needs-decision");
  assert.deepEqual(labelsOn(fake), ["question", "scopesoup:needs-decision"]);
});

test("while a person's chat turn runs on an item, the cycle starts nothing on it and leaves its job alone", async () => {
  const w = world(config({ level: 2, settings: { maxParallelSessions: { value: 3, reason: "test" } } }), [item("1", { state: "doing" }), item("2"), item("3", { state: "done" })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const due = { item: ref("1"), workspace: workspaceKey(ref("1")), branch: "scopesoup/1", step: "implement" as const, failures: 0, fixRounds: 1, agentSession: "agent-1", resumeWith: "Fix it.", startedAt: new Date(T0).toISOString() };
  // Item 3 is done, which would close its job and remove its worktree and branch: not while a person talks to its session.
  const closing = { ...due, item: ref("3"), workspace: workspaceKey(ref("3")), branch: "scopesoup/3" };
  w.store.tx(() => saveJobs(w.store, { [refKey(ref("1"))]: due, [refKey(ref("3"))]: closing }));
  let talking = new Set(["1", "3"]);
  w.runner.busy = (subject) => talking.has(subject.id);
  const report = await w.run();
  assert.deepEqual(report.started.map((each) => each.item), [refKey(ref("2"))]);
  assert.deepEqual(w.runner.requests.map((request) => `${request.subject.id} ${request.role}`), ["2 triage"]);
  assert.deepEqual(w.job("1"), due);
  assert.deepEqual(w.job("3"), closing);
  assert.deepEqual([w.runner.released, w.runner.deleted], [[], []]);
  // The turns count as running sessions.
  assert.equal(report.running, 3);

  // The turns are over: the next tick goes on with both.
  talking = new Set();
  const next = await w.run();
  assert.deepEqual(next.started.map((each) => each.item), [refKey(ref("1"))]);
  assert.equal(w.runner.requests.at(-1)?.resume, "agent-1");
  assert.equal(w.job("3"), undefined);
  assert.deepEqual(w.runner.deleted, ["scopesoup/3"]);
});

test("a chat turn a person starts while the tick prepares the item's step keeps the item: the step is not started", async () => {
  const w = world(config({ level: 2 }), [item("1", { state: "doing" })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const due = { item: ref("1"), workspace: workspaceKey(ref("1")), branch: "scopesoup/1", step: "implement" as const, failures: 0, fixRounds: 1, agentSession: "agent-1", resumeWith: "Fix it.", startedAt: new Date(T0).toISOString() };
  w.store.tx(() => saveJobs(w.store, { [refKey(ref("1"))]: due }));
  // Not busy when the tick picks the item; a person's turn starts while the tick awaits the workspace, before its start.
  let talking = false;
  const checks: boolean[] = [];
  w.runner.busy = () => {
    checks.push(talking);
    return talking;
  };
  const take = w.runner.takeWorkspace.bind(w.runner);
  w.runner.takeWorkspace = async (...args) => {
    talking = true;
    return take(...args);
  };
  const report = await w.run();
  assert.deepEqual(report.started, []);
  assert.deepEqual(w.runner.requests, []);
  assert.deepEqual(w.job("1"), due);
  // Checked when picking (not busy) and again right before the start (busy).
  assert.deepEqual(checks.slice(-2), [false, true]);
  assert.match(report.idle ?? "", /1 waits: a person is talking to one of its sessions/);
});

// --- questions while implementing: cheap ones decided and recorded, expensive ones parked and asked ---

const TAKEN = [
  { question: "Which name for the helper?", chosen: "roundHeight", others: ["round", "toDecimal"], why: "Says what it rounds." },
  { question: "Sort the list by?", chosen: "time", others: ["height"], why: "As the tables do." },
];

test("an implementor answer with two decisions records them in one assumption line and the work goes on", async () => {
  const w = world(config({ rules: { ...STAGE1 } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, decisions: TAKEN });
  const lines = w.lines.filter((line) => line.includes(" assumption "));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!.slice("1 assumption ".length)).decisions, TAKEN);
  assert.match(w.reasons("orchestrator.decisions_recorded")[0] ?? "", /^The implementor decided 2 questions itself as cheap to change later: 1\. Which name for the helper\? Chose: roundHeight\. 2\. Sort the list by\? Chose: time\. .*the work goes on\.$/);
  // Nothing parked: the review starts, and the reviewer is shown both decisions to check.
  assert.equal(w.job("1")?.parked, undefined);
  assert.deepEqual(roles(w), ["triage", "implement", "review"]);
  const told = w.runner.requests[2]?.vars.decisions ?? "";
  assert.match(told, /should have been a question; give it as a `must` finding with `ask` true\.\n1\. Which name for the helper\? Chose: roundHeight\. Other options: round; toDecimal\. Why: Says what it rounds\.\n2\. Sort the list by\?/);
  assert.equal(w.calls.filter((call) => call.startsWith("answerTurn")).length, 0);
});

test("a question of the expensive kind still parks the Item, and the decisions taken before it are recorded too", async () => {
  const w = world(config(), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { done: false, summary: "The file format must change.", question: ASKED, decisions: [TAKEN[0]] });
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.deepEqual(w.job("1")?.decision, ASKED);
  assert.equal(w.lines.filter((line) => line.includes(" assumption ")).length, 1);
  assert.equal(w.lines.filter((line) => line.includes(" question ")).length, 1);
});


// Shortened from real implement answers: the fields after the summary ran into its string as tool-call markup.
const MARKUP_DECISIONS = `Added the helper and its test.</summary>\n<parameter name="decisions">${JSON.stringify(TAKEN)}`;
const MARKUP_QUESTION = `Fixed the docstring; the Item still says 6.</summary>\n<parameter name="question">${JSON.stringify({ question: "Which value should the Item use?", options: [{ label: "Keep 0.06", description: "Square metres." }, { label: "Return 6", description: "Not square metres." }], recommendation: "Keep 0.06" })}</parameter>\n<parameter name="decisions">${JSON.stringify([TAKEN[0]])}`;

test("an implement answer with its decisions run into the summary as markup: the decisions are recorded, and no log line carries the markup", async () => {
  const w = world(config({ rules: { ...STAGE1 } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { done: true, summary: MARKUP_DECISIONS, aboutOthers: [] });
  assert.match(w.reasons("orchestrator.answer_repaired")[0] ?? "", /^The implement answer had decisions run into another field as tool-call markup/);
  const lines = w.lines.filter((line) => line.includes(" assumption "));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!.slice("1 assumption ".length)).decisions, TAKEN);
  assert.equal(w.job("1")?.implement?.summary, "Added the helper and its test.");
  assert.match(w.runner.requests[2]?.vars.decisions ?? "", /1\. Which name for the helper\? Chose: roundHeight\./);
  assert.ok(w.hostWrites.some((write) => write.includes("appendLog 1 session") && write.includes("Added the helper and its test.")), w.hostWrites.join("\n"));
  assert.deepEqual(w.hostWrites.filter((write) => /<parameter|<\/summary>/.test(write)), []);
  assert.deepEqual(roles(w), ["triage", "implement", "review"]);
});

test("an implement question run into the summary as markup is asked with its options and recommendation", async () => {
  const w = world(config(), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { done: false, summary: MARKUP_QUESTION });
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.deepEqual(w.job("1")?.decision?.options, [{ label: "Keep 0.06", description: "Square metres." }, { label: "Return 6", description: "Not square metres." }]);
  assert.equal(w.job("1")?.decision?.recommendation, "Keep 0.06");
  assert.equal(w.lines.filter((line) => line.includes(" assumption ")).length, 1);
  assert.deepEqual(w.hostWrites.filter((write) => /<parameter|<\/summary>/.test(write)), []);
});

test("an implement answer whose markup cannot be taken out is retried as malformed, and the markup is not written to the host", async () => {
  const w = world(config(), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  w.runner.end("1", "succeeded", { done: true, summary: 'Done.</summary>\n<parameter name="decisions">[{"question":' });
  await w.run();
  assert.equal(w.job("1")?.parked, undefined);
  assert.match(w.reasons("orchestrator.retry_scheduled")[0] ?? "", /implement step failed \(1 of 3\): The implementer's answer does not have the expected shape, or has tool-call markup inside a string\./);
  assert.ok(w.hostWrites.some((write) => write.includes("appendLog 1 session") && write.includes("tool-call markup inside its summary and was not taken")), w.hostWrites.join("\n"));
  assert.deepEqual(w.hostWrites.filter((write) => /<parameter|<\/summary>/.test(write)), []);
});
test("the reviewer's send-back for a decision that should have been a question resumes the implementor, told to stop and ask it", async () => {
  const w = world(config({ rules: { ...STAGE1 } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, decisions: TAKEN });
  await step(w, "1", "succeeded", { verdict: "changes", findings: [{ severity: "should", ask: true, text: "Sorting by time changes the saved file's order: ask a person." }] });
  const last = w.runner.requests[w.runner.requests.length - 1];
  assert.equal(last?.role, "implement");
  assert.equal(last?.resume, "agent-s2");
  assert.match(last?.message ?? "", /- \[must, ask a person\] Sorting by time changes the saved file's order: ask a person\./);
  assert.match(last?.message ?? "", /stop and ask it in `question`, and change nothing for it yet\. Fix the others and commit\./);
  // The implementor asks it: the Item parked for a person, and an answer resumes the implement step.
  await step(w, "1", "succeeded", { done: false, summary: "Asked.", question: ASKED });
  assert.equal(w.job("1")?.parked?.as, "needs-decision");
  assert.ok(releaseJob(w.store, ref("1"), "Ada", new Date(w.clock.ms).toISOString(), "answered"));
  assert.ok(w.job("1")?.answerArrived);
  await w.run();
  assert.equal(w.runner.requests[w.runner.requests.length - 1]?.role, "implement");
  assert.equal(w.job("1")?.answerArrived, undefined);
});

test("after a started Item whose answer arrived counts as started; a blocker still starts first", async () => {
  for (const answered of [true, false]) {
    const w = world(config({ settings: { maxParallelSessions: { value: 1, reason: "test" } } }), [item("1"), item("2", { labels: ["bug"], priority: "blocker" })]);
    const job = (id: string) => ({ item: ref(id), workspace: workspaceKey(ref(id)), branch: `scopesoup/${id}`, step: "implement" as const, failures: 0, fixRounds: 0, startedAt: new Date(T0).toISOString() });
    saveJobs(w.store, { [refKey(ref("1"))]: { ...job("1"), ...(answered ? { answerArrived: new Date(T0).toISOString() } : {}) }, [refKey(ref("2"))]: job("2") });
    await w.run();
    assert.deepEqual(w.runner.requests.map((request) => request.subject.id), ["2"]);
  }
  const jobs = { [refKey(ref("1"))]: { answerArrived: "2026-11-18T10:00:00Z" } } as unknown as ReturnType<typeof loadJobs>;
  const triagedLog = [{ at: new Date(T0).toISOString(), by: { who: "scopesoup", agent: true as const }, kind: "session" as const, fields: { role: "triage" } }];
  const both = [item("2", { priority: "blocker", log: triagedLog }), item("1")];
  assert.deepEqual([...both].sort(compareItems([], jobs, both)).map((each) => each.ref.id), ["2", "1"]);
});

// --- an Overturn while the change has not merged goes into the running work ---

/** A person overturns the implementor's second decision on the Item, as `overturnAssumption` does on the host. */
function overturn(w: World, id: string, answer = "By height"): boolean {
  const decision = { id: `d-${id}`, at: new Date(T0).toISOString(), question: TAKEN[1]!.question, chosen: TAKEN[1]!.chosen, others: TAKEN[1]!.others, why: TAKEN[1]!.why };
  return overturnIntoWork(w.store, w.store.get<WorkItem>(ref(id))!, decision, answer, "robin", new Date(w.clock.ms).toISOString());
}

test("Overturn on an Item in work resumes the implementor's own session with the answer before review, and files no new Item", async () => {
  const w = world(config({ rules: { ...STAGE1 } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  assert.equal(w.runner.requests[1]?.role, "implement");
  // The implementor is running: the answer is kept for it.
  assert.equal(overturn(w, "1"), true);
  assert.match(w.reasons("orchestrator.overturn_kept")[0] ?? "", /goes into the running work.*No new Item is filed\./);
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, decisions: TAKEN });
  // Its turn ended: its own session is resumed with the answer, not the review.
  assert.deepEqual(roles(w), ["triage", "implement", "implement"]);
  const last = w.runner.requests[2]!;
  assert.equal(last.resume, "agent-s2");
  assert.match(last.message ?? "", /^A person overturned decision "Sort the list by\?" \(you chose: time\): By height\nChange the work to match before review, and commit\. Answer as before\./);
  assert.deepEqual(w.job("1")?.overturned, ["d-1"]);
  assert.deepEqual(overturnsFor(w.store, refKey(ref("1"))), []);
  assert.ok(w.reasons("orchestrator.step").some((reason) => /A person overturned a decision .* while the change has not merged\. Next: the implementor's own session changes the work to match, before review\./.test(reason)));
  // Then the review, and nothing is told twice.
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.deepEqual(roles(w), ["triage", "implement", "implement", "review"]);
  assert.equal(w.calls.filter((call) => call.startsWith("createWork")).length, 0);
});

test("Overturn on an Item waiting for review sends it back to the implementor first; one in review is not merged", async () => {
  const w = world(config({ rules: { ...STAGE1 } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  // The implementor is done; the review waits for its continuation delay.
  w.runner.end("1", "succeeded", IMPLEMENT_OK);
  await w.run();
  assert.equal(w.job("1")?.step, "review");
  assert.equal(overturn(w, "1"), true);
  w.clock.ms += 1000;
  await w.run();
  assert.equal(w.job("1")?.step, "implement");
  w.clock.ms += 1000;
  await w.run();
  assert.deepEqual(roles(w), ["triage", "implement", "implement"]);
  assert.equal(w.runner.requests[2]?.resume, "agent-s2");
  assert.match(w.runner.requests[2]?.message ?? "", /By height/);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  assert.deepEqual(roles(w), ["triage", "implement", "implement", "review"]);

  // In review: an overturn of another decision while the reviewer runs. It approves, but the change goes back, not on to the merge.
  const other = { id: "d-other", at: new Date(T0).toISOString(), question: TAKEN[0]!.question, chosen: TAKEN[0]!.chosen, others: TAKEN[0]!.others, why: TAKEN[0]!.why };
  assert.equal(overturnIntoWork(w.store, w.store.get<WorkItem>(ref("1"))!, other, "Call it round", "robin", new Date(w.clock.ms).toISOString()), true);
  await step(w, "1", "succeeded", REVIEW_OK);
  const last = w.runner.requests[w.runner.requests.length - 1]!;
  assert.equal(last.role, "implement");
  // The newest implementor session (the fake gives each run an id of its own).
  assert.equal(last.resume, "agent-s3");
  assert.doesNotMatch(last.message ?? "", /Merge now/);
  assert.match(last.message ?? "", /A person overturned decision "Which name for the helper\?" \(you chose: roundHeight\): Call it round/);
  assert.equal(w.job("1")?.merge, undefined);
  assert.deepEqual(w.job("1")?.overturned, ["d-1", "d-other"]);
});

test("pressing Overturn twice does not resume twice; a change in the queue or merged is not taken into the work", async () => {
  const w = world(config({ rules: { ...STAGE1 } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  assert.equal(overturn(w, "1"), true);
  // The verdict could not be written, so a person presses again: it is kept once.
  assert.equal(overturn(w, "1"), true);
  assert.equal(overturnsFor(w.store, refKey(ref("1"))).length, 1);
  assert.equal(w.reasons("orchestrator.overturn_kept").length, 1);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  // Handed to the work; a third press (the verdict failed again) keeps nothing new.
  assert.equal(overturn(w, "1"), true);
  assert.deepEqual(overturnsFor(w.store, refKey(ref("1"))), []);
  await step(w, "1", "succeeded", IMPLEMENT_OK);
  await step(w, "1", "succeeded", { verdict: "changes", findings: [{ severity: "must", text: "Off by one." }] });
  const told = w.runner.requests.filter((request) => /overturned decision/.test(request.message ?? ""));
  assert.equal(told.length, 1);

  // Not taken: in the merge queue, handed over, merged, done, or no work under way.
  const job = w.job("1")!;
  assert.equal(takesOverturn({ ...job, parked: { as: "queued", reason: "", at: "" } }, { state: "doing" }), false);
  assert.equal(takesOverturn({ ...job, parked: { as: "handed-over", reason: "", at: "" } }, { state: "doing" }), false);
  assert.equal(takesOverturn({ ...job, merged: HEAD }, { state: "doing" }), false);
  assert.equal(takesOverturn(job, { state: "done" }), false);
  assert.equal(takesOverturn(undefined, { state: "doing" }), false);
  assert.equal(takesOverturn({ ...job, parked: { as: "needs-decision", reason: "", at: "", byStep: true } }, { state: "doing" }), true);
});

test("an overturn kept for work whose change merged before it was handed gets the new Item an Overturn after merging files", async () => {
  const w = world(config({ rules: { ...STAGE1 } }), [item("1")]);
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  assert.equal(overturn(w, "1"), true);
  // The change merged (the Item is done) before the implementor's turn ended; its job closes.
  w.store.put({ ...w.store.get<WorkItem>(ref("1"))!, state: "done" }, "sync", new Date(w.clock.ms).toISOString());
  const reworked: string[] = [];
  const deps = w.depsFor();
  const actions: Actions = { ...deps.actions, async reworkOverturn(subject, id, answer) { reworked.push(`${subject.id} ${id} ${answer}`); return ref("9"); } };
  w.runner.end("1", "succeeded", IMPLEMENT_OK);
  await tick({ ...deps, actions });
  await tick({ ...deps, actions });
  assert.equal(w.job("1"), undefined);
  assert.deepEqual(reworked, ["1 d-1 By height"]);
  assert.match(w.reasons("orchestrator.overturn_merged")[0] ?? "", /merged before a person's overturn of "Sort the list by\?" reached it: 9 reworks it\./);
  assert.deepEqual(overturnsFor(w.store, refKey(ref("1"))), []);
});

// --- triage and implementors ask questions about other Items (aboutOthers), and triage may rewrite them ---

const ABOUT_Q = { question: "Knots or metres per second?", options: [{ label: "Knots", description: "As the charts." }, { label: "Metres per second", description: "SI." }], recommendation: "Knots" };
const ABOUT_REWRITE = "Show wind speed in knots. Done when the forecast shows knots.";

test("a triage puts a question and a rewrite on another backlog Item, which parks on them as needs-decision naming the asker", async () => {
  const w = world(config(), [item("1", { body: "Tide table units." }), item("2", { body: "Wind units." })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  assert.deepEqual(roles(w), ["triage"]);
  await step(w, "1", "succeeded", { ...TRIAGE_OK, aboutOthers: [{ item: "#2", questions: [ABOUT_Q], rewrite: ABOUT_REWRITE }] });
  const job = w.job("2")!;
  assert.equal(job.parked?.as, "needs-decision");
  assert.equal(job.step, "triage");
  assert.deepEqual(job.rewrite, { original: "Wind units.", text: ABOUT_REWRITE, questions: [{ ...ABOUT_Q, question: "Knots or metres per second? (asked by triage of 1)" }], round: 1, askedBy: ["triage of 1"] });
  assert.match(job.parked?.reason ?? "", /^Asked by triage of 1: a rewrite of the description and 1 question\(s\) about 2 wait for an answer: 1\. Knots or metres per second\? \(asked by triage of 1\)/);
  // Its own triage did not start; item 1 went on to implement.
  assert.deepEqual(w.runner.requests.map((request) => `${request.role} ${request.subject.id}`), ["triage 1", "implement 1"]);
  assert.ok(w.calls.includes("answerTurn 2 decision"));
  const page = buildItemPage(loadSnapshot(w.store), refKey(ref("2")), new Date(w.clock.ms))!;
  assert.equal(page.parked?.rewrite?.text, ABOUT_REWRITE);
  assert.deepEqual(w.reasons("orchestrator.about_other_written"), ["Wrote on 2 what triage of 1 asked: 1 question(s) and a rewrite."]);

  // Answering works as for triage's own rewrite: accepting it triages Item 2 again, with the answer in its prompt.
  assert.deepEqual(answerRewrite(w, "2", ["Knots"]), { settled: "accepted" });
  w.runner.end("1", "succeeded", IMPLEMENT_OK);
  await w.run();
  w.clock.ms += 1000;
  await w.run();
  assert.equal(w.runner.requests.at(-1)?.role, "triage");
  assert.equal(w.runner.requests.at(-1)?.subject.id, "2");
  assert.match(w.runner.requests.at(-1)!.vars.itemBody!, /Answered: Knots/);
  assert.match(w.reasons("orchestrator.step").find((reason) => reason.includes("asked about 2")) ?? "", /A person settled what triage of 1 asked about 2 \(the rewrite accepted\)\. Next: triage again/);
});

test("an implementor puts a question on an Item with paused work, which keeps its branch and session", async () => {
  const w = world(config(), [item("1"), item("2", { body: "Wind units." })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const at = new Date(w.clock.ms).toISOString();
  w.store.tx(() => {
    const jobs = loadJobs(w.store);
    jobs[refKey(ref("2"))] = {
      item: ref("2"), workspace: workspaceKey(ref("2")), branch: "scopesoup/2", step: "implement", failures: 0, fixRounds: 1, startedAt: at,
      agentSession: "agent-old", resumeWith: "Fix the rounding.", parked: { as: "escalated", reason: "The implement step failed 3 times.", at, byStep: true },
    };
    saveJobs(w.store, jobs);
  });
  await w.run();
  await step(w, "1", "succeeded", TRIAGE_OK);
  await step(w, "1", "succeeded", { ...IMPLEMENT_OK, aboutOthers: [{ item: "2", questions: [ABOUT_Q], rewrite: "An implementor's rewrite is not taken." }] });
  const job = w.job("2")!;
  assert.equal(job.parked?.as, "needs-decision");
  assert.equal(job.step, "triage");
  assert.deepEqual(job.rewrite?.askedBy, ["the implementor of 1"]);
  assert.equal(job.rewrite?.text, "Wind units.");
  assert.deepEqual(job.rewrite?.questions.map((each) => each.question), ["Knots or metres per second? (asked by the implementor of 1)"]);
  assert.deepEqual([job.agentSession, job.resumeWith, job.branch, job.fixRounds], ["agent-old", "Fix the rounding.", "scopesoup/2", 1]);
  // It had given back its workspace and claim when it parked before.
  assert.equal(w.calls.includes("release 2"), false);
});

test("a question for an Item held by a person, or with a running session, waits in the store and is written once it is free", async () => {
  const pat = { holder: { actor: { id: "p", name: "Pat" } } };
  const w = world(config({ settings: { maxParallelSessions: { value: 2, reason: "test" } } }), [item("1"), item("2", pat), item("3")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  assert.deepEqual(w.runner.requests.map((request) => `${request.role} ${request.subject.id}`), ["triage 1", "triage 3"]);
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, aboutOthers: [{ item: "2", questions: [ABOUT_Q] }, { item: "3", questions: [{ ...ABOUT_Q, question: "Gusts too?" }] }] });
  await w.run();
  assert.equal(w.job("2"), undefined);
  assert.equal(w.job("3")?.parked, undefined);
  const waits = w.reasons("orchestrator.about_other_wait");
  assert.ok(waits.includes("Questions from triage of 1 wait for 2: it is held by Pat."), waits.join(" / "));
  assert.ok(waits.includes("Questions from triage of 1 wait for 3: its triage session runs."), waits.join(" / "));
  // Item 3's triage ends ready: before its implement step starts, the question is written.
  w.runner.end("3", "succeeded", TRIAGE_OK);
  await w.run();
  w.clock.ms += 1000;
  await w.run();
  assert.equal(w.job("3")?.parked?.as, "needs-decision");
  assert.deepEqual(w.job("3")?.rewrite?.questions.map((each) => each.question), ["Gusts too? (asked by triage of 1)"]);
  assert.equal(w.runner.requests.some((request) => request.role === "implement" && request.subject.id === "3"), false);
  // Pat lets go of item 2.
  w.store.put(item("2"), "sync", new Date(w.clock.ms).toISOString());
  await w.run();
  assert.equal(w.job("2")?.parked?.as, "needs-decision");
  assert.deepEqual(w.job("2")?.rewrite?.askedBy, ["triage of 1"]);
  assert.equal(w.store.getValue("orchestrator.aboutOthers"), "{}");
});

test("a question about another Item that is open there, or a person answered there, is not asked again by any asker", async () => {
  // As in the trial: triage of A-9 asked about A-7, a person answered on A-7, then other triages asked the same again.
  const q = { ...ABOUT_Q, question: "Item 2 says to change only src/units.js. Should it also update test/sum.test.js?" };
  const w = world(config(), [item("1", { priority: "major" }), item("2", { body: "Rename the unit key." }), item("3", { priority: "critical" })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "3", "succeeded", { ...TRIAGE_OK, aboutOthers: [{ item: "2", questions: [q] }] });
  const parked = w.job("2")!.parked!;
  assert.equal(parked.as, "needs-decision");
  assert.equal(w.reasons("orchestrator.about_other_written").length, 1);
  // Asked again while it is open there: not added.
  await step(w, "3", "succeeded", { done: false, summary: "Stopped.", aboutOthers: [{ item: "2", questions: [q] }] });
  assert.match(w.reasons("orchestrator.about_other_dropped").at(-1) ?? "", /^The implementor of 3 asked about 2 again: .* Not asked again: it is open there\.$/);
  assert.equal(w.store.getValue("orchestrator.aboutOthers") ?? "{}", "{}");
  // A person answers on Item 2 as the trial did (one answer to the parked questions, kept with the parked reason); its text is unchanged.
  const at = new Date(w.clock.ms).toISOString();
  addAnswer(w.store, { subject: ref("2"), answer: "Yes: every file that uses m.", by: "Ada", at, question: parked.reason, textHash: itemTextHash(w.store.get<WorkItem>(ref("2"))!) });
  assert.ok(releaseJob(w.store, ref("2"), "Ada", at, "Yes: every file that uses m."));
  await w.run();
  // Triage of 1, another asker, asks the same: it is not asked again, and Item 2 is not parked again.
  assert.equal(w.runner.requests.map((request) => `${request.role} ${request.subject.id}`).at(-1), "triage 1");
  await step(w, "1", "succeeded", { ...TRIAGE_OK, aboutOthers: [{ item: "#2", questions: [q] }] });
  assert.match(w.reasons("orchestrator.about_other_dropped").at(-1) ?? "", /^Triage of 1 asked about 2 again: .* Not asked again: a person answered it there at .* \("Yes: every file that uses m\."\)\.$/);
  assert.equal(w.store.getValue("orchestrator.aboutOthers") ?? "{}", "{}");
  assert.equal(w.reasons("orchestrator.about_other_written").length, 1);
  assert.notEqual(w.job("2")?.parked?.as, "needs-decision");
});

test("a question for an Item whose change is in review waits, and does not pull it back to triage", async () => {
  // As in the trial: A-7 was built ("Next: review") when triage of A-9's question about it was written, and it went back to triage.
  const w = world(config({ rules: STAGE1, settings: { maxParallelSessions: { value: 2, reason: "test" } } }), [item("1", { priority: "major" }), item("2")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  assert.deepEqual(roles(w), ["triage", "triage"]);
  await step(w, "1", "succeeded", TRIAGE_OK);
  assert.deepEqual(roles(w), ["triage", "triage", "implement"]);
  // Item 1 is built in the same tick in which triage of 2 asks about it: its review session has not started yet.
  w.runner.end("1", "succeeded", IMPLEMENT_OK);
  w.runner.end("2", "succeeded", { ...TRIAGE_OK, aboutOthers: [{ item: "1", questions: [ABOUT_Q] }] });
  await w.run();
  assert.equal(w.job("1")?.parked, undefined);
  assert.equal(w.job("1")?.step, "review");
  assert.ok(w.reasons("orchestrator.about_other_wait").some((reason) => /^Questions from triage of 2 wait for 1: its (change is in review|review session runs)\.$/.test(reason)), w.reasons("orchestrator.about_other_wait").join(" / "));
  assert.deepEqual(w.reasons("orchestrator.about_other_written"), []);
});

test("questions about an unknown or closed Item, or the asker's own, are dropped with an event", async () => {
  const w = world(config(), [item("1"), item("2", { state: "done" })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  await step(w, "1", "succeeded", { ...TRIAGE_OK, aboutOthers: [{ item: "99", questions: [ABOUT_Q] }, { item: "2", questions: [ABOUT_Q] }, { item: "1", questions: [ABOUT_Q] }] });
  const dropped = w.reasons("orchestrator.about_other_dropped");
  assert.equal(dropped.length, 3);
  assert.match(dropped[0]!, /asked about "99", but there is no such open Item other than its own: 1 question\(s\) dropped/);
  assert.match(dropped[1]!, /asked about "2", but it is done/);
  assert.equal(w.store.getValue("orchestrator.aboutOthers") ?? "{}", "{}");
  assert.equal(w.job("1")?.step, "implement");
});

test("an answer's aboutOthers: an entry with tool-call markup or without a question is dropped, and an implementor's rewrite is not read", () => {
  assert.deepEqual(asImplement({ done: true, summary: "x", aboutOthers: [{ item: "2", questions: [ABOUT_Q], rewrite: "no" }, { item: "3", questions: [] }, { item: "4", questions: [{ ...ABOUT_Q, question: "a</question>b" }] }] })?.aboutOthers, [{ item: "2", questions: [ABOUT_Q] }]);
  assert.deepEqual(asTriage({ ...TRIAGE_OK, aboutOthers: [{ item: " #5 ", questions: [], rewrite: " D " }] })?.aboutOthers, [{ item: "#5", questions: [], rewrite: "D" }]);
});

test("on GitHub the other Item's rewrite and question are posted there, the agent's text made inert", async () => {
  const w = world(config(), [ghItem("1"), ghItem("2", { body: "Wind units." })]);
  w.store.addUsageSample(usage(0.1, 0.1));
  const fake = fakeIssues("harbour/tides", [1, 2]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  const real = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config(), store: w.store });
  const deps = w.depsFor();
  deps.actions.askQuestions = real.askQuestions;
  deps.actions.postRewrite = real.postRewrite;
  deps.actions.checkRewrite = real.checkRewrite;
  await tick(deps);
  assert.deepEqual(roles(w), ["triage"]);
  w.runner.end("1", "succeeded", { ...TRIAGE_OK, aboutOthers: [{ item: "2", questions: [{ ...ABOUT_Q, question: "Fixes #3 too? Ask @ada." }], rewrite: "Closes #4. Show knots." }] });
  await tick(deps);
  const comments = (fake.comments.get("2") ?? []).map((comment) => comment.body);
  assert.equal(comments.length, 2);
  const all = comments.join("\n");
  const zw = "​";
  assert.ok(all.includes(`F${zw}ixes #3 too? Ask @${zw}ada. (asked by triage of 1)`), all);
  assert.ok(all.includes(`C${zw}loses #4. Show knots.`), all);
  assert.ok(!/Fixes #3|@ada|Closes #4/.test(all), all);
  const parked = loadJobs(w.store)[ghKey("2")]?.parked;
  assert.equal(parked?.as, "needs-decision");
  assert.equal(parked?.rewrite?.questions.length, 1);
});

// --- a Jira project at level 2, end to end against the fake Jira: every host action is the real one ---

test("Jira at level 2: claimed in a property, a question comment answered by a person's A1: reply, implemented, merged and closed on Jira", async () => {
  const w = world(config({ level: 2, ...MERGES }));
  // The fake Jira and the host keep the world's clock.
  const jira = writable("cloud", { clock: w.clock });
  const made = await jira.write.createWork!({ title: "Tide table in metres", body: "Show metres.", verification: "The table says m." });
  w.store.put((await jira.host.work.getWork(made.work))!, "sync", new Date(w.clock.ms).toISOString());
  w.queue = fakeQueue();
  w.store.addUsageSample(usage(0.1, 0.1));
  const deps = w.depsFor();
  deps.actions = createHostActions({ host: jira.host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config({ level: 2, ...MERGES }), store: w.store });
  const key = refKey(made.work);
  const sync = async (): Promise<void> => {
    const item = await jira.host.work.getWork(made.work);
    if (item) w.store.put(item, "sync", new Date(w.clock.ms).toISOString());
  };
  const claimOf = () => jira.fake.issueProperties[made.work.id]?.["scopesoup.claim"] as { claims: { machine: string }[] } | undefined;

  await tick(deps);
  assert.deepEqual(roles(w), ["triage"]);
  assert.deepEqual(claimOf()?.claims.map((each) => each.machine), ["laptop-a"]);
  assert.equal(w.store.get<WorkItem>(made.work)?.holder?.actor.id, "scopesoup@laptop-a");

  // The triage asks: one question comment with its property, and the needs-decision label.
  w.runner.end(made.work.id, "succeeded", { ...TRIAGE_OK, hidesDecision: true, decision: { question: "Round up or down?", options: ["up", "down"], recommendation: "down" } });
  await tick(deps);
  assert.equal(loadJobs(w.store)[key]?.parked?.as, "needs-decision");
  const comments = jira.fake.comments[made.work.id] ?? [];
  assert.equal(comments.length, 1);
  assert.equal((jira.fake.commentProperties[comments[0]!.id]?.scopesoup as { kind: string }).kind, "question");
  assert.ok(jira.fake.issues.get(made.work.id)!.fields.labels?.includes("scopesoup-needs-decision"));

  // A person answers on Jira itself; the next sync reads it and the triage runs again with the answer.
  jira.fake.comments[made.work.id]!.push({ id: "99001", author: jira.person, created: "2026-11-18T10:05:00.000+0000", body: { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A1: down" }] }] } });
  await sync();
  await tick(deps);
  assert.equal(loadJobs(w.store)[key]?.parked, undefined);
  assert.deepEqual(roles(w), ["triage", "triage"]);
  assert.equal(jira.fake.issues.get(made.work.id)!.fields.labels?.includes("scopesoup-needs-decision"), false);

  // Ready now: implemented, merged by the session at level 2, and closed on Jira with the merged property.
  const next = async (output: unknown): Promise<void> => {
    w.runner.end(made.work.id, "succeeded", output);
    await tick(deps);
    w.clock.ms += 1000;
    await tick(deps);
  };
  await next(TRIAGE_OK);
  assert.deepEqual(roles(w), ["triage", "triage", "implement"]);
  assert.deepEqual(claimOf()?.claims.map((each) => each.machine), ["laptop-a"]);
  await next(IMPLEMENT_OK);
  assert.match(w.reasons("orchestrator.merged")[0] ?? "", /The implementing session merged it/);
  const closed = jira.fake.issues.get(made.work.id)!;
  assert.deepEqual([closed.fields.status?.name, closed.fields.resolution?.name], ["Done", "Done"]);
  const merged = Object.values(jira.fake.commentProperties).map((each) => each.scopesoup as { kind?: string; sha?: string }).find((each) => each?.kind === "merged");
  assert.equal(merged?.sha, HEAD);
  // The session lines went to the log property, never a comment.
  const log = jira.fake.issueProperties[made.work.id]?.["scopesoup.log"] as { lines: { kind: string }[] } | undefined;
  assert.ok(log?.lines.some((line) => line.kind === "session"), JSON.stringify(log));
  await sync();
  assert.equal(w.store.get<WorkItem>(made.work)?.state, "done");
});

test("a job a person put back in the backlog on the board is dropped once its session is over, with this machine's claim and workspace", async () => {
  const w = world(config({ level: 2 }), [item("1")]);
  w.claims = true;
  w.claimant = "scopesoup@here";
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  assert.deepEqual(roles(w), ["triage"]);
  // The person's move (src/server/moves.ts) only marks the job; the triage session still runs.
  const jobs = loadJobs(w.store);
  jobs[refKey(ref("1"))]!.dropAskedBy = "Ada";
  saveJobs(w.store, jobs);
  w.store.put(item("1", { holder: { actor: { id: "scopesoup@here", name: "here", bot: true }, until: "2099-01-01T00:00:00Z" } }), "sync", new Date(w.clock.ms).toISOString());
  await w.run();
  assert.ok(w.job("1"), "kept while its session runs");
  w.runner.end("1", "succeeded", TRIAGE_OK);
  await w.run();
  assert.equal(w.job("1"), undefined);
  assert.match(w.reasons("orchestrator.job_dropped")[0] ?? "", /Ada put 1 back in the backlog/);
  assert.ok(w.calls.includes("release 1"), w.calls.join("\n"));
  assert.ok(w.runner.released.includes(workspaceKey(ref("1"))));
});

// --- A person's picks on the board (decision 104): at any level, ending the running session at once ---

/** A job at the review step with a revision, as a person's In review leaves it (src/server/moves.ts). */
const pickedReview = (id: string, over: Record<string, unknown> = {}) => ({
  item: ref(id), workspace: workspaceKey(ref(id)), branch: `scopesoup/${id}`, step: "review" as const, failures: 0, fixRounds: 0,
  startedAt: new Date(T0).toISOString(), head: HEAD, reviewAskedBy: "Ada", ...over,
});

test("a review step a person picked runs below level 3, even at level 0 with its hidden switch paused; only Stop holds it", async () => {
  for (const level of [0, 1, 2]) {
    const w = world(config({ level }), [item("1"), item("2")]);
    w.store.addUsageSample(usage(0.1, 0.1));
    // After a start-up every switch is paused; at these levels the board shows no Review switch.
    applyControl(w.store, "pause", new Date(T0).toISOString(), "test");
    saveJobs(w.store, { [refKey(ref("1"))]: pickedReview("1"), [refKey(ref("2"))]: pickedReview("2", { reviewAskedBy: undefined }) });
    await w.run();
    assert.deepEqual(w.runner.requests.map((request) => `${request.role} ${request.subject.id}`), ["review 1"], `level ${level}: only the review a person asked for`);
    // Its settling clears the ask: what comes next goes as the level says.
    w.runner.end("1", "succeeded", REVIEW_OK);
    await w.run();
    assert.equal(w.job("1")?.reviewAskedBy, undefined);
    assert.equal(w.job("1")?.reviewedHead, HEAD);
  }
  const stopped = world(config({ level: 2 }), [item("1")]);
  stopped.store.addUsageSample(usage(0.1, 0.1));
  applyControl(stopped.store, "stop", new Date(T0).toISOString(), "test");
  saveJobs(stopped.store, { [refKey(ref("1"))]: pickedReview("1") });
  await stopped.run();
  assert.deepEqual(roles(stopped), [], "Stop in force holds it");
});

test("a change a person handed to the merge queue below level 4 goes to the queue, with the hidden switch paused", async () => {
  const queue = fakeQueue();
  const w = world(config({ level: 2, ...MERGES }), [item("1")]);
  w.queue = queue;
  applyControl(w.store, "merge-queue.pause" as ControlAction, new Date(T0).toISOString(), "test");
  saveJobs(w.store, { [refKey(ref("1"))]: pickedReview("1", { reviewAskedBy: undefined, reviewedHead: HEAD, review: { verdict: "approve", findings: [] }, owes: "hand-over", owesAskedBy: "Ada", queueAskedBy: "Ada" }) });
  await w.run();
  assert.deepEqual(queue.enqueued, ["1 scopesoup/1"]);
  assert.equal(w.job("1")?.parked?.as, "queued");
  // Without the person's ask, the same job at level 2 is the implementor's to merge: nothing goes to the queue.
  const own = fakeQueue();
  const v = world(config({ level: 2, ...MERGES }), [item("1")]);
  v.queue = own;
  saveJobs(v.store, { [refKey(ref("1"))]: pickedReview("1", { reviewAskedBy: undefined, reviewedHead: HEAD, review: { verdict: "approve", findings: [] }, owes: "hand-over" }) });
  await v.run();
  assert.deepEqual(own.enqueued, []);
});

test("a pick that replaces the running step ends its session at once, as Stop does, and its result is not settled", async () => {
  const w = world(config({ level: 2 }), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  w.runner.end("1", "succeeded", TRIAGE_OK);
  await w.run();
  w.clock.ms += 5_000;
  await w.run();
  assert.deepEqual(roles(w), ["triage", "implement"]);
  // The person's In review (src/server/moves.ts) over the running implementor.
  const jobs = loadJobs(w.store);
  const key = refKey(ref("1"));
  Object.assign(jobs[key]!, { step: "review", head: HEAD, reviewAskedBy: "Ada", interrupt: { by: "Ada", at: new Date(T0).toISOString(), to: "in-review" } });
  saveJobs(w.store, jobs);
  await w.run();
  assert.match(w.runner.stops[0] ?? "", /^Stopped: Ada picked In review for 1 on the board: the implement session s2 is ended now/);
  const event = w.events("orchestrator.stopped").at(-1);
  assert.deepEqual([event?.subject, (event?.data as Record<string, unknown>).by, (event?.data as Record<string, unknown>).session], [key, "Ada", "s2"]);
  await w.run();
  // The ended implementor is not settled (no failure counted, no build); the review the person asked for starts.
  assert.deepEqual(roles(w), ["triage", "implement", "review"]);
  assert.equal(w.job("1")?.failures, 0);
  assert.equal(w.job("1")?.interrupt, undefined);
});

test("a pick made while the tick prepares a session's start wins: nothing starts, and the pick is carried out", async () => {
  const w = world(config({ level: 2 }), [item("1")]);
  w.store.addUsageSample(usage(0.1, 0.1));
  await w.run();
  w.runner.end("1", "succeeded", TRIAGE_OK);
  await w.run();
  w.clock.ms += 5_000;
  const key = refKey(ref("1"));
  const take = w.runner.takeWorkspace;
  // The person's Backlog arrives while the implement step's workspace is prepared.
  w.runner.takeWorkspace = async (...args) => {
    const jobs = loadJobs(w.store);
    if (jobs[key]) jobs[key]!.dropAskedBy = "Ada";
    saveJobs(w.store, jobs);
    return take(...args);
  };
  await w.run();
  assert.deepEqual(roles(w), ["triage"]);
  w.runner.takeWorkspace = take;
  await w.run();
  // Dropped, and started again from triage, as Backlog says.
  assert.deepEqual(roles(w), ["triage", "triage"]);
  assert.match(w.reasons("orchestrator.job_dropped")[0] ?? "", /Ada put 1 back in the backlog/);
});
