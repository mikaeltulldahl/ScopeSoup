// The board keeps Accept and Overturn picks on implementors' decisions in this browser until Send (web/src/heldDecisions.ts).
// Synthetic data.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HeldStorage } from "../web/src/heldAnswers.ts";
import { clearPicks, loadPicks, picksCount, picksKey, readyPicks, savePicks, unsentNote } from "../web/src/heldDecisions.ts";

function memory(): HeldStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

test("held picks survive a reload: kept per Item and decision id, only the decisions still open come back", () => {
  const storage = memory();
  savePicks(storage, "github:work:7", { "11-0": { action: "accept", answer: "" }, "11-1": { action: "overturn", answer: "By distance" } });
  // A "reload": a new page reads them back; a decision settled since is left out.
  assert.deepEqual(loadPicks(storage, "github:work:7", ["11-1", "11-2"]), { "11-1": { action: "overturn", answer: "By distance" } });
  assert.deepEqual(loadPicks(storage, "github:work:8", ["11-0"]), {});
  // After a Send the sent ones go, the others stay; with none left the entry goes.
  clearPicks(storage, "github:work:7", ["11-0"]);
  assert.deepEqual(Object.keys(JSON.parse(storage.data.get(picksKey("github:work:7"))!)), ["11-1"]);
  clearPicks(storage, "github:work:7", ["11-1"]);
  assert.equal(storage.data.size, 0);
});

test("what is sent: every Accept, an Overturn only once its decision is written, in the order shown", () => {
  const picks = { b: { action: "overturn" as const, answer: "  Use y  " }, a: { action: "accept" as const, answer: "" }, c: { action: "overturn" as const, answer: "   " } };
  assert.deepEqual(readyPicks(picks, ["a", "b", "c", "d"]), [{ id: "a", action: "accept" }, { id: "b", action: "overturn", answer: "Use y" }]);
  assert.deepEqual(readyPicks({}, ["a"]), []);
});

test("storage that is missing, refuses or holds rubbish is no error: nothing is held", () => {
  const refusing: HeldStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); } };
  assert.doesNotThrow(() => savePicks(refusing, "k", { a: { action: "accept", answer: "" } }));
  assert.deepEqual(loadPicks(refusing, "k", ["a"]), {});
  assert.deepEqual(loadPicks(null, "k", ["a"]), {});
  const storage = memory();
  storage.setItem(picksKey("k"), JSON.stringify({ a: { action: "maybe", answer: "" }, b: { action: "accept", answer: "" } }));
  assert.deepEqual(loadPicks(storage, "k", ["a", "b"]), { b: { action: "accept", answer: "" } });
});

test("the card's note counts held picks too, an Overturn still being written included", () => {
  const storage = memory();
  assert.equal(picksCount(storage, "k"), 0);
  savePicks(storage, "k", { a: { action: "accept", answer: "" }, b: { action: "overturn", answer: "" } });
  assert.equal(picksCount(storage, "k"), 2);
  assert.equal(unsentNote(0, 0), null);
  assert.equal(unsentNote(2, 0), "answers not sent");
  assert.equal(unsentNote(0, 1), "decisions not sent");
  assert.equal(unsentNote(1, 1), "answers and decisions not sent");
});
