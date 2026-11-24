import assert from "node:assert/strict";
import { test } from "node:test";
import { adfToMarkdown } from "./adf.ts";
import { CLOUD_DESCRIPTION_ONE, CLOUD_DESCRIPTION_TWO } from "./fixtures.ts";

const text = (value: string, ...marks: string[]) => ({ type: "text", text: value, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ version: 1, type: "doc", content });

test("the common nodes become their Markdown, with nothing simplified", () => {
  const got = adfToMarkdown(CLOUD_DESCRIPTION_ONE);
  assert.equal(got.markdown, "## Goal\n\nShow **every** Item, see [the notes](https://example.test/notes).\n\n- columns\n- cards\n\n## Verification\n\nOpen the board and see DEMO-1.");
  assert.deepEqual(got.simplified, []);
});

test("marks, code, breaks, quotes, rules and ordered lists", () => {
  const got = adfToMarkdown(doc(
    para(text("a "), text(" b ", "strong"), text("c", "em"), text("d", "strike"), text("x`y", "code"), { type: "hardBreak" }, text("next")),
    { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1;\n\nlet b = ```;" }] },
    { type: "blockquote", content: [para(text("quoted")), para(text("twice"))] },
    { type: "rule" },
    { type: "orderedList", attrs: { order: 3 }, content: [{ type: "listItem", content: [para(text("three")), { type: "bulletList", content: [{ type: "listItem", content: [para(text("inner"))] }] }] }, { type: "listItem", content: [para(text("four"))] }] },
  ));
  assert.equal(
    got.markdown,
    "a  **b** *c*~~d~~``x`y``\\\nnext\n\n````ts\nconst a = 1;\n\nlet b = ```;\n````\n\n> quoted\n>\n> twice\n\n---\n\n3. three\n\n   - inner\n4. four",
  );
});

test("plain text that looks like Markdown is escaped; snake_case is left alone", () => {
  const got = adfToMarkdown(doc(para(text("# not a heading *nor* [link] snake_case _x_"))));
  assert.equal(got.markdown, "\\# not a heading \\*nor\\* \\[link\\] snake_case \\_x\\_");
});

test("mentions, status lozenges and panels are simplified and named", () => {
  const got = adfToMarkdown(CLOUD_DESCRIPTION_TWO);
  assert.equal(got.markdown, "Asked by @Robin Example, now \\[BLOCKED\\]\n\n> **Warning:** Only on Fridays.");
  assert.deepEqual(got.simplified, ["mention", "status", "panel"]);
});

test("expand, media, cards, emoji, dates, tasks and tables", () => {
  const got = adfToMarkdown(doc(
    { type: "expand", attrs: { title: "More" }, content: [para(text("hidden"))] },
    { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1", type: "file" } }] },
    para({ type: "inlineCard", attrs: { url: "https://example.test/x" } }, text(" "), { type: "emoji", attrs: { shortName: ":smile:", text: "😄" } }, text(" "), { type: "date", attrs: { timestamp: "1795000000000" } }),
    { type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [text("done")] }, { type: "taskItem", attrs: { state: "TODO" }, content: [text("open")] }] },
    { type: "table", content: [
      { type: "tableRow", content: [{ type: "tableHeader", content: [para(text("A"))] }, { type: "tableHeader", content: [para(text("B|C"))] }] },
      { type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2 }, content: [para(text("wide"))] }] },
    ] },
  ));
  assert.equal(
    got.markdown,
    "<details>\n<summary>More</summary>\n\nhidden\n\n</details>\n\n\\[attachment\\]\n\n<https://example.test/x> 😄 2026-11-18\n\n- [x] done\n- [ ] open\n\n| A | B\\|C |\n| --- | --- |\n| wide |  |",
  );
  assert.deepEqual(got.simplified, ["media", "merged table cells"]);
});

test("an unknown node keeps its text and is named; colour and underline are dropped and named", () => {
  const got = adfToMarkdown(doc(
    { type: "bodiedExtension", attrs: { extensionKey: "x" }, content: [para(text("inside"))] },
    para({ type: "text", text: "red", marks: [{ type: "textColor", attrs: { color: "#ff0000" } }, { type: "underline" }] }, { type: "futureInline", attrs: { text: "kept" } }),
  ));
  assert.equal(got.markdown, "inside\n\nredkept");
  assert.deepEqual(got.simplified, ["bodiedExtension", "textColor", "underline", "futureInline"]);
});

test("an empty field is empty; something that is not ADF says so", () => {
  assert.deepEqual(adfToMarkdown(null), { markdown: "", simplified: [] });
  assert.deepEqual(adfToMarkdown({ nope: true }), { markdown: "", simplified: ["not ADF"] });
});
