// Who holds an item: a hold's details (since when, from where, quiet) and which person is this board's own.
// Pure.

import type { Actor, WorkItem } from "../model/types.ts";
import { ms } from "./snapshot.ts";

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
