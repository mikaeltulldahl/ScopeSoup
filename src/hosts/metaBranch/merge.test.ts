import assert from "node:assert/strict";
import { test } from "node:test";
import type { TreeEntry } from "./merge.ts";
import { appendLines, appendOnlyProblem, conflictName, createdItems, itemPath, lostLines, mergeLogs, mergeTrees, moveItemPaths, renameInHeader } from "./merge.ts";

const L1 = '{"at":"2026-11-18T09:00:00Z","by":"robin","kind":"session"}';
const L2 = '{"at":"2026-11-18T09:05:00Z","by":"sam","kind":"session"}';
const L3 = '{"at":"2026-11-18T09:01:00Z","by":"robin","kind":"assumption"}';

test("append-only: lines may only be added at the end", () => {
  assert.equal(appendOnlyProblem("", `${L1}\n`), null);
  assert.equal(appendOnlyProblem(`${L1}\n`, `${L1}\n${L2}\n`), null);
  // A last line that lacked its line end may gain one.
  assert.equal(appendOnlyProblem(L1, `${L1}\n${L2}\n`), null);
  assert.match(appendOnlyProblem(`${L1}\n${L2}\n`, `${L1}\n`) ?? "", /line 2 .* removed/);
  assert.match(appendOnlyProblem(`${L1}\n`, `${L1.replace("robin", "robyn")}\n`) ?? "", /line 1 .* changed/);
  assert.match(appendOnlyProblem(`${L1}\n${L2}\n`, `${L2}\n${L1}\n`) ?? "", /line 1/);
  assert.equal(appendLines(L1, [L2]), `${L1}\n${L2}\n`);
  assert.equal(appendLines("", []), "");
});

test("lost lines: every distinct line of the old log must still be somewhere; identical lines are one line", () => {
  assert.deepEqual(lostLines(`${L1}\n${L2}\n`, `${L2}\n${L3}\n${L1}\n`), []);
  assert.deepEqual(lostLines(`${L1}\n${L1}\n`, `${L1}\n`), []);
  assert.deepEqual(lostLines(`${L1}\n${L1}\n`, `${L2}\n`), [L1]);
  assert.deepEqual(lostLines(`${L1}\n\n${L2}\n`, `${L1}\n`), [L2]);
  // One own commit wrote the same line twice; the merge keeps one copy, and the check that follows it agrees nothing was lost.
  const ours = `${L1}\n${L2}\n${L2}\n`;
  const merged = mergeLogs(`${L1}\n`, ours, `${L1}\n${L3}\n`);
  assert.deepEqual(merged, { ok: true, text: `${L1}\n${L3}\n${L2}\n` });
  assert.deepEqual(lostLines(ours, merged.ok ? merged.text : ""), []);
});

test("two logs: the other side's log stays as it is, this side's new lines follow, nothing twice", () => {
  assert.deepEqual(mergeLogs(`${L1}\n`, `${L1}\n${L3}\n`, `${L1}\n${L2}\n`), { ok: true, text: `${L1}\n${L2}\n${L3}\n` });
  // The other side already has the line (the same write fetched earlier): not added again.
  assert.deepEqual(mergeLogs(`${L1}\n`, `${L1}\n${L2}\n`, `${L1}\n${L2}\n`), { ok: true, text: `${L1}\n${L2}\n` });
  // Two logs that started apart (no base) keep both.
  assert.deepEqual(mergeLogs("", `${L3}\n`, `${L2}\n`), { ok: true, text: `${L2}\n${L3}\n` });
  // This side's own commit removed a line: refused, not merged.
  const refused = mergeLogs(`${L1}\n${L2}\n`, `${L1}\n${L3}\n`, `${L1}\n${L2}\n`);
  assert.equal(refused.ok, false);
});

const blob = (sha: string): TreeEntry => ({ mode: "100644", type: "blob", sha: sha.padEnd(40, "0") });
const files = (entries: Record<string, string>): Map<string, TreeEntry> => new Map(Object.entries(entries).map(([path, sha]) => [path, blob(sha)]));

