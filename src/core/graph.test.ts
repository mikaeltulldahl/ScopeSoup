import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutLanes } from "./graph.ts";

const byFrom = (lines: { from: number; to: number }[]) => [...lines].sort((x, y) => x.from - y.from || x.to - y.to);

test("a straight history stays in one lane", () => {
  const { rows, lanes } = layoutLanes([{ sha: "c", parents: ["b"] }, { sha: "b", parents: ["a"] }, { sha: "a", parents: [] }]);
  assert.equal(lanes, 1);
  assert.deepEqual(rows.map((row) => row.lane), [0, 0, 0]);
  assert.deepEqual(rows[0]!.top, []);
  assert.deepEqual(rows[1]!.top, [{ from: 0, to: 0 }]);
  assert.deepEqual(rows[2]!.bottom, []);
});

test("a branch takes a second lane and joins back where it left", () => {
  const { rows, lanes } = layoutLanes([{ sha: "f", parents: ["a"] }, { sha: "m", parents: ["a"] }, { sha: "a", parents: [] }]);
  assert.equal(lanes, 2);
  assert.deepEqual(rows.map((row) => row.lane), [0, 1, 0]);
  assert.deepEqual(byFrom(rows[1]!.bottom), [{ from: 0, to: 0 }, { from: 1, to: 0 }]);
  assert.deepEqual(byFrom(rows[2]!.top), [{ from: 0, to: 0 }]);
});

test("a merge commit opens a lane for its second parent", () => {
  const { rows, lanes } = layoutLanes([{ sha: "g", parents: ["b", "f"] }, { sha: "f", parents: ["a"] }, { sha: "b", parents: ["a"] }, { sha: "a", parents: [] }]);
  assert.equal(lanes, 2);
  assert.deepEqual(rows[0]!.bottom, [{ from: 0, to: 0 }, { from: 0, to: 1 }]);
  assert.deepEqual(rows.map((row) => row.lane), [0, 1, 0, 1]);
});

test("a parent outside the window still gets a line down", () => {
  const { rows } = layoutLanes([{ sha: "x", parents: ["gone"] }]);
  assert.deepEqual(rows[0]!.bottom, [{ from: 0, to: 0 }]);
});
