// A stand-in for the `claude` executable in runner tests. It never talks to anything.
// FAKE_CLAUDE_MODE picks the behaviour: ok | hang | chatty | chat | fail | limit | error-result | no-answer.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSyncRetrying } from "../../../hosts/spawnRetry.ts";

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";

function emit(object: unknown): void {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });
}

const prompt = await readStdin();

// FAKE_CLAUDE_LEAVE: {"path": "content"} written in the working directory and not committed, as a stopped
// session leaves them. Written before the first event, so they are there once the session is seen to run.
for (const [path, content] of Object.entries(JSON.parse(process.env.FAKE_CLAUDE_LEAVE ?? "{}") as Record<string, string>)) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const resumeAt = process.argv.indexOf("--resume");
const sessionId = resumeAt > 0 ? (process.argv[resumeAt + 1] ?? "fake-session") : "fake-session-1";

emit({ type: "active_goal" });
emit({ type: "system", subtype: "init", session_id: sessionId, model: "fake" });
emit({ type: "system", subtype: "fake", args: process.argv.slice(2), cwd: process.cwd(), prompt, hasApiKey: process.env.ANTHROPIC_API_KEY !== undefined, ...(process.env.FAKE_CLAUDE_UNIT ? { unit: process.env.FAKE_CLAUDE_UNIT } : {}) });

// The readings are on the real clock while a test runs on its own: they show fresh windows (about one session's worth used), which
// the pace lets one session at a time start in whatever the test's clock (decision 133).
const soon = Math.floor(Date.now() / 1000) + 3600;
const reset = Number(process.env.FAKE_CLAUDE_RESET ?? soon);

if (mode === "hang") {
  // A grandchild, to prove the whole tree dies.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  emit({ type: "system", subtype: "fake_child", pid: child.pid });
  setInterval(() => undefined, 1000);
} else if (mode === "chatty") {
  setInterval(() => emit({ type: "assistant", message: { content: [{ type: "text", text: "still going" }] } }), 20);
} else if (mode === "chat") {
  // A chat turn: the reply streams as partial messages, then the whole message. With FAKE_CLAUDE_HOLD the turn waits,
  // after the first words, until that file exists.
  emit({ type: "stream_event", event: { type: "message_start" } });
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Heard: " } } });
  const hold = process.env.FAKE_CLAUDE_HOLD;
  if (hold) while (!existsSync(hold)) await new Promise((resolve) => setTimeout(resolve, 20));
  const reply = `Heard: ${prompt.trim()}`;
  emit({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
  emit({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: reset }, seven_day: { utilization: 0.01, resetsAt: reset + 86400 } } },
  });
  emit({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId, num_turns: 1, total_cost_usd: 0.01 });
} else if (mode === "fail") {
  process.stderr.write("fake: something broke\n");
  process.exitCode = 3;
} else if (mode === "limit") {
  emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset, rateLimitType: "five_hour" } });
  emit({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 3:45pm", session_id: sessionId, total_cost_usd: 0.5 });
  process.exitCode = 1;
} else if (mode === "error-result") {
  emit({ type: "result", subtype: "error_max_turns", is_error: true, session_id: sessionId, num_turns: 9 });
  process.exitCode = 1;
} else if (mode === "no-answer") {
  emit({ type: "result", subtype: "success", is_error: false, result: "I forgot the schema", session_id: sessionId });
} else {
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "README.md" } }] } });
  // FAKE_CLAUDE_COMMIT names a file to add a line to and commit in the working directory, as an implementor would.
  const commit = process.env.FAKE_CLAUDE_COMMIT;
  if (commit) {
    appendFileSync(commit, `written by the fake in ${process.cwd()}\n`);
    const git = (...args: string[]) => execFileSyncRetrying("git", [...args], { stdio: "pipe" });
    git("add", commit);
    git("commit", "-q", "-m", `fake: ${commit}`);
  }
  // FAKE_CLAUDE_PUSH, only when the prompt tells the session to merge (level 2, or level 3 after the approval):
  // "when-told" pushes the branch to the remote's main, fast-forward; "force" points the remote's main at a new root commit
  // with a force push instead; "squash" pushes one new commit on the remote's main with the branch's tree and names it in
  // `mergedAs`, as a squash merge does. "when-resumed" is "when-told" in a resumed session only: the first one stops before merging.
  const push = process.env.FAKE_CLAUDE_PUSH;
  let merged: string | undefined;
  if (push && /merge it to|Merge now|Merge it now/.test(prompt)) {
    const git = (...args: string[]) => String(execFileSyncRetrying("git", [...args], { stdio: "pipe", encoding: "utf8" })).trim();
    if (push === "when-told" || (push === "when-resumed" && resumeAt > 0)) git("push", "-q", "origin", "HEAD:refs/heads/main");
    if (push === "force") {
      const root = git("commit-tree", "HEAD^{tree}", "-m", "fake: rewritten history");
      git("push", "-q", "--force", "origin", `${root}:refs/heads/main`);
    }
    // "squash-empty": the same, but the new commit leaves main's files as they were (a squash that lost the change).
    if (push === "squash" || push === "squash-empty") {
      git("fetch", "-q", "origin", "main");
      merged = git("commit-tree", push === "squash" ? "HEAD^{tree}" : "FETCH_HEAD^{tree}", "-p", "FETCH_HEAD", "-m", "fake: squashed");
      git("push", "-q", "origin", `${merged}:refs/heads/main`);
    }
  }
  emit({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: reset }, seven_day: { utilization: 0.01, resetsAt: reset + 86400 } } },
  });
  emit({
    type: "result", subtype: "success", is_error: false, result: "ok", session_id: sessionId, num_turns: 2, total_cost_usd: 0.01,
    structured_output: { ...(JSON.parse(process.env.FAKE_CLAUDE_OUTPUT ?? '{"done":true}') as Record<string, unknown>), ...(merged ? { mergedAs: merged } : {}) },
  });
}
