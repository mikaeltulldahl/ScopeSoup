import assert from "node:assert/strict";
import { test } from "node:test";
import { parseItem } from "../hosts/metaBranch/item.ts";
import { canonicalItem, serializeItem } from "../hosts/metaBranch/serialize.ts";
import { work } from "../core/testing.ts";
import { refKey } from "../model/types.ts";
import type { WorkItem } from "../model/types.ts";
import { voteWords } from "../model/vote.ts";
import { openStore } from "../store/store.ts";
import { loadVotes, setVote, withVotes } from "../store/votes.ts";
import type { Jobs } from "./jobs.ts";
import { explainOrder, ordinal, voteForPlace, voteLimits, WEIGHTS } from "./score.ts";
import { compareItems } from "./candidates.ts";

const TRIAGED = { log: [{ at: "2026-03-02T10:00:00.000Z", by: { who: "scopesoup", agent: true as const }, kind: "session" as const, fields: { role: "triage" } }] };
const job = (id: number, size: "small" | "medium" | "large" = "medium", started = false) =>
  ({ [refKey(work(id).ref)]: { step: started ? "implement" : "triage", triage: { size, ready: true, paths: [], hidesDecision: false } } }) as unknown as Jobs;
const order = (items: WorkItem[], jobs: Jobs = {}): string[] => [...items].sort(compareItems(["bug"], jobs, items)).map((item) => item.ref.id);

test("score: a started Item beats a fresh one of slightly higher priority", () => {
  const items = [work(1, { priority: "major", ...TRIAGED }), work(2, { ...TRIAGED })];
  const jobs = { ...job(1), ...job(2, "medium", true) };
  assert.deepEqual(order(items, jobs), ["2", "1"]);
  // Without the start, the higher priority wins.
  assert.deepEqual(order(items, { ...job(1), ...job(2) }), ["1", "2"]);
  assert.ok(WEIGHTS.started > WEIGHTS.priority.major - WEIGHTS.noPriority);
});

test("score: a blocker beats everything with the same standing; a triage still comes first", () => {
  const strong = work(1, { priority: "critical", labels: ["bug"], vote: 15, ...TRIAGED });
  const blocker = work(9, { priority: "blocker", ...TRIAGED });
  const items = [strong, work(3, { blockedBy: [strong.ref], ...TRIAGED }), blocker];
  const jobs = { ...job(1, "small", true), ...job(9, "large"), ...job(3) };
  assert.deepEqual(order(items, jobs), ["9", "1", "3"]);
  // A blocker that has not been triaged yet stays below the Items that were.
  assert.deepEqual(order([work(1, { ...TRIAGED }), work(2, { priority: "blocker" })], job(1)), ["1", "2"]);
});

test("score: rules: priority order, unlabelled between major and minor, bugs and size count only after the triage", () => {
  assert.deepEqual(order([work(1, { priority: "minor" }), work(2), work(3, { priority: "critical" }), work(4, { priority: "major" })]), ["3", "4", "2", "1"]);
  assert.deepEqual(order([work(1), work(2, { labels: ["bug"] })]), ["1", "2"]);
  assert.deepEqual(order([work(1), work(2, { ...TRIAGED })], job(2)), ["2", "1"]);
});

test("score: size, bugs, and the Items an Item unblocks all weigh", () => {
  const items = [work(1, TRIAGED), work(2, TRIAGED), work(3, TRIAGED), work(4, { ...TRIAGED, labels: ["bug"] })];
  const jobs = { ...job(1, "large"), ...job(2, "small"), ...job(3), ...job(4) };
  assert.deepEqual(order(items, jobs), ["4", "2", "3", "1"]);
  const blocking = [work(1, TRIAGED), work(2, TRIAGED), work(3, { blockedBy: [work(2).ref] })];
  assert.deepEqual(order(blocking, { ...job(1), ...job(2) }).slice(0, 2), ["2", "1"]);
});

test("score: started means code written; an answer or a past session is not a start", () => {
  const key = refKey(work(2).ref);
  const base = { triage: { size: "medium", ready: true, paths: [], hidesDecision: false } };
  const items = [work(1, { priority: "major", ...TRIAGED }), work(2, { ...TRIAGED, answers: [{ at: "2026-03-03T10:00:00.000Z", by: { who: "a" }, text: "yes" }] } as never)];
  const answered = { ...job(1), [key]: { ...base, step: "triage", answerArrived: "x", answered: [{ index: 0, answer: "yes", at: "x" }], resume: "s" } } as unknown as Jobs;
  assert.deepEqual(order(items, answered), ["1", "2"]);
  // A branch head that differs from main is code written.
  const ahead = { ...job(1), [key]: { ...base, step: "triage", head: "bbb", base: "aaa" } } as unknown as Jobs;
  assert.deepEqual(order(items, ahead), ["2", "1"]);
  // A head equal to main is no code.
  const none = { ...job(1), [key]: { ...base, step: "triage", head: "aaa", base: "aaa" } } as unknown as Jobs;
  assert.deepEqual(order(items, none), ["1", "2"]);
});

