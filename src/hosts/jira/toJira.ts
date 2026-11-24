// Scope Soup's Markdown written as Jira text: ADF for Jira Cloud (REST v3), wiki markup for Data Center (REST v2). Pure.
// A small subset is kept: paragraphs, headings, bullet and numbered lists (nested), fenced code, quotes, rules, `<details>` (an
// expand on Cloud, a bold title on Data Center), and inline bold, italic, strikethrough, code and links. Anything else is text.
//
// Made inert: no mention, no macro, no image, no smart link is ever written. On Cloud an `@name` in a text node is only text and
// only `link` marks with http(s) or mailto addresses are made; on Data Center every character that could start a mention
// (`[~name]`), a macro (`{html}`), an image (`!x!`), a link or a table is escaped. Newlines inside a paragraph are line breaks, as
// GitHub shows them in comments. Inert text from agents (`inertText`) is still made inert by the caller; this keeps it so.

import type { AdfNode } from "./adf.ts";

// --- the Markdown subset, parsed ---

export type Block =
  | { t: "heading"; level: number; text: string }
  | { t: "paragraph"; text: string }
  | { t: "code"; lang: string; code: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "rule" }
  | { t: "details"; summary: string; blocks: Block[] };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const DETAILS_OPEN = /^\s*<details>\s*(?:<summary>(.*?)<\/summary>\s*)?$/i;
const SUMMARY = /^\s*<summary>(.*?)<\/summary>\s*$/i;
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;

const startsBlock = (line: string): boolean => FENCE_OPEN.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || DETAILS_OPEN.test(line);

/** Removes up to `width` leading spaces (a tab counts as four). */
function dedent(line: string, width: number): string {
  let at = 0;
  let taken = 0;
  while (at < line.length && taken < width) {
    if (line[at] === " ") taken += 1;
    else if (line[at] === "\t") taken += 4;
    else break;
    at += 1;
  }
  return line.slice(at);
}

const indentOf = (line: string): number => {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
};

export function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence?.[1]) {
      const marker = fence[1];
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i] ?? "")) code.push(lines[i++] ?? "");
      i += 1;
      blocks.push({ t: "code", lang: fence[2] ?? "", code: code.join("\n") });
      continue;
    }
    const details = DETAILS_OPEN.exec(line);
    if (details) {
      let summary = details[1] ?? "";
      i += 1;
      if (!details[1] && SUMMARY.test(lines[i] ?? "")) summary = SUMMARY.exec(lines[i++] ?? "")?.[1] ?? "";
      const inner: string[] = [];
      let depth = 0;
      while (i < lines.length) {
        const each = lines[i] ?? "";
        if (DETAILS_OPEN.test(each)) depth += 1;
        if (DETAILS_CLOSE.test(each)) {
          if (depth === 0) break;
          depth -= 1;
        }
        inner.push(each);
        i += 1;
      }
      i += 1;
      blocks.push({ t: "details", summary: summary.trim(), blocks: parseBlocks(inner) });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1]) {
      blocks.push({ t: "heading", level: heading[1].length, text: heading[2] ?? "" });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ t: "rule" });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) inner.push(QUOTE.exec(lines[i++] ?? "")?.[1] ?? "");
      blocks.push({ t: "quote", blocks: parseBlocks(inner) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2] ?? "");
      const start = ordered ? Number.parseInt(item[2] ?? "1", 10) : 1;
      const items: Block[][] = [];
      while (i < lines.length) {
        const head = ITEM.exec(lines[i] ?? "");
        if (!head || /\d/.test(head[2] ?? "") !== ordered) break;
        const width = (head[1] ?? "").length + (head[2] ?? "").length + Math.max(1, Math.min(4, (head[3] ?? " ").length));
        const own: string[] = [head[4] ?? ""];
        i += 1;
        while (i < lines.length) {
          const next = lines[i] ?? "";
          if (next.trim() === "") {
            // A blank line goes on the item only when an indented line follows it.
            let ahead = i;
            while (ahead < lines.length && (lines[ahead] ?? "").trim() === "") ahead += 1;
            if (ahead < lines.length && indentOf(lines[ahead] ?? "") >= width) {
              for (; i < ahead; i += 1) own.push("");
              continue;
            }
            break;
          }
          if (indentOf(next) >= width) own.push(dedent(next, width));
          else if (!startsBlock(next) && own[own.length - 1]?.trim() !== "") own.push(next.trim());
          else break;
          i += 1;
        }
        items.push(parseBlocks(own));
      }
      blocks.push({ t: "list", ordered, start, items });
      continue;
    }
    const text: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && (text.length === 0 || !startsBlock(lines[i] ?? ""))) text.push((lines[i++] ?? "").replace(/^ {0,3}/, ""));
    blocks.push({ t: "paragraph", text: text.join("\n") });
  }
  return blocks;
}

