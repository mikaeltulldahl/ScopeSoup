// Nothing outside the Claude provider names the `claude` CLI, its flags or its event format: everything else goes
// through the provider interface (`src/orchestrator/agent.ts`). Tests are not scanned: they drive the Claude provider through
// its fake CLI on purpose.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = "orchestrator/providers/claude/";

/**
 * Where the CLI's name may stand outside its provider, and why. Keep it short.
 * The configuration has a `claude` section, the Claude provider's own settings (its program, arguments, how the prompt
 * travels); a second provider gets a section of its own beside it.
 */
const ALLOWED: Record<string, string> = {
  "config/types.ts": "the type of the `claude` configuration section",
  "config/defaults.ts": "the defaults of the `claude` configuration section",
  "config/validate.ts": "reads the `claude` configuration section",
  "config/shared.ts": "lists `claude` among the keys that stay on this machine",
  "orchestrator/providers/index.ts": "the list of providers, which imports each one",
  "server/demo.ts": "writes the demo's canned session streams, which the default provider reads for the Rounds table",
  "offboard/projectFiles.ts": "names the project's `.claude/settings.json`, where onboarding put the plugin lines that offboarding takes out",
  "queueTrial.ts": "points the `claude` section at a program that does not exist, so a queue trial starts no session",
};

/**
 * The CLI's name as a word (not `CLAUDE.md`, the project's instructions, nor `claude-code`, an interactive session holding an
 * Item), and the flags and event fields only `claude -p --output-format stream-json` has.
 */
const NAMES: readonly RegExp[] = [
  /(?<![\w-])claude(?![\w-]|\.md\b)/,
  /stream-json/, /rate_limit_event/, /rate_limit_info/, /structured_output/, /stream_event/, /tool_use/, /permission_denials/,
  /total_cost_usd/, /num_turns/, /--allowedTools/, /--disallowedTools/, /--json-schema/, /--permission-mode/, /--resume/,
  /ANTHROPIC_API_KEY/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

test("only the Claude provider names the claude CLI and its event format", () => {
  const found: string[] = [];
  for (const file of files(src)) {
    const name = relative(src, file).replace(/\\/g, "/");
    if (name.startsWith(PROVIDER) || name in ALLOWED) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      const hit = NAMES.find((pattern) => pattern.test(line));
      if (hit) found.push(`${name}:${index + 1} (${hit.source}): ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});

test("each allowed file still needs its place on the list", () => {
  for (const name of Object.keys(ALLOWED)) {
    const text = readFileSync(join(src, name), "utf8");
    assert.ok(NAMES.some((pattern) => pattern.test(text)), `${name} no longer names the CLI: take it off the list`);
  }
});
