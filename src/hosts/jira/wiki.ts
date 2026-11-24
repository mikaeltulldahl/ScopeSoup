// Jira wiki markup (Data Center's REST v2 text) read into Scope Soup's Markdown. Pure.
// Kept: headings, bold, italic, strikethrough, inline code, `{code}` and `{noformat}` blocks, quotes (`bq.` and `{quote}`), lists
// (`*`, `#`, `-`, nested), links, rules, tables and line breaks. Simplified, and named in `simplified`: `[~user]` becomes `@user`
// (no longer a mention), `{panel}` a quote, `{color}` and `+underline+` are dropped, images and attachments become
// `[attachment]`, anchors their text. A macro this reader does not know keeps its text and is named, never dropped silently.

import { type Converted, escapeInline, escapeLineStart, fenceFor, inlineCode, Simplified, tidy } from "./markdown.ts";

const INLINE = new RegExp(
  [
    String.raw`(?<brk>\\\\)`,
    String.raw`\\(?<esc>[^\\\s])`,
    String.raw`\{\{(?<code>.+?)\}\}`,
    String.raw`\[~(?<mention>[^\]]+)\]`,
    String.raw`\[(?<ltext>[^\]|]*)\|(?<lurl>[^\]]+)\]`,
    String.raw`\[(?<bare>[^\]|\n]+)\]`,
    String.raw`!(?<image>[^!\s][^!\n]*?)!`,
    String.raw`\{(?<macro>[a-zA-Z]+)(?::[^}]*)?\}`,
    String.raw`(?<![\w*])\*(?<strong>\S(?:.*?\S)?)\*(?![\w*])`,
    String.raw`(?<![\w_])_(?<em>\S(?:.*?\S)?)_(?![\w_])`,
    String.raw`(?<![\w-])-(?<strike>[^\s-](?:.*?[^\s-])?)-(?![\w-])`,
    String.raw`(?<![\w+])\+(?<under>\S(?:.*?\S)?)\+(?![\w+])`,
    String.raw`\?\?(?<cite>\S(?:.*?\S)?)\?\?`,
  ].join("|"),
  "g",
);

function inline(text: string, simplified: Simplified): string {
  let out = "";
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const groups = match.groups ?? {};
    out += escapeInline(text.slice(at, match.index));
    at = match.index + match[0].length;
    if (groups.brk !== undefined) out += "\\\n";
    else if (groups.esc !== undefined) out += escapeInline(groups.esc);
    else if (groups.code !== undefined) out += inlineCode(groups.code);
    else if (groups.mention !== undefined) {
      simplified.add("mention");
      out += escapeInline(`@${groups.mention}`);
    } else if (groups.lurl !== undefined) {
      out += linkTo(groups.ltext ?? "", groups.lurl, simplified);
    } else if (groups.bare !== undefined) {
      out += linkTo("", groups.bare, simplified);
    } else if (groups.image !== undefined) {
      simplified.add("image");
      out += "\\[attachment\\]";
    } else if (groups.macro !== undefined) {
      const name = groups.macro.toLowerCase();
      // `{color:red}` and its closing `{color}` are dropped; the text between them stays.
      simplified.add(name === "color" ? "color" : `macro ${name}`);
      if (name !== "color") out += escapeInline(match[0]);
    } else if (groups.strong !== undefined) out += `**${inline(groups.strong, simplified)}**`;
    else if (groups.em !== undefined) out += `*${inline(groups.em, simplified)}*`;
    else if (groups.strike !== undefined) out += `~~${inline(groups.strike, simplified)}~~`;
    else if (groups.under !== undefined) {
      simplified.add("underline");
      out += inline(groups.under, simplified);
    } else if (groups.cite !== undefined) out += `*${inline(groups.cite, simplified)}*`;
  }
  return out + escapeInline(text.slice(at));
}

