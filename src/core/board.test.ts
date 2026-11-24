import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch } from "../model/types.ts";
import { bisectState } from "./bisect.ts";
import { buildBoard } from "./board.ts";
import { buildItemList } from "./item-list.ts";
import { buildItemPage } from "./item-page.ts";
import type { Snapshot } from "./snapshot.ts";
import { toStatusView } from "./status.ts";
import { at, batch, change, member, passed, ref, run, session, snapshot, T0, verdict, work } from "./testing.ts";

const now = new Date(T0);
const approved = { verdicts: [verdict("review", "pass")] };

function sample(): Snapshot {
  const suite = run("suite", { status: "running", startedAt: at(-4), runner: "laptop" });
  const probe = run("probe", { status: "running", startedAt: at(-2) });
  const red = run("red", { status: "failed", startedAt: at(-30), finishedAt: at(-22) });
  return snapshot({
    works: [
      work(1, { title: "Ready" }),
      work(2, { title: "Blocked", blockedBy: [ref("work", 3)] }),
      work(3, { title: "Decide", needsDecision: true, updatedAt: at(-60) }),
      work(4, { title: "Being built", state: "doing" }),
      work(5, { title: "Re-review" }),
      work(6, { title: "Queued" }),
      work(7, { title: "Tested A" }),
      work(8, { title: "Tested B" }),
      work(9, { title: "Bisect A" }),
      work(10, { title: "Bisect B" }),
      work(11, { title: "Bisect C" }),
      work(12, { title: "Finished", state: "done" }),
      work(13, { title: "Dropped", state: "abandoned" }),
    ],
    changes: [
      change(40, [4], { draft: true }),
      change(50, [5], { verdicts: [verdict("review", "pass", { stale: true })], updatedAt: at(-20), ref: { ...ref("change", 50), url: "https://host.example/c/50" } }),
      change(60, [6], approved),
      change(70, [7], approved),
      change(80, [8], approved),
      change(90, [9], approved),
      change(100, [10], approved),
      change(110, [11], approved),
    ],
    runs: [suite, probe, red, passed("h1", 6, at(-100)), passed("h2", 10, at(-200))],
    batches: [
      batch(6, [member(70), member(80)], { runs: [suite.ref], startedAt: at(-4) }),
      batch(5, [member(90), member(100), member(110)], {
        status: "bisecting",
        runs: [red.ref],
        startedAt: at(-30),
        suspect: ref("change", 100),
        probes: [{ prefix: 1, status: "passed" }, { prefix: 2, status: "running", run: probe.ref }],
      }),
    ],
    sessions: [
      session("s1", ref("work", 4), { model: "opus", lastAction: "writing tests", startedAt: at(-14) }),
      session("s0", ref("work", 4), { status: "failed", startedAt: at(-90), finishedAt: at(-80), endReason: "turn limit" }),
    ],
    runners: [{ id: "r1", name: "laptop", online: true, busy: true, labels: [], current: suite.ref }],
    usage: { at: at(-1), status: "allowed", windows: [{ kind: "five_hour", utilization: 0.62, resetsAt: at(190) }, { kind: "seven_day", utilization: 0.31, resetsAt: at(4000) }] },
    sync: { lastAt: at(-1) },
  });
}

test("the bisect state: green prefix, red prefix, the culprit once one is left", () => {
  const members = [member(1), member(2), member(3), member(4)];
  const none = bisectState(batch(1, members, { status: "bisecting" }));
  assert.deepEqual([none.goodPrefix, none.badPrefix, none.marks], [0, 4, ["in-doubt", "in-doubt", "in-doubt", "in-doubt"]]);
  const mid = bisectState(batch(1, members, { status: "bisecting", probes: [{ prefix: 2, status: "passed" }, { prefix: 3, status: "running" }] }));
  assert.deepEqual(mid.marks, ["good", "good", "in-doubt", "in-doubt"]);
  assert.equal(mid.culprit, undefined);
  const found = bisectState(batch(1, members, { status: "bisecting", probes: [{ prefix: 2, status: "passed" }, { prefix: 3, status: "failed" }] }));
  assert.deepEqual(found.marks, ["good", "good", "culprit", "untested"]);
  assert.equal(found.culprit?.id, "3");
  const flaky = bisectState(batch(1, members, { status: "bisecting", probes: [{ prefix: 2, status: "passed" }, { prefix: 1, status: "failed" }] }));
  assert.deepEqual([flaky.goodPrefix, flaky.badPrefix], [2, 4]);
});

