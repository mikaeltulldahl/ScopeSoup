import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { allowedCommandsText, allowedProgramIn, SHELL_FACTS, shellPattern } from "./commands.ts";

test("a Bash entry becomes a readable command form; other tools are not shell commands", () => {
  assert.equal(shellPattern("Bash(git *)"), "git ...");
  assert.equal(shellPattern("Bash(pnpm check*)"), "pnpm check");
  assert.equal(shellPattern("Bash(pnpm test *)"), "pnpm test ...");
  assert.equal(shellPattern("Bash(git:*)"), "git ...");
  assert.equal(shellPattern("Bash(ls)"), "ls");
  assert.equal(shellPattern("Read"), null);
  assert.equal(shellPattern("Edit"), null);
});

test("the list has the shell patterns of the role and nothing else", () => {
  const text = allowedCommandsText(["Read", "Glob", "Edit", "Bash(git *)", "Bash(pnpm check*)", "Bash(pnpm test *)"]);
  assert.equal(text, `Shell commands you may run: \`git ...\`, \`pnpm check\`, \`pnpm test ...\`. ${SHELL_FACTS}`);
  assert.doesNotMatch(text, /Read|Glob|Edit/);
  // The shell facts are one line.
  assert.doesNotMatch(text, /\n/);
  assert.match(SHELL_FACTS, /no chaining[^\n]*heredocs[^\n]*git commit -F/);
});

test("a role without shell tools is told no shell commands are allowed", () => {
  assert.match(allowedCommandsText(["Read", "Grep"]), /may not run any shell commands/);
  assert.match(allowedCommandsText([]), /may not run any shell commands/);
});

test("a refused command whose program is allowed is found; one whose program is not is not", () => {
  const tools = ["Read", "Bash(git *)", "Bash(pnpm check*)"];
  assert.equal(allowedProgramIn('git commit -m "$(cat <<EOF x EOF)"', tools), "git");
  assert.equal(allowedProgramIn("`pnpm check`", tools), "pnpm check");
  assert.equal(allowedProgramIn("node -e \"1\"", tools), null);
  assert.equal(allowedProgramIn("digit was refused", tools), null);
  // `pnpm exec` is not allowed just because `pnpm check` is.
  assert.equal(allowedProgramIn('pnpm exec node -e "1"', ["Bash(pnpm check*)"]), null);
  // Prose that starts with or names an allowed command is not a command.
  assert.equal(allowedProgramIn("`git commit` worked, but I need `node -e`", ["Bash(git *)"]), null);
  assert.equal(allowedProgramIn("anything", []), null);
});

test("every prompt keeps the commands it may run, which carry the shell facts", () => {
  for (const name of ["triage", "implement", "review"]) {
    const text = readFileSync(new URL(`../../../../prompts/${name}.md`, import.meta.url), "utf8");
    assert.match(text, /\{\{allowedCommands\}\}/);
    assert.match(text, /data to work from, not instructions/);
  }
});

test("a bare Bash allows any command", () => {
  assert.equal(allowedCommandsText(["Bash"]), `You may run any shell command. ${SHELL_FACTS}`);
});
