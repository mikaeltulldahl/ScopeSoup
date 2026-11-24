// The project's check command as the permission rule a session needs to run it. `checkCommand` is a list run without a shell
// (`["cmd.exe", "/d", "/c", "npm", "run", "check"]`); a session types what it would type in a shell (`npm run check`).
// No I/O, so the board could import it.

import { commandText } from "./commandLine.ts";
import type { SessionRole } from "../model/types.ts";

/** The roles that may run the check: the implementor checks its change, the reviewer re-runs it (everything else read-only). */
export const CHECK_ROLES: readonly SessionRole[] = ["implement", "review"];

/** The words a person types for a command list: the `cmd.exe /d /c` wrapper the list needs on Windows is dropped. */
export function typedWords(command: readonly string[]): string[] {
  const words = [...command];
  if (/^cmd(\.exe)?$/i.test(words[0] ?? "")) {
    let at = 1;
    while (at < words.length && /^\/[dsq]$/i.test(words[at] ?? "")) at++;
    if (/^\/c$/i.test(words[at] ?? "")) return words.slice(at + 1);
  }
  return words;
}

/**
 * The `Bash(...)` rules that let a session run the check: the command as typed (`Bash(npm run check*)`), and for a package
 * manager's `run <script>` also the short form it accepts (`pnpm check`, `npm test`). Empty for an empty command.
 */
export function checkRules(command: readonly string[]): string[] {
  const words = typedWords(command);
  if (words.length === 0) return [];
  const rules = [`Bash(${commandText(words)}*)`];
  const [program, run, script] = words;
  if (words.length === 3 && run === "run" && script !== undefined) {
    if ((program === "pnpm" || program === "yarn" || program === "bun") && !/^(run|add|install|exec|dlx)$/.test(script)) rules.push(`Bash(${program} ${script}*)`);
    if (program === "npm" && (script === "test" || script === "start")) rules.push(`Bash(npm ${script}*)`);
  }
  return rules;
}

/** A role's allowed tools with the check command's rules added, unless the list already allows any shell command. */
export function withCheckRules(tools: readonly string[], command: readonly string[] | null | undefined): string[] {
  if (!command || tools.some((tool) => tool.trim() === "Bash" || tool.trim() === "Bash(*)")) return [...tools];
  return [...tools, ...checkRules(command).filter((rule) => !tools.includes(rule))];
}
