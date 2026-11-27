// The overview's one line at level 0 (replacing an earlier offer): "N Items have no triage: set level 1 and press
// Resume on To do." Level 1 with triage started runs a triage on every Item in To do without one; nothing else runs them (a person
// may ask for one on a Backlog Item). From level 1 To do has a divider (replacing "Triage done for N of M Items"): the Items not
// triaged yet are below it.

import type { Change, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { foreignChanges, hasTriage, readyItems } from "../orchestrator/candidates.ts";
import type { Jobs } from "../orchestrator/jobs.ts";

/** How many Items are ready to start (as the tick picks them) and have no triage. Pure. */
export function countWithoutTriage(items: WorkItem[], changes: Change[], jobs: Jobs, now: string): number {
  return readyItems(items, foreignChanges(changes), jobs, now).ready.filter((item) => !hasTriage(item, jobs[refKey(item.ref)])).length;
}

/**
 * From level 1, To do's divider: the keys of the open Items not triaged yet (no triage), umbrellas left out
 * (they never have one). Pure.
 */
export function withoutTriageKeys(items: WorkItem[], jobs: Jobs): Set<string> {
  return new Set(
    items
      .filter((item) => item.state !== "done" && item.state !== "abandoned" && item.openChildren === 0 && (item.children ?? 0) === 0 && !hasTriage(item, jobs[refKey(item.ref)]))
      .map((item) => refKey(item.ref)),
  );
}
