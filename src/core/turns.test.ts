import assert from "node:assert/strict";
import { test } from "node:test";
import type { Change } from "../model/types.ts";
import type { Snapshot } from "./snapshot.ts";
import { situate } from "./lanes.ts";
import { buildIndex } from "./snapshot.ts";
import { at, batch, change, member, passed, ref, run, session, snapshot, T0, verdict, work } from "./testing.ts";
import { assess, assessAll, computeUnblocks, turnContext, waitingQueue, yourTurn } from "./turns.ts";

const now = new Date(T0);

function turnOf(snap: Snapshot, id: number) {
  const item = snap.works.find((each) => each.ref.id === String(id))!;
  const index = buildIndex(snap);
  return assess(situate(item, index), turnContext(index, now)).turn;
}

test("unblocks counts everything transitively behind an item, once, and survives cycles", () => {
  const works = [
    work(1),
    work(2, { blockedBy: [ref("work", 1)] }),
    work(3, { blockedBy: [ref("work", 2), ref("work", 1)] }),
    work(4, { blockedBy: [ref("work", 3)], state: "done" }),
    work(5, { blockedBy: [ref("work", 6)] }),
    work(6, { blockedBy: [ref("work", 5)] }),
  ];
  const unblocks = computeUnblocks(works);
  assert.equal(unblocks.get("demo:work:1"), 2);
  assert.equal(unblocks.get("demo:work:2"), 1);
  assert.equal(unblocks.get("demo:work:3"), 0);
  assert.equal(unblocks.get("demo:work:5"), 1);
});

test("a card says what it waits for, and when that is a decision for anyone", () => {
  const base = snapshot({ works: [work(1, { needsDecision: true }), work(2, { blockedBy: [ref("work", 1)] })] });
  assert.equal(turnOf(base, 2).reason, "blocked by #1 (needs your decision)");
});

test("backlog reasons: blocked, sub-items, paused, usage limit, ready", () => {
  const works = [work(1), work(2, { blockedBy: [ref("work", 1), ref("work", 9)] }), work(3, { openChildren: 2 }), work(4, { blockedBy: [ref("work", 5)] }), work(5, { state: "done" })];
  const base = snapshot({ works });
  assert.deepEqual([turnOf(base, 1).actor, turnOf(base, 1).reason], ["agent", "ready; waiting for a free agent slot"]);
  assert.deepEqual([turnOf(base, 2).actor, turnOf(base, 2).reason], ["nobody", "blocked by #1"]);
  assert.equal(turnOf(base, 1).unblocks, 1);
  assert.match(turnOf(base, 3).reason, /2 open sub-items/);
  assert.equal(turnOf(base, 4).actor, "agent");
  assert.equal(turnOf({ ...base, paused: true }, 1).reason, "ready, but agents are paused (press Resume all)");
  const limited = { ...base, usage: { at: T0, status: "rejected", windows: [{ kind: "five_hour" as const, resetsAt: at(42) }] } };
  assert.equal(turnOf(limited, 1).reason, "ready, but the usage limit is reached; the window resets in 42 min");
});

test("an Item that waits for a paused triage says so, not that it waits for a slot", () => {
  const snap = snapshot({ works: [work(1), work(2)] });
  const paused = { ...snap, triage: "paused" as const };
  const turnWith = (s: Snapshot, id: number, notTriaged: string[]) => {
    const item = s.works.find((each) => each.ref.id === String(id))!;
    const index = buildIndex(s);
    return assess(situate(item, index), turnContext(index, now, new Set(notTriaged))).turn;
  };
  assert.equal(turnWith(paused, 1, ["demo:work:1"]).reason, "ready, but triage is paused (Resume on Backlog)");
  // One that is already triaged waits for a slot, as does any Item while triage runs.
  assert.equal(turnWith(paused, 2, ["demo:work:1"]).reason, "ready; waiting for a free agent slot");
  assert.equal(turnWith(snap, 1, ["demo:work:1"]).reason, "ready; waiting for a free agent slot");
});

