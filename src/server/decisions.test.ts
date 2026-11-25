// Answering a question from an item's log and settling a conflict, from the item page, against a
// real temporary repository whose meta branch is written by two meta branch hosts (two machines).
// All names and texts are synthetic.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ItemPage } from "../core/views.ts";
import type { WorkItem } from "../model/types.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createTestRepo, itemMd } from "../hosts/metaBranch/testRepo.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import { createSync } from "../sync/index.ts";
import type { Job } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs } from "../orchestrator/jobs.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

const META = "refs/scopesoup/meta";
const person = { name: "Test Person", email: "test.person@example.invalid" };
let repo: TestRepo;
let host: MetaBranchHost;
let other: MetaBranchHost;
let store: Store;
let refresh: () => Promise<void>;
let server: ScopeSoupServer;
let base: string;
let tick = 0;
const clock = (): string => new Date(Date.parse("2026-11-18T09:00:00Z") + 60_000 * tick++).toISOString();

before(async () => {
  repo = createTestRepo();
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  host = createMetaBranchHost({ repoDir: repo.dir, allowWrites: true, remote: null, person, machine: "laptop-a", idPrefix: "A", now: clock });
  other = createMetaBranchHost({ repoDir: repo.dir, allowWrites: true, remote: null, person, machine: "laptop-b", idPrefix: "B", now: clock });
  store = openStore(":memory:");
  const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false });
  refresh = () => sync.refreshNow();
  server = createServer({ store, port: 0, items: { host: "metaBranch", write: host.write! }, syncNow: refresh });
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  await host.stop();
  await other.stop();
  store.close();
  repo.cleanup();
});

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const page = async (ref: string): Promise<ItemPage> => (await (await fetch(`${base}/api/item?ref=${ref}`)).json()) as ItemPage;

test("a question another machine wrote in the log is a person's turn with its options; the answer names it and the turn goes away", async () => {
  const made = await post("/api/items", { title: "Pick a fence colour" });
  const ref = made.body.ref as string;
  await other.write!.appendLog!({ host: "metaBranch", kind: "work", id: "A-1" }, {
    kind: "question",
    by: { who: "planner", agent: true },
    fields: { question: "Which colour?", options: ["green", "white"], recommendation: "green" },
  });
  await refresh();

  const asked = await page(ref);
  assert.equal(asked.actor, "anyone");
  assert.equal(asked.decision.needed, true);
  assert.doesNotMatch(asked.decision.words, /on the host/);
  assert.equal(asked.questions.length, 1);
  const question = asked.questions[0]!;
  assert.equal(question.question, "Which colour?");
  assert.deepEqual(question.options, ["green", "white"]);
  assert.equal(question.recommendation, "green");
  assert.equal(question.by.machine, "laptop-b");

  const answered = await post("/api/answer", { ref, answer: "green", to: question.at });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.logged, true);
  const log = repo.git(["cat-file", "-p", `${META}:items/A-1/log.jsonl`]).split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const last = log[log.length - 1]!;
  assert.equal(last.kind, "answer");
  assert.equal(Date.parse(last.to as string), Date.parse(question.at));
  assert.deepEqual(last.toBy, question.by);

  const after = await page(ref);
  assert.deepEqual(after.questions, []);
  assert.notEqual(after.actor, "anyone");
});

