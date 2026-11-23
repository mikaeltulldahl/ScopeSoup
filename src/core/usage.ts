// Who used the usage windows. Pure: readings, sessions and the span come in as arguments.
//
// Between two readings of one window the window rose by some share. That share is spread evenly over
// the time between the readings and handed to whoever ran in each moment:
//  - nobody ran: "outside" Scope Soup (a person's own use, or another tool);
//  - one session ran: it gets the moment ("session");
//  - several ran: split by run time ("runtime"), or, when every one of them has a token count from its
//    stream, by tokens per second of run time ("tokens"), so a chatty session counts for more.
// A drop between readings is a reset: the new window's reading is what was used since the reset.

import { refKey } from "../model/types.ts";
import type { Session, SessionRole, UsageSample, UsageWindowKind } from "../model/types.ts";
import { overlapMs } from "./forecast.ts";

export type UsageKey = SessionRole | "outside";
export type UsageMethod = "session" | "runtime" | "tokens" | "outside";

export const USAGE_ROLES: readonly SessionRole[] = ["triage", "implement", "review"];

/**
 * The role a session's use is counted under. Sessions of a role since removed count where that work went: the fix role's
 * as implement, since the implementor now fixes its own change; the checklist's "check-review" as review.
 */
function usageRole(role: string): SessionRole {
  if (role === "fix") return "implement";
  return (USAGE_ROLES as readonly string[]).includes(role) ? (role as SessionRole) : "review";
}

export type UsageSession = Pick<Session, "ref" | "role" | "startedAt" | "finishedAt"> & {
  /** Tokens the session's stream reported in all; absent when the stream said none. */
  tokens?: number;
};

export interface UsageBucket {
  /** ISO start of the bucket. */
  from: string;
  /** Share of the window (0 to 1) per role in this bucket; "outside" included. */
  parts: Partial<Record<UsageKey, number>>;
}

export interface UsageAttribution {
  kind: UsageWindowKind;
  /** Total share of the window used in the span (above 1 when it reset in the span). */
  total: number;
  /** Share per role, and "outside". */
  shares: Record<UsageKey, number>;
  /** Share by how it was split. */
  methods: Record<UsageMethod, number>;
  /** Sessions that took a part, per role. */
  sessions: Record<SessionRole, number>;
  /** How many resets fell in the readings. */
  resets: number;
  /** Readings that were used. */
  readings: number;
  buckets: UsageBucket[];
}

export interface AttributeOptions {
  from: number;
  to: number;
  /** How many bars to cut the span into. */
  buckets: number;
}

function zeros<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

interface Step {
  from: number;
  to: number;
  delta: number;
}

/** The rises of one window between its readings, oldest first. After a reset, what is read counts. */
function stepsOf(samples: readonly UsageSample[], kind: UsageWindowKind): { steps: Step[]; resets: number; readings: number } {
  const readings = samples
    .flatMap((sample) => {
      const window = sample.windows.find((each) => each.kind === kind);
      const at = Date.parse(sample.at);
      if (!window || window.utilization === undefined || Number.isNaN(at)) return [];
      return [{ at, utilization: window.utilization, resetsAt: Date.parse(window.resetsAt) }];
    })
    .sort((a, b) => a.at - b.at);
  const steps: Step[] = [];
  let resets = 0;
  for (let i = 1; i < readings.length; i++) {
    const before = readings[i - 1]!;
    const now = readings[i]!;
    if (now.utilization >= before.utilization) {
      if (now.utilization > before.utilization) steps.push({ from: before.at, to: now.at, delta: now.utilization - before.utilization });
    } else {
      // The window emptied at its reset time; what is read now was used after that.
      resets++;
      const resetAt = Number.isNaN(before.resetsAt) ? before.at : Math.min(Math.max(before.resetsAt, before.at), now.at);
      if (now.utilization > 0) steps.push({ from: resetAt, to: now.at, delta: now.utilization });
    }
  }
  return { steps, resets, readings: readings.length };
}

export function attributeUsage(samples: readonly UsageSample[], sessions: readonly UsageSession[], kind: UsageWindowKind, options: AttributeOptions): UsageAttribution {
  const result: UsageAttribution = {
    kind,
    total: 0,
    shares: zeros<UsageKey>([...USAGE_ROLES, "outside"]),
    methods: zeros<UsageMethod>(["session", "runtime", "tokens", "outside"]),
    sessions: zeros(USAGE_ROLES),
    resets: 0,
    readings: 0,
    buckets: [],
  };
  const count = Math.max(1, options.buckets);
  const width = Math.max(1, options.to - options.from) / count;
  for (let i = 0; i < count; i++) result.buckets.push({ from: new Date(options.from + i * width).toISOString(), parts: {} });
  const bucketAt = (ms: number) => result.buckets[Math.min(count - 1, Math.max(0, Math.floor((ms - options.from) / width)))]!;
  const took = new Set<string>();

  const found = stepsOf(samples, kind);
  result.resets = found.resets;
  result.readings = found.readings;
  for (const step of found.steps) {
    // Only the part of the step inside the span counts; the rise is taken as even over the step.
    const lo = Math.max(step.from, options.from);
    const hi = Math.min(step.to, options.to);
    if (hi <= lo) continue;
    const perMs = step.delta / Math.max(1, step.to - step.from);
    const active = sessions.filter((session) => overlapMs(session, lo, hi) > 0);
    const cuts = new Set<number>([lo, hi]);
    for (const session of active) {
      for (const text of [session.startedAt, session.finishedAt]) {
        const ms = text === undefined ? Number.NaN : Date.parse(text);
        if (ms > lo && ms < hi) cuts.add(ms);
      }
    }
    const edges = [...cuts].sort((a, b) => a - b);
    for (let i = 1; i < edges.length; i++) {
      const a = edges[i - 1]!;
      const b = edges[i]!;
      const share = (b - a) * perMs;
      const running = active.filter((session) => overlapMs(session, a, b) > 0);
      const give = (key: UsageKey, amount: number, method: UsageMethod) => {
        result.shares[key] += amount;
        result.methods[method] += amount;
        const parts = bucketAt((a + b) / 2).parts;
        parts[key] = (parts[key] ?? 0) + amount;
        result.total += amount;
      };
      if (running.length === 0) {
        give("outside", share, "outside");
        continue;
      }
      const useTokens = running.length > 1 && running.every((session) => (session.tokens ?? 0) > 0);
      // Tokens per ms of the session's whole run, so a session is not favoured for running long.
      const weights = running.map((session) => {
        if (!useTokens) return 1;
        const end = session.finishedAt === undefined ? options.to : Date.parse(session.finishedAt);
        return session.tokens! / Math.max(1, end - Date.parse(session.startedAt));
      });
      const sum = weights.reduce((x, y) => x + y, 0);
      const method: UsageMethod = running.length === 1 ? "session" : useTokens ? "tokens" : "runtime";
      running.forEach((session, index) => {
        took.add(refKey(session.ref));
        give(usageRole(session.role), (share * weights[index]!) / sum, method);
      });
    }
  }
  for (const session of sessions) if (took.has(refKey(session.ref))) result.sessions[usageRole(session.role)]++;
  return result;
}
