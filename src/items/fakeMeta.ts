// A meta branch in memory, as a move back writes it (`MetaTarget` in moveToMeta.ts), for tests and the demo: a batch is one
// "commit" that finds an Item by its `unique` value or makes it with the next id of the prefix, links by key, and keeps the lines.
// Never touches git.

import type { BatchItem, BatchResult } from "../hosts/metaBranch/writer.ts";
import type { ItemInput } from "../hosts/metaBranch/serialize.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import type { WorkPatch } from "../ports/host.ts";
import type { MetaTarget } from "./moveToMeta.ts";

export interface FakeMeta extends MetaTarget {
  items: Map<string, { input: ItemInput; unique?: string; lines: { kind: string; fields: Record<string, unknown> }[] }>;
  /** How many batches wrote something. */
  commits: number;
  /** The next batch fails with this message, once. */
  failNext?: string;
  /** What the batches' sharing round says (`pending`: not on the remote yet). */
  sharing: "local" | "shared" | "pending";
}

export function fakeMeta(prefix: string, at = "2026-11-25T09:00:00.000Z"): FakeMeta {
  let next = 1;
  const fake: FakeMeta = {
    items: new Map(),
    commits: 0,
    sharing: "local",
    async createItems(batch: readonly BatchItem[]): Promise<BatchResult> {
      if (fake.failNext) {
        const message = fake.failNext;
        delete fake.failNext;
        throw new Error(message);
      }
      const ids = new Map<string, { id: string; created: boolean }>();
      for (const item of batch) {
        const there = [...fake.items].find(([, each]) => item.unique && each.unique?.toLowerCase() === item.unique[1].toLowerCase());
        ids.set(item.key, there ? { id: there[0], created: false } : { id: `${prefix}-${next++}`, created: true });
      }
      for (const item of batch) {
        const { id, created } = ids.get(item.key)!;
        if (!created) continue;
        const made = item.make((key) => ids.get(key)?.id);
        fake.items.set(id, { input: made.input, ...(item.unique ? { unique: item.unique[1] } : {}), lines: (made.lines ?? []).map((line) => ({ kind: line.kind, fields: line.fields ?? {} })) });
      }
      const changed = [...ids.values()].some((each) => each.created);
      if (changed) fake.commits++;
      return { items: ids, commit: changed ? `c${fake.commits}` : null, changed, sharing: { at, state: fake.sharing, pushes: 0, refusedPushes: 0, replayed: 0, conflicts: [], renamed: [], locks: [], ...(fake.sharing === "pending" ? { problem: "the remote did not answer" } : {}) } };
    },
    async listWork(): Promise<WorkItem[]> {
      return [...fake.items].map(([id, item]) => ({
        ref: { host: "metaBranch", kind: "work", id }, title: item.input.title, state: item.input.state ?? "todo", hostState: item.input.state ?? "todo",
        labels: item.input.labels ?? [], blockedBy: [], openChildren: 0, updatedAt: at,
        ...(item.input.body ? { body: item.input.body } : {}), ...(item.input.verification ? { verification: item.input.verification } : {}),
        log: item.lines.map((line) => ({ at, by: { who: "test", agent: false }, kind: line.kind, fields: line.fields })),
      }) as WorkItem);
    },
    async editWork(ref: Ref, patch: WorkPatch) {
      const item = fake.items.get(ref.id);
      if (!item) throw new Error(`There is no item ${ref.id}.`);
      if (patch.body !== undefined) item.input.body = patch.body;
      if (typeof patch.verification === "string") item.input.verification = patch.verification;
      return { work: ref };
    },
  };
  return fake;
}
