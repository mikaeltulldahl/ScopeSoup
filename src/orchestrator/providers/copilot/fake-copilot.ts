// A stand-in for the `copilot` executable in tests. It never talks to anything. Its events have the shapes of the recorded
// streams in `fixtures/`. FAKE_COPILOT_MODE picks the behaviour: ok | chat | prose | prose-then-answer | denied | limit | fail.
// FAKE_COPILOT_OUTPUT is the answer (JSON text) the session ends with.

import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_COPILOT_MODE ?? "ok";
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  if (at >= 0) return argv[at + 1];
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
};
const prompt = flag("-p") ?? "";
const resume = flag("--resume");
const sessionId = resume ?? "00000000-0000-4000-8000-00000000f001";
const at = () => new Date().toISOString();

function emit(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ type, data, timestamp: at(), ...extra })}\n`);
}

function final(text: string, id: string): void {
  emit("assistant.message_start", { messageId: id, phase: "final_answer" }, { ephemeral: true });
  emit("assistant.message_delta", { messageId: id, deltaContent: text }, { ephemeral: true });
  emit("assistant.message", { messageId: id, model: "fake-model", content: text, toolRequests: [], phase: "final_answer" });
}

function finish(premiumRequests: number, exitCode = 0): void {
  emit("session.usage_checkpoint", { totalNanoAiu: premiumRequests * 50_000_000, totalPremiumRequests: premiumRequests });
  const usage = flag("--usage-output-file");
  if (usage) {
    writeFileSync(usage, JSON.stringify({
      totalPremiumRequestCost: premiumRequests, totalNanoAiu: premiumRequests * 50_000_000,
      tokenDetails: { input: { tokenCount: 1000 }, cache_read: { tokenCount: 30000 }, cache_write: { tokenCount: 0 }, output: { tokenCount: 50 } },
    }));
  }
  process.stdout.write(`${JSON.stringify({ type: "result", timestamp: at(), sessionId, exitCode, usage: { premiumRequests } })}\n`);
  process.exitCode = exitCode;
}

if (resume) emit("session.resume", { selectedModel: "auto", context: { cwd: process.cwd() } });
else emit("session.start", { sessionId, selectedModel: flag("--model") === "fusion" ? "auto" : (flag("--model") ?? "auto"), context: { cwd: process.cwd() } });
emit("session.mcp_server_status_changed", { serverName: "demo", status: "pending" }, { ephemeral: true });
emit("fake.args", { args: argv, cwd: process.cwd(), prompt, hasToken: process.env.COPILOT_GITHUB_TOKEN !== undefined });
emit("user.message", { content: prompt });
emit("assistant.turn_start", { turnId: "0" });

const answer = process.env.FAKE_COPILOT_OUTPUT ?? '{"done":true,"summary":"fake"}';

if (mode === "fail") {
  process.stderr.write("fake copilot: something broke\n");
  process.exitCode = 3;
} else if (mode === "limit") {
  emit("session.error", { errorType: "rate_limit", message: "You've hit your session rate limit." });
  finish(1, 1);
} else if (mode === "chat") {
  final(`Heard: ${prompt.trim()}`, "m-chat");
  finish(1);
} else if (mode === "prose" || (mode === "prose-then-answer" && !resume)) {
  final("I am done, everything looks fine.", "m-prose");
  finish(1);
} else {
  const command = mode === "denied" ? "git tag demo-tag" : "git status";
  emit("assistant.message", { messageId: "m-tool", content: "", toolRequests: [{ toolCallId: "call-1", name: "powershell", arguments: { command }, type: "function" }] });
  emit("tool.execution_start", { toolCallId: "call-1", toolName: "powershell", arguments: { command } });
  emit("tool.execution_complete", mode === "denied"
    ? { toolCallId: "call-1", success: false, error: { message: "Permission denied because no interactive user response was available.", code: "denied" } }
    : { toolCallId: "call-1", success: true, result: { content: "On branch main" } });
  emit("assistant.turn_start", { turnId: "1" });
  final(answer, "m-answer");
  finish(resume ? 2 : 1);
}
