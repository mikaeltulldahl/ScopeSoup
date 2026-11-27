// Moving cards on the board (web/src/drag.ts, #222): which lanes take a card (the State menu's options), where a drop lands in
// an ordered lane, the board as it shows a move that waits, and the Alt+arrow moves.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardView, LaneView } from "./core/views.ts";
import { beforeKey, dropVerdict, insertionIndex, keyMove, groupToast, keyMoves, laneState, placeText, stuckNote, rangeKeys, selectedInOrder, withShown } from "../web/src/drag.ts";
import type { MenuPage } from "../web/src/stateMenu.ts";
import { currentState, stateOptions } from "../web/src/stateMenu.ts";
import { THEMES } from "../web/src/theme.ts";

const theme = THEMES.default.words;
const page = (fields: Partial<MenuPage> = {}, item: Partial<MenuPage["item"]> = {}): MenuPage => ({
  lane: "todo",
  canEdit: true,
  hold: { claim: {} },
  moves: { triage: { why: "in line for triage already" }, "in-review": { why: "nothing to review yet" }, "merge-queue": { why: "not reviewed yet" } },
  sessions: { live: [] },
  ...fields,
  item: { state: "todo", label: "A-2", ...item },
});
const verdict = (menu: MenuPage, lane: string) => dropVerdict(stateOptions(menu, theme), currentState(menu), lane);

test("drag: a lane takes the card when the State menu offers it, with the same steps", () => {
  const backlog = page({ lane: "backlog" });
  assert.deepEqual(verdict(backlog, "todo"), { ok: true, option: stateOptions(backlog, theme).find((option) => option.key === "todo") });
  const toTodo = verdict(backlog, "todo");
  assert.ok(toTodo.ok && toTodo.option);
  assert.deepEqual(toTodo.option.steps, [{ kind: "lane", lane: "todo" }]);
  // Its own lane: only the place changes.
  assert.deepEqual(verdict(backlog, "backlog"), { ok: true });
  // In progress is a claim; Done the state edit.
  const claim = verdict(page(), "in-progress");
  assert.ok(claim.ok && claim.option);
  assert.deepEqual(claim.option.steps, [{ kind: "claim" }]);
});

test("drag: a lane that does not take the card says why, as the State menu does", () => {
  assert.deepEqual(verdict(page(), "in-review"), { ok: false, why: "nothing to review yet" });
  assert.deepEqual(verdict(page({ canEdit: false }), "done"), { ok: false, why: "can't be changed here" });
  // Blocked asks for the blocker: that is picked on the Item page.
  assert.deepEqual(verdict(page(), "blocked"), { ok: false, why: "pick its blocker on its page" });
  // Below level 4 the merge queue is not offered.
  assert.deepEqual(verdict(page({ moves: { triage: {}, "in-review": { why: "x" } } }), "merge-queue"), { ok: false, why: "not offered here" });
});

test("drag: the board's lanes map onto the menu's states; the merge queue's lane is one", () => {
  assert.equal(laneState("queued"), "merge-queue");
  assert.equal(laneState("checking"), "merge-queue");
  assert.equal(laneState("merge-queue"), "merge-queue");
  assert.equal(laneState("todo"), "todo");
  assert.equal(laneState("your-turn"), undefined);
});

const card = (key: string, lane: CardView["lane"] = "todo", position?: number): CardView => ({ key, label: key, lane, ...(position !== undefined ? { position } : {}) }) as CardView;

test("drag: a drop lands above the card under the pointer, skipping cards outside To do's order", () => {
  assert.equal(insertionIndex([10, 30, 50], 5), 0);
  assert.equal(insertionIndex([10, 30, 50], 31), 2);
  assert.equal(insertionIndex([10, 30, 50], 99), 3);
  const todo = [card("a", "todo", 1), card("umbrella"), card("b", "todo", 2)];
  assert.equal(beforeKey(todo, 0), "a");
  assert.equal(beforeKey(todo, 1), "b");
  assert.equal(beforeKey(todo, 3), null);
  assert.equal(beforeKey([card("x", "backlog")], 0), "x");
  assert.equal(placeText(null, "To do"), "last in To do");
  assert.equal(placeText("A-5", "To do"), "above A-5");
});

