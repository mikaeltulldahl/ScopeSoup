// The unified line diff behind the triage draft on the Item page (web/src/textDiff.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collapse, diffLines, hasChanges } from "../../web/src/textDiff.ts";

const marked = (before: string, after: string) => diffLines(before, after).map((row) => (row.kind === "same" ? " " : row.kind === "del" ? "-" : "+") + row.text);
const lines = (n: number) => Array.from({ length: n }, (_, k) => `line ${k}`);

describe("diffLines", () => {
  it("keeps unchanged lines and finds added and removed ones", () => {
    assert.deepEqual(marked("a\nb\nc", "a\nc\nd"), [" a", "-b", " c", "+d"]);
  });
  it("puts the removed lines of a change before the added ones", () => {
    assert.deepEqual(marked("a\nx\ny\nb", "a\nz\nb"), [" a", "-x", "-y", "+z", " b"]);
  });
  it("has no change for equal texts, also with other line endings", () => {
    assert.equal(hasChanges(diffLines("a\nb", "a\r\nb")), false);
  });
  it("treats an empty text as no lines", () => {
    assert.deepEqual(marked("", "a\nb"), ["+a", "+b"]);
    assert.deepEqual(marked("a", ""), ["-a"]);
    assert.deepEqual(marked("", ""), []);
  });
  it("marks the changed words in a changed line pair", () => {
    const [del, add] = diffLines("Fix the login bug today", "Fix the signup bug today");
    assert.deepEqual(del!.parts, [{ text: "Fix the ", changed: false }, { text: "login", changed: true }, { text: " bug today", changed: false }]);
    assert.deepEqual(add!.parts, [{ text: "Fix the ", changed: false }, { text: "signup", changed: true }, { text: " bug today", changed: false }]);
  });
  it("gives no word marks to lines with nothing in common", () => {
    const [del, add] = diffLines("alpha beta", "gamma delta");
    assert.equal(del!.parts, undefined);
    assert.equal(add!.parts, undefined);
  });
});

describe("collapse", () => {
  it("folds a long unchanged run between two changes, keeping context", () => {
    const rows = diffLines(["top", ...lines(20), "bottom"].join("\n"), ["TOP", ...lines(20), "BOTTOM"].join("\n"));
    const shown = collapse(rows, 2);
    const skipped = shown.flatMap((entry) => ("skipped" in entry ? [entry.skipped] : []));
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.length, 16);
    assert.equal(shown.length, 2 + 2 + 1 + 2 + 2);
  });
  it("folds only the side away from the change at the ends", () => {
    const shown = collapse(diffLines(lines(20).join("\n"), [...lines(20), "new"].join("\n")), 2);
    assert.equal("skipped" in shown[0]! ? shown[0].skipped.length : -1, 18);
    assert.equal(shown.length, 1 + 2 + 1);
  });
  it("keeps short runs whole", () => {
    assert.equal(collapse(diffLines("a\nb\nc\nd", "A\nb\nc\nD"), 2).every((entry) => "row" in entry), true);
  });
});
