import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { validateConfig } from "../../../config/validate.ts";
import type { ProjectConfig } from "../../../config/types.ts";
import type { AgentEvent } from "../../agent.ts";
import { providerFor } from "../index.ts";
import { checkAnswer } from "./answer.ts";
import { copilotArgs, copilotRefusal, copilotRules, shellRule, usageFile } from "./command.ts";
import { copilotCommandsText, copilotProvider } from "./index.ts";
import { replyIn, tokensIn, tokensInUsage, toolCallsIn } from "./readers.ts";
import { createCopilotReader } from "./stream.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const dir = mkdtempSync(join(tmpdir(), "scopesoup-copilot-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function config(roles: Record<string, unknown> = {}, level = 2, copilot: Record<string, unknown> = {}): ProjectConfig {
  const result = validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "repo", level, roles, copilot }, dir);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

function read(text: string, schema?: string, chunk = text.length) {
  const reader = createCopilotReader(() => "2026-11-20T10:00:00.000Z", "C:\\work\\demo", schema);
  const events: AgentEvent[] = [];
  for (let i = 0; i < text.length; i += chunk) events.push(...reader.push(text.slice(i, i + chunk)));
  events.push(...reader.end());
  return { events, summary: reader.summary(), limitHit: reader.limitHit(undefined) };
}

test("a role picks Copilot by its provider; it then runs on Fusion with the balance profile unless the file says otherwise", () => {
  const c = config({ triage: { provider: "copilot" }, review: { provider: "copilot", model: "fusion", autoTier: "quality" }, implement: {} });
  assert.equal(providerFor(c, "triage"), copilotProvider);
  assert.equal(providerFor(c, "implement").name, "claude");
  assert.equal(c.roles.triage.model, "fusion");
  assert.equal(c.roles.triage.autoTier, "balance");
  assert.equal(c.roles.review.autoTier, "quality");
  assert.equal(c.roles.implement.model, "sonnet");
  const bad = validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "repo", roles: { triage: { provider: "codex" } } }, dir);
  assert.equal(bad.ok, false);
});

test("allowedTools become Copilot rules that never allow more than the entry did", () => {
  assert.equal(shellRule("Bash(git *)"), "shell(git:*)");
  assert.equal(shellRule("Bash(git log *)"), "shell(git log:*)");
  assert.equal(shellRule("Bash(pnpm check*)"), "shell(pnpm check:*)");
  assert.equal(shellRule("Bash(npm test:*)"), "shell(npm test:*)");
  assert.equal(shellRule("Bash(git status)"), "shell(git status)");
  assert.equal(shellRule("Bash"), "shell");
  assert.equal(shellRule("Bash(*)"), "shell");
  // Copilot names a command by its first subcommand only: these cannot be held without allowing more.
  assert.equal(shellRule("Bash(npm run check*)"), null);
  assert.equal(shellRule("Bash(pnpm --dir C:/soup item list*)"), null);
  assert.equal(shellRule("Bash(git push --force*)"), null);
  assert.equal(shellRule("Read"), undefined);

  const rules = copilotRules(["Read", "Glob", "Grep", "Edit", "Write", "Bash(git diff *)", "Bash(npm run check*)", "WebFetch"]);
  assert.deepEqual(rules.allow, ["write", "shell(git diff:*)"]);
  assert.deepEqual(rules.deny, ["shell(git push)"]);
  assert.deepEqual(rules.left, ["Bash(npm run check*)", "WebFetch"]);
});

test("the prompt names the commands the role really got", () => {
  const text = copilotCommandsText(["Read", "Bash(git log *)", "Bash(git status *)", "Bash(npm run check*)"]);
  assert.match(text, /^Shell commands you may run: `git log \.\.\.`, `git status \.\.\.`\./);
  assert.doesNotMatch(text, /npm run check/);
  assert.match(text, /`git push` is always refused/);
});

