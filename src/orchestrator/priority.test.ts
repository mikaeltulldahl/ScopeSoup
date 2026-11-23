import assert from "node:assert/strict";
import { test } from "node:test";
import { parseItem } from "../hosts/metaBranch/item.ts";
import { canonicalItem, serializeItem } from "../hosts/metaBranch/serialize.ts";
import { compareItems } from "./candidates.ts";
import { priorityFromLabels, priorityRank } from "../model/priority.ts";
import type { Priority, WorkItem } from "../model/types.ts";

const item = (id: string, priority?: Priority, over: Partial<WorkItem> = {}): WorkItem => ({
  ref: { host: "fake", kind: "work", id },
  title: id,
  state: "todo",
  hostState: "open",
  labels: [],
  blockedBy: [],
  openChildren: 0,
  updatedAt: "2026-11-01T00:00:00Z",
  ...(priority ? { priority } : {}),
  ...over,
});

test("priority: ranks blocker to minor", () => {
  assert.deepEqual((["minor", "blocker", "major", "critical"] as Priority[]).sort((a, b) => priorityRank(a) - priorityRank(b)), ["blocker", "critical", "major", "minor"]);
});

test("priority: github labels, case-insensitive, most urgent wins, unknown ignored", () => {
  assert.equal(priorityFromLabels(["bug", "priority:critical"]), "critical");
  assert.equal(priorityFromLabels(["Priority: Minor", "priority:blocker"]), "blocker");
  assert.equal(priorityFromLabels(["priority:urgent", "bug"]), undefined);
});

test("priority: item.md reads, writes and refuses it", () => {
  const text = "---\nid: A-1\ntitle: T\nstate: todo\npriority: critical\n---\n";
  const parsed = parseItem(text, "A-1");
  assert.ok(parsed.ok);
  assert.equal(parsed.fields.priority, "critical");
  assert.equal(serializeItem("A-1", parsed.fields), text);
  assert.equal(serializeItem("A-1", canonicalItem({ title: "T" })).includes("priority"), false);
  assert.equal(parseItem("---\ntitle: T\nstate: todo\npriority: urgent\n---\n", "A-1").ok, false);
  assert.throws(() => canonicalItem({ title: "T", priority: "urgent" as Priority }), /priority/);
});

test("priority: orders before bugs, size and age; an item without one sits between major and minor", () => {
  const items = [item("minor", "minor"), item("old-bug", undefined, { labels: ["bug"], updatedAt: "2026-10-01T00:00:00Z" }), item("plain"), item("block", "blocker", { updatedAt: "2026-11-30T00:00:00Z" }), item("crit", "critical"), item("major-bug", "major", { labels: ["bug"] })];
  assert.deepEqual(items.sort(compareItems(["bug"], {}, items)).map((entry) => entry.ref.id), ["block", "crit", "major-bug", "old-bug", "plain", "minor"]);
});
