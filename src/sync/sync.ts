// The sync loop: pulls every configured host into the store on a timer. Host-agnostic.
// It never throws: a failure becomes a `sync.failed` event and a longer wait.

import type { Host } from "../ports/host.ts";
import type { Store } from "../store/store.ts";
import { KEYS } from "../store/keys.ts";
import { ACTOR, lastOkKey, runnersKey, syncHost } from "./syncHost.ts";

/** Calls `fn` once after `ms`; returns a function that cancels it. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export interface SyncOptions {
  store: Store;
  hosts: Host[];
  intervalMs: number;
  now?: () => Date;
  setTimer?: SetTimer;
  /** Pipelines whose history is always pulled, besides those seen in runs. */
  pipelines?: string[];
  /** Finished runs kept per pipeline. Default 20. */
  recentLimit?: number;
  /** Newest batches kept. Default 20. */
  batchLimit?: number;
  /** The wait doubles per failed cycle up to this. Default 15 minutes. */
  maxBackoffMs?: number;
  /** Every this many cycles the cursors are ignored and everything is listed and reconciled. 0: never. Default 120. */
  fullEvery?: number;
  /** Refresh at once when a host's WatchPort reports a change. Default true. */
  useWatch?: boolean;
}

export interface Sync {
  /** Runs a cycle now, then one after every interval. */
  start(): void;
  stop(): void;
  /** Runs a cycle now. While one runs, all callers share the one cycle that follows it. */
  refreshNow(): Promise<void>;
  /** How long the loop waits after the last cycle: the interval, longer after failures. */
  nextDelayMs(): number;
}

const realTimer: SetTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
};

export function createSync(options: SyncOptions): Sync {
  const { store, hosts } = options;
  const clock = options.now ?? (() => new Date());
  const now = (): string => clock().toISOString();
  const setTimer = options.setTimer ?? realTimer;
  const fullEvery = options.fullEvery ?? 120;
  const maxBackoffMs = Math.max(options.maxBackoffMs ?? 15 * 60_000, options.intervalMs);

  let started = false;
  let cancelTimer: (() => void) | null = null;
  let unwatch: (() => void)[] = [];
  let failedCycles = 0;
  let cycles = 0;
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  function fail(host: string, part: string, error: string): void {
    try {
      store.appendEvent({ kind: "sync.failed", actor: ACTOR, data: { host, part, error } }, now());
    } catch {
      // The store itself is failing; the next cycle will show it again.
    }
  }

  /** Writes what the board reads: all hosts' runners as one list, and when the last cycle ran and how it went. */
  function summarise(errors: string[]): void {
    try {
      const runners = hosts.flatMap((host) => {
        try {
          const list: unknown = JSON.parse(store.getValue(runnersKey(host.info.id)) ?? "[]");
          return Array.isArray(list) ? list : [];
        } catch {
          return [];
        }
      });
      store.setValue(KEYS.runners, JSON.stringify(runners));
      const previous = errors.length > 0 ? lastGoodAt() : undefined;
      const state = errors.length === 0 ? { lastAt: now() } : { ...(previous ? { lastAt: previous } : {}), error: errors.join("; ") };
      store.setValue(KEYS.sync, JSON.stringify(state));
    } catch {
      // The store itself is failing; the next cycle will show it again.
    }
  }

  function lastGoodAt(): string | undefined {
    try {
      const value: unknown = JSON.parse(store.getValue(KEYS.sync) ?? "{}");
      const lastAt = (value as { lastAt?: unknown }).lastAt;
      return typeof lastAt === "string" ? lastAt : undefined;
    } catch {
      return undefined;
    }
  }

  async function cycle(): Promise<void> {
    const full = fullEvery > 0 && cycles > 0 && cycles % fullEvery === 0;
    cycles += 1;
    let clean = true;
    const errors: string[] = [];
    for (const host of hosts) {
      try {
        const failures = await syncHost(
          store,
          host,
          { pipelines: options.pipelines ?? [], recentLimit: options.recentLimit ?? 20, batchLimit: options.batchLimit ?? 20, full },
          now,
        );
        for (const failure of failures) {
          fail(host.info.id, failure.part, failure.error);
          errors.push(`${host.info.id} ${failure.part}: ${failure.error}`);
        }
        if (failures.length === 0) store.setValue(lastOkKey(host.info.id), now());
        else clean = false;
      } catch (error) {
        clean = false;
        const message = error instanceof Error ? error.message : String(error);
        fail(host.info.id, "host", message);
        errors.push(`${host.info.id}: ${message}`);
      }
    }
    summarise(errors);
    failedCycles = clean ? 0 : failedCycles + 1;
  }

  const nextDelayMs = (): number => Math.min(options.intervalMs * 2 ** Math.min(failedCycles, 20), maxBackoffMs);

  function run(): Promise<void> {
    cancelTimer?.();
    cancelTimer = null;
    const current: Promise<void> = cycle()
      .catch(() => undefined)
      .then(() => {
        running = null;
        if (started && !queued) cancelTimer = setTimer(() => void run(), nextDelayMs());
      });
    running = current;
    return current;
  }

  function refreshNow(): Promise<void> {
    if (!running) return run();
    if (!queued) {
      queued = running.then(() => {
        queued = null;
        return run();
      });
    }
    return queued;
  }

  return {
    start() {
      if (started) return;
      started = true;
      void refreshNow();
      if (options.useWatch === false) return;
      for (const host of hosts) {
        host.watch
          ?.watch(() => void refreshNow())
          .then((stop) => {
            if (started) unwatch.push(stop);
            else stop();
          })
          .catch((error: unknown) => fail(host.info.id, "watch", error instanceof Error ? error.message : String(error)));
      }
    },

    stop() {
      started = false;
      cancelTimer?.();
      cancelTimer = null;
      for (const stop of unwatch) stop();
      unwatch = [];
    },

    refreshNow,
    nextDelayMs,
  };
}
