// The project's check command as a process, for the merge queue (`queueDriver.ts`), which merges at level 4: it runs the
// check on each chain and pushes only a commit the check passed, fast-forward only. The safety rules of the run are here:
// - started without a shell, never with git's hooks skipped;
// - ended (with its whole process tree) on its time limit or once Stop is pressed: `stop` is asked every second.

import type { ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { resolveExecutable } from "./executable.ts";
import type { ProcessControl } from "./process.ts";

/** How much of the check's output is kept: the end, where the failure usually is. */
const TAIL_CHARS = 4000;
const STOP_POLL_MS = 1000;

export const CHECK_ADVICE = {
  shim: 'checkCommand is run without a shell. Name the program behind the shim instead (for an npm tool: node.exe, then the tool\'s .js script), or start a script of the project\'s own with ["cmd.exe", "/d", "/c", "<script>.cmd"].',
  missing: "Install it, or give checkCommand the full path of the program.",
};

export interface CheckRun {
  /** "stopped": Stop was pressed while it ran, and it was ended. */
  outcome: "passed" | "failed" | "timed-out" | "stopped" | "not-started";
  code: number | null;
  /** The end of what it printed (standard output and error together), or why it did not start. */
  tail: string;
  ms: number;
}

/** Runs the check command in `cwd`. `stop` is asked every second; true ends the command. `extraEnv`: a resource unit's variables. */
export type RunCheck = (command: readonly string[], cwd: string, timeoutMs: number, stop: () => boolean, extraEnv?: Record<string, string>) => Promise<CheckRun>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The check command as a process: started without a shell (on Windows resolved to a real .exe the
 * same way an agent CLI is), its whole process tree ended on timeout or when Stop is pressed.
 */
export function createCheckRunner(processes: ProcessControl, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now, advice: { shim: string; missing: string } = CHECK_ADVICE): RunCheck {
  return (command, cwd, timeoutMs, stop, extraEnv) => new Promise<CheckRun>((done) => {
    const started = now();
    const childEnv = extraEnv ? { ...env, ...extraEnv } : env;
    const [program = "", ...args] = command;
    let child: ChildProcess;
    try {
      // A program named with a folder is the project's own, relative to its repository.
      const path = /[\\/]/.test(program) && !isAbsolute(program) ? resolve(cwd, program) : program;
      child = processes.spawn(resolveExecutable(path, { env: childEnv, advice }), args, { cwd, env: childEnv, stdin: false });
    } catch (error) {
      done({ outcome: "not-started", code: null, tail: `Could not start ${program}: ${errorText(error)}`, ms: 0 });
      return;
    }
    let tail = "";
    let ended: "timed-out" | "stopped" | null = null;
    let over = false;
    const add = (chunk: string): void => void (tail = (tail + chunk).slice(-TAIL_CHARS));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", add);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", add);
    const end = (why: "timed-out" | "stopped"): void => {
      if (ended || over) return;
      ended = why;
      if (child.pid !== undefined) processes.killTree(child.pid);
    };
    const timer = setTimeout(() => end("timed-out"), timeoutMs);
    const poll = setInterval(() => {
      if (stop()) end("stopped");
    }, STOP_POLL_MS);
    const finish = (code: number | null, error?: Error): void => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      clearInterval(poll);
      const ms = now() - started;
      if (error && child.pid === undefined) done({ outcome: "not-started", code: null, tail: `Could not start ${program}: ${error.message}`, ms });
      else if (ended) done({ outcome: ended, code, tail, ms });
      else done({ outcome: code === 0 ? "passed" : "failed", code, tail, ms });
    };
    child.on("error", (error) => {
      if (child.pid === undefined) finish(null, error);
    });
    child.on("close", (code) => finish(code));
  });
}
