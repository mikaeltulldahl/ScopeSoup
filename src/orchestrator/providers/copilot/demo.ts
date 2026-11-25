// The demo's synthetic Copilot use: the triage role runs on Copilot, with a plan allowance and a few sessions a working day for
// 28 days. Made up from a fixed seed; no real data.

import { at as plus, ref, session } from "../../../core/testing.ts";
import type { Session } from "../../../model/types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A small seeded generator, so the demo looks the same each time. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export interface DemoAllowanceSession {
  session: Session;
  /** As the session's result record keeps it. */
  result: { premiumRequests: number; aiCredits: number };
}

export const copilotDemo = {
  /** The shared settings' `roles`: triage runs on Copilot, the others stay on Claude. */
  roles: { triage: { provider: "copilot" } },
  /** This machine's file: a plan of 150 premium requests a month, reset on a day about twelve days ago. */
  machine: (now: Date) => ({ copilot: { monthlyRequests: 150, resetDay: Math.min(28, new Date(now.getTime() - 12 * DAY).getUTCDate()) } }),
  /** The Copilot triage sessions of the 28 days before `now`, with the results they recorded. */
  sessions(now: Date): DemoAllowanceSession[] {
    const end = now.getTime();
    const rand = random(94);
    const out: DemoAllowanceSession[] = [];
    for (let day = 0; day < 28; day++) {
      for (let k = 0; k < 5; k++) {
        const from = end - day * DAY - (2 + k * 1.7 + rand()) * HOUR - 30 * MINUTE;
        const minutes = 3 + rand() * 4;
        const premiumRequests = rand() < 0.8 ? 1 : 2;
        out.push({
          session: session(`cp-${out.length + 1}`, ref("work", 1 + (out.length % 30)), {
            role: "triage", model: "fusion", provider: "copilot", status: "succeeded", endReason: "succeeded",
            startedAt: plus((from - end) / MINUTE, now.toISOString()), finishedAt: plus((from + minutes * MINUTE - end) / MINUTE, now.toISOString()),
          }),
          result: { premiumRequests, aiCredits: Math.round(premiumRequests * 0.05 * 100) / 100 },
        });
      }
    }
    return out;
  },
};
