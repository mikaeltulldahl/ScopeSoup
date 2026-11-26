// What the board shows of sharing the meta ref with the remote: kept in memory by main.ts, updated after each round (once a minute).

import type { ShareState } from "../core/snapshot.ts";
import type { SharingReport } from "../hosts/metaBranch/writer.ts";

/** The state after one round. Singleplayer or no remote (`local`) gives none; a failure keeps the last good time. */
export function nextShareState(previous: ShareState | undefined, report: SharingReport, at: string): ShareState | undefined {
  if (report.state === "local") return undefined;
  if (report.problem || report.state === "pending") {
    return { ...(previous?.lastOkAt ? { lastOkAt: previous.lastOkAt } : {}), failed: { at, reason: report.problem ?? "the remote did not take everything", waiting: report.waiting } };
  }
  return { lastOkAt: at };
}
