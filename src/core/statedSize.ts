// An item that states its own size skips the triage and goes straight to implement.
// Decided earlier, kept without a setting when the triage slider went. With risk classes removed
//, the size label alone decides.

import type { WorkItem } from "../model/types.ts";

/**
 * The size an item states itself, as a `size:small` or `size:medium` label. Large is never
 * stated: a large item is split first, and triage is what says so.
 */
export function statedSize(item: WorkItem): "small" | "medium" | null {
  for (const label of item.labels) {
    const name = label.trim().toLowerCase();
    if (name === "size:small") return "small";
    if (name === "size:medium") return "medium";
  }
  return null;
}

/**
 * Whether the item goes straight to implement without triage: it says its own size, and nothing about it waits on an
 * answer. Any other item gets the full triage.
 */
export function clearWithoutTriage(item: WorkItem): { size: "small" | "medium" } | null {
  const size = statedSize(item);
  if (!size || item.needsDecision || (item.openQuestions?.length ?? 0) > 0) return null;
  return { size };
}