test("the board puts every item in its lane, hides abandoned ones, and gives every card a reason", () => {
  const board = buildBoard(sample(), now);
  const lanes = Object.fromEntries(board.lanes.map((lane) => [lane.lane, lane.cards.map((card) => card.label)]));
  assert.deepEqual(lanes, {
    blocked: ["#2"],
    backlog: ["#3", "#1"],
    "in-progress": ["#4"],
    "in-review": ["#5"],
    queued: ["#6"],
    checking: ["#10", "#7", "#8", "#9", "#11"],
    done: ["#12"],
  });
  for (const lane of board.lanes) for (const card of lane.cards) assert.ok(card.reason.length > 0, card.label);
  assert.equal(board.now, T0);
});

test("a card carries its change, its live session with last action and model, and its batch", () => {
  const board = buildBoard(sample(), now);
  const cards = new Map(board.lanes.flatMap((lane) => lane.cards).map((card) => [card.label, card]));
  const built = cards.get("#4")!;
  assert.equal(built.session?.ref.id, "s1");
  assert.deepEqual([built.session?.model, built.session?.lastAction, built.session?.live], ["opus", "writing tests", true]);
  assert.equal(built.change?.draft, true);
  assert.equal(built.tone, "moving");
  assert.equal(cards.get("#5")!.change?.url, "https://host.example/c/50");
  assert.deepEqual(cards.get("#7")!.batch, { ref: ref("batch", 6, "scopesoup"), name: "batch 6", status: "testing" });
  assert.equal(cards.get("#2")!.tone, "blocked");
});

test("the your-turn list is a person's, ordered by what it unblocks", () => {
  const board = buildBoard(sample(), now);
  assert.deepEqual(board.yourTurn.map((card) => [card.label, card.unblocks, card.reason]), [
    ["#3", 1, "Answer the question: the item needs a decision"],
  ]);
});

test("batches are boxes: members in chain order, one progress, the bisect with its probes and suspect", () => {
  const { queue } = buildBoard(sample(), now);
  assert.deepEqual(queue.batches.map((each) => each.name), ["batch 5", "batch 6"]);
  const [bisecting, testing] = queue.batches;
  assert.deepEqual(testing!.members.map((each) => [each.items[0]?.label, each.items[0]?.title, each.state]), [["#7", "Tested A", "testing"], ["#8", "Tested B", "testing"]]);
  assert.deepEqual([testing!.progress.state, testing!.progress.fraction, testing!.progress.estimateMs], ["running", 0.5, 8 * 60_000]);
  assert.equal(testing!.words, "checking: 4 min of ~8 min");
  assert.equal(testing!.bisect, undefined);

  assert.deepEqual(bisecting!.members.map((each) => [each.items[0]?.label, each.mark, each.suspect]), [["#9", "good", false], ["#10", "in-doubt", true], ["#11", "in-doubt", false]]);
  assert.deepEqual(bisecting!.bisect?.probes.map((each) => each.words), ["first 1 of 3: passed", "first 2 of 3: 2 min of ~8 min"]);
  assert.equal(bisecting!.bisect?.probes[1]?.progress?.fraction, 0.25);
  assert.equal(bisecting!.words, "failed; bisecting: the culprit is among #10 and #11");
  assert.deepEqual(queue.waiting.map((each) => [each.position, each.items[0]?.label]), [[1, "#6"]]);
  assert.deepEqual([queue.forming, queue.recent], [[], []]);
});

