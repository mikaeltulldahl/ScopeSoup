// The Copilot budget. Pure: no clock, no I/O. Copilot reports no usage window, so the budget is the plan's monthly allowance of
// premium requests (set by the person) and what Scope Soup's Copilot sessions used since the month's reset day (UTC, as GitHub counts).

import type { SessionRole } from "../model/types.ts";
import { USAGE_ROLES, usageRole } from "./usage.ts";

export interface CopilotPeriod {
  /** The month's start (the last reset) and the next reset, in ms. */
  start: number;
  end: number;
}

/** The reset day is kept from 1 to 28, so every month has it. */
export function clampResetDay(day: number): number {
  return Math.min(28, Math.max(1, Math.floor(day)));
}

/** The month `now` is in: from the last reset day at 00:00 UTC to the next. */
export function copilotPeriod(now: number, resetDay: number): CopilotPeriod {
  const day = clampResetDay(resetDay);
  const at = new Date(now);
  const thisMonth = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), day);
  const start = now >= thisMonth ? thisMonth : Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, day);
  const after = new Date(start);
  return { start, end: Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + 1, day) };
}

export interface CopilotSessionUse {
  role: string;
  startedAt: string;
  /** What the session's result recorded; absent when its provider said none (or it still runs). */
  premiumRequests?: number;
  aiCredits?: number;
}

export interface CopilotUse {
  /** Premium requests used in the period, and AI credits where reported. */
  requests: number;
  credits: number;
  /** Per role. */
  byRole: Record<SessionRole, { requests: number; sessions: number }>;
  sessions: number;
}

/** What the sessions that started in the period used, by role (as the Claude windows count roles). */
export function copilotUse(sessions: readonly CopilotSessionUse[], period: CopilotPeriod): CopilotUse {
  const use: CopilotUse = { requests: 0, credits: 0, byRole: Object.fromEntries(USAGE_ROLES.map((role) => [role, { requests: 0, sessions: 0 }])) as CopilotUse["byRole"], sessions: 0 };
  for (const session of sessions) {
    const started = Date.parse(session.startedAt);
    if (Number.isNaN(started) || started < period.start || started >= period.end) continue;
    const requests = session.premiumRequests ?? 0;
    const row = use.byRole[usageRole(session.role)];
    row.requests += requests;
    row.sessions++;
    use.requests += requests;
    use.credits += session.aiCredits ?? 0;
    use.sessions++;
  }
  return use;
}

export interface CopilotCheckInput {
  /** The plan's monthly premium requests; absent when the person set none. */
  allowance?: number;
  used: number;
  /** Share of the allowance kept for people's own use, 0 to 1. */
  reserve: number;
  period: CopilotPeriod;
}

export interface CopilotCheck {
  allow: boolean;
  reason: string;
  /** The next reset, when the allowance is spent. */
  resumeAt?: string;
}

/** The requests Scope Soup may use in the period: the allowance minus the reserve. */
export function copilotLimit(allowance: number, reserve: number): number {
  return allowance * (1 - Math.min(1, Math.max(0, reserve)));
}

/** Whether a Copilot session may start: not once the month's use has reached the allowance minus the reserve. No allowance set: no stop. */
export function copilotCheck(input: CopilotCheckInput): CopilotCheck {
  if (input.allowance === undefined) return { allow: true, reason: "No Copilot allowance is set (copilot.monthlyRequests), so Copilot sessions are not paced." };
  const limit = copilotLimit(input.allowance, input.reserve);
  const round = (n: number) => Math.round(n * 10) / 10;
  if (input.used >= limit) {
    const resumeAt = new Date(input.period.end).toISOString();
    return { allow: false, resumeAt, reason: `Copilot has used ${round(input.used)} of ${input.allowance} premium requests this month; the limit with the reserve is ${round(limit)}. Waiting until the reset at ${resumeAt}.` };
  }
  return { allow: true, reason: `Within the Copilot budget: ${round(input.used)} of ${input.allowance} premium requests, limit ${round(limit)}.` };
}
