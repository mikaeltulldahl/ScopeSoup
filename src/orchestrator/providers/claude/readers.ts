// What the board reads from a finished `claude` stream file: a chat turn's reply, the tools called, the tokens used.

import type { ToolCall } from "../../agent.ts";
import { describeTool, objectsOnLine } from "./stream.ts";

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

function* events(text: string): Generator<Obj> {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    yield* objectsOnLine(line.trim()).objects;
  }
}

/**
 * The reply in a turn's stream (`stream-json` with partial messages): the text of each finished assistant message, then the
 * text of the message being written. A tool call adds no text.
 */
export function replyIn(text: string): string {
  const done: string[] = [];
  let partial = "";
  for (const event of events(text)) {
    if (event.type === "assistant" && isObj(event.message) && Array.isArray(event.message.content)) {
      partial = "";
      for (const block of event.message.content as unknown[]) {
        if (isObj(block) && block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") done.push(block.text.trim());
      }
    } else if (event.type === "stream_event" && isObj(event.event)) {
      const inner = event.event;
      if (inner.type === "message_start") partial = "";
      else if (inner.type === "content_block_delta" && isObj(inner.delta) && inner.delta.type === "text_delta" && typeof inner.delta.text === "string") partial += inner.delta.text;
    }
  }
  return [...done, partial.trim()].filter((part) => part !== "").join("\n\n");
}

/** The tools the stream's assistant messages called, each in a few words, oldest first. */
export function toolCallsIn(text: string, root?: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of events(text)) {
    if (event.type !== "assistant" || !isObj(event.message) || !Array.isArray(event.message.content)) continue;
    for (const block of event.message.content as unknown[]) {
      if (!isObj(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
      calls.push({ name: block.name, text: describeTool(block.name, isObj(block.input) ? block.input : {}, root) });
    }
  }
  return calls;
}

/** Input, output and cache-creation tokens of a finished stream (its last `result` line); undefined when it says none. */
export function tokensIn(text: string): number | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"type":"result"')) continue;
    try {
      const usage = (JSON.parse(lines[i]!) as { usage?: Record<string, unknown> }).usage;
      if (!usage) return undefined;
      const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
      const total = n("input_tokens") + n("output_tokens") + n("cache_creation_input_tokens");
      return total > 0 ? total : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