const ctx = (items: WorkItem[], jobs: Jobs) => ({ all: items, jobs, bugLabels: ["bug"] });
const sortedBy = (items: WorkItem[], jobs: Jobs): WorkItem[] => [...items].sort(compareItems(["bug"], jobs, items));
/** One press on `id`: the Items with the vote the press sets, or undefined when the button is off. */
function press(items: WorkItem[], id: number, direction: "up" | "down", jobs: Jobs = {}): WorkItem[] | undefined {
  const move = voteForPlace(sortedBy(items, jobs), refKey(work(id).ref), direction, ctx(items, jobs));
  return move.ok ? items.map((item) => (item.ref.id === String(id) ? { ...item, vote: move.vote } : item)) : undefined;
}
const limitsOf = (items: WorkItem[], jobs: Jobs = {}) => voteLimits(sortedBy(items, jobs), ctx(items, jobs));

test("vote: each press moves the Item exactly one place, from the bottom to the top and back", () => {
  const items = [work(1, { ...TRIAGED, priority: "major" }), work(2, TRIAGED), work(3, { ...TRIAGED, priority: "critical" }), work(4, { ...TRIAGED, priority: "minor" }), work(5, TRIAGED), work(6, { ...TRIAGED, labels: ["bug"] })];
  const jobs = [1, 2, 3, 4, 5, 6].reduce((all, id) => ({ ...all, ...job(id, id % 2 ? "small" : "large") }), {} as Jobs);
  for (const id of [1, 2, 3, 4, 5, 6]) {
    let now = items;
    for (;;) {
      const before = order(now, jobs);
      const next = press(now, id, "up", jobs);
      if (!next) break;
      const after = order(next, jobs);
      assert.equal(after.indexOf(String(id)), before.indexOf(String(id)) - 1, `${id} up: ${before} -> ${after}`);
      assert.deepEqual(after.filter((each) => each !== String(id)), before.filter((each) => each !== String(id)), "the others keep their order");
      now = next;
    }
    assert.equal(order(now, jobs)[0], String(id));
    for (;;) {
      const before = order(now, jobs);
      const next = press(now, id, "down", jobs);
      if (!next) break;
      const after = order(next, jobs);
      assert.equal(after.indexOf(String(id)), before.indexOf(String(id)) + 1, `${id} down: ${before} -> ${after}`);
      assert.deepEqual(after.filter((each) => each !== String(id)), before.filter((each) => each !== String(id)));
      now = next;
    }
    assert.equal(order(now, jobs).at(-1), String(id));
  }
});

test("vote: with equal scores one press still moves one place when the age lies between; votes have 2 decimals", () => {
  const jobs = { ...job(1), ...job(2), ...job(3), ...job(4) };
  // 3 ties with 2 (age 0.25 + vote 0.25 = 0.5, and 2 has age 0.5): moving 3 up puts it between 2's neighbours.
  const tied = [work(1, { ...TRIAGED, priority: "major" }), work(2, TRIAGED), work(3, { ...TRIAGED, vote: 0.25 })];
  assert.deepEqual(order(tied, jobs), ["1", "2", "3"]);
  const moved = press(tied, 3, "up", jobs)!;
  assert.deepEqual(order(moved, jobs), ["1", "3", "2"]);
  assert.equal(moved[2]!.vote, Math.round(moved[2]!.vote! * 100) / 100);
  // 1 ties with 3 (the older one wins), 2 in between by age: 2 pressed up goes above 1? No: one place, between 1 and the top.
  const three = [work(1, TRIAGED), work(2, { ...TRIAGED, vote: -0.25 }), work(3, { ...TRIAGED, vote: 0.25 })];
  assert.deepEqual(order(three, jobs), ["1", "3", "2"]);
  assert.deepEqual(order(press(three, 2, "up", jobs)!, jobs), ["1", "2", "3"]);
  // Neighbours with one score and no age between them: the small gap beyond both is all that is left, and it still moves.
  const stuck = [work(1, { ...TRIAGED, priority: "major" }), work(2, { ...TRIAGED, vote: 0.25 }), work(3, { ...TRIAGED, vote: 0.5 }), work(4, { ...TRIAGED, vote: 0.75 })];
  assert.deepEqual(order(stuck, jobs), ["1", "2", "3", "4"]);
  assert.deepEqual(order(press(stuck, 4, "up", jobs)!, jobs).slice(0, 2), ["1", "4"]);
});

test("vote: the second Item goes a fixed margin above the top; the last stays a margin below", () => {
  const items = [work(1, { ...TRIAGED, priority: "major" }), work(2, TRIAGED), work(3, { ...TRIAGED, priority: "minor" })];
  const jobs = { ...job(1), ...job(2), ...job(3) };
  const up = press(items, 2, "up", jobs)!;
  assert.deepEqual(order(up, jobs), ["2", "1", "3"]);
  // Major 30 + age 0.5 = 30.5; the vote puts 2 a margin above it: 0.25 + vote = 30.5 + 1.
  assert.equal(up[1]!.vote, 31.25);
  assert.equal(limitsOf(up, jobs).get(refKey(work(2).ref))!.up, "Already first of the backlog.");
  assert.deepEqual(order(press(items, 2, "down", jobs)!, jobs), ["1", "3", "2"]);
  assert.equal(press(items, 1, "up", jobs), undefined);
  assert.equal(press(items, 3, "down", jobs), undefined);
});

