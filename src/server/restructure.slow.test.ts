// A proposed restructuring accepted on a meta branch host, against a real temporary repository: a child and a related Item are
// made, a part is added to an existing Item, the question in the log is answered, and the item keeps its part. Names are synthetic.

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
  { title: "Read the old format", description: "Parse the old files.", verification: "A test reads a sample.", goes: "original" },
  { title: "Write the new format", description: "Write the new files.", verification: "A test writes a sample.", goes: "child" },
  { title: "Document the format", description: "Describe the new files.", verification: "", goes: "related" },
  { title: "Old files readable", description: "Old files keep opening.", verification: "", goes: "into" },
];
const CARRIED = "- Asked: Which format?\n  Answered: Keep the old one readable.";

test("on a meta branch host, accepting makes each part where it goes, closes the question in the log, and the item keeps its part", async () => {
  const repo = createTestRepo();
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  let tick = 0;
  const clock = (): string => new Date(Date.parse("2026-11-18T09:00:00Z") + 60_000 * tick++).toISOString();
  const host = createMetaBranchHost({ repoDir: repo.dir, allowWrites: true, remote: null, person: { name: "Test Person", email: "test.person@example.invalid" }, machine: "laptop-a", idPrefix: "A", now: clock });
  const store = openStore(":memory:");
  const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false });
  const server = createServer({ store, port: 0, items: { host: "metaBranch", write: host.write! }, restructure: [{ host: "metaBranch", write: host.write!, read: (ref) => host.work.getWork(ref) }], syncNow: () => sync.refreshNow(), planning: () => ({ bugLabels: [] }) });
  const url = (await server.start()).url;
  try {
    const item: Ref = (await host.write!.createWork!({ title: "Change the file format", body: "Everything.", labels: ["scopesoup"] })).work;
    const other: Ref = (await host.write!.createWork!({ title: "Keep old files readable", body: "Old files stay readable." })).work;
    const parts = PARTS.map((part) => (part.goes === "into" ? { ...part, into: other.id } : part));
    const reason = "Triage proposes to restructure the Item.";
    // As park writes it.
    const proposal = { id: "abc12345", reason, original: "keeps" as const, parts, carried: CARRIED };
    await host.write!.appendLog!(item, { kind: "question", by: { who: "scopesoup", agent: true }, fields: { question: reason, proposal, parked: "needs-decision" } });
    await sync.refreshNow();
    saveJobs(store, { [`metaBranch:work:${item.id}`]: { item, workspace: "w", branch: `scopesoup/${item.id}`, failures: 0, fixRounds: 0, startedAt: clock(), at: { kind: "parked", step: "triage", parked: { as: "needs-decision", reason, at: clock() }, ask: { is: "restructuring", proposal } } } });
    const shown = (await (await fetch(`${url}/api/item?ref=metaBranch:work:${item.id}`)).json()) as ItemPage;
    assert.deepEqual(shown.proposal?.parts, parts);
    assert.match(shown.decision.words, /proposed restructuring/);

    const response = await fetch(`${url}/api/proposal`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: `metaBranch:work:${item.id}`, action: "accept", to: shown.proposal!.at }) });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.logged, true);
    await sync.refreshNow();
    const works = store.list<WorkItem>("work");
    const children = works.filter((work) => work.parent?.id === item.id);
    assert.deepEqual(children.map((child) => child.title), ["Write the new format"]);
    assert.ok(!children[0]!.labels.includes("scopesoup"), "no invite label");
    assert.equal(children[0]!.verification, "A test writes a sample.");
    assert.match(children[0]!.body ?? "", /## Decisions carried over from A-1[^]*Keep the old one readable[^]*Part 2 of restructuring abc12345 of metaBranch:work:A-1\.$/);
    const related = works.find((work) => work.title === "Document the format")!;
    assert.equal(related.parent, undefined);
    assert.match(related.body ?? "", /Part 3 of restructuring abc12345 of metaBranch:work:A-1\.$/);
    assert.match(works.find((work) => work.ref.id === other.id)!.body ?? "", /^Old files stay readable\.\n\n## Added from metaBranch:work:A-1: Old files readable\n\nOld files keep opening\.\n\nPart 4 of restructuring abc12345 of metaBranch:work:A-1\.$/);
    // The item is narrowed to the part it keeps, and released so triage looks at it again.
    const kept = works.find((work) => work.ref.id === item.id)!;
    assert.equal(kept.title, "Read the old format");
    assert.equal(kept.body, "Parse the old files.");
    assert.equal(kept.verification, "A test reads a sample.");
    const after = (await (await fetch(`${url}/api/item?ref=metaBranch:work:${item.id}`)).json()) as ItemPage;
    assert.deepEqual(after.questions, [], "the question in the log is answered");
    assert.equal(after.proposal, undefined);
    assert.equal(after.parked, undefined);
  } finally {
    await server.stop();
    await host.stop();
    store.close();
    repo.cleanup();
  }
});

