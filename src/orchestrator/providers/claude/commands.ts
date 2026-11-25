// The shell commands a role may run, in words an agent can follow, built from its `allowedTools`.

import { mcpText } from "../mcp.ts";

/** `Bash(git *)` is `git ...`, `Bash(pnpm check*)` is `pnpm check`. Anything that is not a `Bash(...)` entry gives null. */
export function shellPattern(tool: string): string | null {
  const match = /^Bash\((.*)\)$/.exec(tool.trim());
  if (!match) return null;
  const inner = (match[1] ?? "").trim();
  const open = /^(.*?)(?::\*| \*)$/.exec(inner);
  if (open) return `${(open[1] ?? "").trim()} ...`.trim();
  const stripped = inner.replace(/\*+$/, "").trim();
  return stripped === "" ? "..." : stripped;
}

/**
 * The allowed prefix (`git`, `pnpm check`) that an agent's report of a refused command starts with, or null. The
 * report counts as a command only when it is one command (alone, or alone in backticks) that starts with the whole
 * prefix of an allowed form, as the permission check does; prose that merely names an allowed command gives null.
 * A refused `git commit -m "$(...)"` in a role with `Bash(git *)` was refused for its shape, not its program;
 * `pnpm exec node -e "1"` with only `Bash(pnpm check*)` was refused because `pnpm exec` is not allowed.
 * When unsure the answer is null: a wrong "shape" advice sends a person looking in the wrong place.
 */
export function allowedProgramIn(refused: string, allowedTools: readonly string[]): string | null {
  if (allowedTools.some((tool) => tool.trim() === "Bash" || tool.trim() === "Bash(*)")) return "any shell command";
  let command = refused.trim();
  const wrapped = /^`([^`]*)`$/.exec(command);
  if (wrapped) command = (wrapped[1] ?? "").trim();
  else if (command.startsWith("`")) return null;
  for (const tool of allowedTools) {
    const prefix = shellPattern(tool)?.replace(/\s*\.\.\.$/, "").trim();
    if (!prefix || prefix === "...") continue;
    if (command === prefix || command.startsWith(`${prefix} `)) return prefix;
  }
  return null;
}

/** The one line of shell facts every prompt keeps (decided, section 8): the shapes the permission check refuses. */
export const SHELL_FACTS = "One command per call, as listed: no `cd`, no chaining with `;`, `&&` or pipes, no `$(...)` or heredocs, no PowerShell or `cmd.exe`; write a commit message to a file outside the tree and run `git commit -F <file>`.";

/** The text for the `allowedCommands` prompt variable: the commands the role may run, from its `allowedTools`, and the shell facts. */
export function allowedCommandsText(allowedTools: readonly string[]): string {
  return `${shellCommandsText(allowedTools)}${mcpText(allowedTools)}`;
}

function shellCommandsText(allowedTools: readonly string[]): string {
  if (allowedTools.some((tool) => tool.trim() === "Bash" || tool.trim() === "Bash(*)")) return `You may run any shell command. ${SHELL_FACTS}`;
  const patterns = allowedTools.map(shellPattern).filter((pattern): pattern is string => pattern !== null);
  if (patterns.length === 0) return "You may not run any shell commands. Use the file tools.";
  return `Shell commands you may run: ${patterns.map((pattern) => `\`${pattern}\``).join(", ")}. ${SHELL_FACTS}`;
}
