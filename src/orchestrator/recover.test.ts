// The orchestrator's progress and the answers kept in the items' logs (meta branch), and read
// back after the local store is deleted. A real temporary repository holds the meta branch; the
// runner is a fake, so no agent is started. All names and texts are synthetic.

import { KEYS } from "../store/keys.ts";
import { setRolesForTest } from "../store/control.ts";
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { fixedConfig } from "../config/loader.ts";
import type { ProjectConfig } from "../config/types.ts";
import { validateConfig } from "../config/validate.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import type { LogRecord, Ref, Session, SessionStatus, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { createServer } from "../server/server.ts";
import { loadSnapshot } from "../server/snapshot.ts";
import { loadAnswers } from "../store/answers.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { createSync } from "../sync/index.ts";
import { createHostActions } from "./hostActions.ts";
import { loadJobs } from "./jobs.ts";
import type { AgentRunner, SessionRequest } from "./ports.ts";
import { jobFromLog } from "./recover.ts";
import { sessionResultKey } from "./runner.ts";
import { tick } from "./tick.ts";

const repos: TestRepo[] = [];
const hosts: MetaBranchHost[] = [];
after(async () => {
  for (const host of hosts) await host.stop();
  for (const repo of repos) repo.cleanup();
});

const CONFIG: ProjectConfig = (() => {
  const result = validateConfig({
    project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", level: 3,
    rules: { riskClasses: { on: true, reason: "test", effects: [{ name: "changes the database schema", paths: ["**/migrations/**"] }] } },
  }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
})();

const SHA1 = "1111111111111111111111111111111111111111";
const TRIAGE_OK = { ready: true, size: "small", paths: ["src/a.ts"], hidesDecision: false, risk: "low", riskReason: "plain code" };
const IMPLEMENT_OK = { done: true, summary: "Added the parser.", risk: "low", riskReason: "plain code" };
const REVIEW_OK = { verdict: "approve", findings: [], risk: "low", riskReason: "plain code" };

/** A meta branch with one item, written by a meta branch host with writes on. */
async function project(): Promise<{ host: MetaBranchHost; item: Ref }> {
  const repo = createTestRepo();
  repos.push(repo);
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  let n = 0;
  const host = createMetaBranchHost({
    repoDir: repo.dir, allowWrites: true, remote: null, person: { name: "Test Person", email: "test.person@example.invalid" }, machine: "laptop-a", idPrefix: "A",
    now: () => new Date(Date.parse("2026-11-18T09:00:00Z") + 1000 * n++).toISOString(),
  });
  hosts.push(host);
  const made = await host.write!.createWork!({ title: "Write the parser" });
  return { host, item: made.work };
}

interface Laptop {
  store: Store;
  requests: SessionRequest[];
  /** Syncs the meta branch into the store, then ticks. */
  run(): Promise<void>;
  /** Ends the running session of the item, ticks, waits past the continuation delay and ticks again. */
  end(status: SessionStatus, output: unknown): Promise<void>;
  sync(): Promise<void>;
}

/** Scope Soup started on a new local store, as after deleting data/. */
function start(host: MetaBranchHost): Laptop {
  const store = openStore(":memory:");
  // As after a person pressed Start agents and Start merge queue.
  setRolesForTest(store, "started");
  store.setValue(KEYS.mergeQueue, "started");
  const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false });
  const clock = { ms: Date.parse("2026-11-18T10:00:00Z") };
  const now = (): string => new Date(clock.ms).toISOString();
  const requests: SessionRequest[] = [];
  let running: Session | null = null;
  let count = 0;
  const runner: AgentRunner = {
    async start(request) {
      running = { ref: { host: "scopesoup", kind: "session", id: `s${++count}` }, role: request.role, subject: request.subject, status: "running", attempt: request.attempt, startedAt: now(), model: `model-of-${request.role}` };
      requests.push(request);
      store.put(running, "orchestrator", now());
      return running;
    },
    async reconcile() {},
    stopAll: () => 0,
    running: () => (running ? 1 : 0),
    takeWorkspace: async () => null,
    async releaseWorkspace() {},
    async deleteBranch() {},
    changedPaths: async () => ["src/parser.ts"],
    head: async () => SHA1,
    // The remote's main does not contain the branch: nothing here is merged by a session.
    fetchMain: async () => ({ repo: "/srv/clone", main: "0".repeat(40) }),
    contains: async () => false,
  };
  const actions = createHostActions({ host, git: async () => ({ code: 1, stdout: "", stderr: "not used" }), config: () => CONFIG, store });
  const deps = { store, runner, config: fixedConfig(CONFIG), actions, now };
  const laptop: Laptop = {
    store, requests,
    sync: () => sync.refreshNow(),
    async run() {
      await sync.refreshNow();
      await tick(deps);
    },
    async end(status, output) {
      const session = running;
      if (!session) assert.fail("no session is running");
      running = null;
      clock.ms += 60_000;
      store.setValue(sessionResultKey(session.ref.id), JSON.stringify({ output }));
      store.put({ ...session, status, finishedAt: now(), endReason: status }, "orchestrator", now());
      await laptop.run();
      clock.ms += 1000;
      await laptop.run();
    },
  };
  return laptop;
}

