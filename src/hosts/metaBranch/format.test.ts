// The meta branch's format entry and the steps between formats. Pure; the fixtures in ./fixtures are one meta tree
// per released format (format-0: what Scope Soup wrote before the format entry; format-1: the same with the format entry). Synthetic data.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FORMAT_FILE, META_FORMAT, NEWER_META, formatText, migrationChanges, readFormat, writeProblem } from "./format.ts";
import type { TreeEntry } from "./merge.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const blob = (sha = "a".repeat(40)): TreeEntry => ({ mode: "100644", type: "blob", sha });

describe("the meta format", { concurrency: 4 }, () => {
  test("this Scope Soup is format 1; the fixtures are formats 0 and 1", () => {
    assert.equal(META_FORMAT, 1);
    assert.equal(existsSync(join(FIXTURES, "format-0", FORMAT_FILE)), false);
    const one = readFileSync(join(FIXTURES, "format-1", FORMAT_FILE), "utf8");
    assert.equal(one, formatText());
    assert.deepEqual(readFormat(blob(), one), { ok: true, format: META_FORMAT });
  });

  test("no format entry is format 0; a whole number is that format; anything else cannot be read", () => {
    assert.deepEqual(readFormat(undefined, null), { ok: true, format: 0 });
    for (const [text, format] of [["0\n", 0], ["1\n", 1], ["1", 1], ["1\r\n", 1], ["12\n", 12]] as const) assert.deepEqual(readFormat(blob(), text), { ok: true, format }, text);
    for (const text of ["", "01\n", "-1\n", "1.5\n", " 1\n", "1\n\n", "two\n", "{\"format\":1}\n", "1234567890\n"]) assert.equal(readFormat(blob(), text).ok, false, JSON.stringify(text));
    assert.equal(readFormat({ mode: "120000", type: "blob" }, "1\n").ok, false);
    assert.equal(readFormat({ mode: "040000", type: "tree" }, null).ok, false);
    assert.equal(readFormat(blob(), null).ok, false);
  });

  test("format 0 and this Scope Soup's format are written to; a newer or unreadable format is read only, with the upgrade message", () => {
    assert.equal(writeProblem({ ok: true, format: 0 }), null);
    assert.equal(writeProblem({ ok: true, format: META_FORMAT }), null);
    const newer = writeProblem({ ok: true, format: META_FORMAT + 1 });
    assert.ok(newer?.includes(NEWER_META), newer ?? "");
    assert.equal(NEWER_META, "this project's data is from a newer Scope Soup; upgrade");
    assert.match(writeProblem({ ok: false, problem: "format is not a regular file" }) ?? "", /cannot tell its format and writes nothing to it/);
  });

  test("the step from 0 to 1 changes nothing but the format entry", async () => {
    const files = new Map<string, TreeEntry>([["items/F-1/item.md", blob("b".repeat(40))], ["items/F-1/log.jsonl", blob("c".repeat(40))]]);
    const read: string[] = [];
    const steps = await migrationChanges(0, files, async (sha) => (read.push(sha), ""));
    assert.deepEqual([...steps.changes], [[FORMAT_FILE, { text: "1\n" }]]);
    assert.deepEqual(read, []);
    assert.deepEqual(steps.notes, ["Format 0 to 1: the format entry is written; nothing else changes."]);
    await assert.rejects(migrationChanges(META_FORMAT, files, async () => null), /No migration from format 1/);
    await assert.rejects(migrationChanges(-1, files, async () => null), /No migration/);
  });
});
