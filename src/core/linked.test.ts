import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedText } from "./linked.ts";
import { work } from "./testing.ts";

test("a linked Item that is done or abandoned is left out of the linked block", () => {
  const text = linkedText([
    { type: "related", item: work(1, { title: "open one" }) },
    { type: "related", item: work(2, { title: "done one", state: "done" }) },
    { type: "conflictsWith", item: work(3, { title: "dropped one", state: "abandoned" }) },
  ]);
  assert.match(text, /open one/);
  assert.doesNotMatch(text, /done one|dropped one/);
  assert.equal(linkedText([{ type: "related", item: work(2, { state: "done" }) }]), "");
});