const lane = (name: CardView["lane"], cards: CardView[]): LaneView => ({ lane: name, title: name, total: cards.length, cards });

test("drag: a move that waits shows on the board already, and nothing else moves", () => {
  const lanes = [lane("backlog", [card("x", "backlog"), card("y", "backlog")]), lane("todo", [card("a", "todo", 1), card("b", "todo", 2)])];
  const moved = withShown(lanes, [{ key: "y", lane: "todo", before: "a" }]);
  assert.deepEqual(moved.map((each) => each.cards.map((one) => one.key)), [["x"], ["y", "a", "b"]]);
  assert.deepEqual(moved.map((each) => each.total), [1, 3]);
  assert.equal(moved[1]!.cards[0]!.lane, "todo");
  assert.equal(moved[1]!.cards[0]!.position, undefined);
  // Within a lane, last; to a lane without an order, first.
  assert.deepEqual(withShown(lanes, [{ key: "a", lane: "todo", before: null }])[1]!.cards.map((one) => one.key), ["b", "a"]);
  assert.deepEqual(withShown([...lanes, lane("done", [card("d", "done")])], [{ key: "a", lane: "done" }])[2]!.cards.map((one) => one.key), ["a", "d"]);
  // A lane the board does not draw this way (the merge queue's): nothing changes until it is sent.
  assert.deepEqual(withShown(lanes, [{ key: "a", lane: "merge-queue" }]), lanes);
  assert.equal(lanes[0]!.cards.length, 2, "the board it was given stays as it was");
});

test("drag: Alt and the arrow keys move a card one place in its lane, or to the lane beside", () => {
  const lanes = [lane("backlog", [card("x", "backlog")]), lane("todo", [card("a", "todo", 1), card("b", "todo", 2), card("c", "todo", 3)]), lane("in-progress", [])];
  assert.deepEqual(keyMove(lanes, "b", "up"), { lane: "todo", before: "a" });
  assert.deepEqual(keyMove(lanes, "b", "down"), { lane: "todo", before: null });
  assert.deepEqual(keyMove(lanes, "a", "down"), { lane: "todo", before: "c" });
  assert.equal(keyMove(lanes, "a", "up"), undefined);
  assert.equal(keyMove(lanes, "c", "down"), undefined);
  assert.deepEqual(keyMove(lanes, "a", "left"), { lane: "backlog" });
  assert.deepEqual(keyMove(lanes, "a", "right"), { lane: "in-progress" });
  assert.equal(keyMove(lanes, "x", "left"), undefined);
  // An umbrella in To do has no number: it has no place to move to.
  assert.equal(keyMove([lane("todo", [card("a", "todo", 1), card("u", "todo")])], "u", "up"), undefined);
  // A lane without an order: no up or down.
  assert.equal(keyMove([lane("in-progress", [card("p", "in-progress"), card("q", "in-progress")])], "q", "up"), undefined);
});

test("multi-select: the selection in board order, and Shift+click's range within one lane", () => {
  const lanes = [lane("backlog", [card("x", "backlog"), card("y", "backlog"), card("z", "backlog")]), lane("todo", [card("a", "todo", 1), card("b", "todo", 2)])];
  assert.deepEqual(selectedInOrder(lanes, ["b", "z", "x"]), ["x", "z", "b"]);
  assert.deepEqual(rangeKeys(lanes, "z", "x"), ["x", "y", "z"]);
  assert.deepEqual(rangeKeys(lanes, undefined, "y"), ["y"]);
  // The anchor is in another lane: just the card.
  assert.deepEqual(rangeKeys(lanes, "x", "b"), ["b"]);
});

test("multi-select: cards moved together land in their order above the same card", () => {
  const lanes = [lane("backlog", [card("x", "backlog"), card("y", "backlog"), card("z", "backlog")]), lane("todo", [card("a", "todo", 1), card("b", "todo", 2)])];
  const above = withShown(lanes, [{ key: "x", lane: "todo", before: "b" }, { key: "z", lane: "todo", before: "b" }]);
  assert.deepEqual(above.map((each) => each.cards.map((one) => one.key)), [["y"], ["a", "x", "z", "b"]]);
  const last = withShown(lanes, [{ key: "x", lane: "todo", before: null }, { key: "z", lane: "todo", before: null }]);
  assert.deepEqual(last[1]!.cards.map((one) => one.key), ["a", "b", "x", "z"]);
});

