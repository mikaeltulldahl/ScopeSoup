// Makes text that Scope Soup did not write (agent summaries, findings, issue text) inert on the
// host. The text still reads the same to a person; invisible characters stop GitHub from
// acting on it.

const ZWSP = "\u200b";

const CLOSING_KEYWORD = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi;

/**
 * Breaks GitHub's closing keywords (so "Fixes #3" in a pull request description cannot close
 * anything) and @-mentions (so nobody is notified). A zero-width space goes after the first
 * letter of a keyword and after an "@" that is followed by a letter or digit.
 */
export function inertText(text: string): string {
  return text
    .replace(CLOSING_KEYWORD, (word) => `${word.slice(0, 1)}${ZWSP}${word.slice(1)}`)
    .replace(/@(?=[\p{L}\p{N}])/gu, `@${ZWSP}`);
}

/** A file name for use inside a code span: no backticks, no live mention. */
export function inertFile(file: string): string {
  return inertText(file.replaceAll("`", ""));
}

/** Text with every hidden mark of Scope Soup's (`<!-- scopesoup:... -->`) taken out, so text from agents cannot pose as one. */
export function withoutMarks(text: string): string {
  return text.replace(/<!--\s*scopesoup:[\s\S]*?-->/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}