test("a ready Item whose next step is implement says only \"ready\" when no implementor takes it (paused, or below level 2)", () => {
  const snap = snapshot({ works: [work(1), work(2)] });
  const paused = { ...snap, implement: "paused" as const };
  const turnWith = (s: Snapshot, id: number, notTriaged: string[]) => {
    const item = s.works.find((each) => each.ref.id === String(id))!;
    const index = buildIndex(s);
    const found = assess(situate(item, index), turnContext(index, now, new Set(notTriaged)));
    return { ...found.turn, tone: found.tone };
  };
  const words = "ready";
  const triaged = turnWith(paused, 2, ["demo:work:1"]);
  assert.equal(triaged.reason, words);
  assert.equal(triaged.tone, "waiting");
  assert.equal(triaged.actor, "nobody");
  // One still to triage waits for triage, which runs; implementors do not matter yet.
  assert.equal(turnWith(paused, 1, ["demo:work:1"]).reason, "ready; waiting for a free agent slot");
  assert.equal(turnWith(snap, 2, ["demo:work:1"]).reason, "ready; waiting for a free agent slot");
});

test("an item parked as too large leaves Your turn once split, and says so when all parts are done", () => {
  const parkedList = [{ subject: ref("work", 1), as: "not-ready" as const, reason: "Triage: too large for one change.", at: T0 }];
  const single = snapshot({ works: [work(1)], parked: parkedList });
  assert.equal(turnOf(single, 1).actor, "anyone");

  const split = snapshot({ works: [work(1, { openChildren: 2, children: 2 })], parked: parkedList });
  assert.deepEqual([turnOf(split, 1).actor, turnOf(split, 1).reason], ["nobody", "has 2 open sub-items; the work happens there"]);
  assert.deepEqual(yourTurn(assessAll(buildIndex(split), now)), []);

  const done = snapshot({ works: [work(1, { openChildren: 0, children: 2 })], parked: parkedList });
  assert.deepEqual([turnOf(done, 1).actor, turnOf(done, 1).reason], ["anyone", "Close it if nothing is left: all 2 sub-items are done"]);
});

test("an umbrella is an umbrella", () => {
  const snap = snapshot({ works: [work(1, { openChildren: 1, children: 1 })] });
  const index = buildIndex(snap);
  const item = snap.works[0]!;
  assert.match(assess(situate(item, index), turnContext(index, now)).turn.reason, /1 open sub-item;/);
});

test("a decision is everyone's turn wherever the item is", () => {
  const snap = snapshot({ works: [work(1, { needsDecision: true }), work(2, { needsDecision: true, state: "done" })] });
  assert.deepEqual([turnOf(snap, 1).actor, turnOf(snap, 1).reason], ["anyone", "Answer the question: the item needs a decision"]);
  assert.equal(turnOf(snap, 2).actor, "nobody");
});

test("sessions: running says what it does, stalled and limit say so", () => {
  const snap = snapshot({
    works: [work(1), work(2), work(3)],
    sessions: [
      session("a", ref("work", 1), { startedAt: at(-14), model: "opus", lastAction: "writing tests" }),
      session("b", ref("work", 2), { status: "stalled", startedAt: at(-40), lastEventAt: at(-12) }),
      session("c", ref("work", 3), { status: "limit", startedAt: at(-40) }),
    ],
    usage: { at: T0, windows: [{ kind: "five_hour", resetsAt: at(30) }] },
  });
  assert.deepEqual([turnOf(snap, 1).actor, turnOf(snap, 1).reason], ["agent", "implement session running for 14 min (opus): writing tests"]);
  assert.equal(turnOf(snap, 2).reason, "the implement session has stalled: no activity for 12 min");
  assert.deepEqual([turnOf(snap, 3).actor, turnOf(snap, 3).reason], ["nobody", "the implement session stopped at the usage limit and resumes on its own; the window resets in 30 min"]);
});

