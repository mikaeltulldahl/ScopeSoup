// The queue's batches as the model's Batch, for the store and the board.

import type { Batch, BatchStatus, BisectProbe, Ref } from "../model/types.ts";
import type { QueueBatch, QueueState } from "./types.ts";

function statusOf(b: QueueBatch): BatchStatus {
  if (b.status === "building") return "forming";
  if (b.status === "testing") return b.bad === null ? "testing" : "bisecting";
  return b.members.length > 0 && b.good >= b.members.length ? "merged" : "failed";
}

/** One probe per tested prefix, in the order they were first tested; a rerun speaks for its prefix. */
function probesOf(b: QueueBatch): BisectProbe[] {
  const byPrefix = new Map<number, BisectProbe>();
  for (const p of b.probes) {
    const probe: BisectProbe = { prefix: p.prefix, status: p.status };
    const run = p.run ?? byPrefix.get(p.prefix)?.run;
    if (run) probe.run = run;
    byPrefix.set(p.prefix, probe);
  }
  return [...byPrefix.values()];
}

export function toBatch(state: QueueState, host = "scopesoup"): Batch[] {
  return state.batches.map((b) => {
    const at = b.culprit ?? b.suspect;
    const suspect = at === null ? undefined : b.members[at - 1]?.change;
    const batch: Batch = {
      ref: { host, kind: "batch", id: String(b.id) },
      status: statusOf(b),
      base: b.base,
      members: b.members.map((m) => ({ change: m.change, sha: m.sha || m.head, state: m.state })),
      runs: b.probes.flatMap((p): Ref[] => (p.run ? [p.run] : [])),
      probes: probesOf(b),
      startedAt: b.startedAt,
    };
    if (suspect) batch.suspect = suspect;
    if (b.note) batch.note = b.note;
    if (b.finishedAt) batch.finishedAt = b.finishedAt;
    return batch;
  });
}
