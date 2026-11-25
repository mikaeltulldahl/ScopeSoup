// The triage's label proposals, kept to the repository's labels and applied at Accept. Synthetic names only.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyChange, asLabelChange, changeText, isOwnLabel, keepProposal, labelsPromptText } from "./labels.ts";

const REPO = ["bug", "question", "priority:major", "size:small", "scopesoup:claimed"];

test("a proposal keeps existing labels only: scopesoup:* never, an unknown label dropped and noted, no-ops left out", () => {
  const kept = keepProposal({ add: ["Bug", "scopesoup:claimed", "tidal", "priority:major", "bug"], remove: ["question", "size:small", "scopesoup:needs-decision"] }, REPO, ["question", "scopesoup:needs-decision"]);
  // "size:small" is not on the Item, so removing it is nothing.
  assert.deepEqual(kept, { change: { add: ["bug", "priority:major"], remove: ["question"] }, dropped: ["tidal"] });
});

test("the same label added and removed is neither", () => {
  assert.deepEqual(keepProposal({ add: ["bug"], remove: ["Bug"] }, REPO, []).change, { add: [], remove: [] });
  assert.deepEqual(keepProposal({ add: ["bug"], remove: ["Bug"] }, REPO, ["bug"]).change, { add: [], remove: [] });
});

test("at Accept only the changes that still make sense are applied, and other labels stay as people set them", () => {
  // A person added bug and removed question after the rewrite, and added "harbour".
  assert.deepEqual(applyChange(["bug", "harbour"], { add: ["bug", "priority:major"], remove: ["question"] }), { labels: ["bug", "harbour", "priority:major"], add: ["priority:major"], remove: [] });
  assert.deepEqual(applyChange(["Question"], { add: ["scopesoup:claimed"], remove: ["question", "scopesoup:claimed"] }), { labels: [], add: [], remove: ["Question"] });
});

test("shown as +bug, −question; read from an answer", () => {
  assert.equal(changeText({ add: ["bug"], remove: ["question"] }), "+bug, −question");
  assert.deepEqual(asLabelChange({ add: [" bug ", "", 3], remove: "question" }), { add: ["bug"], remove: [] });
  assert.equal(asLabelChange({ add: [], remove: [] }), undefined);
  assert.equal(asLabelChange("bug"), undefined);
});

test("the prompt lists the repository's labels with descriptions and the Item's, without scopesoup:*", () => {
  const text = labelsPromptText([{ name: "bug", description: "Something is broken" }, { name: "scopesoup:claimed", description: "Held" }], ["question", "scopesoup:needs-decision"]);
  assert.equal(text, "The repository's labels (name: description):\n- bug: Something is broken\nThe Item's labels: question");
  assert.match(labelsPromptText(null, []), /leave `labels` empty/);
});

test("Scope Soup's own labels: the scopesoup: prefix and Jira's scopesoup-needs-decision, not any other scopesoup- label", () => {
  assert.equal(isOwnLabel("scopesoup:claimed"), true);
  assert.equal(isOwnLabel("Scopesoup-Needs-Decision"), true);
  assert.equal(isOwnLabel("scopesoup-docs"), false);
  assert.equal(isOwnLabel("bug"), false);
});
