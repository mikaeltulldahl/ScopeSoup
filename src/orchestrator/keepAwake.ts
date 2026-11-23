// Keeping the laptop from sleeping while Scope Soup has work. Three parts:
//   shouldStayAwake  the decision, pure
//   startWindowsHold the Windows mechanism: a long-lived powershell child that asks for
//                    "system required" and holds it until its stdin closes
//   createKeepAwake  follows the decision, starting and ending the hold; a no-op off Windows
//
// The hold needs no dependency and no elevation. It is tied to the pipe to its parent, so
// it ends when Scope Soup stops, and also when Scope Soup dies without stopping it.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { trackSpawn } from "../hosts/processTree.ts";

export interface AwakeInput {
  /** The project's `keepAwake` setting. */
  enabled: boolean;
  /** The project's level: level 0 (Watch) starts nothing, so there is nothing to stay awake for. */
  level: number;
  /** Agents are paused or stopped: nothing new starts, but running sessions may still finish their step. */
  paused: boolean;
  /** Sessions with a live process. */
  running: number;
  /** Items ready to start that did not (no slot, no budget). */
  queued: number;
  /** Something is waiting for a moment (a retry back-off, a limit reset). */
  waitingForTime: boolean;
}

/** Should the machine be kept from sleeping now? Yes while a session runs or work is waiting. */
export function shouldStayAwake(input: AwakeInput): boolean {
  if (!input.enabled || input.level === 0) return false;
  // Paused agents let running sessions finish: those keep the machine awake, waiting work does not.
  if (input.paused) return input.running > 0;
  return input.running > 0 || input.queued > 0 || input.waitingForTime;
}

/** What a hold is, for the controller and for tests. */
export interface Hold {
  /** The process id of the holding process, when there is one. */
  pid?: number;
  /** Resolves once the request is in force; rejects when it could not be made. */
  ready: Promise<void>;
  /** Ends the hold and resolves when its process is gone. */
  release(): Promise<void>;
  /** Resolves when the hold ended by itself (the process died). */
  ended: Promise<void>;
}

// ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001). The request belongs to the thread
// that made it, so that thread stays in the read loop until stdin closes.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -Namespace Scope Soup -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
  "if ([Scope Soup.Power]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'SetThreadExecutionState failed' }",
  "[Console]::Out.WriteLine('held')",
  "[Console]::Out.Flush()",
  "while ($null -ne [Console]::In.ReadLine()) { }",
].join("\n");

const RELEASE_GRACE_MS = 3000;
const START_TIMEOUT_MS = 20_000;

export interface WindowsHoldOptions {
  powershell?: string;
  /** Replaces the arguments given to `powershell`. For tests, to start a harmless process instead. */
  args?: string[];
  /** How long the child may take to say it holds the request. */
  startTimeoutMs?: number;
  killTree?: (pid: number) => void;
}

/** Starts the powershell child that holds the request. Windows only. */
export function startWindowsHold(options: WindowsHoldOptions = {}): Hold {
  const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
  const before = Date.now();
  const child: ChildProcess = spawn(
    options.powershell ?? "powershell.exe",
    options.args ?? ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  // So that a tree kill knows this pid is still the child it started (src/hosts/processTree.ts).
  trackSpawn(child, before);
  const endChild = (): void => {
    if (child.pid === undefined) return;
    if (options.killTree) options.killTree(child.pid);
    else child.kill();
  };
  let stderr = "";
  let out = "";
  let exited = false;
  let settleReady: { ok: () => void; fail: (error: Error) => void };
  const ready = new Promise<void>((ok, fail) => (settleReady = { ok, fail }));
  ready.catch(() => undefined);
  // A powershell that hangs before it holds anything must not leave the hold looking made.
  const startTimer = setTimeout(() => {
    settleReady.fail(new Error(`The keep-awake process did not take the request within ${Math.round((options.startTimeoutMs ?? START_TIMEOUT_MS) / 1000)} s and was ended.${stderr ? ` ${stderr.trim().slice(-300)}` : ""}`));
    endChild();
  }, options.startTimeoutMs ?? START_TIMEOUT_MS);
  startTimer.unref();
  ready.then(() => clearTimeout(startTimer), () => clearTimeout(startTimer));
  const ended = new Promise<void>((resolve) => {
    child.on("exit", () => {
      exited = true;
      settleReady.fail(new Error(`The keep-awake process ended before it held the request.${stderr ? ` ${stderr.trim().slice(-300)}` : ""}`));
      resolve();
    });
    child.on("error", (error) => {
      exited = true;
      settleReady.fail(error);
      resolve();
    });
  });
  child.stdin?.on("error", () => undefined);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
    if (out.includes("held")) settleReady.ok();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));

  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    ready,
    ended,
    async release() {
      if (exited) return;
      child.stdin?.end();
      const timer = setTimeout(endChild, RELEASE_GRACE_MS);
      await ended;
      clearTimeout(timer);
    },
  };
}

export interface KeepAwake {
  /** Follows the decision. Starts the hold when it becomes true, ends it when it becomes false. */
  set(awake: boolean): void;
  /** Ends the hold and waits for its process to be gone. */
  stop(): Promise<void>;
  /** True while a hold is in force or being made. */
  readonly holding: boolean;
}

export interface KeepAwakeDeps {
  platform?: NodeJS.Platform;
  /** Replaceable in tests. */
  start?: () => Hold;
  /** Called when a hold could not be made or died, once per episode. */
  onProblem?: (message: string) => void;
  /** Called when a hold is in force (once it has been made) and when it ends. */
  onChange?: (holding: boolean) => void;
}

export function createKeepAwake(deps: KeepAwakeDeps = {}): KeepAwake {
  const platform = deps.platform ?? process.platform;
  const start = deps.start ?? (() => startWindowsHold());
  let hold: Hold | null = null;
  let failed = false;
  let stopped = false;
  let releasing: Promise<void> = Promise.resolve();

  // The hold for which onChange(true) was called, so that onChange(false) follows exactly that.
  let announced: Hold | null = null;
  const unannounce = (old: Hold): void => {
    if (announced !== old) return;
    announced = null;
    deps.onChange?.(false);
  };

  function begin(): void {
    const mine = start();
    hold = mine;
    mine.ready.then(
      () => {
        // A hold that was released or replaced meanwhile says nothing about the present.
        if (hold !== mine) return;
        failed = false;
        announced = mine;
        deps.onChange?.(true);
      },
      (error: unknown) => {
        if (hold !== mine) return;
        if (!failed) deps.onProblem?.(error instanceof Error ? error.message : String(error));
        failed = true;
      },
    );
    void mine.ended.then(() => {
      if (hold === mine) hold = null;
      unannounce(mine);
    });
  }

  return {
    get holding() {
      return hold !== null;
    },
    set(awake) {
      if (platform !== "win32" || stopped) return;
      if (awake && hold === null) {
        // A hold that died on its own is made again at the next call. One that could not be made at all is not
        // tried again until there has been nothing to do in between: otherwise every tick would start a process.
        if (!failed) begin();
      } else if (!awake) {
        failed = false;
        if (hold === null) return;
        const old = hold;
        hold = null;
        unannounce(old);
        releasing = releasing.then(() => old.release());
      }
    },
    async stop() {
      stopped = true;
      const old = hold;
      hold = null;
      if (old) {
        unannounce(old);
        releasing = releasing.then(() => old.release());
      }
      await releasing;
    },
  };
}
