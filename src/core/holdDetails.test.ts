import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRecord, WorkItem } from "../model/types.ts";
import { holdDetails } from "./holdings.ts";
import { buildItemPage } from "./item-page.ts";
import type { Snapshot } from "./snapshot.ts";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const FAR = "2036-11-19T09:00:00.000Z";

const claim: LogRecord = { at: "2026-11-19T09:00:00.000Z", by: { who: "robin", machine: "laptop-a", agent: false }, kind: "claimed", fields: { until: FAR, from: "claude-code" } };

function held(): WorkItem {
  return {
    ref: { host: "metaBranch", kind: "work", id: "A-5" }, title: "Item A-5", state: "todo", hostState: "todo", labels: [], blockedBy: [], openChildren: 0,
    updatedAt: "2026-11-19T09:00:00.000Z", holder: { actor: { id: "robin@laptop-a", name: "robin on laptop-a" }, until: FAR }, log: [claim],
  };
}

test("a person's hold from a session says so, and is quiet after a day", () => {
  assert.deepEqual(holdDetails(held(), NOW), { since: "2026-11-19T09:00:00.000Z", from: "claude-code", quiet: false });
  assert.deepEqual(holdDetails(held(), new Date("2026-11-21T12:00:00.000Z")), { since: "2026-11-19T09:00:00.000Z", from: "claude-code", quiet: true });
  assert.equal(holdDetails({ ...held(), holder: undefined }, NOW), undefined);
});

test("the item page carries the same details for 'held by'", () => {
  const snapshot = { works: [held()], changes: [], runs: [], batches: [], sessions: [], runners: [], answers: [], settings: {}, now: NOW.toISOString() } as unknown as Snapshot;
  const page = buildItemPage(snapshot, "metaBranch:work:A-5", new Date("2026-11-21T12:00:00.000Z"));
  assert.deepEqual([page?.item.holder?.actor.name, page?.item.holder?.from, page?.item.holder?.quiet], ["robin on laptop-a", "claude-code", true]);
});