function linkTo(label: string, target: string, simplified: Simplified): string {
  if (/^(https?|mailto|ftp):/i.test(target)) {
    const url = target.replace(/[()\s]/g, (char) => encodeURIComponent(char));
    return label ? `[${inline(label, simplified)}](${url})` : `<${target}>`;
  }
  // `[#anchor]`, `[^attachment.png]`, `[Some page]`: no URL Scope Soup can follow; the text stays.
  simplified.add(target.startsWith("^") ? "attachment link" : target.startsWith("#") ? "anchor" : "page link");
  return escapeInline(label || target.replace(/^[#^]/, ""));
}

const BLOCK_MACRO = /(?<![{\\])\{(code|noformat|quote|panel)(?::([^}]*))?\}([\s\S]*?)\{\1\}/g;

/** The language of `{code:java}` or `{code:language=java|title=x}`; none for `{code:title=x}`. */
function languageOf(params: string | undefined): string {
  if (!params) return "";
  for (const part of params.split("|")) {
    const [key, value] = part.split("=");
    if (value === undefined && key && /^[\w+#-]+$/.test(key)) return key;
    if (key?.trim() === "language" && value) return value.trim();
  }
  return "";
}

function listMarker(symbols: string, widths: number[]): { marker: string; indent: string } {
  const depth = symbols.length;
  const marker = symbols.endsWith("#") ? "1. " : "- ";
  widths.length = depth - 1 <= widths.length ? depth - 1 : widths.length;
  const indent = widths.reduce((sum, width) => sum + " ".repeat(width), "");
  widths.push(marker.length);
  return { marker, indent };
}

function tableRow(line: string, simplified: Simplified): { cells: string[]; header: boolean } {
  const header = line.startsWith("||");
  const cells = line.replace(/^\|\|?/, "").replace(/\|\|?\s*$/, "").split(/\|\|?/).map((cell) => inline(cell.trim(), simplified).replace(/\|/g, "\\|"));
  return { cells, header };
}

function convert(text: string, simplified: Simplified): string {
  const kept: string[] = [];
  const hold = (markdown: string): string => `\n\u0000${kept.push(markdown) - 1}\u0000\n`;
  const withBlocks = text.replace(/\r\n?/g, "\n").replace(BLOCK_MACRO, (_all, name: string, params: string | undefined, body: string) => {
    if (name === "code" || name === "noformat") {
      const code = body.replace(/^\n/, "").replace(/\n$/, "");
      const fence = fenceFor(code);
      return hold(`${fence}${name === "code" ? languageOf(params) : ""}\n${code}\n${fence}`);
    }
    if (name === "panel") simplified.add("panel");
    const inner = convert(body, simplified).trim();
    return hold(inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n"));
  });

  const out: string[] = [];
  const widths: number[] = [];
  let table: { rows: string[][]; headed: boolean } | null = null;
  const flushTable = (): void => {
    if (!table) return;
    const width = Math.max(...table.rows.map((row) => row.length));
    const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
    const [first = [], ...rest] = table.rows;
    out.push([line(first), `|${" --- |".repeat(width)}`, ...rest.map(line)].join("\n"), "");
    table = null;
  };
  for (const raw of withBlocks.split("\n")) {
    const line = raw.trimEnd();
    const trimmed = line.trimStart();
    if (/^\|/.test(trimmed)) {
      const row = tableRow(trimmed, simplified);
      if (!table) table = { rows: [], headed: row.header };
      table.rows.push(row.cells);
      continue;
    }
    flushTable();
    const list = /^([*#-]+)\s+(.*)$/.exec(trimmed);
    if (list?.[1] && !(list[1].length >= 4 && /^-+$/.test(list[1]))) {
      // `----` alone is a rule; `- text` and `*# text` are list items.
      const { marker, indent } = listMarker(list[1], widths);
      out.push(`${indent}${marker}${inline(list[2] ?? "", simplified)}`);
      continue;
    }
    widths.length = 0;
    const heading = /^h([1-6])\.\s+(.*)$/.exec(trimmed);
    if (heading) out.push(`${"#".repeat(Number(heading[1]))} ${inline(heading[2] ?? "", simplified)}`, "");
    else if (/^bq\.\s+/.test(trimmed)) out.push(`> ${inline(trimmed.replace(/^bq\.\s+/, ""), simplified)}`, "");
    else if (/^-{4,}$/.test(trimmed)) out.push("---", "");
    else if (/^\u0000\d+\u0000$/.test(trimmed)) out.push(trimmed, "");
    else if (trimmed === "") out.push("");
    else out.push(inline(trimmed, simplified).split("\n").map(escapeLineStart).join("\n"));
  }
  flushTable();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\u0000(\d+)\u0000/g, (_all, index: string) => kept[Number(index)] ?? "");
}

/** Wiki markup (or null, an empty field) as Markdown. */
export function wikiToMarkdown(text: string | null | undefined): Converted {
  const simplified = new Simplified();
  if (!text) return { markdown: "", simplified: [] };
  return { markdown: tidy(convert(text, simplified)), simplified: simplified.names };
}
