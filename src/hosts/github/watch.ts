// WatchPort by polling: runs a probe on a timer and passes on what it reports.

import type { HostEvent, WatchPort } from "../../ports/host.ts";

/** Calls `fn` once after `ms`; returns a function that cancels it. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

const realTimer: SetTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
};

export function pollingWatch(probe: () => Promise<HostEvent[]>, intervalMs: number, setTimer: SetTimer = realTimer): WatchPort {
  return {
    async watch(onEvent) {
      let stopped = false;
      let cancel: (() => void) | null = null;
      const round = async (): Promise<void> => {
        try {
          for (const event of await probe()) if (!stopped) onEvent(event);
        } catch {
          // A failed probe costs only delay; the next round tries again.
        }
        if (!stopped) cancel = setTimer(() => void round(), intervalMs);
      };
      await round();
      return () => {
        stopped = true;
        cancel?.();
      };
    },
  };
}
