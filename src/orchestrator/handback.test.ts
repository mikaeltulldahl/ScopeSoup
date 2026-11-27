// A person's hand-back takes the cycle on from the review: the job it makes, when it waits, and
// that a held item is left alone. The runner and the hosts are fakes; no agent is started. Synthetic data.

import { KEYS } from "../store/keys.ts";
import { setRolesForTest } from "../store/control.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedConfig } from "../config/loader.ts";
import type { ProjectConfig } from "../config/types.ts";
import { validateConfig } from "../config/validate.ts";
import type { Change, LogRecord, Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import { personOf } from "../core/turns.ts";
import { findHandbacks } from "./handback.ts";
import { loadJobs } from "./jobs.ts";
import type { Actions, AgentRunner } from "./ports.ts";
import { tick } from "./tick.ts";
import { where } from "./jobs.ts";

const SHA = "b".repeat(40);
const NEWER = "c".repeat(40);
const T0 = "2026-11-20T10:00:00.000Z";

function config(raw: Record<string, unknown> = {}): ProjectConfig {
  const result = validateConfig({
    project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", level: 3, ...raw,
  }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

const ref = (id: string): Ref => ({ host: "metaBranch", kind: "work", id });
const line = (kind: string, fields: Record<string, unknown>, by = { who: "Ada", machine: "laptop-a", agent: false }, at = "2026-11-20T09:00:00Z"): LogRecord => ({ at, by, kind, fields });
const HANDBACK = line("revision", { sha: SHA, branch: "scopesoup/A-1", handback: true, note: "with a test" });

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return { ref: ref(id), title: `Item ${id}`, state: "todo", hostState: "todo", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-20T09:00:00Z", ...over };
}

function world(items: WorkItem[], changes: Change[] = [], cfg = config(), branchHead: string | Error = SHA) {
  const store = openStore(":memory:");
  setRolesForTest(store, "started");
  store.setValue(KEYS.mergeQueue, "started");
  for (const each of items) store.put(each, "sync", T0);
  for (const each of changes) store.put(each, "sync", T0);
  const started: string[] = [];
  const logged: string[] = [];
  const runner: AgentRunner = {
    async start(request) {
      started.push(`${request.role} ${request.subject.id}`);
      return { ref: { host: "scopesoup", kind: "session", id: `s${started.length}` }, role: request.role, subject: request.subject, status: "running", attempt: 1, startedAt: T0, pid: 1, model: "m" };
    },
    async reconcile() {},
    stopAll: () => 0,
    running: () => 0,
    async takeWorkspace() {
      return null;
    },
    async releaseWorkspace() {},
    async deleteBranch() {},
    async changedPaths() {
      return ["src/a.ts"];
    },
    async commitsAhead() {
      return 1;
    },
    async head() {
      if (branchHead instanceof Error) throw branchHead;
      return branchHead;
    },
    // The remote's main does not contain the branch: nothing here is merged by a session.
    fetchMain: async () => ({ repo: "/srv/clone", main: "0".repeat(40) }),
    contains: async () => false,
  };
  const actions: Actions = {
    async claim() {
      return { won: true };
    },
    async release() {},
    async answerTurn() {},
    async appendLog(item, kind, fields) {
      logged.push(`${item.id} ${kind} ${JSON.stringify(fields)}`);
    },
  };
  const run = (at = T0) => tick({ store, runner, config: fixedConfig(cfg), actions, now: () => at });
  return { store, started, logged, run, job: (id: string) => loadJobs(store)[refKey(ref(id))], events: (kind: string) => store.eventsAfter(0, 1000).filter((event) => event.kind === kind) };
}

test("a hand-back on metaBranch: a person's revision line marked handback, newest of the log, for an open item", () => {
  const items = [
    item("A-1", { log: [line("created", {}), HANDBACK] }),
    // Written by an agent, or not marked: not a hand-back.
    item("A-2", { log: [line("revision", { sha: SHA, branch: "scopesoup/A-2", handback: true }, { who: "scopesoup", machine: "laptop-a", agent: true })] }),
    item("A-3", { log: [line("revision", { sha: SHA, branch: "scopesoup/A-3" })] }),
    // Scope Soup has worked on it since: its revision is the newest.
    item("A-4", { log: [HANDBACK, line("revision", { sha: NEWER, branch: "scopesoup/A-4" }, { who: "scopesoup", machine: "laptop-a", agent: true }, "2026-11-20T09:30:00Z")] }),
    item("A-5", { state: "done", log: [HANDBACK] }),
  ];
  const found = findHandbacks(items, []);
  assert.deepEqual(found.map((each) => [each.item.ref.id, each.branch, each.sha, each.by, each.note]), [["A-1", "scopesoup/A-1", SHA, "Ada on laptop-a", "with a test"]]);
});

test("a hand-back on GitHub: an open pull request with the label that names an open issue", () => {
  const gh = (id: string): Ref => ({ host: "github", kind: "work", id });
  const change = (over: Partial<Change> = {}): Change => ({
    ref: { host: "github", kind: "change", id: "41" }, title: "Cache", author: { id: "ada", name: "ada" }, state: "open", draft: false, target: "main", branch: "scopesoup/7",
    revisions: [{ id: SHA, sha: SHA, createdAt: T0, author: { id: "ada", name: "ada" } }], verdicts: [], labels: ["scopesoup:review"], works: [gh("7")], updatedAt: T0, ...over,
  });
  const issue = item("7", { ref: gh("7") });
  assert.deepEqual(findHandbacks([issue], [change()]).map((each) => [each.item.ref.id, each.branch, each.sha, each.by]), [["7", "scopesoup/7", SHA, "ada"]]);
  assert.deepEqual(findHandbacks([issue], [change({ labels: [] })]), []);
  assert.deepEqual(findHandbacks([issue], [change({ state: "merged" })]), []);
  assert.deepEqual(findHandbacks([item("7", { ref: gh("7"), state: "done" })], [change()]), []);
});

test("the tick takes a hand-back on: a job with the branch and head, and the review is next", async () => {
  const w = world([item("A-1", { log: [line("created", {}), HANDBACK, line("released", { reason: "handed back" })] })]);
  await w.run();
  const job = w.job("A-1")!;
  assert.equal(where(job).step, "review");
  assert.equal(job.branch, "scopesoup/A-1");
  assert.equal(job.head, SHA);
  assert.match(job.implement!.summary, /Handed back by Ada on laptop-a: with a test/);
  assert.equal(w.events("orchestrator.handback").length, 1);
  // The review session starts after the short continuation delay; not an implement session, not triage.
  await w.run("2026-11-20T10:00:02.000Z");
  assert.deepEqual(w.started, ["review A-1"]);
  // Once per hand-back: another tick makes no second job or event.
  await w.run("2026-11-20T10:00:05.000Z");
  assert.equal(w.events("orchestrator.handback").length, 1);
});

test("an old file that still lists a checklist goes straight to review: the checklist stage is gone", async () => {
  const w = world([item("A-1", { log: [HANDBACK] })], [], config({ review: { checklist: ["Tests are added."] } }));
  await w.run();
  assert.equal(where(w.job("A-1"))!.step, "review");
});

test("a hand-back waits while the item is held, the branch is not here, the stop switch is on, or the level is below 2", async () => {
  const held = world([item("A-1", { log: [HANDBACK], holder: { actor: { id: "Ada@laptop-a", name: "Ada on laptop-a" } } })]);
  await held.run();
  assert.equal(held.job("A-1"), undefined);

  const missing = world([item("A-1", { log: [HANDBACK] })], [], config(), new Error("The branch scopesoup/A-1 is not there."));
  await missing.run();
  assert.equal(missing.job("A-1"), undefined);
  assert.match((missing.events("orchestrator.handback_waits")[0]!.data as { reason: string }).reason, /not there/);

  const paused = world([item("A-1", { log: [HANDBACK] })]);
  // Implementors paused at level 2: the hand-back leads to the hand-over, so it waits for them to be resumed.
  setRolesForTest(paused.store, "paused");
  await paused.run();
  assert.equal(paused.job("A-1"), undefined);

  // Below level 2 (Implement) nothing is built, so a hand-back is not taken on either.
  for (const level of [0, 1]) {
    const low = world([item("A-1", { log: [HANDBACK] })], [], config({ level }));
    await low.run();
    assert.equal(low.job("A-1"), undefined);
    assert.deepEqual(low.started, []);
  }
});

test("an item a person holds is left alone, even with a job waiting for its next step", async () => {
  const w = world([item("A-1", { log: [HANDBACK] })]);
  await w.run();
  assert.equal(where(w.job("A-1"))!.step, "review");
  // A person takes it before the review starts.
  w.store.put(item("A-1", { log: [HANDBACK], holder: { actor: { id: "Bo@laptop-b", name: "Bo on laptop-b" } } }), "sync", T0);
  await w.run("2026-11-20T10:00:02.000Z");
  assert.deepEqual(w.started, []);
});

// Jira: a hand-back comment (`handedBack`), adopted once by its comment id, only on the Item's own branch at the sha it names.
const jiraRef = (id: string): Ref => ({ host: "jira", kind: "work", id });
const jiraJob = (store: ReturnType<typeof openStore>) => loadJobs(store)[refKey(jiraRef("DEMO-5"))];
const jiraItem = (over: Partial<WorkItem> = {}): WorkItem =>
  item("DEMO-5", { ref: jiraRef("DEMO-5"), handedBack: { id: "40007", sha: SHA, branch: "scopesoup/DEMO-5", by: { id: "robin", name: "Robin Example" }, at: T0, note: "colours" }, ...over });

test("a hand-back on Jira: found by its comment, the person is Robin, and another branch is not one", () => {
  const found = findHandbacks([jiraItem()], []);
  assert.deepEqual(found.map((each) => [each.key, each.branch, each.sha, each.by, each.comment, each.note]), [["jira:work:DEMO-5@comment:40007", "scopesoup/DEMO-5", SHA, "Robin Example", "40007", "colours"]]);
  assert.equal(personOf({ item: jiraItem() })?.name, "Robin Example");
  assert.deepEqual(findHandbacks([jiraItem({ handedBack: { id: "40008", sha: SHA, branch: "scopesoup/DEMO-3", by: { id: "robin", name: "Robin Example" }, at: T0 } })], []), []);
  assert.deepEqual(findHandbacks([jiraItem({ state: "done" })], []), []);
});

test("the tick takes a Jira hand-back on at the branch's head, writes the revision naming the comment, and never twice", async () => {
  const w = world([jiraItem()]);
  await w.run();
  const job = jiraJob(w.store)!;
  assert.equal(where(job).step, "review");
  assert.equal(job.head, SHA);
  assert.deepEqual(w.logged.filter((each) => each.includes("revision")), [`DEMO-5 revision ${JSON.stringify({ sha: SHA, branch: "scopesoup/DEMO-5", handback: "40007" })}`]);
  await w.run("2026-11-20T10:00:05.000Z");
  assert.equal(w.events("orchestrator.handback").length, 1);
});

test("a Jira hand-back whose sha is not the branch's head is refused, and one beside a standing job is not taken on", async () => {
  const moved = world([jiraItem()], [], config(), NEWER);
  await moved.run();
  assert.equal(jiraJob(moved.store), undefined);
  assert.deepEqual(moved.started, []);
  assert.match((moved.events("orchestrator.handback_refused")[0]!.data as { reason: string }).reason, /names bbbbbbbbb, but scopesoup\/DEMO-5 is at ccccccccc here/);

  // A job of the Item stands (a later hand-back, another comment): the new one is not taken on over it.
  const w = world([jiraItem()]);
  await w.run();
  w.store.put(jiraItem({ handedBack: { id: "40009", sha: SHA, branch: "scopesoup/DEMO-5", by: { id: "robin", name: "Robin Example" }, at: T0 } }), "sync", T0);
  await w.run("2026-11-20T10:00:05.000Z");
  assert.equal(w.events("orchestrator.handback").length, 1);
});
