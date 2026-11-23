// Retries process creation when the operating system refuses it. On Windows, starting a process
// sometimes fails with EPERM (or EACCES) and no pid: nothing ran. It is machine-wide and passes
// within moments (likely the virus scanner). Only that is retried: a process that started is never
// run again, whatever happened to it afterwards.
//
// This sits under src/hosts because a host may import only hosts, ports and model; the orchestrator,
// the tools and the tests import it from here.

import { execFileSync, spawnSync } from "node:child_process";

/** The waits between tries: five tries in all, about 750 ms of waiting at most. */
export const SPAWN_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400];

export interface SpawnRetryOptions {
  delaysMs?: readonly number[];
  /** Told once per call that was refused at least once. Default: console.warn. */
  log?: (line: string) => void;
}

/**
 * True when the error says process creation was refused and nothing started: the code is EPERM or
 * EACCES, it came from the spawn call itself (`spawn`, `spawn git`, `spawnSync git`), and no pid was
 * given (`spawnSync` reports pid 0). An EPERM from anything else (a write, a kill) is not one.
 */
export function isSpawnRefused(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, syscall, pid } = error as { code?: unknown; syscall?: unknown; pid?: unknown };
  if (code !== "EPERM" && code !== "EACCES") return false;
  if (typeof syscall !== "string" || !/^spawn(Sync)?( |$)/.test(syscall)) return false;
  return pid === undefined || pid === null || pid === 0;
}

function report(what: string, refusals: number, error: unknown, startedOnTry: number | null, log: (line: string) => void): void {
  const code = (error as { code?: string }).code ?? "refused";
  const times = refusals === 1 ? "once" : `${refusals} times`;
  log(startedOnTry === null
    ? `${what}: Windows refused to start the process ${times} (${code}); gave up`
    : `${what}: Windows refused to start the process ${times} (${code}); it started on try ${startedOnTry}`);
}

/**
 * Runs `attempt`, which starts one process, again while it fails with a refused spawn (see
 * `isSpawnRefused`), waiting a little longer each time. Any other outcome is returned or thrown as is.
 */
export async function retrySpawn<T>(what: string, attempt: () => Promise<T>, options: SpawnRetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? SPAWN_RETRY_DELAYS_MS;
  const log = options.log ?? console.warn;
  let refusals = 0;
  let last: unknown;
  for (;;) {
    try {
      const value = await attempt();
      if (refusals > 0) report(what, refusals, last, refusals + 1, log);
      return value;
    } catch (error) {
      if (!isSpawnRefused(error)) throw error;
      last = error;
      const delay = delays[refusals];
      refusals++;
      if (delay === undefined) {
        report(what, refusals, error, null, log);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * The same for a synchronous start. The waits block the thread (at most about 750 ms, and only
 * when Windows has refused a process), so this is for tests, tools and starts that must return a
 * process at once.
 */
export function retrySpawnSync<T>(what: string, attempt: () => T, options: SpawnRetryOptions = {}): T {
  const delays = options.delaysMs ?? SPAWN_RETRY_DELAYS_MS;
  const log = options.log ?? console.warn;
  let refusals = 0;
  let last: unknown;
  for (;;) {
    try {
      const value = attempt();
      if (refusals > 0) report(what, refusals, last, refusals + 1, log);
      return value;
    } catch (error) {
      if (!isSpawnRefused(error)) throw error;
      last = error;
      const delay = delays[refusals];
      refusals++;
      if (delay === undefined) {
        report(what, refusals, error, null, log);
        throw error;
      }
      Atomics.wait(pause, 0, 0, delay);
    }
  }
}

/** `execFileSync` with a refused start retried. Same arguments and results. */
export const execFileSyncRetrying = ((file: string, ...rest: unknown[]) =>
  retrySpawnSync(file, () => (execFileSync as (...args: unknown[]) => unknown)(file, ...rest))) as typeof execFileSync;

/** `spawnSync` with a refused start retried (its `error` with pid 0). Same arguments and results. */
export const spawnSyncRetrying = ((file: string, ...rest: unknown[]) =>
  retrySpawnSync(file, () => {
    const result = (spawnSync as (...args: unknown[]) => ReturnType<typeof spawnSync>)(file, ...rest);
    if (result.error && isSpawnRefused(Object.assign(result.error, { pid: result.pid }))) throw result.error;
    return result;
  })) as typeof spawnSync;
