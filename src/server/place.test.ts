// A drop at a place in a lane's order (#222, src/server/place.ts): the vote puts the Item exactly there, the others keep their
// order, and a drop past the edge of its group lands at that edge.

import assert from "node:assert/strict";
import { test } from "node:test";
import { work } from "../core/testing.ts";
import { compareItems } from "../orchestrator/candidates.ts";
import type { Jobs } from "../orchestrator/jobs.ts";
import { refKey } from "../model/types.ts";
import type { WorkItem } from "../model/types.ts";
import { voteToPlace } from "./place.ts";

const TRIAGED = { log: [{ at: "2026-03-02T10:00:00.000Z", by: { who: "scopesoup", agent: true as const }, kind: "session" as const, fields: { role: "triage" } }] };
const triaged = (ids: number[]): Jobs => Object.fromEntries(ids.map((id) => [refKey(work(id).ref), { step: "triage", triage: { size: id % 2 ? "small" : "large", ready: true, paths: [], hidesDecision: false } }])) as unknown as Jobs;
const sorted = (items: WorkItem[], jobs: Jobs): WorkItem[] => [...items].sort(compareItems(["bug"], jobs, items));
const ids = (items: WorkItem[], jobs: Jobs): string[] => sorted(items, jobs).map((item) => item.ref.id);

/** Drops `id` right above `before` (or last), and gives the order after with the vote set. */
function drop(items: WorkItem[], jobs: Jobs, id: number, before: number | null): { order: string[]; note?: string } {
  const item = items.find((each) => each.ref.id === String(id))!;
  const move = voteToPlace(sorted(items, jobs), item, before === null ? null : refKey(work(before).ref), { all: items, jobs, bugLabels: ["bug"] });
  assert.ok(move.ok);
  const next = items.map((each) => (each === item ? { ...each, vote: move.vote } : each));
  return { order: ids(next, jobs), ...(move.note ? { note: move.note } : {}) };
}

test("place: a drop puts the Item at any place, the others keep their order", () => {
  const items = [work(1, { ...TRIAGED, priority: "major" }), work(2, TRIAGED), work(3, { ...TRIAGED, priority: "critical" }), work(4, { ...TRIAGED, priority: "minor" }), work(5, TRIAGED), work(6, { ...TRIAGED, labels: ["bug"] })];
  const jobs = triaged([1, 2, 3, 4, 5, 6]);
  const start = ids(items, jobs);
  for (const id of start) {
    const others = start.filter((each) => each !== id);
    for (let at = 0; at <= others.length; at++) {
      const before = others[at] === undefined ? null : Number(others[at]);
      const { order, note } = drop(items, jobs, Number(id), before);
      const expected = [...others.slice(0, at), id, ...others.slice(at)];
      assert.deepEqual(order, expected, `${id} above ${before}`);
      assert.equal(note, undefined);
    }
  }
});

test("place: Items with one score and no votes are told apart", () => {
  const items = [work(1), work(2), work(3), work(4)];
  assert.deepEqual(drop(items, {}, 4, 1).order, ["4", "1", "2", "3"]);
  assert.deepEqual(drop(items, {}, 1, null).order, ["2", "3", "4", "1"]);
  assert.deepEqual(drop(items, {}, 1, 4).order, ["2", "3", "1", "4"]);
});

test("place: a drop past the edge of the Item's group lands at that edge, and says so", () => {
  const items = [work(1, TRIAGED), work(2, TRIAGED), work(3), work(4)];
  const jobs = triaged([1, 2]);
  const up = drop(items, jobs, 4, 1);
  assert.deepEqual(up.order, ["1", "2", "4", "3"]);
  assert.match(up.note ?? "", /stays among the Items not triaged yet: it goes first of them/);
  const down = drop(items, jobs, 1, null);
  assert.deepEqual(down.order, ["2", "1", "3", "4"]);
  assert.match(down.note ?? "", /goes last of them/);
});

test("place: an Item moved in from another lane is placed in the order it was not in", () => {
  const items = [work(1), work(2), work(3)];
  const lane = sorted(items.slice(0, 2), {});
  const move = voteToPlace(lane, items[2]!, refKey(work(1).ref), { all: items, jobs: {}, bugLabels: ["bug"] });
  assert.ok(move.ok);
  assert.deepEqual(ids(items.map((each) => (each.ref.id === "3" ? { ...each, vote: move.vote } : each)), {}), ["3", "1", "2"]);
});
