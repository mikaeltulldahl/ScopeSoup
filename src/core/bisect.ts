// What a bisect has established so far, from the probes of a batch.

import type { Batch, Ref } from "../model/types.ts";

/** Where a member stands: cleared, among those that may have broken the batch, or not looked at. */
export type BisectMark = "good" | "in-doubt" | "culprit" | "untested";

export interface BisectState {
  /** Members before this index are known good (the longest passing prefix). */
  goodPrefix: number;
  /** The shortest failing prefix. The whole batch failed, so at most the batch size. */
  badPrefix: number;
  /** Set once exactly one member is left in doubt. */
  culprit?: Ref;
  /** One mark per member, in chain order. */
  marks: BisectMark[];
}

export function bisectState(batch: Batch): BisectState {
  const size = batch.members.length;
  let goodPrefix = 0;
  let badPrefix = size;
  for (const probe of batch.probes) {
    const prefix = Math.min(size, Math.max(0, probe.prefix));
    if (probe.status === "passed" && prefix > goodPrefix) goodPrefix = prefix;
    if (probe.status === "failed" && prefix < badPrefix) badPrefix = prefix;
  }
  // Contradicting probes (a flake): trust the passing prefix and leave the rest in doubt.
  if (badPrefix <= goodPrefix) badPrefix = size;
  const found = badPrefix - goodPrefix === 1;
  const marks = batch.members.map((_, position): BisectMark => {
    if (position < goodPrefix) return "good";
    if (position < badPrefix) return found ? "culprit" : "in-doubt";
    return "untested";
  });
  const state: BisectState = { goodPrefix, badPrefix, marks };
  if (found) state.culprit = batch.members[goodPrefix]?.change;
  return state;
}
