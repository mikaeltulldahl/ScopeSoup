// The text of a follow-up Item says what is so when it is written: the approved change is not merged yet.

import assert from "node:assert/strict";
import { test } from "node:test";
import { followUpItem } from "./followUp.ts";
import { work } from "../core/testing.ts";

test("a follow-up's description does not say the source change was merged: at the approval it is only on its way", () => {
  const item = work(7, { title: "Fix the thing" });
  const made = followUpItem(item, [{ text: "Rename the helper.", file: "a.ts" }] as never, "abcdef1234");
  assert.doesNotMatch(made.body, /merged/);
  assert.match(made.body, /went on to the merge without it/);
});
