// Shared by the two readers of Jira text (ADF on Cloud, wiki markup on Data Center): Markdown escaping of plain text, and the
// record of what a reader simplified. Pure.

/** What a conversion gave and what it could not keep as it was: node or macro names, once each, in the order met. */
export interface Converted {
  markdown: string;
  simplified: string[];
}

/** Collects the names of what was simplified, once each. */
export class Simplified {
  names: string[] = [];
  add(name: string): void {
    if (!this.names.includes(name)) this.names.push(name);
  }
}

/**
 * Plain text made safe as Markdown: the characters that would start emphasis, code, a link or HTML get a backslash; `_` only
 * where it could open or close emphasis (not inside a word such as snake_case). Line starts are `escapeLineStart`'s.
 */
export function escapeInline(text: string): string {
  return text
    .replace(/[\\`*[\]<]/g, (char) => `\\${char}`)
    .replace(/_/g, (char, at: number, all: string) => (/\w/.test(all[at - 1] ?? "") && /\w/.test(all[at + 1] ?? "") ? char : `\\${char}`));
}

/** A line that would read as a heading, quote, list item or rule gets a backslash before its marker. */
export function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)(#|>|[-+](?=\s|$)|\d+(?=[.)]\s)|={3,}|-{3,})/, (_all, space: string, marker: string) => `${space}\\${marker}`);
}

/** Trims the ends (code blocks inside keep their blank lines and spaces). */
export function tidy(markdown: string): string {
  return markdown.replace(/^\s*\n/, "").trimEnd();
}

/** A fence long enough for `code` (one backtick more than its longest run). */
export function fenceFor(code: string): string {
  let longest = 2;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(longest + 1);
}

/** Inline code that holds backticks: a longer backtick run around it. */
export function inlineCode(code: string): string {
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const ticks = "`".repeat(longest + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${ticks}${pad}${code}${pad}${ticks}`;
}
