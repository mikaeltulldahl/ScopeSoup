// One test per rule of rules.ts, named by its id, that builds the bad state by hand and shows the rule fires, so no rule is green
// because it checks nothing. Below them, runs shrunk by the simulator and pasted here (`failsOn`): each fails its rule on today's code.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CardView } from "../core/views.ts";
import type { RecordedAnswer, ScopeSoupEvent, WorkItem } from "../model/types.ts";
import type { Job, Where } from "../orchestrator/jobs.ts";
import type { SessionRequest } from "../orchestrator/ports.ts";
import { FakeGit } from "./git.ts";
import type { GitObs, ItemObs, Observation, StartObs } from "./observe.ts";
import { touchingCount, uniqueLeftovers } from "./observe.ts";
import type { RunOptions } from "./play.ts";
import { play } from "./play.ts";
import type { Rule } from "./rules.ts";
import { RULE_IDS, RULES } from "./rules.ts";
import type { W } from "./waits.ts";
import type { Action, Ledger } from "./world.ts";
import { jobOf } from "../orchestrator/jobs.ts";

const AT = "2026-11-18T10:00:00.000Z";
const key = (id: string): string => `metaBranch:work:${id}`;

function gitObs(g: FakeGit = new FakeGit()): GitObs {
  return {
    main: g.main, branches: new Map(g.branches), tags: new Map(g.tags), stash: [...g.stash], unique: uniqueLeftovers(g), worktrees: [...g.worktrees.values()], owners: new Map(g.owners),
    deleted: [...g.deleted], mainMoves: [...g.mainMoves], contains: (a, d) => g.contains(a, d), commit: (sha) => g.commits.get(sha), touching: (since, until, paths) => touchingCount(g, since, until, paths),
  };
}

function ledger(over: Partial<Ledger> = {}): Ledger {
  return { requests: [], closesAsked: new Map(), texts: new Map(), ended: [], answers: [], asksInFair: new Map(), skipped: 0, seen: new Map(), ...over };
}

function workItem(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return { ref: { host: "metaBranch", kind: "work", id }, title: `Item ${id}`, state: "todo", hostState: "todo", labels: [], blockedBy: [], openChildren: 0, updatedAt: AT, ...over };
}

function job(id: string, over: Partial<Job & Where> = {}): Job {
  return jobOf({ item: { host: "metaBranch", kind: "work", id }, workspace: `w-${id}`, branch: `scopesoup/${id}`, step: "triage", failures: 0, fixRounds: 0, startedAt: AT, ...over });
}

function card(id: string, over: Partial<CardView> = {}): CardView {
  return { ref: { host: "metaBranch", kind: "work", id }, label: id, title: `Item ${id}`, key: key(id), lane: "backlog", actor: "agent", reason: "", tone: "neutral", unblocks: 0, needsDecision: false, ...over } as CardView;
}

function item(id: string, w: W, over: Partial<ItemObs> = {}): ItemObs {
  const work = over.item ?? workItem(id);
  return { key: key(id), id, item: work, host: work, w, paths: [], live: [], ...over };
}

function obs(over: Partial<Observation> = {}): Observation {
  return {
    seed: 1, step: 1, action: { kind: "sync" }, at: AT, level: 3, slots: 2, switches: { triage: "started", implement: "started", review: "started", mergeQueue: "started" },
    usageReserve: false, overPace: false, kickBlocked: false, waiting: 0, caps: { triage: 2, work: 5 }, retriageShare: 0.05, fair: false, items: [], sessions: [], started: [], liveCount: 0, events: [], lastSeq: 0, answers: [], tick: null, tickError: null,
    git: gitObs(), ledger: ledger(), requests: [], remote: { refusedRewrites: 0, down: false, items: 0, retries: 0 }, lanes: ["blocked", "backlog", "in-progress", "in-review", "queued", "checking", "done"],
    queued: [], fairTicks: 0, ...over,
  };
}

function started(id: string, role: "triage" | "implement" | "review", over: Partial<SessionRequest> = {}): StartObs {
  return {
    session: `s-${id}`, item: key(id), role, limitAtStart: 2,
    request: { role, subject: { host: "metaBranch", kind: "work", id }, attempt: 1, workspace: `w-${id}`, branch: `scopesoup/${id}`, vars: { itemTitle: `Item ${id}`, itemBody: "Do it." }, ...over },
  };
}

const event = (subject: string | undefined, actor = "orchestrator", kind = "orchestrator.step"): ScopeSoupEvent => ({ seq: 1, at: AT, kind, ...(subject ? { subject } : {}), actor, data: {} });
const tick = { kind: "tick" } as Action;
const report = (over: object = {}) => ({ at: AT, started: [], running: 0, queued: 0, ...over });

const rule = (id: string): Rule => RULES.find((each) => each.id === id)!;
/** Runs the rule over the observations in order with one memo, and returns the first thing it says is wrong. */
function fires(id: string, ...steps: Observation[]): string | null {
  const memo = {};
  let prev: Observation | undefined;
  for (const o of steps) {
    const found = rule(id).check(o, prev, memo);
    if (found) return found;
    prev = o;
  }
  return null;
}

const NOTHING: W = { kind: "nothing" };
const SLOT: W = { kind: "start", role: "implement", cause: "slot" };

