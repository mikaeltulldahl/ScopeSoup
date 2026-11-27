// The usage check. Pure: no clock, no I/O. Admission control over the newest usage sample.

import type { UsageSample, UsageWindow, UsageWindowKind } from "../model/types.ts";
import { plural } from "../model/plural.ts";

export const WINDOW_MS: Record<UsageWindowKind, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 24 * 3600_000,
};

export interface UsageCheckInput {
  /** The newest sample from any session's stream; null when none was ever seen. */
  sample: UsageSample | null;
  now: string;
  /** Each window's budget, a share of its even pace (0 to 2): no session starts once a window is at it, or full. */
  budget: Record<UsageWindowKind, number>;
  /** Sessions running now. An unknown budget allows one probe, and only when nothing runs. */
  runningSessions: number;
}

export interface UsageCheckDecision {
  allow: boolean;
  reason: string;
  /** When to ask again. Absent on a stop that needs a person, and when allowed. */
  resumeAt?: string;
  /** Running sessions should be stopped too, not only dispatch. */
  stopRunning?: boolean;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const NAMES: Record<UsageWindowKind, string> = { five_hour: "5-hour window", seven_day: "weekly window" };

export function decide(input: UsageCheckInput): UsageCheckDecision {
  const { sample, runningSessions } = input;
  const now = Date.parse(input.now);

  const probe = (why: string): UsageCheckDecision =>
    runningSessions === 0
      ? { allow: true, reason: `${why}; starting one session to get a reading` }
      : { allow: false, reason: `${why}; waiting for a reading from the ${plural(runningSessions, "running session")}` };

  if (!sample) return probe("No usage reading yet");

  if (sample.usingOverage) {
    return { allow: false, stopRunning: true, reason: "Paid extra usage is being drawn. Stopped until a person looks at it." };
  }

  // A window whose reset has passed says nothing about the new window.
  const live = sample.windows.filter((window) => Date.parse(window.resetsAt) > now);

  if (sample.status === "rejected") {
    const resumeAt = resetAfterRejection(sample, input.now);
    if (resumeAt) return { allow: false, resumeAt, reason: `The usage limit is hit. Waiting until the reset at ${resumeAt}.` };
    return probe("The limit that was hit has reset");
  }

  if (live.length === 0) return probe(sample.windows.length === 0 ? "The last reading named no window" : "Every window in the last reading has reset");

  for (const kind of ["five_hour", "seven_day"] as const) {
    const window = live.find((candidate) => candidate.kind === kind);
    if (!window || window.utilization === undefined) continue;
    const limit = Math.min(1, Math.max(0, input.budget[kind]));
    if (window.utilization >= limit) {
      return {
        allow: false,
        resumeAt: window.resetsAt,
        reason: `The ${NAMES[kind]} is at ${pct(window.utilization)}; ${limit < 1 ? `its budget stops new sessions at ${pct(limit)}` : "it is full"}. Waiting until the reset at ${window.resetsAt}.`,
      };
    }
  }

  const unknown = live.filter((window) => window.utilization === undefined);
  if (unknown.length > 0) {
    if (sample.status === "allowed_warning") {
      const resumeAt = iso(Math.min(...unknown.map((window) => Date.parse(window.resetsAt))));
      return { allow: false, resumeAt, reason: `The agent warned that a limit is near and gave no figure. Waiting until the reset at ${resumeAt}.` };
    }
    return probe(`The last reading gave no figure for the ${unknown.map((window) => NAMES[window.kind]).join(" and ")}`);
  }

  const parts = live.map((window: UsageWindow) => `${NAMES[window.kind]} at ${pct(window.utilization ?? 0)}`);
  return { allow: true, reason: `Within budget: ${parts.join(", ")}.` };
}

/**
 * When a rejected sample lets work start again: the latest reset among the windows known to be
 * full, else the earliest reset still ahead (a later probe finds out the rest). Undefined when
 * every reset has passed.
 */
export function resetAfterRejection(sample: UsageSample, now: string): string | undefined {
  const at = Date.parse(now);
  const live = sample.windows.map((window) => ({ window, resets: Date.parse(window.resetsAt) })).filter((entry) => entry.resets > at);
  if (live.length === 0) return undefined;
  const full = live.filter((entry) => entry.window.utilization !== undefined && entry.window.utilization >= 1);
  const resets = (full.length > 0 ? full : live).map((entry) => entry.resets);
  return iso(full.length > 0 ? Math.max(...resets) : Math.min(...resets));
}
