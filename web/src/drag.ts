// Moving cards on the board (#222): by dragging, or with Alt and the arrow keys. Where a card may go is what the Item page's State
// menu offers (`stateOptions`, #154): this maps the board's lanes onto its options, and a drop sends the option's steps with the
// same Undo wait. To do and Backlog have an order: a drop there also places the card right above another one (`/api/item/place`).
// A drag carries a list of cards, so moving several at once can come later. Pure (no DOM), so src/webDrag.test.ts can test it.

import type { CardView, LaneView } from "../../src/core/views.ts";
import { MERGE_LANE } from "./mergeLane.ts";
import type { StateKey, StateOption } from "./stateMenu.ts";

/** The lanes with an order a person sets (by a vote, or a drop at a place). */
export const ORDERED_LANES: readonly string[] = ["todo", "backlog"];

/** The State menu's option for a lane of the board (the merge queue's lane is Queued and Checking drawn as one). */
export function laneState(lane: string): StateKey | undefined {
  if (lane === MERGE_LANE || lane === "queued" || lane === "checking") return "merge-queue";
  const keys: readonly string[] = ["backlog", "blocked", "todo", "in-progress", "in-review", "done"];
  return keys.includes(lane) ? (lane as StateKey) : undefined;
}

/** What a drop on a lane does: nothing new (its own lane: only the place), the option's steps, or why it is refused. */
export type Verdict = { ok: true; option?: StateOption } | { ok: false; why: string };

/** The verdict for dropping on `lane`, from the State menu's options and the column the Item is in (`currentState`). */
export function dropVerdict(options: readonly StateOption[], current: StateKey, lane: string): Verdict {
  const target = laneState(lane);
  if (!target) return { ok: false, why: "not a lane a card goes to" };
  if (target === current || (current === "triage" && target === "todo")) return { ok: true };
  const option = options.find((each) => each.key === target);
  if (!option) return { ok: false, why: "not offered here" };
  if (option.why) return { ok: false, why: option.why };
  // Blocked asks which Item blocks it: that is picked on its page.
  if (option.steps.some((step) => step.kind === "block")) return { ok: false, why: "pick its blocker on its page" };
  return { ok: true, option };
}

/** Where among cards with these vertical middles a pointer at `y` goes: the index of the first card below it. */
export function insertionIndex(middles: readonly number[], y: number): number {
  const index = middles.findIndex((middle) => y < middle);
  return index < 0 ? middles.length : index;
}

/**
 * The card a drop at `index` of the lane's shown cards (without the dragged ones) lands right above, for `/api/item/place`: the
 * first one at or after it that is in the order (in To do the numbered ones), or null for last.
 */
/** Whether the card has a place in its lane's order: in To do the numbered ones (an umbrella or a person's Item is not planned). */
export const inOrder = (card: Pick<CardView, "position" | "lane">): boolean => card.lane !== "todo" || card.position !== undefined;

export function beforeKey(cards: readonly Pick<CardView, "key" | "position" | "lane">[], index: number): string | null {
  return cards.slice(index).find(inOrder)?.key ?? null;
}

/** A move waiting in the Undo wait that the board shows already: the card in `lane`, above `before` (null: last; absent: first). */
export interface Shown {
  key: string;
  lane: string;
  before?: string | null;
}

/**
 * The board's lanes as they will be once the moves waiting are sent: each card out of where it is and into its new lane and place,
 * so a drop settles at once and Undo puts it back. The merge queue's lane draws its own order, so a move there shows when it is sent.
 */
export function withShown(lanes: readonly LaneView[], shown: readonly Shown[]): LaneView[] {
  let result = lanes.map((lane) => ({ ...lane, cards: [...lane.cards] }));
  for (const move of shown) {
    const target = result.find((lane) => lane.lane === move.lane);
    const from = result.find((lane) => lane.cards.some((card) => card.key === move.key));
    const card = from?.cards.find((each) => each.key === move.key);
    if (!target || !from || !card) continue;
    result = result.map((lane) => (lane === from ? { ...lane, cards: lane.cards.filter((each) => each.key !== move.key), total: lane.total - 1 } : lane));
    const into = result.find((lane) => lane.lane === move.lane)!;
    const at = move.before === undefined ? 0 : move.before === null ? into.cards.length : Math.max(0, into.cards.findIndex((each) => each.key === move.before));
    const placed: CardView = from === target ? card : { ...card, lane: target.lane, position: undefined, why: undefined, voteOff: undefined };
    const cards = [...into.cards.slice(0, at), placed, ...into.cards.slice(at)];
    result = result.map((lane) => (lane === into ? { ...lane, cards, total: lane.total + 1 } : lane));
  }
  return result;
}

