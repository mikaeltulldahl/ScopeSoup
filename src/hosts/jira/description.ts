// Writing an issue's description on Jira without flattening what Scope Soup cannot write (docs/research/jira.md, section 3).
// A new Verification section is spliced into the description as it stands: in the ADF tree (Cloud) or the wiki text (Data
// Center), every other node or line kept exactly. A new description replaces the text whole, so it is refused while the
// description holds nodes Scope Soup's Markdown cannot hold (a panel, a mention, a macro). Pure.

import { spliceBody } from "../github/map.ts";
import type { AdfNode } from "./adf.ts";
import { adfToMarkdown } from "./adf.ts";
import type { Deployment } from "./client.ts";
import { markdownToAdf, markdownToAdfBlocks, markdownToWiki } from "./toJira.ts";
import { wikiToMarkdown } from "./wiki.ts";

/** Markdown in the deployment's text format: an ADF document on Cloud, wiki markup on Data Center. */
export const toJiraText = (deployment: Deployment, markdown: string): unknown => (deployment === "cloud" ? markdownToAdf(markdown) : markdownToWiki(markdown));

const textIn = (node: AdfNode): string => (node.type === "text" ? node.text ?? "" : (node.content ?? []).map(textIn).join(""));
const isSectionHeading = (node: AdfNode): boolean => node.type === "heading" && Number(node.attrs?.level ?? 1) <= 2;
const isVerification = (node: AdfNode): boolean => isSectionHeading(node) && textIn(node).trim().toLowerCase() === "verification";

/**
 * The ADF document with its last top-level Verification section (a heading of level 1 or 2, to the next such heading) set to `text`;
 * null or empty removes it. With no section and nothing to write, the document comes back as it was (null stays null).
 */
export function spliceAdfVerification(doc: unknown, text: string | null): unknown {
  const content: AdfNode[] = doc && typeof doc === "object" && (doc as AdfNode).type === "doc" ? [...((doc as AdfNode).content ?? [])] : [];
  let start = -1;
  content.forEach((node, index) => {
    if (isVerification(node)) start = index;
  });
  let end = content.length;
  if (start >= 0) for (let index = start + 1; index < content.length; index += 1) if (isSectionHeading(content[index]!)) {
    end = index;
    break;
  }
  const wanted = (text ?? "").trim();
  if (start < 0 && !wanted) return doc;
  const section: AdfNode[] = wanted ? [start >= 0 ? content[start]! : { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Verification" }] }, ...markdownToAdfBlocks(wanted)] : [];
  const next = start >= 0 ? [...content.slice(0, start), ...section, ...content.slice(end)] : [...content, ...section];
  return { version: 1, type: "doc", content: next };
}

const WIKI_SECTION = /^\s*h[12]\.\s/;
const WIKI_VERIFICATION = /^\s*h[12]\.\s+verification\s*$/i;

/** The block macros whose inside is not the description's own structure: a heading there is the macro's, not a section. */
const WIKI_BLOCK_MACRO = /\{(code|noformat|panel|quote)(?::[^}]*)?\}/gi;

/**
 * The wiki text with its last Verification section (`h1.` or `h2.`, to the next such heading, outside `{code}`, `{noformat}`,
 * `{panel}` and `{quote}`) set to `text`; null or empty removes it. A Verification heading inside such a macro is the macro's own:
 * a new section is added at the end instead, and the macro is left whole. With no section and nothing to write, the text is unchanged.
 */
export function spliceWikiVerification(wiki: string, text: string | null): string {
  const lines = wiki.replace(/\r\n?/g, "\n").split("\n");
  // Each macro name opens and closes with the same tag (`{panel:title=x}` ... `{panel}`); inside code nothing else counts.
  const open = new Set<string>();
  let start = -1;
  let end = lines.length;
  const headings: number[] = [];
  lines.forEach((line, index) => {
    if (open.size === 0 && WIKI_SECTION.test(line)) {
      headings.push(index);
      if (WIKI_VERIFICATION.test(line)) start = index;
    }
    for (const match of line.matchAll(WIKI_BLOCK_MACRO)) {
      const name = (match[1] ?? "").toLowerCase();
      const inCode = open.has("code") || open.has("noformat");
      if (inCode && name !== "code" && name !== "noformat") continue;
      if (open.has(name)) open.delete(name);
      else if (!inCode) open.add(name);
    }
  });
  if (start >= 0) end = headings.find((index) => index > start) ?? lines.length;
  const wanted = (text ?? "").trim();
  if (start < 0 && !wanted) return wiki;
  const section = wanted ? [start >= 0 ? lines[start]! : "h2. Verification", "", markdownToWiki(wanted)] : [];
  const trim = (part: string[]): string[] => {
    const copy = [...part];
    while (copy.length > 0 && copy[copy.length - 1]!.trim() === "") copy.pop();
    return copy;
  };
  const before = trim(start >= 0 ? lines.slice(0, start) : lines);
  const after = start >= 0 ? lines.slice(end) : [];
  return [...before, ...(before.length > 0 && section.length > 0 ? [""] : []), ...section, ...(after.length > 0 && (before.length > 0 || section.length > 0) ? [""] : []), ...after].join("\n").trim();
}

/** What a description write gives: the new field value, or why it is refused. */
export type DescriptionWrite = { value: unknown } | { refused: string };

/**
 * The description field after `change`. A new verification alone is spliced in and keeps every other node. A new description
 * keeps the Verification section as text and replaces the rest; it is refused when the description as it stands holds what the
 * Markdown subset cannot write back, so a person's panel or mention is never flattened.
 */
export function writeDescription(deployment: Deployment, current: unknown, change: { description?: string; verification?: string | null }): DescriptionWrite {
  const read = deployment === "cloud" ? adfToMarkdown(current) : wikiToMarkdown(typeof current === "string" ? current : null);
  if (change.description === undefined) {
    if (change.verification === undefined) return { value: current };
    return { value: deployment === "cloud" ? spliceAdfVerification(current, change.verification) : spliceWikiVerification(typeof current === "string" ? current : "", change.verification) };
  }
  if (read.simplified.length > 0) return { refused: `its description on Jira holds what Scope Soup cannot write back (${read.simplified.join(", ")}), so replacing it would lose that; edit it on Jira` };
  return { value: toJiraText(deployment, spliceBody(read.markdown, change)) };
}