test("a held Item whose triage session runs says that a session runs, not that none does", () => {
  const holder = { actor: { id: "scopesoup@laptop-a", name: "scopesoup on laptop-a", bot: true } };
  const snap = snapshot({ works: [work(1, { holder }), work(2, { holder })], sessions: [session("t", ref("work", 1), { role: "triage", startedAt: at(-2) })] });
  assert.match(turnOf(snap, 1).reason, /^triage session running for 2 min/);
  assert.match(turnOf(snap, 2).reason, /^held by scopesoup on laptop-a; no session is running here$/);
});

test("in progress without a session: a held item, an expired claim, nobody at all", () => {
  const holder = { actor: { id: "w", name: "worker-2", bot: true } };
  const snap = snapshot({
    works: [work(1, { state: "doing", holder }), work(2, { state: "doing", holder: { ...holder, until: at(-30) } }), work(3, { state: "doing" })],
  });
  assert.match(turnOf(snap, 1).reason, /^held by worker-2; no session/);
  assert.match(turnOf(snap, 2).reason, /claim ran out 30 min ago/);
  assert.match(turnOf(snap, 3).reason, /nobody holds it/);
});

test("review reasons: waiting for a reviewer, findings, failed checks, a new revision", () => {
  const snap = snapshot({
    works: [work(1), work(2), work(3), work(5)],
    changes: [
      change(10, [1]),
      change(20, [2], { verdicts: [verdict("review", "fail")] }),
      change(30, [3], { verdicts: [verdict("review", "pass"), verdict("ci", "fail")] }),
      change(50, [5], { verdicts: [verdict("review", "pass", { stale: true })] }),
    ],
  });
  assert.deepEqual([turnOf(snap, 1).actor, turnOf(snap, 1).reason], ["agent", "waiting for a reviewer session"]);
  assert.match(turnOf(snap, 2).reason, /review verdict is a fail/);
  assert.match(turnOf(snap, 3).reason, /checks failed/);
  assert.match(turnOf(snap, 5).reason, /new revision since the last review/);
});

test("a change not merged below level 3 waits for its implementor, and no reason names a switch hidden at the level", () => {
  const snap = snapshot({ works: [work(1)], changes: [change(10, [1])] });
  const paused = { review: "paused", implement: "paused", triage: "paused", mergeQueue: "paused" } as const;
  // Level 2, everything paused after a start-up (the sandbox's A-1): the implementors' switch, shown on In progress.
  const two = turnOf({ ...snap, ...paused, level: 2 }, 1);
  assert.deepEqual([two.actor, two.reason], ["agent", "its change is not merged; nobody reviews at level 2: its implementor merges it, but implementors are paused (Resume on In progress)"]);
  assert.equal(turnOf({ ...snap, level: 2 }, 1).reason, "its change is not merged; nobody reviews at level 2: its implementor merges it");
  assert.equal(turnOf({ ...snap, ...paused, level: 1 }, 1).reason, "its change is not merged, and at level 1 nothing is built or merged (raise the level to go on)");
  // From level 3 the review switch is shown, and named when paused.
  assert.equal(turnOf({ ...snap, ...paused, level: 3 }, 1).reason, "waiting for a reviewer session, and review is paused (Resume on In review)");
  for (const level of [0, 1, 2]) assert.doesNotMatch(turnOf({ ...snap, ...paused, level }, 1).reason, /review is paused|In review|queue/);
  // An approved change below level 4 is not in a queue: Scope Soup merges nothing itself there.
  const approved = snapshot({ works: [work(2)], changes: [change(20, [2], { verdicts: [verdict("review", "pass")] })] });
  assert.equal(turnOf({ ...approved, ...paused, paused: true, level: 3 }, 2).reason, "approved; at level 3 Scope Soup merges nothing itself: its implementor or a person merges it");
  assert.doesNotMatch(turnOf({ ...approved, ...paused, paused: true, level: 3 }, 2).reason, /queue/);
  assert.equal(turnOf({ ...approved, ...paused, paused: true, level: 4 }, 2).reason, "approved, but the queue is paused");
});