test("each role's command line: model, auto tier, rules, usage file, no question form", () => {
  const c = config({ triage: { provider: "copilot" }, review: { provider: "copilot", model: "demo-model" } });
  const args = copilotArgs(c, "triage", "C:\\data\\streams\\s1.ndjson");
  const value = (name: string) => args[args.indexOf(name) + 1];
  assert.deepEqual(args.slice(0, 2), ["--output-format", "json"]);
  assert.equal(value("--model"), "fusion");
  assert.equal(value("--auto-tier"), "balance");
  assert.equal(value("--usage-output-file"), usageFile("C:\\data\\streams\\s1.ndjson"));
  for (const word of ["--no-ask-user", "--disable-builtin-mcps", "--no-auto-update", "--deny-tool=shell(git push)", "--allow-tool=shell(git log:*)"]) assert.ok(args.includes(word), word);
  assert.ok(!args.includes("--trust-folder") && !args.includes("--reasoning-effort") && !args.includes("--allow-all-tools"));
  // A named model takes no Auto routing profile.
  assert.equal(copilotArgs(c, "review").includes("--auto-tier"), false);
});

test("a role that may commit is refused on Copilot: it cannot refuse --no-verify; the read-only roles run", () => {
  const c = config({ triage: { provider: "copilot" }, implement: { provider: "copilot" }, review: { provider: "copilot" } });
  assert.equal(copilotRefusal(c, "triage"), null);
  assert.equal(copilotRefusal(c, "review"), null);
  assert.match(copilotRefusal(c, "implement") ?? "", /cannot refuse `git commit --no-verify`/);
  const narrow = config({ implement: { provider: "copilot", allowedTools: ["Read", "Edit", "Bash(git add *)"] } });
  assert.equal(copilotRefusal(narrow, "implement"), null);
});

test("the launch runs the driver with the prompt, the schema and the instruction about the answer on stdin", () => {
  const c = config({ review: { provider: "copilot" } }, 2, { path: process.execPath });
  const launch = copilotProvider.launch({ config: c, role: "review", prompt: "Review it.", schema: '{"type":"object"}', partial: false, env: {}, resume: "abc" });
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args.at(-1) ?? "", /driver\.ts$/);
  const spec = JSON.parse(launch.stdin ?? "") as { program: string; prompt: string; resume: string; schema: string };
  assert.equal(spec.program, process.execPath);
  // On Windows a program that is not there (or only a shim) fails the launch, with what to do about it.
  const missing = config({ review: { provider: "copilot" } }, 2, { path: join(dir, "no-such-copilot.exe") });
  if (process.platform === "win32") assert.throws(() => copilotProvider.launch({ config: missing, role: "review", prompt: "x", partial: false, env: {} }), /copilot\.path/);
  assert.equal(spec.resume, "abc");
  assert.match(spec.prompt, /^Review it\.\n\nWhen you are done, your last message is your answer/);
});

test("a plain answer: session id, model, answer, premium requests and AI credits", () => {
  const { events, summary } = read(fixture("plain.jsonl"), undefined, 37);
  assert.equal(events[0]?.kind, "init");
  assert.deepEqual(events[0]?.kind === "init" ? [events[0].sessionId, events[0].model] : [], ["00000000-0000-4000-8000-000000000001", "auto"]);
  assert.equal(summary.malformed, 0);
  assert.equal(summary.answer, "ok");
  assert.deepEqual(summary.result, {
    isError: false, hasStructuredOutput: false, subtype: "success", turns: 1, sessionId: "00000000-0000-4000-8000-000000000001",
    premiumRequests: 1, aiCredits: 0.083, text: "ok",
  });
});