test("an item in conflict shows both versions; keeping one settles exactly the versions shown", async () => {
  const made = await post("/api/items", { title: "Mend the gate" });
  const ref = made.body.ref as string;
  // A version from another machine, put aside beside item.md as a merge would.
  const theirs = itemMd("A-2", "Mend the old gate", "todo");
  const blob = repo.git(["hash-object", "-w", "--stdin"], theirs);
  const files: Record<string, { mode: string; sha: string }> = {};
  for (const line of repo.git(["ls-tree", "-r", META]).split("\n")) {
    const [meta, path] = line.split("\t") as [string, string];
    const [mode, , sha] = meta.split(" ") as [string, string, string];
    files[path] = { mode, sha };
  }
  files[`items/A-2/item.conflict-${blob.slice(0, 12)}.md`] = { mode: "100644", sha: blob };
  repo.commit(META, files, "2026-11-18T10:00:00Z");
  await refresh();

  const shown = await page(ref);
  assert.equal(shown.actor, "anyone");
  assert.ok(shown.conflict, "the page carries the conflict");
  assert.match(shown.conflict.current ?? "", /title: Mend the gate/);
  assert.deepEqual(shown.conflict.aside.map((version) => [version.id, version.text]), [[blob, theirs]]);

  assert.equal((await post("/api/item/resolve", { ref, text: "not an item", supersedes: [blob] })).status, 400);
  assert.equal((await post("/api/item/resolve", { ref, text: theirs, supersedes: [] })).status, 400);
  const settled = await post("/api/item/resolve", { ref, text: theirs, supersedes: shown.conflict.aside.map((version) => version.id) });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.conflict, false);
  assert.equal(repo.git(["ls-tree", "--name-only", `${META}:items/A-2`]), "item.md\nlog.jsonl");

  const after = await page(ref);
  assert.equal(after.item.title, "Mend the old gate");
  assert.equal(after.conflict, undefined);
  assert.notEqual(after.actor, "anyone");
});

// --- proposed rewrites of an item's text: removed, an old one is still read ---

/** An item with an old rewrite proposal in its log, written by another machine as the orchestrator wrote it earlier. */
async function proposed(title: string): Promise<{ ref: string; id: string }> {
  const made = await post("/api/items", { title, body: "Paint the fence white.", verification: "Look at it." });
  const ref = made.body.ref as string;
  const id = ref.split(":")[2]!;
  await other.write!.appendLog!({ host: "metaBranch", kind: "work", id }, {
    kind: "question",
    by: { who: "scopesoup", agent: true },
    fields: { question: "A review session proposes a new description for the item: wrong colour.", proposal: { description: "Paint the fence green.", reason: "A person said green." }, parked: "needs-decision" },
  });
  await refresh();
  return { ref, id };
}

test("an old proposed rewrite in an item's log is read without error, kept in the log, and no longer waits for an answer", async () => {
  const { ref } = await proposed("Fence colour");
  const shown = await page(ref);
  assert.equal(shown.proposal, undefined);
  assert.deepEqual(shown.questions, []);
  assert.equal(shown.decision.needed, false);
  assert.equal(shown.item.body?.trim(), "Paint the fence white.");
  const work = store.list<WorkItem>("work").find((each) => each.ref.id === ref.split(":")[2]);
  assert.ok(work?.log?.some((line) => line.kind === "question" && typeof line.fields.proposal === "object"), "the line is still in the log");
  assert.equal((await post("/api/proposal", { ref, action: "accept" })).status, 404);
});

test("a decision on a proposal is refused for a bad action and when none is waiting", async () => {
  const made = await post("/api/items", { title: "Nothing proposed" });
  const ref = made.body.ref as string;
  assert.equal((await post("/api/proposal", { ref, action: "accept" })).status, 404);
  assert.equal((await post("/api/proposal", { ref, action: "maybe" })).status, 400);
  assert.equal((await post("/api/proposal", { ref: "metaBranch:work:nope", action: "reject" })).status, 404);
});

test("a job stored with an old proposed rewrite shows no proposal, and none can be accepted", async () => {
  const kept = openStore(":memory:");
  const itemRef = { host: "fake", kind: "work" as const, id: "7" };
  const at = "2026-11-18T09:00:00Z";
  kept.put({ ref: itemRef, title: "Thing", body: "Old text.", state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: at }, "sync", at);
  const proposal = { description: "New text.", reason: "Because." } as unknown as Job["proposal"];
  saveJobs(kept, { "fake:work:7": { item: itemRef, workspace: "w", branch: "scopesoup/7", step: "implement", failures: 0, fixRounds: 0, startedAt: at, proposal, parked: { as: "needs-decision", reason: "A implement session proposes a new description for the item: Because.", at } } });
  const plain = createServer({ store: kept, port: 0 });
  const url = (await plain.start()).url;
  try {
    const shown = (await (await fetch(`${url}/api/item?ref=fake:work:7`)).json()) as ItemPage;
    assert.equal(shown.proposal, undefined);
    const response = await fetch(`${url}/api/proposal`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: "fake:work:7", action: "accept" }) });
    assert.equal(response.status, 404);
    assert.ok(loadJobs(kept)["fake:work:7"], "the tick releases it, not the page");
  } finally {
    await plain.stop();
    kept.close();
  }
});

