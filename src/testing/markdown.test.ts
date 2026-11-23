// The board's markdown parser (web/src/markdownParse.ts), on bodies shaped like this repository's issues.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inline, parseMarkdown } from "../../web/src/markdownParse.ts";
import type { Block } from "../../web/src/markdownParse.ts";

const ISSUE = `Seen on the self-trial board (Item #7): descriptions do not render.

- **Bold and italic are shown raw.** The renderer handles \`code\`, but no *emphasis*.
- **Lists show no bullets.** \`styles.css\` sets
  \`list-style: none\` globally.
  - nested one
  - nested two
    1. deeper numbered
- last

## Verification
1. Tests with fixtures.
2. A screenshot, see [the board](https://example.com/board) or [bad](javascript:alert(1)).

> A quoted note
> on two lines

---

| Name | Value |
| --- | :-: |
| a | \`x\\|y\` |
| b | **2** |

\`\`\`ts
const a = 1;
- not a list
\`\`\`
`;

const kinds = (blocks: Block[]) => blocks.map((b) => b.t);

describe("inline", () => {
  it("makes bold and italic, nested in each other", () => {
    assert.deepEqual(inline("a **b *c* x** d"), ["a ", { t: "b", c: ["b ", { t: "i", c: ["c"] }, " x"] }, " d"]);
    assert.deepEqual(inline("_x_ and snake_case_name"), [{ t: "i", c: ["x"] }, " and snake_case_name"]);
  });
  it("leaves stray stars and spaces-around-stars alone", () => {
    assert.deepEqual(inline("2 * 3 * 4"), ["2 * 3 * 4"]);
    assert.deepEqual(inline("**"), ["**"]);
  });
  it("does not emphasise inside code", () => {
    assert.deepEqual(inline("`**a**`"), [{ t: "code", v: "**a**" }]);
  });
  it("links only to http, https and mailto, and keeps html as text", () => {
    assert.deepEqual(inline("[x](javascript:alert(1))"), ["[x](javascript:alert(1)", ")"]);
    assert.deepEqual(inline("<script>x</script>"), ["<script>x</script>"]);
  });
});

