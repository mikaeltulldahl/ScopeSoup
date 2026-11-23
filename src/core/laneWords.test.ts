// One word means one thing: an open GitHub item with a live implement session is "In progress"
// on its page, its card, the items list and the overview, whatever the stored state says.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBoard } from "./board.ts";
import { buildItemList, parseListQuery } from "./item-list.ts";
import { buildItemPage } from "./item-page.ts";
import { hostDiffers, LANE_TITLES } from "./lanes.ts";
import { ref, session, snapshot, T0, work } from "./testing.ts";

const item = work(7, { state: "todo", hostState: "open", ref: ref("work", 7, "github") });
const snap = snapshot({ works: [item], sessions: [session(1, item.ref, { role: "implement", status: "running" })] });
const now = new Date(T0);

test("an open GitHub item with a running implement session is In progress in every view", () => {
  const page = buildItemPage(snap, item.ref, now);
  assert.equal(page?.lane, "in-progress");
  assert.equal(page?.item.state, "todo");
  assert.equal(page?.item.hostState, "open");

  const lane = buildBoard(snap, now).lanes.find((each) => each.cards.some((card) => card.ref.id === "7"));
  assert.equal(lane?.lane, "in-progress");
  assert.equal(lane?.title, LANE_TITLES["in-progress"]);
  assert.equal(lane?.cards[0]?.lane, "in-progress");

  const row = buildItemList(snap, {}, now).items[0];
  assert.equal(row?.lane, "in-progress");
});

test("the host's state is shown only where it differs from the lane", () => {
  assert.equal(hostDiffers("in-progress", "open"), false);
  assert.equal(hostDiffers("backlog", "open"), false);
  assert.equal(hostDiffers("done", "closed"), false);
  assert.equal(hostDiffers(null, "closed"), false);
  assert.equal(hostDiffers("done", "open"), true);
  assert.equal(hostDiffers("in-progress", "closed"), true);
  assert.equal(hostDiffers("backlog", "weird"), true);
});

test("the 'Recently done' view's lane=done query keeps done items and drops the rest", () => {
  const finished = work(8, { state: "done", hostState: "closed", ref: ref("work", 8, "github") });
  const both = snapshot({ works: [item, finished], sessions: snap.sessions });
  const query = parseListQuery(new URLSearchParams("lane=done&doneDays=14"));
  assert.deepEqual(query.lane, ["done"]);
  const rows = buildItemList(both, query, now).items;
  assert.deepEqual(rows.map((row) => row.lane), ["done"]);
});

test("the items list filters by lane", () => {
  assert.equal(buildItemList(snap, parseListQuery(new URLSearchParams("lane=in-progress")), now).total, 1);
  assert.equal(buildItemList(snap, parseListQuery(new URLSearchParams("lane=backlog")), now).total, 0);
  assert.equal(buildItemList(snap, parseListQuery(new URLSearchParams("lane=nonsense")), now).total, 1);
});