test("vote: up then down gives the order back", () => {
  const base = [work(1, TRIAGED), work(2, { ...TRIAGED, priority: "major" }), work(3, TRIAGED), work(4, { ...TRIAGED, labels: ["bug"] })];
  const jobs = { ...job(1), ...job(2), ...job(3), ...job(4) };
  const before = order(base, jobs);
  for (const id of [1, 2, 3, 4]) {
    const up = press(base, id, "up", jobs);
    if (up) assert.deepEqual(order(press(up, id, "down", jobs)!, jobs), before);
    const down = press(base, id, "down", jobs);
    if (down) assert.deepEqual(order(press(down, id, "up", jobs)!, jobs), before);
  }
});

test("vote: stays inside its group: the triage boundary is not crossed, and a blocker stays among blockers", () => {
  const items = [work(1, TRIAGED), work(2, TRIAGED), work(3), work(4), work(5, { priority: "blocker" })];
  const jobs = { ...job(1), ...job(2) };
  assert.deepEqual(order(items, jobs), ["1", "2", "5", "3", "4"]);
  const limits = limitsOf(items, jobs);
  assert.equal(limits.get(refKey(work(1).ref))!.up, "Already first of the backlog.");
  assert.equal(limits.get(refKey(work(2).ref))!.down, "Already last among the Items triaged.");
  assert.equal(limits.get(refKey(work(5).ref))!.up, "Already first among the Items not triaged yet.");
  assert.equal(limits.get(refKey(work(5).ref))!.down, "Already last among the blockers.");
  assert.equal(limits.get(refKey(work(3).ref))!.up, "Already first among the Items that are not blockers.");
  assert.equal(limits.get(refKey(work(4).ref))!.down, "Already last of the backlog.");
  assert.equal(limits.get(refKey(work(4).ref))!.up, undefined);
  // Items not triaged yet move up one place at a time and stop below the triage group.
  const untriaged = [work(1, TRIAGED), work(2), work(3), work(4)];
  const triaged = job(1);
  const once = press(untriaged, 4, "up", triaged)!;
  assert.deepEqual(order(once, triaged), ["1", "2", "4", "3"]);
  const twice = press(once, 4, "up", triaged)!;
  assert.deepEqual(order(twice, triaged), ["1", "4", "2", "3"]);
  assert.equal(press(twice, 4, "up", triaged), undefined);
  assert.equal(limitsOf(twice, triaged).get(refKey(work(4).ref))!.up, "Already first among the Items not triaged yet.");
});

test("why: place, reasons and what is ahead, in words and without the vote's number", () => {
  const first = work(41, { ...TRIAGED, priority: "major" });
  const second = work(42, { ...TRIAGED, priority: "major", labels: ["bug"], vote: 1 });
  const all = [first, second, work(43, { blockedBy: [second.ref] }), work(44, { blockedBy: [second.ref] })];
  const jobs = { ...job(41, "small", true), ...job(42, "small") };
  assert.deepEqual(order(all, jobs).slice(0, 2), ["41", "42"]);
  const why = explainOrder([first, second], { all, jobs, bugLabels: ["bug"] });
  assert.equal(why.get(refKey(first.ref)), "1st: major, already started, small");
  assert.equal(why.get(refKey(second.ref)), "2nd: major bug, unblocks 2, small, voted up; behind #41 because #41 is already started");
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(22), "22nd");
  assert.equal(voteWords(-2), "voted down");
  assert.equal(voteWords(0), "");
});

test("vote: kept in the item.md header (meta branch) and in the store (GitHub items)", () => {
  const text = serializeItem("A-1", canonicalItem({ title: "T", vote: -2.35 }));
  assert.match(text, /\nvote: -2.35\n/);
  const parsed = parseItem(text, "A-1");
  assert.ok(parsed.ok);
  assert.equal(parsed.fields.vote, -2.35);
  assert.equal(serializeItem("A-1", canonicalItem({ title: "T" })).includes("vote"), false);
  assert.equal(parseItem("---\ntitle: T\nstate: todo\nvote: 2.345\n---\n", "A-1").ok, false);
  const store = openStore(":memory:");
  const github = { ...work(7), ref: { host: "github", kind: "work" as const, id: "7" } };
  setVote(store, github.ref, 12.5, "robin", "2026-03-02T10:00:00.000Z");
  assert.equal(withVotes([github, work(8)], loadVotes(store))[0]!.vote, 12.5);
  setVote(store, github.ref, 0, "robin", "2026-03-02T10:01:00.000Z");
  assert.deepEqual(loadVotes(store), {});
  assert.equal(store.getValue("scopesoup.votes"), "{}");
});
