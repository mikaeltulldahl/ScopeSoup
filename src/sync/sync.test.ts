import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch, Change, Ref, Run, Runner, WorkItem } from "../model/types.ts";
import type { Host, HostEvent, Page } from "../ports/host.ts";
import { openStore } from "../store/store.ts";
import { loadSnapshot } from "../server/snapshot.ts";
import { createSync } from "./sync.ts";
import { cursorKey, lastOkKey, runnersKey } from "./syncHost.ts";

const ref = (kind: Ref["kind"], id: string): Ref => ({ host: "fake", kind, id });

const work = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  ref: ref("work", id),
  title: `Item ${id}`,
  state: "todo",
  hostState: "open",
  labels: [],
  blockedBy: [],
  openChildren: 0,
  updatedAt: "2026-11-16T09:00:00Z",
  ...over,
});

const change = (id: string, over: Partial<Change> = {}): Change => ({
  ref: ref("change", id),
  title: `Change ${id}`,
  author: { id: "robin", name: "robin" },
  state: "open",
  draft: false,
  target: "main",
  revisions: [{ id: "s", sha: "s", createdAt: "2026-11-16T09:00:00Z" }],
  verdicts: [],
  labels: [],
  works: [],
  updatedAt: "2026-11-16T09:00:00Z",
  ...over,
});

const run = (id: string, status: Run["status"], over: Partial<Run> = {}): Run => ({ ref: ref("run", id), pipeline: "Full suite", sha: `sha${id}`, status, ...over });

const batch = (id: string): Batch => ({ ref: ref("batch", id), status: "testing", base: "b", members: [], runs: [], probes: [] });

/** A host whose answers the test sets, and which records what it was asked. */
function fakeHost() {
  const state = {
    workPages: [] as Page<WorkItem>[],
    work: new Map<string, WorkItem>(),
    changePages: [] as Page<Change>[],
    changes: new Map<string, Change>(),
    active: [] as Run[],
    bySha: new Map<string, Run[]>(),
    recent: new Map<string, Run[]>(),
    runners: [] as Runner[],
    batches: [] as Batch[],
    asked: [] as string[],
    failWork: null as string | null,
    onWatch: null as ((event: HostEvent) => void) | null,
    unwatched: 0,
    gate: null as Promise<void> | null,
  };
  const host: Host = {
    info: { id: "fake", capabilities: new Set(["work", "changes", "ci", "runners", "batches"]), whoami: async () => ({ id: "me", name: "me" }) },
    work: {
      async listWork(since) {
        state.asked.push(`listWork ${since ?? "-"}`);
        if (state.gate) await state.gate;
        if (state.failWork) throw new Error(state.failWork);
        return state.workPages.shift() ?? { items: [], cursor: since ?? "c0", unchanged: true };
      },
      async getWork(itemRef) {
        state.asked.push(`getWork ${itemRef.id}`);
        return state.work.get(itemRef.id) ?? null;
      },
    },
    changes: {
      async listChanges(since) {
        state.asked.push(`listChanges ${since ?? "-"}`);
        return state.changePages.shift() ?? { items: [], cursor: since ?? "c0", unchanged: true };
      },
      getChange: async (changeRef) => state.changes.get(changeRef.id) ?? null,
    },
    ci: {
      runsFor: async (sha) => {
        state.asked.push(`runsFor ${sha}`);
        return state.bySha.get(sha) ?? [];
      },
      recentRuns: async (pipeline, limit) => {
        state.asked.push(`recentRuns ${pipeline} ${limit}`);
        return state.recent.get(pipeline) ?? [];
      },
      activeRuns: async () => state.active,
      runners: async () => state.runners,
    },
    batches: { listBatches: async (limit) => state.batches.slice(0, limit) },
    watch: {
      async watch(onEvent) {
        state.onWatch = onEvent;
        return () => void state.unwatched++;
      },
    },
  };
  return { host, state };
}

function setup(over: Partial<Parameters<typeof createSync>[0]> = {}) {
  const store = openStore(":memory:");
  const fake = fakeHost();
  let clock = Date.parse("2026-11-16T10:00:00Z");
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const sync = createSync({
    store,
    hosts: [fake.host],
    intervalMs: 1000,
    now: () => new Date((clock += 1000)),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    recentLimit: 5,
    ...over,
  });
  const kinds = (after = 0) => store.eventsAfter(after, 1000).map((event) => event.kind);
  return { store, sync, timers, kinds, ...fake };
}

