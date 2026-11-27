// The Item page's State menu (web/src/stateMenu.ts, #154): which options there are per situation, what each sends, why one is
// off, the toast's words in each theme, and the Undo wait.

import assert from "node:assert/strict";
import { test } from "node:test";
import { THEMES } from "../web/src/theme.ts";
import type { MenuPage, Pending, StateKey } from "../web/src/stateMenu.ts";
import { addPending, cancelPending, currentState, duePending, effectNote, implementAnyway, implementToast, requestNote, stateOptions, STATE_KEYS, toastText, UNDO_MS, withBlocker } from "../web/src/stateMenu.ts";

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
const byKey = (menu: MenuPage) => Object.fromEntries(stateOptions(menu, theme).map((option) => [option.key, option])) as Record<StateKey, ReturnType<typeof stateOptions>[number]>;

test("the options are the board's columns plus Triage and Abandoned, in that order, in the theme's words", () => {
  assert.deepEqual(stateOptions(page(), theme).map((option) => option.label), ["Triage", "Backlog", "Blocked", "To do", "In progress", "In review", "Merge queue", "Done", "Abandoned"]);
  assert.deepEqual(stateOptions(page(), THEMES.graveyard.words).map((option) => option.label), ["Line-up", "Tip-offs", "Stakeout", "At large", "On the case", "Cross-examination", "Crime lab", "Laid to rest", "Cold case"]);
  assert.equal(STATE_KEYS.length, 9);
});

test("the current option: the lane under Your turn, the merge queue for Queued and Checking, Abandoned with no lane, Triage while one runs", () => {
  assert.equal(currentState(page({ lane: "in-review" })), "in-review");
  assert.equal(currentState(page({ lane: "checking" })), "merge-queue");
  assert.equal(currentState(page({ lane: null }, { state: "abandoned" })), "abandoned");
  assert.equal(currentState(page({ sessions: { live: [{ role: "triage" }] } })), "triage");
  assert.equal(currentState(page({ sessions: { live: [{ role: "triage", chat: true }] } })), "todo");
});

test("a waiting Item: claim for In progress, the state edit for Done and Abandoned, the server's why on the agents' moves", () => {
  const menu = byKey(page());
  assert.deepEqual(menu["in-progress"].steps, [{ kind: "claim" }]);
  assert.deepEqual(menu.done.steps, [{ kind: "state", state: "done" }]);
  assert.deepEqual(menu.abandoned.steps, [{ kind: "state", state: "abandoned" }]);
  assert.deepEqual(menu.blocked.steps, [{ kind: "block" }]);
  assert.equal(menu["in-review"].why, "nothing to review yet");
  assert.equal(menu.triage.why, "in line for triage already");
  assert.equal(menu.todo.why, "in To do already");
  assert.deepEqual(menu.backlog.steps, [{ kind: "lane", lane: "backlog" }]);
  // Without Scope Soup's agents on this server the moves are off, and a read-only host offers no edit.
  const bare = byKey(page({ moves: undefined, canEdit: false, hold: undefined }));
  assert.equal(bare.triage.why, "no agents run here");
  assert.equal(bare.done.why, "can't be changed here");
  assert.equal(bare["in-progress"].why, "can't be changed here");
});

test("work under way: To do drops it, Backlog drops it too, In review starts the review, a running agent's claim rule says why", () => {
  const menu = byKey(page({ lane: "in-progress", moves: { triage: {}, todo: {}, "in-review": {}, "merge-queue": { why: "not reviewed yet" } } }));
  assert.deepEqual(menu.todo.steps, [{ kind: "move", to: "todo" }]);
  assert.deepEqual(menu.backlog.steps, [{ kind: "move", to: "todo" }, { kind: "lane", lane: "backlog" }]);
  assert.deepEqual(menu["in-review"].steps, [{ kind: "move", to: "in-review" }]);
  assert.deepEqual(menu.triage.steps, [{ kind: "move", to: "triage" }]);
  const running = byKey(page({ hold: { claim: { why: "A-2 has its implement session running now." } }, sessions: { live: [{ role: "implement" }] } }));
  assert.equal(running["in-progress"].why, "A-2 has its implement session running now.");
});

