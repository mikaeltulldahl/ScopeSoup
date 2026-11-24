// Defensive reader for `copilot -p --output-format json`: JSON lines, each `{type, data, ...}`, ending with a `result` line
// (`{type: "result", sessionId, exitCode, usage}`). Recorded with Copilot CLI 1.0.115 (`fixtures/`). Most event types are
// ephemeral noise (MCP status, deltas, skills) and read as "other". A driver run that asked again once holds two runs, one
// after the other: the last answer and the last `result` count.

import type { AgentEvent, AgentResult, EventReader, EventSummary } from "../../agent.ts";
import { DETAIL_MAX, isObj, objectsOnLine, oneLine, shortPath } from "../lines.ts";
import type { Obj } from "../lines.ts";
import { checkAnswer } from "./answer.ts";

/** The words a card uses for Copilot's tools. Others keep their own name. */
const TOOL_WORDS: Record<string, string> = {
  powershell: "running", bash: "running", shell: "running", view: "reading", edit: "editing", str_replace: "editing",
  create: "writing", write: "writing", grep: "searching", rg: "searching", glob: "finding",
};

/** One tool request in a few words: "running git status", "reading src/a.ts". */
export function describeTool(name: string, args: Obj, root?: string): string {
  const word = TOOL_WORDS[name] ?? name.toLowerCase();
  const pick = (...keys: string[]) => keys.map((key) => args[key]).find((value): value is string => typeof value === "string" && value !== "");
  const command = pick("command");
  if (command) return `${word} ${oneLine(command, DETAIL_MAX)}`;
  const path = pick("path", "file_path");
  const pattern = pick("pattern");
  if (pattern) return oneLine(path ? `${word} ${pattern} in ${shortPath(path, root)}` : `${word} ${pattern}`, DETAIL_MAX + 20);
  if (path) return `${word} ${shortPath(path, root)}`;
  const other = pick("description", "url");
  return other ? oneLine(`${word} ${other}`, DETAIL_MAX + 20) : word;
}

/** The message's content when it is the session's final answer. */
export function finalAnswerOf(event: Obj): string | undefined {
  if (event.type !== "assistant.message" || !isObj(event.data) || event.data.phase !== "final_answer") return undefined;
  return typeof event.data.content === "string" ? event.data.content : undefined;
}

/** The plan's limit, in the words Copilot says it with (`copilot help limits`). */
const LIMIT_TEXT = /(hit|reached) (the|your) (\w+ )?rate limit/i;

export interface CopilotSummary extends EventSummary {
  /** The last final answer's text, checked or not. */
  answer?: string;
}

export interface CopilotReader extends EventReader {
  summary(): CopilotSummary;
}

/** `schema`: the answer's schema; the result has the answer only when the last final answer fits it. */
export function createCopilotReader(now: () => string, root?: string, schema?: string): CopilotReader {
  void now;
  let buffer = "";
  const state: CopilotSummary = { lines: 0, malformed: 0, repaired: 0 };
  const commands = new Map<string, string>();
  const denied: string[] = [];
  const errors: string[] = [];
  let turns = 0;
  let aiCredits: number | undefined;

  function result(object: Obj): AgentResult {
    const exitCode = typeof object.exitCode === "number" ? object.exitCode : undefined;
    const isError = exitCode !== undefined && exitCode !== 0;
    const out: AgentResult = { isError, hasStructuredOutput: false, subtype: isError ? `exit ${exitCode}` : "success", turns };
    if (typeof object.sessionId === "string") out.sessionId = object.sessionId;
    const usage = isObj(object.usage) ? object.usage : {};
    if (typeof usage.premiumRequests === "number") out.premiumRequests = usage.premiumRequests;
    if (aiCredits !== undefined) out.aiCredits = aiCredits;
    if (denied.length > 0) out.denied = [...denied];
    const text = isError && errors.length > 0 ? errors[errors.length - 1] : state.answer;
    if (text !== undefined) out.text = text;
    if (schema && !isError) {
      const checked = checkAnswer(state.answer, schema);
      if (checked.ok) {
        out.hasStructuredOutput = true;
        out.structuredOutput = checked.value;
      }
    }
    return out;
  }

  function interpret(object: Obj, raw: string): AgentEvent {
    const type = typeof object.type === "string" ? object.type : "";
    const data = isObj(object.data) ? object.data : {};
    if (type === "session.start" && typeof data.sessionId === "string") {
      state.sessionId = data.sessionId;
      return { kind: "init", raw, sessionId: data.sessionId, model: typeof data.selectedModel === "string" ? data.selectedModel : undefined };
    }
    if (type === "assistant.turn_start") turns++;
    if (type === "assistant.message") {
      const answer = finalAnswerOf(object);
      if (answer !== undefined) state.answer = answer;
      let action: string | undefined;
      if (typeof data.content === "string" && data.content.trim() !== "") action = oneLine(data.content);
      for (const request of Array.isArray(data.toolRequests) ? (data.toolRequests as unknown[]) : []) {
        if (isObj(request) && typeof request.name === "string") action = describeTool(request.name, isObj(request.arguments) ? request.arguments : {}, root);
      }
      if (action) {
        state.lastAction = action;
        return { kind: "action", raw, text: action };
      }
    }
    if (type === "tool.execution_start" && typeof data.toolCallId === "string") {
      const args = isObj(data.arguments) ? data.arguments : {};
      const command = typeof args.command === "string" && args.command.trim() ? args.command.trim() : typeof data.toolName === "string" ? data.toolName : "";
      if (command) commands.set(data.toolCallId, command);
    }
    if (type === "tool.execution_complete" && data.success === false && isObj(data.error) && data.error.code === "denied") {
      const command = typeof data.toolCallId === "string" ? commands.get(data.toolCallId) : undefined;
      if (command) denied.push(command);
    }
    if (type === "session.usage_checkpoint" && typeof data.totalNanoAiu === "number") aiCredits = data.totalNanoAiu / 1e9;
    if (type === "session.error" || type === "error") {
      const message = typeof data.message === "string" ? data.message : typeof object.message === "string" ? object.message : undefined;
      if (message) errors.push(message);
    }
    if (type === "result") {
      const read = result(object);
      state.result = read;
      if (read.sessionId) state.sessionId = read.sessionId;
      return { kind: "result", raw, result: read };
    }
    return { kind: "other", raw, type: type || "unknown" };
  }

  function line(raw: string): AgentEvent[] {
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
      const events: AgentEvent[] = [];
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
    // Copilot's stream carries no usage windows: a limit hit is told apart by the words of its error.
    limitHit() {
      return errors.some((text) => LIMIT_TEXT.test(text)) || (state.result?.isError === true && LIMIT_TEXT.test(state.result.text ?? ""));
    },
  };
}
