// What the board shows of sharing the meta ref with the remote: written after each round (main.ts, once a minute).

import type { ShareState } from "../core/snapshot.ts";
import type { SharingReport } from "../hosts/metaBranch/writer.ts";
import { KEYS } from "../store/keys.ts";
import type { Store } from "../store/store.ts";

/**
 * Records one round. Singleplayer or no remote (`local`) clears it. The value is written every round (it holds the time of the last
 * good one); an event only when the picture changes: it starts to fail, fails differently, the writes waiting change, or it recovers.
 */
export function recordShare(store: Store, report: SharingReport, at: string): void {
  store.tx(() => {
    const before = store.getValue(KEYS.share) ?? "";
    let previous: ShareState = {};
    try {
      previous = before ? (JSON.parse(before) as ShareState) : {};
    } catch {
      previous = {};
    }
    if (report.state === "local") {
      if (before !== "") {
        store.setValue(KEYS.share, "");
        store.appendEvent({ kind: "share.cleared", actor: "scopesoup" }, at);
      }
      return;
    }
    const failed = report.problem || report.state === "pending" ? { at, reason: report.problem ?? "the remote did not take everything", waiting: report.waiting } : undefined;
    const lastOkAt = failed ? previous.lastOkAt : at;
    const next: ShareState = { ...(lastOkAt ? { lastOkAt } : {}), ...(failed ? { failed } : {}) };
    store.setValue(KEYS.share, JSON.stringify(next));
    const was = previous.failed;
    if (failed && (!was || was.reason !== failed.reason || was.waiting !== failed.waiting)) {
      store.appendEvent({ kind: "share.failed", actor: "scopesoup", data: { reason: failed.reason, waiting: failed.waiting } }, at);
    } else if (!failed && was) {
      store.appendEvent({ kind: "share.recovered", actor: "scopesoup", data: { after: was.at } }, at);
    }
  });
}