/** The toast's words for a move to a place: "A-2 → above A-5", "A-2 → last in To do". */
export function placeText(before: string | null, laneLabel: string): string {
  return before === null ? `last in ${laneLabel}` : `above ${before}`;
}

/**
 * Alt and an arrow key on a focused card: up and down move it one place in an ordered lane (the card it lands above, null for
 * last; undefined when it cannot move), left and right to the lane beside (undefined at the edge).
 */
export function keyMove(lanes: readonly { lane: string; cards: readonly Pick<CardView, "key" | "position" | "lane">[] }[], key: string, arrow: "up" | "down" | "left" | "right"): { lane: string; before?: string | null } | undefined {
  const at = lanes.findIndex((lane) => lane.cards.some((card) => card.key === key));
  const lane = lanes[at];
  if (!lane) return undefined;
  if (arrow === "left" || arrow === "right") {
    const next = lanes[at + (arrow === "left" ? -1 : 1)];
    return next ? { lane: next.lane } : undefined;
  }
  if (!ORDERED_LANES.includes(lane.lane)) return undefined;
  const cards = lane.cards;
  const index = cards.findIndex((card) => card.key === key);
  if (!inOrder(cards[index]!)) return undefined;
  const rest = cards.filter((card) => card.key !== key);
  if (arrow === "up") {
    if (index === 0) return undefined;
    return { lane: lane.lane, before: beforeKey(rest, index - 1) };
  }
  if (index >= cards.length - 1) return undefined;
  return { lane: lane.lane, before: beforeKey(rest, index + 1) };
}

/** The selected cards among the lanes' shown cards, in board order (lanes left to right, cards top to bottom). */
export function selectedInOrder(lanes: readonly { cards: readonly Pick<CardView, "key">[] }[], selected: readonly string[]): string[] {
  return lanes.flatMap((lane) => lane.cards.map((card) => card.key)).filter((key) => selected.includes(key));
}

/**
 * The cards from `anchor` to `key` in the lane that shows both (Shift+click); just `key` when they are not in one lane.
 */
export function rangeKeys(lanes: readonly { cards: readonly Pick<CardView, "key">[] }[], anchor: string | undefined, key: string): string[] {
  const lane = lanes.find((each) => each.cards.some((card) => card.key === key));
  if (!lane || anchor === undefined) return [key];
  const from = lane.cards.findIndex((card) => card.key === anchor);
  const to = lane.cards.findIndex((card) => card.key === key);
  if (from < 0) return [key];
  return lane.cards.slice(Math.min(from, to), Math.max(from, to) + 1).map((card) => card.key);
}

/** One card's move from Alt and an arrow key on a selection. */
export interface GroupMove {
  key: string;
  lane: string;
  before?: string | null;
}

/**
 * Alt and an arrow key with several cards selected: left and right take each to the lane beside it; up and down move the cards of
 * each ordered lane together, as one block, one place (above the card that was above the first one, or below the last one).
 * With one card selected it is `keyMove`.
 */
export function keyMoves(lanes: readonly { lane: string; cards: readonly Pick<CardView, "key" | "position" | "lane">[] }[], keys: readonly string[], arrow: "up" | "down" | "left" | "right"): GroupMove[] {
  if (keys.length === 1) {
    const move = keyMove(lanes, keys[0]!, arrow);
    return move ? [{ key: keys[0]!, ...move }] : [];
  }
  const moves: GroupMove[] = [];
  if (arrow === "left" || arrow === "right") {
    for (const key of keys) {
      const move = keyMove(lanes, key, arrow);
      if (move) moves.push({ key, ...move });
    }
    return moves;
  }
  for (const lane of lanes) {
    if (!ORDERED_LANES.includes(lane.lane)) continue;
    const mine = lane.cards.filter((card) => keys.includes(card.key) && inOrder(card));
    if (mine.length === 0) continue;
    const rest = lane.cards.filter((card) => !keys.includes(card.key));
    const first = lane.cards.findIndex((card) => card.key === mine[0]!.key);
    const last = lane.cards.findIndex((card) => card.key === mine[mine.length - 1]!.key);
    const restBefore = lane.cards.slice(0, last).filter((card) => !keys.includes(card.key)).length;
    let before: string | null;
    if (arrow === "up") {
      const above = lane.cards.slice(0, first).filter((card) => !keys.includes(card.key)).length;
      if (above === 0) continue;
      before = beforeKey(rest, above - 1);
    } else {
      if (restBefore >= rest.length) continue;
      before = beforeKey(rest, restBefore + 1);
    }
    for (const card of mine) moves.push({ key: card.key, lane: lane.lane, before });
  }
  return moves;
}
