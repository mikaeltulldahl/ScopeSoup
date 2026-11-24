// The board keeps the answers picked on an Item page in this browser until Send (web/src/heldAnswers.ts). Synthetic data.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HeldStorage } from "../web/src/heldAnswers.ts";
import { answerText, clearHeld, dropOther, heldCount, isAnswered, heldKey, loadHeld, pick, pickOther, saveHeld } from "../web/src/heldAnswers.ts";

function memory(): HeldStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

const OPTIONS = [{ label: "down", send: "down: as the tables do" }, { label: "up", send: "up: safer" }];

test("held answers survive a reload: kept per Item and question id, only the questions still asked come back", () => {
  const storage = memory();
  saveHeld(storage, "github:work:7", { "parked:T:0": { picked: ["up"], other: null }, "parked:T:1": { picked: [], other: "Fathoms" }, "parked:T:2": { picked: [], other: null } });
  assert.deepEqual(JSON.parse(storage.data.get(heldKey("github:work:7"))!), { "parked:T:0": { picked: ["up"], other: null }, "parked:T:1": { picked: [], other: "Fathoms" } });
  // A "reload": a new page reads them back; a question no longer asked is left out.
  assert.deepEqual(loadHeld(storage, "github:work:7", ["parked:T:0", "parked:T:9"]), { "parked:T:0": { picked: ["up"], other: null } });
  assert.deepEqual(loadHeld(storage, "github:work:8", ["parked:T:0"]), {});
  assert.equal(heldCount(storage, "github:work:7"), 2);
  // After a Send the sent ones go, the others stay; with none left the entry goes.
  clearHeld(storage, "github:work:7", ["parked:T:0"]);
  assert.deepEqual(loadHeld(storage, "github:work:7", ["parked:T:0", "parked:T:1"]), { "parked:T:1": { picked: [], other: "Fathoms" } });
  clearHeld(storage, "github:work:7", ["parked:T:1"]);
  assert.equal(storage.data.size, 0);
});

test("storage that is missing, refuses or holds rubbish is no error: nothing is held", () => {
  const refusing: HeldStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); } };
  assert.doesNotThrow(() => saveHeld(refusing, "k", { a: { picked: ["up"], other: null } }));
  assert.deepEqual(loadHeld(refusing, "k", ["a"]), {});
  assert.deepEqual(loadHeld(null, "k", ["a"]), {});
  const storage = memory();
  storage.setItem(heldKey("k"), "{not json");
  assert.deepEqual(loadHeld(storage, "k", ["a"]), {});
  storage.setItem(heldKey("k"), JSON.stringify({ a: { picked: [1], other: null }, b: { picked: ["up"], other: null } }));
  assert.deepEqual(loadHeld(storage, "k", ["a", "b"]), { b: { picked: ["up"], other: null } });
});

test("picking: one option replaces the other and Other; a multi-select question toggles and keeps Other", () => {
  let held = pick(undefined, "down", false);
  held = pick(held, "up", false);
  assert.deepEqual(held, { picked: ["up"], other: null });
  assert.deepEqual(pickOther(held, "half way", false), { picked: [], other: "half way" });
  let multi = pick(undefined, "up", true);
  multi = pick(multi, "down", true);
  multi = pickOther(multi, "  and sideways  ", true);
  assert.equal(answerText(multi, OPTIONS), "down: as the tables do; up: safer; and sideways");
  multi = pick(multi, "up", true);
  assert.deepEqual(dropOther(multi), { picked: ["down"], other: null });
});

test("the answer sent: the option as given, an Other text as written, nothing when nothing is picked", () => {
  assert.equal(answerText({ picked: ["up"], other: null }, OPTIONS), "up: safer");
  assert.equal(answerText({ picked: [], other: "Round to the nearest 5 cm, as the harbour master asks." }, OPTIONS), "Round to the nearest 5 cm, as the harbour master asks.");
  assert.equal(answerText({ picked: [], other: "   " }, OPTIONS), "");
  assert.equal(answerText(undefined, OPTIONS), "");
});

test("a question with nothing ticked and Other empty is not answered, a multi-select one included", () => {
  assert.equal(isAnswered(undefined, OPTIONS), false);
  assert.equal(isAnswered({ picked: [], other: null }, OPTIONS), false);
  // "Other" ticked but empty or blank, or every pick unticked again.
  assert.equal(isAnswered(pickOther(undefined, "", true), OPTIONS), false);
  assert.equal(isAnswered(pickOther(undefined, "  ", true), OPTIONS), false);
  assert.equal(isAnswered(pick(pick(undefined, "up", true), "up", true), OPTIONS), false);
  // A pick of an option no longer asked is not an answer either.
  assert.equal(isAnswered({ picked: ["gone"], other: null }, OPTIONS), false);
  assert.equal(isAnswered(pick(undefined, "up", true), OPTIONS), true);
  assert.equal(isAnswered(dropOther(pickOther(pick(undefined, "up", true), "words", true)), OPTIONS), true);
  assert.equal(isAnswered(pickOther(undefined, "Fathoms", true), OPTIONS), true);
  assert.equal(answerText(pickOther(undefined, "", true), OPTIONS), "");
});
