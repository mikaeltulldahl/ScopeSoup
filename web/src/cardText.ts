// A card's one line of text on the board: short, and nothing the lane already says. The Item page's status line says the
// same; the page keeps the long reason next to what it is about.

import type { CardView, SessionView } from "../../src/core/views.ts";

export type CardText = { kind: "none" } | { kind: "text"; text: string } | { kind: "held"; name: string; mine: boolean };

/**
 * - A person's turn (theirs or anyone's): what waits, as in Your turn ("2 questions", "a draft to accept").
 * - Held by a person: "held by @name", the name as a mention, marked when it is the person viewing (`viewer`).
 * - Queued, waiting its turn: nothing (the lane says it). A blocked queued card ("cannot merge") keeps its reason.
 * - Done: nothing, unless the item is not closed on the host yet.
 */
type Texted = Pick<CardView, "tone" | "actor" | "reason" | "waits" | "heldBy" | "person"> & { lane: CardView["lane"] | null };

export function cardText(card: Texted, viewer: string): CardText {
  const personal = card.actor === "person" || card.actor === "anyone";
  const text = personal && card.waits ? card.waits : card.reason;
  if (card.heldBy && text === `held by ${card.heldBy}`) return { kind: "held", name: card.heldBy, mine: heldByViewer(card, viewer) };
  if (personal && card.waits) return { kind: "text", text };
  if (card.lane === "queued" && card.tone !== "blocked") return { kind: "none" };
  if (card.lane === "done" && card.reason === "done") return { kind: "none" };
  return { kind: "text", text };
}

/** The holder is the person viewing: the server says so when it is their turn; otherwise the picked name decides. */
export function heldByViewer(card: Pick<CardView, "heldBy" | "person">, viewer: string): boolean {
  if (card.person && card.person.name === card.heldBy) return card.person.mine;
  return viewer !== "" && viewer === card.heldBy;
}

export type StatusText = CardText | { kind: "wait"; resource: string; since: string };

/**
 * The Item page's status line: the card's text, or the whole reason where the card says nothing (the lane's words are not on
 * the page's tag row twice). A wait for a unit of a resource is the line only while it is why the Item is stuck: not while it
 * is a person's turn or a person holds it.
 */
export function statusText(page: Texted, viewer: string, waits: readonly { name: string; since: string }[] = []): StatusText {
  const wait = waits[0];
  if (wait && page.actor !== "person" && page.actor !== "anyone" && !page.heldBy) return { kind: "wait", resource: wait.name, since: wait.since };
  const text = cardText(page, viewer);
  return text.kind === "none" ? { kind: "text", text: page.reason } : text;
}

/** A backlog place as the score explains it ("2nd: major bug; behind #12 because …") split into the place and the why. */
export function placeText(why: string): { place: string; why: string } {
  const match = /^(\d+(?:st|nd|rd|th))(?::\s*)?(.*)$/s.exec(why);
  return match ? { place: match[1]!, why: match[2]! } : { place: "", why };
}

/** A card's session tag: only while the session runs or is stalled; a finished one says nothing the lane does not. */
export function sessionShown(session: Pick<SessionView, "live" | "status">): boolean {
  return session.live || session.status === "stalled";
}
