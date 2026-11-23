// The reporter of `pnpm test`: Node's dot reporter (one dot per test, then every failure in full),
// followed by one line per failed test naming its file, line and name, so the last lines of the
// output still say what failed when the full failures have scrolled away. Then the slowest test
// files, from the summary Node sends for each file, so a file that grows slow shows. Then every git
// that was run once more because it was ended from outside (src/hosts/gitRetry.ts): test output is
// otherwise not shown, and those retries must not pass unseen. With
// SCOPESOUP_TEST_TIMES set to a path, the time of every file is written there as JSON too.

import { writeFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestEvent } from "node:test/reporters";
import { dot } from "node:test/reporters";

interface Failed {
  where: string;
  name: string;
  why: string;
}

function firstLine(error: unknown): string {
  const inner = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const text = inner instanceof Error ? inner.message : String(inner);
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, 200);
}

function where(file: string | undefined, line: number | undefined): string {
  if (!file) return "(no file)";
  const absolute = file.startsWith("file:") ? fileURLToPath(file) : file;
  const inside = relative(process.cwd(), absolute);
  const path = (inside.startsWith("..") || isAbsolute(inside) ? absolute : inside).split("\\").join("/");
  return line ? `${path}:${line}` : path;
}

export function summary(failed: Failed[]): string {
  if (failed.length === 0) return "";
  const lines = failed.map((entry) => `  ${entry.where}  ${entry.name}${entry.why ? `\n    ${entry.why}` : ""}`);
  return `\n${failed.length} failed:\n${lines.join("\n")}\n`;
}

/** The lines a test file printed that tell of a git run once more after it was ended from outside. */
export function retried(lines: { file: string; message: string }[]): string {
  const found = lines.flatMap((entry) => entry.message.split(/\r?\n/).filter((line) => line.includes("(ended from outside)")).map((line) => `  ${entry.file}  ${line.trim()}`));
  return found.length === 0 ? "" : `\nRetried, ended from outside (${found.length}):\n${found.join("\n")}\n`;
}

export interface FileTime {
  file: string;
  ms: number;
}

/** The slowest files, one line each, slowest first. */
export function slowest(times: FileTime[], count = 10): string {
  if (times.length === 0) return "";
  const top = [...times].sort((a, b) => b.ms - a.ms).slice(0, count);
  return `\nSlowest test files:\n${top.map((entry) => `  ${(entry.ms / 1000).toFixed(1).padStart(6)} s  ${entry.file}`).join("\n")}\n`;
}

export default async function* reporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string, void> {
  const failed: Failed[] = [];
  const times: FileTime[] = [];
  const printed: { file: string; message: string }[] = [];
  async function* watched(): AsyncGenerator<TestEvent, void> {
    for await (const event of source) {
      // One summary per file (it names the file), and one for the whole run (it does not).
      if (event.type === "test:summary" && event.data.file) times.push({ file: where(event.data.file, undefined), ms: event.data.duration_ms });
      if (event.type === "test:stderr" && event.data.message.includes("(ended from outside)")) printed.push({ file: where(event.data.file, undefined), message: event.data.message });
      if (event.type === "test:fail" && !event.data.todo) {
        const error = event.data.details.error as Error & { failureType?: string };
        // A suite, or a test that failed only because a test inside it did: the inner one is listed.
        if (event.data.details.type !== "suite" && error.failureType !== "subtestsFailed") {
          failed.push({ where: where(event.data.file, event.data.line), name: event.data.name, why: firstLine(error) });
        }
      }
      yield event;
    }
  }
  yield* dot(watched());
  yield slowest(times);
  yield retried(printed);
  yield summary(failed);
  const out = process.env.SCOPESOUP_TEST_TIMES;
  if (out) writeFileSync(out, JSON.stringify(times, null, 1));
}
