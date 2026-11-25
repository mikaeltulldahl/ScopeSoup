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

const item = work(7, { title: "Tidy the dock" });
const key = refKey(item.ref);
const triage = { ready: true, size: "small" as const, paths: ["src/a.ts"], hidesDecision: false };
const job = (fields: Partial<Job> = {}): Job => ({ item: item.ref, workspace: "w7", branch: "scopesoup/7", step: "implement", failures: 0, fixRounds: 0, startedAt: T0, triage, ...fields });
const input = (fields: Partial<MoveInput> = {}): MoveInput => ({ item, job: job(), lane: "backlog", level: 4, mergeQueueOn: true, at: Date.parse(T0), ...fields });

describe("the rules", () => {
  test("triage again: refused while a session runs, an agent elsewhere or a person holds it, below level 1, and with no triage to drop", () => {
    assert.deepEqual(moveWhys(input()).triage, {});
    assert.match(moveWhys(input({ job: job({ sessionId: "s1" }) })).triage!.why!, /the implementor is on it now/);
    const bot = { ...item, holder: { actor: { id: "scopesoup@laptop-b", name: "laptop-b", bot: true }, until: "2099-01-01T00:00:00Z" } };
    assert.equal(moveWhys(input({ item: bot, job: undefined })).triage!.why, "an agent on laptop-b is on it");
    const held = { ...item, holder: { actor: { id: "ana", name: "Ana" } } };
    assert.equal(moveWhys(input({ item: held })).triage!.why, "held by Ana");
    assert.equal(moveWhys(input({ level: 0 })).triage!.why, "triage is off at level 0");
    assert.equal(moveWhys(input({ job: undefined })).triage!.why, "in line for triage already");
    assert.equal(moveWhys(input({ job: job({ step: "triage" }) })).triage!.why, "next for triage already");
    assert.equal(moveWhys(input({ item: { ...item, state: "done" } })).triage!.why, "reopen it first");
  });

  test("back to the backlog: only with work under way; a person's hold is left to Release, a running session refuses it", () => {
    assert.equal(moveWhys(input({ job: undefined })).backlog, undefined);
    assert.deepEqual(moveWhys(input()).backlog, {});
    assert.deepEqual(moveWhys(input({ item: { ...item, holder: { actor: { id: "ana", name: "Ana" } } } })).backlog, {});
    assert.match(moveWhys(input({ job: job({ sessionId: "s1", step: "review" }) })).backlog!.why!, /the reviewer is on it now/);
    assert.equal(moveWhys(input({ lane: "checking" })).backlog!.why, "the merge queue is checking it");
  });

  test("review now: needs a revision and level 3; merge queue now: a reviewed change at level 4 with the queue running", () => {
    assert.equal(moveWhys(input())["in-review"]?.why, "nothing to review yet");
    assert.deepEqual(moveWhys(input({ job: job({ head: "abc" }), lane: "in-progress" }))["in-review"], {});
    assert.equal(moveWhys(input({ job: job({ head: "abc" }), level: 2 }))["in-review"]!.why, "review is off below level 3");
    assert.equal(moveWhys(input({ job: job({ head: "abc", step: "review" }) }))["in-review"]!.why, "in review already");

    const reviewed = job({ head: "abc", step: "review", review: { verdict: "approve", findings: [] }, parked: { as: "handed-over", reason: "reviewed", at: T0 } });
    assert.deepEqual(moveWhys(input({ job: reviewed, lane: "in-review" }))["merge-queue"], {});
    assert.equal(moveWhys(input({ job: reviewed, level: 3 }))["merge-queue"]!.why, "the merge queue is off below level 4");
    assert.equal(moveWhys(input({ job: reviewed, mergeQueueOn: false }))["merge-queue"]!.why, "the merge queue is paused");
    assert.equal(moveWhys(input({ job: job({ head: "abc" }) }))["merge-queue"]!.why, "not reviewed yet");
    assert.equal(moveWhys(input({ job: { ...reviewed, sentBack: "abc" } }))["merge-queue"]!.why, "the merge queue sent it back; it needs a fix");
    assert.equal(moveWhys(input({ job: reviewed, lane: "queued" }))["merge-queue"]!.why, "in the merge queue already");
  });

  test("each move changes the job as the orchestrator's own step would", () => {
    const jobs = { [key]: job({ head: "abc", agentSession: "a1", triaged: { at: T0, textHash: "h", title: "t", body: "", verification: "", blockers: [] } }) };
    const triaged = applyMove(jobs, key, "triage", input({ job: jobs[key] }), "Ada", "2026-11-25T10:00:00Z");
    assert.equal(triaged.ok, true);
    assert.deepEqual([jobs[key]!.step, jobs[key]!.head, jobs[key]!.agentSession, jobs[key]!.recheck?.reasons, jobs[key]!.recheck?.previous], ["triage", undefined, undefined, ["Ada asked for it on the board"], triage]);

    const review = { [key]: job({ head: "abc", parked: { as: "escalated", reason: "x", at: T0 } }) };
    assert.equal(applyMove(review, key, "in-review", input({ job: review[key], level: 3 }), "Ada", T0).ok, true);
    assert.deepEqual([review[key]!.step, review[key]!.parked], ["review", undefined]);

    const queue = { [key]: job({ head: "abc", step: "review", review: { verdict: "approve", findings: [] }, parked: { as: "handed-over", reason: "x", at: T0 } }) };
    assert.equal(applyMove(queue, key, "merge-queue", input({ job: queue[key] }), "Ada", T0).ok, true);
    assert.deepEqual([queue[key]!.owes, queue[key]!.owesAskedBy, queue[key]!.parked], ["hand-over", "Ada", undefined]);

    const drop = { [key]: job() };
    assert.equal(applyMove(drop, key, "backlog", input(), "Ada", T0).ok, true);
    assert.equal(drop[key], undefined);
    assert.deepEqual(applyMove({ [key]: job({ sessionId: "s" }) }, key, "backlog", input({ job: job({ sessionId: "s" }) }), "Ada", T0), { ok: false, why: "the implementor is on it now; wait for it to finish" });
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
    saveJobs(store, { [key]: job({ head: "abc", sessionId: "s1" }) });
    const running = await post({ ref: key, to: "in-review" });
    assert.equal(running.status, 409);
    assert.match(((await running.json()) as { error: { message: string } }).error.message, /the implementor is on it now/);

    saveJobs(store, { [key]: job({ head: "abc" }) });
    const page = (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;
    assert.deepEqual(page.moves?.["in-review"], {});
    assert.equal(page.moves?.["merge-queue"]?.why, "the merge queue is off below level 4");
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
});
