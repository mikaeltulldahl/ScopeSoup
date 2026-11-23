// `GET /api/usage`: reads the readings and sessions from the store and the token counts from the
// session streams (read by each session's agent provider), then attributes with core.

import { readFileSync } from "node:fs";
import { attributeUsage } from "../core/usage.ts";
import type { UsageSession } from "../core/usage.ts";
import type { UsageView } from "../core/views.ts";
import type { Session } from "../model/types.ts";
import type { Store } from "../store/store.ts";
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
  return providerNamed(provider).tokensIn(text);
}

export function buildUsageView(store: Store, sessions: readonly Session[], span: { span: string; ms: number }, now: Date): UsageView {
  const to = now.getTime();
  const from = to - span.ms;
  const mine = sessions.filter((session) => {
    const end = session.finishedAt === undefined ? to : Date.parse(session.finishedAt);
    return Date.parse(session.startedAt) < to && end > from;
  });
  const usage: UsageSession[] = mine.map((session) => {
    const tokens = session.finishedAt === undefined ? undefined : streamTokens(session.streamPath, session.provider);
    return { ref: session.ref, role: session.role, startedAt: session.startedAt, ...(session.finishedAt ? { finishedAt: session.finishedAt } : {}), ...(tokens ? { tokens } : {}) };
  });
  // Readings from before the span too, so the first step of the span has its start.
  const samples = store.usageSamplesSince(new Date(from - 8 * 24 * HOUR).toISOString()).filter((sample) => Date.parse(sample.at) <= to);
  const days = span.ms / (24 * HOUR);
  const buckets = span.ms <= 5 * HOUR ? 20 : days <= 7 ? Math.round(days) * 4 : Math.round(days);
  const windows = (["five_hour", "seven_day"] as const).map((kind) => attributeUsage(samples, usage, kind, { from, to, buckets }));
  return { now: now.toISOString(), span: span.span, from: new Date(from).toISOString(), to: now.toISOString(), windows, sessions: usage.length, withTokens: usage.filter((session) => session.tokens !== undefined).length };
}