test("a pull request Scope Soup will not review says who it waits for", () => {
  const person = { id: "ada", name: "ada" };
  const snap = snapshot({
    works: [work(1), work(2), work(3), work(4)],
    changes: [
      change(10, [1], { branch: "feature/x", author: person }),
      change(20, [2], { branch: "feature/y", author: person, labels: ["scopesoup:review"] }),
      change(30, [3], { branch: "scopesoup/3", author: person }),
      change(40, [4], { author: person }),
    ],
  });
  assert.deepEqual([turnOf(snap, 1).actor, turnOf(snap, 1).reason], ["nobody", "open pull request by ada; Scope Soup does not review it"]);
  assert.equal(turnOf(snap, 2).reason, "waiting for a reviewer session");
  assert.equal(turnOf(snap, 3).reason, "waiting for a reviewer session");
  assert.equal(turnOf(snap, 4).reason, "waiting for a reviewer session");
});

test("queue reasons: position, paused, forming, cannot merge", () => {
  const approved = { verdicts: [verdict("review", "pass")] };
  const snap = snapshot({
    works: [work(1), work(2), work(3), work(4)],
    changes: [
      change(10, [1], { ...approved, updatedAt: at(-5) }),
      change(20, [2], { ...approved, updatedAt: at(-9) }),
      change(30, [3], approved),
      change(40, [4], { ...approved, mergeable: false, blockers: ["conflicts with main"] }),
    ],
    batches: [batch(7, [member(30, "waiting")], { status: "forming" })],
  });
  assert.deepEqual(waitingQueue(buildIndex(snap)).map((each) => each.ref.id), ["20", "10", "40"]);
  assert.deepEqual([turnOf(snap, 1).actor, turnOf(snap, 1).reason], ["queue", "approved; waiting in the queue (position 2 of 3)"]);
  assert.equal(turnOf(snap, 3).reason, "in batch 7, which is being prepared for its check");
  assert.deepEqual([turnOf(snap, 4).actor, turnOf(snap, 4).reason], ["agent", "approved, but it cannot merge: conflicts with main; the branch needs a rebase on main"]);
  assert.equal(turnOf({ ...snap, paused: true }, 1).reason, "approved, but the queue is paused");
});

test("checking: the runner's turn with progress, waiting for a runner, a bisect and its suspect, a culprit", () => {
  const approved = { verdicts: [verdict("review", "pass")] };
  const running = run("r1", { status: "running", startedAt: at(-4) });
  const queued = run("r2", { status: "queued", createdAt: at(-3) });
  const snap = snapshot({
    works: [1, 2, 3, 4, 5].map((id) => work(id)),
    changes: [1, 2, 3, 4, 5].map((id) => change(id * 10, [id], approved)),
    runs: [running, queued, passed("h", 8, at(-60))],
    batches: [
      batch(6, [member(10)], { runs: [running.ref] }),
      batch(7, [member(20)], { runs: [queued.ref] }),
      batch(5, [member(30), member(40)], { status: "bisecting", suspect: ref("change", 40) }),
      batch(4, [member(50, "culprit")], { status: "failed", finishedAt: at(-20) }),
    ],
    runners: [{ id: "r", name: "laptop", online: false, busy: false, labels: [] }],
  });
  assert.deepEqual([turnOf(snap, 1).actor, turnOf(snap, 1).reason], ["runner", "in batch 6, checking: 4 min of ~8 min"]);
  assert.equal(turnOf(snap, 2).reason, "in batch 7, waiting for a runner: none is online");
  assert.equal(turnOf({ ...snap, runners: [] }, 2).reason, "in batch 7, waiting for a runner (3 min)");
  assert.deepEqual([turnOf(snap, 3).actor, turnOf(snap, 3).reason], ["queue", "batch 5 failed; a bisect is finding which change broke it"]);
  assert.match(turnOf(snap, 4).reason, /this change is the suspect/);
  assert.deepEqual([turnOf(snap, 5).actor, turnOf(snap, 5).reason], ["agent", "it broke batch 4 and was taken out; waiting for an implementor session"]);
});

