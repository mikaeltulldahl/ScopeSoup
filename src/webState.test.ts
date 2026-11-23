// The words the board's Item page and Items list render for an Item's state (web/src/Item.tsx,
// web/src/ItemList.tsx use these helpers): the lane's word, the host's state only where it differs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { hostDiffers } from "./core/lanes.ts";
import { flakyRows, laneWord, optionRows, stateFacts, unmatchedRecommendation } from "../web/src/format.ts";

test("the Queue page's flaky tests: capped at the limit, a count worded as times, none when the record is missing", () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ test: `t${i}`, count: i === 0 ? 1 : 3, at: "2026-11-20T10:00:00Z" }));
  const rows = flakyRows(entries);
  assert.equal(rows.length, 10);
  assert.deepEqual([rows[0]!.test, rows[0]!.times, rows[1]!.times], ["t0", "1 time", "3 times"]);
  assert.equal(flakyRows(entries, 2).length, 2);
  assert.deepEqual(flakyRows(undefined), []);
});

test("decision options keep label and reasoning apart, the recommended one first; plain text stays whole", () => {
  const rows = optionRows([{ label: "Keep it", description: "less work" }, { label: "Drop it", description: "saves cost" }, "Plain: text — as is"], "Drop it");
  assert.deepEqual(rows.map((r) => [r.label, r.description, r.recommended]), [
    ["Drop it", "saves cost", true],
    ["Keep it", "less work", false],
    ["Plain: text — as is", "", false],
  ]);
  assert.equal(rows[0]!.answer, "Drop it: saves cost");
});

test("a recommendation that opens with a label marks that row; one that matches none adds no row", () => {
  const options = [{ label: "Option 1", description: "x" }, { label: "Option 2", description: "y" }];
  const rows = optionRows(options, "Option 2, because it is cheaper");
  assert.deepEqual(rows.map((r) => [r.label, r.recommended]), [["Option 2", true], ["Option 1", false]]);
  assert.deepEqual(optionRows(options, "Option 22").map((r) => r.recommended), [false, false]);
  assert.deepEqual(optionRows(["a", "b"], "c").map((r) => [r.label, r.recommended]), [["a", false], ["b", false]]);
  assert.deepEqual(optionRows(["a", "b"]).map((r) => r.label), ["a", "b"]);
});

test("a recommendation that matches no option is kept as a note, never lost", () => {
  const options = [{ label: "Option 1", description: "x" }, { label: "Option 2", description: "y" }];
  assert.equal(unmatchedRecommendation(optionRows(options, "Do something else"), "Do something else"), "Do something else");
  assert.equal(unmatchedRecommendation(optionRows(options, "Option 2"), "Option 2"), null);
  assert.equal(unmatchedRecommendation(optionRows(options), undefined), null);
  assert.equal(unmatchedRecommendation(optionRows(options, "  "), "  "), null);
});

test("the lane tag and State line say In progress for an open item with a live session", () => {
  assert.equal(laneWord("in-progress"), "In progress");
  const facts = stateFacts("in-progress", "open", hostDiffers("in-progress", "open"));
  assert.deepEqual(facts, { state: "In progress", host: null });
});

test("the State line shows the host's state only where it differs from the lane", () => {
  assert.deepEqual(stateFacts("done", "open", hostDiffers("done", "open")), { state: "Done", host: "open" });
  assert.deepEqual(stateFacts("backlog", "open", hostDiffers("backlog", "open")), { state: "Backlog", host: null });
});

test("no lane reads as Abandoned, in the tag and the list's lane filter", () => {
  assert.equal(laneWord(null), "Abandoned");
  assert.deepEqual(stateFacts(null, "closed", hostDiffers(null, "closed")), { state: "Abandoned", host: null });
});