describe("each rule fires on a bad state built by hand", { concurrency: 1 }, () => {
  test("every rule has a test here", () => {
    const named = new Set(TESTED);
    assert.deepEqual(RULE_IDS.filter((id) => !named.has(id)), []);
  });

  const TESTED: string[] = [];
  const it = (id: string, name: string, f: () => void): void => {
    TESTED.push(id);
    test(`${id}: ${name}`, f);
  };

  it("A1", "an Item parked for a person in the Queued lane (#207)", () => {
    const parked = obs({ items: [item("A-1", { kind: "person", why: "answer", n: 1 }, { card: card("A-1", { lane: "queued", actor: "anyone" }) })] });
    assert.match(fires("A1", parked) ?? "", /queued lane/);
    assert.equal(fires("A1", obs({ items: [item("A-1", { kind: "queue" }, { card: card("A-1", { lane: "queued", actor: "queue" }) })] })), null);
    // A review runs on an Item whose change the store has not read yet: In review, not To do (#230).
    assert.match(fires("A1", obs({ items: [item("A-1", { kind: "session", role: "review" }, { card: card("A-1", { lane: "todo" }) })] })) ?? "", /card is in todo/);
    // A question at implement, with a commit: In progress (decision 2).
    const asked = item("A-1", { kind: "person", why: "answer", n: 1 }, { job: job("A-1", { step: "implement", head: "1".repeat(40) }), card: card("A-1", { lane: "todo", actor: "anyone" }) });
    assert.match(fires("A1", obs({ items: [asked] })) ?? "", /its lane is in-progress/);
  });
  it("A1", "a timed wait whose card says another cause (decision 3, #230)", () => {
    // Read after a tick (between ticks the card is the last tick's, #238).
    const at = (cause: "text" | "timer", reason: string) => obs({ action: { kind: "tick" }, items: [item("A-1", { kind: "start", role: "implement", cause }, { card: card("A-1", { lane: "todo", reason }) })] });
    assert.match(fires("A1", at("timer", "ready; waiting for a free agent slot")) ?? "", /waits for a timer/);
    assert.equal(fires("A1", at("timer", "the implement step failed once; it tries again in 30 s")), null);
    assert.match(fires("A1", at("text", "ready; waiting for a free agent slot")) ?? "", /read back/);
    assert.equal(fires("A1", at("text", "waits until the description written at a person's Accept is read back from metaBranch (at most 29 min more)")), null);
  });
  it("A2", "a person's turn while a session works on it (#194)", () => {
    assert.match(fires("A2", obs({ items: [item("A-1", { kind: "session", role: "implement" }, { card: card("A-1", { lane: "in-progress", actor: "anyone" }) })] })) ?? "", /person's turn/);
  });
  it("A3", "an open question line on the host while nothing asks (#209)", () => {
    const host = workItem("A-1", { openQuestions: [{ at: AT, by: { who: "scopesoup", agent: true }, question: "Close it?", options: [] }] });
    assert.match(fires("A3", obs({ items: [item("A-1", { kind: "not-started" }, { host })] })) ?? "", /open question/);
  });
  it("A4", "a step started while W waited for a switch", () => {
    const before = obs({ items: [item("A-1", { kind: "start", role: "implement", cause: "switch" })] });
    assert.match(fires("A4", before, obs({ action: tick, started: [started("A-1", "implement")] })) ?? "", /while W was start\(implement, switch\)/);
  });
  it("A5", "parked as queued with nothing in the queue", () => {
    assert.match(fires("A5", obs({ items: [item("A-1", { kind: "queue" }, { job: job("A-1", { parked: { as: "queued", reason: "", at: AT } }) })] })) ?? "", /queue does not have it/);
  });
  it("A6", "idle with no session while an Item waits only for a slot", () => {
    assert.match(fires("A6", obs({ action: tick, tick: report({ idle: "Nothing to do." }), items: [item("A-1", SLOT)] })) ?? "", /waits only for a slot/);
  });
  it("B1", "an accepted answer missing from the next session's prompt", () => {
    const answers: RecordedAnswer[] = [{ subject: { host: "metaBranch", kind: "work", id: "A-1" }, answer: "metres", by: "Ada", at: AT }];
    const o = obs({ step: 5, answers, ledger: ledger({ answers: [{ step: 2, item: key("A-1"), text: "metres" }] }), started: [started("A-1", "triage")] });
    assert.match(fires("B1", o) ?? "", /not told the answer "metres"/);
    assert.match(fires("B1", obs({ ledger: ledger({ answers: [{ step: 0, item: key("A-1"), text: "metres" }] }) })) ?? "", /not in the store's answers/);
  });
  it("B2", "the description on the host is not the last a person wrote", () => {
    const o = obs({ items: [item("A-1", NOTHING, { host: workItem("A-1", { body: "Old text." }) })], ledger: ledger({ texts: new Map([[key("A-1"), { title: "Item A-1", body: "New text." }]]) }) });
    assert.match(fires("B2", o) ?? "", /not the last a person wrote/);
  });
  it("B3", "a request with a parked state the Item never had is carried out (#195)", () => {
    const o = obs({ requests: [{ step: 1, path: "/api/answer", body: { parkedAt: "2026-01-01T00:00:00.000Z" }, status: 200, response: {}, item: "A-1" }] });
    assert.match(fires("B3", o) ?? "", /carried out/);
  });
  it("B4", "a question still open about a closed Item (#199, #209)", () => {
    const host = workItem("A-1", { openQuestions: [{ at: AT, by: { who: "scopesoup", agent: true }, question: "Close A-2 as a duplicate of A-1?", options: [] }] });
    const o = obs({ items: [item("A-1", { kind: "person", why: "answer", n: 1 }, { host }), item("A-2", NOTHING, { item: workItem("A-2", { state: "abandoned" }) })] });
    assert.match(fires("B4", o) ?? "", /about A-2, which is closed/);
  });
  it("B5", "a close accepted inside a tick is undone by it", () => {
    const o = obs({ action: { kind: "inside-tick", inner: { kind: "close", item: "A-1", state: "done" } }, requests: [{ step: 1, path: "/api/item/edit", body: { state: "done" }, status: 200, response: {}, item: "A-1" }], items: [item("A-1", SLOT)] });
    assert.match(fires("B5", o) ?? "", /closed inside the tick/);
  });
  it("B6", "a session starts on an Item a person holds", () => {
    const held = workItem("A-1", { holder: { actor: { id: "Ada@laptop-a", name: "Ada on laptop-a" } } });
    assert.match(fires("B6", obs({ items: [item("A-1", { kind: "person", why: "holds" }, { item: held })] }), obs({ started: [started("A-1", "implement")] })) ?? "", /holds/);
  });
  it("B7", "a triage started twice on the same input after it settled (#196, #197)", () => {
    const done = ledger({ ended: [{ step: 1, item: key("A-1"), role: "triage", session: "s-A-1", status: "succeeded", settled: true }] });
    assert.match(fires("B7", obs({ started: [started("A-1", "triage")] }), obs({ ledger: done, started: [started("A-1", "triage")] })) ?? "", /same input/);
    // The session with this input never ended with a result (a restart left it with no process): its step starts again (#238).
    const older = ledger({ ended: [{ step: 1, item: key("A-1"), role: "triage", session: "s0", status: "succeeded", settled: true }] });
    assert.equal(fires("B7", obs({ started: [started("A-1", "triage")] }), obs({ ledger: older, started: [started("A-1", "triage")] })), null);
    // A person picked the review again on a change reviewed before: their ask is new input (#268).
    const reviewed = ledger({ ended: [{ step: 1, item: key("A-1"), role: "review", session: "s-A-1", status: "succeeded", settled: true }] });
    const picked = obs({ ledger: reviewed, items: [item("A-1", SLOT, { job: job("A-1", { step: "review", reviewAskedBy: "Ada" }) })] });
    assert.equal(fires("B7", obs({ started: [started("A-1", "review")] }), picked, obs({ ledger: reviewed, started: [started("A-1", "review")] })), null);
    assert.match(fires("B7", obs({ started: [started("A-1", "review")] }), obs({ ledger: reviewed, started: [started("A-1", "review")] })) ?? "", /same input/);
    assert.match(fires("B7", obs({ ledger: ledger({ asksInFair: new Map([[key("A-1"), 4]]) }) })) ?? "", /asked 4 times/);
    const shown = (text: string, body: string, questions: number): string | null => {
      const rewrite = { original: body.trim(), text, questions: Array.from({ length: questions }, () => ({ question: "?", options: [], recommendation: "" })), round: 1 };
      const parked = job("A-1", { step: "triage", parked: { as: "needs-decision", reason: "", at: AT }, rewrite } as never);
      return fires("B7", obs({ items: [item("A-1", { kind: "person", why: "rewrite" }, { item: workItem("A-1", { body }), job: parked })] }));
    };
    assert.match(shown("Do it.", "Do it.", 0) ?? "", /equals its description/);
    assert.match(shown("Do it.  ", "Do it.", 1) ?? "", /apart from whitespace/);
    assert.equal(shown("Do it.", "Do it.", 1), null); // the questions are asked with the description as it is
  });
  it("B8", "an answer to the implementor's question sends the Item back to triage", () => {
    const parked = obs({ items: [item("A-1", { kind: "person", why: "answer", n: 1 }, { job: job("A-1", { step: "implement", parked: { as: "needs-decision", reason: "", at: AT, byStep: true } }) })] });
    const answered = obs({ requests: [{ step: 1, path: "/api/answer", body: {}, status: 200, response: {}, item: "A-1" }], items: parked.items });
    assert.match(fires("B8", parked, answered, obs({ started: [started("A-1", "triage")], items: parked.items })) ?? "", /next session is triage/);
    // Questions another Item's agent asked about it were written before the implementor resumed: answered, it is triaged again (#264).
    const written = obs({ events: [event(key("A-1"), "orchestrator", "orchestrator.about_other_written")], items: parked.items });
    assert.equal(fires("B8", parked, answered, written, obs({ started: [started("A-1", "triage")], items: parked.items })), null);
    // A person's Merge queue over a running review: the review must not start again before the hand-over.
    const reviewing = obs({ items: [item("A-1", { kind: "session", role: "review" }, { job: job("A-1", { step: "review", sessionId: "s1" }) })] });
    const picked = obs({ requests: [{ step: 1, path: "/api/item/move", body: { to: "merge-queue" }, status: 200, response: {}, item: "A-1" }], items: reviewing.items });
    assert.match(fires("B8", reviewing, picked, obs({ started: [started("A-1", "review")], items: reviewing.items })) ?? "", /picked for the merge queue, but a review session started/);
    const queued = obs({ items: [item("A-1", { kind: "queue" }, { job: job("A-1", { step: "review", parked: { as: "queued", reason: "", at: AT } }) })] });
    assert.equal(fires("B8", reviewing, picked, queued, obs({ started: [started("A-1", "review")], items: queued.items })), null);
  });
  it("B9", "a triage taken again with nothing it read changed: age alone is no input (#217)", () => {
    const g = new FakeGit();
    const waiting = (over: Partial<WorkItem> = {}) => item("A-1", NOTHING, { item: workItem("A-1", over), paths: ["src/a.ts"], job: job("A-1", { step: "implement" }) });
    const first = obs({ git: gitObs(g), items: [waiting()], started: [started("A-1", "triage")] });
    const settled = ledger({ ended: [{ step: 1, item: key("A-1"), role: "triage", session: "s-A-1", status: "succeeded", settled: true }] });
    const chose = { ...event(key("A-1"), "orchestrator", "orchestrator.triage_again"), data: {} };
    const again = (over: Partial<Observation> = {}) => obs({ action: tick, ledger: settled, events: [chose], items: [waiting()], started: [started("A-1", "triage", { vars: { itemTitle: "Item A-1", itemBody: "Do it.", recheck: "It is 40 days old." } })], ...over });
    assert.match(fires("B9", first, obs({ action: tick, ledger: settled, git: gitObs(g), items: [waiting()] }), again({ git: gitObs(g), at: "2027-01-01T10:00:00.000Z" })) ?? "", /nothing it read changed/);
    // Its text edited, a commit on main on the paths it named: new input.
    assert.equal(fires("B9", first, again({ git: gitObs(g), items: [waiting({ title: "Item A-1, edited" })] })), null);
    const moved = new FakeGit();
    const base = moved.main;
    const f = obs({ git: { ...gitObs(moved), main: base }, items: [waiting()], started: [started("A-1", "triage")] });
    moved.outsideCommit(["src/a.ts"]);
    assert.equal(fires("B9", f, again({ git: gitObs(moved) })), null);
    // A triage that did not settle is not the Item's triage: its retry is not checked against it.
    assert.equal(fires("B9", first, again({ ledger: ledger(), git: gitObs(g) })), null);
    // Taken again after a person's answer (no triage_again event): theirs, not Scope Soup's choice.
    assert.equal(fires("B9", first, obs({ action: tick, ledger: settled, git: gitObs(g), items: [waiting()] }), again({ git: gitObs(g), events: [] })), null);
  });
  it("B10", "Scope Soup takes more triages again on its own than its share allows (#217)", () => {
    const again = { ...event(key("A-1"), "orchestrator", "orchestrator.triage_again"), data: { background: true } };
    const sessions = Array.from({ length: 10 }, (_, n) => started(`A-${n}`, "implement"));
    assert.match(fires("B10", obs({ started: sessions }), obs({ events: [again, again] })) ?? "", /2 triages were taken again/);
    assert.equal(fires("B10", obs({ started: sessions }), obs({ events: [again] })), null);
    // Before an Item starts, a triage taken again is not counted in the share.
    assert.equal(fires("B10", obs({ events: [{ ...again, data: {} }, { ...again, data: {} }] })), null);
  });
  it("B11", "a step starts on the old text after a person accepted a rewrite the store has not read back, or the job forgets to wait (#268)", () => {
    const body = { item: workItem("A-1", { body: "Do thing 1." }) };
    const running = item("A-1", { kind: "session", role: "triage" }, { ...body, job: job("A-1", { sessionId: "s1" }) });
    const waits = item("A-1", { kind: "session", role: "triage" }, { ...body, job: job("A-1", { sessionId: "s1", writing: { from: "h", at: AT } }) });
    const old = obs({ items: [running] });
    const texts = new Map([[key("A-1"), { title: "Item A-1", body: "Rewritten." }]]);
    const accepted = (i: ItemObs) => obs({ step: 2, requests: [{ step: 2, path: "/api/proposed-rewrite", body: { action: "accept" }, status: 200, response: { written: true }, item: "A-1" }], ledger: ledger({ texts }), items: [i] });
    const next = (text: string) => obs({ step: 3, action: tick, started: [started("A-1", "implement", { vars: { itemTitle: "Item A-1", itemBody: text } })], items: [waits] });
    assert.match(fires("B11", old, accepted(waits), next("Do thing 1.")) ?? "", /started on the text before the one written at a person's accept at step 2/);
    assert.equal(fires("B11", old, accepted(waits), next("Rewritten.")), null);
    // The job running a session dropped the wait at the accept (the bug fixed in #211 step 3).
    assert.match(fires("B11", old, accepted(running)) ?? "", /A-1's job no longer waits for the text written at a person's accept at step 2/);
    // Read back by a sync, the old text is gone from the store: nothing is owed any more.
    const read = obs({ step: 3, items: [item("A-1", NOTHING, { item: workItem("A-1", { body: "Rewritten." }), job: job("A-1") })] });
    assert.equal(fires("B11", old, accepted(waits), read, next("Do thing 1.")), null);
    // Past the 30 minutes the product waits, it goes on with the text the store has.
    assert.equal(fires("B11", old, accepted(waits), { ...next("Do thing 1."), at: "2026-11-18T10:30:00.000Z" }), null);
  });
  it("C1", "an Item closed by an answer on another Item (#209, decision 8)", () => {
    assert.match(fires("C1", obs({ items: [item("A-2", SLOT)] }), obs({ items: [item("A-2", NOTHING, { item: workItem("A-2", { state: "abandoned" }) })] })) ?? "", /no person's close/);
  });
  it("C2", "a merged change whose Item stays open", () => {
    const g = new FakeGit();
    const head = g.commit([g.main], ["src/a.ts"], "work", "agent");
    g.mergeToMain(head, "session told", key("A-1"));
    const o = obs({ action: tick, git: gitObs(g), items: [item("A-1", SLOT, { job: job("A-1", { head }) })] });
    assert.match(fires("C2", o, o, o, o) ?? "", /still todo after 3 ticks/);
  });
  it("C3", "a closed Item keeps its job and a live session (decision 5)", () => {
    const o = obs({ action: tick, items: [item("A-1", NOTHING, { item: workItem("A-1", { state: "abandoned" }), job: job("A-1"), live: [{ id: "s1", role: "triage" }] })] });
    assert.match(fires("C3", o, o, o, o) ?? "", /still has a job, a live session/);
  });
  it("D1", "more live sessions than the limit", () => {
    assert.match(fires("D1", obs({ liveCount: 3, started: [{ ...started("A-1", "triage"), limitAtStart: 2 }] })) ?? "", /over the limit/);
  });
  it("D2", "two live sessions on one Item", () => {
    assert.match(fires("D2", obs({ items: [item("A-1", { kind: "session", role: "triage" }, { live: [{ id: "s1", role: "triage" }, { id: "s2", role: "triage" }] })] })) ?? "", /2 live sessions/);
  });
  it("D3", "an implement step starts while a busy Item has the same paths (#187)", () => {
    const before = obs({ items: [
      item("A-1", SLOT, { job: job("A-1", { step: "implement", triage: { ready: true, size: "small", paths: ["src/a.ts"], hidesDecision: false } }), paths: ["src/a.ts"] }),
      item("A-2", { kind: "session", role: "implement" }, { job: job("A-2", { step: "implement", sessionId: "s2" }), paths: ["src/a.ts"] }),
    ] });
    assert.match(fires("D3", before, obs({ items: before.items, started: [started("A-1", "implement")] })) ?? "", /busy on the same paths/);
  });
  it("D4", "a session starts while its switch is paused", () => {
    const paused = obs({ switches: { triage: "paused", implement: "started", review: "started", mergeQueue: "started" } });
    assert.match(fires("D4", paused, obs({ started: [started("A-1", "triage")] })) ?? "", /switch was paused/);
  });
  it("D5", "a session starts while usage is in the reserve", () => {
    assert.match(fires("D5", obs({ usageReserve: true }), obs({ started: [started("A-1", "triage")] })) ?? "", /reserve/);
  });
  it("D9", "a new triage or a first implement step starts while too much waits for a person", () => {
    const full = obs({ waiting: 2 });
    assert.match(fires("D9", full, obs({ action: tick, waiting: 2, started: [started("A-1", "triage")] })) ?? "", /new triage started on A-1 while 2 things waited/);
    // Work under way goes on: a triage of an Item that has a job (a recheck) is not new.
    const under = obs({ waiting: 5, items: [item("A-1", SLOT, { job: job("A-1", { step: "implement" }) }), item("A-2", SLOT, { job: job("A-2", { step: "implement", head: "abc" }) })] });
    assert.equal(fires("D9", under, obs({ action: tick, waiting: 5, started: [started("A-1", "triage"), started("A-2", "implement")] })), null);
    assert.match(fires("D9", under, obs({ action: tick, waiting: 5, started: [started("A-1", "implement")] })) ?? "", /new work started on A-1 while 5 things waited/);
    // An answer settled in the tick brought it under the cap.
    assert.equal(fires("D9", full, obs({ action: tick, waiting: 1, started: [started("A-1", "triage")] })), null);
  });
  it("D10", "more than the kick starts while a window is over its pace line", () => {
    assert.match(fires("D10", obs({ overPace: true, liveCount: 1 }), obs({ action: tick, overPace: true, started: [started("A-1", "triage")] })) ?? "", /over its pace line, with 1 running/);
    // Nothing ran: a start is the kick, allowed only in a fresh window or at or under the line now.
    assert.equal(fires("D10", obs({ overPace: true, liveCount: 0 }), obs({ action: tick, started: [started("A-1", "triage")] })), null);
    assert.match(fires("D10", obs({ overPace: true, kickBlocked: true, liveCount: 0 }), obs({ action: tick, kickBlocked: true, started: [started("A-1", "triage")] })) ?? "", /nothing running while a usage window was over its pace line/);
  });
  it("D6", "a step that keeps failing is never put down", () => {
    assert.match(fires("D6", obs({ items: [item("A-1", SLOT, { job: job("A-1", { failures: 9 }) })] })) ?? "", /failed 9 times/);
  });
  it("D7", "a live session with no workspace", () => {
    assert.match(fires("D7", obs({ items: [item("A-1", { kind: "session", role: "triage" }, { live: [{ id: "s1", role: "triage" }] })] })) ?? "", /no workspace/);
  });
  it("D8", "a review on an empty branch", () => {
    const g = new FakeGit();
    g.branches.set("scopesoup/A-1", g.main);
    assert.match(fires("D8", obs({ git: gitObs(g), started: [started("A-1", "review")] })) ?? "", /empty branch/);
  });
  it("E1", "an Item appears with no person's request", () => {
    assert.match(fires("E1", obs({ remote: { refusedRewrites: 0, down: false, items: 3, retries: 0 } }), obs({ remote: { refusedRewrites: 0, down: false, items: 4, retries: 0 } })) ?? "", /appeared/);
    // A leftover of an agent's with nothing unique may go; a person's tag, or a leftover with unique work, may not.
    const g = new FakeGit();
    g.deleted.push({ ref: "refs/tags/wip-A-1", madeBy: { item: key("A-1"), scopesoup: true }, unmerged: false });
    assert.equal(fires("E1", obs({ git: gitObs(g) })), null);
    g.deleted.push({ ref: "refs/tags/v1.0", madeBy: { scopesoup: false }, unmerged: false });
    assert.match(fires("E1", obs({ git: gitObs(g) })) ?? "", /v1.0 was deleted/);
  });
  it("E2", "a log line on the host was to be changed", () => {
    assert.match(fires("E2", obs({ remote: { refusedRewrites: 1, down: false, items: 0, retries: 0 } })) ?? "", /log line/);
  });
  it("E3", "an answer the person never sent", () => {
    assert.match(fires("E3", obs({ answers: [{ subject: { host: "metaBranch", kind: "work", id: "A-1" }, answer: "feet", by: "Ada", at: AT }] })) ?? "", /never sent/);
  });
  it("E4", "a session merged without being told, and nobody is told (decision 108)", () => {
    const g = new FakeGit();
    g.mergeToMain(g.commit([g.main], ["src/a.ts"], "work", "agent"), "session untold", key("A-1"));
    const session = { ref: { host: "scopesoup", kind: "session" as const, id: "s1" }, role: "implement" as const, subject: { host: "metaBranch", kind: "work" as const, id: "A-1" }, status: "succeeded" as const, attempt: 1, startedAt: AT };
    const o = obs({ action: tick, git: gitObs(g), items: [item("A-1", SLOT)], sessions: [session] });
    assert.match(fires("E4", o, o, o, o) ?? "", /without being told/);
    // Another machine's implementor merged it (multiplayer): that machine judges it.
    const elsewhere = obs({ action: tick, git: gitObs(g), items: [item("A-1", SLOT)] });
    assert.equal(fires("E4", elsewhere, elsewhere, elsewhere, elsewhere), null);
  });
  it("E5", "the queue merged an Item's change and its implementor merges it again (#238)", () => {
    const g = new FakeGit();
    g.mergeToMain(g.commit([g.main], ["src/a.ts"], "work", "agent"), "queue", key("A-1"));
    const first = obs({ git: gitObs(g), items: [item("A-1", SLOT)] });
    g.mergeToMain(g.commit([g.main], ["src/a.ts"], "work", "agent"), "session told", key("A-1"));
    assert.match(fires("E5", first, obs({ git: gitObs(g), items: [item("A-1", SLOT)] })) ?? "", /went to main again/);
    // Closed in between (done, then reopened): a new merge is new work.
    const closed = obs({ git: first.git, items: [item("A-1", SLOT, { item: { ...workItem("A-1"), state: "done" } })] });
    assert.equal(fires("E5", first, closed, obs({ git: gitObs(g), items: [item("A-1", SLOT)] })), null);
  });
  it("F1", "W changed with no event about the Item", () => {
    // A blocker a person's request closed frees the Item at once; the tick that reads it must say so.
    const blocked = obs({ action: tick, items: [item("A-1", { kind: "blocker", on: [key("A-9")] })] });
    const closed = obs({ action: { kind: "close", item: "A-9", state: "done" }, requests: [{ step: 1, path: "/api/item/edit", body: {}, status: 200, response: {}, item: "A-9" }], items: [item("A-1", { kind: "not-started" })] });
    assert.equal(fires("F1", blocked, closed), null);
    assert.match(fires("F1", blocked, closed, obs({ action: tick, items: [item("A-1", { kind: "not-started" })] })) ?? "", /no event about it/);
    assert.equal(fires("F1", blocked, closed, obs({ action: tick, events: [event(key("A-1"))], items: [item("A-1", { kind: "not-started" })] })), null);
    // A lost store takes the jobs with it, and no event can say that.
    assert.equal(fires("F1", obs({ action: tick, items: [item("A-1", SLOT)] }), obs({ action: { kind: "lose-store" } }), obs({ action: { kind: "release", item: "A-1" }, requests: [{ step: 1, path: "/api/item/release", body: {}, status: 200, response: {}, item: "A-1" }], items: [item("A-1", { kind: "not-started" })] })), null);
    assert.match(fires("F1", obs({ action: tick, items: [item("A-1", SLOT)] }), obs({ action: tick, items: [item("A-1", { kind: "person", why: "escalated" })] })) ?? "", /no event about it/);
    assert.equal(fires("F1", obs({ action: tick, items: [item("A-1", SLOT)] }), obs({ action: tick, events: [event(key("A-1"))], items: [item("A-1", { kind: "person", why: "escalated" })] })), null);
  });
  it("F2", "an accepted request with no event naming the person", () => {
    const o = obs({ events: [event(key("A-1"), "sync", "work.updated")], requests: [{ step: 1, path: "/api/item/edit", body: {}, status: 200, response: {}, item: "A-1" }] });
    assert.match(fires("F2", o) ?? "", /no event naming the person/);
  });
  it("F3", "a tick right after a tick writes an event", () => {
    assert.match(fires("F3", obs({ action: tick }), obs({ action: tick, events: [event(undefined, "orchestrator", "orchestrator.step")] })) ?? "", /orchestrator.step/);
    // A standing line with new words is news (the tick before started sessions); the same words again are not.
    const said = (reason: string): ScopeSoupEvent => ({ ...event(undefined, "orchestrator", "orchestrator.idle"), data: { reason } });
    assert.equal(fires("F3", obs({ action: tick }), obs({ action: tick, events: [said("2 sessions are running")] })), null);
    assert.match(fires("F3", obs({ action: tick, events: [said("2 sessions are running")] }), obs({ action: tick }), obs({ action: tick, events: [said("2 sessions are running")] })) ?? "", /orchestrator.idle/);
  });
  it("G1", "a switch is still started after a restart", () => {
    assert.match(fires("G1", obs(), obs({ action: { kind: "restart" } })) ?? "", /switch is started/);
    // A queued change after the level was lowered to 2: the restart ends the queue's run, and the implementor merges it (#264).
    const paused = { triage: "paused", implement: "paused", review: "paused", mergeQueue: "paused" };
    const queued = obs({ level: 2, items: [item("A-1", { kind: "queue" })] });
    const merges = obs({ level: 2, action: tick, switches: paused, items: [item("A-1", { kind: "start", role: "implement", cause: "switch" })] });
    assert.equal(fires("G1", queued, obs({ action: { kind: "restart" }, switches: paused, items: queued.items }), merges), null);
    assert.match(fires("G1", queued, obs({ action: { kind: "restart" }, switches: paused, items: queued.items }), { ...merges, level: 4 }) ?? "", /was queue before the restart/);
  });
  it("G2", "the tick threw", () => {
    assert.match(fires("G2", obs({ tickError: "boom" })) ?? "", /threw: boom/);
  });
  it("G3", "a closed Item starts again after the store was lost", () => {
    const lost = obs({ action: { kind: "lose-store" }, items: [item("A-1", NOTHING, { item: workItem("A-1", { state: "done" }) })] });
    assert.match(fires("G3", lost, obs({ action: tick, started: [started("A-1", "triage")] })) ?? "", /started again/);
  });
  it("H1", "an Item still waits after the fair tail", () => {
    assert.match(fires("H1", obs({ final: true, items: [item("A-1", SLOT, { card: card("A-1", { reason: "ready" }) })] })) ?? "", /still waits/);
  });
  it("H2", "two Items wait for each other", () => {
    const o = obs({ items: [item("A-1", { kind: "blocker", on: [key("A-2")] }), item("A-2", { kind: "blocker", on: [key("A-1")] })] });
    assert.match(fires("H2", o) ?? "", /waits for itself/);
  });
  it("H3", "Scope Soup's claim outlives its session by hours", () => {
    const claimed = workItem("A-1", { holder: { actor: { id: "scopesoup@laptop-a", name: "scopesoup on laptop-a", bot: true }, until: "2026-11-19T10:00:00.000Z" } });
    const at = (ms: number) => obs({ at: new Date(Date.parse(AT) + ms).toISOString(), items: [item("A-1", SLOT, { item: claimed })] });
    assert.match(fires("H3", at(0), at(3 * 3600_000)) ?? "", /outlived its session/);
    // A change waiting in this machine's merge queue is work under way: its claim stands (#229).
    const queued = (ms: number) => obs({ at: new Date(Date.parse(AT) + ms).toISOString(), items: [item("A-1", { kind: "queue" }, { item: claimed })] });
    assert.equal(fires("H3", queued(0), queued(3 * 3600_000)), null);
    // A text wait past 30 minutes that the card still gives as the reason; a parked job keeps the wait for its next step, and its card
    // asks the person, so that is no text wait (#268).
    const text = (reason: string, over: Partial<Where> = {}) => obs({ action: tick, at: "2026-11-18T11:00:00.000Z", items: [item("A-1", SLOT, { job: job("A-1", { writing: { from: "h", at: AT }, ...over }), card: card("A-1", { reason }) })] });
    assert.match(fires("H3", text("waits until the description written at a person's Accept is read back from metaBranch (at most 1 minute more)")) ?? "", /still waits for its text/);
    assert.equal(fires("H3", text("Answer the question: a rewrite of the description waits for a person", { parked: { as: "needs-decision", reason: "r", at: AT } })), null);
  });
  it("H4", "a person is waited for and the page offers nothing (#183)", () => {
    const o = obs({ items: [item("A-1", { kind: "person", why: "escalated" }, { served: { item: { ref: { host: "metaBranch", kind: "work", id: "A-1" }, title: "Item", state: "todo" }, lane: "backlog" } })] });
    assert.match(fires("H4", o) ?? "", /offers nothing/);
  });
  it("H5", "a free slot and an Item waiting only for one, and the tick starts nothing", () => {
    assert.match(fires("H5", obs({ items: [item("A-1", SLOT)] }), obs({ action: tick, tick: report(), items: [item("A-1", SLOT)] })) ?? "", /did not start it/);
    // Other machines' pushes got in first 5 times: the claim gave up ("the remote kept moving"), and the next tick tries again (#264).
    const raced = { refusedRewrites: 0, down: false, items: 0, retries: 5 };
    assert.equal(fires("H5", obs({ items: [item("A-1", SLOT)] }), obs({ action: tick, tick: report(), remote: raced, items: [item("A-1", SLOT)] })), null);
  });
  it("I1", "a branch of Scope Soup's belongs to no Item", () => {
    const g = new FakeGit();
    g.ensureWorktree("w-A-9", "scopesoup/A-9", key("A-9"));
    assert.match(fires("I1", obs({ git: gitObs(g) })) ?? "", /not an Item/);
  });
  it("I2", "a closed Item's worktree is still there", () => {
    const g = new FakeGit();
    g.ensureWorktree("w-A-1", "scopesoup/A-1", key("A-1"));
    const o = obs({ action: tick, git: gitObs(g), items: [item("A-1", NOTHING, { item: workItem("A-1", { state: "done" }) })] });
    assert.match(fires("I2", o, o, o, o) ?? "", /worktree w-A-1 is still there/);
    // A tag holding work found nowhere else may stay, once it was reported with its sha; not before.
    const h = new FakeGit();
    const sha = h.commit([h.main], ["src/a.ts"], "work on A-1", "agent");
    h.tags.set("wip-A-1", sha);
    h.owners.set("refs/tags/wip-A-1", { item: key("A-1"), scopesoup: true });
    const closed = item("A-1", NOTHING, { item: workItem("A-1", { state: "done" }) });
    const left = obs({ action: tick, git: gitObs(h), items: [closed] });
    assert.match(fires("I2", left, left, left, left) ?? "", /refs\/tags\/wip-A-1/);
    const kept = obs({ action: tick, git: gitObs(h), items: [closed], events: [{ ...event(key("A-1"), "orchestrator", "orchestrator.leftover_kept"), data: { ref: "refs/tags/wip-A-1", sha } }] });
    assert.equal(fires("I2", kept, left, left, left), null);
  });
  it("I3", "Scope Soup's branches grow with history", () => {
    const g = new FakeGit();
    for (let i = 0; i < 20; i++) g.branches.set(`scopesoup/old-${i}`, g.main);
    assert.match(fires("I3", obs({ git: gitObs(g) })) ?? "", /bound/);
  });
  it("I4", "a branch with work not on main is deleted", () => {
    const g = new FakeGit();
    g.ensureWorktree("w-A-1", "scopesoup/A-1", key("A-1"));
    g.branches.set("scopesoup/A-1", g.commit([g.main], ["src/a.ts"], "work", "agent"));
    g.deleteBranch("scopesoup/A-1");
    assert.match(fires("I4", obs({ git: gitObs(g) })) ?? "", /deleted with work/);
    // Judged when it happens: a deletion seen before (after a person's close) does not fire again later, after a reopen (#229).
    assert.equal(rule("I4").check(obs({ git: gitObs(g) }), obs({ git: gitObs(g) }), {}), null);
  });
  it("I5", "a session starts in a worktree with another Item's files", () => {
    const g = new FakeGit();
    g.ensureWorktree("w-A-1", "scopesoup/A-2", key("A-2")).dirty.push("src/a.ts");
    assert.match(fires("I5", obs({ git: gitObs(g), started: [started("A-1", "implement")] })) ?? "", /A-2's files/);
  });
  it("I6", "a person's branch is gone", () => {
    const g = new FakeGit();
    const before = obs({ git: gitObs(g) });
    g.branches.delete("feature/by-hand");
    assert.match(fires("I6", before, obs({ git: gitObs(g) })) ?? "", /feature\/by-hand/);
    // A person's tag, made while an Item runs, reported as an agent's leftover.
    const h = new FakeGit();
    h.personRefs(1);
    const told = { ...event(key("A-1"), "orchestrator", "orchestrator.leftover_kept"), data: { ref: "refs/tags/release-1", sha: h.main } };
    assert.match(fires("I6", obs({ git: gitObs(h), events: [told] })) ?? "", /release-1.*reported as an agent's/);
  });
  const LANES = ["blocked", "backlog", "todo", "in-progress", "in-review", "queued", "checking", "done"];
  it("J1", "an agent starts work on an Item in Backlog (#221)", () => {
    const before = obs({ lanes: LANES, items: [item("A-1", { kind: "not-started" }, { card: card("A-1", { lane: "backlog" }) })] });
    assert.match(fires("J1", before, obs({ lanes: LANES, started: [started("A-1", "triage")] })) ?? "", /was in Backlog/);
    // Before #221 the board has no To do lane, and the rule holds for nothing.
    assert.equal(fires("J1", obs({ items: before.items }), obs({ started: [started("A-1", "triage")] })), null);
    // A person's Triage on the Backlog Item: that one triage is theirs; an implement step is still an agent starting work there.
    const asked = ledger({ requests: [{ step: 1, path: "/api/item/move", body: { to: "triage" }, status: 200, response: {}, item: "A-1" }] });
    assert.equal(fires("J1", before, obs({ lanes: LANES, ledger: asked, started: [started("A-1", "triage")] })), null);
    assert.match(fires("J1", before, obs({ lanes: LANES, ledger: asked, started: [started("A-1", "implement")] })) ?? "", /implement session started on A-1/);
    // Asked on another machine's board as a pick, which this machine carries out (#264).
    const elsewhere = [{ step: 1, path: "/api/item/pick", body: { steps: [{ kind: "move", to: "triage" }] }, status: 202, response: {}, item: "A-1" }];
    assert.equal(fires("J1", before, obs({ lanes: LANES, requestsElsewhere: elsewhere, started: [started("A-1", "triage")] })), null);
  });
  it("J2", "an Item moves into To do with no person's move (#221)", () => {
    const at = (lane: string) => obs({ lanes: LANES, items: [item("A-1", { kind: "not-started" }, { card: card("A-1", { lane: lane as never }) })] });
    assert.match(fires("J2", at("backlog"), at("todo")) ?? "", /no person's move/);
    // A person's move: the lane edit, a claim, a hand-back, Implement anyway (work under way is never in Backlog). Dropping work is not.
    const by = (path: string, body: Record<string, unknown>) => ({ ...at("todo"), requests: [{ step: 1, path, body, status: 200, response: {}, item: "A-1" }] });
    for (const [path, body] of [["/api/item/edit", { lane: "todo" }], ["/api/item/claim", { id: "A-1" }], ["/api/item/handback", { id: "A-1" }], ["/api/item/move", { to: "implement" }], ["/api/item/pick", { steps: [{ kind: "lane", lane: "todo" }] }]] as const) {
      assert.equal(fires("J2", at("backlog"), by(path, body)), null, path);
    }
    assert.match(fires("J2", at("backlog"), by("/api/item/move", { to: "todo" })) ?? "", /no person's move/);
  });
  it("J3", "a new Item lands in To do (#221)", () => {
    const inTodo = obs({ lanes: LANES, items: [item("A-1", { kind: "not-started" }, { card: card("A-1", { lane: "todo" as never }) })] });
    assert.match(fires("J3", obs({ lanes: LANES }), inTodo) ?? "", /landed in To do/);
    // Read back after the store was lost: seen before, so not new (#229).
    assert.equal(fires("J3", inTodo, obs({ lanes: LANES }), inTodo), null);
  });
  it("J4", "Scope Soup chooses to triage again an Item in Backlog (#217)", () => {
    const before = obs({ lanes: LANES, items: [item("A-1", NOTHING, { card: card("A-1", { lane: "backlog" }), job: job("A-1", { step: "implement" }) })] });
    const chose = { ...event(key("A-1"), "orchestrator", "orchestrator.triage_again"), data: { background: true } };
    assert.match(fires("J4", before, obs({ lanes: LANES, events: [chose] })) ?? "", /in Backlog and Scope Soup chose to triage it again/);
    // In To do it may; a person's Triage or answer in Backlog writes no such event.
    const inTodo = obs({ lanes: LANES, items: [item("A-1", NOTHING, { card: card("A-1", { lane: "todo" as never }), job: job("A-1", { step: "implement" }) })] });
    assert.equal(fires("J4", inTodo, obs({ lanes: LANES, events: [chose] })), null);
    assert.equal(fires("J4", before, obs({ lanes: LANES, started: [started("A-1", "triage", { vars: { itemTitle: "Item A-1", itemBody: "Do it.", recheck: "A person answered." } })] })), null);
  });
});

type Shrunk = Omit<RunOptions, "items" | "level" | "slots"> & { items: number; level: number; slots: number };

/** A run the simulator shrank, replayed: it fails the rule on today's code. When the code is fixed, the test is turned round (`holdsOn`). */
async function failsOn(id: string, options: Shrunk, actions: Action[]): Promise<void> {
  const result = await play(1, options as RunOptions, actions, RULES.filter((each) => each.id === id));
  assert.ok(result.failures.some((f) => f.rule === id), `${id} held on the pasted steps`);
}

// (None fail on today's code: known.ts holds the others' seeds, and `failsOn` is kept for the next one.)
void failsOn;

/** A run the simulator shrank once, replayed: since its fix the rule holds on it. */
async function holdsOn(id: string, options: Shrunk, actions: Action[]): Promise<void> {
  const result = await play(1, options as RunOptions, actions, RULES.filter((each) => each.id === id));
  assert.deepEqual(result.failures.filter((f) => f.rule === id).map((f) => f.message), []);
}

describe("runs the simulator shrank, held since their fix", { concurrency: 1 }, () => {
  // The checker's W fixed (#268): an implement step whose session a limit cut off has begun, so it waits for its timer, not the same files.
  test("A1: an implement session cut off by the limit resumes on its timer, held by no same-files wait", async () => {
    await holdsOn("A1", {items: 9, level: 2, slots: 1, steps: 600, profile: "calm", ageing: true}, [
      {kind: "tick"},
      {kind: "end", item: "A-1", v: 995829},
      {kind: "tick"},
      {kind: "end", item: "A-2", v: 686222},
      {kind: "answer", item: "A-1", v: 715631},
      {kind: "tick"},
      {kind: "answer", item: "A-2", v: 298307},
      {kind: "tick"},
      {kind: "clock", ms: 1000},
      {kind: "tick"},
      {kind: "end", item: "A-1", v: 996598},
      {kind: "tick"},
    ]);
  });

  // Fixed (#268): a lost store does not hand over a change approved before the work was dropped and triaged again.
  test("A1: approved, put back in To do, triaged blocked, then the store is lost: no hand-over is rebuilt", async () => {
    await holdsOn("A1", {items: 7, level: 2, slots: 3, steps: 600, profile: "rough", ageing: true}, [
      {kind: "level", to: 3},
      {kind: "tick"},
      {kind: "end", item: "A-2", v: 534778},
      {kind: "tick"},
      {kind: "clock", ms: 1860000},
      {kind: "tick"},
      {kind: "end", item: "A-2", v: 984367},
      {kind: "tick"},
      {kind: "clock", ms: 60000},
      {kind: "tick"},
      {kind: "end", item: "A-2", v: 752435},
      {kind: "tick"},
      {kind: "move", item: "A-2", v: 973302, keen: true},
      {kind: "move", item: "A-2", v: 51184, keen: true},
      {kind: "tick"},
      {kind: "end", item: "A-2", v: 86247},
      {kind: "tick"},
      {kind: "lose-store"},
      {kind: "tick"},
    ]);
  });

  // Fixed (#268): a step a person picked at a level below its switch runs while the agents are paused; the card says its timer.
  test("A1: Implement anyway at level 1, cut off by a restart: the card says when it starts, not that agents are paused", async () => {
    await holdsOn("A1", {items: 7, level: 3, slots: 2, steps: 600, profile: "rough", ageing: true}, [
      {kind: "close", item: "A-1", state: "abandoned"},
      {kind: "foreign-claim", item: "A-2"},
      {kind: "slots", to: 3},
      {kind: "level", to: 1},
      {kind: "tick"},
      {kind: "end", item: "A-5", v: 411021},
      {kind: "end", item: "A-3", v: 652790},
      {kind: "tick"},
      {kind: "end", item: "A-7", v: 844819},
      {kind: "tick"},
      {kind: "move", item: "A-7", v: 578128},
      {kind: "tick"},
      {kind: "restart"},
      {kind: "tick"},
    ]);
  });

  // Fixed (#268): a step Scope Soup's lost store would rebuild from the log is not rebuilt for an Item a person moved to Backlog.
  test("J1: the store lost after a move to Backlog, and the Item still claimed: no triage starts there", async () => {
    await holdsOn("J1", {items: 3, level: 4, slots: 2, steps: 600, profile: "calm", ageing: true}, [
      {kind: "tick"},
      {kind: "end", item: "A-2", v: 64492},
      {kind: "tick"},
      {kind: "lane", item: "A-2", to: "backlog"},
      {kind: "lose-store"},
      {kind: "switch", to: "resume"},
      {kind: "tick"},
    ]);
  });

  // Fixed (#223): a move's words, written by the park's set before the store read its questions back, answer every question of the set.
  test("A3: a move answers both questions of a park the store has not read back", async () => {
    await holdsOn("A3", {items: 6, level: 2, slots: 2, steps: 600, profile: "rough"}, [
      {kind: "tick"},
      {kind: "end", item: "A-1", v: 784594},
      {kind: "tick"},
      {kind: "move", item: "A-1", v: 848690},
    ]);
  });

  // Fixed (#223): the ceiling is read again right before a start, so one lowered while the tick awaits holds the next start.
  test("D1: slots lowered inside a tick hold the next start", async () => {
    await holdsOn("D1", {items: 9, level: 4, slots: 2, steps: 600, profile: "rough"}, [{ kind: "inside-tick", inner: { kind: "slots", to: 1 } }]);
  });

  // Fixed (#223): a job made again on an Item counts its parks on from the log, so a re-triage's park in the same instant as the one
  // before does not get its set, and the earlier answer does not release it.
  test("A3: a re-triage's questions are not released by the answer to the park before", async () => {
    await holdsOn("A3", {items: 11, level: 3, slots: 2, steps: 600, profile: "calm"}, [
      {kind: "tick"},
      {kind: "end", item: "A-1", v: 997478},
      {kind: "tick"},
      {kind: "end", item: "A-3", v: 399605},
      {kind: "tick"},
      {kind: "answer", item: "A-3", v: 147897},
      {kind: "tick"},
      {kind: "end", item: "A-3", v: 70262},
      {kind: "tick"},
      {kind: "tick"},
    ]);
  });

  // Fixed (#255): a commit no longer forgets what was said, so a tick after a tick that started sessions says its idle line once, new,
  // and the next one says nothing (F3 now tells news from the same words again).
  test("F3: ticks in a row say a standing line once", async () => {
    await holdsOn("F3", { items: 6, level: 4, slots: 2, steps: 80, profile: "normal" }, [{ kind: "tick" }, { kind: "tick" }, { kind: "tick" }]);
  });

  // Fixed (#230): the answer, in the same second as the question and from a name that sorts first, folded before it.
  test("A3: an answer to a not-ready triage closes its question on the host (#230)", async () => {
    await holdsOn("A3", { items: 6, level: 4, slots: 2, steps: 80, profile: "normal" }, [
      { kind: "tick" },
      { kind: "end", item: "A-1", v: 781588 },
      { kind: "tick" },
      { kind: "answer", item: "A-1", v: 672227 },
    ]);
  });

  test("I2 and C3: an Item closed while its triage runs keeps nothing: the session is stopped, the worktree and claim go (#229)", async () => {
    const steps: Action[] = [{ kind: "tick" }, { kind: "close", item: "A-1", state: "abandoned" }, { kind: "tick" }, { kind: "tick" }, { kind: "tick" }];
    await holdsOn("I2", { items: 5, level: 3, slots: 3, steps: 80, profile: "normal" }, steps);
    await holdsOn("C3", { items: 5, level: 3, slots: 3, steps: 80, profile: "normal" }, steps);
  });

  test("G1: a session ended by a restart starts its step again, not counted as a failure, so a third restart does not escalate it (#238)", async () => {
    await holdsOn("G1", { items: 10, level: 3, slots: 3, steps: 600, profile: "rough" }, [
      { kind: "tick" },
      { kind: "end", item: "A-3", v: 951361 },
      { kind: "restart" },
      { kind: "tick" },
      { kind: "level", to: 1 },
      { kind: "clock", ms: 60000 },
      { kind: "switch", to: "resume" },
      { kind: "tick" },
      { kind: "end", item: "A-1", v: 289275 },
      { kind: "tick" },
      { kind: "clock", ms: 60000 },
      { kind: "end", item: "A-5", v: 313800 },
      { kind: "tick" },
      { kind: "restart" },
      { kind: "tick" },
    ]);
  });

  test("I1: the store lost while the host is down: the Items read before still own their branches (the checker's own setup, #238)", async () => {
    await holdsOn("I1", { items: 12, level: 4, slots: 2, steps: 600, profile: "normal" }, [{ kind: "tick" }, { kind: "host-down", steps: 3 }, { kind: "lose-store" }]);
  });

  test("C3: a closed Item's open question ends with it (#229)", async () => {
    await holdsOn("C3", { items: 4, level: 4, slots: 1, steps: 80, profile: "calm" }, [
      { kind: "tick" },
      { kind: "end", item: "A-1", v: 209723 },
      { kind: "tick" },
      { kind: "close", item: "A-1", state: "done" },
      { kind: "tick" },
      { kind: "tick" },
      { kind: "tick" },
    ]);
  });
});
