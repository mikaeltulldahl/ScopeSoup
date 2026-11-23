// The shared settings on the meta ref: what a save changed, and two saves made at once merged when one is put on top.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeTrees } from "./merge.ts";
import { mergeSettings, SETTINGS_FILE, SETTINGS_LOG, settingChanges, settingsText } from "./settings.ts";

test("settingChanges names each changed value by its path; objects are walked, lists compared whole", () => {
  assert.deepEqual(settingChanges({ level: 1, roles: { implement: { model: "haiku", allowedTools: ["Read"] } } }, { level: 2, roles: { implement: { allowedTools: ["Read", "Edit"] } }, bugLabels: ["bug"] }), [
    { key: "level", from: 1, to: 2 },
    { key: "roles.implement.model", from: "haiku" },
    { key: "roles.implement.allowedTools", from: ["Read"], to: ["Read", "Edit"] },
    { key: "bugLabels", to: ["bug"] },
  ]);
  assert.deepEqual(settingChanges({ level: 1 }, { level: 1 }), []);
});

test("mergeSettings: this side's changed values are made again on the other side's settings; a value both changed takes this side's", () => {
  const base = settingsText({ project: "tides", level: 1, roles: { implement: { model: "haiku" } } });
  const ours = settingsText({ project: "tides", level: 2, roles: { implement: { model: "haiku" } } });
  const theirs = settingsText({ project: "tides", level: 3, mainBranch: "trunk", roles: { implement: { model: "opus" } } });
  const merged = mergeSettings(base, ours, theirs);
  assert.ok(merged.ok);
  assert.deepEqual(JSON.parse(merged.text), { project: "tides", level: 2, mainBranch: "trunk", roles: { implement: { model: "opus" } } });
  // A key this side removed goes; one the other side has no file for starts from nothing.
  const removed = mergeSettings(settingsText({ a: 1, b: 2 }), settingsText({ a: 1 }), settingsText({ a: 5, b: 2 }));
  assert.ok(removed.ok && JSON.parse(removed.text).b === undefined && JSON.parse(removed.text).a === 5);
  assert.deepEqual(mergeSettings(null, settingsText({ a: 1 }), null), { ok: true, text: settingsText({ a: 1 }) });
  assert.equal(mergeSettings(base, "not json", theirs).ok, false);
});

test("mergeTrees: the settings and their log changed on both sides are merged, never refused", () => {
  const entry = (sha: string) => ({ mode: "100644", type: "blob", sha });
  const texts: Record<string, string> = {
    s0: settingsText({ level: 1 }), s1: settingsText({ level: 2 }), s2: settingsText({ level: 1, bugLabels: ["bug"] }),
    l0: "a\n", l1: "a\nb\n", l2: "a\nc\n",
  };
  const base = new Map([[SETTINGS_FILE, entry("s0")], [SETTINGS_LOG, entry("l0")]]);
  const ours = new Map([[SETTINGS_FILE, entry("s1")], [SETTINGS_LOG, entry("l1")]]);
  const theirs = new Map([[SETTINGS_FILE, entry("s2")], [SETTINGS_LOG, entry("l2")]]);
  const merged = mergeTrees(base, ours, theirs, (sha) => texts[sha] ?? "");
  assert.deepEqual(merged.problems, []);
  assert.deepEqual(merged.changes.get(SETTINGS_FILE), { text: settingsText({ level: 2, bugLabels: ["bug"] }) });
  assert.deepEqual(merged.changes.get(SETTINGS_LOG), { text: "a\nc\nb\n" });
});
