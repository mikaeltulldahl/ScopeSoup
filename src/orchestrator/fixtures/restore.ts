// Follows a record's RESTORE.md literally: the commands of its `sh` block, parsed as a POSIX shell
// would (single-quoted words), run one by one. Only the commands RESTORE.md uses are understood;
// anything else fails the test.

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSyncRetrying } from "../../hosts/spawnRetry.ts";

/** The words of one command line: plain words, and single-quoted ones with `'\''` for a quote. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? "";
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) throw new Error(`unclosed quote in: ${line}`);
      word = (word ?? "") + line.slice(index + 1, end);
      index = end;
    } else if (char === "\\") {
      word = (word ?? "") + (line[index + 1] ?? "");
      index++;
    } else if (char === " ") {
      if (word !== null) words.push(word);
      word = null;
    } else if (/[;&|<>$`"*?]/.test(char)) {
      throw new Error(`RESTORE.md uses shell syntax this test does not follow (${char}): ${line}`);
    } else word = (word ?? "") + char;
  }
  if (word !== null) words.push(word);
  return words;
}

/** The commands of RESTORE.md's `sh` block, as words. Empty when it has none. */
export function restoreCommands(record: string): string[][] {
  const text = readFileSync(join(record, "RESTORE.md"), "utf8");
  const block = /```sh\n([\s\S]*?)```/.exec(text);
  return block ? (block[1] ?? "").split("\n").filter((line) => line.trim() !== "").map(shellWords) : [];
}

/** Runs them, in order. */
export function followRestore(record: string): string[][] {
  const commands = restoreCommands(record);
  let cwd = process.cwd();
  for (const [command, ...words] of commands) {
    // `--` ends the options, as the shell's own mkdir and cp read it; an operand never starts with `-` here.
    const end = words.indexOf("--");
    const options = end < 0 ? words : words.slice(0, end);
    const args = end < 0 ? [] : words.slice(end + 1);
    const operandsSafe = args.every((arg) => !arg.startsWith("-"));
    if (command === "cd" && words.length === 1) cwd = resolve(cwd, words[0] ?? "");
    else if (command === "git" && end >= 0 && operandsSafe) execFileSyncRetrying("git", words, { cwd, stdio: "pipe" });
    else if (command === "mkdir" && options.join(" ") === "-p" && args.length === 1 && operandsSafe) mkdirSync(resolve(cwd, args[0] ?? ""), { recursive: true });
    else if (command === "cp" && options.length === 0 && args.length === 2 && operandsSafe) copyFileSync(resolve(cwd, args[0] ?? ""), resolve(cwd, args[1] ?? ""));
    else throw new Error(`RESTORE.md has a command this test does not follow: ${[command, ...words].join(" ")}`);
  }
  return commands;
}
