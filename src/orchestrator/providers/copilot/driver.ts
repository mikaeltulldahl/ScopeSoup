// Runs one Copilot CLI session for the runner, which spawns this script with Node and sends a `DriverSpec` on stdin.
// Copilot has no JSON-schema output, so when the session's last message is not an answer that fits the schema, the driver
// resumes the session once and asks again. Both runs' JSON lines go to stdout, in order; the exit code is the last run's.
// The runner's tree kill (stall, timeout, Stop) ends this process and the CLI under it together.

import { spawn } from "node:child_process";
import { askAgainMessage, checkAnswer } from "./answer.ts";
import { retryUsageFile } from "./command.ts";
import type { DriverSpec } from "./command.ts";
import { createCopilotReader } from "./stream.ts";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });
}

interface Run {
  code: number;
  sessionId?: string;
  answer?: string;
}

/** One run of the CLI; `--resume=<id>` and `-p <prompt>` go after the spec's arguments. */
function run(spec: DriverSpec, prompt: string, resume: string | undefined): Promise<Run> {
  return new Promise((resolve) => {
    // `--resume` takes an optional value, so it is given with `=`. No `--trust-folder`: it cannot go with `--resume`, and an
    // untrusted folder keeps the repository's own hooks and MCP servers out of the session.
    const args = [...spec.args, ...(resume ? [`--resume=${resume}`] : []), "-p", prompt];
    const reader = createCopilotReader(() => new Date().toISOString(), undefined, spec.schema);
    let child;
    try {
      child = spawn(spec.program, args, { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    } catch (error) {
      process.stderr.write(`Could not start ${spec.program}: ${error instanceof Error ? error.message : String(error)}\n`);
      resolve({ code: 127 });
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      process.stdout.write(chunk);
      reader.push(chunk);
    });
    child.on("error", (error) => {
      process.stderr.write(`Could not start ${spec.program}: ${error.message}\n`);
      resolve({ code: 127 });
    });
    child.on("close", (code) => {
      reader.end();
      const summary = reader.summary();
      resolve({ code: code ?? 1, ...(summary.sessionId ? { sessionId: summary.sessionId } : {}), ...(summary.answer !== undefined ? { answer: summary.answer } : {}) });
    });
  });
}

const spec = JSON.parse(await readStdin()) as DriverSpec;
/** The second run writes its own usage file (`retryUsageFile`); `tokensIn` adds both. */
function retryArgs(args: readonly string[]): string[] {
  const at = args.indexOf("--usage-output-file");
  return args.map((arg, index) => (at >= 0 && index === at + 1 ? retryUsageFile(arg) : arg));
}
let last = await run(spec, spec.prompt, spec.resume);
if (spec.schema && last.code === 0) {
  const sessionId = last.sessionId ?? spec.resume;
  const checked = checkAnswer(last.answer, spec.schema);
  if (!checked.ok && sessionId) {
    process.stdout.write(`${JSON.stringify({ type: "scopesoup.ask_again", data: { problems: checked.problems } })}\n`);
    last = await run({ ...spec, args: retryArgs(spec.args) }, askAgainMessage(checked.problems, spec.schema), sessionId);
  }
}
process.exitCode = last.code;
