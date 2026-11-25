// Defensive parser for `claude -p --output-format stream-json --verbose`.
// The format is NDJSON, but lines are not trusted: a line may be cut, may be something else
// entirely, or may have a second object injected into the middle of it. Every event keeps its
// raw line; lines that needed repair or gave nothing are counted.

import type { UsageSample, UsageWindow, UsageWindowKind } from "../../../model/types.ts";
import type { AgentEvent, AgentResult, EventReader, EventSummary } from "../../agent.ts";
import { DETAIL_MAX, objectsOnLine, oneLine, shortPath } from "../lines.ts";

export { DETAIL_MAX, objectsOnLine, shortPath };

/** A `result` line as the Claude provider reads it: the provider-neutral part and what tells a limit hit apart. */
export interface StreamResult extends AgentResult {
  apiErrorStatus?: number;
  terminalReason?: string;
}

export type StreamEvent = AgentEvent;

export interface StreamSummary extends EventSummary {
  result?: StreamResult;
}

export interface StreamParser extends EventReader {
  summary(): StreamSummary;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoFromEpochSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value * 1000).toISOString();
}

function fraction(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A usage sample from a `rate_limit_event`. Null when the event carries no rate limit info. */
export function usageFromEvent(event: Obj, at: string): UsageSample | null {
  const info = event.rate_limit_info;
  if (!isObj(info)) return null;
  const windows: UsageWindow[] = [];
  const unified = info.unifiedWindows;
  if (isObj(unified)) {
    for (const kind of ["five_hour", "seven_day"] as const) {
      const entry = unified[kind];
      if (!isObj(entry)) continue;
      const resetsAt = isoFromEpochSeconds(entry.resetsAt);
      if (resetsAt) windows.push({ kind, utilization: fraction(entry.utilization), resetsAt });
    }
  }
  if (windows.length === 0) {
    const resetsAt = isoFromEpochSeconds(info.resetsAt);
    if (resetsAt) {
      const type = info.rateLimitType;
      let kind: UsageWindowKind | undefined;
      if (type === "five_hour" || type === "seven_day") kind = type;
      // No type given: a reset within five hours can only be the short window.
      else if (type === undefined) kind = Date.parse(resetsAt) - Date.parse(at) <= 5 * 3600_000 ? "five_hour" : "seven_day";
      // Per-model and overage windows are not the shared ones; they add no window here.
      if (kind) windows.push({ kind, utilization: fraction(info.utilization), resetsAt });
    }
  }
  const sample: UsageSample = { at, windows };
  if (typeof info.status === "string") sample.status = info.status;
  if (typeof info.isUsingOverage === "boolean") sample.usingOverage = info.isUsingOverage;
  return sample;
}

/** The words a card uses for a tool. Other tools keep their own name in lower case. */
export const TOOL_WORDS: Record<string, string> = {
  Read: "reading", Edit: "editing", MultiEdit: "editing", Write: "writing", Bash: "running", Grep: "searching", Glob: "finding",
};

/** One tool call in a few words: "reading web/tsconfig.json", "running pnpm check". */
export function describeTool(name: string, input: Obj, root?: string): string {
  const word = TOOL_WORDS[name] ?? name.toLowerCase();
  const pick = (...keys: string[]) => keys.map((key) => input[key]).find((value): value is string => typeof value === "string" && value !== "");
  const file = pick("file_path", "notebook_path");
  if (file) return `${word} ${shortPath(file, root)}`;
  if (name === "Bash") {
    const command = pick("command", "description");
    return command ? `${word} ${oneLine(command, DETAIL_MAX)}` : word;
  }
  const path = pick("path");
  const pattern = pick("pattern");
  if (pattern) return oneLine(path ? `${word} ${pattern} in ${shortPath(path, root)}` : `${word} ${pattern}`, DETAIL_MAX + 20);
  const other = path ? shortPath(path, root) : pick("description", "url");
  return other ? oneLine(`${word} ${other}`, DETAIL_MAX + 20) : word;
}

/** The last thing an assistant message did, in a line for the card. */
function actionOf(event: Obj, root?: string): string | undefined {
  const message = event.message;
  if (!isObj(message) || !Array.isArray(message.content)) return undefined;
  let action: string | undefined;
  for (const block of message.content as unknown[]) {
    if (!isObj(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") action = oneLine(block.text);
    else if (block.type === "tool_use" && typeof block.name === "string") {
      action = describeTool(block.name, isObj(block.input) ? block.input : {}, root);
    }
  }
  return action;
}

function resultOf(event: Obj): StreamResult {
  const result: StreamResult = { isError: event.is_error === true, hasStructuredOutput: "structured_output" in event && event.structured_output != null };
  if (result.hasStructuredOutput) result.structuredOutput = event.structured_output;
  if (typeof event.subtype === "string") result.subtype = event.subtype;
  if (typeof event.result === "string") result.text = event.result;
  if (typeof event.total_cost_usd === "number") result.costUsd = event.total_cost_usd;
  if (typeof event.num_turns === "number") result.turns = event.num_turns;
  if (typeof event.session_id === "string") result.sessionId = event.session_id;
  if (typeof event.api_error_status === "number") result.apiErrorStatus = event.api_error_status;
  if (typeof event.terminal_reason === "string") result.terminalReason = event.terminal_reason;
  if (typeof event.subtype === "string" && event.subtype.startsWith("error")) result.isError = true;
  if (Array.isArray(event.permission_denials)) {
    const denied = (event.permission_denials as unknown[]).flatMap((entry): string[] => {
      if (!isObj(entry)) return [];
      const input = isObj(entry.tool_input) ? entry.tool_input : {};
      if (typeof input.command === "string" && input.command.trim()) return [input.command.trim()];
      return typeof entry.tool_name === "string" ? [entry.tool_name] : [];
    });
    if (denied.length > 0) result.denied = denied;
  }
  return result;
}

/**
 * True when the run ended on the plan's usage limit (not on a transient 429 or 529).
 * The exact shape of a limit hit is not documented; this follows the research notes.
 */
export function isLimitHit(result: StreamResult | undefined, lastUsage: UsageSample | undefined): boolean {
  if (result?.text && /hit your .*limit/i.test(result.text)) return true;
  if (result?.terminalReason === "blocking_limit") return true;
  return lastUsage?.status === "rejected" && (result === undefined || result.isError);
}

/** `root` is the work clone the agent runs in; paths inside it are shown relative to it. */
export function createStreamParser(now: () => string, root?: string): StreamParser {
  let buffer = "";
  const state: StreamSummary = { lines: 0, malformed: 0, repaired: 0 };

  function interpret(object: Obj, raw: string): StreamEvent {
    const type = typeof object.type === "string" ? object.type : "";
    if (type === "system" && object.subtype === "init" && typeof object.session_id === "string") {
      state.sessionId = object.session_id;
      return { kind: "init", raw, sessionId: object.session_id, model: typeof object.model === "string" ? object.model : undefined };
    }
    if (type === "assistant") {
      const text = actionOf(object, root);
      if (text) {
        state.lastAction = text;
        return { kind: "action", raw, text };
      }
    }
    if (type === "rate_limit_event") {
      const sample = usageFromEvent(object, now());
      if (sample) {
        state.lastUsage = sample;
        return { kind: "usage", raw, sample };
      }
    }
    if (type === "result") {
      const result = resultOf(object);
      state.result = result;
      if (result.sessionId && !state.sessionId) state.sessionId = result.sessionId;
      return { kind: "result", raw, result };
    }
    return { kind: "other", raw, type: type || "unknown" };
  }

  function line(raw: string): StreamEvent[] {
    if (raw.trim() === "") return [];
    state.lines++;
    const { objects, clean } = objectsOnLine(raw.trim());
    if (!clean) state.malformed++;
    if (objects.length === 0) return [{ kind: "malformed", raw }];
    if (!clean) state.repaired++;
    return objects.map((object) => interpret(object, raw));
  }

  return {
    push(chunk) {
      buffer += chunk;
      const events: StreamEvent[] = [];
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const raw = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        events.push(...line(raw));
      }
      return events;
    },
    end() {
      const raw = buffer;
      buffer = "";
      return line(raw);
    },
    summary() {
      return { ...state };
    },
    limitHit(lastUsage) {
      return isLimitHit(state.result, lastUsage);
    },
  };
}