test("another person's hold: To do, Done and Abandoned release it first, In progress takes over (release, then claim)", () => {
  const held = page({ hold: { claim: { why: "held by Ana" }, release: {} } }, { holder: { actor: { id: "ana", name: "Ana" } } });
  const menu = byKey(held);
  assert.deepEqual(menu.todo.steps, [{ kind: "release" }]);
  assert.deepEqual(menu.done.steps, [{ kind: "release" }, { kind: "state", state: "done" }]);
  assert.deepEqual(menu["in-progress"].steps, [{ kind: "release" }, { kind: "claim" }]);
  assert.equal(effectNote("in-progress", held, theme), "takes over from Ana");
  assert.equal(effectNote("todo", held, theme), "releases Ana's hold");
  // The board's own person holds it: In progress is theirs already, Hand back is on the hold row.
  assert.equal(byKey(page({ hold: { handBack: {}, release: {} } }, { holder: { actor: { id: "mira", name: "mira" } } }))["in-progress"].why, "yours already");
});

test("done or abandoned: To do or Backlog reopens it with the state edit and the lane; the agents' moves wait for that", () => {
  const menu = byKey(page({ lane: null, hold: undefined, moves: { triage: { why: "reopen it first" } } }, { state: "abandoned" }));
  assert.deepEqual(menu.todo.steps, [{ kind: "state", state: "todo" }, { kind: "lane", lane: "todo" }]);
  assert.deepEqual(menu.backlog.steps, [{ kind: "state", state: "todo" }, { kind: "lane", lane: "backlog" }]);
  assert.equal(menu.blocked.why, "reopen it first");
  assert.equal(menu["in-progress"].why, "reopen it first");
});

test("the toast: the theme's words, and what the pick does to work under way", () => {
  assert.equal(toastText("A-2", "backlog", "", theme), "A-2 → Backlog");
  assert.equal(toastText("A-2", "abandoned", "", THEMES.graveyard.words), "Murdered A-2");
  const running = page({ sessions: { live: [{ role: "implement" }] } });
  // A pick that replaces the step that runs ends its session at once (decision 104); Done lets it finish.
  for (const key of ["abandoned", "backlog", "triage", "in-review", "merge-queue"] as const) assert.equal(effectNote(key, running, theme), "interrupts the implementor", key);
  assert.equal(effectNote("abandoned", running, THEMES.graveyard.words), "interrupts the detective");
  assert.equal(effectNote("done", running, theme), "stops after the implementor");
  assert.equal(effectNote("blocked", running, theme), "the implementor goes on");
  // The work runs on another machine: the pick goes there, at its next fetch.
  const elsewhere = page({ remote: { machine: "laptop-b" } }, { holder: { actor: { id: "scopesoup@laptop-b", name: "scopesoup on laptop-b", bot: true } } });
  assert.equal(effectNote("todo", elsewhere, theme), "interrupts the implementor on laptop-b, within a minute");
  assert.equal(effectNote("done", elsewhere, theme), "stops after the implementor on laptop-b");
  assert.equal(effectNote("abandoned", page({ lane: "in-review", remote: { machine: "laptop-b" } }), theme), "interrupts the reviewer on laptop-b, within a minute");
  assert.equal(effectNote("abandoned", page({ lane: "queued" }), theme), "leaves the merge queue");
  assert.equal(toastText("A-2", "done", effectNote("done", page({ lane: "checking" }), theme), theme), "A-2 → Done · stops after the merge queue's check");
  assert.equal(effectNote("done", page(), theme), "");
});

