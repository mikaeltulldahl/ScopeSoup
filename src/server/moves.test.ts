// The State menu's moves (#154, src/server/moves.ts): triage again, back to To do, review now, the merge queue now. The
// rules, what each does to the job, and `POST /api/item/move` with its event, its refusals and its check that the Item did not change.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { T0, work } from "../core/testing.ts";
import type { ItemPage } from "../core/views.ts";
import type { Job, Where } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs, where, jobOf } from "../orchestrator/jobs.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";
import type { MoveInput } from "./moves.ts";
import { applyMove, moveWhys } from "./moves.ts";
import { memoryRequests } from "../hosts/metaBranch/requests.ts";

const item = work(7, { title: "Tidy the dock" });
const key = refKey(item.ref);
const triage = { ready: true, size: "small" as const, paths: ["src/a.ts"], hidesDecision: false };
const job = (fields: Partial<Job & Where> = {}): Job => (jobOf({ item: item.ref, workspace: "w7", branch: "scopesoup/7", step: "implement", failures: 0, fixRounds: 0, startedAt: T0, triage, ...fields }));
const input = (fields: Partial<MoveInput> = {}): MoveInput => ({ item, job: job(), lane: "todo", level: 4, mergeQueueOn: true, at: Date.parse(T0), ...fields });