// --- inline ---

export interface Span {
  text: string;
  strong?: true;
  em?: true;
  strike?: true;
  code?: true;
  href?: string;
  /** A line break. */
  br?: true;
}

type Marks = Omit<Span, "text" | "br">;

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
/** Addresses a link may have: anything else stays text, so nothing but a plain web or mail link is made. */
export const safeHref = (url: string): boolean => /^(https?:\/\/|mailto:)[^\s<>"]+$/i.test(url);

/** Where the closing `delimiter` of a run opened at `from` is, or -1. Code spans and links are skipped. */
function closing(text: string, from: number, delimiter: string): number {
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(text.slice(at))?.[0] ?? "`";
      const end = text.indexOf(run, at + run.length);
      if (end > 0) at = end + run.length - 1;
      continue;
    }
    if (text.startsWith(delimiter, at) && at > from && !/\s/.test(text[at - 1] ?? "")) {
      // `_` closes only at a word's end, and `*` must not be part of a longer run meant as another delimiter.
      if (delimiter[0] === "_" && /\w/.test(text[at + delimiter.length] ?? "")) continue;
      if (delimiter === "*" && text[at + 1] === "*") {
        at += 1;
        continue;
      }
      return at;
    }
  }
  return -1;
}

export function parseInline(text: string, marks: Marks = {}): Span[] {
  const out: Span[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) out.push({ text: plain, ...marks });
    plain = "";
  };
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    const rest = text.slice(at);
    if (char === "\\" && text[at + 1] === "\n") {
      flush();
      out.push({ text: "", br: true });
      at += 1;
      continue;
    }
    if (char === "\\" && PUNCT.test(text[at + 1] ?? "")) {
      plain += text[at + 1];
      at += 1;
      continue;
    }
    if (char === "\n") {
      plain = plain.replace(/ +$/, "");
      flush();
      out.push({ text: "", br: true });
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(rest)?.[0] ?? "`";
      const end = text.indexOf(run, at + run.length);
      if (end > 0 && text[end + run.length] !== "`") {
        flush();
        let code = text.slice(at + run.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(code) && code.trim() !== "") code = code.slice(1, -1);
        out.push({ text: code, code: true, ...(marks.href ? { href: marks.href } : {}) });
        at = end + run.length - 1;
        continue;
      }
      plain += run;
      at += run.length - 1;
      continue;
    }
    if (char === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
      if (auto?.[1]) {
        flush();
        out.push({ text: auto[1], ...marks, ...(safeHref(auto[1]) ? { href: auto[1] } : {}) });
        at += auto[0].length - 1;
        continue;
      }
    }
    if (char === "[" && !marks.href) {
      const link = /^\[((?:\\.|[^\]\\])*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (link) {
        flush();
        const url = (link[2] ?? "").replace(/%28/gi, "(").replace(/%29/gi, ")").replace(/%20/g, " ");
        const inner = parseInline(link[1] ?? "", safeHref(url.replace(/ /g, "%20")) ? { ...marks, href: url.replace(/ /g, "%20") } : marks);
        out.push(...inner);
        if (!safeHref(url.replace(/ /g, "%20")) && url) out.push({ text: ` (${url})`, ...marks });
        at += link[0].length - 1;
        continue;
      }
    }
    let matched = false;
    for (const [delimiter, mark] of [["**", "strong"], ["__", "strong"], ["~~", "strike"], ["*", "em"], ["_", "em"]] as const) {
      if (!rest.startsWith(delimiter) || marks[mark]) continue;
      if (/\s/.test(text[at + delimiter.length] ?? " ")) continue;
      if (delimiter[0] === "_" && /\w/.test(text[at - 1] ?? "")) continue;
      const end = closing(text, at + delimiter.length, delimiter);
      if (end < 0) continue;
      flush();
      out.push(...parseInline(text.slice(at + delimiter.length, end), { ...marks, [mark]: true }));
      at = end + delimiter.length - 1;
      matched = true;
      break;
    }
    if (!matched) plain += char;
  }
  flush();
  return out;
}

const textOfSpans = (spans: Span[]): string => spans.map((span) => (span.br ? " " : span.text)).join("");

// --- ADF ---

