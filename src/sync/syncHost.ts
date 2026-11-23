// One pass over one host: pulls what the host has into the store. Each part fails on its own.

import type { Batch, Change, Ref, Run, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Host } from "../ports/host.ts";
import { WorkGone } from "../ports/host.ts";
import type { Store } from "../store/store.ts";

export const ACTOR = "sync";

export const cursorKey = (hostId: string, part: "work" | "changes"): string => `sync:${hostId}:cursor:${part}`;
/** The kv key that holds a host's runners as a JSON array of Runner. */
export const runnersKey = (hostId: string): string => `runners:${hostId}`;
/** The kv key that holds when a host was last synced without a failure. */
export const lastOkKey = (hostId: string): string => `sync:${hostId}:lastOk`;

export interface HostSyncOptions {
  /** Pipelines whose history is always pulled, besides those seen in runs. */
  pipelines: string[];
  recentLimit: number;
  batchLimit: number;
  /** Ignore the cursors and list everything, then check what the store has that the list did not. */
  full: boolean;
}

export interface PartFailure {
  part: string;
  error: string;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Returns the failures, one per part that threw. Never throws. */
export async function syncHost(store: Store, host: Host, options: HostSyncOptions, now: () => string): Promise<PartFailure[]> {
  const hostId = host.info.id;
  const failures: PartFailure[] = [];
  const part = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      failures.push({ part: name, error: errorText(error) });
    }
  };

  /** A cursor listing, and on a full pass a check of the open objects the listing did not return. */
  async function listed<T extends { ref: Ref; state: string }>(
    kind: "work" | "change",
    key: string,
    list: (since?: string) => Promise<{ items: T[]; cursor: string; removed?: Ref[]; movedTo?: Record<string, string> }>,
    get: (ref: Ref) => Promise<T | null>,
    isOpen: (object: T) => boolean,
  ): Promise<void> {
    const cursor = options.full ? undefined : (store.getValue(key) ?? undefined);
    const page = await list(cursor);
    const refetched: { ref: Ref; object: T | null; gone?: WorkGone }[] = [];
    if (cursor === undefined) {
      const seen = new Set(page.items.map((item) => item.ref.id));
      for (const stored of store.list<T>(kind, hostId)) {
        if (!isOpen(stored) || seen.has(stored.ref.id)) continue;
        try {
          refetched.push({ ref: stored.ref, object: await get(stored.ref) });
        } catch (error) {
          // Moved elsewhere or deleted on the host: it leaves the store, and the event says why.
          if (!(error instanceof WorkGone)) throw error;
          refetched.push({ ref: stored.ref, object: null, gone: error });
        }
      }
    }
    const why = (ref: Ref, movedTo: string | undefined, message?: string): Record<string, unknown> | undefined =>
      movedTo ? { reason: `${ref.id} was moved to ${movedTo} on ${hostId}; it leaves the board.`, movedTo } : message ? { reason: message } : undefined;
    const at = now();
    store.tx(() => {
      for (const item of page.items) store.put(item, ACTOR, at);
      for (const ref of page.removed ?? []) store.remove(ref, ACTOR, at, why(ref, page.movedTo?.[refKey(ref)]));
      for (const { ref, object, gone } of refetched) {
        if (object) store.put(object, ACTOR, at);
        else store.remove(ref, ACTOR, at, why(ref, gone?.movedTo, gone?.message));
      }
      store.setValue(key, page.cursor);
    });
  }

  const { work, changes, ci, batches } = host;

  if (work) {
    await part("work", () =>
      listed<WorkItem>("work", cursorKey(hostId, "work"), (since) => work.listWork(since), (ref) => work.getWork(ref), (item) => item.state !== "done" && item.state !== "abandoned"),
    );
  }

  if (changes) {
    await part("changes", () =>
      listed<Change>("change", cursorKey(hostId, "changes"), (since) => changes.listChanges(since), (ref) => changes.getChange(ref), (change) => change.state === "open"),
    );
  }

  if (ci) {
    await part("runs", async () => {
      const active = await ci.activeRuns();
      const stored = store.list<Run>("run", hostId);
      const isActive = (run: Run): boolean => run.status === "queued" || run.status === "running";
      const activeIds = new Set(active.map((run) => run.ref.id));

      // Runs the store thinks are going but the host no longer lists: ask how they ended.
      const lost = stored.filter((run) => isActive(run) && !activeIds.has(run.ref.id));
      const ended = new Map<string, Run>();
      for (const sha of new Set(lost.map((run) => run.sha))) {
        for (const run of await ci.runsFor(sha)) ended.set(run.ref.id, run);
      }

      const pipelines = new Set([...options.pipelines, ...active.map((run) => run.pipeline), ...stored.map((run) => run.pipeline)]);
      pipelines.delete("");
      const recent = new Map<string, Run[]>();
      for (const pipeline of pipelines) recent.set(pipeline, await ci.recentRuns(pipeline, options.recentLimit));

      const at = now();
      store.tx(() => {
        for (const run of active) store.put(run, ACTOR, at);
        for (const run of lost) {
          const final = ended.get(run.ref.id);
          if (final) store.put(final, ACTOR, at);
          else store.remove(run.ref, ACTOR, at);
        }
        for (const [pipeline, runs] of recent) {
          for (const run of runs) if (!activeIds.has(run.ref.id)) store.put(run, ACTOR, at);
          // History is the host's recent window: finished runs that fell out of it go.
          const keep = new Set(runs.map((run) => run.ref.id));
          for (const run of stored) {
            if (run.pipeline === pipeline && !isActive(run) && !keep.has(run.ref.id)) store.remove(run.ref, ACTOR, at);
          }
        }
      });
    });

    const runners = ci.runners?.bind(ci);
    if (runners) {
      await part("runners", async () => {
        const list = [...(await runners())].sort((a, b) => a.id.localeCompare(b.id));
        const json = JSON.stringify(list);
        const key = runnersKey(hostId);
        if (store.getValue(key) === json) return;
        store.tx(() => {
          store.setValue(key, json);
          store.appendEvent({ kind: "runner.updated", actor: ACTOR, data: { host: hostId, runners: list } }, now());
        });
      });
    }
  }

  if (batches) {
    await part("batches", async () => {
      const list = await batches.listBatches(options.batchLimit);
      const keep = new Set(list.map((batch) => batch.ref.id));
      const at = now();
      store.tx(() => {
        for (const batch of list) store.put(batch, ACTOR, at);
        for (const stored of store.list<Batch>("batch", hostId)) {
          if (!keep.has(stored.ref.id)) store.remove(stored.ref, ACTOR, at);
        }
      });
    });
  }

  return failures;
}