test("a triage's rewrite: keeping the recommendation accepts it in one action, the description changes and the old text stays in the history", async () => {
  const made = await post("/api/items", { title: "Tide table units", body: "Tide table units." });
  const ref = made.body.ref as string;
  const subject = { host: "metaBranch", kind: "work" as const, id: ref.split(":").pop()! };
  const at = clock();
  const question = { question: "Metric or imperial?", options: [{ label: "Metric", description: "Metres." }, { label: "Imperial", description: "Feet." }], recommendation: "Metric" };
  const job: Job = {
    item: subject, workspace: "w", branch: `scopesoup/${subject.id}`, step: "triage", failures: 0, fixRounds: 0, startedAt: at,
    triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision: question, decisions: [question], rewrite: "Show the tide table in metres." },
    rewrite: { original: "Tide table units.", text: "Show the tide table in metres.", questions: [question], round: 1 }, rewriteRounds: 1,
    parked: { as: "needs-decision", reason: "Triage, round 1: a rewrite of the description and 1 question(s) wait for an answer: 1. Metric or imperial?", at },
  };
  store.tx(() => saveJobs(store, { ...loadJobs(store), [ref]: job }));

  const shown = await page(ref);
  assert.equal(shown.parked?.rewrite?.text, "Show the tide table in metres.");
  assert.equal(shown.parked?.rewrite?.questions[0]?.recommendation, "Metric");

  assert.equal((await post("/api/rewrite", { ref, parkedAt: at, answers: [], action: "accept" })).status, 400);
  assert.equal((await post("/api/rewrite", { ref, parkedAt: "2020-01-01T00:00:00Z", answers: ["Metric"], action: "accept" })).status, 409);
  const accepted = await post("/api/rewrite", { ref, parkedAt: at, answers: ["Metric"], action: "accept" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.settled, "accepted");
  assert.equal(accepted.body.written, true);

  const after = await page(ref);
  assert.equal(after.item.body?.trim(), "Show the tide table in metres.");
  assert.ok(after.history.some((line) => /Changed description \(triage, round 1\)\. Before: Tide table units\./.test(line.text)), JSON.stringify(after.history));
  assert.deepEqual(after.answers.map((each) => each.question), ["Metric or imperial?", "Triage rewrite, round 1"]);
  assert.equal(after.parked, undefined);
  assert.equal(loadJobs(store)[ref]?.rewrite?.settled, "accepted");
  // Answered once: a second press finds no rewrite.
  assert.equal((await post("/api/rewrite", { ref, parkedAt: at, answers: ["Metric"], action: "accept" })).status, 409);
});

test("another answer to a rewrite is recorded and sends the item back to its triage; the description is not changed", async () => {
  const made = await post("/api/items", { title: "Harbour names", body: "Harbour names." });
  const ref = made.body.ref as string;
  const subject = { host: "metaBranch", kind: "work" as const, id: ref.split(":").pop()! };
  const at = clock();
  const question = { question: "Local names?", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], recommendation: "Yes" };
  store.tx(() => saveJobs(store, { ...loadJobs(store), [ref]: {
    item: subject, workspace: "w", branch: `scopesoup/${subject.id}`, step: "triage", failures: 0, fixRounds: 0, startedAt: at,
    rewrite: { original: "Harbour names.", text: "Show local harbour names.", questions: [question], round: 1 },
    parked: { as: "needs-decision", reason: "Triage, round 1.", at },
  } }));
  const answered = await post("/api/rewrite", { ref, parkedAt: at, answers: ["No, the official ones"], action: "accept" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.rerun, true);
  const stored = loadJobs(store)[ref]!;
  assert.deepEqual([stored.step, stored.parked, stored.rewrite], ["triage", undefined, undefined]);
  const after = await page(ref);
  assert.equal(after.item.body?.trim(), "Harbour names.");
  assert.deepEqual(after.answers.map((each) => `${each.question}: ${each.answer}`), ["Local names?: No, the official ones"]);
});

