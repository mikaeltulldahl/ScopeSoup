// Atlassian Document Format (Jira Cloud's REST v3 text) read into Scope Soup's Markdown. Pure.
// The common nodes become their Markdown; what Markdown cannot hold is simplified and named in `simplified`: a mention becomes
// `@name` (no longer a mention), a status lozenge `[TEXT]`, a panel a quote, media `[attachment]`, colour and underline are
// dropped, merged table cells are split. A node this reader does not know keeps its text and is named, never dropped silently.

import { type Converted, escapeInline, escapeLineStart, fenceFor, inlineCode, Simplified, tidy } from "./markdown.ts";

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

const str = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

/** Every text in the node and below, run together: what an unknown node keeps. */
function plainText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const own = str(node.attrs?.text) || str(node.attrs?.url);
  return own || (node.content ?? []).map(plainText).join("");
}

const DROPPED_MARKS = new Set(["underline", "textColor", "backgroundColor", "subsup", "alignment", "indentation", "border", "annotation", "fragment", "breakout", "dataConsumer"]);

/** Wraps `inner` in the marker, keeping spaces at the ends outside it (`** bold**` is not bold in Markdown). */
function wrap(inner: string, open: string, close = open): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  const [, before = "", core = "", after = ""] = match ?? [];
  return core ? `${before}${open}${core}${close}${after}` : inner;
}

function textNode(node: AdfNode, simplified: Simplified): string {
  const raw = node.text ?? "";
  const marks = node.marks ?? [];
  const has = (type: string) => marks.some((mark) => mark.type === type);
  let out = has("code") ? inlineCode(raw) : escapeInline(raw);
  if (has("em")) out = wrap(out, "*");
  if (has("strong")) out = wrap(out, "**");
  if (has("strike")) out = wrap(out, "~~");
  const link = marks.find((mark) => mark.type === "link");
  if (link) out = `[${out}](${str(link.attrs?.href).replace(/[()\s]/g, (char) => encodeURIComponent(char))})`;
  for (const mark of marks) {
    if (["code", "em", "strong", "strike", "link"].includes(mark.type)) continue;
    simplified.add(DROPPED_MARKS.has(mark.type) ? mark.type : `mark ${mark.type}`);
  }
  return out;
}

function inline(nodes: AdfNode[] | undefined, simplified: Simplified): string {
  let out = "";
  for (const node of nodes ?? []) {
    switch (node.type) {
      case "text":
        out += textNode(node, simplified);
        break;
      case "hardBreak":
        out += "\\\n";
        break;
      case "mention":
        simplified.add("mention");
        out += escapeInline(`@${str(node.attrs?.text).replace(/^@/, "") || str(node.attrs?.id)}`);
        break;
      case "emoji":
        out += escapeInline(str(node.attrs?.text) || str(node.attrs?.shortName));
        break;
      case "status":
        simplified.add("status");
        out += escapeInline(`[${str(node.attrs?.text)}]`);
        break;
      case "date": {
        const stamp = Number(node.attrs?.timestamp);
        out += Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : "";
        break;
      }
      case "inlineCard": {
        const url = str(node.attrs?.url);
        out += url ? `<${url}>` : "";
        break;
      }
      case "placeholder":
        break;
      default:
        simplified.add(node.type);
        out += escapeInline(plainText(node));
    }
  }
  return out;
}

/** Each line of `text` with `first` before the first line and `rest` before the others (empty lines stay empty). */
function prefixLines(text: string, first: string, rest: string): string {
  return text.split("\n").map((line, index) => (index === 0 ? first + line : line === "" ? rest.trimEnd() : rest + line)).join("\n");
}

function paragraphText(nodes: AdfNode[] | undefined, simplified: Simplified): string {
  return inline(nodes, simplified).split("\n").map(escapeLineStart).join("\n");
}

function listItem(item: AdfNode, marker: string, simplified: Simplified): string {
  const body = item.type === "listItem" ? blocks(item.content, simplified) : paragraphText(item.content, simplified);
  return prefixLines(body || "", marker, " ".repeat(marker.length));
}

