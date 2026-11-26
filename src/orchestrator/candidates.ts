// Which work items are ready to start, and in what order. Pure.

import type { Change, RecordedAnswer, Ref, WorkItem } from "../model/types.ts";
import { holdStands } from "../model/people.ts";
import { refKey } from "../model/types.ts";
import type { Job, Jobs } from "./jobs.ts";
import type { NamedFiles } from "../core/sameFiles.ts";
import { mayConflictWith, sameFilesAs } from "../core/sameFiles.ts";
import { awaitsImplement } from "./recheck.ts";

export interface Readiness {
  ready: WorkItem[];
  /** Items in "todo" that are not ready, each with the reason in words. */
  held: { item: WorkItem; reason: string }[];
}

/**
 * Ready: state todo, not blocked, nobody holds it, no decision pending, no open change, no job.
 * Every item of the backlog is a candidate: there is no invite label.
 */
export function readyItems(items: WorkItem[], changes: Change[], jobs: Jobs, now: string): Readiness {
  const byKey = new Map(items.map((item) => [refKey(item.ref), item]));
  const touched = new Set<string>();
  const merged = new Set<string>();
  for (const change of changes) {
    if (change.state === "open") for (const work of change.works) touched.add(refKey(work));
    if (change.state === "merged") for (const work of change.works) merged.add(refKey(work));
  }
  const at = Date.parse(now);
  const result: Readiness = { ready: [], held: [] };
  for (const item of items) {
    if (item.state !== "todo") continue;
    const key = refKey(item.ref);
    const job = jobs[key];
    let reason: string | undefined;
    if (job) reason = job.parked ? `parked as "${job.parked.as}": ${job.parked.reason}` : `already in work (${job.step})`;
    // An umbrella is never started or triaged itself.
    else if (item.openChildren > 0) reason = `has ${item.openChildren} open child item(s)`;
    else if ((item.children ?? 0) > 0) reason = "all its child items are done; waiting for a person to close it";
    else if (item.needsDecision) reason = "waits for a decision by a person";
    else if (item.holder && holdStands(item.holder, at)) reason = `held by ${item.holder.actor.name}`;
    else if (touched.has(key)) reason = "an open change already covers it";
    else if (merged.has(key)) reason = "its change is merged; waiting for the host to close the item";
    else {
      const open = item.blockedBy.filter((blocker) => {
        const other = byKey.get(refKey(blocker));
        return !other || (other.state !== "done" && other.state !== "abandoned");
      });
      if (open.length > 0) reason = `blocked by ${open.map((blocker) => blocker.id).join(", ")}`;
    }
    if (reason) result.held.push({ item, reason });
    else result.ready.push(item);
  }
  return result;
}

export { compareItems, hasTriage } from "./score.ts";
import { compareItems } from "./score.ts";

/**
 * Changes that count against readiness. On a host that keeps a log per item, an item's change has the
 * item's own id: it is Scope Soup's work on the item's branch, which a new start of the item continues.
 * It does not hold the item back the way someone else's change does.
 */
export function foreignChanges(changes: Change[]): Change[] {
  return changes.filter((change) => !change.works.some((work) => work.host === change.ref.host && work.id === change.ref.id));
}

/**
 * The planned order of execution, next first: ready items in `compareItems` order, then items that
 * cannot start yet (blocked, waiting on a person, ...) in the same order, then the rest.
 * The orchestrator's pick order is the first part of this, so the board shows what will be picked.
 */
export function planOrder(items: WorkItem[], changes: Change[], jobs: Jobs, now: string, bugLabels: string[]): WorkItem[] {
  const compare = compareItems(bugLabels, jobs, items);
  const readiness = readyItems(items, foreignChanges(changes), jobs, now);
  const held = readiness.held.map((entry) => entry.item);
  const listed = new Set([...readiness.ready, ...held]);
  const rest = items.filter((item) => !listed.has(item));
  return [...readiness.ready.sort(compare), ...held.sort(compare), ...rest.sort(compare)];
}

/**
 * The busy Items, with the paths and links their triage named: a running or started implement step, a review, or a change that
 * exists and is not on main yet (in the merge queue, handed over, or parked for a person after a revision was written). A job
 * parked before any change exists (a triage question, a rewrite, not ready) holds nothing back; a merged one is over.
 */
export function busyItems(jobs: Jobs): NamedFiles[] {
  return Object.values(jobs).flatMap((job) => {
    if (job.merged !== undefined) return [];
    const busy = job.parked
      ? job.parked.as === "queued" || job.parked.as === "handed-over" || job.head !== undefined || job.queued !== undefined
      : job.step === "review" || (job.step === "implement" && (job.sessionId !== undefined || !awaitsImplement(job)));
    if (!busy) return [];
    const paths = (job.triage?.paths ?? []).filter((path) => path.trim());
    return [{ item: job.item, paths, ...(job.triage?.links?.length ? { links: job.triage.links } : {}) }];
  });
}

/** What a job waits for before its first implement step: busy Items that change the same files, and busy ones linked to it with `conflictsWith`. */
export interface SameFilesWait {
  waitsFor: Ref[];
  /** Linked with `conflictsWith` (not also in `waitsFor`), with no "Go on with both" for the pair. */
  mayConflict: Ref[];
}

/**
 * The busy Items a job waits for before its first implement step (`busyItems`): those whose named paths overlap its own, and those
 * linked to it with `conflictsWith` by either triage, unless a person said to go on with both. Null for a job that is not about to
 * start implementing, or that waits for none.
 */
export function sameFilesWait(job: Job, busy: readonly NamedFiles[], answers: readonly RecordedAnswer[]): SameFilesWait | null {
  if (job.sessionId !== undefined || !awaitsImplement(job)) return null;
  const self: NamedFiles = { item: job.item, paths: (job.triage?.paths ?? []).filter((path) => path.trim()), ...(job.triage?.links ? { links: job.triage.links } : {}) };
  const waitsFor = sameFilesAs(self, busy);
  const mayConflict = mayConflictWith(self, busy, answers).filter((ref) => !waitsFor.some((each) => refKey(each) === refKey(ref)));
  return waitsFor.length + mayConflict.length > 0 ? { waitsFor, mayConflict } : null;
}
