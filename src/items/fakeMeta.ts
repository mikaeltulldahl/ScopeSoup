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
  /**
   * Why an Item is refused, as the real writer refuses a header or text it cannot store; default: a control character (other than
   * tab and line end) or a lone surrogate anywhere in its title, description or verification.
   */
  refuse: (input: ItemInput) => string | undefined;
}

export function fakeMeta(prefix: string, at = "2026-11-25T09:00:00.000Z"): FakeMeta {
  let next = 1;
  const fake: FakeMeta = {
    items: new Map(),
    commits: 0,
    sharing: "local",
    refuse: (input) => (/[\u0000-\u0008\u000b-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(`${input.title}${input.body ?? ""}${input.verification ?? ""}`) ? "it holds a control character or a lone surrogate" : undefined),
    async createItems(batch: readonly BatchItem[], options: { dryRun?: boolean } = {}): Promise<BatchResult> {
      if (fake.failNext) {
        const message = fake.failNext;
        delete fake.failNext;
        throw new Error(message);
      }
      const ids = new Map<string, { id: string; created: boolean }>();
      let counter = next;
      for (const item of batch) {
        const there = [...fake.items].find(([, each]) => item.unique && each.unique?.toLowerCase() === item.unique[1].toLowerCase());
        ids.set(item.key, there ? { id: there[0], created: false } : { id: `${prefix}-${counter++}`, created: true });
      }
      // The whole batch is checked first: a refused Item writes nothing, as the one commit would not be made.
      const made = new Map(batch.filter((item) => ids.get(item.key)!.created).map((item) => [item.key, item.make((key) => ids.get(key)?.id)] as const));
      for (const [key, each] of made) {
        const why = fake.refuse(each.input);
        if (why) throw new Error(`The item ${ids.get(key)!.id} cannot be written: ${why}.`);
      }
      if (options.dryRun) return { items: ids, commit: null, changed: false, sharing: null };
      next = counter;
      for (const item of batch) {
        const each = made.get(item.key);
        if (!each) continue;
        fake.items.set(ids.get(item.key)!.id, { input: each.input, ...(item.unique ? { unique: item.unique[1] } : {}), lines: (each.lines ?? []).map((line) => ({ kind: line.kind, fields: line.fields ?? {} })) });
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