function tableText(table: AdfNode, simplified: Simplified): string {
  const rows = (table.content ?? []).filter((row) => row.type === "tableRow");
  if (rows.length === 0) return "";
  const cells = rows.map((row) =>
    (row.content ?? []).map((cell) => {
      const span = Number(cell.attrs?.colspan ?? 1) * Number(cell.attrs?.rowspan ?? 1);
      if (span > 1) simplified.add("merged table cells");
      return blocks(cell.content, simplified).replace(/\n+/g, " ").replace(/\|/g, "\\|");
    }),
  );
  const width = Math.max(...cells.map((row) => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
  return [line(cells[0] ?? []), `|${" --- |".repeat(width)}`, ...cells.slice(1).map(line)].join("\n");
}

function block(node: AdfNode, simplified: Simplified): string {
  switch (node.type) {
    case "paragraph":
      return paragraphText(node.content, simplified);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${"#".repeat(level)} ${inline(node.content, simplified).replace(/\\\n/g, " ")}`;
    }
    case "bulletList":
      return (node.content ?? []).map((item) => listItem(item, "- ", simplified)).join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.order ?? 1) || 1;
      return (node.content ?? []).map((item, index) => listItem(item, `${start + index}. `, simplified)).join("\n");
    }
    case "taskList":
      return (node.content ?? []).map((item) => (item.type === "taskList" ? prefixLines(block(item, simplified), "  ", "  ") : listItem(item, item.attrs?.state === "DONE" ? "- [x] " : "- [ ] ", simplified))).join("\n");
    case "decisionList":
      simplified.add("decision");
      return (node.content ?? []).map((item) => listItem(item, "- ", simplified)).join("\n");
    case "codeBlock": {
      const code = (node.content ?? []).map((child) => child.text ?? "").join("");
      const fence = fenceFor(code);
      return `${fence}${str(node.attrs?.language)}\n${code}\n${fence}`;
    }
    case "blockquote":
      return prefixLines(blocks(node.content, simplified), "> ", "> ");
    case "rule":
      return "---";
    case "panel": {
      simplified.add("panel");
      const kind = str(node.attrs?.panelType) || "info";
      return prefixLines(`**${kind[0]?.toUpperCase()}${kind.slice(1)}:** ${blocks(node.content, simplified)}`, "> ", "> ");
    }
    case "expand":
    case "nestedExpand": {
      const title = escapeInline(str(node.attrs?.title)) || "Details";
      return `<details>\n<summary>${title}</summary>\n\n${blocks(node.content, simplified)}\n\n</details>`;
    }
    case "mediaSingle":
    case "mediaGroup":
    case "media":
    case "mediaInline":
      simplified.add("media");
      return "\\[attachment\\]";
    case "table":
      return tableText(node, simplified);
    case "blockCard":
    case "embedCard": {
      const url = str(node.attrs?.url);
      return url ? `<${url}>` : "";
    }
    default: {
      simplified.add(node.type);
      return plainText(node).split("\n").map((line) => escapeLineStart(escapeInline(line))).join("\n");
    }
  }
}

function blocks(nodes: AdfNode[] | undefined, simplified: Simplified): string {
  return (nodes ?? []).map((node) => block(node, simplified)).filter((text) => text !== "").join("\n\n");
}

/** An ADF document (or null, an empty field) as Markdown. A string is taken as plain text, as some old fields still hold. */
export function adfToMarkdown(doc: unknown): Converted {
  const simplified = new Simplified();
  if (doc === null || doc === undefined) return { markdown: "", simplified: [] };
  if (typeof doc === "string") return { markdown: tidy(doc), simplified: [] };
  const node = doc as AdfNode;
  if (typeof node !== "object" || typeof node.type !== "string") return { markdown: "", simplified: ["not ADF"] };
  const markdown = node.type === "doc" ? blocks(node.content, simplified) : block(node, simplified);
  return { markdown: tidy(markdown), simplified: simplified.names };
}
