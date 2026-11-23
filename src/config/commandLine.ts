// A command as one line of text and back: the Settings page edits `checkCommand`, a list run without a shell, as text.
// Words are split at spaces; double quotes keep spaces inside one word. Nothing else is special. No I/O, so the board imports it.

/** The words of a command line: `pnpm run "a b"` is ["pnpm", "run", "a b"]. */
export function commandWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      inWord = true;
    } else if (!quoted && /\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** The command as one line, a word with a space (or none at all) in double quotes. */
export function commandText(words: readonly string[]): string {
  return words.map((word) => (word === "" || /\s/.test(word) ? `"${word}"` : word)).join(" ");
}