describe("parseMarkdown", () => {
  const blocks = parseMarkdown(ISSUE);

  it("finds each kind of block in order", () => {
    assert.deepEqual(kinds(blocks), ["p", "list", "h", "list", "quote", "hr", "table", "code"]);
  });

  it("keeps nested lists, continuation lines and bold in list items", () => {
    const list = blocks[1]!;
    assert.ok(list.t === "list" && !list.ordered);
    assert.equal(list.items.length, 3);
    assert.deepEqual(list.items[0]!.c[0], { t: "b", c: ["Bold and italic are shown raw."] });
    const text = JSON.stringify(list.items[1]!.c);
    assert.match(text, /list-style: none/);
    const nested = list.items[1]!.children[0]!;
    assert.ok(nested.t === "list" && nested.items.length === 2);
    const deeper = nested.items[1]!.children[0]!;
    assert.ok(deeper.t === "list" && deeper.ordered);
  });

  it("makes a numbered list and only safe links", () => {
    const numbered = blocks[3]!;
    assert.ok(numbered.t === "list" && numbered.ordered && numbered.items.length === 2);
    const links = JSON.stringify(numbered.items[1]!.c);
    assert.match(links, /"href":"https:\/\/example.com\/board"/);
    assert.doesNotMatch(links, /"href":"javascript/);
  });

  it("makes a table with escaped pipes inside cells", () => {
    const table = blocks[6]!;
    assert.ok(table.t === "table");
    assert.deepEqual(table.head, [["Name"], ["Value"]]);
    assert.equal(table.rows.length, 2);
    assert.deepEqual(table.rows[0]![1], [{ t: "code", v: "x|y" }]);
    assert.deepEqual(table.rows[1]![1], [{ t: "b", c: ["2"] }]);
  });

  it("makes a quote of its own blocks and a fenced block with its language, unparsed", () => {
    const quote = blocks[4]!;
    assert.ok(quote.t === "quote" && quote.c.length === 1 && quote.c[0]!.t === "p");
    assert.deepEqual(blocks[7], { t: "code", lang: "ts", v: "const a = 1;\n- not a list" });
  });

  it("never turns text into anything but plain data", () => {
    const out = parseMarkdown("<img src=x onerror=alert(1)>\n\n<b>hi</b>");
    assert.deepEqual(out, [
      { t: "p", c: ["<img src=x onerror=alert(1)>"] },
      { t: "p", c: ["<b>hi</b>"] },
    ]);
  });

  it("joins the lines of a paragraph and stops it at a list", () => {
    assert.deepEqual(kinds(parseMarkdown("one\ntwo\n- item")), ["p", "list"]);
    assert.deepEqual(parseMarkdown("one\ntwo")[0], { t: "p", c: ["one two"] });
  });

  it("treats a pipe line without a separator row as a paragraph", () => {
    assert.deepEqual(kinds(parseMarkdown("a | b\nc | d")), ["p"]);
  });

  it("copes with Windows line ends and an unclosed fence", () => {
    assert.deepEqual(kinds(parseMarkdown("- a\r\n- b\r\n\r\n```\r\ncode")), ["list", "code"]);
  });
});

// More bodies shaped like this repository's issues (synthetic copies).
const FIXTURES: Record<string, { text: string; kinds: string[] }> = {
  bug: {
    text: "**Seen:** the page shows raw `**`.\n\n**Steps**\n1. Open the item.\n2. Look at the *description*.\n\n## Verification\n- A test.\n- `pnpm check` passes.",
    kinds: ["p", "p", "list", "h", "list"],
  },
  decided: {
    text: "Context.\n\n> **Decided by a person:** keep it.\n> Do not ask again.\n\n---\n\n- one\n  continues here\n- two",
    kinds: ["p", "quote", "hr", "list"],
  },
  table: {
    text: "| File | Change |\n|------|--------|\n| `a.ts` | **new** |\n| `b.ts` | edit |\n\nAfter.\n\n```json\n{ \"a\": 1 }\n```",
    kinds: ["table", "p", "code"],
  },
  plain: { text: "Just a sentence with 2 * 3 and snake_case.", kinds: ["p"] },
};

describe("fixtures", () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    it(`parses ${name} into the expected blocks`, () => {
      assert.deepEqual(kinds(parseMarkdown(f.text)), f.kinds);
    });
  }
  it("joins a continued list line into its item", () => {
    const list = parseMarkdown(FIXTURES.decided!.text)[3]!;
    assert.ok(list.t === "list" && list.items.length === 2);
    assert.match(JSON.stringify(list.items[0]!.c), /one continues here/);
  });
  it("keeps the language of a fence and the cells of a table", () => {
    const blocks = parseMarkdown(FIXTURES.table!.text);
    assert.deepEqual(blocks[2], { t: "code", lang: "json", v: '{ "a": 1 }' });
    const table = blocks[0]!;
    assert.ok(table.t === "table" && table.rows.length === 2);
    assert.deepEqual(table.rows[0]![1], [{ t: "b", c: ["new"] }]);
  });
});

// Markdown.tsx is JSX, which Node cannot load without the web build, so its mapping and the styles are
// checked as source: every block kind is built as an element, and no HTML text path exists.
describe("Markdown.tsx and styles.css", () => {
  const web = (p: string) => readFileSync(new URL(`../../web/src/${p}`, import.meta.url), "utf8");
  const tsx = web("Markdown.tsx");
  const css = web("styles.css");

  it("builds an element for every block and inline kind", () => {
    for (const kind of ["p", "h", "code", "hr", "quote", "list", "table"]) assert.match(tsx, new RegExp(`case "${kind}"`));
    for (const tag of ["<strong>", "<em>", "<code>", "<blockquote", "<hr", "<ol", "<ul", "<table>", "<th>", "<td>", "<a href"]) {
      assert.ok(tsx.includes(tag), tag);
    }
    assert.match(tsx, /data-lang=/);
  });
  it("never sets HTML from text", () => {
    assert.doesNotMatch(tsx, /dangerouslySetInnerHTML|innerHTML/);
  });
  it("puts list markers, table borders and the quote bar back", () => {
    assert.match(css, /ul\.md-list\s*\{[^}]*list-style:\s*disc/);
    assert.match(css, /ol\.md-list\s*\{[^}]*list-style:\s*decimal/);
    assert.match(css, /\.md-table th,\s*\.md-table td\s*\{[^}]*border/);
    assert.match(css, /\.md-quote\s*\{[^}]*border-left/);
    assert.match(css, /\.md-rule\s*\{/);
  });
});