test("a cycle pulls work, changes, runs, runners and batches into the store, as actor sync", async () => {
  const t = setup({ pipelines: ["Light check"] });
  t.state.workPages.push({ items: [work("1"), work("2")], cursor: "w1" });
  t.state.changePages.push({ items: [change("7")], cursor: "c1" });
  t.state.active = [run("31", "running")];
  t.state.recent.set("Full suite", [run("30", "passed"), run("29", "failed")]);
  t.state.runners = [{ id: "b", name: "box-2", online: false, busy: false, labels: [] }, { id: "a", name: "box-1", online: true, busy: true, labels: [] }];
  t.state.batches = [batch("4"), batch("3")];
  await t.sync.refreshNow();

  assert.deepEqual(t.store.list<WorkItem>("work", "fake").map((item) => item.ref.id), ["1", "2"]);
  assert.deepEqual(t.store.get<Change>(ref("change", "7"))?.title, "Change 7");
  assert.deepEqual(t.store.list<Run>("run").map((stored) => stored.ref.id), ["29", "30", "31"]);
  assert.deepEqual(t.store.list<Batch>("batch").map((stored) => stored.ref.id), ["3", "4"]);
  assert.equal(t.store.getValue(cursorKey("fake", "work")), "w1");
  assert.equal(t.store.getValue(cursorKey("fake", "changes")), "c1");
  assert.ok(t.store.getValue(lastOkKey("fake")));
  assert.deepEqual((JSON.parse(t.store.getValue(runnersKey("fake")) ?? "[]") as Runner[]).map((runner) => runner.id), ["a", "b"]);
  assert.ok(t.state.asked.includes("recentRuns Light check 5") && t.state.asked.includes("recentRuns Full suite 5"));
  const events = t.store.eventsAfter(0, 100);
  assert.ok(events.every((event) => event.actor === "sync"));
  assert.equal(events.filter((event) => event.kind === "runner.updated").length, 1);
  assert.ok(!t.kinds().includes("sync.failed"));
});

test("the next cycle passes the cursors on, and an unchanged host writes no events", async () => {
  const t = setup();
  t.state.workPages.push({ items: [work("1")], cursor: "w1" });
  t.state.runners = [{ id: "a", name: "box-1", online: true, busy: false, labels: [] }];
  await t.sync.refreshNow();
  const seq = t.store.lastSeq();
  t.state.asked.length = 0;
  await t.sync.refreshNow();
  assert.deepEqual(t.state.asked.slice(0, 2), ["listWork w1", "listChanges c0"]);
  assert.equal(t.store.lastSeq(), seq);

  t.state.runners = [{ id: "a", name: "box-1", online: true, busy: true, labels: [] }];
  await t.sync.refreshNow();
  assert.deepEqual(t.kinds(seq), ["runner.updated"]);
});

test("removes what the host says is gone", async () => {
  const t = setup();
  t.state.workPages.push({ items: [work("1"), work("2")], cursor: "w1" });
  t.state.changePages.push({ items: [change("7"), change("8")], cursor: "c1" });
  t.state.batches = [batch("4"), batch("3")];
  await t.sync.refreshNow();

  t.state.workPages.push({ items: [work("2", { state: "done" })], cursor: "w2", removed: [ref("work", "1")] });
  t.state.changePages.push({ items: [], cursor: "c2", removed: [ref("change", "8")] });
  t.state.batches = [batch("5"), batch("4")];
  const seq = t.store.lastSeq();
  await t.sync.refreshNow();
  assert.deepEqual(t.store.list<WorkItem>("work").map((item) => [item.ref.id, item.state]), [["2", "done"]]);
  assert.deepEqual(t.store.list<Change>("change").map((stored) => stored.ref.id), ["7"]);
  assert.deepEqual(t.store.list<Batch>("batch").map((stored) => stored.ref.id), ["4", "5"]);
  assert.deepEqual(t.kinds(seq).sort(), ["batch.created", "batch.removed", "change.removed", "work.removed", "work.updated"]);
});

test("a run that is no longer active gets its final state, and history beyond the window goes", async () => {
  const t = setup();
  t.state.active = [run("31", "running"), run("32", "queued")];
  t.state.recent.set("Full suite", [run("30", "passed"), run("29", "passed")]);
  await t.sync.refreshNow();

  t.state.active = [];
  t.state.bySha.set("sha31", [run("31", "failed")]);
  t.state.recent.set("Full suite", [run("31", "failed"), run("30", "passed")]);
  await t.sync.refreshNow();
  assert.ok(t.state.asked.includes("runsFor sha31") && t.state.asked.includes("runsFor sha32"));
  // 32 vanished at the host; 29 fell out of the recent window.
  assert.deepEqual(t.store.list<Run>("run").map((stored) => [stored.ref.id, stored.status]), [
    ["30", "passed"],
    ["31", "failed"],
  ]);
});

