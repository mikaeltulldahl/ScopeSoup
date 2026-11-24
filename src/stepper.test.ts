// The Item page shows questions and implementors' decisions one at a time (web/src/stepper.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { clampStep, firstOpen, keyStep, step, stepTitle } from "../web/src/stepper.ts";

test("the arrows step back and on and stop at the ends; a shorter list keeps the index inside it", () => {
  assert.equal(step(0, 4, 1), 1);
  assert.equal(step(3, 4, 1), 3);
  assert.equal(step(0, 4, -1), 0);
  assert.equal(step(2, 4, -1), 1);
  assert.equal(step(7, 4, -1), 2);
  assert.equal(clampStep(5, 2), 1);
  assert.equal(clampStep(-1, 2), 0);
  assert.equal(clampStep(3, 0), 0);
  assert.equal(step(0, 1, 1), 0);
});

test("the panel opens at the first one not answered, or the first when all are", () => {
  assert.equal(firstOpen([true, false, false]), 1);
  assert.equal(firstOpen([true, true]), 0);
  assert.equal(firstOpen([]), 0);
});

test("left and right keys step, but not in a text box or with a modifier held", () => {
  const button = { tagName: "BUTTON" };
  assert.equal(keyStep("ArrowLeft", button, false), -1);
  assert.equal(keyStep("ArrowRight", button, false), 1);
  assert.equal(keyStep("ArrowUp", button, false), 0);
  assert.equal(keyStep("ArrowRight", { tagName: "textarea" }, false), 0);
  assert.equal(keyStep("ArrowRight", { tagName: "INPUT" }, false), 0);
  assert.equal(keyStep("ArrowRight", { tagName: "DIV", isContentEditable: true }, false), 0);
  assert.equal(keyStep("ArrowRight", button, true), 0);
  assert.equal(keyStep("ArrowRight", null, false), 1);
});

test("the counter names the position, and only the noun when there is one", () => {
  assert.equal(stepTitle("Question", 1, 4), "Question 2 of 4");
  assert.equal(stepTitle("Decision", 0, 1), "Decision");
  assert.equal(stepTitle("Question", 9, 3), "Question 3 of 3");
});