test("the status line: runners and since when, usage windows, queue, pause, sync, alerts", () => {
  const board = buildBoard(sample(), now);
  const { status } = board;
  assert.deepEqual(status.runners, { online: 1, busy: 1, total: 1, list: [{ id: "r1", name: "laptop", online: true, busy: true, words: "online, busy 4 min", since: at(-4) }] });
  assert.deepEqual(status.usage?.windows, [
    { kind: "five_hour", label: "5 h", utilization: 0.62, resetsAt: at(190) },
    { kind: "seven_day", label: "week", utilization: 0.31, resetsAt: at(4000) },
  ]);
  assert.deepEqual(status.queue, { waiting: 1, forming: 0, testing: 1, bisecting: 1 });
  assert.deepEqual([status.paused, status.sync, status.alerts], [false, { lastAt: at(-1) }, []]);

  const away = buildBoard({ ...sample(), paused: true, sync: { lastAt: at(-9), error: "host unreachable" }, runners: [{ id: "r1", name: "laptop", online: false, busy: false, labels: [], since: at(-120) }] }, now);
  assert.equal(away.status.runners.list[0]?.words, "away for 2 h");
  assert.equal(away.status.paused, true);
  assert.deepEqual(away.status.alerts, ["No runner is online and work is waiting for one.", "The last sync failed: host unreachable"]);
});

test("the status line carries the orchestrator's idle reason, and none when it is absent", () => {
  assert.equal("idle" in buildBoard(sample(), now).status, false);
  const idle = buildBoard({ ...sample(), idle: "Nothing was started because the stop switch is on." }, now);
  assert.equal(idle.status.idle, "Nothing was started because the stop switch is on.");
});

test("the compact status mirrors the board", () => {
  const status = toStatusView(buildBoard(sample(), now));
  assert.deepEqual(status.lanes, { blocked: 1, backlog: 2, "in-progress": 1, "in-review": 1, queued: 1, checking: 5, done: 1 });
  assert.deepEqual(status.yourTurn.map((each) => each.ref), ["demo:work:3"]);
  assert.deepEqual(status.batches[1], { name: "batch 6", status: "testing", words: "checking: 4 min of ~8 min", members: ["#7", "#8"], progress: "4 min of ~8 min" });
  assert.equal(status.runners[0]?.words, "online, busy 4 min");
});

test("the item page: text, decision, changes with verdicts and diff link, runs, batch, sessions", () => {
  const snap = sample();
  assert.equal(buildItemPage(snap, "demo:work:999", now), null);
  const built = buildItemPage(snap, ref("work", 4), now)!;
  assert.deepEqual([built.item.label, built.lane, built.actor], ["#4", "in-progress", "agent"]);
  assert.deepEqual(built.sessions.live.map((each) => each.ref.id), ["s1"]);
  assert.deepEqual(built.sessions.finished.map((each) => [each.ref.id, each.endReason]), [["s0", "turn limit"]]);

  const review = buildItemPage(snap, "demo:work:5", now)!;
  assert.deepEqual([review.changes[0]?.url, review.changes[0]?.verdicts[0]?.value, review.changes[0]?.sha], ["https://host.example/c/50", "pass", "sha-50"]);
  assert.equal(review.actor, "agent");

  const decide = buildItemPage(snap, "demo:work:3", now)!;
  assert.equal(decide.decision.needed, true);
  assert.deepEqual(decide.blocks.map((each) => each.label), ["#2"]);
  assert.deepEqual(buildItemPage(snap, "demo:work:2", now)!.blockedBy.map((each) => [each.label, each.open]), [["#3", true]]);

  const tested = buildItemPage(snap, "demo:work:10", now)!;
  assert.deepEqual(tested.batches.map((each) => [each.batch.name, each.memberState, each.position]), [["batch 5", "testing", 2]]);
  assert.deepEqual(tested.runs.map((each) => [each.ref.id, each.status]), [["probe", "running"], ["red", "failed"]]);
  assert.equal(tested.runs[0]?.progress.fraction, 0.25);
});