test("the your-turn list: everyone's turns only, most unblocking first, then oldest", () => {
  const snap = snapshot({
    works: [
      work(1, { needsDecision: true, updatedAt: at(-10) }),
      work(2, { needsDecision: true, updatedAt: at(-90) }),
      work(3, { needsDecision: true, updatedAt: at(-50) }),
      work(4, { blockedBy: [ref("work", 3)] }),
      work(5, { blockedBy: [ref("work", 4)] }),
      work(6),
    ],
  });
  const list = yourTurn(assessAll(buildIndex(snap), now));
  assert.deepEqual(list.map((each) => [each.turn.subject.id, each.turn.unblocks]), [["3", 2], ["2", 0], ["1", 0]]);
});

test("every kind of parked Item for people starts with what to do, and nothing a person cannot act on is in Your turn", () => {
  const parked = (as: "needs-decision" | "handed-over" | "not-ready" | "escalated", extra = {}) => ({ subject: ref("work", 1), as, reason: "Because.", at: T0, ...extra });
  const reasonOf = (r: ReturnType<typeof parked>, changes: Change[] = []) => turnOf(snapshot({ works: [work(1)], changes, parked: [r] }), 1).reason;
  const option = { label: "A", description: "a" };
  const decision = { question: "Which?", options: [option], recommendation: "A" };
  assert.match(reasonOf(parked("needs-decision", { decision })), /^Pick an option: Which\?/);
  // Several open questions: how many are still open, and the first of those.
  const questions = [{ ...decision, question: "First?", answer: "a" }, { ...decision, question: "Second?" }, { ...decision, question: "Third?" }];
  assert.match(reasonOf(parked("needs-decision", { decision, questions })), /^Answer 2 of 3 questions: Second\?/);
  assert.match(reasonOf(parked("needs-decision", { decision: { ...decision, options: [] } })), /^Answer the question: Which\?/);
  const parts = [{ title: "One", description: "", verification: "", goes: "child" }];
  assert.match(reasonOf(parked("needs-decision", { proposal: { reason: "Too large.", original: "umbrella", parts } })), /^Accept, edit or reject the proposed restructuring: Too large./);
  assert.match(reasonOf(parked("handed-over")), /^Merge branch scopesoup\/1: /);
  assert.match(reasonOf(parked("handed-over"), [change(77, [1])]), /^Merge pull request 77: /);
  assert.match(reasonOf(parked("not-ready")), /^Answer or edit the item/);
  assert.match(reasonOf(parked("escalated")), /^Look at it and decide/);

  // The your-turn list says only what waits and how many, not the text of the question.
  const waitsOf = (r: ReturnType<typeof parked>, changes: Change[] = []) => turnOf(snapshot({ works: [work(1)], changes, parked: [r] }), 1).waits;
  assert.equal(waitsOf(parked("needs-decision", { decision, questions })), "2 questions");
  assert.equal(waitsOf(parked("needs-decision", { decision })), "1 question");
  assert.equal(waitsOf(parked("needs-decision", { proposal: { reason: "Too large.", original: "umbrella", parts } })), "a restructuring to accept");
  assert.deepEqual([waitsOf(parked("handed-over")), waitsOf(parked("not-ready")), waitsOf(parked("escalated"))], ["to merge", "not ready", "escalated"]);

  const mixed = snapshot({ works: [work(1), work(2, { needsDecision: true }), work(3)], parked: [parked("escalated")] });
  const listed = yourTurn(assessAll(buildIndex(mixed), now));
  assert.deepEqual(listed.map((each) => each.turn.subject.id).sort(), ["1", "2"]);
  for (const each of listed) assert.match(each.turn.reason, /^[A-Z]/);
});


