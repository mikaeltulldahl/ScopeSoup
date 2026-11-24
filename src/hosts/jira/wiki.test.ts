import assert from "node:assert/strict";
import { test } from "node:test";
import { DC_DESCRIPTION_ONE, DC_DESCRIPTION_TWO } from "./fixtures.ts";
import { wikiToMarkdown } from "./wiki.ts";

test("headings, emphasis, links and lists become their Markdown", () => {
  const got = wikiToMarkdown(DC_DESCRIPTION_ONE);
  assert.equal(got.markdown, "## Goal\n\nShow **every** Item, see [the notes](https://example.test/notes).\n- columns\n- cards\n\n## Verification\n\nOpen the board and see DEMO-1.");
  assert.deepEqual(got.simplified, []);
});

test("mentions, colour and panels are simplified and named", () => {
  const got = wikiToMarkdown(DC_DESCRIPTION_TWO);
  assert.equal(got.markdown, "Asked by @robin, now BLOCKED\n\n> Only on Fridays.");
  assert.deepEqual(got.simplified, ["panel", "mention", "color"]);
});

test("code and noformat blocks keep their text as is", () => {
  const got = wikiToMarkdown("Before\n{code:language=java|title=A}\nint *a* = 1;\n\n\n{code}\n{noformat}\n_raw_ [x]\n{noformat}");
  assert.equal(got.markdown, "Before\n\n```java\nint *a* = 1;\n\n\n```\n\n```\n_raw_ [x]\n```");
});

test("inline code, strike, citations, breaks, escapes and bare links", () => {
  const got = wikiToMarkdown("Use {{a*b}} not -old- ??Someone?? line\\\\next \\*star [https://example.test/a] _em_ snake_case");
  assert.equal(got.markdown, "Use `a*b` not ~~old~~ *Someone* line\\\nnext \\*star <https://example.test/a> *em* snake_case");
});

test("nested and numbered lists, quotes, rules and tables", () => {
  const got = wikiToMarkdown("# one\n## one.a\n#* bullet\n# two\n\nbq. a quote\n----\n||H1||H2||\n|a|b|\n{quote}\nsaid *this*\n{quote}");
  assert.equal(got.markdown, "1. one\n   1. one.a\n   - bullet\n1. two\n\n> a quote\n\n---\n\n| H1 | H2 |\n| --- | --- |\n| a | b |\n\n> said **this**");
});

test("plain text that looks like Markdown is escaped", () => {
  assert.equal(wikiToMarkdown("> not a quote <b> `tick`").markdown, "\\> not a quote \\<b> \\`tick\\`");
});

test("an unknown macro keeps its text and is named; images and page links are simplified", () => {
  const got = wikiToMarkdown("{toc} see !diagram.png! and [Some page] and [^spec.pdf] and +under+");
  assert.equal(got.markdown, "{toc} see \\[attachment\\] and Some page and spec.pdf and under");
  assert.deepEqual(got.simplified, ["macro toc", "image", "page link", "attachment link", "underline"]);
});

test("an empty field is empty", () => {
  assert.deepEqual(wikiToMarkdown(null), { markdown: "", simplified: [] });
});