function adfInline(spans: Span[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  for (const span of spans) {
    if (span.br) {
      nodes.push({ type: "hardBreak" });
      continue;
    }
    if (!span.text) continue;
    const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
    // ADF allows `code` only with `link`.
    if (span.code) marks.push({ type: "code" });
    else {
      if (span.strong) marks.push({ type: "strong" });
      if (span.em) marks.push({ type: "em" });
      if (span.strike) marks.push({ type: "strike" });
    }
    if (span.href) marks.push({ type: "link", attrs: { href: span.href } });
    nodes.push({ type: "text", text: span.text, ...(marks.length > 0 ? { marks } : {}) });
  }
  // A paragraph does not end in a line break.
  while (nodes[nodes.length - 1]?.type === "hardBreak") nodes.pop();
  return nodes;
}

const paragraph = (spans: Span[]): AdfNode => {
  const content = adfInline(spans);
  return { type: "paragraph", ...(content.length > 0 ? { content } : {}) };
};

type Place = "top" | "expand" | "quote" | "item";

function adfBlocks(blocks: Block[], place: Place): AdfNode[] {
  const out: AdfNode[] = [];
  for (const block of blocks) {
    switch (block.t) {
      case "paragraph":
        out.push(paragraph(parseInline(block.text)));
        break;
      case "heading":
        // Quotes and list items take no headings: a bold paragraph instead.
        if (place === "quote" || place === "item") out.push(paragraph(parseInline(block.text, { strong: true })));
        else {
          const content = adfInline(parseInline(block.text));
          out.push({ type: "heading", attrs: { level: block.level }, ...(content.length > 0 ? { content } : {}) });
        }
        break;
      case "code":
        out.push({ type: "codeBlock", ...(block.lang ? { attrs: { language: block.lang } } : {}), ...(block.code ? { content: [{ type: "text", text: block.code }] } : {}) });
        break;
      case "quote":
        if (place === "quote" || place === "item") out.push(...adfBlocks(block.blocks, place));
        else out.push({ type: "blockquote", content: nonEmpty(adfBlocks(block.blocks, "quote")) });
        break;
      case "list": {
        const items = block.items.map((item) => {
          const content = adfBlocks(item, "item");
          // A list item starts with a paragraph or a code block.
          if (content.length === 0 || !["paragraph", "codeBlock"].includes(content[0]!.type)) content.unshift({ type: "paragraph" });
          return { type: "listItem", content };
        });
        out.push(block.ordered ? { type: "orderedList", ...(block.start !== 1 ? { attrs: { order: block.start } } : {}), content: items } : { type: "bulletList", content: items });
        break;
      }
      case "rule":
        if (place === "top" || place === "expand") out.push({ type: "rule" });
        break;
      case "details":
        if (place === "top") out.push({ type: "expand", attrs: { title: textOfSpans(parseInline(block.summary)) }, content: nonEmpty(adfBlocks(block.blocks, "expand")) });
        else {
          if (block.summary) out.push(paragraph(parseInline(block.summary, { strong: true })));
          out.push(...adfBlocks(block.blocks, place));
        }
        break;
    }
  }
  return out;
}

const nonEmpty = (nodes: AdfNode[]): AdfNode[] => (nodes.length > 0 ? nodes : [{ type: "paragraph" }]);

/** Markdown as one ADF block list (no `doc` around it). */
export const markdownToAdfBlocks = (markdown: string): AdfNode[] => adfBlocks(parseBlocks(markdown.replace(/\r\n?/g, "\n").split("\n")), "top");

/** Markdown as an ADF document, Jira Cloud's text. */
export function markdownToAdf(markdown: string): AdfNode & { version: 1 } {
  return { version: 1, type: "doc", content: markdownToAdfBlocks(markdown) };
}

// --- wiki markup ---

const ZWSP = "​";
/** Wiki characters that start a macro, link, mention, image or table cell: always escaped. */
const ALWAYS = new Set(["{", "}", "[", "]", "!", "|"]);
/** Wiki characters that start or end a mark (`*bold*`, `_em_`, `-strike-`, `+under+`, `^sup^`, `~sub~`) at a word's edge. */
const EDGE = new Set(["*", "_", "-", "+", "^", "~"]);

/** Plain text as wiki markup that means only that text. */
export function wikiEscape(text: string): string {
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    const before = text[at - 1] ?? " ";
    const after = text[at + 1] ?? " ";
    if (char === "\\") {
      // `\\` is a line break in wiki markup, and `\x` an escape: a backslash keeps its meaning only alone.
      out += /[\s\w]/.test(after) || at + 1 >= text.length ? "\\" : `\\${ZWSP}`;
    } else if (ALWAYS.has(char)) out += `\\${char}`;
    else if (EDGE.has(char) && ((!/\w/.test(before) && !/\s/.test(after)) || (!/\s/.test(before) && !/\w/.test(after)))) out += `\\${char}`;
    else if (char === "?" && (before === "?" || after === "?")) out += "\\?";
    else out += char;
  }
  return out;
}