test("a batch whose only run passed is not drawn as a bisect", () => {
  const ref = (kind: "batch" | "change", id: string) => ({ host: "fake", kind, id });
  const batch: Batch = {
    ref: ref("batch", "1"),
    status: "merged",
    base: "b0",
    members: [{ change: ref("change", "7"), sha: "s7", state: "merged" }],
    runs: [],
    probes: [{ prefix: 1, status: "passed" }],
  };
  const board = buildBoard({ works: [], changes: [], runs: [], batches: [batch], sessions: [], runners: [], usage: null, paused: false, agents: "started", triage: "started", implement: "started", review: "started", mergeQueue: "started", sync: {} }, new Date("2026-01-01T00:00:00Z"));
  const shown = [...board.queue.batches, ...board.queue.recent][0];
  assert.ok(shown);
  assert.equal(shown.bisect, undefined);
});

test("a queue member the host has no change object for shows its item's title, not (not synced)", () => {
  const snap = snapshot({
    works: [work(7, { title: "Seven" })],
    batches: [batch(3, [{ change: ref("work", 7), sha: "sha-7", state: "waiting" }])],
  });
  const view = buildBoard(snap, now).queue.batches[0];
  assert.equal(view?.members[0]?.change.title, "Seven");
  assert.equal(view?.members[0]?.items[0]?.title, "Seven");
  const unknown = buildBoard(snapshot({ batches: [batch(3, [{ change: ref("work", 8), sha: "sha-8", state: "waiting" }])] }), now).queue.batches[0];
  assert.equal(unknown?.members[0]?.change.title, "(not synced)");
});

test("the queue's pause, flakes and problems reach the queue view and the status line alerts", () => {
  const health = {
    paused: { reason: "The host refused the push.", at: at(-5) },
    notes: [
      { at: at(-30), kind: "flake" as const, text: "test/a.test.js failed and passed on a rerun." },
      { at: at(-10), kind: "problem" as const, text: "The main branch moved without the queue." },
    ],
  };
  const board = buildBoard({ ...snapshot({}), queue: health }, now);
  assert.deepEqual(board.queue.health?.notes.map((n) => n.kind), ["flake", "problem"]);
  assert.ok(board.status.alerts.some((a) => /merge queue is paused: The host refused the push\. Resume it on the Queue page/.test(a)), board.status.alerts.join("|"));
  const running = buildBoard({ ...snapshot({}), queue: { notes: health.notes } }, now);
  assert.ok(running.status.alerts.some((a) => /reported a problem: The main branch moved/.test(a)));
  assert.ok(!running.status.alerts.some((a) => /rerun/.test(a)), "a flake is on the Queue page, not an alert");
  const old = buildBoard({ ...snapshot({}), queue: { notes: [{ at: at(-60 * 30), kind: "problem" as const, text: "old" }] } }, now);
  assert.deepEqual(old.status.alerts, []);
  assert.equal(buildBoard(snapshot({}), now).queue.health, undefined);
});

test("an umbrella item with open children takes no number in the plan", () => {
  const snap = snapshot({ works: [work(1, { title: "Umbrella", openChildren: 2 }), work(2, { title: "First" }), work(3, { title: "Second" })] });
  const order = snap.works.map((item) => `${item.ref.host}:${item.ref.kind}:${item.ref.id}`);
  const cards = buildBoard(snap, now, order).lanes.find((lane) => lane.lane === "backlog")?.cards ?? [];
  assert.equal(cards.find((card) => card.title === "Umbrella")?.position, undefined);
  assert.deepEqual(cards.filter((card) => card.title !== "Umbrella").map((card) => card.position), [1, 2]);
});

