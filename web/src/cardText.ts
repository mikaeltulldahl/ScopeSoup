// A card's one line of text on the board: short, and nothing the lane already says. The Item page keeps the long reason.

import type { CardView } from "../../src/core/views.ts";

export type CardText = { kind: "none" } | { kind: "text"; text: string } | { kind: "held"; name: string; mine: boolean };

/**
 * - A person's turn (theirs or anyone's): what waits, as in Your turn ("2 questions", "a draft to accept").
 * - Held by a person: "held by @name", the name as a mention, marked when it is the person viewing (`viewer`).
 * - Queued, waiting its turn: nothing (the lane says it). A blocked queued card ("cannot merge") keeps its reason.
 * - Done: nothing, unless the item is not closed on the host yet.
 */
export function cardText(card: Pick<CardView, "lane" | "tone" | "actor" | "reason" | "waits" | "heldBy" | "person">, viewer: string): CardText {
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
