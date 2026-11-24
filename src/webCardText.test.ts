// A card's short text on the board (web/src/cardText.ts): what waits on a person, "held by @name", and nothing that repeats
// the lane. All names are synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardView } from "./core/views.ts";
import { cardText } from "../web/src/cardText.ts";

type Card = Pick<CardView, "lane" | "tone" | "actor" | "reason" | "waits" | "heldBy" | "person">;
const card = (fields: Partial<Card>): Card => ({ lane: "backlog", tone: "waiting", actor: "agent", reason: "ready; waiting for a free agent slot", ...fields });

test("a person's turn shows what waits, not the question", () => {
  const asked = card({ actor: "anyone", tone: "yours", reason: "Answer the question: Triage, round 1: which harbour?", waits: "1 question" });
  assert.deepEqual(cardText(asked, ""), { kind: "text", text: "1 question" });
  const draft = card({ actor: "person", person: { name: "mira", mine: false }, tone: "waiting", reason: "Answer 0 of 2 questions: x", waits: "a draft to accept" });
  assert.deepEqual(cardText(draft, "olle"), { kind: "text", text: "a draft to accept" });
});

test("an agent's turn keeps its reason", () => {
  assert.deepEqual(cardText(card({}), ""), { kind: "text", text: "ready; waiting for a free agent slot" });
});

test("held by a person: the name as a mention, marked for the viewer", () => {
  const held = (mine: boolean) =>
    card({ actor: "person", person: { name: "mira", mine }, tone: mine ? "yours" : "waiting", heldBy: "mira", waits: "held by mira", reason: "held by mira on demo; Scope Soup leaves it alone until they hand it back or release it" });
  assert.deepEqual(cardText(held(true), "mira"), { kind: "held", name: "mira", mine: true });
  assert.deepEqual(cardText(held(false), "olle"), { kind: "held", name: "mira", mine: false });
});

test("queued cards waiting their turn show nothing; a blocked one keeps its reason", () => {
  assert.deepEqual(cardText(card({ lane: "queued", actor: "queue", reason: "approved; waiting in the queue (position 1 of 7)" }), ""), { kind: "none" });
  const stuck = card({ lane: "queued", actor: "agent", tone: "blocked", reason: "approved, but it cannot merge; the branch needs a rebase on main" });
  assert.deepEqual(cardText(stuck, ""), { kind: "text", text: stuck.reason });
});

test("done cards show nothing, unless the host has not closed the item yet", () => {
  assert.deepEqual(cardText(card({ lane: "done", actor: "nobody", tone: "done", reason: "done" }), ""), { kind: "none" });
  const open = card({ lane: "done", actor: "nobody", tone: "done", reason: "its change is merged; waiting for the host to close the item" });
  assert.deepEqual(cardText(open, ""), { kind: "text", text: open.reason });
});