test("every todo card takes a number in the plan, whatever its labels: there is no invite label", () => {
  const snap = snapshot({ works: [work(1, { title: "Plain" }), work(2, { title: "Labelled", labels: ["scopesoup"] })] });
  const order = snap.works.map((item) => `${item.ref.host}:${item.ref.kind}:${item.ref.id}`);
  const cards = buildBoard(snap, now, order).lanes.find((lane) => lane.lane === "backlog")?.cards ?? [];
  assert.deepEqual(cards.map((card) => card.position), [1, 2]);
  assert.ok(cards.every((card) => card.reason.startsWith("ready")));
});

test("a person's turn on the board: theirs is yours, another person's names them and is not coloured as yours", () => {
  const far = "2036-03-02T10:00:00.000Z";
  const board = buildBoard(snapshot({ works: [work(1, { holder: { actor: { id: "alice@a", name: "alice on a" }, until: far } }), work(2, { holder: { actor: { id: "bob@b", name: "bob on b" }, until: far } })] }), now, undefined, { person: "alice", machine: "a" });
  const cards = board.lanes.flatMap((lane) => lane.cards);
  const one = cards.find((card) => card.label === "#1")!;
  const two = cards.find((card) => card.label === "#2")!;
  assert.deepEqual([one.actor, one.person, one.tone], ["person", { name: "alice", mine: true }, "yours"]);
  assert.deepEqual([two.actor, two.person, two.tone], ["person", { name: "bob", mine: false }, "waiting"]);
  assert.deepEqual(board.yourTurn.map((card) => card.label), ["#1"]);
  // Scope Soup never starts an item a person holds, so the backlog gives it no number.
  const planned = buildBoard(snapshot({ works: [work(1, { holder: { actor: { id: "alice@a", name: "alice on a" } } }), work(2)] }), now, ["demo:work:2", "demo:work:1"]);
  assert.deepEqual(planned.lanes.find((lane) => lane.lane === "backlog")!.cards.map((card) => [card.label, card.position]), [["#2", 1], ["#1", undefined]]);
});

test("the item page names whose turn it is", () => {
  const snap = snapshot({ works: [work(1, { holder: { actor: { id: "bob@b", name: "bob on b" } } })] });
  assert.deepEqual(buildItemPage(snap, ref("work", 1), now, undefined, { person: "alice", machine: "a" })?.person, { name: "bob", mine: false });
  assert.deepEqual(buildItemPage(snap, ref("work", 1), now, undefined, { person: "bob", machine: "b" })?.person, { name: "bob", mine: true });
});

test("the item page and the item list say a waiting Item waits for a paused triage", () => {
  const snap = { ...snapshot({ works: [work(1), work(2)] }), triage: "paused" as const };
  const notTriaged = new Set(["demo:work:1"]);
  const words = "ready, but triage is paused (Resume on Backlog)";
  assert.equal(buildItemPage(snap, "demo:work:1", now, undefined, undefined, notTriaged)!.reason, words);
  assert.equal(buildItemPage(snap, "demo:work:1", now)!.reason, "ready; waiting for a free agent slot");
  const list = buildItemList(snap, {}, now, undefined, notTriaged);
  assert.deepEqual(list.items.map((row) => [row.label, row.reason]).sort(), [["#1", words], ["#2", "ready; waiting for a free agent slot"]]);
});

test("the item page lists the implementor's decisions oldest first, open and answered alike; the same time goes by id", () => {
  const decision = (id: string, minutes: number, accepted?: true) => ({
    id, at: at(minutes), question: `Q ${id}?`, chosen: "x", others: [], why: "",
    ...(accepted ? { settled: { verdict: "accepted" as const, at: at(minutes + 1), by: "robin" } } : {}),
  });
  // Two open ones minutes old, listed first in the Item, and three answered hours ago.
  const item = work(1, { state: "doing", assumptions: [decision("new-b", -5), decision("new-a", -5), decision("old-3", -180, true), decision("old-1", -240, true), decision("old-2", -200, true)] });
  const page = buildItemPage(snapshot({ works: [item] }), ref("work", 1), now)!;
  assert.deepEqual(page.assumptions.map((each) => each.id), ["old-1", "old-2", "old-3", "new-a", "new-b"]);
});
