// The overview's Merge queue lane: the core's Queued and Checking lanes drawn as one. The batch under test (preparing,
// checking or bisecting) on top as its box, then the waiting changes in queue order. Finished batches stay on the Merge
// queue page. Elsewhere (Your turn, the Item page, the Items list) an Item's lane is still Queued or Checking.
// Pure, so src/webMergeLane.test.ts can test it without a browser.

import type { BatchView, CardView, LaneView, QueueView } from "../../src/core/views.ts";

export const MERGE_LANE = "merge-queue";

export interface MergeLane {
  batches: BatchView[];
  /** The cards below the "Waiting" divider, in queue order. */
  waiting: CardView[];
  /** The changes in the lane: in a batch (not those sent back to the queue) plus waiting. */
  count: number;
}

/**
 * Whether the board shows the merge queue (its lane, its tab): it is Scope Soup's own, from level 4 (decision 104). Below, only
 * while it still holds or checks changes (after the level was lowered), until it is empty. Board only (no level): shown.
 */
export const queueShown = (level: number | undefined, count: number): boolean => level === undefined || level >= 4 || count > 0;

export function mergeLane(queued: LaneView | undefined, checking: LaneView | undefined, queue: Pick<QueueView, "batches" | "forming" | "waiting">): MergeLane {
  const batches = [...queue.batches, ...queue.forming];
  // A member sent back to the queue shows in the box as "back in queue", and waits below as a card.
  const inBatch = batches.flatMap((batch) => batch.members.filter((member) => member.state !== "requeued"));
  const boxed = new Set(inBatch.flatMap((member) => member.items.map((item) => item.key)));
  const rank = new Map<string, number>();
  for (const entry of queue.waiting) for (const item of entry.items) if (!rank.has(item.key)) rank.set(item.key, entry.position);
  const at = (card: CardView): number => rank.get(card.key) ?? Number.MAX_SAFE_INTEGER;
  const cards = [...(checking?.cards ?? []), ...(queued?.cards ?? [])].filter((card) => !boxed.has(card.key));
  // Stable: a card the queue does not list keeps its lane's order, after the listed ones.
  const waiting = cards.map((card, index) => ({ card, index })).sort((a, b) => at(a.card) - at(b.card) || a.index - b.index).map(({ card }) => card);
  return { batches, waiting, count: inBatch.length + waiting.length };
}