/** A meta-branch Item labelled `question` parked on a rewrite that proposes +bug, −question. */
async function labelRewrite(title: string): Promise<{ ref: string; at: string }> {
  const made = await post("/api/items", { title, body: `${title}.`, labels: "question, harbour" });
  const ref = made.body.ref as string;
  const subject = { host: "metaBranch", kind: "work" as const, id: ref.split(":").pop()! };
  const at = clock();
  store.tx(() => saveJobs(store, { ...loadJobs(store), [ref]: {
    item: subject, workspace: "w", branch: `scopesoup/${subject.id}`, step: "triage", failures: 0, fixRounds: 0, startedAt: at,
    triage: { ready: true, size: "small", paths: [], hidesDecision: false, rewrite: `${title}, in metres.` },
    rewrite: { original: `${title}.`, text: `${title}, in metres.`, questions: [], round: 1, labels: { add: ["bug"], remove: ["question"] } }, rewriteRounds: 1,
    parked: { as: "needs-decision", reason: "Triage, round 1: a rewrite of the description waits for a person to accept, edit or reject. Labels: +bug, −question.", at },
  } }));
  return { ref, at };
}

test("meta branch: Accept writes the description and the label changes to the Item in one edit; other labels stay", async () => {
  const { ref, at } = await labelRewrite("Tide heights");
  assert.deepEqual((await page(ref)).parked?.rewrite?.labels, { add: ["bug"], remove: ["question"] });
  const accepted = await post("/api/rewrite", { ref, parkedAt: at, answers: [], action: "accept" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body.labels, { added: ["bug"], removed: ["question"] });
  const after = await page(ref);
  assert.equal(after.item.body?.trim(), "Tide heights, in metres.");
  assert.deepEqual(after.item.labels, ["harbour", "bug"]);
});

test("meta branch: Reject leaves the labels and the description unchanged", async () => {
  const { ref, at } = await labelRewrite("Tide times");
  const rejected = await post("/api/rewrite", { ref, parkedAt: at, answers: [], action: "reject" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  const after = await page(ref);
  assert.equal(after.item.body?.trim(), "Tide times.");
  assert.deepEqual(after.item.labels, ["question", "harbour"]);
});

test("two log questions answered with one Send are one commit on the meta branch, and both close", async () => {
  const made = await post("/api/items", { title: "Pick a gate latch" });
  const ref = made.body.ref as string;
  const id = ref.split(":").pop()!;
  for (const question of ["Which latch?", "Which height?"]) {
    await other.write!.appendLog!({ host: "metaBranch", kind: "work", id }, { kind: "question", by: { who: "planner", agent: true }, fields: { question, options: ["low", "high"] } });
  }
  await refresh();
  const asked = await page(ref);
  assert.equal(asked.questions.length, 2);
  const commits = () => Number(repo.git(["rev-list", "--count", META]).trim());
  const before = commits();
  const sent = await post("/api/answers", { ref, answers: asked.questions.map((question, index) => ({ to: question.at, answer: index === 0 ? "low" : "At hand height, as written" })) });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.logged, true);
  assert.equal(commits(), before + 1);
  const log = repo.git(["cat-file", "-p", `${META}:items/${id}/log.jsonl`]).split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(log.slice(-2).map((line) => [line.kind, line.answer]), [["answer", "low"], ["answer", "At hand height, as written"]]);
  assert.deepEqual((await page(ref)).questions, []);
});