// --- each person's own turn, and no stall timer for people ---

const alice = { id: "alice@laptop-a", name: "alice on laptop-a" };
const bob = { id: "bob@laptop-b", name: "bob on laptop-b" };
const far = "2036-03-02T10:00:00.000Z";

test("a person's hold is their turn and has no stall timer: a passed until or a quiet week never makes it stuck or free", () => {
  const snap = snapshot({
    works: [
      work(1, { holder: { actor: alice, until: far }, log: [{ at: at(-10), by: { who: "alice", machine: "laptop-a", agent: false }, kind: "claimed", fields: { until: far } }] }),
      work(2, { state: "doing", holder: { actor: bob, until: at(-60 * 24 * 7) }, updatedAt: at(-60 * 24 * 7) }),
    ],
  });
  const one = turnOf(snap, 1);
  assert.deepEqual([one.actor, one.person?.id], ["person", "alice@laptop-a"]);
  assert.equal(one.reason, "held by alice on laptop-a; Scope Soup leaves it alone until they hand it back or release it");
  assert.equal(one.since, at(-10));
  const two = turnOf(snap, 2);
  assert.equal(two.actor, "person");
  assert.doesNotMatch(two.reason, /ran out|stalled|stuck/);
  assert.match(two.reason, /Quiet: nothing written for 7 d$/);
  const tones = assessAll(buildIndex(snap), now).map((each) => each.tone);
  assert.deepEqual(tones, ["yours", "yours"]);
});

test("an Item parked after a person handed it back is that person's turn; other parked Items are everyone's", () => {
  const handback = { at: at(-30), by: { who: "alice", machine: "laptop-a", agent: false }, kind: "revision", fields: { sha: "a".repeat(40), branch: "scopesoup/3", handback: true } };
  const parked = [
    { subject: ref("work", 3), as: "handed-over" as const, reason: "Level 2: merge it.", at: at(-5) },
    { subject: ref("work", 4), as: "needs-decision" as const, reason: "Which parser?", at: at(-4) },
    { subject: ref("work", 5), as: "escalated" as const, reason: "The fix did not converge.", at: at(-3) },
    { subject: ref("work", 6), as: "escalated" as const, reason: "Gave up.", at: at(-2) },
  ];
  const later = { ...handback, at: at(-20), by: { who: "scopesoup", machine: "laptop-a", agent: true }, fields: { sha: "b".repeat(40), branch: "scopesoup/6" } };
  const snap = snapshot({
    works: [work(3, { log: [handback] }), work(4), work(5), work(6, { log: [handback, later] })],
    changes: [change(50, [5], { labels: ["scopesoup:review"], branch: "pr-branch", author: { id: "bob", name: "bob" } })],
    parked,
  });
  assert.deepEqual([turnOf(snap, 3).actor, turnOf(snap, 3).person?.id], ["person", "alice@laptop-a"]);
  assert.equal(turnOf(snap, 4).actor, "anyone");
  assert.deepEqual([turnOf(snap, 5).actor, turnOf(snap, 5).person?.id], ["person", "bob"]);
  // Scope Soup's own later revision supersedes the hand-back: the Item is everyone's again.
  assert.equal(turnOf(snap, 6).actor, "anyone");
});

