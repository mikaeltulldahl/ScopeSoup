// Who holds what: the items others hold, by machine and by person, as far as the items' logs tell.
// Pure. The server adds which machine and person this board belongs to, and what it last saw of the
// merge queue lease.

import type { Actor, LogRecord, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { HeldItem, HolderGroup, HoldingsView, MachineView } from "./views.ts";
import { ms, refLabel } from "./snapshot.ts";

/** The machine and the person this board belongs to. */
export interface Self {
  machine?: string;
  person?: string;
}

/** A person's hold with no log line for this long is shown as quiet (nothing expires; the board only asks). */
export const QUIET_MS = 24 * 3600_000;

/** What the board says about a hold: since when, where it came from, and whether a person's has been quiet for long. */
export interface HoldDetails {
  since?: string;
  /** Where the hold came from, as the `claimed` line says: `claude-code` for a session. */
  from?: string;
  quiet: boolean;
}

/** Pure. A person's hold is quiet when nothing was written to the item for a day; nothing expires by itself. */
export function holdDetails(item: WorkItem, now: Date): HoldDetails | undefined {
  if (!item.holder) return undefined;
  const parts = actorParts(item.holder.actor);
  const log = item.log ?? [];
  const claimed = [...log].reverse().find((line) => line.kind === "claimed" && line.by.who === parts.who && line.by.machine === parts.machine);
  const touched = ms([...log].pop()?.at) ?? ms(item.updatedAt);
  const from = typeof claimed?.fields.from === "string" && claimed.fields.from ? claimed.fields.from : undefined;
  return {
    ...(claimed ? { since: claimed.at } : {}),
    ...(from ? { from } : {}),
    quiet: !item.holder.actor.bot && touched !== null && now.getTime() - touched > QUIET_MS,
  };
}

const open = (item: WorkItem): boolean => item.state !== "done" && item.state !== "abandoned";

/** `who@machine` as the meta branch host writes it, or a bare name. */
export function actorParts(actor: Actor): { who: string; machine?: string } {
  const at = actor.id.lastIndexOf("@");
  return at > 0 ? { who: actor.id.slice(0, at), machine: actor.id.slice(at + 1) } : { who: actor.id };
}

/**
 * This actor is the person picked at this board (a person's claim is `person@machine`). A person is not tied to a
 * machine: their hold is theirs on every board, whatever machine wrote it. Only agents' claims are machine-bound.
 */
export function isSelfPerson(actor: Actor, self: Self | undefined): boolean {
  if (!self?.person || actor.bot) return false;
  return actorParts(actor).who === self.person;
}

const clip = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/** The newest session line of the item's log in words: what another machine's session did, as the log tells it. */
function lastSession(log: readonly LogRecord[]): HeldItem["last"] | undefined {
  const line = [...log].reverse().find((each) => each.kind === "session");
  if (!line) return undefined;
  const role = typeof line.fields.role === "string" ? line.fields.role : "session";
  const outcome = typeof line.fields.outcome === "string" ? line.fields.outcome : "";
  const summary = typeof line.fields.summary === "string" ? line.fields.summary.trim() : "";
  return { at: line.at, words: clip(`${role}${outcome ? ` ${outcome}` : ""}${summary ? `: ${summary}` : ""}`, 200), ...(line.by.machine ? { machine: line.by.machine } : {}) };
}

export function buildHoldings(works: readonly WorkItem[], now: Date, self: Self | undefined): HoldingsView {
  const groups = new Map<string, HolderGroup>();
  for (const item of works) {
    if (!open(item) || !item.holder) continue;
    const { actor, until } = item.holder;
    const parts = actorParts(actor);
    const person = !actor.bot;
    const mine = person ? isSelfPerson(actor, self) : self?.machine !== undefined && parts.machine === self.machine;
    const log = item.log ?? [];
    const details = holdDetails(item, now) ?? { quiet: false };
    // A person's hold has no end (no stall timer); the far `until` it is written with is not shown.
    const expired = !person && until !== undefined && (ms(until) ?? Infinity) <= now.getTime();
    const held: HeldItem = {
      key: refKey(item.ref), label: refLabel(item.ref), title: item.title,
      ...(details.since ? { since: details.since } : {}), ...(until && !person ? { until } : {}), expired, quiet: details.quiet,
      ...(details.from ? { from: details.from } : {}),
    };
    const last = lastSession(log);
    if (last) held.last = last;
    const group = groups.get(actor.id) ?? { id: actor.id, who: parts.who, ...(parts.machine ? { machine: parts.machine } : {}), person, mine, items: [] };
    group.items.push(held);
    groups.set(actor.id, group);
  }
  const ordered = [...groups.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || Number(b.person) - Number(a.person) || a.id.localeCompare(b.id));
  return { now: now.toISOString(), ...(self ? { self } : {}), groups: ordered, machines: machines(works, now, self) };
}

/** Every machine that has written a line to an item's log, and when it last did. */
function machines(works: readonly WorkItem[], now: Date, self: Self | undefined): MachineView[] {
  const seen = new Map<string, MachineView>();
  for (const item of works) {
    for (const line of item.log ?? []) {
      const name = line.by.machine;
      if (!name) continue;
      const entry = seen.get(name) ?? { name, mine: self?.machine === name, lastAt: line.at, holding: 0 };
      if (line.at > entry.lastAt) entry.lastAt = line.at;
      seen.set(name, entry);
    }
  }
  for (const item of works) {
    const name = open(item) && item.holder ? actorParts(item.holder.actor).machine : undefined;
    const entry = name ? seen.get(name) : undefined;
    if (entry) entry.holding++;
  }
  return [...seen.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name)).map((entry) => ({ ...entry, quietFor: Math.max(0, now.getTime() - (ms(entry.lastAt) ?? now.getTime())) }));
}
