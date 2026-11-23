// What one tick carries around: the dependencies, the configuration in use, the jobs, and
// the two ways of writing to the log.

import type { ConfigSource } from "../config/loader.ts";
import type { ProjectConfig } from "../config/types.ts";
import type { Store } from "../store/store.ts";
import type { Jobs } from "./jobs.ts";
import { saveJobs } from "./jobs.ts";
import type { Actions, AgentRunner } from "./ports.ts";
import type { MergeQueue } from "./mergeQueue.ts";
import type { QueueDriver } from "./queueDriver.ts";
import type { Resources } from "./resources.ts";

export const ACTOR = "orchestrator";
const SAID_KEY = "orchestrator.said";

export interface TickDeps {
  store: Store;
  runner: AgentRunner;
  config: ConfigSource;
  actions: Actions;
  /** ISO 8601, UTC. */
  now: () => string;
  /** The merge queue's driver: level 4 merges through it. */
  queue?: QueueDriver;
  /** The merge queue lease, when several machines share the main branch: only the machine holding it merges. */
  mergeQueue?: MergeQueue;
  /** The limited resources a session may need: a unit is taken before the session starts. */
  resources?: Resources;
  /** How long the tick that starts the merge queue waits for it before it moves on (default 2000). Tests set it. */
  queueWaitMs?: number;
}

export interface Context {
  deps: TickDeps;
  config: ProjectConfig;
  at: string;
  jobs: Jobs;
  /**
   * Records a decision: saves the jobs and writes the event in one transaction.
   * Every event carries its reason in plain words.
   */
  commit(kind: string, reason: string, subject?: string, data?: Record<string, unknown>): void;
  /**
   * Records a standing condition ("nothing to do because ...", "would start ..."). Written once,
   * and again only when the reason changes or after something else happened in between.
   */
  say(kind: string, reason: string, subject?: string, data?: Record<string, unknown>): void;
  /** Lets a standing condition be reported again the next time it holds. */
  forget(kind: string, subject?: string): void;
  /** Runs a host action; a failure is logged and does not stop the tick. */
  act(what: string, subject: string, run: () => Promise<unknown>): Promise<void>;
}

export function createLog(store: Store, at: string, jobs: () => Jobs | null): Pick<Context, "commit" | "say" | "forget"> {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(store.getValue(SAID_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  };
  return {
    commit(kind, reason, subject, data) {
      store.tx(() => {
        const current = jobs();
        if (current) saveJobs(store, current);
        if (store.getValue(SAID_KEY) !== "{}") store.setValue(SAID_KEY, "{}");
        store.appendEvent({ kind, subject, actor: ACTOR, data: { reason, ...data } }, at);
      });
    },
    forget(kind, subject) {
      const said = read();
      const key = `${kind}|${subject ?? ""}`;
      if (!(key in said)) return;
      delete said[key];
      store.setValue(SAID_KEY, JSON.stringify(said));
    },
    say(kind, reason, subject, data) {
      const said = read();
      const key = `${kind}|${subject ?? ""}`;
      if (said[key] === reason) return;
      said[key] = reason;
      store.tx(() => {
        store.setValue(SAID_KEY, JSON.stringify(said));
        store.appendEvent({ kind, subject, actor: ACTOR, data: { reason, ...data } }, at);
      });
    },
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