test("a full pass ignores the cursor and checks open objects the listing did not return", async () => {
  const t = setup({ fullEvery: 2 });
  t.state.workPages.push({ items: [work("1"), work("2"), work("3", { state: "done" })], cursor: "w1" });
  await t.sync.refreshNow();
  await t.sync.refreshNow();
  t.state.asked.length = 0;
  t.state.workPages.push({ items: [work("1")], cursor: "w3" });
  await t.sync.refreshNow();
  assert.deepEqual(t.state.asked.filter((asked) => asked.includes("Work")), ["listWork -", "getWork 2"]);
  assert.deepEqual(t.store.list<WorkItem>("work").map((item) => item.ref.id), ["1", "3"]);
  assert.equal(t.store.getValue(cursorKey("fake", "work")), "w3");
});

test("a failing part is recorded, the other parts still run, and the loop backs off", async () => {
  const t = setup({ maxBackoffMs: 3000 });
  t.state.failWork = "GitHub 502 on /issues: bad gateway";
  t.state.changePages.push({ items: [change("7")], cursor: "c1" });
  t.sync.start();
  await t.sync.refreshNow();

  const failed = t.store.eventsAfter(0, 100).filter((event) => event.kind === "sync.failed");
  assert.deepEqual(failed[0]?.data, { host: "fake", part: "work", error: "GitHub 502 on /issues: bad gateway" });
  assert.equal(t.store.list<Change>("change").length, 1);
  assert.equal(t.store.getValue(lastOkKey("fake")), null);
  assert.equal(t.store.getValue(cursorKey("fake", "work")), null);

  const delays: number[] = [];
  for (let round = 0; round < 3; round++) {
    const timer = t.timers.filter((candidate) => !candidate.cancelled).at(-1);
    assert.ok(timer);
    delays.push(timer.ms);
    timer.cancelled = true;
    timer.fn();
    await t.sync.refreshNow();
  }
  assert.deepEqual(delays, [3000, 3000, 3000]);
  assert.ok(failed.length >= 2);

  t.state.failWork = null;
  await t.sync.refreshNow();
  assert.equal(t.sync.nextDelayMs(), 1000);
  t.sync.stop();
});

test("the wait doubles per failed cycle", async () => {
  const t = setup();
  t.state.failWork = "down";
  const delays: number[] = [];
  for (let round = 0; round < 3; round++) {
    await t.sync.refreshNow();
    delays.push(t.sync.nextDelayMs());
  }
  assert.deepEqual(delays, [2000, 4000, 8000]);
});

test("refreshNow coalesces: callers during a cycle share the one that follows", async () => {
  const t = setup();
  let open: () => void = () => {};
  t.state.gate = new Promise<void>((resolve) => (open = resolve));
  const first = t.sync.refreshNow();
  const second = t.sync.refreshNow();
  const third = t.sync.refreshNow();
  assert.equal(second, third);
  assert.notEqual(first, second);
  open();
  t.state.gate = null;
  await Promise.all([first, second, third]);
  assert.equal(t.state.asked.filter((asked) => asked.startsWith("listWork")).length, 2);
});

test("start runs at once and then on the timer; a watch event refreshes; stop ends both", async () => {
  const t = setup();
  t.sync.start();
  await t.sync.refreshNow();
  const count = () => t.state.asked.filter((asked) => asked.startsWith("listWork")).length;
  const before = count();
  const timer = t.timers.filter((candidate) => !candidate.cancelled).at(-1);
  assert.equal(timer?.ms, 1000);
  timer?.fn();
  await t.sync.refreshNow();
  assert.ok(count() > before);

  const watched = count();
  t.state.onWatch?.({ at: "2026-11-16T10:00:00Z", hint: "work" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count(), watched + 1);

  t.sync.stop();
  assert.equal(t.state.unwatched, 1);
  assert.equal(t.timers.filter((candidate) => !candidate.cancelled).length, 0);
});

test("each cycle writes what the board reads: the runners as one list and how the sync went", async () => {
  const t = setup();
  t.state.runners = [{ id: "a", name: "box-1", online: true, busy: false, labels: [] }];
  await t.sync.refreshNow();
  assert.deepEqual(loadSnapshot(t.store).runners.map((runner) => runner.name), ["box-1"]);
  const good = loadSnapshot(t.store).sync;
  assert.ok(good.lastAt);
  assert.equal(good.error, undefined);

  t.state.failWork = "host is down";
  await t.sync.refreshNow();
  assert.deepEqual(loadSnapshot(t.store).sync, { lastAt: good.lastAt, error: "fake work: host is down" });
  t.sync.stop();
});
