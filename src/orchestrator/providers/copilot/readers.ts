// What the board reads from a finished `copilot` stream file: a chat turn's reply, the tools called, and the tokens used
// (from the usage file Copilot writes beside the stream, `--usage-output-file`, which the caller reads).

import type { BesideStream, ToolCall } from "../../agent.ts";
import { isObj, objectsOnLine } from "../lines.ts";
import type { Obj } from "../lines.ts";
import { RETRY_USAGE_SUFFIX, USAGE_SUFFIX } from "./command.ts";
import { describeTool } from "./stream.ts";

function* events(text: string): Generator<Obj> {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    yield* objectsOnLine(line.trim()).objects;
  }
}

/** The reply in a turn's stream: the text of each finished assistant message, then the text of the message being written. */
export function replyIn(text: string): string {
  const done: string[] = [];
  let partial = "";
  for (const event of events(text)) {
    const data = isObj(event.data) ? event.data : {};
    if (event.type === "assistant.message") {
      partial = "";
      if (typeof data.content === "string" && data.content.trim() !== "") done.push(data.content.trim());
    } else if (event.type === "assistant.message_start") partial = "";
    else if (event.type === "assistant.message_delta" && typeof data.deltaContent === "string") partial += data.deltaContent;
  }
  return [...done, partial.trim()].filter((part) => part !== "").join("\n\n");
}

/** The tools the stream's assistant messages asked for, each in a few words, oldest first. */
export function toolCallsIn(text: string, root?: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of events(text)) {
    if (event.type !== "assistant.message" || !isObj(event.data) || !Array.isArray(event.data.toolRequests)) continue;
    for (const request of event.data.toolRequests as unknown[]) {
      if (!isObj(request) || typeof request.name !== "string") continue;
      calls.push({ name: request.name, text: describeTool(request.name, isObj(request.arguments) ? request.arguments : {}, root) });
    }
  }
  return calls;
}

/** Input, output and cache-write tokens from a usage file's text (cache reads left out, as for the other providers). */
export function tokensInUsage(text: string): number | undefined {
  try {
    const usage = JSON.parse(text) as unknown;
    if (!isObj(usage) || !isObj(usage.tokenDetails)) return undefined;
    const details = usage.tokenDetails;
    const count = (key: string) => {
      const entry = details[key];
      return isObj(entry) && typeof entry.tokenCount === "number" ? entry.tokenCount : 0;
    };
    const total = count("input") + count("output") + count("cache_write");
    return total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The tokens of a finished session: its stream has none, so they are read from the usage files beside it, the first run's
 * and, when the driver asked again, the second run's, added up. (Premium requests are read from the stream's last `result`
 * line instead: the recording shows them counted for the whole session, earlier runs included. Whether a resumed run's usage
 * file counts only that run, as this sum takes it, is not recorded yet.)
 */
export function tokensIn(_stream: string, beside?: BesideStream): number | undefined {
  if (!beside) return undefined;
  let total: number | undefined;
  for (const suffix of [USAGE_SUFFIX, RETRY_USAGE_SUFFIX]) {
    const text = beside(suffix);
    if (text === undefined) continue;
    const tokens = tokensInUsage(text);
    if (tokens !== undefined) total = (total ?? 0) + tokens;
  }
  return total;
}
