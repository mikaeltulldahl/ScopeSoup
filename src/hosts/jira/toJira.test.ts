import assert from "node:assert/strict";
import { test } from "node:test";
import { answersBody, assumptionBody, rewriteBody, questionBody } from "../github/conventions.ts";
import type { AdfNode } from "./adf.ts";
import { adfToMarkdown } from "./adf.ts";
import { spliceAdfVerification, spliceWikiVerification, writeDescription } from "./description.ts";
import { adfProblem } from "./fakeJiraWrites.ts";
import { markdownToAdf, markdownToWiki, wikiEscape } from "./toJira.ts";
import { wikiToMarkdown } from "./wiki.ts";

const SAMPLE = [
  "Plain text.",
  "**bold** and *em* and _em_ and ~~gone~~ and `code` and [a link](https://example.test/a).",
  "# Title\n\nSome text.\n\n## Verification\n\nRun `pnpm check`.",
  "- one\n- two\n  - two and a half\n- three",
  "3. third\n4. fourth",
  "> quoted\n> more",
  "```ts\nconst a = 1;\n\nconst b = `x`;\n```",
  "Line one\nline two",
  "---",
  "snake_case_name and 2*3*4",
];

test("Markdown to ADF gives documents the fake (Jira's schema) takes, and reads back as the same Markdown", () => {
  for (const markdown of SAMPLE) {
    const doc = markdownToAdf(markdown);
    assert.equal(adfProblem(doc), null, markdown);
  }
  assert.equal(adfToMarkdown(markdownToAdf(SAMPLE[1]!)).markdown, "**bold** and *em* and *em* and ~~gone~~ and `code` and [a link](https://example.test/a).");
  assert.equal(adfToMarkdown(markdownToAdf(SAMPLE[2]!)).markdown, SAMPLE[2]);
  assert.equal(adfToMarkdown(markdownToAdf(SAMPLE[6]!)).markdown, SAMPLE[6]);
  assert.equal(adfToMarkdown(markdownToAdf("snake_case_name")).markdown, "snake_case_name");
  assert.equal(adfToMarkdown(markdownToAdf(SAMPLE[7]!)).markdown, "Line one\\\nline two");
});

test("Scope Soup's own comment bodies are valid ADF: question, answers, rewrite (an expand), decisions", () => {
  const bodies = [
    questionBody(1, { question: "Round?", options: [{ label: "up", description: "Always." }, "down"], recommendation: "down", context: "From the triage.", parked: "needs-decision", step: "triage" }),
    answersBody([{ to: 1, n: 1, given: { answer: "down" } }, { to: 2, n: 2, given: { answer: "metres" } }], "Ada"),
    rewriteBody(2, "New text.\n\n## Verification\n\nIt works.", "abc", { add: ["units"], remove: [] }),
    assumptionBody([{ question: "Unit?", chosen: "metres", others: ["feet"], why: "SI." }]),
  ];
  for (const body of bodies) {
    const visible = body.trimEnd().split("\n").slice(0, -1).join("\n");
    const doc = markdownToAdf(visible);
    assert.equal(adfProblem(doc), null, visible);
  }
  const rewrite = markdownToAdf(rewriteBody(2, "New text.", "abc").split("\n").slice(0, -1).join("\n"));
  assert.equal(rewrite.content![0]?.type, "expand");
  assert.equal(rewrite.content![0]?.attrs?.title, "Triage, round 2: proposed description");
});

