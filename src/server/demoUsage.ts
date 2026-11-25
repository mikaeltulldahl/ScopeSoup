// The demo's usage history: 28 days of synthetic readings of both windows and the finished sessions that filled them, so the
// Usage page shows every part (several 5-hour resets, weekly resets, all four roles). Made up from a fixed seed; no real data.

import { at as plus, ref, session } from "../core/testing.ts";
import type { Session, SessionRole, UsageSample } from "../model/types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Share of the 5-hour window one minute of each kind of work uses. */
const RATE: Record<SessionRole | "outside", number> = { implement: 0.0021, review: 0.0017, triage: 0.0024, outside: 0.004 };
/** A share of the 5-hour window is this much of the week. */
const WEEK_PER_FIVE_HOUR = 0.075;
const MODEL: Record<SessionRole, string> = { implement: "sonnet", review: "opus", triage: "opus" };

/** A small seeded generator, so the demo looks the same each time. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Run {
  role: SessionRole | "outside";
  from: number;
  to: number;
  /** How hard it used the window, around 1. */
  weight: number;
}

/** A synthetic Copilot session and what its result records. */
export interface DemoCopilotSession {
  session: Session;
  premiumRequests: number;
  aiCredits: number;
}

/** The demo's Copilot sessions: the triage role runs on Copilot, a few sessions a working day for 28 days. Made up from a fixed seed. */
function demoCopilot(now: Date): DemoCopilotSession[] {
  const end = now.getTime();
  const rand = random(94);
  const out: DemoCopilotSession[] = [];
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
        premiumRequests,
        aiCredits: Math.round(premiumRequests * 0.05 * 100) / 100,
      });
    }
  }
  return out;
}

/** The demo's usage over the 28 days before `now`: readings every ten minutes and the sessions that ran, and the Copilot sessions. */
export function demoUsage(now: Date): { samples: UsageSample[]; sessions: Session[]; copilot: DemoCopilotSession[] } {
  const end = now.getTime();
  const rand = random(85);
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const runs: Run[] = [];
  // The sessions seeded elsewhere run now: no made-up session in the last quarter hour, but their use goes on.
  const quiet = end - 15 * MINUTE;
  runs.push({ role: "implement", from: quiet, to: end, weight: 1 }, { role: "review", from: end - 3 * MINUTE, to: end, weight: 1 });
  const lane = (from: number, to: number, pick: (index: number) => { role: SessionRole; minutes: [number, number] } | null) => {
    let t = from + between(0, 10) * MINUTE;
    for (let index = 0; t < to; index++) {
      const next = pick(index);
      if (next) {
        const stop = Math.min(to, t + between(...next.minutes) * MINUTE);
        if (stop - t > 2 * MINUTE) runs.push({ role: next.role, from: t, to: stop, weight: between(0.7, 1.3) });
        t = stop;
      }
      t += between(2, 10) * MINUTE;
    }
  };
  for (let day = 0; day < 31; day++) {
    const dayEnd = end - day * DAY;
    // Two quiet days a week: only a person's own use.
    const quietDay = day % 7 === 2 || day % 7 === 3;
    const own = dayEnd - 7 * HOUR + between(0, 40) * MINUTE;
    runs.push({ role: "outside", from: own, to: own + between(15, 40) * MINUTE, weight: between(0.7, 1.3) });
    if (quietDay) continue;
    const blocks: [number, number][] = [
      [dayEnd - 13 * HOUR + between(-30, 30) * MINUTE, dayEnd - 8.5 * HOUR],
      [dayEnd - 4.3 * HOUR + (day === 0 ? 0 : between(-30, 10) * MINUTE), day === 0 ? quiet : dayEnd - between(0, 40) * MINUTE],
    ];
    for (const [from, to] of blocks) {
      lane(from, to, () => ({ role: "implement", minutes: [35, 65] }));
      lane(from, to, (index) => (rand() < 0.2 ? null : index % 2 === 0 ? { role: "triage", minutes: [4, 8] } : { role: "review", minutes: [10, 22] }));
    }
  }
  // The first reading is 28 days ago, so the 30-day plot shows its "no readings" part.
  const start = end - 28 * DAY;
  const live = runs.filter((each) => each.to > start).sort((a, b) => a.from - b.from);

  // The windows, a minute at a time. A 5-hour window opens on the first use after the last one ended, from the whole hour.
  const weeklyReset = Math.floor((end - 2.4 * DAY) / HOUR) * HOUR;
  const nextWeekly = (t: number) => weeklyReset + Math.ceil((t - weeklyReset + 1) / (7 * DAY)) * 7 * DAY;
  let fiveEnd = 0;
  let five = 0;
  let week = 0.08;
  let weekEnd = nextWeekly(start);
  const samples: UsageSample[] = [];
  const readEvery = 10;
  let next = end - 30_000 - Math.floor((end - 30_000 - start) / (readEvery * MINUTE)) * readEvery * MINUTE;
  for (let t = start; t <= end; t += MINUTE) {
    if (t >= weekEnd) {
      week = 0;
      weekEnd = nextWeekly(t);
    }
    if (t >= fiveEnd) five = 0;
    const use = live.filter((each) => each.from <= t && each.to > t).reduce((sum, each) => sum + RATE[each.role] * each.weight, 0);
    if (use > 0) {
      if (t >= fiveEnd) fiveEnd = Math.floor(t / HOUR) * HOUR + 5 * HOUR;
      const added = Math.min(use, 0.97 - five);
      five += Math.max(0, added);
      week = Math.min(1, week + Math.max(0, added) * WEEK_PER_FIVE_HOUR);
    }
    while (next <= t + MINUTE && next <= end) {
      const iso = new Date(next).toISOString();
      samples.push({
        at: iso,
        status: "allowed",
        windows: [
          { kind: "five_hour", utilization: Math.round(five * 1000) / 1000, resetsAt: new Date(fiveEnd || next).toISOString() },
          { kind: "seven_day", utilization: Math.round(week * 1000) / 1000, resetsAt: new Date(weekEnd).toISOString() },
        ],
      });
      next += readEvery * MINUTE;
    }
  }

  const base = now.toISOString();
  const sessions = live
    .filter((each): each is Run & { role: SessionRole } => each.role !== "outside" && each.to <= quiet)
    .map((each, index) =>
      session(`u-${index + 1}`, ref("work", 1 + (index % 30)), {
        role: each.role,
        model: MODEL[each.role],
        status: "succeeded",
        endReason: "succeeded",
        startedAt: plus((each.from - end) / MINUTE, base),
        finishedAt: plus((each.to - end) / MINUTE, base),
      }),
    );
  return { samples, sessions, copilot: demoCopilot(now) };
}
