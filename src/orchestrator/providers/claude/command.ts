// The `claude -p` command line for one session: start, resume, command limits and the answer's schema.

import type { McpServer, ProjectConfig } from "../../../config/types.ts";
import type { SessionRole } from "../../../model/types.ts";

export interface BuiltCommand {
  command: string;
  args: string[];
  /** Written to the child's stdin when the prompt does not travel as an argument. */
  stdin?: string;
}

/**
 * Disallowed for every session, whatever its allowedTools say: a force push and a skipped hook are never a session's
 * call. From level 4 (Autopilot) Scope Soup merges, so a session does not push at all.
 */
export function disallowedTools(level: number): string[] {
  const always = ["Bash(git push --force*)", "Bash(git push -f*)", "Bash(*--no-verify*)"];
  return level >= 4 ? [...always, "Bash(git push*)"] : always;
}

/**
 * `--mcp-config`'s JSON for a role's servers, or null for none. `env` carries `${NAME}`: Claude Code reads the value from the
 * environment when it starts the server, so no value is in the command line or any file.
 */
export function mcpConfigJson(servers: Record<string, McpServer> | undefined): string | null {
  const entries = Object.entries(servers ?? {});
  if (entries.length === 0) return null;
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of entries) {
    mcpServers[name] = {
      type: "stdio",
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: Object.fromEntries(server.env.map((variable) => [variable, `\${${variable}}`])) } : {}),
    };
  }
  return JSON.stringify({ mcpServers });
}

/** The `claude -p` command line for one session. `partial`: the reply streams as it is written (a chat turn). */
export function buildCommand(config: ProjectConfig, spec: { role: SessionRole; schema?: string }, prompt: string, resume?: string, partial = false): BuiltCommand {
  const role = config.roles[spec.role];
  const viaArg = config.claude.promptVia === "arg";
  const args = [...config.claude.prefixArgs, "-p"];
  if (viaArg) args.push(prompt);
  args.push("--output-format", "stream-json", "--verbose");
  if (partial) args.push("--include-partial-messages");
  args.push("--model", role.model, "--max-turns", String(role.maxTurns), "--permission-mode", role.permissionMode);
  if (role.effort) args.push("--effort", role.effort);
  if (role.allowedTools.length > 0) args.push("--allowedTools", role.allowedTools.join(","));
  args.push("--disallowedTools", disallowedTools(config.level).join(","));
  const mcp = mcpConfigJson(role.mcpServers);
  if (mcp) args.push("--mcp-config", mcp);
  if (spec.schema) args.push("--json-schema", spec.schema);
  if (resume) args.push("--resume", resume);
  args.push(...config.claude.extraArgs);
  return viaArg ? { command: config.claude.path, args } : { command: config.claude.path, args, stdin: prompt };
}
