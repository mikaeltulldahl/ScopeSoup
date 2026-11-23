// How urgent an item is, in the usual tracker words: blocker, critical, major, minor. An item may have none; the backlog score gives that its own points (`WEIGHTS` in src/orchestrator/score.ts).

import type { Priority } from "./types.ts";

/** Most urgent first. */
export const PRIORITIES: readonly Priority[] = ["blocker", "critical", "major", "minor"];

export const isPriority = (value: unknown): value is Priority => typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);

/** 0 for the most urgent. */
export const priorityRank = (priority: Priority): number => PRIORITIES.indexOf(priority);

/** The priority a host label names (`priority:critical`), case-insensitively; the most urgent one if there are several. */
export function priorityFromLabels(labels: string[]): Priority | undefined {
  let found: Priority | undefined;
  for (const label of labels) {
    const match = /^priority:\s*(.+)$/i.exec(label.trim());
    const name = match?.[1]?.trim().toLowerCase();
    if (isPriority(name) && (found === undefined || priorityRank(name) < priorityRank(found))) found = name;
  }
  return found;
}
