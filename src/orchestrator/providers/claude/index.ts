// The Claude Code provider: `claude -p` with stream-json output. The only place that knows the `claude` CLI, its flags and its
// event format (a test checks it, `providers/boundary.test.ts`). Its fake for tests is `fake-claude.ts`.

import type { AgentProvider } from "../../agent.ts";
import { buildCommand } from "./command.ts";
import { allowedCommandsText, allowedProgramIn } from "./commands.ts";
import { replyIn, tokensIn, toolCallsIn } from "./readers.ts";
import { createStreamParser } from "./stream.ts";

export const claudeProvider: AgentProvider = {
  name: "claude",
  label: "claude",
  program: (config) => config.claude.path,
  advice: {
    shim: "Set claude.path in the project configuration to the real claude.exe (for the native install: %USERPROFILE%\\.local\\bin\\claude.exe).",
    missing: "Install it, or set claude.path in the project configuration to the full path of the .exe.",
  },
  keyEnv: ["ANTHROPIC_API_KEY"],

  launch(request) {
    const built = buildCommand(request.config, { role: request.role, ...(request.schema ? { schema: request.schema } : {}) }, request.prompt, request.resume, request.partial);
    const env = { ...request.env };
    // Sessions draw from the subscription, not from an API key that happens to be set.
    if (request.config.claude.dropApiKeyEnv) delete env.ANTHROPIC_API_KEY;
    return { ...built, env };
  },
  reader: (now, root) => createStreamParser(now, root),

  // `--permission-mode dontAsk` with `--allowedTools`: a command not on the list is refused by the CLI.
  commandLimit: "allowlist",
  commandsText: allowedCommandsText,
  refusedProgram: allowedProgramIn,

  // No `readUsage`: `rate_limit_event` lines in the stream carry the usage windows.

  replyIn,
  toolCallsIn,
  tokensIn,
};
