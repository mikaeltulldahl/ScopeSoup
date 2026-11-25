// The Settings page's saving at once (web/src/settingsSave.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { commandChange, keepDaysChange, levelFourFilled, pendingFourText, resourcesReady, serialQueue, wholeNumber } from "../web/src/settingsSave.ts";

test("saves run one after another, in order, even when one fails or is slow", async () => {
  const run = serialQueue();
  const order: string[] = [];
  const slow = run(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); order.push("first"); });
  const failing = run(async () => { order.push("second"); throw new Error("refused"); });
  const last = run(async () => { order.push("third"); return 3; });
  await slow;
  await assert.rejects(failing, /refused/);
  assert.equal(await last, 3);
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("an emptied command line is null, which removes it", () => {
  assert.equal(commandChange("   "), null);
  assert.deepEqual(commandChange('pnpm run "a b"'), ["pnpm", "run", "a b"]);
});

test("numbers are whole and within their bounds; images' keep-days: empty is Never", () => {
  assert.deepEqual(wholeNumber("30", 1, 365), { ok: true, value: 30 });
  assert.equal(wholeNumber("0", 1, 365).ok, false);
  assert.equal(wholeNumber("1.5", 1, 365).ok, false);
  assert.equal(wholeNumber("", 1, 365).ok, false);
  assert.deepEqual(keepDaysChange(""), { ok: true, value: null });
  assert.deepEqual(keepDaysChange("0"), { ok: true, value: 0 });
  assert.equal(keepDaysChange("4000").ok, false);
});

test("level 4 is saved only once every field it asks for is filled in, and says the old level stays until then", () => {
  assert.equal(levelFourFilled([], {}), false);
  assert.equal(levelFourFilled(["checkCommand", "remoteUrl"], { checkCommand: "npm test", remoteUrl: " " }), false);
  assert.equal(levelFourFilled(["checkCommand", "remoteUrl"], { checkCommand: "npm test", remoteUrl: "x" }), true);
  assert.equal(pendingFourText(2, ["checkCommand"], false), "Still level 2 until this is filled in.");
  assert.equal(pendingFourText(2, ["checkCommand", "remoteUrl"], false), "Still level 2 until these are filled in.");
});

test("resources are saved when each has a name and units from 1 to 64", () => {
  assert.equal(resourcesReady([{ name: "emulator", units: "2" }]), true);
  assert.equal(resourcesReady([{ name: "", units: "1" }]), false);
  assert.equal(resourcesReady([{ name: "a", units: "65" }]), false);
});