describe("the rules", () => {
  test("triage again: a running implementor is interrupted; refused while the triage runs, an agent elsewhere or a person holds it, below level 1, and with no triage to drop", () => {
    assert.deepEqual(moveWhys(input()).triage, {});
    assert.deepEqual(moveWhys(input({ job: job({ sessionId: "s1" }) })).triage, {});
    assert.equal(moveWhys(input({ job: job({ sessionId: "s1", step: "triage" }) })).triage!.why, "the triage is on it now");
    const bot = { ...item, holder: { actor: { id: "scopesoup@laptop-b", name: "laptop-b", bot: true }, until: "2099-01-01T00:00:00Z" } };
    assert.equal(moveWhys(input({ item: bot, job: undefined })).triage!.why, "an agent on laptop-b is on it");
    const held = { ...item, holder: { actor: { id: "ana", name: "Ana" } } };
    assert.equal(moveWhys(input({ item: held })).triage!.why, "held by Ana");
    // Level 0: a person's Triage makes the job (decision 104); it needs the agent program.
    assert.deepEqual(moveWhys(input({ level: 0, job: undefined })).triage, {});
    assert.equal(moveWhys(input({ level: 0, job: undefined, needs: { triage: "needs Claude Code" } })).triage!.why, "needs Claude Code");
    assert.equal(moveWhys(input({ job: undefined })).triage!.why, "in line for triage already");
    assert.equal(moveWhys(input({ job: job({ step: "triage" }) })).triage!.why, "next for triage already");
    assert.equal(moveWhys(input({ item: { ...item, state: "done" } })).triage!.why, "reopen it first");
  });

  test("back to To do: only with work under way; a person's hold is left to Release; a running session is interrupted", () => {
    assert.equal(moveWhys(input({ job: undefined })).todo, undefined);
    assert.deepEqual(moveWhys(input()).todo, {});
    assert.deepEqual(moveWhys(input({ item: { ...item, holder: { actor: { id: "ana", name: "Ana" } } } })).todo, {});
    assert.deepEqual(moveWhys(input({ job: job({ sessionId: "s1", step: "review" }) })).todo, {});
    assert.equal(moveWhys(input({ lane: "checking" })).todo!.why, "the merge queue is checking it");
    assert.deepEqual(moveWhys(input({ liveRole: "implement" })).todo, {});
  });

  test("an Item the merge queue holds (waiting, in a batch, merged) is not sent to triage or To do", () => {
    const signals: Partial<MoveInput>[] = [
      { job: job({ parked: { as: "queued", reason: "queued", at: T0 } }) },
      { job: job({ queued: "abc" }) },
      { job: job({ merged: "def" }) },
      { lane: "queued" },
    ];
    for (const signal of signals) {
      const whys = moveWhys(input(signal));
      assert.equal(whys.triage!.why, "it is in the merge queue", JSON.stringify(signal));
      assert.equal(whys.todo!.why, "it is in the merge queue", JSON.stringify(signal));
    }
  });

  test("review now: needs a revision and the program, at any level; merge queue now: a reviewed change, from level 4 only", () => {
    assert.equal(moveWhys(input())["in-review"]?.why, "nothing to review yet");
    assert.deepEqual(moveWhys(input({ job: job({ head: "abc" }), lane: "in-progress" }))["in-review"], {});
    for (const level of [0, 1, 2]) assert.deepEqual(moveWhys(input({ job: job({ head: "abc" }), level }))["in-review"], {}, `level ${level}`);
    assert.equal(moveWhys(input({ job: job({ head: "abc" }), needs: { review: "needs Claude Code" } }))["in-review"]!.why, "needs Claude Code");
    assert.equal(moveWhys(input({ job: job({ head: "abc", step: "review" }) }))["in-review"]!.why, "in review already");
    assert.equal(moveWhys(input({ job: job({ head: "abc", step: "review", sessionId: "s" }) }))["in-review"]!.why, "in review already");
    // A running implementor's fix round is interrupted by In review.
    assert.deepEqual(moveWhys(input({ job: job({ head: "abc", sessionId: "s" }) }))["in-review"], {});

    const reviewed = job({ head: "abc", reviewedHead: "abc", step: "review", review: { verdict: "approve", findings: [] }, parked: { as: "handed-over", reason: "reviewed", at: T0 } });
    assert.deepEqual(moveWhys(input({ job: reviewed, lane: "in-review" }))["merge-queue"], {});
    // Below level 4 the merge queue is not offered at all: it is Scope Soup's own.
    for (const level of [0, 1, 2, 3]) assert.equal(moveWhys(input({ job: reviewed, level }))["merge-queue"], undefined, `level ${level}`);
    assert.deepEqual(applyMove({ [key]: reviewed }, key, "merge-queue", input({ job: reviewed, level: 3 }), "Ada", T0), { ok: false, why: "the merge queue runs from level 4" });
    assert.equal(moveWhys(input({ job: reviewed, mergeQueueOn: false }))["merge-queue"]!.why, "the merge queue is paused");
    assert.equal(moveWhys(input({ job: job({ head: "abc" }) }))["merge-queue"]!.why, "not reviewed yet");
    assert.equal(moveWhys(input({ job: { ...reviewed, sentBack: "abc" } }))["merge-queue"]!.why, "the merge queue sent it back; it needs a fix");
    assert.equal(moveWhys(input({ job: reviewed, lane: "queued" }))["merge-queue"]!.why, "in the merge queue already");
    // Approved on revision A, then a fix round made B: B is not reviewed (an approval with \`should\` findings, or a new In review).
    assert.equal(moveWhys(input({ job: jobOf({ ...reviewed, head: "b2", parked: undefined }) }))["merge-queue"]!.why, "not reviewed yet");
    assert.equal(moveWhys(input({ job: { ...reviewed, reviewedHead: undefined } }))["merge-queue"]!.why, "not reviewed yet");
  });

  test("a job parked on a question waits for its answer: no review or merge queue from the menu", () => {
    for (const as of ["needs-decision", "escalated", "not-ready"] as const) {
      const parked = job({ head: "abc", reviewedHead: "abc", step: "review", review: { verdict: "approve", findings: [] }, parked: { as, reason: "which?", at: T0 } });
      assert.equal(moveWhys(input({ job: parked }))["in-review"]!.why, "it waits for an answer on this page", as);
      assert.equal(moveWhys(input({ job: parked }))["merge-queue"]!.why, "it waits for an answer on this page", as);
    }
    // A failed hand-over a person may retry is not a question.
    const retry = job({ head: "abc", reviewedHead: "abc", step: "review", review: { verdict: "approve", findings: [] }, parked: { as: "escalated", reason: "push failed", at: T0, retry: "hand-over" } });
    assert.deepEqual(moveWhys(input({ job: retry }))["merge-queue"], {});
  });

  test("each move changes the job as the orchestrator's own step would", () => {
    const jobs = { [key]: job({ head: "abc", agentSession: "a1", triaged: { at: T0, textHash: "h", title: "t", body: "", verification: "", blockers: [] } }) };
    const triaged = applyMove(jobs, key, "triage", input({ job: jobs[key] }), "Ada", "2026-11-25T10:00:00Z");
    assert.equal(triaged.ok, true);
    assert.deepEqual([where(jobs[key])!.step, jobs[key]!.head, jobs[key]!.agentSession, where(jobs[key])!.recheck?.reasons, where(jobs[key])!.recheck?.previous], ["triage", undefined, undefined, ["Ada asked for it on the board"], triage]);

    const review = { [key]: job({ head: "abc", parked: { as: "handed-over", reason: "x", at: T0 } }) };
    assert.equal(applyMove(review, key, "in-review", input({ job: review[key], level: 3 }), "Ada", T0).ok, true);
    assert.deepEqual([where(review[key])!.step, where(review[key])!.parked], ["review", undefined]);

    const queue = { [key]: job({ head: "abc", reviewedHead: "abc", step: "review", review: { verdict: "approve", findings: [] }, parked: { as: "handed-over", reason: "x", at: T0 } }) };
    assert.equal(applyMove(queue, key, "merge-queue", input({ job: queue[key] }), "Ada", T0).ok, true);
    assert.deepEqual([where(queue[key])!.owes, queue[key]!.owesAskedBy, where(queue[key])!.parked], ["hand-over", "Ada", undefined]);

    // Back to the backlog only marks the job: the tick drops it and gives back the claim and workspace.
    const drop = { [key]: job() };
    assert.equal(applyMove(drop, key, "todo", input(), "Ada", T0).ok, true);
    assert.equal(drop[key]?.dropAskedBy, "Ada");
    assert.equal(moveWhys(input({ job: drop[key] })).todo!.why, "back to To do already");
  });

  test("a move that replaces the step that runs marks the job for the tick to end that session; In review and Merge queue are marked as a person's", () => {
    const drop = { [key]: job({ sessionId: "s" }) };
    const dropped = applyMove(drop, key, "todo", input({ job: drop[key] }), "Ada", T0);
    assert.ok(dropped.ok && /The implementor's session is ended now/.test(dropped.reason));
    assert.deepEqual([drop[key]!.dropAskedBy, drop[key]!.interrupt, where(drop[key])!.sessionId], ["Ada", { by: "Ada", at: T0, to: "todo" }, "s"]);

    const triaged = { [key]: job({ sessionId: "s", head: "abc" }) };
    assert.ok(applyMove(triaged, key, "triage", input({ job: triaged[key] }), "Ada", T0).ok);
    assert.deepEqual([where(triaged[key])!.step, where(triaged[key])!.sessionId, triaged[key]!.interrupt?.to], ["triage", "s", "triage"]);

    const review = { [key]: job({ head: "abc", sessionId: "s", resumeWith: "fix it" }) };
    assert.ok(applyMove(review, key, "in-review", input({ job: review[key], level: 1 }), "Ada", T0).ok);
    assert.deepEqual([where(review[key])!.step, review[key]!.reviewAskedBy, review[key]!.interrupt?.to, review[key]!.resumeWith], ["review", "Ada", "in-review", undefined]);

    // A session the store has as live (starting, before the tick saved its id) counts too.
    const starting = { [key]: job({ head: "abc" }) };
    assert.ok(applyMove(starting, key, "in-review", input({ job: starting[key], liveRole: "implement" }), "Ada", T0).ok);
    assert.equal(starting[key]!.interrupt?.to, "in-review");

    const queue = { [key]: job({ head: "abc", reviewedHead: "abc", step: "review", review: { verdict: "approve", findings: [] }, sessionId: "s", reviewAskedBy: "Bo" }) };
    const queued = applyMove(queue, key, "merge-queue", input({ job: queue[key] }), "Ada", T0);
    assert.ok(queued.ok && /The reviewer's session is ended now/.test(queued.reason));
    // One ask at a time: the review asked for before is not asked for any more.
    assert.deepEqual([queue[key]!.queueAskedBy, queue[key]!.reviewAskedBy, queue[key]!.interrupt?.to], ["Ada", undefined, "merge-queue"]);
    // The hand-over is owed while the review the pick ends still runs: once the tick has ended it, the change is handed over.
    assert.deepEqual([where(queue[key])?.owes, where(queue[key])?.sessionId], ["hand-over", "s"]);
    const back = { [key]: job({ head: "abc", queueAskedBy: "Bo" }) };
    assert.ok(applyMove(back, key, "in-review", input({ job: back[key] }), "Ada", T0).ok);
    assert.deepEqual([back[key]!.reviewAskedBy, back[key]!.queueAskedBy], ["Ada", undefined]);

    // Level 0: Triage on an Item with no job makes one, asked for by the person.
    const none: Record<string, Job> = {};
    assert.ok(applyMove(none, key, "triage", input({ job: undefined, level: 0 }), "Ada", T0).ok);
    assert.deepEqual([where(none[key])?.step, none[key]?.triageAskedBy], ["triage", "Ada"]);
  });

  test("Implement anyway: only over triage's own not-ready verdict, at any level, as the person's ask for the implement step (decision 105)", () => {
    const verdict = (fields: Partial<Job & Where> = {}) => job({ step: "triage", parked: { as: "not-ready", reason: "Triage: too large for one change", at: T0, verdict: true }, ...fields });
    // Not offered without triage's verdict: a person's own stop, another parked state, or no parked state.
    assert.equal(moveWhys(input({ job: job({ step: "triage", parked: { as: "not-ready", reason: "A person answered: stop.", at: T0 } }) })).implement, undefined);
    assert.equal(moveWhys(input({ job: job({ parked: { as: "needs-decision", reason: "which?", at: T0 } }) })).implement, undefined);
    assert.equal(moveWhys(input()).implement, undefined);
    // Offered at any level, level 0 included; refused when the program is missing or a person holds it.
    for (const level of [0, 1, 2, 3, 4]) assert.deepEqual(moveWhys(input({ job: verdict(), level })).implement, {}, `level ${level}`);
    assert.equal(moveWhys(input({ job: verdict(), needs: { implement: "needs claude" } })).implement!.why, "needs claude");
    const held = { ...item, holder: { actor: { id: "bo", name: "Bo" } } };
    assert.equal(moveWhys(input({ item: held, job: verdict() })).implement!.why, "held by Bo");

    const jobs = { [key]: verdict({ reviewAskedBy: "Cy", notBefore: T0, reviewSendBacks: 3 }) };
    const done = applyMove(jobs, key, "implement", input({ job: jobs[key], level: 1 }), "Ada", T0);
    assert.ok(done.ok && /Ada overruled triage's verdict on 7 \(Implement anyway\)/.test(done.reason));
    assert.deepEqual([where(jobs[key])!.step, where(jobs[key])!.parked, jobs[key]!.implementAskedBy, jobs[key]!.reviewAskedBy, where(jobs[key])!.notBefore, jobs[key]!.triage], ["implement", undefined, "Ada", undefined, undefined, triage]);
    assert.equal(jobs[key]!.reviewSendBacks, undefined, "a fresh start: no step-up carried over");
    // Once it is under way, there is nothing to overrule.
    assert.deepEqual(applyMove(jobs, key, "implement", input({ job: jobs[key] }), "Ada", T0), { ok: false, why: "only triage's not-ready verdict can be overruled" });
    // Another pick replaces the ask.
    Object.assign(jobs[key]!, { head: "abc" });
    assert.equal(applyMove(jobs, key, "in-review", input({ job: jobs[key] }), "Ada", T0).ok, true);
    assert.equal(jobs[key]!.implementAskedBy, undefined);
  });

  test("an Item whose work runs on another machine: the moves are left to that machine, except what is known everywhere", () => {
    const bot = { ...item, holder: { actor: { id: "scopesoup@laptop-b", name: "scopesoup on laptop-b", bot: true }, until: "2099-01-01T00:00:00Z" } };
    const whys = moveWhys(input({ item: bot, job: undefined, elsewhere: "laptop-b" }));
    assert.deepEqual(whys, { triage: {}, todo: {}, "in-review": {}, "merge-queue": {} });
    assert.equal(moveWhys(input({ item: bot, job: undefined, elsewhere: "laptop-b", level: 3 }))["merge-queue"], undefined);
    assert.equal(moveWhys(input({ item: { ...bot, state: "done" }, job: undefined, elsewhere: "laptop-b" })).triage!.why, "reopen it first");
    assert.deepEqual(applyMove({}, key, "todo", input({ item: bot, job: undefined, elsewhere: "laptop-b" }), "Ada", T0), { ok: false, why: "its work runs on laptop-b; pick it on the Item page, which asks that machine" });
  });
});

describe("POST /api/item/move", () => {
  let store: Store;
  let server: ScopeSoupServer;
  let base: string;
  before(async () => {
    store = openStore(":memory:");
    store.put(item, "sync", T0);
    server = createServer({ store, now: () => new Date(T0), port: 0, heartbeatMs: 20, configFile: "scopesoup.config.json", planning: () => ({ bugLabels: [], level: 3 }) });
    base = (await server.start()).url;
  });
  after(async () => {
    await server.stop();
    store.close();
  });
  const post = (body: unknown, person = "Ada") => fetch(`${base}/api/item/move`, { method: "POST", headers: { "Content-Type": "application/json", ...(person ? { "X-ScopeSoup-Person": person } : {}) }, body: JSON.stringify(body) });

  test("names the person, refuses a bad body, an unknown Item, a changed Item and a move the rules refuse, and records who", async () => {
    assert.equal((await post({ ref: key, to: "triage" }, "")).status, 400);
    assert.equal((await post({ ref: key, to: "sideways" })).status, 400);
    assert.equal((await post({ ref: "fake:work:999", to: "triage" })).status, 404);
    // No job here: nothing to drop, and triage is next already.
    const none = await post({ ref: key, to: "todo" });
    assert.equal(none.status, 409);
    saveJobs(store, { [key]: job({ head: "abc", sessionId: "s1", step: "review" }) });
    const running = await post({ ref: key, to: "in-review" });
    assert.equal(running.status, 409);
    assert.match(((await running.json()) as { error: { message: string } }).error.message, /in review already/);

    saveJobs(store, { [key]: job({ head: "abc" }) });
    const page = (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;
    assert.deepEqual(page.moves?.["in-review"], {});
    assert.equal(page.moves?.["merge-queue"], undefined);
    const stale = await post({ ref: key, to: "in-review", seen: "2020-01-01T00:00:00Z" });
    assert.equal(stale.status, 409);
    assert.match(((await stale.json()) as { error: { message: string } }).error.message, /changed meanwhile/);
    const done = await post({ ref: key, to: "in-review", seen: page.item.updatedAt });
    assert.equal(done.status, 200);
    assert.equal(where(loadJobs(store)[key])?.step, "review");
    const event = store.eventsOfKinds(["person.moved"], 10)[0];
    assert.deepEqual([event?.actor, event?.subject, (event?.data as { to?: string }).to], ["Ada", key, "in-review"]);

    // Triage again by a person: the old triage goes, the job starts at triage.
    const again = await post({ ref: key, to: "triage" });
    assert.equal(again.status, 200);
    assert.deepEqual([where(loadJobs(store)[key])?.step, where(loadJobs(store)[key])?.recheck?.reasons], ["triage", ["Ada asked for it on the board"]]);
  });

  test("POST /api/item/pick runs a pick's steps in order in one request, checks what the page saw once, and says which went through", async () => {
    const pick = (body: unknown) => fetch(`${base}/api/item/pick`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
    const seen = ((await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage).item.updatedAt;
    assert.equal((await pick({ ref: key, seen, steps: [] })).status, 400);
    assert.equal((await pick({ ref: key, seen, steps: [{ kind: "explode" }] })).status, 400);
    assert.equal((await pick({ ref: key, steps: [{ kind: "move", to: "in-review" }] })).status, 400);
    const stale = await pick({ ref: key, seen: "2020-01-01T00:00:00Z", steps: [{ kind: "move", to: "in-review" }] });
    assert.equal(stale.status, 409);

    saveJobs(store, { [key]: job({ head: "abc" }) });
    const one = await pick({ ref: key, seen, steps: [{ kind: "move", to: "in-review" }] });
    assert.deepEqual([one.status, await one.json()], [200, { ref: key, done: ["moved"] }]);
    assert.equal(where(loadJobs(store)[key])?.step, "review");

    // The second step is refused (level 3 has no merge queue): the first stays done, and the answer names it.
    saveJobs(store, { [key]: job({ head: "abc" }) });
    const two = await pick({ ref: key, seen, steps: [{ kind: "move", to: "in-review" }, { kind: "move", to: "merge-queue" }] });
    assert.equal(two.status, 409);
    assert.equal(((await two.json()) as { error: { message: string } }).error.message, "Moved; then refused: 7: the merge queue runs from level 4.");
    assert.equal(where(loadJobs(store)[key])?.step, "review");

    // Implement anyway goes through the same pick: the seen check, the person's event, and History's words.
    saveJobs(store, { [key]: job({ step: "triage", parked: { as: "not-ready", reason: "Triage: not ready.", at: T0, verdict: true } }) });
    const page = (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;
    assert.deepEqual(page.moves?.implement, {});
    assert.equal((await pick({ ref: key, seen: "2020-01-01T00:00:00Z", steps: [{ kind: "move", to: "implement" }] })).status, 409);
    const anyway = await pick({ ref: key, seen: page.item.updatedAt, steps: [{ kind: "move", to: "implement" }] });
    assert.equal(anyway.status, 200);
    assert.deepEqual([where(loadJobs(store)[key])?.step, loadJobs(store)[key]?.implementAskedBy], ["implement", "Ada"]);
    const event = store.eventsOfKinds(["person.moved"], 10)[0];
    assert.deepEqual([event?.actor, (event?.data as { to?: string }).to], ["Ada", "implement"]);
    const activity = (await (await fetch(`${base}/api/activity`)).json()) as { rows: { text: string; who?: string }[] };
    assert.ok(activity.rows.some((row) => row.text === "Overruled triage: Implement anyway, on the board" && row.who === "Ada"));
  });
});

describe("Implement anyway answers the not-ready question the log holds open", () => {
  test("an answer line naming the question is written to the Item's log, so the card stops asking", async () => {
    const asked = { at: "2026-11-20T10:00:00Z", by: { id: "scopesoup", name: "scopesoup", bot: true }, question: "Triage: not ready.", options: [] };
    const waiting = { ...item, needsDecision: true, openQuestions: [asked] };
    const store = openStore(":memory:");
    store.put(waiting, "sync", T0);
    saveJobs(store, { [key]: job({ step: "triage", parked: { as: "not-ready", reason: "Triage: not ready.", at: T0, verdict: true } }) });
    const written: { kind: string; fields: Record<string, unknown> }[] = [];
    const write = { appendLog: async (_ref: unknown, line: { kind: string; fields: Record<string, unknown> }) => { written.push(line); return { shared: true }; } };
    const server = createServer({ store, now: () => new Date(T0), port: 0, heartbeatMs: 20, configFile: "scopesoup.config.json", planning: () => ({ bugLabels: [], level: 3 }), items: { host: item.ref.host, write: write as never } });
    try {
      const base = (await server.start()).url;
      const response = await fetch(`${base}/api/item/move`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: key, to: "implement" }) });
      assert.equal(response.status, 200);
      assert.deepEqual(written.map((line) => [line.kind, line.fields.to]), [["answer", asked.at]]);
    } finally {
      await server.stop();
      store.close();
    }
  });
});

describe("a pick for an Item whose work runs on another machine (decision 104)", () => {
  const held = { ...item, holder: { actor: { id: "scopesoup@laptop-b", name: "scopesoup on laptop-b", bot: true }, until: "2099-01-01T00:00:00Z" } };
  let lines: string[];
  let storeA: Store;
  let storeB: Store;
  let serverA: ScopeSoupServer;
  let serverB: ScopeSoupServer;
  let baseA: string;
  /** The clock of both machines, in milliseconds. */
  let clock = Date.parse(T0);
  before(async () => {
    // One requests' log, as if both machines fetched the meta ref at once.
    lines = [];
    storeA = openStore(":memory:");
    storeB = openStore(":memory:");
    storeA.put(held, "sync", T0);
    storeB.put(held, "sync", T0);
    const common = { now: () => new Date(clock), port: 0, heartbeatMs: 20, configFile: "scopesoup.config.json", planning: () => ({ bugLabels: [], level: 2 }) };
    serverA = createServer({ ...common, store: storeA, requests: memoryRequests(lines, "laptop-a", () => new Date(clock).toISOString()) });
    serverB = createServer({ ...common, store: storeB, requests: memoryRequests(lines, "laptop-b", () => new Date(clock).toISOString()) });
    baseA = (await serverA.start()).url;
    await serverB.start();
  });
  after(async () => {
    await Promise.all([serverA.stop(), serverB.stop()]);
    storeA.close();
    storeB.close();
  });
  const pageA = async () => (await (await fetch(`${baseA}/api/item?ref=${key}`)).json()) as ItemPage;
  const pickA = (body: unknown) => fetch(`${baseA}/api/item/pick`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "mira" }, body: JSON.stringify(body) });

  test("is written as a request, carried out by that machine through the same code, and its answer shows on the first board", async () => {
    // laptop-b runs the implementor on it.
    saveJobs(storeB, { [key]: job({ sessionId: "s1" }) });
    const before = await pageA();
    assert.equal(before.remote?.machine, "laptop-b");
    assert.deepEqual(before.moves?.todo, {});
    const asked = await pickA({ ref: key, seen: before.item.updatedAt, steps: [{ kind: "move", to: "todo" }] });
    assert.equal(asked.status, 202);
    assert.equal(((await asked.json()) as { requested: { for: string } }).requested.for, "laptop-b");
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual([line.kind, line.for, line.item, line.seen, (line.by as { who: string; machine: string }).who, (line.by as { machine: string }).machine], ["pick", "laptop-b", key, before.item.updatedAt, "mira", "laptop-a"]);
    assert.equal(loadJobs(storeA)[key], undefined, "nothing changes on the board's own machine");
    assert.equal((await pageA()).remote?.request?.state, "pending");

    // laptop-b fetches: the pick is made there, as mira, and the running session is marked to be ended.
    assert.equal(await serverB.carryOutRequests(), 1);
    assert.equal(await serverB.carryOutRequests(), 0, "once");
    const jobB = loadJobs(storeB)[key]!;
    assert.deepEqual([jobB.dropAskedBy, jobB.interrupt?.by, jobB.interrupt?.to], ["mira", "mira", "todo"]);
    assert.equal(storeB.eventsOfKinds(["person.moved"], 10)[0]?.actor, "mira");
    const answer = JSON.parse(lines[1]!) as Record<string, unknown>;
    assert.deepEqual([answer.kind, (answer.by as { machine: string }).machine, answer.done], ["pick-done", "laptop-b", ["moved"]]);
    assert.equal((await pageA()).remote?.request?.state, "done");
  });

  test("Backlog is one request, the work dropped then the lane, and nothing changes here (decision 121)", async () => {
    saveJobs(storeB, { [key]: job({ sessionId: "s1" }) });
    const before = await pageA();
    const count = lines.length;
    const asked = await pickA({ ref: key, seen: before.item.updatedAt, steps: [{ kind: "move", to: "todo" }, { kind: "lane", lane: "backlog" }] });
    assert.equal(asked.status, 202);
    const line = JSON.parse(lines[count]!) as Record<string, unknown>;
    assert.deepEqual([line.seen, line.steps], [before.item.updatedAt, [{ kind: "move", to: "todo" }, { kind: "lane", lane: "backlog" }]]);
    assert.equal((await pageA()).item.updatedAt, before.item.updatedAt, "the lane is written there, after the drop");
    // That machine drops the work first; the lane edit then needs a writable host there (none in this test), so it is refused there.
    assert.equal(await serverB.carryOutRequests(), 1);
    assert.equal(loadJobs(storeB)[key]?.dropAskedBy, "mira");
  });

  test("a pick that machine refuses is written back with why; one nobody answered in time lapses and is never carried out", async () => {
    saveJobs(storeB, { [key]: job({ head: "abc" }) });
    const asked = await pickA({ ref: key, seen: held.updatedAt, steps: [{ kind: "move", to: "merge-queue" }] });
    assert.equal(asked.status, 202);
    assert.equal(await serverB.carryOutRequests(), 1);
    const refused = (await pageA()).remote?.request;
    assert.deepEqual([refused?.state, refused?.why], ["refused", "7: the merge queue runs from level 4."]);
    assert.equal(where(loadJobs(storeB)[key])?.owes, undefined);

    // A request written 70 minutes ago by its own clock (laptop-b was off): it lapsed.
    const write = (id: string, at: number, by = { who: "mira", agent: false }) => memoryRequests(lines, "laptop-a", () => new Date(at).toISOString()).write({ kind: "pick", by, fields: { id, item: key, for: "laptop-b", seen: held.updatedAt, steps: [{ kind: "move", to: "todo" }] } });
    await write("old-1", clock - 70 * 60_000);
    assert.equal(await serverB.carryOutRequests(), 0);
    assert.equal((await pageA()).remote?.request?.state, "lapsed");
    assert.equal(loadJobs(storeB)[key]?.dropAskedBy, undefined);
  });

  test("a request lapses 15 minutes after this machine first saw it, whatever the writer's clock; one dated ahead is refused; an agent's line is no request", async () => {
    saveJobs(storeB, { [key]: job() });
    // laptop-a's clock is 10 minutes behind: by its time the request is old already, by laptop-b's first sight it is new.
    await write2("skewed", clock - 10 * 60_000);
    // laptop-b was busy: it reads it, but carries it out only later, past 15 minutes from its first sight.
    assert.equal((await pageA()).remote?.request?.state, "pending");
    clock += 16 * 60_000;
    assert.equal((await pageA()).remote?.request?.state, "lapsed");
    clock -= 16 * 60_000;

    // Dated 5 minutes ahead of laptop-b's clock: refused, with why.
    await write2("ahead", clock + 5 * 60_000);
    assert.equal(await serverB.carryOutRequests(), 2);
    const refused = readAnswers().get("ahead");
    assert.match(String(refused?.why), /dated 5 minutes ahead of this machine's clock/);

    // A line an agent wrote is not a request: never carried out, and not shown.
    await write2("forged", clock, { who: "scopesoup", agent: true });
    assert.equal(await serverB.carryOutRequests(), 0);
    assert.equal(readAnswers().has("forged"), false);
  });

  test("a request taken is never carried out twice, even by a restarted server on the same store", async () => {
    saveJobs(storeB, { [key]: job() });
    await write2("once", clock);
    const again = createServer({ store: storeB, now: () => new Date(clock), port: 0, configFile: "scopesoup.config.json", planning: () => ({ bugLabels: [], level: 2 }), requests: memoryRequests(lines, "laptop-b", () => new Date(clock).toISOString()) });
    // The first server takes it (its answer is not written yet, as if it stopped there): the store remembers it.
    storeB.setValue("pickRequests.taken", JSON.stringify(["once"]));
    assert.equal(await again.carryOutRequests(), 0);
    assert.equal(loadJobs(storeB)[key]?.dropAskedBy, undefined);
  });

  test("an answer that could not be pushed is kept and pushed at the next fetch, and the pick is not carried out again", async () => {
    saveJobs(storeB, { [key]: job() });
    await write2("flaky", clock);
    let failures = 2;
    const port = memoryRequests(lines, "laptop-b", () => new Date(clock).toISOString());
    const flaky = { ...port, write: async (line: Parameters<typeof port.write>[0]) => (failures-- > 0 ? ({ ok: false, error: "the remote kept moving" } as const) : port.write(line)) };
    const server = createServer({ store: storeB, now: () => new Date(clock), port: 0, configFile: "scopesoup.config.json", planning: () => ({ bugLabels: [], level: 2 }), requests: flaky });
    const answers = () => lines.filter((line) => line.includes('"pick-') && line.includes('"flaky"'));
    assert.equal(await server.carryOutRequests(), 1);
    assert.equal(answers().length, 0);
    assert.equal(await server.carryOutRequests(), 0, "pushed again: still failing");
    assert.equal(answers().length, 0);
    assert.equal(await server.carryOutRequests(), 1, "lands");
    assert.equal(answers().length, 1);
    assert.equal(await server.carryOutRequests(), 0);
    assert.equal(answers().length, 1, "one answer line");
    assert.equal(storeB.getValue("pickRequests.taken")?.split("flaky").length, 2, "carried out once");
  });

  const write2 = (id: string, at: number, by = { who: "mira", agent: false }) => memoryRequests(lines, "laptop-a", () => new Date(at).toISOString()).write({ kind: "pick", by, fields: { id, item: key, for: "laptop-b", seen: held.updatedAt, steps: [{ kind: "move", to: "todo" }] } });
  const readAnswers = () => new Map(lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.kind === "pick-refused" || line.kind === "pick-done").map((line) => [String(line.request), line]));
});