test("a pick requested of another machine: waiting, refused, or lapsed, for an hour; done says nothing", () => {
  const at = Date.parse("2026-11-25T10:00:00Z");
  const asked = (state: "pending" | "done" | "refused" | "lapsed", why?: string) => page({ remote: { machine: "laptop-b", request: { who: "mira", at: "2026-11-25T10:00:00Z", for: "laptop-b", steps: [{ kind: "move", to: "todo" }], state, ...(why ? { why } : {}) } } });
  assert.equal(requestNote(asked("pending"), theme, at), "mira's To do waits for laptop-b (at its next fetch, within a minute)");
  assert.equal(requestNote(asked("refused", "A-2 changed meanwhile: look again and pick again."), theme, at), "laptop-b refused mira's To do: A-2 changed meanwhile: look again and pick again.");
  assert.equal(requestNote(asked("lapsed"), theme, at + 20 * 60_000), "laptop-b did not answer mira's To do within 15 minutes; it is not carried out");
  assert.equal(requestNote(asked("done"), theme, at), "");
  assert.equal(requestNote(asked("refused", "x"), theme, at + 2 * 60 * 60_000), "");
});

test("a new blocker is added to the ones there, as ids", () => {
  assert.deepEqual(withBlocker(["metaBranch:work:A-1"], "metaBranch:work:A-3"), ["A-1", "A-3"]);
  assert.deepEqual(withBlocker(["metaBranch:work:A-1"], "metaBranch:work:A-1"), ["A-1"]);
});

test("the Undo wait: due after about 5 s, Undo takes it out unsent, each pick on its own timer", () => {
  let list = addPending<Pending>([], { id: 1, text: "A-2 → Done" }, 1000);
  list = addPending(list, { id: 2, text: "A-3 → Backlog" }, 3000);
  assert.equal(list[0]!.at, 1000 + UNDO_MS);
  assert.deepEqual(duePending(list, 5999).due, []);
  const first = duePending(list, 6000);
  assert.deepEqual([first.due.map((each) => each.id), first.rest.map((each) => each.id)], [[1], [2]]);
  list = cancelPending(first.rest, 2);
  assert.deepEqual(duePending(list, 99_999).due, []);
});

test("below level 4 the server offers no Merge queue, and the menu leaves it out, unless the Item is in the queue", () => {
  const keys = (menu: MenuPage) => stateOptions(menu, theme).map((option) => option.key);
  const low = page({ moves: { triage: {}, "in-review": {} } });
  assert.equal(keys(low).includes("merge-queue"), false);
  assert.equal(keys({ ...low, lane: "queued" }).includes("merge-queue"), true);
  assert.equal(keys(page()).includes("merge-queue"), true);
});

test("Implement anyway is a button by triage's verdict, not a menu option: the server's move, waiting as In progress (decision 105)", () => {
  assert.equal(implementAnyway(page()), undefined);
  const offered = page({ moves: { ...page().moves, implement: {} } });
  assert.deepEqual(implementAnyway(offered), { key: "in-progress", steps: [{ kind: "move", to: "implement" }] });
  assert.deepEqual(implementAnyway(page({ moves: { implement: { why: "held by Bo" } } })), { key: "in-progress", why: "held by Bo", steps: [] });
  // The menu's In progress stays a person's claim.
  assert.deepEqual(byKey(offered)["in-progress"].steps, [{ kind: "claim" }]);
  assert.equal(implementToast("A-2"), "A-2 → Implement anyway");
});

test("an Item in Backlog (decision 121): To do moves it there, Triage runs one triage and it stays", () => {
  const menu = byKey(page({ lane: "backlog", moves: { triage: {}, "in-review": { why: "nothing to review yet" } } }));
  assert.deepEqual(menu.todo.steps, [{ kind: "lane", lane: "todo" }]);
  assert.equal(menu.backlog.why, "in Backlog already");
  assert.deepEqual(menu.triage.steps, [{ kind: "move", to: "triage" }]);
  assert.equal(currentState(page({ lane: "backlog" })), "backlog");
  assert.equal(byKey(page({ lane: "backlog", canEdit: false })).todo.why, "can't be changed here");
});
