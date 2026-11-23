// Everything the runner does to processes, behind one interface so tests can replace it.

import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { uptime } from "node:os";
import { endWindowsTree, trackSpawn, trackedWindow, windowAround } from "../hosts/processTree.ts";
import { retryGitOnce } from "../hosts/gitRetry.ts";
import { isSpawnRefused, retrySpawn, retrySpawnSync } from "../hosts/spawnRetry.ts";
import { resolveExecutable } from "./executable.ts";

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** True when something will be written to the child's stdin. */
  stdin: boolean;
  /** What the person should change when the program cannot be started (the agent provider's own advice). */
  advice?: { shim: string; missing: string };
}

export interface ProcessControl {
  /**
   * Starts the executable directly, never through a shell. On Windows the command is first resolved to a real .exe; a shim is an error.
   * A start that Windows refuses (EPERM, nothing ran) is tried again a few times (src/hosts/spawnRetry.ts).
   */
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
  /**
   * Kills the process and everything it started. Must not throw when the process is gone.
   * On Windows only a process that is known to be the one that was started is touched: a child of
   * `spawn` that has not exited, or a process whose creation time is `createdMs` (read earlier with
   * `startTimeMs`). Anything else (an exited child, whose pid may have been reused) is left alone,
   * and of the tree only processes created no earlier than their parent are ended (src/hosts/processTree.ts).
   */
  killTree(pid: number, createdMs?: number): void;
  isAlive(pid: number): boolean;
  /** When the machine started. A pid recorded before that belongs to another process now. */
  bootTimeMs(): number;
  /** When the process with this pid was created, in ms since the epoch; null when it cannot be read (then the process must not be touched). */
  startTimeMs(pid: number): Promise<number | null>;
}

const KILL_GRACE_MS = 5000;

export const realProcesses: ProcessControl = {
  spawn(command, args, options) {
    const executable = resolveExecutable(command, { env: options.env, ...(options.advice ? { advice: options.advice } : {}) });
    // Node throws a refused start (EPERM) at once, so it can be retried before a process is returned.
    return retrySpawnSync(command, () => {
      const before = Date.now();
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        // POSIX: the child leads its own process group, so the whole group can be signalled.
        // Windows: not detached (that would open a console); killTree walks the tree instead.
        detached: process.platform !== "win32",
      });
      // Its creation window, so that killTree can tell it from a later process with the same pid.
      trackSpawn(child, before);
      return child;
    });
  },

  killTree(pid, createdMs) {
    if (process.platform === "win32") {
      const own = trackedWindow(pid);
      const window = createdMs !== undefined ? windowAround(createdMs) : own;
      // Not a child that is still running, and no creation time to check it by: its pid may be another program's now.
      if (!window) return;
      void endWindowsTree(pid, window).then(({ listed }) => {
        // No listing (PowerShell failed): end the root alone, but only a running child of ours, whose
        // pid cannot have been reused while Node holds its handle.
        if (!listed && own && trackedWindow(pid) === own) {
          try {
            process.kill(pid);
          } catch {
            // Already gone.
          }
        }
      });
      return;
    }
    const signal = (name: NodeJS.Signals): void => {
      try {
        process.kill(-pid, name);
      } catch {
        try {
          process.kill(pid, name);
        } catch {
          // Already gone.
        }
      }
    };
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref();
  },

  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: it exists but is not ours.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },

  bootTimeMs() {
    return Date.now() - uptime() * 1000;
  },

  startTimeMs(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
    const [command, args, env]: [string, string[], NodeJS.ProcessEnv] =
      process.platform === "win32"
        ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], process.env]
        : ["ps", ["-o", "lstart=", "-p", String(pid)], { ...process.env, LC_ALL: "C" }];
    return new Promise((resolve) => {
      execFile(command, args, { env, windowsHide: true, timeout: 20_000 }, (error, stdout) => {
        const time = error ? Number.NaN : Date.parse(stdout.trim());
        resolve(Number.isNaN(time) ? null : time);
      });
    });
  },
};

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `input` goes to the command's standard input; `env` is added to the environment of the command. */
export type Git = (args: string[], cwd: string, input?: string, env?: Record<string, string>) => Promise<GitResult>;

/**
 * A start of git that Windows refuses (EPERM, nothing ran) is tried again a few times; when it still fails, the result has code 1.
 * A git that started is run once more only when it was ended from outside and is safe to repeat (src/hosts/gitRetry.ts).
 */
export const realGit: Git = async (args, cwd, input, env) => {
  const { failure, ...result } = await retryGitOnce(args, () => realGitOnce(args, cwd, input, env));
  // With nothing on stderr, the message Node made from the failure stands in for it.
  return { ...result, stderr: result.stderr || failure };
};

/** One run of git for `realGit`, with git's own stderr (empty when it printed nothing) and Node's message on a failure apart. */
const realGitOnce = (args: string[], cwd: string, input?: string, env?: Record<string, string>): Promise<GitResult & { failure: string }> =>
  retrySpawn("git", () =>
    new Promise<GitResult & { failure: string }>((resolve, reject) => {
      const child = execFile("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout, stderr) => {
        if (error && child.pid === undefined && isSpawnRefused(error)) return reject(error);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr, failure: error && code !== 0 ? error.message : "" });
      });
      if (input !== undefined) child.stdin?.end(input);
    }),
  ).catch((error: unknown) => {
    if (!isSpawnRefused(error)) throw error;
    return { code: 1, stdout: "", stderr: (error as Error).message, failure: "" };
  });