test("a shell command shows as the last action; a refused one is read as denied", () => {
  assert.equal(read(fixture("shell.jsonl")).summary.lastAction, "`git log --oneline -1`: a1b2c3d init `git status`: on branch main, clean.");
  assert.deepEqual(toolCallsIn(fixture("shell.jsonl")), [{ name: "powershell", text: "running git log --oneline -1; git status" }]);
  const denied = read(fixture("denied.jsonl")).summary;
  assert.deepEqual(denied.result?.denied, ["git tag demo-tag"]);
  assert.equal(copilotProvider.refusedProgram("git tag demo-tag", ["Bash(git log *)"]), null);
  assert.equal(copilotProvider.refusedProgram("git log --oneline", ["Bash(git log *)"]), "git log");
});

test("a resumed session has no new id in its stream; the result names it", () => {
  const { events, summary } = read(fixture("resume.jsonl"));
  assert.equal(events.some((event) => event.kind === "init"), false);
  assert.equal(summary.sessionId, "00000000-0000-4000-8000-000000000003");
  assert.equal(summary.result?.premiumRequests, 2);
  assert.equal(replyIn(fixture("resume.jsonl")), "`git tag demo-tag`");
});

test("the answer counts only when it is JSON that fits the schema", () => {
  const schema = JSON.stringify({ type: "object", additionalProperties: false, required: ["verdict", "findings"], properties: {
    verdict: { enum: ["approve", "changes"] },
    findings: { type: "array", items: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
  } });
  assert.deepEqual(checkAnswer('{"verdict":"approve","findings":[]}', schema), { ok: true, value: { verdict: "approve", findings: [] } });
  assert.equal(checkAnswer('```json\n{"verdict":"changes","findings":[{"text":"x"}]}\n```', schema).ok, true);
  assert.equal(checkAnswer('Here it is: {"verdict":"approve","findings":[]}', schema).ok, true);
  assert.deepEqual(checkAnswer('{"verdict":"maybe","findings":[{}],"extra":1}', schema), {
    ok: false, problems: ['answer.verdict must be one of "approve", "changes"', "answer.findings[0].text is missing", "answer.extra is not in the schema"],
  });
  assert.deepEqual(checkAnswer("All good.", schema), { ok: false, problems: ["the answer was not JSON"] });

  const stream = fixture("plain.jsonl").replace('"content":"ok"', `"content":${JSON.stringify('{"verdict":"approve","findings":[]}')}`);
  const fits = read(stream, schema).summary.result;
  assert.deepEqual([fits?.hasStructuredOutput, fits?.structuredOutput], [true, { verdict: "approve", findings: [] }]);
  assert.equal(read(fixture("plain.jsonl"), schema).summary.result?.hasStructuredOutput, false);
});

test("a rate limit is told apart by its words", () => {
  const limit = `${JSON.stringify({ type: "session.error", data: { message: "You've reached your weekly rate limit." } })}\n${JSON.stringify({ type: "result", sessionId: "s", exitCode: 1 })}\n`;
  const { summary, limitHit } = read(limit);
  assert.equal(limitHit, true);
  assert.equal(summary.result?.isError, true);
  assert.equal(summary.result?.text, "You've reached your weekly rate limit.");
  assert.equal(read(fixture("plain.jsonl")).limitHit, false);
});

test("tokens come from the usage file beside the stream", () => {
  assert.equal(tokensInUsage(fixture("usage.json")), 1448 + 72);
  const stream = join(dir, "s1.ndjson");
  writeFileSync(stream, fixture("plain.jsonl"));
  assert.equal(tokensIn(fixture("plain.jsonl"), stream), undefined);
  writeFileSync(usageFile(stream), fixture("usage.json"));
  assert.equal(copilotProvider.tokensIn(fixture("plain.jsonl"), stream), 1520);
});

test("a chat reply streams from the deltas of the message being written", () => {
  const partial = [
    { type: "assistant.message", data: { content: "First." } },
    { type: "assistant.message_start", data: { messageId: "m2" } },
    { type: "assistant.message_delta", data: { messageId: "m2", deltaContent: "Sec" } },
    { type: "assistant.message_delta", data: { messageId: "m2", deltaContent: "ond" } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(replyIn(partial), "First.\n\nSecond");
});
