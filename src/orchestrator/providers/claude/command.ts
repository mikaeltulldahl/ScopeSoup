// The `claude -p` command line for one session: start, resume, command limits and the answer's schema.

import type { ProjectConfig } from "../../../config/types.ts";
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

/** The `claude -p` command line for one session. `partial`: the reply streams as it is written (a chat turn). */
export function buildCommand(config: ProjectConfig, spec: { role: SessionRole; schema?: string }, prompt: string, resume?: string, partial = false): BuiltCommand {
  const role = config.roles[spec.role];
  const viaArg = config.claude.promptVia === "arg";
  const args = [...config.claude.prefixArgs, "-p"];
  if (viaArg) args.push(prompt);
  args.push("--output-format", "stream-json", "--verbose");
  if (partial) args.push("--include-partial-messages");
  args.push("--model", role.model, "--max-turns", String(role.maxTurns), "--permission-mode", role.permissionMode);
  if (role.allowedTools.length > 0) args.push("--allowedTools", role.allowedTools.join(","));
  args.push("--disallowedTools", disallowedTools(config.level).join(","));
  if (spec.schema) args.push("--json-schema", spec.schema);
  if (resume) args.push("--resume", resume);
  args.push(...config.claude.extraArgs);
  return viaArg ? { command: config.claude.path, args } : { command: config.claude.path, args, stdin: prompt };
}
