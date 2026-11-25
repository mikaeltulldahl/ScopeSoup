// The Item page's State menu (#154): the board's columns plus Triage and Abandoned, each with what picking it sends and why it
// cannot be picked now; and the Undo wait before anything is sent. The rules of what may be done stay on the server (the hold
// buttons' `why`, `page.moves`); this only puts them in the order of the columns and words them in the theme.
// Pure (no DOM), so src/webStateMenu.test.ts can test it without a browser.

import type { ItemPage } from "../../src/core/views.ts";
import type { ThemeWords } from "./theme.ts";
import { fill } from "./theme.ts";

export const STATE_KEYS = ["triage", "blocked", "backlog", "in-progress", "in-review", "merge-queue", "done", "abandoned"] as const;
export type StateKey = (typeof STATE_KEYS)[number];

/** One call the pick sends, in order. `block` adds the blocker the person picks. */
export type Step =
  | { kind: "release" }
  | { kind: "claim" }
  | { kind: "state"; state: "todo" | "done" | "abandoned" }
  | { kind: "move"; to: "triage" | "backlog" | "in-review" | "merge-queue" }
  | { kind: "block" };

export interface StateOption {
  key: StateKey;
  label: string;
  /** Why it cannot be picked now; absent when it can. */
  why?: string;
  steps: Step[];
}

/** What the menu reads of the Item page. */
export type MenuPage = Pick<ItemPage, "lane" | "hold" | "moves" | "canEdit"> & {
  item: Pick<ItemPage["item"], "state" | "holder" | "label">;
  sessions: { live: Pick<ItemPage["sessions"]["live"][number], "role" | "chat">[] };
};

export const stateLabel = (key: StateKey, theme: ThemeWords): string =>
  key === "triage" ? theme.triageState : key === "abandoned" ? theme.abandoned : key === "merge-queue" ? theme.mergeLane : theme.lanes[key];

/** The running step session on the Item here, if any (a chat turn is not one). */
const liveStep = (page: MenuPage) => page.sessions.live.find((session) => !session.chat);

/** The column the Item is in: Your turn is not a state, so an Item there shows the column under it. */
export function currentState(page: MenuPage): StateKey {
  if (page.item.state === "abandoned" || page.lane === null) return "abandoned";
  if (page.lane === "queued" || page.lane === "checking") return "merge-queue";
  if (liveStep(page)?.role === "triage") return "triage";
  return page.lane;
}

/** A person other than the board's one holds the Item: their name. */
function otherPerson(page: MenuPage): string | undefined {
  const holder = page.item.holder;
  return holder && !holder.actor.bot && page.hold?.release && !page.hold.handBack ? holder.actor.name : undefined;
}

const NO_AGENTS = "no agents run here";
const NO_EDIT = "can't be changed here";

/** Every option, in the board's order, with its steps and why not. The current one is in the list too (shown selected). */
export function stateOptions(page: MenuPage, theme: ThemeWords): StateOption[] {
  const closed = page.item.state === "done" || page.item.state === "abandoned";
  const moves = page.moves;
  const hold = page.hold;
  const other = otherPerson(page);
  // A person's hold goes first when the pick moves the Item on (anyone may release anyone's hold).
  const releasing: Step[] = other && hold?.release && hold.release.why === undefined ? [{ kind: "release" }] : [];
  const move = (to: "triage" | "in-review" | "merge-queue"): Pick<StateOption, "why" | "steps"> => {
    const said = moves?.[to];
    if (!moves || !said) return { why: NO_AGENTS, steps: [] };
    return said.why ? { why: said.why, steps: [] } : { steps: [{ kind: "move", to }] };
  };
  const edit = (state: "todo" | "done" | "abandoned", before: Step[] = []): Pick<StateOption, "why" | "steps"> => (page.canEdit ? { steps: [...before, { kind: "state", state }] } : { why: NO_EDIT, steps: [] });

  const backlog = ((): Pick<StateOption, "why" | "steps"> => {
    if (closed) return edit("todo");
    const drop = moves?.backlog;
    if (drop?.why) return { why: drop.why, steps: [] };
    const steps: Step[] = [...releasing, ...(drop ? [{ kind: "move" as const, to: "backlog" as const }] : [])];
    if (other && releasing.length === 0) return { why: hold?.release?.why ?? NO_EDIT, steps: [] };
    if (page.item.state === "doing" && !page.item.holder) return edit("todo", steps);
    if (steps.length > 0) return { steps };
    if (page.lane === "blocked") return { why: "remove its blockers in Edit", steps: [] };
    return { why: "in the backlog already", steps: [] };
  })();

  const inProgress = ((): Pick<StateOption, "why" | "steps"> => {
    if (hold?.handBack) return { why: "yours already", steps: [] };
    // Taking over from another person: release, then claim (people are equals). An agent's hold is refused by the claim rules.
    if (other && releasing.length > 0) return { steps: [...releasing, { kind: "claim" }] };
    if (!hold?.claim) return { why: closed ? "reopen it first" : NO_EDIT, steps: [] };
    return hold.claim.why ? { why: hold.claim.why, steps: [] } : { steps: [{ kind: "claim" }] };
  })();

  const options: Record<StateKey, Pick<StateOption, "why" | "steps">> = {
    triage: move("triage"),
    blocked: closed ? { why: "reopen it first", steps: [] } : page.canEdit ? { steps: [{ kind: "block" }] } : { why: NO_EDIT, steps: [] },
    backlog,
    "in-progress": inProgress,
    "in-review": move("in-review"),
    "merge-queue": move("merge-queue"),
    done: edit("done", releasing),
    abandoned: edit("abandoned", releasing),
  };
  return STATE_KEYS.map((key) => ({ key, label: stateLabel(key, theme), ...options[key] }));
}

