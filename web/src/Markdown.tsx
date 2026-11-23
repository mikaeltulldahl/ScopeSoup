// Item descriptions as markdown: headings, lists (nested), emphasis, code, links, tables, quotes and
// rules. The parser (`markdownParse.ts`) makes plain data; this builds elements from it, never HTML
// text, so nothing in an item can become markup. Anything it does not know stays text.

import type { ComponentChildren } from "preact";
import { parseMarkdown } from "./markdownParse.ts";
import type { Block, Inline } from "./markdownParse.ts";

function inlines(parts: Inline[]): ComponentChildren[] {
  return parts.map((part) => {
    if (typeof part === "string") return part;
    if (part.t === "code") return <code>{part.v}</code>;
    if (part.t === "b") return <strong>{inlines(part.c)}</strong>;
    if (part.t === "i") return <em>{inlines(part.c)}</em>;
    return <a href={part.href} rel="noreferrer noopener" target="_blank">{inlines(part.c)}</a>;
  });
}

function render(block: Block): ComponentChildren {
  switch (block.t) {
    case "p":
      return <p>{inlines(block.c)}</p>;
    case "h": {
      const Tag = `h${block.level}` as "h4" | "h5" | "h6";
      return <Tag class="md-heading">{inlines(block.c)}</Tag>;
    }
    case "code":
      return <pre class="md-code" data-lang={block.lang || undefined}><code>{block.v}</code></pre>;
    case "hr":
      return <hr class="md-rule" />;
    case "quote":
      return <blockquote class="md-quote">{block.c.map(render)}</blockquote>;
    case "list": {
      const items = block.items.map((item) => <li>{inlines(item.c)}{item.children.map(render)}</li>);
      return block.ordered ? <ol class="md-list">{items}</ol> : <ul class="md-list">{items}</ul>;
    }
    case "table":
      return (
        <div class="md-table">
          <table>
            <thead><tr>{block.head.map((cell) => <th>{inlines(cell)}</th>)}</tr></thead>
            <tbody>{block.rows.map((row) => <tr>{row.map((cell) => <td>{inlines(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  return <div class="md">{parseMarkdown(text).map(render)}</div>;
}
