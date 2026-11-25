// `GET /api/usage`: reads the readings and sessions from the store and the token counts from the
// session streams (read by each session's agent provider), then attributes with core.

import { readFileSync } from "node:fs";
import { forecastWindow } from "../core/forecast.ts";
import { buildIndex } from "../core/snapshot.ts";
import type { Snapshot } from "../core/snapshot.ts";
import { forecastLoad } from "../core/status.ts";
import { copilotPeriod, copilotUse } from "../core/copilotBudget.ts";
import { attributeUsage, forecastLine, usagePlot } from "../core/usage.ts";
import type { UsageSession } from "../core/usage.ts";
import type { CopilotUsageView, UsageView, UsagePageWindow } from "../core/views.ts";
import type { Session, UsageWindowKind } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import { copilotSessionUse } from "../orchestrator/tick.ts";
import { providerNamed } from "../orchestrator/providers/index.ts";

const HOUR = 3600_000;
const MAX_DAYS = 30;

/** "5h", "7d", "<N>d" (1 to 30): the span in ms, or null when it is not one. Absent means 7d. */
export function parseSpan(text: string | null): { span: string; ms: number } | null {
  const match = /^(?:(5)h|(\d{1,2})d)$/.exec(text ?? "7d");
  if (!match) return null;
  if (match[1]) return { span: "5h", ms: 5 * HOUR };
  const days = Number(match[2]);
  return days >= 1 && days <= MAX_DAYS ? { span: `${days}d`, ms: days * 24 * HOUR } : null;
}

/** The tokens a finished stream says it used, read by the provider that wrote it; undefined when it says none. */
export function streamTokens(path: string | undefined, provider?: string): number | undefined {
  if (!path) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  // A provider may keep its counts in a file of its own beside the stream (a usage file).
  const beside = (suffix: string): string | undefined => {
    try {
      return readFileSync(`${path}${suffix}`, "utf8");
    } catch {
      return undefined;
    }
  };
  return providerNamed(provider).tokensIn(text, beside);
}

/** How many even steps a span's plot is sampled in: about one per pixel column's worth, at most a few hundred. */
function plotSteps(ms: number): number {
  if (ms <= 5 * HOUR) return 150;
  if (ms <= 24 * HOUR) return 288;
  return Math.min(720, Math.round(ms / HOUR));
}

/** What the Usage page needs of the configuration for Copilot: present only when some role runs on it. */
export interface CopilotPlan {
  allowance?: number;
  resetDay: number;
  /** The share of the allowance kept for people. */
  reserve: number;
}

/**
 * The Usage page: per window the newest reading with the status line's forecast (planned with the snapshot's sessions, pause
 * and planned sessions), the reserve, how full it got over the span by role, and the share each role used.
 */
export function buildUsageView(store: Store, snapshot: Snapshot, span: { span: string; ms: number }, now: Date, reserve?: Record<UsageWindowKind, number>, copilot?: CopilotPlan): UsageView {
  const to = now.getTime();
  const from = to - span.ms;
  // Readings from before the span too, so the first step of the span has its start and the plot knows who filled the
  // window since its last reset; the sessions of that time too.
  const since = from - 8 * 24 * HOUR;
  const ran = (session: Session, start: number) => {
    const end = session.finishedAt === undefined ? to : Date.parse(session.finishedAt);
    return Date.parse(session.startedAt) < to && end > start;
  };
  const usage: UsageSession[] = snapshot.sessions.filter((session) => ran(session, since)).map((session) => {
    const tokens = session.finishedAt === undefined ? undefined : streamTokens(session.streamPath, session.provider);
    return { ref: session.ref, role: session.role, startedAt: session.startedAt, ...(session.finishedAt ? { finishedAt: session.finishedAt } : {}), ...(tokens ? { tokens } : {}) };
  });
  const inSpan = usage.filter((session) => (session.finishedAt === undefined ? to : Date.parse(session.finishedAt)) > from);
  const samples = store.usageSamplesSince(new Date(since).toISOString()).filter((sample) => Date.parse(sample.at) <= to);
  const latest = samples.at(-1);
  const load = forecastLoad(buildIndex(snapshot));
  const windows = (["five_hour", "seven_day"] as const).map((kind): UsagePageWindow => {
    const attribution = attributeUsage(samples, usage, kind, { from, to });
    const plot = usagePlot(samples, usage, kind, { from, to, steps: plotSteps(span.ms) });
    const reading = latest?.windows.find((window) => window.kind === kind);
    const view: UsagePageWindow = { ...attribution, plot, forecastLine: [] };
    if (reserve) view.reserve = reserve[kind];
    if (latest && reading?.utilization !== undefined) {
      const forecast = forecastWindow(samples, kind, now, load) ?? undefined;
      view.current = { utilization: reading.utilization, resetsAt: reading.resetsAt, at: latest.at, ...(forecast ? { forecast } : {}) };
      view.forecastLine = forecastLine(to, reading.utilization, Date.parse(reading.resetsAt), forecast);
    }
    return view;
  });
  let copilotView: CopilotUsageView | undefined;
  if (copilot) {
    const period = copilotPeriod(to, copilot.resetDay);
    const use = copilotUse(copilotSessionUse(store), period);
    copilotView = { from: new Date(period.start).toISOString(), resetsAt: new Date(period.end).toISOString(), ...(copilot.allowance !== undefined ? { allowance: copilot.allowance } : {}), reserve: copilot.reserve, requests: use.requests, credits: use.credits, byRole: use.byRole, sessions: use.sessions };
  }
  return { now: now.toISOString(), span: span.span, from: new Date(from).toISOString(), to: now.toISOString(), windows, sessions: inSpan.length, withTokens: inSpan.filter((session) => session.tokens !== undefined).length, ...(copilotView ? { copilot: copilotView } : {}) };
}
