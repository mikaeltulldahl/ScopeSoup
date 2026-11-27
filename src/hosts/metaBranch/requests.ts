// A person's pick on the board for an Item whose work runs on another machine (decision 104): written on the meta ref as a
// request, which every project has whatever its Items' host. The machine that holds the work carries it out at its next fetch
// and writes one answer line. Pure: the files' names, the lines' shapes, and the fold of the lines into each request's state.
//
// The lines go in one append-only file per month, `requests/<yyyy-mm>.jsonl` (merged like an Item's log), named by the line's
// own time. A request lives minutes, so only this month's and the last month's files are read; older ones are never read again,
// and no file grows past a month of picks.
//
//   {"at":…,"by":{"who":"mira","machine":"laptop-a","agent":false},"kind":"pick","id":"<uuid>","item":"meta:work:A-2",
//    "for":"laptop-b","seen":"<the Item's updatedAt the page showed>","steps":[{"kind":"move","to":"todo"}]}
//   {"at":…,"by":{"who":"scopesoup","machine":"laptop-b","agent":true},"kind":"pick-done","request":"<uuid>","done":["moved"]}
//   {"at":…,"by":{"who":"scopesoup","machine":"laptop-b","agent":true},"kind":"pick-refused","request":"<uuid>","why":"…"}
//
// Only a person's line is a request (an agent's is skipped), and only the picks a board sends for another machine's work: one
// move, or Abandoned. A request has lapsed when it waited `REQUEST_TTL_MS` since this machine first saw it, or `REQUEST_MAX_AGE_MS`
// by its own time (a machine back after hours does not act on old picks); a lapsed one is never carried out. Lines stay.

import type { LogEntry } from "./log.ts";
import { parseLog } from "./log.ts";
import { serializeLogLine } from "./serialize.ts";

/** The month's requests file for a line written at `at`. */
export const requestsFile = (at: string): string => `requests/${new Date(at).toISOString().slice(0, 7)}.jsonl`;

/** A requests file on the meta ref: append-only, merged as a log. */
export const isRequestsLog = (path: string): boolean => /^requests\/\d{4}-\d{2}\.jsonl$/.test(path);

/** The files read at `now`: last month's, then this month's. */
export function requestsFiles(now: string): string[] {
  const date = new Date(now);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString();
  return [requestsFile(last), requestsFile(now)];
}

/** How long a request waits for the machine it names, from when this machine first saw it: fetches run every minute. */
export const REQUEST_TTL_MS = 15 * 60_000;
/** The most a request may be old by its own time and still be carried out (clocks of machines differ a little). */
export const REQUEST_MAX_AGE_MS = 60 * 60_000;
/** A request dated further ahead of this machine's clock is refused: its time cannot be trusted to make it lapse. */
export const REQUEST_AHEAD_MS = 2 * 60_000;

/** A pick's steps as the board's `POST /api/item/pick` takes them. */
export type RequestStep =
  | { kind: "release" | "claim" | "block" }
  | { kind: "state"; state: "todo" | "done" | "abandoned" }
  | { kind: "lane"; lane: "backlog" | "todo" }
  | { kind: "move"; to: "triage" | "todo" | "in-review" | "merge-queue" | "implement" };

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
  /** Absent while it waits; then what that machine did. */
  answer?: { at: string; done?: string[]; why?: string };
}

const MOVES = new Set(["triage", "todo", "in-review", "merge-queue", "implement"]);

/** The one step a request may carry: what a board sends for another machine's work (a move, or Abandoned). */
function asStep(value: unknown): RequestStep | null {
  if (typeof value !== "object" || value === null) return null;
  const each = value as Record<string, unknown>;
  if (each.kind === "state" && each.state === "abandoned") return { kind: "state", state: "abandoned" };
  if (each.kind === "move" && typeof each.to === "string" && MOVES.has(each.to)) return { kind: "move", to: each.to as "triage" | "todo" | "in-review" | "merge-queue" | "implement" };
  return null;
}

/** Backlog for work on another machine: the work dropped there, then the lane written there (decision 120). */
const isBacklogPick = (steps: readonly unknown[]): boolean => {
  const [drop, lane] = steps as Record<string, unknown>[];
  return steps.length === 2 && drop?.kind === "move" && drop.to === "todo" && lane?.kind === "lane" && lane.lane === "backlog";
};

/** Whether a board's pick may go to another machine as a request: one move, Abandoned, or Backlog (drop, then the lane). */
export const requestable = (steps: readonly unknown[]): boolean => (steps.length === 1 && asStep(steps[0]) !== null) || isBacklogPick(steps);

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= 300 ? value : undefined);

function asRequest(entry: LogEntry): PickRequest | null {
  // Only a person picks: a line an agent wrote is not a request.
  if (entry.by.agent) return null;
  const { data } = entry;
  const id = str(data.id);
  const item = str(data.item);
  const target = str(data.for);
  const seen = str(data.seen);
  const steps = Array.isArray(data.steps) ? data.steps : [];
  if (!id || !item || !target || !seen || !requestable(steps)) return null;
  const typed: RequestStep[] = isBacklogPick(steps) ? [{ kind: "move", to: "todo" }, { kind: "lane", lane: "backlog" }] : [asStep(steps[0])!];
  return { id, at: entry.at, who: entry.by.who, ...(entry.by.machine ? { from: entry.by.machine } : {}), item, for: target, seen, steps: typed };
}

/** Every request in the lines, oldest first, each with the first answer written for it. Lines of other shapes are skipped. */
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
    // Only Scope Soup on the machine the request names answers it.
    if (!request || request.answer || !entry.by.agent || entry.by.machine !== request.for) continue;
    request.answer = entry.kind === "pick-done"
      ? { at: entry.at, done: Array.isArray(entry.data.done) ? entry.data.done.filter((each): each is string => typeof each === "string") : [] }
      : { at: entry.at, why: str(entry.data.why) ?? "refused" };
  }
  return requests;
}

/** Where a request stands at `now` (milliseconds), `firstSeen` being when this machine first read it. */
export function requestState(request: PickRequest, now: number, firstSeen: number = now): "pending" | "done" | "refused" | "lapsed" {
  if (request.answer) return request.answer.why !== undefined ? "refused" : "done";
  return now - firstSeen > REQUEST_TTL_MS || now - Date.parse(request.at) > REQUEST_MAX_AGE_MS ? "lapsed" : "pending";
}

/** Why a request cannot be trusted at `now`: dated ahead of this machine's clock. */
export function aheadWhy(request: PickRequest, now: number): string | undefined {
  const ahead = Date.parse(request.at) - now;
  return ahead > REQUEST_AHEAD_MS ? `it is dated ${Math.round(ahead / 60_000)} minutes ahead of this machine's clock` : undefined;
}

/**
 * The requests' lines in memory, for tests and the demo: `lines` stands for the files, shared by every machine given them (as if
 * each fetched at once). Written through the same line format as the meta ref's.
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