test("multi-select: Alt and the arrow keys move the selection together", () => {
  const lanes = [lane("backlog", [card("x", "backlog")]), lane("todo", [card("a", "todo", 1), card("b", "todo", 2), card("c", "todo", 3), card("d", "todo", 4)]), lane("in-progress", [])];
  assert.deepEqual(keyMoves(lanes, ["b"], "up"), [{ key: "b", lane: "todo", before: "a" }]);
  // Up: the block goes above the card that was above the first; at the top nothing moves.
  assert.deepEqual(keyMoves(lanes, ["b", "c"], "up"), [{ key: "b", lane: "todo", before: "a" }, { key: "c", lane: "todo", before: "a" }]);
  assert.deepEqual(keyMoves(lanes, ["a", "b"], "up"), []);
  // Down: below the card after the last one.
  assert.deepEqual(keyMoves(lanes, ["a", "b"], "down"), [{ key: "a", lane: "todo", before: "d" }, { key: "b", lane: "todo", before: "d" }]);
  assert.deepEqual(keyMoves(lanes, ["c", "d"], "down"), []);
  assert.deepEqual(keyMoves(lanes, ["b", "c"], "down"), [{ key: "b", lane: "todo", before: null }, { key: "c", lane: "todo", before: null }]);
  // Left and right: each to the lane beside its own; one at the edge stays.
  assert.deepEqual(keyMoves(lanes, ["x", "a"], "left"), [{ key: "a", lane: "backlog" }]);
  assert.deepEqual(keyMoves(lanes, ["x", "a"], "right"), [{ key: "x", lane: "todo" }, { key: "a", lane: "in-progress" }]);
});

test("multi-select: queued back to front, each above the one after it, the cards keep their order", () => {
  const lanes = [lane("backlog", [card("x", "backlog"), card("y", "backlog"), card("z", "backlog")]), lane("todo", [card("a", "todo", 1), card("b", "todo", 2)])];
  const chained = withShown(lanes, [{ key: "z", lane: "todo", before: "b" }, { key: "y", lane: "todo", before: "z" }, { key: "x", lane: "todo", before: "y" }]);
  assert.deepEqual(chained[1]!.cards.map((one) => one.key), ["a", "x", "y", "z", "b"]);
});

test("multi-select: one toast says who moved, where, and which stayed and why", () => {
  const stay = { label: "#44", why: "pick its blocker on its page", text: "#44 can't go to To do: pick its blocker on its page." };
  // Some move, some stay.
  assert.equal(groupToast(["#84", "#85"], [stay], "To do", "above #52"), "#84, #85 → To do · above #52 · #44 stayed: pick its blocker on its page");
  assert.equal(groupToast(["#84", "#85"], [stay, { ...stay, label: "#47", why: "not offered here" }], "In progress", ""), "#84, #85 → In progress · #44 stayed: pick its blocker on its page; #47 stayed: not offered here");
  // Many moved are counted; all moved has no stay part.
  assert.equal(groupToast(["#1", "#2", "#3", "#4"], [], "To do", "last in To do"), "4 cards → To do · last in To do");
  // None moved: a lone card keeps its own sentence.
  assert.equal(groupToast([], [stay], "To do", ""), stay.text);
  assert.equal(groupToast([], [stay, { ...stay, label: "#47", why: "x" }], "To do", ""), "None moved to To do. #44 stayed: pick its blocker on its page; #47 stayed: x.");
});

test("drag: a move the server took but the Item's page does not show is said, not left looking moved", () => {
  const names = (lane: string) => ({ "in-review": "In review", todo: "To do" })[lane] ?? lane;
  assert.equal(stuckNote("#63", "todo", "in-review", names), "#63 is still in In review, not To do: the server took the move, but the Item's page does not put it there.");
  assert.equal(stuckNote("#63", "todo", "todo", names), undefined);
  // The merge queue's lane is drawn from two lanes: not compared.
  assert.equal(stuckNote("#63", "merge-queue", "queued", names), undefined);
});
