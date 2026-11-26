import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBoard } from "../core/board.ts";
import { refKey } from "../model/types.ts";
import { ref, snapshot, T0, work } from "../core/testing.ts";
import { compareItems, planOrder, readyItems } from "./candidates.ts";

const now = new Date(T0);

// 1 older, 2 a bug, 3 blocked by open 9, 4 waits for an answer, 5 a bug blocked by 9, 9 itself ready.
const works = [
  work(1),
  work(2, { labels: ["bug"] }),
  work(3, { blockedBy: [ref("work", 9)] }),
  work(4, { needsDecision: true }),
  work(5, { labels: ["bug"], blockedBy: [ref("work", 9)] }),
  work(9),
];

test("planOrder: ready items in pick order, then held ones in the same order; without triages, oldest first", () => {
  const order = planOrder(works, [], {}, T0, ["bug"]).map((item) => item.ref.id);
  assert.deepEqual(order, ["1", "2", "9", "3", "4", "5"]);
});

test("compareItems: Items with a triage first (bugs ahead), then the rest by priority and age", () => {
  const triaged = { log: [{ at: new Date(T0).toISOString(), by: { who: "scopesoup", agent: true as const }, kind: "session" as const, fields: { role: "triage" } }] };
  const items = [work(1), work(2, { labels: ["bug"] }), work(3, { priority: "critical" }), work(4, { ...triaged }), work(5, { ...triaged, labels: ["bug"] }), work(6, { priority: "minor" })];
  assert.deepEqual([...items].sort(compareItems(["bug"], {}, items)).map((item) => item.ref.id), ["5", "4", "3", "1", "2", "6"]);
});

test("readyItems holds an umbrella and an all-parts-done item; labels do not matter", () => {
  const items = [work(1, { openChildren: 2, children: 2 }), work(2, { openChildren: 0, children: 2 }), work(3, { labels: ["go"] }), work(4, { labels: ["go"], openChildren: 1, children: 1 })];
  const { ready, held } = readyItems(items, [], {}, T0);
  assert.deepEqual(ready.map((item) => item.ref.id), ["3"]);
  assert.deepEqual(held.map((entry) => [entry.item.ref.id, entry.reason]), [
    ["1", "has 2 open child items"],
    ["2", "all its child items are done; waiting for a person to close it"],
    ["4", "has 1 open child item"],
  ]);
});

test("planOrder starts with exactly what the orchestrator would pick", () => {
  const readiness = readyItems(works, [], {}, T0);
  const picks = readiness.ready.sort(compareItems(["bug"], {}, works)).map((item) => item.ref.id);
  const planned = planOrder(works, [], {}, T0, ["bug"]).map((item) => item.ref.id);
  assert.deepEqual(planned.slice(0, picks.length), picks);
});

test("the backlog column follows the planned order and numbers its cards", () => {
  const snap = snapshot({ works });
  const keys = planOrder(snap.works, snap.changes, {}, T0, ["bug"]).map((item) => refKey(item.ref));
  const board = buildBoard(snap, now, keys);
  const backlog = board.lanes.find((lane) => lane.lane === "backlog")!;
  // 3 and 5 are blocked by 9, so they are in the Blocked lane, not in the numbered backlog.
  const blocked = board.lanes.find((lane) => lane.lane === "blocked")!;
  assert.deepEqual(blocked.cards.map((card) => card.label).sort(), ["#3", "#5"]);
  assert.deepEqual(backlog.cards.map((card) => card.key), keys.filter((key) => !blocked.cards.some((card) => card.key === key)));
  assert.deepEqual(backlog.cards.map((card) => card.label), ["#1", "#2", "#9", "#4"]);
  assert.deepEqual(backlog.cards.map((card) => card.position), [1, 2, 3, 4]);
  const other = board.lanes.find((lane) => lane.lane === "in-progress")!;
  assert.ok(other.cards.every((card) => card.position === undefined));
});
