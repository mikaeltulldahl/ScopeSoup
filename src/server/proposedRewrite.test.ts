// A rewrite of an Item's description that another Item's triage proposed with no question (decision 110): shown in "your turn" and
// on the Item page, decided with POST /api/proposed-rewrite, and never touching the Item's job.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { T0 } from "../core/testing.ts";
import type { WorkItem } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import { knownAnswers } from "../store/answers.ts";
import type { Job } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs, atStep } from "../orchestrator/jobs.ts";
import { readProposedRewrites, writeProposedRewrites } from "../orchestrator/aboutOthers.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

let store: Store;
let server: ScopeSoupServer;
let base: string;
let dir: string;

const at = new Date(T0).toISOString();
const later = new Date(Date.parse(at) + 3600_000).toISOString();
const key = (id: string) => `fake:work:${id}`;

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return { ref: { host: "fake", kind: "work", id }, title: `Item ${id}`, state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-01T00:00:00Z", ...over };
}

function job(id: string, over: Partial<Job>): Job {
  return { item: item(id).ref, workspace: `ws-${id}`, branch: `scopesoup/${id}`, failures: 0, fixRounds: 0, startedAt: at, at: atStep("implement"), ...over };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "scopesoup-proposed-"));
  const file = join(dir, "scopesoup.config.json");
  writeFileSync(file, JSON.stringify({ project: "demo", machineName: "laptop-a", repoPath: "repo", level: 3 }, null, 2) + "\n");
  store = openStore(":memory:");
  for (const id of ["1", "2", "3"]) store.put(item(id, { body: `Wind units ${id}.` }), "sync", at);
  // An approved change waiting for its merge turn, one in a backoff wait, and one triaged and parked as not ready.
  saveJobs(store, {
    [key("1")]: job("1", { at: { kind: "implement", run: { is: "waiting", notBefore: later }, merge: true }, fixRounds: 1, agentSession: "agent-1" }),
    [key("2")]: job("2", { at: atStep("implement", { is: "waiting", notBefore: later }), failures: 1 }),
    [key("3")]: job("3", { at: { kind: "parked", step: "triage", parked: { as: "not-ready", reason: "Triage: not ready. Which source?", at, verdict: true } } }),
  });
  writeProposedRewrites(store, Object.fromEntries(["1", "2", "3"].map((id) => [key(id), { askedBy: "triage of 9", from: key("9"), original: `Wind units ${id}.`, text: `Show wind ${id} in knots.`, at }])));
  server = createServer({ store, now: () => new Date(T0), port: 0, configFile: file, programFound: () => true, planning: () => ({ bugLabels: ["bug"], level: 3 }) });
  base = (await server.start()).url;
});

afterEach(async () => {
  await server.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const post = (body: unknown) => fetch(`${base}/api/proposed-rewrite`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });

test("a proposed rewrite is in your turn and on the Item page; Accept, Edit and Reject leave the Item's job exactly as it was", async () => {
  const jobsBefore = structuredClone(loadJobs(store));
  const page = (await (await fetch(`${base}/api/item?ref=${encodeURIComponent(key("2"))}`)).json()) as { proposedRewrite?: { askedBy: string; text: string; at: string } };
  assert.deepEqual(page.proposedRewrite, { askedBy: "triage of 9", original: "Wind units 2.", text: "Show wind 2 in knots.", at });
  const board = (await (await fetch(`${base}/api/board`)).json()) as { yourTurn: { key: string; waits?: string }[] };
  const two = board.yourTurn.find((card) => card.key === key("2"));
  assert.equal(two?.waits, "a rewrite to accept");

  assert.equal((await post({ ref: key("1"), at: "2020-01-01T00:00:00Z", action: "accept" })).status, 409);
  assert.equal((await post({ ref: key("1"), at, action: "edit", text: " " })).status, 400);
  assert.equal((await post({ ref: key("1"), at, action: "accept" })).status, 200);
  assert.equal((await post({ ref: key("2"), at, action: "edit", text: "Show wind 2 in knots, rounded." })).status, 200);
  assert.equal((await post({ ref: key("3"), at, action: "reject" })).status, 200);
  assert.equal((await post({ ref: key("3"), at, action: "reject" })).status, 409, "decided once");

  assert.deepEqual(loadJobs(store), jobsBefore);
  assert.deepEqual(readProposedRewrites(store), {});
  // This host's items are not written here: the accepted text is kept as the answer the agents use.
  const answers = knownAnswers(store).map((answer) => `${answer.subject.id}: ${answer.answer.split("\n")[1] ?? answer.answer}`);
  assert.deepEqual(answers, ["1: Show wind 1 in knots.", "2: Show wind 2 in knots, rounded."]);
  const kinds = store.eventsAfter(0, 1000).map((event) => event.kind).filter((kind) => kind.startsWith("orchestrator.rewrite_"));
  assert.deepEqual(kinds, ["orchestrator.rewrite_accepted", "orchestrator.rewrite_edited", "orchestrator.rewrite_rejected"]);
});

test("Accept is refused once the description was edited since the rewrite was written; Edit still decides it", async () => {
  store.put(item("1", { body: "Wind units, edited." }), "sync", at);
  const refused = await post({ ref: key("1"), at, action: "accept" });
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "BODY_CHANGED");
  assert.equal((await post({ ref: key("1"), at, action: "edit", text: "Wind units in knots." })).status, 200);
});