test("Your turn per person: everyone's turns and their own, not another person's; a board with no person shows all", () => {
  const snap = snapshot({
    works: [work(1, { holder: { actor: alice, until: far } }), work(2, { holder: { actor: bob, until: far } }), work(3, { needsDecision: true })],
  });
  const all = assessAll(buildIndex(snap), now);
  const ids = (self?: { person?: string; machine?: string }) => yourTurn(all, self).map((each) => each.situation.item.ref.id).sort();
  assert.deepEqual(ids({ person: "alice", machine: "laptop-a" }), ["1", "3"]);
  assert.deepEqual(ids({ person: "bob", machine: "laptop-b" }), ["2", "3"]);
  // A person is not tied to a machine: Alice's hold from laptop-a is hers on the board of laptop-c too.
  assert.deepEqual(ids({ person: "alice", machine: "laptop-c" }), ["1", "3"]);
  assert.deepEqual(ids({ person: "carol" }), ["3"]);
  assert.deepEqual(ids(undefined), ["1", "2", "3"]);
  assert.deepEqual(ids({ machine: "laptop-a" }), ["1", "2", "3"]);
});

test("a question is in every person's Your turn until someone answers it, even on an item a person holds or handed back", () => {
  const handback = { at: at(-30), by: { who: "alice", machine: "laptop-a", agent: false }, kind: "revision", fields: { sha: "a".repeat(40), branch: "scopesoup/2", handback: true } };
  const asked = (id: number) => ({ subject: ref("work", id), as: "needs-decision" as const, reason: "Which parser?", at: at(-4) });
  const waiting = snapshot({ works: [work(1), work(2, { log: [handback] }), work(3, { holder: { actor: bob, until: far } })], parked: [asked(1), asked(2)] });
  const all = assessAll(buildIndex(waiting), now);
  const ids = (person?: string) => yourTurn(all, person ? { person } : undefined).map((each) => each.situation.item.ref.id).sort();
  assert.deepEqual([turnOf(waiting, 1).actor, turnOf(waiting, 2).actor], ["anyone", "anyone"]);
  for (const person of ["alice", "bob", "carol"]) assert.deepEqual(ids(person).filter((id) => id !== "3"), ["1", "2"], person);
  assert.deepEqual(ids("bob"), ["1", "2", "3"]);
  // Answered: the Item is no longer parked, and the question leaves every list at once.
  const answered = snapshot({ works: [work(1), work(2, { log: [handback] }), work(3, { holder: { actor: bob, until: far } })] });
  const after = assessAll(buildIndex(answered), now);
  for (const person of ["alice", "bob", "carol"]) assert.deepEqual(yourTurn(after, { person }).map((each) => each.situation.item.ref.id).filter((id) => id !== "3"), [], person);
});

test("below level 2 a triaged Item is only \"ready\", never waiting for a slot", () => {
  const snap = snapshot({ works: [work(1)] });
  for (const level of [0, 1]) assert.equal(turnOf({ ...snap, level }, 1).reason, "ready");
  assert.equal(turnOf({ ...snap, level: 2 }, 1).reason, "ready; waiting for a free agent slot");
});

test("a triaged Item whose paths overlap an Item in progress waits for it, and says so instead of waiting for a slot", () => {
  const snap = { ...snapshot({ works: [work(1), work(2)] }), sameFiles: [{ subject: ref("work", 2), waitsFor: [ref("work", 1)] }] };
  const turn = turnOf(snap, 2);
  assert.deepEqual([turn.actor, turn.reason], ["nobody", "waits for #1, which changes the same files"]);
  assert.equal(turnOf(snap, 1).reason, "ready; waiting for a free agent slot");
});

test("a same-files wait shows on the card over Scope Soup's own leftover hold, not over a person's", () => {
  const sameFiles = [{ subject: ref("work", 1), waitsFor: [ref("work", 2)], mayConflict: [] }];
  const bot = { actor: { id: "scopesoup@laptop-a", name: "scopesoup on laptop-a", bot: true } };
  const alice = { actor: { id: "alice", name: "Alice" } };
  const held = (holder: typeof bot | typeof alice) => turnOf(snapshot({ works: [work(1, { holder }), work(2, { state: "doing" })], sameFiles }), 1).reason;
  assert.match(held(bot), /^waits for /);
  assert.match(held(alice), /^held by Alice/);
});
