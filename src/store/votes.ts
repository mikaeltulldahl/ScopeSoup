// The votes on Items of a host that has no place for them: a GitHub Item has no header, so its vote lives here,
// in Scope Soup's own store (one record, each Item's number), and is read into `vote` wherever the store's items are read. On the
// meta branch host the vote is a field of the Item's own header and this record is never read for it.

import type { Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { cleanVote } from "../model/vote.ts";
import type { Store } from "./store.ts";

const KEY = "scopesoup.votes";

/** True for an Item whose vote is kept in the store (GitHub's), not in a header. */
export const voteInStore = (ref: Ref): boolean => ref.host === "github";

export function loadVotes(store: Store): Record<string, number> {
  const text = store.getValue(KEY);
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, vote]) => [key, cleanVote(vote)]).filter(([, vote]) => vote !== 0));
  } catch {
    return {};
  }
}

/** Sets one Item's vote (0 clears it) with its event, in one transaction. */
export function setVote(store: Store, item: Ref, vote: number, actor: string, at: string): void {
  store.tx(() => {
    const all = loadVotes(store);
    const key = refKey(item);
    const before = all[key] ?? 0;
    const next = cleanVote(vote);
    if (next !== 0) all[key] = next;
    else delete all[key];
    store.setValue(KEY, JSON.stringify(all));
    store.appendEvent({ kind: "item.voted", subject: key, actor, data: { from: before, to: next } }, at);
  });
}

/** The items with their stored vote read into `vote`; items whose vote is in a header are returned as they are. */
export function withVotes(items: WorkItem[], votes: Record<string, number>): WorkItem[] {
  if (Object.keys(votes).length === 0) return items;
  return items.map((item) => {
    const vote = voteInStore(item.ref) ? votes[refKey(item.ref)] : undefined;
    return vote ? { ...item, vote } : item;
  });
}
