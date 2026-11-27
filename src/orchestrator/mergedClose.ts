// After a merge (through the queue, or a merge by the session) the item itself is closed on the host that keeps
// it as an issue: a commit pushed to the main branch does not close it, and an open issue
// could be picked up again. When writes are off, the board says it is to be closed by hand. Scope Soup's own claim is
// released first: a merged Item is nobody's work any more (a person's claim is theirs, and `release` leaves it).

import { refKey } from "../model/types.ts";
import type { Context } from "./context.ts";
import type { Job } from "./jobs.ts";

/** Releases Scope Soup's claim, then closes the merged item on its host, once, with a comment naming the commit and the batch. */
export async function closeMerged(ctx: Context, job: Job, sha: string, batch?: number): Promise<void> {
  const { actions } = ctx.deps;
  const key = refKey(job.item);
  if (actions.claims) await ctx.act("release the claim", key, () => actions.release(job.item, `merged on ${ctx.config.mainBranch} as ${sha.slice(0, 7)}`));
  if (!actions.closeMerged) return;
  let result: Awaited<ReturnType<NonNullable<typeof actions.closeMerged>>> | undefined;
  let failed = false;
  // Owed until the host took it, so a failure (written with the job by `act`) leaves it for the tick to try again.
  const owed = job.closeOwed !== undefined;
  job.closeOwed = { sha, ...(batch !== undefined ? { batch } : {}) };
  await ctx.act("close the merged item on its host", key, async () => {
    try {
      result = await actions.closeMerged!(job.item, { sha, target: ctx.config.mainBranch, ...(batch !== undefined ? { batch } : {}) });
    } catch (error) {
      failed = true;
      throw error;
    }
  });
  // The failure itself is logged by `act`; this is the standing note on the board. The tick tries the close again (`closeOwed`).
  if (failed) {
    ctx.say("orchestrator.close_failed", `${job.item.id} merged on ${ctx.config.mainBranch} as ${sha.slice(0, 7)}, but closing it on the host failed: Scope Soup tries again at each tick, or close it on the host by hand.`, key, { sha });
    return;
  }
  delete job.closeOwed;
  if (owed && result !== "closed") ctx.commit("orchestrator.close_retried", `${job.item.id}: the close of its merged change was tried again and the host took it.`, key, { sha });
  if (result === "closed") ctx.commit("orchestrator.item_closed", `${job.item.id} was closed on its host: it merged on ${ctx.config.mainBranch} as ${sha.slice(0, 7)}.`, key, { sha });
  // Not closed: the job stays, parked as merged, so the item is not started again.
  else if (result === "by-hand") ctx.say("orchestrator.close_by_hand", `${job.item.id} merged on ${ctx.config.mainBranch} as ${sha.slice(0, 7)}, but writes to the host are off: close it on the host by hand.`, key, { sha });
}
