import assert from "node:assert/strict";
import { test } from "node:test";
import { answersBody, assumptionBody, draftBody, questionBody } from "../github/conventions.ts";
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

test("Scope Soup's own comment bodies are valid ADF: question, answers, draft (an expand), decisions", () => {
  const bodies = [
    questionBody(1, { question: "Round?", options: [{ label: "up", description: "Always." }, "down"], recommendation: "down", context: "From the triage.", parked: "needs-decision", step: "triage" }),
    answersBody([{ to: 1, n: 1, given: { answer: "down" } }, { to: 2, n: 2, given: { answer: "metres" } }], "Ada"),
    draftBody(2, "New text.\n\n## Verification\n\nIt works.", "abc", { add: ["units"], remove: [] }),
    assumptionBody([{ question: "Unit?", chosen: "metres", others: ["feet"], why: "SI." }]),
  ];
  for (const body of bodies) {
    const visible = body.trimEnd().split("\n").slice(0, -1).join("\n");
    const doc = markdownToAdf(visible);
    assert.equal(adfProblem(doc), null, visible);
  }
  const draft = markdownToAdf(draftBody(2, "New text.", "abc").split("\n").slice(0, -1).join("\n"));
  assert.equal(draft.content![0]?.type, "expand");
  assert.equal(draft.content![0]?.attrs?.title, "Triage, round 2: proposed description");
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
  assert.equal(markdownToWiki("```\nthe {code} macro\n```"), "{noformat}\nthe {code} macro\n{noformat}");
});

test("the Verification section is spliced into the ADF tree and the wiki text, everything else kept", () => {
  const panel = { type: "panel", attrs: { panelType: "info" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Kept." }] }] };
  const doc = { version: 1, type: "doc", content: [panel, { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Verification" }] }, { type: "paragraph", content: [{ type: "text", text: "Old." }] }, { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Notes" }] }] };
  const spliced = spliceAdfVerification(doc, "New.");
  assert.deepEqual(spliced.content![0], panel);
  assert.equal(adfToMarkdown(spliced).markdown, "> **Info:** Kept.\n\n## Verification\n\nNew.\n\n## Notes");
  assert.equal(spliceAdfVerification({ version: 1, type: "doc", content: [panel] }, "Added.").content?.length, 3);
  assert.deepEqual(spliceAdfVerification(doc, null).content, [panel, doc.content[3]]);
  assert.equal(spliceWikiVerification("{panel}Kept.{panel}\n\nh2. Verification\nOld.\n\nh2. Notes\nN.", "New."), "{panel}Kept.{panel}\n\nh2. Verification\n\nNew.\n\nh2. Notes\nN.");
  assert.equal(spliceWikiVerification("Text.", "Added."), "Text.\n\nh2. Verification\n\nAdded.");
  assert.match(JSON.stringify(writeDescription("cloud", doc, { description: "Flat." })), /refused/);
  assert.deepEqual(writeDescription("datacenter", "Plain.\n\nh2. Verification\nIt.", { description: "New." }), { value: "New.\n\nh2. Verification\n\nIt." });
});
