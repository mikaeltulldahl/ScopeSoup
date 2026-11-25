import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsWords, shown } from "./settingsWords.ts";

test("the models of the roles are one phrase, by role, with the old value when there was one", () => {
  assert.deepEqual(
    settingsWords([
      { key: "roles.triage.model", from: "sonnet", to: "haiku" },
      { key: "roles.implement.model", to: "haiku" },
    ]),
    ["Models: triage Sonnet → Haiku, implementor Haiku"],
  );
  assert.deepEqual(settingsWords([{ key: "roles.review.model", from: "claude-opus-4-1" }]), ["Models: reviewer back to its default"]);
});

test("the level, numbers with their unit, commands and lists read as words, not JSON", () => {
  assert.deepEqual(
    settingsWords([
      { key: "level", from: 2, to: 3 },
      { key: "settings.stallTimeoutMinutes.value", from: 10, to: 15 },
      { key: "settings.stallTimeoutMinutes.reason", from: "a", to: "b" },
      { key: "checkCommand", from: ["pnpm", "test"], to: ["pnpm", "run", "check"] },
      { key: "bugLabels", from: ["bug"], to: ["bug", "defect"] },
      { key: "roles.implement.maxTurns", from: 40, to: 60 },
      { key: "mergeQueue.ciTimeoutMinutes", to: 30 },
      { key: "setupWatch", from: ["pnpm-lock.yaml"] },
    ]),
    [
      "Level 2 → 3",
      "Stall timeout 10 → 15 min",
      'Check command "pnpm test" → "pnpm run check"',
      "Bug labels bug → bug, defect",
      "Implementor's turn limit 40 → 60",
      "Merge queue ci timeout minutes set to 30",
      "Files that rerun the setup removed (was pnpm-lock.yaml)",
    ],
  );
  // The models phrase stays where the first model change was.
  assert.deepEqual(settingsWords([{ key: "level", from: 3, to: 4 }, { key: "roles.triage.model", from: "opus", to: "haiku" }]), ["Level 3 → 4", "Models: triage Opus → Haiku"]);
});

test("a first save of many values is one phrase; an unknown key is spelled out", () => {
  const first = ["project", "level", "bugLabels", "checkCommand"].map((key) => ({ key, to: 1 }));
  assert.deepEqual(settingsWords(first), ["Saved the project's settings for the first time (4 values)"]);
  assert.deepEqual(settingsWords([{ key: "someNewThing.innerPart", from: true, to: false }]), ["Some new thing inner part on → off"]);
  assert.deepEqual(settingsWords([{ key: "settings.reserveFiveHour.reason", from: "x", to: "y" }]), ["Reserve of the 5-hour window: reason changed"]);
});

test("values are cut short and objects shown by name", () => {
  assert.equal(shown([{ name: "tide-api", units: 1 }, { name: "emulator" }]), "tide-api, emulator");
  assert.equal(shown({ value: 2, reason: "x" }), "2");
  assert.equal(shown([]), "none");
  assert.ok(shown("x".repeat(100)).endsWith("…"));
  assert.ok(shown("x".repeat(100)).length <= 60);
});
