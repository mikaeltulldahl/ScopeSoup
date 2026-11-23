// A proposed split accepted on a meta branch host, against a real temporary repository: the parts become child Items,
// invited, the question in the log is answered, and the item becomes an umbrella. Names are synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemPage } from "../core/views.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import { createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import type { ProposedPart, Ref, WorkItem } from "../model/types.ts";
import { saveJobs } from "../orchestrator/jobs.ts";
import { openStore } from "../store/store.ts";
import { createSync } from "../sync/index.ts";
import { createServer } from "./server.ts";

const PARTS: ProposedPart[] = [
  { title: "Read the old format", description: "Parse the old files.", verification: "A test reads a sample." },
  { title: "Write the new format", description: "Write the new files.", verification: "A test writes a sample." },
];
const CARRIED = "- Asked: Which format?\n  Answered: Keep the old one readable.";

test("on a meta branch host, accepting creates the parts as child Items, invited, closes the question in the log, and the item becomes an umbrella", async () => {
  const repo = createTestRepo();
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  let tick = 0;
  const clock = (): string => new Date(Date.parse("2026-11-18T09:00:00Z") + 60_000 * tick++).toISOString();
  const host = createMetaBranchHost({ repoDir: repo.dir, allowWrites: true, remote: null, person: { name: "Test Person", email: "test.person@example.invalid" }, machine: "laptop-a", idPrefix: "A", now: clock });
  const store = openStore(":memory:");
  const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false });
  const server = createServer({ store, port: 0, items: { host: "metaBranch", write: host.write! }, split: [{ host: "metaBranch", write: host.write! }], syncNow: () => sync.refreshNow(), planning: () => ({ bugLabels: [] }) });
  const url = (await server.start()).url;
  try {
    const item: Ref = (await host.write!.createWork!({ title: "Change the file format", body: "Everything.", labels: ["scopesoup"] })).work;
    const reason = "Triage: too large for one change; it proposes 2 parts.";
    // As park writes it.
    await host.write!.appendLog!(item, { kind: "question", by: { who: "scopesoup", agent: true }, fields: { question: reason, proposal: { reason, parts: PARTS, carried: CARRIED }, parked: "needs-decision" } });
    await sync.refreshNow();
    saveJobs(store, { [`metaBranch:work:${item.id}`]: { item, workspace: "w", branch: `scopesoup/${item.id}`, step: "triage", failures: 0, fixRounds: 0, startedAt: clock(), proposal: { reason, parts: PARTS, carried: CARRIED }, parked: { as: "needs-decision", reason, at: clock() } } });
    const shown = (await (await fetch(`${url}/api/item?ref=metaBranch:work:${item.id}`)).json()) as ItemPage;
    assert.deepEqual(shown.proposal?.parts, PARTS);
    assert.match(shown.decision.words, /proposed split/);

    const response = await fetch(`${url}/api/proposal`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: `metaBranch:work:${item.id}`, action: "accept", to: shown.proposal!.at }) });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.logged, true);
    await sync.refreshNow();
    const works = store.list<WorkItem>("work");
    const children = works.filter((work) => work.parent?.id === item.id).sort((a, b) => a.ref.id.localeCompare(b.ref.id));
    assert.deepEqual(children.map((child) => child.title), ["Read the old format", "Write the new format"]);
    for (const [index, child] of children.entries()) {
      assert.ok(!child.labels.includes("scopesoup"), "no invite label");
      assert.equal(child.verification, PARTS[index]!.verification);
      assert.match(child.body ?? "", /## Decisions carried over from A-1[^]*Keep the old one readable/);
    }
    const after = (await (await fetch(`${url}/api/item?ref=metaBranch:work:${item.id}`)).json()) as ItemPage;
    assert.deepEqual(after.questions, [], "the question in the log is answered");
    assert.equal(after.proposal, undefined);
    assert.equal(after.item.openChildren, 2);
    assert.match(after.reason, /has 2 open sub-items/);
  } finally {
    await server.stop();
    await host.stop();
    store.close();
    repo.cleanup();
  }
});

