// An Overturn while the change has not merged goes into the running work. The answer is kept here until the
// cycle hands it to the implementor's own session, the way review findings go back (decision 57); only once the change has
// merged does an Overturn file a new Item. Kept apart from the jobs, so a person's press never races the tick's save
// of a job it is settling.

import type { Assumption, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import type { Job } from "./jobs.ts";
import { loadJobs } from "./jobs.ts";

/** A person's overturn kept for the running work of an Item. Agent and person text: data. */
export interface PendingOverturn {
  /** The decision's id, as the item's `assumptions` name it. */
  id: string;
  question: string;
  chosen: string;
  answer: string;
  by: string;
  at: string;
}

/** By the Item's ref key, oldest first. */
export type PendingOverturns = Record<string, PendingOverturn[]>;

const KEY = "orchestrator.overturns";

export function readOverturns(store: Store): PendingOverturns {
  const text = store.getValue(KEY);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as PendingOverturns) : {};
  } catch {
    return {};
  }
}

function writeOverturns(store: Store, pending: PendingOverturns): void {
  for (const key of Object.keys(pending)) if (pending[key]!.length === 0) delete pending[key];
  store.setValue(KEY, JSON.stringify(pending));
}

/**
 * Whether the job's work takes an overturn: the Item is open, and its change has not merged and is not out of the implementor's
 * hands (in the merge queue, handed over to a person to merge, or owing its hand-over). Those, and an Item with no work under way,
 * get a new Item as before.
 */
export function takesOverturn(job: Job | undefined, item: Pick<WorkItem, "state">): boolean {
  if (!job || item.state === "done" || item.state === "abandoned") return false;
  if (job.merged !== undefined || job.queued !== undefined || job.owes !== undefined) return false;
  return job.parked?.as !== "queued" && job.parked?.as !== "handed-over";
}

/**
 * A person overturned `decision` of `item` with `answer`: kept for its running work, in one transaction with the event. Pressed
 * again (the verdict could not be written the first time), an overturn kept or handed to the work already is not kept twice, so
 * the implementor is not told twice. False when the work does not take it (`takesOverturn`): nothing is kept.
 */
export function overturnIntoWork(store: Store, item: WorkItem, decision: Assumption, answer: string, by: string, at: string): boolean {
  return store.tx(() => {
    const key = refKey(item.ref);
    const job = loadJobs(store)[key];
    const pending = readOverturns(store);
    const list = pending[key] ?? [];
    if (list.some((each) => each.id === decision.id) || job?.overturned?.includes(decision.id)) return true;
    if (!takesOverturn(job, item)) return false;
    pending[key] = [...list, { id: decision.id, question: decision.question, chosen: decision.chosen, answer: answer.trim(), by, at }];
    writeOverturns(store, pending);
    store.appendEvent({
      kind: "orchestrator.overturn_kept", subject: key, actor: "orchestrator",
      data: { reason: `A person overturned a decision on ${item.ref.id} while its change has not merged: it goes into the running work, and the implementor's own session is told before the next step. No new Item is filed.`, id: decision.id },
    }, at);
    return true;
  });
}

/** The overturns kept for the Item `key`, oldest first; nothing is taken out. */
export function overturnsFor(store: Store, key: string): PendingOverturn[] {
  return readOverturns(store)[key] ?? [];
}

/** Takes the overturns `ids` out of the Item's list. Call it in the transaction that saves the job they were handed to. */
export function dropOverturns(store: Store, key: string, ids: readonly string[]): void {
  const pending = readOverturns(store);
  const list = pending[key];
  if (!list) return;
  pending[key] = list.filter((each) => !ids.includes(each.id));
  writeOverturns(store, pending);
}

/** What the implementor is told of a person's overturns. */
export function overturnMessage(list: readonly PendingOverturn[]): string {
  return [...list.map((each) => `A person overturned decision "${each.question}" (you chose: ${each.chosen}): ${each.answer}`), "Change the work to match before review, and commit."].join("\n");
}
