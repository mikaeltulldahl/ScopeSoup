// The overview's Merge queue lane (web/src/mergeLane.ts): the core's Queued and Checking lanes as one. All names are synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BatchMemberView, BatchView, CardView, LaneView, WaitingView } from "./core/views.ts";
import { mergeLane, queueShown } from "../web/src/mergeLane.ts";

const item = (n: number) => ({ key: `demo:work:${n}`, label: `#${n}`, title: `Item ${n}` });
const card = (n: number, lane: "queued" | "checking"): CardView => ({ ...item(n), lane, actor: "queue", reason: "", tone: "waiting", unblocks: 0, needsDecision: false }) as CardView;
const lane = (key: "queued" | "checking", cards: CardView[]): LaneView => ({ lane: key, title: key, total: cards.length, cards });
const member = (n: number, state: BatchMemberView["state"] = "testing"): BatchMemberView => ({ change: { label: `!${n}`, title: `Change ${n}` }, items: [item(n)], state }) as BatchMemberView;
const batch = (name: string, status: BatchView["status"], members: BatchMemberView[]): BatchView => ({ key: name, name, status, members }) as BatchView;
const waiting = (...ns: number[]): WaitingView[] => ns.map((n, index) => ({ position: index + 1, items: [item(n)] }) as WaitingView);

test("the batch under test on top, then the waiting changes in queue order, counted as changes", () => {
  const testing = batch("batch 6", "testing", [member(1), member(2)]);
  const forming = batch("batch 7", "forming", [member(3, "waiting")]);
  const queued = lane("queued", [card(5, "queued"), card(3, "queued"), card(4, "queued")]);
  const checking = lane("checking", [card(1, "checking"), card(2, "checking")]);
  const view = mergeLane(queued, checking, { batches: [testing], forming: [forming], waiting: waiting(4, 5) });
  assert.deepEqual(view.batches.map((each) => each.name), ["batch 6", "batch 7"], "being prepared counts as under test");
  assert.deepEqual(view.waiting.map((each) => each.label), ["#4", "#5"], "boxed cards are not repeated; the rest in queue order");
  assert.equal(view.count, 5);
});

test("a member sent back to the queue waits below as a card, and an empty queue has nothing", () => {
  const bisecting = batch("batch 8", "bisecting", [member(1), member(2, "requeued")]);
  const view = mergeLane(lane("queued", [card(2, "queued")]), lane("checking", [card(1, "checking")]), { batches: [bisecting], forming: [], waiting: waiting(2) });
  assert.deepEqual(view.waiting.map((each) => each.label), ["#2"]);
  assert.equal(view.count, 2);
  assert.deepEqual(mergeLane(lane("queued", []), undefined, { batches: [], forming: [], waiting: [] }), { batches: [], waiting: [], count: 0 });
});

test("the merge queue shows from level 4, and below only while it holds or checks changes", () => {
  assert.equal(queueShown(4, 0), true);
  assert.equal(queueShown(3, 0), false);
  assert.equal(queueShown(2, 1), true);
  assert.equal(queueShown(undefined, 0), true, "board only");
});
