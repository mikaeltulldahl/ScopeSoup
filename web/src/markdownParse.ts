// The markdown parser behind the board's item descriptions. It makes a tree of plain data, never
// HTML text, so nothing in an item can become markup; `Markdown.tsx` turns the tree into elements.
// No imports and no DOM, so the tests in `src/` run it directly.

export type Inline = string | { t: "code"; v: string } | { t: "b"; c: Inline[] } | { t: "i"; c: Inline[] } | { t: "a"; href: string; c: Inline[] } | MediaImage;

/**
 * An image an agent attached: `![alt](media/<name>)`. Only a relative `media/` path with a plain file name is one; the board
 * serves it from the Item's images (`src/core/media.ts`). Any other image syntax stays text: no URL is ever loaded.
 */
export type MediaImage = { t: "img"; name: string; alt: string };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "hr" }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; items: ListItem[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

export type ListItem = { c: Inline[]; children: Block[] };

/** Only these links are made; any other target stays plain text. */
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** The name of an image an agent attached, as `src/core/media.ts` accepts it. */
const MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,94}\.(png|jpe?g|gif|webp|svg)$/i;

const IMAGE = /!\[([^\]]*)\]\(media\/([^)\s]+)\)/g;

const image = (alt: string, name: string): MediaImage | null => (MEDIA_NAME.test(name) && !name.includes("..") ? { t: "img", name, alt: alt.trim() } : null);

/** Plain text with the images in it taken out, for agents' text the board shows as it is (a summary, a question, an option). */
export function imageParts(text: string): (string | MediaImage)[] {
  const parts: (string | MediaImage)[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(IMAGE.source, "g"))) {
    const found = image(m[1]!, m[2]!);
    if (!found) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(found);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const INLINE =
  /!\[([^\]]*)\]\(media\/([^)\s]+)\)|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\w*])\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_]+?)(?<=[^\s_])_(?![\w_])/g;

/** Images, inline code, links, bold and italic in one run of text. */
export function inline(text: string): Inline[] {
  const parts: Inline[] = [];
  const pattern = new RegExp(INLINE.source, "g");
  let last = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] !== undefined) parts.push(image(m[1]!, m[2]) ?? m[0]);
    else if (m[3] !== undefined) parts.push({ t: "code", v: m[3] });
    else if (m[4] !== undefined) {
      if (SAFE_URL.test(m[5]!)) parts.push({ t: "a", href: m[5]!, c: inline(m[4]) });
      else parts.push(m[0]);
    } else if (m[6] !== undefined) parts.push({ t: "b", c: inline(m[6]) });
    else parts.push({ t: "i", c: inline((m[7] ?? m[8])!) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const HEADING = /^(#{1,6})\s+(.*?)(\s+#+)?\s*$/;
const MARKER = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^(\s*)(```+|~~~+)\s*([^\s`]*)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function indentOf(text: string): number {
  return text.match(/^[ \t]*/)![0].replace(/\t/g, "    ").length;
}

function cells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function startsTable(lines: string[], i: number): boolean {
  return lines[i]!.includes("|") && i + 1 < lines.length && lines[i + 1]!.includes("-") && TABLE_SEPARATOR.test(lines[i + 1]!) && cells(lines[i]!).length > 1;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return FENCE.test(line) || HEADING.test(line) || MARKER.test(line) || RULE.test(line) || QUOTE.test(line) || startsTable(lines, i);
}

/** A fenced code block starting at line `i`; returns the block and the next line. */
function fenced(lines: string[], i: number): [Block, number] {
  const open = FENCE.exec(lines[i]!)!;
  const strip = open[1]!.length;
  const code: string[] = [];
  i++;
  while (i < lines.length && !(lines[i]!.trim().startsWith(open[2]!) && lines[i]!.trim().replace(/[`~]/g, "") === "")) {
    code.push(lines[i]!.slice(Math.min(strip, indentOf(lines[i]!))));
    i++;
  }
  return [{ t: "code", lang: open[3]!, v: code.join("\n") }, i + 1];
}

function list(lines: string[], start: number, indent: number): [Block, number] {
  let i = start;
  const first = MARKER.exec(lines[i]!)!;
  const ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  while (i < lines.length) {
    const m = MARKER.exec(lines[i]!);
    if (!m || indentOf(m[1]!) !== indent || /\d/.test(m[2]!) !== ordered) break;
    const text = [m[3]!];
    const children: Block[] = [];
    i++;
    let afterBlank = false;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim() === "") {
        // A blank line keeps the list going only when the next line belongs to it.
        let j = i;
        while (j < lines.length && lines[j]!.trim() === "") j++;
        if (j >= lines.length || indentOf(lines[j]!) <= indent && !MARKER.test(lines[j]!)) break;
        if (MARKER.test(lines[j]!) && indentOf(lines[j]!) < indent) break;
        i = j;
        afterBlank = true;
        continue;
      }
      const marker = MARKER.exec(line);
      const depth = indentOf(line);
      if (marker && depth > indent) {
        const [block, next] = list(lines, i, depth);
        children.push(block);
        i = next;
      } else if (marker) {
        break;
      } else if (FENCE.test(line) && depth > indent) {
        const [block, next] = fenced(lines, i);
        children.push(block);
        i = next;
      } else if (depth > indent || (!afterBlank && !startsBlock(lines, i))) {
        if (children.length === 0 && !afterBlank) text.push(line.trim());
        else children.push({ t: "p", c: inline(line.trim()) });
        i++;
      } else break;
      afterBlank = false;
    }
    items.push({ c: inline(text.join(" ")), children });
  }
  return [{ t: "list", ordered, items }, i];
}

export function parseMarkdown(source: string): Block[] {
  return blocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
    } else if (FENCE.test(line)) {
      const [block, next] = fenced(lines, i);
      out.push(block);
      i = next;
    } else if (HEADING.test(line)) {
      const m = HEADING.exec(line)!;
      // Headings inside an item sit below the page's own: h4 and smaller.
      out.push({ t: "h", level: Math.min(6, m[1]!.length + 3), c: inline(m[2]!) });
      i++;
    } else if (RULE.test(line)) {
      out.push({ t: "hr" });
      i++;
    } else if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && (QUOTE.test(lines[i]!) || !startsBlock(lines, i))) inner.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ""));
      out.push({ t: "quote", c: blocks(inner) });
    } else if (startsTable(lines, i)) {
      const head = cells(line).map(inline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) rows.push(cells(lines[i++]!).map(inline));
      out.push({ t: "table", head, rows });
    } else if (MARKER.test(line)) {
      const [block, next] = list(lines, i, indentOf(MARKER.exec(line)![1]!));
      out.push(block);
      i = next;
    } else {
      const paragraph: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && (paragraph.length === 0 || !startsBlock(lines, i))) paragraph.push(lines[i++]!.trim());
      out.push({ t: "p", c: inline(paragraph.join(" ")) });
    }
  }
  return out;
}
