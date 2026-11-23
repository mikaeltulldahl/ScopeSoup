// The flat list of all items, open and closed, with search and filters. It stores nothing of its own.

import type { Actor, Priority, TurnActor, WorkItem, WorkState } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { isPriority } from "../model/priority.ts";
import { LANES, situate } from "./lanes.ts";
import type { Snapshot } from "./snapshot.ts";
import { buildIndex, ms, refLabel } from "./snapshot.ts";
import { assess, turnContext } from "./turns.ts";
import type { ItemListQuery, ItemListRow, ItemListView } from "./views.ts";

export const LIST_LIMIT = 200;
const STATES: readonly string[] = ["todo", "doing", "waiting", "done", "abandoned"];
const ACTORS: readonly string[] = ["anyone", "person", "agent", "queue", "runner", "nobody"];
const DAY = 86_400_000;

const words = (value: string | null): string[] => (value ?? "").split(",").map((each) => each.trim()).filter((each) => each !== "");

/** Reads the filters from a URL's query. What is not understood is ignored, so an old link still opens. */
export function parseListQuery(params: URLSearchParams): ItemListQuery {
  const query: ItemListQuery = {};
  const q = params.get("q")?.trim();
  if (q) query.q = q.slice(0, 200);
  const state = words(params.get("state")).filter((each) => each === "open" || STATES.includes(each));
  if (state.length > 0) query.state = state;
  const lane = words(params.get("lane")).filter((each) => each === "abandoned" || (LANES as readonly string[]).includes(each));
  if (lane.length > 0) query.lane = lane;
  const priority = words(params.get("priority")).filter(isPriority);
  if (priority.length > 0) query.priority = priority;
  const turn = words(params.get("turn")).filter((each): each is TurnActor => ACTORS.includes(each));
  if (turn.length > 0) query.turn = turn;
  const label = params.get("label")?.trim();
  if (label) query.label = label;
  const holder = params.get("holder")?.trim();
  if (holder) query.holder = holder;
  const change = params.get("change");
  if (change === "yes" || change === "no") query.change = change;
  const days = Number(params.get("doneDays"));
  if (params.get("doneDays") && Number.isFinite(days) && days >= 0) query.doneDays = Math.min(days, 3650);
  const createdBy = params.get("createdBy")?.trim();
  if (createdBy) query.createdBy = createdBy;
  const keys = words(params.get("keys")).slice(0, 50);
  if (keys.length > 0) query.keys = keys;
  return query;
}

/** True when `actor` is `who`: the id, the name, or the id before an `@machine`, case-insensitively. */
function isPerson(actor: Actor | undefined, who: string): boolean {
  if (!actor) return false;
  const wanted = who.toLowerCase();
  const id = actor.id.toLowerCase();
  const name = actor.name.toLowerCase();
  return id === wanted || id.startsWith(`${wanted}@`) || name === wanted || name.startsWith(`${wanted} on `);
}

function creator(item: WorkItem): Actor | undefined {
  return item.history?.find((line) => line.kind === "created")?.by;
}

function matchesText(item: WorkItem, query: string): boolean {
  const needle = query.toLowerCase();
  if (item.ref.id.toLowerCase() === needle.replace(/^#/, "")) return true;
  return [item.title, item.body ?? "", refLabel(item.ref)].some((part) => part.toLowerCase().includes(needle));
}

/**
 * Every item that passes the filters, most recently changed first (or in the order of `keys`).
 * `me` is who "me" is: `createdBy=me` means items whose log starts with a line by that person.
 * A done item's "when" is its last change, as the item does not record when it was closed.
 */
export function buildItemList(snapshot: Snapshot, query: ItemListQuery, now: Date, me?: string): ItemListView {
  const index = buildIndex(snapshot);
  const ctx = turnContext(index, now);
  const labels = new Set<string>();
  const rows: (ItemListRow & { time: number })[] = [];
  const wantedKeys = query.keys ? new Set(query.keys) : undefined;
  const who = query.createdBy === "me" ? me : query.createdBy;
  for (const item of snapshot.works) {
    for (const label of item.labels) labels.add(label);
    const key = refKey(item.ref);
    if (wantedKeys && !wantedKeys.has(key)) continue;
    const open = item.state !== "done" && item.state !== "abandoned";
    if (query.state && !query.state.some((state) => (state === "open" ? open : state === item.state))) continue;
    if (query.priority && !query.priority.includes(item.priority ?? "major")) continue;
    if (query.label && !item.labels.some((label) => label.toLowerCase() === query.label!.toLowerCase())) continue;
    if (query.q && !matchesText(item, query.q)) continue;
    const time = ms(item.updatedAt) ?? 0;
    if (query.doneDays !== undefined && (item.state !== "done" || time < now.getTime() - query.doneDays * DAY)) continue;
    if (query.createdBy !== undefined && (who === undefined || !isPerson(creator(item), who))) continue;
    if (query.holder) {
      const held = item.holder?.actor;
      if (query.holder === "none" ? held !== undefined : !isPerson(held, query.holder)) continue;
    }
    const changes = index.changesByWork.get(key) ?? [];
    if (query.change === "yes" && changes.length === 0) continue;
    if (query.change === "no" && changes.length > 0) continue;
    const { turn, tone, situation } = assess(situate(item, index), ctx);
    if (query.turn && !query.turn.includes(turn.actor)) continue;
    if (query.lane && !query.lane.includes(situation.lane ?? "abandoned")) continue;
    const change = changes.find((each) => each.state === "open") ?? changes[0];
    rows.push({
      key,
      label: refLabel(item.ref),
      title: item.title,
      state: item.state as WorkState,
      lane: situation.lane,
      actor: turn.actor,
      reason: turn.reason,
      tone,
      labels: item.labels,
      updatedAt: item.updatedAt,
      time,
      ...(item.priority ? { priority: item.priority as Priority } : {}),
      ...(item.holder ? { holder: item.holder.actor.name } : {}),
      ...(change ? { change: { label: refLabel(change.ref), state: change.state } } : {}),
    });
  }
  if (query.keys) {
    const order = new Map(query.keys.map((key, position) => [key, position]));
    rows.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  } else rows.sort((a, b) => b.time - a.time || a.key.localeCompare(b.key));
  return {
    now: now.toISOString(),
    total: rows.length,
    items: rows.slice(0, LIST_LIMIT).map(({ time: _time, ...row }) => row),
    labels: [...labels].sort((a, b) => a.localeCompare(b)),
    ...(me ? { me } : {}),
  };
}
