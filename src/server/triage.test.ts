// The overview's one line at level 0: how many ready Items have no triage. No endpoint runs a triage. From
// level 1 the backlog's divider.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { T0 } from "../core/testing.ts";
import type { WorkItem } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { Jobs } from "../orchestrator/jobs.ts";
import { saveJobs } from "../orchestrator/jobs.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

let store: Store;
let server: ScopeSoupServer;
let base: string;
let dir: string;
let level: number;

const at = new Date(T0).toISOString();

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return { ref: { host: "fake", kind: "work", id }, title: `Item ${id}`, state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-01T00:00:00Z", ...over };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "scopesoup-triage-"));
  const file = join(dir, "scopesoup.config.json");
  writeFileSync(file, JSON.stringify({ project: "demo", machineName: "laptop-a", repoPath: "repo", level: 0 }, null, 2) + "\n");
  level = 0;
  store = openStore(":memory:");
  store.put(item("1"), "sync", at);
  store.put(item("2"), "sync", at);
  // A triage session line in its log: it has had its triage.
  store.put(item("3", { log: [{ at, by: { who: "scopesoup", agent: true }, kind: "session", fields: { role: "triage" } }] }), "sync", at);
  store.put(item("4", { state: "done" }), "sync", at);
  // A request stored earlier's offer is ignored.
  store.setValue("orchestrator.triages", JSON.stringify(["fake:work:1"]));
  server = createServer({ store, now: () => new Date(T0), port: 0, configFile: file, programFound: () => true, planning: () => ({ bugLabels: ["bug"], level }) });
  base = (await server.start()).url;
});

afterEach(async () => {
  await server.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const board = async () => ((await (await fetch(`${base}/api/board`)).json()) as { withoutTriage?: number }).withoutTriage;

test("at level 0 the board counts the ready Items with no triage; above 0 it says nothing", async () => {
  assert.equal(await board(), 2);
  level = 1;
  assert.equal(await board(), undefined);
});

interface Board {
  lanes: { lane: string; notTriaged?: number; cards: { key: string }[] }[];
  yourTurn: { key: string }[];
}
const fullBoard = async (): Promise<Board> => (await (await fetch(`${base}/api/board`)).json()) as Board;
/** To do's keys above and below the divider, or null without one. */
const divided = async (): Promise<{ above: string[]; below: string[] } | null> => {
  const backlog = (await fullBoard()).lanes.find((lane) => lane.lane === "todo")!;
  if (backlog.notTriaged === undefined) return null;
  const keys = backlog.cards.map((card) => card.key);
  return { above: keys.slice(0, keys.length - backlog.notTriaged), below: keys.slice(keys.length - backlog.notTriaged) };
};
const triaged = { log: [{ at, by: { who: "scopesoup", agent: true as const }, kind: "session" as const, fields: { role: "triage" } }] };

test("from level 1 To do has a divider; an Item moves above it when its triage takes it in", async () => {
  assert.equal(await divided(), null, "level 0: no divider");
  level = 1;
  assert.deepEqual(await divided(), { above: ["fake:work:3"], below: ["fake:work:1", "fake:work:2"] });
  store.put(item("2", triaged), "sync", at);
  assert.deepEqual(await divided(), { above: ["fake:work:2", "fake:work:3"], below: ["fake:work:1"] });
});

test("below the divider: creation order, a higher priority ahead; triages run in that order", async () => {
  level = 1;
  store.put(item("5", { priority: "critical" }), "sync", at);
  store.put(item("6", { labels: ["bug"] }), "sync", at);
  assert.deepEqual((await divided())?.below, ["fake:work:5", "fake:work:1", "fake:work:2", "fake:work:6"]);
});

test("an Item parked on its triage's questions stays in Your turn", async () => {
  level = 1;
  const decision = { question: "Which way?", options: [{ label: "A", description: "one way" }, { label: "B", description: "the other" }], recommendation: "A" };
  const jobs: Jobs = {
    "fake:work:1": { item: item("1").ref, workspace: "w1", branch: "scopesoup/1", failures: 0, fixRounds: 0, startedAt: at, triage: { ready: false, size: "small", paths: [], hidesDecision: true, decision, decisions: [decision] }, at: { kind: "parked", step: "triage", parked: { as: "needs-decision", reason: "a question", at } } },
  };
  saveJobs(store, jobs);
  const board = await fullBoard();
  assert.ok(board.yourTurn.some((card) => card.key === "fake:work:1"), "in Your turn");
  assert.ok(board.lanes.find((lane) => lane.lane === "todo")!.cards.some((card) => card.key === "fake:work:1"), "still in To do");
});

test("there is no triage endpoint any more", async () => {
  const response = await fetch(`${base}/api/triage`, { method: "POST" });
  assert.ok(response.status === 404 || response.status === 405, `refused, got ${response.status}`);
  await response.text();
  assert.equal(store.eventsAfter(0, 100).filter((event) => event.kind.startsWith("orchestrator.triages") || event.kind === "config.changed").length, 0);
});