test("two trees: logs merged, item.md changed on both sides kept twice, a resolution wins, foreign files are not merged", () => {
  const texts: Record<string, string> = { [blob("a1").sha]: `${L1}\n`, [blob("a2").sha]: `${L1}\n${L3}\n`, [blob("a3").sha]: `${L1}\n${L2}\n` };
  const text = (sha: string): string => texts[sha] ?? "";
  const base = files({ "items/A-1/item.md": "c1", "items/A-1/log.jsonl": "a1", "items/A-2/item.md": "d1", "README.md": "e1" });
  const ours = files({ "items/A-1/item.md": "c2", "items/A-1/log.jsonl": "a2", "items/A-2/item.md": "d1", "items/B-1/item.md": "b1", "README.md": "e1" });
  const theirs = files({ "items/A-1/item.md": "c3", "items/A-1/log.jsonl": "a3", "items/A-2/item.md": "d2", "README.md": "e1" });
  const merged = mergeTrees(base, ours, theirs, text);
  assert.deepEqual(merged.problems, []);
  assert.deepEqual(merged.conflicts, ["A-1"]);
  assert.deepEqual([...merged.changes.keys()].sort(), ["items/A-1/item.conflict-c20000000000.md", "items/A-1/log.jsonl", "items/B-1/item.md"]);
  // item.md stays as the other side has it (it may be pushed); this side's version is beside it.
  assert.equal(merged.changes.get("items/A-1/item.md"), undefined);
  assert.deepEqual(merged.changes.get("items/A-1/item.conflict-c20000000000.md"), blob("c2"));
  assert.deepEqual(merged.changes.get("items/A-1/log.jsonl"), { text: `${L1}\n${L2}\n${L3}\n` });
  // Only the other side changed A-2: it stays theirs.

  // The conflict is resolved on one side while the other side appends: the resolution and the line both stay.
  const aside = "items/A-1/item.conflict-c20000000000.md";
  const conflicted = files({ "items/A-1/item.md": "c3", [aside]: "c2", "items/A-1/log.jsonl": "a1" });
  const resolved = files({ "items/A-1/item.md": "c4", "items/A-1/log.jsonl": "a1" });
  const appended = files({ "items/A-1/item.md": "c3", [aside]: "c2", "items/A-1/log.jsonl": "a3" });
  const settle = mergeTrees(conflicted, resolved, appended, text);
  assert.deepEqual([settle.problems, settle.conflicts], [[], []]);
  assert.deepEqual(settle.changes, new Map<string, unknown>([["items/A-1/item.conflict-c20000000000.md", null], ["items/A-1/item.md", blob("c4")]]));
  // A resolution that meets another edit is a conflict again: the resolution is kept beside it.
  const edited = files({ "items/A-1/item.md": "c5", [aside]: "c2", "items/A-1/log.jsonl": "a1" });
  assert.deepEqual(mergeTrees(conflicted, resolved, edited, text).conflicts, ["A-1"]);

  // A file Scope Soup does not own, changed on both sides, is not merged by guessing.
  const foreign = mergeTrees(files({ "README.md": "e1" }), files({ "README.md": "e2" }), files({ "README.md": "e3" }), text);
  assert.match(foreign.problems[0] ?? "", /README.md was changed on both sides/);
  // This side's commit that removed a log line is refused even when the other side did not touch the log.
  const shrunk = mergeTrees(files({ "items/A-1/log.jsonl": "a2" }), files({ "items/A-1/log.jsonl": "a1" }), files({ "items/A-1/log.jsonl": "a2" }), text);
  assert.match(shrunk.problems[0] ?? "", /append-only/);
});

test("an item created on both sides under one id: found, and its files and header id moved byte for byte", () => {
  const base = files({ "items/A-1/item.md": "a1" });
  const ours = files({ "items/A-1/item.md": "a1", "items/X-1/item.md": "b1", "items/X-1/log.jsonl": "b2", "items/X-2/item.md": "b3" });
  assert.deepEqual(createdItems(base, ours), ["X-1", "X-2"]);
  assert.deepEqual([...moveItemPaths(ours, "X-1", "X-3").keys()], ["items/A-1/item.md", "items/X-3/item.md", "items/X-3/log.jsonl", "items/X-2/item.md"]);
  const moved = new Map([["X-1", "X-3"]]);
  assert.equal(renameInHeader("---\r\nid: X-1\r\ntitle: Keep X-1   this\r\n# a comment X-1\r\n---\r\nbody id: X-1\r\n", moved), "---\r\nid: X-3\r\ntitle: Keep X-1   this\r\n# a comment X-1\r\n---\r\nbody id: X-1\r\n");
  // References from another item move too; X-10 and other keys do not.
  assert.equal(renameInHeader("---\nid: X-2\nparent: X-1\nblockedBy: [X-10, X-1 ,A-1]\nverification: X-1\n---\n", moved), "---\nid: X-2\nparent: X-3\nblockedBy: [X-10, X-3 ,A-1]\nverification: X-1\n---\n");
  assert.equal(renameInHeader("---\ntitle: t\n---\nid: X-1\n", moved), "---\ntitle: t\n---\nid: X-1\n");
});

test("conflict files are named by the version's blob id and recognised as part of the item", () => {
  assert.equal(conflictName("0123456789abcdef0123456789abcdef01234567"), "item.conflict-0123456789ab.md");
  assert.deepEqual(itemPath("items/A-1/item.conflict-0123456789ab.md"), { id: "A-1", file: "conflict" });
  assert.equal(itemPath("items/A-1/item.conflict-XYZ.md"), null);
  assert.equal(itemPath("items/../item.md"), null);
  assert.throws(() => conflictName("../x"), /not a blob id/);
});
