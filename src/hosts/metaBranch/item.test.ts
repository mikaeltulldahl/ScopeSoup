import assert from "node:assert/strict";
import { test } from "node:test";
import { parseItem } from "./item.ts";

const full = [
  "---",
  "id: A-12",
  "title: Add a regression suite",
  "state: doing",
  "labels: tests, area-core",
  "parent: A-3",
  "blockedBy: A-10, A-11",
  "verification: pnpm check runs the new suite",
  "estimate: small",
  "---",
  "",
  "The suite covers the parser.",
  "",
  "    indented code",
  "",
].join("\n");

test("item.md: every header field and the description are read", () => {
  const parsed = parseItem(full, "A-12");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.fields, {
    title: "Add a regression suite",
    state: "doing",
    labels: ["tests", "area-core"],
    parent: "A-3",
    blockedBy: ["A-10", "A-11"],
    verification: "pnpm check runs the new suite",
    body: "The suite covers the parser.\n\n    indented code",
    extra: [["estimate", "small"]],
  });
});

test("item.md: CRLF line ends, a byte order mark, bracketed lists, comments and no id", () => {
  const text = "﻿---\r\ntitle: Colon: kept in the value\r\nstate: todo\r\n# a comment\r\n\r\nlabels: [a, , b]\r\n---\r\nBody\r\n";
  const parsed = parseItem(text, "B-1");
  assert.ok(parsed.ok);
  assert.equal(parsed.fields.title, "Colon: kept in the value");
  assert.deepEqual(parsed.fields.labels, ["a", "b"]);
  assert.equal(parsed.fields.body, "Body");
  assert.equal(parsed.fields.parent, undefined);
});

test("item.md: a header alone, with an empty description", () => {
  const parsed = parseItem("---\ntitle: T\nstate: done\n---", "C-1");
  assert.ok(parsed.ok);
  assert.equal(parsed.fields.body, "");
  assert.deepEqual(parsed.fields.blockedBy, []);
});

test("item.md: each kind of malformed header is named, not thrown", () => {
  const problems = (text: string, id = "A-1"): string[] => {
    const parsed = parseItem(text, id);
    assert.equal(parsed.ok, false);
    return parsed.ok ? [] : parsed.problems;
  };
  assert.match(problems("title: no header\n")[0] ?? "", /does not start with a --- line/);
  assert.match(problems("---\ntitle: T\nstate: todo\n")[0] ?? "", /no closing ---/);
  assert.deepEqual(problems("---\nstate: todo\n---\n"), ["the title is missing"]);
  assert.deepEqual(problems("---\ntitle: T\n---\n"), ["the state is missing"]);
  assert.match(problems("---\ntitle: T\nstate: started\n---\n")[0] ?? "", /the state "started" is not one of/);
  assert.match(problems("---\ntitle: T\ntitle: U\nstate: todo\n---\n")[0] ?? "", /appears twice/);
  assert.match(problems("---\ntitle: T\nstate: todo\njust words\n---\n")[0] ?? "", /line 4 is not "key: value"/);
  assert.match(problems("---\nid: A-2\ntitle: T\nstate: todo\n---\n")[0] ?? "", /header id "A-2" is not the directory's "A-1"/);
  assert.match(problems("---\ntitle: T\nstate: todo\nparent: ../x\n---\n")[0] ?? "", /parent "..\/x" is not an item id/);
  assert.match(problems("---\ntitle: T\nstate: todo\nblockedBy: A-2, -rf\n---\n")[0] ?? "", /blockedBy "-rf" is not an item id/);
});
