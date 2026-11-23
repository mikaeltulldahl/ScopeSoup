// Blockers the triage found, kept by Scope Soup itself. On a host whose items Scope Soup writes (meta branch) they also go to
// the item's own `blockedBy` field; this record makes them count there at once. They are read into each item's `blockedBy`
// wherever the store's items are read for the board and the tick. GitHub Items are not kept here: their blockers are
// GitHub's issue dependencies, written through and read back by the poll, so this record is never read for them.

import type { Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "./store.ts";

const KEY = "scopesoup.blockedBy";

/** The host id of GitHub Items (the GitHub adapter's default, which the hosts set up never change). */
const GITHUB_HOST = "github";

/** True for an Item whose blockers are only its host's (GitHub's issue dependencies), never this record. */
export const blockersOnHost = (ref: Ref): boolean => ref.host === GITHUB_HOST;

export function loadOwnBlockers(store: Store): Record<string, Ref[]> {
  const text = store.getValue(KEY);
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Ref[]>) : {};
  } catch {
    return {};
  }
}

/** Records the blockers the newest triage found on `item` (replacing what an earlier one found), with an event. */
export function setOwnBlockers(store: Store, item: Ref, blockers: readonly Ref[], actor: string, at: string, reason: string): void {
  store.tx(() => {
    const all = loadOwnBlockers(store);
    const key = refKey(item);
    if (blockers.length > 0) all[key] = blockers.map((each) => ({ host: each.host, kind: each.kind, id: each.id, ...(each.url ? { url: each.url } : {}) }));
    else delete all[key];
    store.setValue(KEY, JSON.stringify(all));
    store.appendEvent({ kind: "orchestrator.blockers_recorded", subject: key, actor, data: { reason, blockedBy: blockers.map(refKey) } }, at);
  });
}

/**
 * The items with Scope Soup's own blockers added to their `blockedBy` (each once). Items without any are returned as they are, and
 * so are GitHub Items: an entry left from earlier is not read (docs/github-mapping.md, section 6).
 */
export function withOwnBlockers(items: WorkItem[], own: Record<string, Ref[]>): WorkItem[] {
  if (Object.keys(own).length === 0) return items;
  return items.map((item) => {
    const extra = blockersOnHost(item.ref) ? undefined : own[refKey(item.ref)];
    if (!extra || extra.length === 0) return item;
    const have = new Set(item.blockedBy.map(refKey));
    const added = extra.filter((each) => !have.has(refKey(each)));
    return added.length === 0 ? item : { ...item, blockedBy: [...item.blockedBy, ...added] };
  });
}