/**
 * What the pick does to work under way, for the toast, in a few words; "" for nothing. Scope Soup stops no running session
 * (`sessionRunning` in the server, the claim rules): an Item made done or abandoned lets its session finish its step and then
 * closes the job; on another machine that machine sees the change at its next fetch of the meta branch and does the same.
 */
export function effectNote(key: StateKey, page: MenuPage, theme: ThemeWords): string {
  const notes: string[] = [];
  const other = otherPerson(page);
  const steps = stateOptions(page, theme).find((option) => option.key === key)?.steps ?? [];
  if (other && steps.some((step) => step.kind === "release")) notes.push(key === "in-progress" ? `takes over from ${other}` : `releases ${other}'s hold`);
  const ending = key === "done" || key === "abandoned";
  const session = liveStep(page);
  const holder = page.item.holder;
  const elsewhere = !session && holder?.actor.bot ? holder.actor.name : undefined;
  const role = session ? theme.roles[session.role === "triage" ? "triage" : session.role === "review" ? "review" : "implement"] : undefined;
  if (role || elsewhere) {
    const who = role ? `the ${role}` : `the agent on ${elsewhere}`;
    if (ending) notes.push(`stops after ${who}`);
    else if (key === "blocked") notes.push(`${who} goes on`);
  } else if (ending && page.lane === "queued") notes.push(`leaves the ${theme.roles.queue}`);
  else if (ending && page.lane === "checking") notes.push(`stops after the ${theme.roles.queue}'s check`);
  return notes.join(" · ");
}

/** The toast's text before its Undo: "A-2 → Backlog · releases Ana's hold". */
export function toastText(id: string, key: StateKey, note: string, theme: ThemeWords): string {
  const head = fill(key === "abandoned" ? theme.abandonToast : theme.moveToast, { id, state: stateLabel(key, theme) });
  return note ? `${head} · ${note}` : head;
}

/** The Item's blockers as ids after adding `added` (a ref key or an id), for the Edit endpoint's `blockedBy`. */
export function withBlocker(existing: readonly string[], added: string): string[] {
  const id = (key: string): string => (key.split(":").length >= 3 ? key.split(":").slice(2).join(":") : key);
  const ids = existing.map(id);
  return ids.includes(id(added)) ? ids : [...ids, id(added)];
}

// --- The Undo wait ---

/** A pick waiting to be sent. */
export interface Pending {
  id: number;
  /** When it is sent (milliseconds). */
  at: number;
  text: string;
}

export const UNDO_MS = 5000;

/** Adds a pick that is sent `UNDO_MS` from `now`. */
export const addPending = <T extends Pending>(list: readonly T[], entry: Omit<T, "at">, now: number): T[] => [...list, { ...entry, at: now + UNDO_MS } as T];

/** Undo: the pick goes, nothing is sent. */
export const cancelPending = <T extends Pending>(list: readonly T[], id: number): T[] => list.filter((entry) => entry.id !== id);

/** The picks due at `now`, to send, and the rest. */
export function duePending<T extends Pending>(list: readonly T[], now: number): { due: T[]; rest: T[] } {
  return { due: list.filter((entry) => entry.at <= now), rest: list.filter((entry) => entry.at > now) };
}
