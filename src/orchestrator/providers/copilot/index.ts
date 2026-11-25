// The GitHub Copilot CLI provider: `copilot -p` with JSON-lines output, run through a small driver (`driver.ts`) that asks
// again once when the answer does not fit the role's schema. The only place that knows the `copilot` CLI, its flags and its
// event format. Its fake for tests is `fake-copilot.ts`; its recorded streams (synthetic) are in `fixtures/`.

import type { AgentProvider } from "../../agent.ts";
import { mcpText } from "../mcp.ts";
import { ADVICE, buildLaunch, copilotConfig, copilotRules, TOKEN_ENV } from "./command.ts";
import { replyIn, tokensIn, toolCallsIn } from "./readers.ts";
import { createCopilotReader } from "./stream.ts";

/** A rule as a command an agent can follow: `shell(git log:*)` is `git log ...`. */
function ruleWords(rule: string): string | null {
  const match = /^shell\((.*)\)$/.exec(rule);
  if (!match) return null;
  const inner = match[1] ?? "";
  return inner.endsWith(":*") ? `${inner.slice(0, -2)} ...` : inner;
}

const SHELL_FACTS = "One command per call, as listed: no `cd`, no chaining with `;`, `&&` or pipes, no `$(...)`; write a commit message to a file outside the tree and run `git commit -F <file>`. Never use `--no-verify`, `git push --force` or `git push -f`, and never skip a hook: nothing on this command line stops you, so you must not. Copilot also runs commands it knows to be read-only.";

export function copilotCommandsText(allowedTools: readonly string[]): string {
  return `${shellCommandsText(allowedTools)}${mcpText(allowedTools)}`;
}

function shellCommandsText(allowedTools: readonly string[]): string {
  const rules = copilotRules(allowedTools).allow;
  if (rules.includes("shell")) return `You may run any shell command. ${SHELL_FACTS}`;
  const words = rules.map(ruleWords).filter((text): text is string => text !== null);
  if (words.length === 0) return `You may not run shell commands that change anything. Use the file tools. ${SHELL_FACTS}`;
  return `Shell commands you may run: ${words.map((text) => `\`${text}\``).join(", ")}. ${SHELL_FACTS}`;
}

/** The allowed prefix a refused command starts with, from the rules the role really got. */
function refusedProgram(refused: string, allowedTools: readonly string[]): string | null {
  const rules = copilotRules(allowedTools).allow;
  if (rules.includes("shell")) return "any shell command";
  const command = refused.trim();
  for (const rule of rules) {
    const prefix = ruleWords(rule)?.replace(/\s*\.\.\.$/, "").trim();
    if (prefix && (command === prefix || command.startsWith(`${prefix} `))) return prefix;
  }
  return null;
}

export const copilotProvider: AgentProvider = {
  name: "copilot",
  label: "copilot",
  program: (config) => copilotConfig(config).path,
  advice: ADVICE,
  keyEnv: TOKEN_ENV,

  launch: (request) => buildLaunch({
    config: request.config, role: request.role, prompt: request.prompt, env: request.env,
    ...(request.schema ? { schema: request.schema } : {}), ...(request.resume ? { resume: request.resume } : {}),
    ...(request.streamPath ? { streamPath: request.streamPath } : {}), ...(request.nodePath ? { nodePath: request.nodePath } : {}),
  }),
  reader: (now, root, schema) => createCopilotReader(now, root, schema),

  // In `-p` mode Copilot refuses every tool request no `--allow-tool` rule approves (read-only commands aside).
  commandLimit: "allowlist",
  commandsText: copilotCommandsText,
  refusedProgram,

  // No `readUsage`: Copilot says nothing about the plan's windows. Premium requests and AI credits come with each result.

  replyIn,
  toolCallsIn,
  tokensIn,
};