test("only plain web and mail links are made; anything else stays text, and no mention or card is ever made", () => {
  const doc = JSON.stringify(markdownToAdf("[x](javascript:alert(1)) [y](https://example.test) <https://example.test/b> @\u200bpat"));
  assert.doesNotMatch(doc, /"href":"javascript/);
  assert.match(doc, /"href":"https:\/\/example.test"/);
  assert.match(doc, /"href":"https:\/\/example.test\/b"/);
  assert.doesNotMatch(doc, /mention|inlineCard/);
});

test("Markdown to wiki markup reads back as the same Markdown, with every live character escaped", () => {
  assert.equal(wikiToMarkdown(markdownToWiki(SAMPLE[1]!)).markdown, "**bold** and *em* and *em* and ~~gone~~ and `code` and [a link](https://example.test/a).");
  assert.equal(wikiToMarkdown(markdownToWiki(SAMPLE[2]!)).markdown, SAMPLE[2]);
  assert.equal(markdownToWiki(SAMPLE[3]!), "* one\n* two\n** two and a half\n* three");
  assert.equal(wikiToMarkdown(markdownToWiki(SAMPLE[6]!)).markdown, SAMPLE[6]);
  assert.equal(wikiEscape("[~admin] {html} !img! a|b"), "\\[\\~admin\\] \\{html\\} \\!img\\! a\\|b");
  assert.equal(wikiEscape("a - b well-known snake_case"), "a - b well-known snake_case");
  assert.equal(wikiEscape("-strike- *bold*"), "\\-strike\\- \\*bold\\*");
  for (const line of ["h1. not a heading", "* not a list", "bq. not a quote", "---- not a rule"]) {
    const read = wikiToMarkdown(markdownToWiki(line.replace(/^\*/, "\\*").replace(/^-/, "\\-")));
    assert.equal(read.simplified.length, 0, line);
    assert.doesNotMatch(read.markdown, /^(#|>|- |---$)/, line);
  }
  // Every `{code` and `{noformat` inside a code block gets a zero-width space, parameterised ones too, so none ends or opens a block.
  assert.equal(markdownToWiki("```\nthe {code} and {noformat} and {code:java} macros\n```"), "{code}\nthe {​code} and {​noformat} and {​code:java} macros\n{code}");
  assert.equal(wikiToMarkdown(markdownToWiki("```\nend {code} here\n```")).markdown, "```\nend {​code} here\n```");
});

test("inline code on Data Center escapes everything wiki markup still acts on inside {{...}}, and reads back as it was", () => {
  const code = "[~admin] !x.png! [a|http://e] *b* {html} -s- _e_ a\\b";
  const wiki = markdownToWiki(`Run \`${code}\` now.`);
  const inside = /\{\{(.*)\}\}/.exec(wiki)?.[1] ?? "";
  for (const live of [/(^|[^\\])\[/, /(^|[^\\])!/, /(^|[^\\])\*/, /(^|[^\\])\{/, /(^|[^\\])\|/, /(^|[^\\])_/, /(^|[^\\])-/]) assert.doesNotMatch(inside, live, inside);
  const read = wikiToMarkdown(wiki);
  assert.equal(read.simplified.length, 0);
  assert.equal(read.markdown, `Run \`${code}\` now.`);
});

test("the Verification section is spliced into the ADF tree and the wiki text, everything else kept", () => {
  const panel = { type: "panel", attrs: { panelType: "info" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Kept." }] }] };
  const doc = { version: 1, type: "doc", content: [panel, { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Verification" }] }, { type: "paragraph", content: [{ type: "text", text: "Old." }] }, { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Notes" }] }] };
  const splice = (from: unknown, text: string | null): AdfNode => spliceAdfVerification(from, text) as AdfNode;
  const spliced = splice(doc, "New.");
  assert.deepEqual(spliced.content![0], panel);
  assert.equal(adfToMarkdown(spliced).markdown, "> **Info:** Kept.\n\n## Verification\n\nNew.\n\n## Notes");
  assert.equal(splice({ version: 1, type: "doc", content: [panel] }, "Added.").content?.length, 3);
  assert.deepEqual(splice(doc, null).content, [panel, doc.content[3]]);
  // Nothing to splice and nothing to write: the description as it was, an empty one too.
  assert.equal(spliceAdfVerification(null, null), null);
  assert.deepEqual(writeDescription("cloud", null, { verification: null }), { value: null });
  assert.equal(spliceWikiVerification("Text.", ""), "Text.");
  assert.equal(spliceWikiVerification("{panel}Kept.{panel}\n\nh2. Verification\nOld.\n\nh2. Notes\nN.", "New."), "{panel}Kept.{panel}\n\nh2. Verification\n\nNew.\n\nh2. Notes\nN.");
  assert.equal(spliceWikiVerification("Text.", "Added."), "Text.\n\nh2. Verification\n\nAdded.");
  // A heading inside a panel or quote is the macro's: a Verification there is left whole and a section is added at the end.
  const inPanel = "{panel:title=Notes}\nh2. Verification\nInside.\n{panel}\n\nAfter.";
  assert.equal(spliceWikiVerification(inPanel, "New."), `${inPanel}\n\nh2. Verification\n\nNew.`);
  // A quote inside the section is the section's, whole: its heading does not end the section, so no closing tag is left behind.
  assert.equal(spliceWikiVerification("h2. Verification\nOld.\n{quote}\nh2. Quoted\n{quote}\nh2. Notes\nN.", "New."), "h2. Verification\n\nNew.\n\nh2. Notes\nN.");
  assert.match(JSON.stringify(writeDescription("cloud", doc, { description: "Flat." })), /refused/);
  assert.deepEqual(writeDescription("datacenter", "Plain.\n\nh2. Verification\nIt.", { description: "New." }), { value: "New.\n\nh2. Verification\n\nIt." });
});
