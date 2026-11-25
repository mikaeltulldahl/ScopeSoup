// The State menu's moves (#154, src/server/moves.ts): triage again, back to the backlog, review now, the merge queue now. The
// rules, what each does to the job, and `POST /api/item/move` with its event, its refusals and its check that the Item did not change.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { T0, work } from "../core/testing.ts";
import type { ItemPage } from "../core/views.ts";
import type { Job } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs } from "../orchestrator/jobs.ts";
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
const job = (fields: Partial<Job> = {}): Job => ({ item: item.ref, workspace: "w7", branch: "scopesoup/7", step: "implement", failures: 0, fixRounds: 0, startedAt: T0, triage, ...fields });
const input = (fields: Partial<MoveInput> = {}): MoveInput => ({ item, job: job(), lane: "backlog", level: 4, mergeQueueOn: true, at: Date.parse(T0), ...fields });

describe("the rules", () => {
  test("triage again: a running implementor is interrupted; refused while the triage runs, an agent elsewhere or a person holds it, below level 1, and with no triage to drop", () => {
    assert.deepEqual(moveWhys(input()).triage, {});
    assert.deepEqual(moveWhys(input({ job: job({ sessionId: "s1" }) })).triage, {});
    assert.equal(moveWhys(input({ job: job({ sessionId: "s1", step: "triage" }) })).triage!.why, "the triage is on it now");
    const bot = { ...item, holder: { actor: { id: "scopesoup@laptop-b", name: "laptop-b", bot: true }, until: "2099-01-01T00:00:00Z" } };
    assert.equal(moveWhys(input({ item: bot, job: undefined })).triage!.why, "an agent on laptop-b is on it");
    const held = { ...item, holder: { actor: { id: "ana", name: "Ana" } } };
    assert.equal(moveWhys(input({ item: held })).triage!.why, "held by Ana");
    assert.equal(moveWhys(input({ level: 0 })).triage!.why, "triage is off at level 0");
    assert.equal(moveWhys(input({ job: undefined })).triage!.why, "in line for triage already");
    assert.equal(moveWhys(input({ job: job({ step: "triage" }) })).triage!.why, "next for triage already");
    assert.equal(moveWhys(input({ item: { ...item, state: "done" } })).triage!.why, "reopen it first");
  });

  test("back to the backlog: only with work under way; a person's hold is left to Release; a running session is interrupted", () => {
    assert.equal(moveWhys(input({ job: undefined })).backlog, undefined);
    assert.deepEqual(moveWhys(input()).backlog, {});
    assert.deepEqual(moveWhys(input({ item: { ...item, holder: { actor: { id: "ana", name: "Ana" } } } })).backlog, {});
    assert.deepEqual(moveWhys(input({ job: job({ sessionId: "s1", step: "review" }) })).backlog, {});
    assert.equal(moveWhys(input({ lane: "checking" })).backlog!.why, "the merge queue is checking it");
    assert.deepEqual(moveWhys(input({ liveRole: "implement" })).backlog, {});
  });

  test("an Item the merge queue holds (waiting, in a batch, merged) is not sent to triage or the backlog", () => {
    const signals: Partial<MoveInput>[] = [
      { job: job({ parked: { as: "queued", reason: "queued", at: T0 } }) },
      { job: job({ queued: "abc" }) },
      { job: job({ merged: "def" }) },
      { lane: "queued" },
    ];
    for (const signal of signals) {
      const whys = moveWhys(input(signal));
      assert.equal(whys.triage!.why, "it is in the merge queue", JSON.stringify(signal));
      assert.equal(whys.backlog!.why, "it is in the merge queue", JSON.stringify(signal));
    }
  });

  test("review now: needs a revision and the program, at any level; merge queue now: a reviewed change, at any level when the queue can run", () => {
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
    assert.deepEqual(moveWhys(input({ job: reviewed, level: 1 }))["merge-queue"], {});
    assert.equal(moveWhys(input({ job: reviewed, level: 1, needs: { queue: "the merge queue needs a check command (checkCommand)" } }))["merge-queue"]!.why, "the merge queue needs a check command (checkCommand)");
    assert.equal(moveWhys(input({ job: reviewed, mergeQueueOn: false }))["merge-queue"]!.why, "the merge queue is paused");
    assert.equal(moveWhys(input({ job: job({ head: "abc" }) }))["merge-queue"]!.why, "not reviewed yet");
    assert.equal(moveWhys(input({ job: { ...reviewed, sentBack: "abc" } }))["merge-queue"]!.why, "the merge queue sent it back; it needs a fix");
    assert.equal(moveWhys(input({ job: reviewed, lane: "queued" }))["merge-queue"]!.why, "in the merge queue already");
    // Approved on revision A, then a fix round made B: B is not reviewed (an approval with \`should\` findings, or a new In review).
    assert.equal(moveWhys(input({ job: { ...reviewed, head: "b2", parked: undefined } }))["merge-queue"]!.why, "not reviewed yet");
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
    assert.deepEqual([jobs[key]!.step, jobs[key]!.head, jobs[key]!.agentSession, jobs[key]!.recheck?.reasons, jobs[key]!.recheck?.previous], ["triage", undefined, undefined, ["Ada asked for it on the board"], triage]);

    const review = { [key]: job({ head: "abc", parked: { as: "handed-over", reason: "x", at: T0 } }) };
    assert.equal(applyMove(review, key, "in-review", input({ job: review[key], level: 3 }), "Ada", T0).ok, true);
    assert.deepEqual([review[key]!.step, review[key]!.parked], ["review", undefined]);

    const queue = { [key]: job({ head: "abc", reviewedHead: "abc", step: "review", review: { verdict: "approve", findings: [] }, parked: { as: "handed-over", reason: "x", at: T0 } }) };
    assert.equal(applyMove(queue, key, "merge-queue", input({ job: queue[key] }), "Ada", T0).ok, true);
    assert.deepEqual([queue[key]!.owes, queue[key]!.owesAskedBy, queue[key]!.parked], ["hand-over", "Ada", undefined]);

    // Back to the backlog only marks the job: the tick drops it and gives back the claim and workspace.
    const drop = { [key]: job() };
    assert.equal(applyMove(drop, key, "backlog", input(), "Ada", T0).ok, true);
    assert.equal(drop[key]?.dropAskedBy, "Ada");
    assert.equal(moveWhys(input({ job: drop[key] })).backlog!.why, "back to the backlog already");
  });

  test("a move that replaces the step that runs marks the job for the tick to end that session; In review and Merge queue are marked as a person's", () => {
    const drop = { [key]: job({ sessionId: "s" }) };
    const dropped = applyMove(drop, key, "backlog", input({ job: drop[key] }), "Ada", T0);
    assert.ok(dropped.ok && /The implementor's session is ended now/.test(dropped.reason));
    assert.deepEqual([drop[key]!.dropAskedBy, drop[key]!.interrupt, drop[key]!.sessionId], ["Ada", { by: "Ada", at: T0, to: "backlog" }, "s"]);

    const triaged = { [key]: job({ sessionId: "s", head: "abc" }) };
    assert.ok(applyMove(triaged, key, "triage", input({ job: triaged[key] }), "Ada", T0).ok);
    assert.deepEqual([triaged[key]!.step, triaged[key]!.sessionId, triaged[key]!.interrupt?.to], ["triage", "s", "triage"]);

    const review = { [key]: job({ head: "abc", sessionId: "s", resumeWith: "fix it" }) };
    assert.ok(applyMove(review, key, "in-review", input({ job: review[key], level: 1 }), "Ada", T0).ok);
    assert.deepEqual([review[key]!.step, review[key]!.reviewAskedBy, review[key]!.interrupt?.to, review[key]!.resumeWith], ["review", "Ada", "in-review", undefined]);

    // A session the store has as live (starting, before the tick saved its id) counts too.
    const starting = { [key]: job({ head: "abc" }) };
    assert.ok(applyMove(starting, key, "in-review", input({ job: starting[key], liveRole: "implement" }), "Ada", T0).ok);
    assert.equal(starting[key]!.interrupt?.to, "in-review");

    const queue = { [key]: job({ head: "abc", reviewedHead: "abc", step: "review", review: { verdict: "approve", findings: [] }, parked: { as: "handed-over", reason: "x", at: T0 } }) };
    assert.ok(applyMove(queue, key, "merge-queue", input({ job: queue[key], level: 2 }), "Ada", T0).ok);
    assert.deepEqual([queue[key]!.queueAskedBy, queue[key]!.interrupt], ["Ada", undefined]);
  });

  test("an Item whose work runs on another machine: the moves are left to that machine, except what is known everywhere", () => {
    const bot = { ...item, holder: { actor: { id: "scopesoup@laptop-b", name: "scopesoup on laptop-b", bot: true }, until: "2099-01-01T00:00:00Z" } };
    const whys = moveWhys(input({ item: bot, job: undefined, elsewhere: "laptop-b" }));
    assert.deepEqual(whys, { triage: {}, backlog: {}, "in-review": {}, "merge-queue": {} });
    assert.equal(moveWhys(input({ item: bot, job: undefined, elsewhere: "laptop-b", needs: { queue: "the merge queue needs x" } }))["merge-queue"]!.why, "the merge queue needs x");
    assert.equal(moveWhys(input({ item: { ...bot, state: "done" }, job: undefined, elsewhere: "laptop-b" })).triage!.why, "reopen it first");
    assert.deepEqual(applyMove({}, key, "backlog", input({ item: bot, job: undefined, elsewhere: "laptop-b" }), "Ada", T0), { ok: false, why: "its work runs on laptop-b; pick it on the Item page, which asks that machine" });
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
    const none = await post({ ref: key, to: "backlog" });
    assert.equal(none.status, 409);
    saveJobs(store, { [key]: job({ head: "abc", sessionId: "s1", step: "review" }) });
    const running = await post({ ref: key, to: "in-review" });
    assert.equal(running.status, 409);
    assert.match(((await running.json()) as { error: { message: string } }).error.message, /in review already/);

    saveJobs(store, { [key]: job({ head: "abc" }) });
    const page = (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;
    assert.deepEqual(page.moves?.["in-review"], {});
    assert.equal(page.moves?.["merge-queue"]?.why, "not reviewed yet");
    const stale = await post({ ref: key, to: "in-review", seen: "2020-01-01T00:00:00Z" });
    assert.equal(stale.status, 409);
    assert.match(((await stale.json()) as { error: { message: string } }).error.message, /changed meanwhile/);
    const done = await post({ ref: key, to: "in-review", seen: page.item.updatedAt });
    assert.equal(done.status, 200);
    assert.equal(loadJobs(store)[key]?.step, "review");
    const event = store.eventsOfKinds(["person.moved"], 10)[0];
    assert.deepEqual([event?.actor, event?.subject, (event?.data as { to?: string }).to], ["Ada", key, "in-review"]);

    // Triage again by a person: the old triage goes, the job starts at triage.
    const again = await post({ ref: key, to: "triage" });
    assert.equal(again.status, 200);
    assert.deepEqual([loadJobs(store)[key]?.step, loadJobs(store)[key]?.recheck?.reasons], ["triage", ["Ada asked for it on the board"]]);
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
    assert.equal(loadJobs(store)[key]?.step, "review");

    // The second step is refused (level 3 has no merge queue): the first stays done, and the answer names it.
    saveJobs(store, { [key]: job({ head: "abc" }) });
    const two = await pick({ ref: key, seen, steps: [{ kind: "move", to: "in-review" }, { kind: "move", to: "merge-queue" }] });
    assert.equal(two.status, 409);
    assert.equal(((await two.json()) as { error: { message: string } }).error.message, "Moved; then refused: 7: not reviewed yet.");
    assert.equal(loadJobs(store)[key]?.step, "review");
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
  before(async () => {
    // One requests' log, as if both machines fetched the meta ref at once.
    lines = [];
    storeA = openStore(":memory:");
    storeB = openStore(":memory:");
    storeA.put(held, "sync", T0);
    storeB.put(held, "sync", T0);
    const common = { now: () => new Date(T0), port: 0, heartbeatMs: 20, configFile: "scopesoup.config.json", planning: () => ({ bugLabels: [], level: 2 }) };
    serverA = createServer({ ...common, store: storeA, requests: memoryRequests(lines, "laptop-a", () => T0) });
    serverB = createServer({ ...common, store: storeB, requests: memoryRequests(lines, "laptop-b", () => T0) });
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
    assert.deepEqual(before.moves?.backlog, {});
    const asked = await pickA({ ref: key, seen: before.item.updatedAt, steps: [{ kind: "move", to: "backlog" }] });
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
    assert.deepEqual([jobB.dropAskedBy, jobB.interrupt?.by, jobB.interrupt?.to], ["mira", "mira", "backlog"]);
    assert.equal(storeB.eventsOfKinds(["person.moved"], 10)[0]?.actor, "mira");
    const answer = JSON.parse(lines[1]!) as Record<string, unknown>;
    assert.deepEqual([answer.kind, (answer.by as { machine: string }).machine, answer.done], ["pick-done", "laptop-b", ["moved"]]);
    assert.equal((await pageA()).remote?.request?.state, "done");
  });

  test("a pick that machine refuses is written back with why; one nobody answered in time lapses and is never carried out", async () => {
    saveJobs(storeB, { [key]: job({ head: "abc" }) });
    const asked = await pickA({ ref: key, seen: held.updatedAt, steps: [{ kind: "move", to: "merge-queue" }] });
    assert.equal(asked.status, 202);
    assert.equal(await serverB.carryOutRequests(), 1);
    const refused = (await pageA()).remote?.request;
    assert.deepEqual([refused?.state, refused?.why], ["refused", "7: not reviewed yet."]);
    assert.equal(loadJobs(storeB)[key]?.owes, undefined);

    // A request written 20 minutes ago (laptop-b was off): it lapsed.
    await memoryRequests(lines, "laptop-a", () => new Date(Date.parse(T0) - 20 * 60_000).toISOString()).write({ kind: "pick", by: { who: "mira", agent: false }, fields: { id: "old-1", item: key, for: "laptop-b", seen: held.updatedAt, steps: [{ kind: "move", to: "backlog" }] } });
    assert.equal(await serverB.carryOutRequests(), 0);
    assert.equal((await pageA()).remote?.request?.state, "lapsed");
    assert.equal(loadJobs(storeB)[key]?.dropAskedBy, undefined);
  });
});
