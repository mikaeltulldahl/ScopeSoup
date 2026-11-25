// A person's pick on the board for an Item whose work runs on another machine (decision 104): written on the meta ref as a
// request, `requests/log.jsonl` (append-only, merged like an Item's log), which every project has whatever its Items' host.
// The machine that holds the work carries it out at its next fetch and writes one answer line. Pure: the file's name, the lines'
// shapes, and the fold of the log into each request's state.
//
//   {"at":…,"by":{"who":"mira","machine":"laptop-a","agent":false},"kind":"pick","id":"<uuid>","item":"meta:work:A-2",
//    "for":"laptop-b","seen":"<the Item's updatedAt the page showed>","steps":[{"kind":"move","to":"backlog"}]}
//   {"at":…,"by":{"who":"scopesoup","machine":"laptop-b","agent":true},"kind":"pick-done","request":"<uuid>","done":["moved"]}
//   {"at":…,"by":{"who":"scopesoup","machine":"laptop-b","agent":true},"kind":"pick-refused","request":"<uuid>","why":"…"}
//
// A request nobody answered within `REQUEST_TTL_MS` has lapsed (the machine is gone or off): it is no longer pending, and the
// machine it names never carries it out later. Its line stays, as every line does.

import type { LogEntry } from "./log.ts";
import { parseLog } from "./log.ts";
import { serializeLogLine } from "./serialize.ts";

/** The requests' log on the meta ref. */
export const REQUESTS_LOG = "requests/log.jsonl";

/** How long a request waits for the machine it names: fetches run every minute, so this is many fetches. */
export const REQUEST_TTL_MS = 15 * 60_000;

/** A pick's steps as the board's `POST /api/item/pick` takes them. */
export type RequestStep = { kind: "release" | "claim" | "block" } | { kind: "state"; state: "todo" | "done" | "abandoned" } | { kind: "move"; to: "triage" | "backlog" | "in-review" | "merge-queue" };

export interface PickRequest {
  id: string;
  at: string;
  /** The person who picked, and the machine whose board they used. */
  who: string;
  from?: string;
  /** The Item's ref key. */
  item: string;
  /** The machine that holds the work. */
  for: string;
  seen: string;
  steps: RequestStep[];
  blockedBy?: string[];
  /** Absent while it waits; then what that machine did. */
  answer?: { at: string; done?: string[]; why?: string };
}

const MOVES = new Set(["triage", "backlog", "in-review", "merge-queue"]);
const STATES = new Set(["todo", "done", "abandoned"]);

function asStep(value: unknown): RequestStep | null {
  if (typeof value !== "object" || value === null) return null;
  const each = value as Record<string, unknown>;
  if (each.kind === "release" || each.kind === "claim" || each.kind === "block") return { kind: each.kind };
  if (each.kind === "state" && typeof each.state === "string" && STATES.has(each.state)) return { kind: "state", state: each.state as "todo" | "done" | "abandoned" };
  if (each.kind === "move" && typeof each.to === "string" && MOVES.has(each.to)) return { kind: "move", to: each.to as "triage" | "backlog" | "in-review" | "merge-queue" };
  return null;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= 300 ? value : undefined);

function asRequest(entry: LogEntry): PickRequest | null {
  const { data } = entry;
  const id = str(data.id);
  const item = str(data.item);
  const target = str(data.for);
  const seen = str(data.seen);
  const steps = Array.isArray(data.steps) ? data.steps.map(asStep) : [];
  if (!id || !item || !target || !seen || steps.length === 0 || steps.length > 3 || steps.some((step) => step === null)) return null;
  const blockedBy = Array.isArray(data.blockedBy) ? data.blockedBy.filter((each): each is string => typeof each === "string") : undefined;
  return { id, at: entry.at, who: entry.by.who, ...(entry.by.machine ? { from: entry.by.machine } : {}), item, for: target, seen, steps: steps as RequestStep[], ...(blockedBy ? { blockedBy } : {}) };
}

/** Every request in the log, oldest first, each with the first answer written for it. Lines of other shapes are skipped. */
export function readRequests(text: string): PickRequest[] {
  const requests: PickRequest[] = [];
  const byId = new Map<string, PickRequest>();
  const entries = parseLog(text).entries;
  for (const entry of entries) {
    if (entry.kind !== "pick") continue;
    const request = asRequest(entry);
    if (!request || byId.has(request.id)) continue;
    byId.set(request.id, request);
    requests.push(request);
  }
  for (const entry of entries) {
    if (entry.kind !== "pick-done" && entry.kind !== "pick-refused") continue;
    const request = byId.get(str(entry.data.request) ?? "");
    // Only the machine the request names answers it.
    if (!request || request.answer || entry.by.machine !== request.for) continue;
    request.answer = entry.kind === "pick-done"
      ? { at: entry.at, done: Array.isArray(entry.data.done) ? entry.data.done.filter((each): each is string => typeof each === "string") : [] }
      : { at: entry.at, why: str(entry.data.why) ?? "refused" };
  }
  return requests;
}

/** Where a request stands at `now` (milliseconds). */
export function requestState(request: PickRequest, now: number): "pending" | "done" | "refused" | "lapsed" {
  if (request.answer) return request.answer.why !== undefined ? "refused" : "done";
  return now - Date.parse(request.at) > REQUEST_TTL_MS ? "lapsed" : "pending";
}

/**
 * The requests' log in memory, for tests and the demo: `lines` is the file, shared by every machine given it (as if each
 * fetched at once). Written through the same line format as the meta ref's.
 */
export function memoryRequests(lines: string[], machine: string, now: () => string = () => new Date().toISOString()): {
  machine: string;
  list(): PickRequest[];
  write(line: { kind: string; by: { who: string; agent: boolean }; fields: Record<string, unknown> }): Promise<{ ok: true }>;
} {
  return {
    machine,
    list: () => readRequests(lines.join("\n")),
    write: async (line) => {
      lines.push(serializeLogLine({ at: now(), by: { ...line.by, machine }, kind: line.kind, fields: line.fields }));
      return { ok: true };
    },
  };
}