const kinds = (store: Store, item: Ref): string[] => (store.get<WorkItem>({ ...item })?.log ?? []).map((line) => line.kind);

describe("recover", { concurrency: 4 }, () => {
test("an item run to reviewed is found where it was after the local store is deleted, without a new session", async () => {
  const { host, item } = await project();
  const key = refKey(item);
  const first = start(host);
  await first.run();
  assert.equal(first.requests.length, 1);
  await first.end("succeeded", TRIAGE_OK);
  await first.end("succeeded", IMPLEMENT_OK);
  await first.end("succeeded", REVIEW_OK);
  // Approved below level 4: the implementor is resumed to merge it; here it opens a pull request instead.
  await first.end("succeeded", { ...IMPLEMENT_OK, mergedAs: "https://git.example.invalid/team/project/pull/1" });
  assert.deepEqual(first.requests.map((request) => request.role), ["triage", "implement", "review", "implement"]);
  assert.equal(loadJobs(first.store)[key]?.parked?.as, "handed-over");
  await first.sync();
  assert.deepEqual(kinds(first.store, item), ["session", "revision", "session", "review", "session", "question", "session"]);
  const log = first.store.get<WorkItem>(item)?.log ?? [];
  const sessions = log.filter((line) => line.kind === "session").map((line) => [line.fields.role, line.fields.outcome, line.fields.next ?? null]);
  assert.deepEqual(sessions, [["triage", "succeeded", "implement"], ["implement", "succeeded", "review"], ["review", "succeeded", "implement"], ["implement", "succeeded", null]]);
  assert.deepEqual(log.find((line) => line.kind === "review")?.fields.verdict, "pass");

  const second = start(host);
  await second.run();
  assert.equal(second.requests.length, 0, "no new session");
  const job = loadJobs(second.store)[key];
  assert.equal(job?.parked?.as, "handed-over");
  assert.equal(job?.branch, "scopesoup/A-1");
  assert.ok(second.store.eventsAfter(0, 1000).some((event) => event.kind === "orchestrator.recovered" && event.subject === key));
  await second.run();
  assert.equal(second.requests.length, 0);
});

test("a pending question and its later answer both survive the deleted local store", async () => {
  const { host, item } = await project();
  const key = refKey(item);
  const first = start(host);
  await first.run();
  await first.end("succeeded", { ...TRIAGE_OK, hidesDecision: true, decision: { question: "Letters or digits in ids?", options: ["letters", "digits"], recommendation: "letters" } });
  assert.equal(loadJobs(first.store)[key]?.parked?.as, "needs-decision");

  // Deleted: the item still waits, with its question, and nothing is started.
  const second = start(host);
  await second.run();
  assert.equal(second.requests.length, 0);
  const parked = loadSnapshot(second.store).parked?.find((each) => refKey(each.subject) === key);
  assert.equal(parked?.as, "needs-decision");
  assert.deepEqual(parked?.decision, { question: "Letters or digits in ids?", options: ["letters", "digits"], recommendation: "letters" });
  const asked = second.store.get<WorkItem>(item)?.openQuestions?.[0];
  assert.equal(asked?.question, "Letters or digits in ids?");

  // A person answers on the board: the answer goes into the log, naming the question.
  const server = createServer({ store: second.store, port: 0, items: { host: "metaBranch", write: host.write! }, syncNow: () => second.sync() });
  const base = (await server.start()).url;
  try {
    const response = await fetch(`${base}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: key, answer: "letters" }) });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.released, true);
    assert.equal(body.logged, true);
  } finally {
    await server.stop();
  }
  const answerLine = second.store.get<WorkItem>(item)?.log?.find((line) => line.kind === "answer");
  assert.equal(Date.parse(String(answerLine?.fields.to)), Date.parse(asked?.at ?? ""));
  assert.deepEqual(answerLine?.fields.toBy, asked?.by);
  assert.equal(second.store.get<WorkItem>(item)?.openQuestions, undefined);

  // Deleted again: the answer is back, and the item starts over with it in the prompt.
  const third = start(host);
  await third.run();
  const answers = loadAnswers(third.store);
  assert.deepEqual(answers.map((answer) => [answer.answer, answer.question]), [["letters", "Letters or digits in ids?"]]);
  assert.equal(third.requests.length, 1);
  assert.equal(third.requests[0]?.role, "triage");
  assert.match(third.requests[0]?.vars.itemBody ?? "", /Answered: letters/);
});

test("three open triage questions all wait again after a deleted store; the first answer does not release the item, the third does", async () => {
  const { host, item } = await project();
  const key = refKey(item);
  const first = start(host);
  await first.run();
  const decisions = [
    { question: "Letters or digits in ids?", options: ["letters", "digits"], recommendation: "letters" },
    { question: "Keep the old parser?", options: ["keep", "drop"], recommendation: "drop" },
    { question: "Log parse errors?", options: ["yes", "no"], recommendation: "yes" },
  ];
  await first.end("succeeded", { ...TRIAGE_OK, hidesDecision: true, decisions });
  assert.equal(loadJobs(first.store)[key]?.parked?.as, "needs-decision");
  await first.sync();
  assert.equal(first.store.get<WorkItem>(item)?.openQuestions?.length, 3);

  // Deleted: all three questions wait again, in the order triage gave them.
  const second = start(host);
  await second.run();
  assert.equal(second.requests.length, 0);
  const job = loadJobs(second.store)[key];
  assert.equal(job?.parked?.as, "needs-decision");
  assert.deepEqual(job?.triage?.decisions?.map((each) => each.question), decisions.map((each) => each.question));
  const parked = loadSnapshot(second.store).parked?.find((each) => refKey(each.subject) === key);
  assert.deepEqual(parked?.questions?.map((each) => each.question), decisions.map((each) => each.question));
  assert.equal(parked?.at, job?.parked?.at);

  // A person answers on the board, as the page does: by index, naming the parked state it read.
  const server = createServer({ store: second.store, port: 0, items: { host: "metaBranch", write: host.write! }, syncNow: () => second.sync() });
  const base = (await server.start()).url;
  const answer = async (question: number, text: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${base}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: key, answer: text, question, parkedAt: parked?.at }) });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  try {
    assert.equal((await answer(0, "letters")).released, false);
    assert.equal(loadJobs(second.store)[key]?.parked?.as, "needs-decision");
    assert.equal((await answer(1, "drop")).released, false);
    assert.equal((await answer(2, "yes")).released, true);
  } finally {
    await server.stop();
  }
  assert.equal(loadJobs(second.store)[key], undefined);
  await second.sync();
  assert.equal(second.store.get<WorkItem>(item)?.openQuestions, undefined);
});

const line = (kind: string, fields: Record<string, unknown>, at = "2026-11-18T09:00:00.000Z"): LogRecord => ({ at, by: { who: "scopesoup", machine: "laptop-a", agent: true }, kind, fields });
const workItem = (log: LogRecord[]): WorkItem => ({ ref: { host: "metaBranch", kind: "work", id: "A-9" }, title: "Synthetic", state: "todo", hostState: "todo", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-18T09:00:00Z", log });

test("a log read back: mid-session starts that step again, a new item and a person's lines give no job", () => {
  const mid = jobFromLog(workItem([
    line("session", { role: "implement", outcome: "succeeded", summary: "Added it.", next: "review" }),
    line("revision", { sha: SHA1, branch: "scopesoup/A-9" }),
  ]));
  assert.equal(mid?.step, "review");
  assert.equal(mid?.implement?.summary, "Added it.");
  assert.equal(mid?.head, SHA1);
  assert.equal(mid?.parked, undefined);
  assert.equal(jobFromLog(workItem([])), null);
  assert.equal(jobFromLog(workItem([{ ...line("session", { role: "triage", next: "implement" }), by: { who: "robin", agent: false } }])), null);
  assert.equal(jobFromLog({ ...workItem([line("session", { role: "triage", next: "implement" })]), state: "done" }), null);
});

test("a log whose last session sent the item to the removed check-review step is read back at that step, for the tick to move on", () => {
  const old = jobFromLog(workItem([
    line("session", { role: "implement", outcome: "succeeded", summary: "Added it.", next: "check-review" }),
    line("revision", { sha: SHA1, branch: "scopesoup/A-9" }),
  ]));
  assert.equal(old?.step as string, "check-review");
  assert.equal(old?.head, SHA1);
});

test("a log whose last session sent the item to the removed fix step is read back at that step, for the tick to move on", () => {
  const old = jobFromLog(workItem([
    line("session", { role: "review", outcome: "succeeded", summary: "changes, 1 finding(s)", next: "fix" }),
  ]));
  assert.equal(old?.step as string, "fix");
});

test("a log whose last review sent the change back to the implementor is read back with the findings for it", () => {
  const back = jobFromLog(workItem([
    line("session", { role: "implement", outcome: "succeeded", summary: "Added it.", next: "review" }),
    line("revision", { sha: SHA1, branch: "scopesoup/A-9" }),
    line("review", { sha: SHA1, verdict: "fail", findings: ["[must] src/a.ts: Off by one."] }),
    line("session", { role: "review", outcome: "succeeded", summary: "changes, 1 finding(s)", next: "implement" }),
  ]));
  assert.equal(back?.step, "implement");
  assert.equal(back?.resumeWith, "The reviewer asked for these changes:\n- [must] src/a.ts: Off by one.\nFix them and commit.");
});

test("a parked decision read back from the log keeps its options as { label, description } and its context", () => {
  const at = "2026-11-18T09:05:00.000Z";
  const by = { who: "scopesoup", machine: "laptop-a", agent: true };
  const options = [{ label: "Keep", description: "less work" }, { label: "Drop", description: "cleaner" }];
  const item: WorkItem = {
    ...workItem([line("question", { question: "Keep it?", options, recommendation: "Keep", context: "Also check the budget line.", parked: "needs-decision" }, at)]),
    openQuestions: [{ at, by, question: "Keep it?", options, recommendation: "Keep", context: "Also check the budget line." }],
  };
  const job = jobFromLog(item);
  assert.equal(job?.parked?.as, "needs-decision");
  assert.deepEqual(job?.triage?.decision, { question: "Keep it?", options, recommendation: "Keep", context: "Also check the budget line." });
  const plain = jobFromLog({ ...item, openQuestions: [{ at, by, question: "Keep it?", options: ["Keep", "Drop"] }] });
  assert.deepEqual(plain?.triage?.decision, { question: "Keep it?", options: ["Keep", "Drop"], recommendation: "" });
});

test("an item left parked on an old proposed rewrite (removed) is not held by it: a new store starts it at triage", async () => {
  const { host, item } = await project();
  // The question line the orchestrator wrote earlier, still open in the log.
  await host.write!.appendLog!(item, {
    kind: "question",
    by: { who: "scopesoup", agent: true },
    fields: { question: "A triage session proposes a new description for the item: Letters were never meant to be parsed.", proposal: { description: "Parse digits only.", reason: "Letters were never meant to be parsed." }, parked: "needs-decision" },
  });
  const laptop = start(host);
  await laptop.run();
  const read = laptop.store.get<WorkItem>(item);
  assert.equal(read?.openQuestions, undefined, "the old rewrite is not an open question");
  assert.ok(read?.log?.some((line) => line.kind === "question"), "the line stays in the log");
  assert.equal(laptop.requests.length, 1);
  assert.equal(laptop.requests[0]?.role, "triage");
});

test("a proposed split waits across a deleted store, with its parts", async () => {
  const { host, item } = await project();
  const key = refKey(item);
  const parts = [{ title: "First half", description: "Do half.", verification: "Half works." }, { title: "Second half", description: "Do the rest.", verification: "All works." }];
  const first = start(host);
  await first.run();
  await first.end("succeeded", { ...TRIAGE_OK, size: "large", parts });
  assert.equal(loadJobs(first.store)[key]?.parked?.as, "needs-decision");

  const second = start(host);
  await second.run();
  assert.equal(second.requests.length, 0, "nothing is started while the split waits");
  assert.deepEqual(loadJobs(second.store)[key]?.proposal?.parts, parts);
  assert.deepEqual(second.store.get<WorkItem>(item)?.openQuestions?.[0]?.proposal?.parts, parts);
});

test("an implementer's question with options survives a deleted store, and the answer resumes the item", async () => {
  const { host, item } = await project();
  const key = refKey(item);
  const first = start(host);
  await first.run();
  await first.end("succeeded", TRIAGE_OK);
  await first.end("succeeded", { ...IMPLEMENT_OK, done: false, needs: "decision", blockedReason: "x", decision: { question: "Digits or letters?", options: ["digits", "letters"], recommendation: "digits" } });
  assert.equal(loadJobs(first.store)[key]?.parked?.as, "needs-decision");

  const second = start(host);
  await second.run();
  assert.equal(second.requests.length, 0);
  const asked = second.store.get<WorkItem>(item)?.openQuestions?.[0];
  assert.deepEqual([asked?.question, asked?.options, asked?.recommendation], ["Digits or letters?", ["digits", "letters"], "digits"]);
  const server = createServer({ store: second.store, port: 0, items: { host: "metaBranch", write: host.write! }, syncNow: () => second.sync() });
  const base = (await server.start()).url;
  try {
    const response = await fetch(`${base}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: key, answer: "digits" }) });
    assert.equal(response.status, 200);
  } finally {
    await server.stop();
  }
  await second.run();
  assert.equal(second.requests.length, 1);
  assert.match(second.requests[0]?.vars.itemBody ?? "", /Asked: Digits or letters\?\n {2}Answered: digits/);
});
});
