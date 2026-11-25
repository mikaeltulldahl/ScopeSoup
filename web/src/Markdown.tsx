// Item descriptions as markdown: headings, lists (nested), emphasis, code, links, tables, quotes and
// rules. The parser (`markdownParse.ts`) makes plain data; this builds elements from it, never HTML
// text, so nothing in an item can become markup. Anything it does not know stays text.
// Images agents attached (`media/<name>`) are shown from the Item's images when a `MediaContext` names them; images next to
// each other sit side by side (a before and after). An SVG is shown only in an <img>, where it runs no script.

import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import { imageParts, parseMarkdown } from "./markdownParse.ts";
import type { Block, Inline, MediaImage } from "./markdownParse.ts";

/** The Item's images as the page knows them: where they are served, which there are, and how one is deleted. */
export interface MediaView {
  /** `/media/<item key>/`. */
  base: string;
  names: ReadonlySet<string>;
  onDelete?: (name: string) => void;
}

export const MediaContext = createContext<MediaView | null>(null);

function Picture({ image }: { image: MediaImage }) {
  const media = useContext(MediaContext);
  if (!media || !media.names.has(image.name)) {
    return <span class="md-image-gone" title={image.name}>[image{image.alt ? `: ${image.alt}` : ""}, not here]</span>;
  }
  const onDelete = media.onDelete;
  return (
    <span class="md-figure">
      <a href={media.base + encodeURIComponent(image.name)} target="_blank" rel="noreferrer noopener">
        <img src={media.base + encodeURIComponent(image.name)} alt={image.alt || image.name} loading="lazy" />
      </a>
      <span class="md-figure-caption">
        <span>{image.alt || image.name}</span>
        {onDelete && (
          <button type="button" class="md-figure-delete" title={`Delete ${image.name}`} onClick={() => onDelete(image.name)}>
            Delete
          </button>
        )}
      </span>
    </span>
  );
}

function inlines(parts: Inline[]): ComponentChildren[] {
  return parts.map((part) => {
    if (typeof part === "string") return part;
    if (part.t === "img") return <Picture image={part} />;
    if (part.t === "code") return <code>{part.v}</code>;
    if (part.t === "b") return <strong>{inlines(part.c)}</strong>;
    if (part.t === "i") return <em>{inlines(part.c)}</em>;
    return <a href={part.href} rel="noreferrer noopener" target="_blank">{inlines(part.c)}</a>;
  });
}

/** True for a run made only of images and blanks: shown as a row of pictures. */
const onlyImages = (parts: readonly (Inline | MediaImage)[]): boolean =>
  parts.some((part) => typeof part !== "string" && part.t === "img") && parts.every((part) => (typeof part === "string" ? part.trim() === "" : part.t === "img"));

function render(block: Block): ComponentChildren {
  switch (block.t) {
    case "p":
      return onlyImages(block.c) ? <div class="md-images">{inlines(block.c)}</div> : <p>{inlines(block.c)}</p>;
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

/** The images a text refers to, as a row of pictures (each with its Delete), or nothing when it has none. */
export function TextImages({ text }: { text: string }) {
  const images = imageParts(text).filter((part): part is MediaImage => typeof part !== "string");
  return images.length === 0 ? null : <span class="md-images">{images.map((image) => <Picture image={image} />)}</span>;
}

/** The text without its images, for a place that cannot hold a picture (inside a button). */
export function withoutImages(text: string): string {
  return imageParts(text).filter((part): part is string => typeof part === "string").join("").replace(/\s+/g, " ").trim();
}

/**
 * Text an agent wrote, shown as it is (no markdown), with the images it refers to. Text without one is the text itself, so
 * it can stand where a string did; images next to each other sit side by side.
 */
export function AgentText({ text }: { text: string }) {
  const parts = imageParts(text);
  if (parts.length === 1 && typeof parts[0] === "string") return <>{text}</>;
  const out: ComponentChildren[] = [];
  let row: MediaImage[] = [];
  const flush = () => {
    if (row.length > 0) out.push(<span class="md-images">{row.map((image) => <Picture image={image} />)}</span>);
    row = [];
  };
  for (const part of parts) {
    if (typeof part !== "string") row.push(part);
    else if (part.trim() === "" && row.length > 0) continue;
    else {
      flush();
      out.push(part);
    }
  }
  flush();
  return <>{out}</>;
}
