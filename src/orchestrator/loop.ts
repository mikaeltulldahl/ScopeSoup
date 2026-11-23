// The loop around the tick: one tick at a time, the next one on a timer, sooner when something
// is due or someone asks. Timers are injectable for tests.

import { pauseAtStartup } from "../store/control.ts";
import { errorText } from "./context.ts";
import type { TickDeps, TickReport } from "./tick.ts";
import { tick } from "./tick.ts";

export interface LoopDeps extends TickDeps {
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called after every tick, for the status endpoint or a test. */
  onTick?: (report: TickReport) => void;
}

export interface Loop {
  /** Starts ticking, paused: agents and the merge queue stay paused until a person presses Start. */
  start(): void;
  /** Stops scheduling and waits for a tick in progress. Running sessions are left alone. */
  stop(): Promise<void>;
  /** Asks for a tick now. Requests made while one runs are folded into a single follow-up. */
  refresh(): void;
}

const MIN_DELAY_MS = 200;
const FALLBACK_TICK_MS = 30_000;

export function createLoop(deps: LoopDeps): Loop {
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let timer: unknown;
  let current: Promise<void> | null = null;
  let again = false;
  let stopped = true;

  function schedule(ms: number): void {
    if (stopped) return;
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      current = run();
    }, ms);
  }

  async function run(): Promise<void> {
    let delay = FALLBACK_TICK_MS;
    try {
      const report = await tick(deps);
      const config = deps.config.load().config;
      if (config) delay = config.settings.tickSeconds.value * 1000;
      if (report.wakeAt) delay = Math.min(delay, Math.max(MIN_DELAY_MS, Date.parse(report.wakeAt) - Date.parse(deps.now())));
      deps.onTick?.(report);
    } catch (error) {
      try {
        deps.store.appendEvent({ kind: "orchestrator.tick_failed", actor: "orchestrator", data: { reason: `The tick failed: ${errorText(error)}` } }, deps.now());
      } catch {
        // The store itself is failing; the next tick tries again.
      }
    }
    current = null;
    if (again) {
      again = false;
      delay = 0;
    }
    schedule(delay);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      // Scope Soup comes up paused after every start-up: nothing runs until Start agents (and Start merge queue at level 4).
      // Work under way goes on from the items' logs when it is pressed (recover.ts).
      pauseAtStartup(deps.store, deps.now());
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (current) await current;
    },
    refresh() {
      if (stopped) return;
      if (current) again = true;
      else schedule(0);
    },
  };
}