/** A line of wiki markup that would read as a heading, quote, list, rule or table gets its start escaped. */
function wikiLineStart(line: string): string {
  return line
    .replace(/^(\s*)(h[1-6]|bq)\.(\s)/, "$1$2\\.$3")
    .replace(/^(\s*)([*#-]+)(?=\s|$)/, (_all, space: string, marker: string) => `${space}\\${marker}`);
}

function wikiInline(spans: Span[]): string {
  let out = "";
  for (const span of spans) {
    if (span.br) {
      out += "\n";
      continue;
    }
    if (!span.text) continue;
    let text = span.code ? `{{${wikiCodeEscape(span.text)}}}` : wikiEscape(span.text);
    if (!span.code) {
      if (span.strike) text = `-${text}-`;
      if (span.em) text = `_${text}_`;
      if (span.strong) text = `*${text}*`;
    }
    if (span.href) text = `[${text}|${span.href.replace(/[|\]]/g, (char) => encodeURIComponent(char))}]`;
    out += text;
  }
  return out.replace(/\n+$/, "");
}

const wikiParagraph = (text: string, marks: Marks = {}): string => wikiInline(parseInline(text, marks)).split("\n").map(wikiLineStart).join("\n");

function wikiCode(block: { lang: string; code: string }): string {
  // A code block ends at the first `{code}`: every `{code` and `{noformat` in the code (with parameters or not) gets a zero-width
  // space, so none can close the block or open another.
  const code = block.code.replace(/\{(code|noformat)/gi, `{${ZWSP}$1`);
  const lang = /^[\w+#-]+$/.test(block.lang) ? `:${block.lang}` : "";
  return `{code${lang}}\n${code}\n{code}`;
}

/** Wiki characters that still act inside `{{monospace}}`: all escaped there, a backslash kept as text. */
const CODE_LIVE = new Set(["{", "}", "[", "]", "!", "|", "*", "_", "-", "+", "^", "~", "?", "#"]);

/** Text for inside `{{...}}`: wiki markup still acts there (a mention, a link, an image, bold), so every such character is escaped. */
export function wikiCodeEscape(text: string): string {
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    const after = text[at + 1] ?? "";
    if (char === "\\") out += CODE_LIVE.has(after) || after === "\\" || after === "" ? `\\${ZWSP}` : "\\";
    else out += CODE_LIVE.has(char) ? `\\${char}` : char;
  }
  return out;
}

function wikiBlocks(blocks: Block[], depth: string): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.t) {
      case "paragraph":
        out.push(wikiParagraph(block.text));
        break;
      case "heading":
        out.push(`h${block.level}. ${wikiInline(parseInline(block.text)).replace(/\n/g, " ")}`);
        break;
      case "code":
        out.push(wikiCode(block));
        break;
      case "quote":
        out.push(`{quote}\n${wikiBlocks(block.blocks, "").join("\n\n")}\n{quote}`);
        break;
      case "rule":
        out.push("----");
        break;
      case "details":
        if (block.summary) out.push(wikiParagraph(block.summary, { strong: true }));
        out.push(...wikiBlocks(block.blocks, depth));
        break;
      case "list": {
        const marker = `${depth}${block.ordered ? "#" : "*"}`;
        const lines: string[] = [];
        for (const item of block.items) {
          const [first, ...rest] = item;
          const head = first?.t === "paragraph" ? wikiInline(parseInline(first.text)).replace(/\n/g, " ") : "";
          lines.push(`${marker} ${head}`);
          for (const more of first?.t === "paragraph" ? rest : item) {
            if (more.t === "list") lines.push(...wikiBlocks([more], marker));
            else lines.push(...wikiBlocks([more], marker).map((text) => text));
          }
        }
        out.push(lines.join("\n"));
        break;
      }
    }
  }
  return out;
}

/** Markdown as Jira wiki markup, Data Center's text. */
export function markdownToWiki(markdown: string): string {
  return wikiBlocks(parseBlocks(markdown.replace(/\r\n?/g, "\n").split("\n")), "").join("\n\n");
}
