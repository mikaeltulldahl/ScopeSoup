// The monthly allowance budget of a provider that reports no usage window. Pure: no clock, no I/O. The budget is the plan's
// monthly allowance (set by the person, in the provider's own unit) and what that provider's sessions used since the month's
// reset day (UTC). Which provider, its unit and its words come in as arguments.

import type { SessionRole } from "../model/types.ts";
import { USAGE_ROLES, usageRole } from "./usage.ts";

export interface AllowancePeriod {
  /** The month's start (the last reset) and the next reset, in ms. */
  start: number;
  end: number;
}

/** The reset day is kept from 1 to 28, so every month has it. */
export function clampResetDay(day: number): number {
  return Math.min(28, Math.max(1, Math.floor(day)));
}

/** The month `now` is in: from the last reset day at 00:00 UTC to the next. */
export function allowancePeriod(now: number, resetDay: number): AllowancePeriod {
  const day = clampResetDay(resetDay);
  const at = new Date(now);
  const thisMonth = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), day);
  const start = now >= thisMonth ? thisMonth : Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, day);
  const after = new Date(start);
  return { start, end: Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + 1, day) };
}

export interface AllowanceSessionUse {
  role: string;
  startedAt: string;
  /** What the session's result recorded, in the provider's unit; absent when its provider said none (or it still runs). */
  used?: number;
}

export interface AllowanceUse {
  /** Used in the period, in all and per role. */
  used: number;
  byRole: Record<SessionRole, { used: number; sessions: number }>;
  sessions: number;
}

/** What the sessions that started in the period used, by role (as the Claude windows count roles). */
export function allowanceUse(sessions: readonly AllowanceSessionUse[], period: AllowancePeriod): AllowanceUse {
  const use: AllowanceUse = { used: 0, byRole: Object.fromEntries(USAGE_ROLES.map((role) => [role, { used: 0, sessions: 0 }])) as AllowanceUse["byRole"], sessions: 0 };
  for (const session of sessions) {
    const started = Date.parse(session.startedAt);
    if (Number.isNaN(started) || started < period.start || started >= period.end) continue;
    const row = use.byRole[usageRole(session.role)];
    row.used += session.used ?? 0;
    row.sessions++;
    use.used += session.used ?? 0;
    use.sessions++;
  }
  return use;
}

/** The provider's words for its allowance. */
export interface AllowanceWords {
  /** The provider as a person calls it. */
  label: string;
  /** What is counted ("premium requests"). */
  unit: string;
  /** The configuration setting that holds the allowance, named when none is set. */
  setting: string;
}

export interface AllowanceCheckInput extends AllowanceWords {
  /** The plan's monthly allowance; absent when the person set none. */
  allowance?: number;
  used: number;
  /** Share of the allowance kept for people's own use, 0 to 1. */
  reserve: number;
  period: AllowancePeriod;
}

export interface AllowanceCheck {
  allow: boolean;
  reason: string;
  /** The next reset, when the allowance is spent. */
  resumeAt?: string;
}

/** What Scope Soup may use in the period: the allowance minus the reserve. */
export function allowanceLimit(allowance: number, reserve: number): number {
  return allowance * (1 - Math.min(1, Math.max(0, reserve)));
}

/** Whether a session may start: not once the month's use has reached the allowance minus the reserve. No allowance set: no stop. */
export function allowanceCheck(input: AllowanceCheckInput): AllowanceCheck {
  if (input.allowance === undefined) return { allow: true, reason: `No ${input.label} allowance is set (${input.setting}), so ${input.label} sessions are not paced.` };
  const limit = allowanceLimit(input.allowance, input.reserve);
  const round = (n: number) => Math.round(n * 10) / 10;
  if (input.used >= limit) {
    const resumeAt = new Date(input.period.end).toISOString();
    return { allow: false, resumeAt, reason: `${input.label} has used ${round(input.used)} of ${input.allowance} ${input.unit} this month; the limit with the reserve is ${round(limit)}. Waiting until the reset at ${resumeAt}.` };
  }
  return { allow: true, reason: `Within the ${input.label} budget: ${round(input.used)} of ${input.allowance} ${input.unit}, limit ${round(limit)}.` };
}
