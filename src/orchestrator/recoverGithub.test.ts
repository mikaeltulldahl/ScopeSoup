// On a GitHub Item Scope Soup's progress is one log comment, edited in place, and `recover.ts` rebuilds jobs from the
// comments after the store is deleted: the log, the questions, and a triage rewrite that waits. The real adapter and host
// actions run on a fake GitHub that keeps issues, comments and labels. Nothing reaches the network. All names are synthetic.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { createServer } from "../server/server.ts";
import { loadSnapshot } from "../server/snapshot.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { Context } from "./context.ts";
import { createLog } from "./context.ts";
import { createHostActions } from "./hostActions.ts";
import type { Jobs } from "./jobs.ts";
import { loadJobs, saveJobs, stepAt, parkedOf, rewriteOf, rewritePosted } from "./jobs.ts";
import { recoverFromLogs } from "./recover.ts";

const at = "2026-11-22T09:00:00Z";
const R = "/repos/harbour/tides/issues";
const fake = fakeIssues("harbour/tides", [1, 2, 3, 4, 5, 6]);
const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot", now: () => Date.parse(fake.clock) });
const ref = (id: string): Ref => ({ host: "github", kind: "work", id });
const key = (id: string): string => `github:work:${id}`;
const config = (() => {
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
})();
const QUESTION = { question: "Metric or imperial?", options: [{ label: "Metric", description: "Metres." }, { label: "Imperial", description: "Feet." }], recommendation: "Metric" };
const REWRITE = "Show the tide table in metres.";

const actionsOn = (store: Store) => createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store });
const writes = (): string[] => fake.calls.filter((call) => !call.startsWith("GET"));
const logOf = (id: string) => (fake.comments.get(id) ?? []).filter((comment) => readMarker(comment.body)?.kind === "log");
type Line = { at: string; kind: string; fields: Record<string, unknown> };
const linesOf = (id: string): Line[] => readMarker(logOf(id)[0]!.body)!.data.lines as Line[];

async function syncInto(into: Store): Promise<WorkItem[]> {
  const items = (await host.work.listWork()).items;
  for (const each of items) into.put(each, "sync", at);
  return items;
}

/** A fresh store synced from GitHub, as after deleting data/, and the recovery the first tick runs. */
async function deletedStore(): Promise<{ store: Store; jobs: Jobs; events: string[] }> {
  const store = openStore(":memory:");
  const items = await syncInto(store);
  const jobs: Jobs = {};
  const events: string[] = [];
  const log = createLog(store, at, () => jobs);
  const ctx = { deps: { store, actions: actionsOn(store) }, config, at, jobs, ...log, commit: (kind: string, reason: string, subject?: string, data?: Record<string, unknown>) => {
    events.push(`${kind}: ${reason}`);
    log.commit(kind, reason, subject, data);
  } } as unknown as Context;
  recoverFromLogs(ctx, items);
  return { store, jobs, events };
}

describe("the log comment", () => {
  test("the first line posts the log comment, the next ones edit it: two calls each, a list in words, made inert", async () => {
    const store = openStore(":memory:");
    const actions = actionsOn(store);
    fake.clear();
    await actions.appendLog(ref("1"), "session", { role: "triage", outcome: "succeeded", summary: "Fixes #2, asks @kim.", durationMs: 120_000, next: "implement" });
    assert.deepEqual(fake.calls, [`GET ${R}/1/comments?per_page=100`, `POST ${R}/1/comments`]);
    fake.clear();
    await actions.appendLog(ref("1"), "revision", { sha: "a".repeat(40), branch: "scopesoup/1" });
    await actions.appendLog(ref("1"), "review", { sha: "a".repeat(40), verdict: "pass", findings: [] });
    await actions.appendLog(ref("1"), "check", { sha: "a".repeat(40), verdict: "pass", command: "pnpm check" });
    const id = logOf("1")[0]!.id;
    assert.deepEqual(fake.calls, [0, 1, 2].flatMap(() => [`GET ${R}/1/comments?per_page=100`, `PATCH ${R}/comments/${id}`]));
    assert.equal(logOf("1").length, 1);
    // Questions, answers, claims and merges have comments of their own.
    fake.clear();
    await actions.appendLog(ref("1"), "merged", { sha: "a".repeat(40), target: "main" });
    assert.deepEqual(fake.calls, []);

    const body = logOf("1")[0]!.body!;
    assert.match(body, /^\*\*Scope Soup's log\*\* \(one comment, edited in place; newest last\)\n\n- 2026-11-22 09:00 UTC: triage session succeeded, 2 min: F​ixes #2, asks @​kim\. Next: implement\.\n- .*revision aaaaaaa on scopesoup\/1\.\n- .*review of aaaaaaa: pass\.\n- .*check of aaaaaaa: pass \(pnpm check\)\.\n\n<!-- scopesoup:log /);
    assert.deepEqual(linesOf("1").map((line) => line.kind), ["session", "revision", "review", "check"]);
    assert.equal(readMarker(body)!.data.dropped, 0);
    // Read back into the item.
    const item = await host.work.getWork(ref("1"));
    assert.deepEqual(item?.hostRecord?.log.map((line) => [line.kind, line.by]), ["session", "revision", "review", "check"].map((kind) => [kind, { who: "scopesoup", agent: true }]));
  });

  test("a session's summary is cut to 500 characters and a review's findings to 2,000; a log comment from someone else is not read", async () => {
    // A stranger's comment with a log marker: a plain comment.
    fake.reply(2, "stranger", "NONE", `Mine.\n\n<!-- scopesoup:log {"v":1,"lines":[{"at":"${at}","kind":"session","fields":{"next":"review"}}],"dropped":0} -->`);
    const store = openStore(":memory:");
    const actions = actionsOn(store);
    await actions.appendLog(ref("2"), "session", { role: "implement", outcome: "succeeded", summary: "x".repeat(4000) });
    await actions.appendLog(ref("2"), "review", { sha: "b".repeat(40), verdict: "fail", findings: Array.from({ length: 20 }, () => "y".repeat(600)) });
    assert.equal(logOf("2").length, 2);
    const own = readMarker(logOf("2").find((comment) => comment.user?.login === "scopesoup-bot")!.body)!.data.lines as Line[];
    assert.equal(own.length, 2);
    assert.equal((own[0]!.fields.summary as string).length, 500);
    assert.equal((own[1]!.fields.findings as string[]).join("").length, 2000);
    assert.equal((await host.work.getWork(ref("2")))?.hostRecord?.log.length, 2);
  });

  test("a log over 60,000 characters drops its oldest lines and counts them", async () => {
    const actions = actionsOn(openStore(":memory:"));
    for (let n = 0; n < 90; n++) await actions.appendLog(ref("3"), "session", { role: "implement", outcome: "succeeded", summary: `${n} ${"z".repeat(1600)}` });
    const body = logOf("3")[0]!.body!;
    assert.ok(body.length <= 60_000, String(body.length));
    const marker = readMarker(body)!;
    const lines = marker.data.lines as Line[];
    const dropped = marker.data.dropped as number;
    assert.ok(dropped > 0);
    assert.equal(lines.length + dropped, 90);
    // The newest is kept, the oldest are gone.
    assert.match(lines.at(-1)!.fields.summary as string, /^89 /);
    assert.match(lines[0]!.fields.summary as string, new RegExp(`^${dropped} `));
    assert.match(body, new RegExp(`\\n\\n_${dropped} older lines dropped\\._\\n\\n`));
  });

  test("a log write GitHub refuses is orchestrator.host_write_failed and does not stop the step", async () => {
    const store = openStore(":memory:");
    const actions = actionsOn(store);
    fake.refusesComments = true;
    try {
      await actions.appendLog(ref("6"), "session", { role: "triage", outcome: "succeeded", summary: "Done." });
    } finally {
      fake.refusesComments = false;
    }
    assert.equal(logOf("6").length, 0);
    const failed = store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.host_write_failed");
    assert.equal(failed.length, 1);
    assert.match(String((failed[0]!.data as { reason: string }).reason), /^Could not write the session line to the log comment of 6 on github: .* The step goes on without it\.$/);
  });
});

describe("recovery from GitHub", () => {
  test("after a store delete, an Item whose last session said next: review resumes at review", async () => {
    // In To do (its label): work under way is never in Backlog (decision 121).
    fake.issues.get("4")!.labels.push("scopesoup:todo");
    const actions = actionsOn(openStore(":memory:"));
    await actions.appendLog(ref("4"), "session", { role: "triage", outcome: "succeeded", summary: "Ready.", next: "implement", size: "small" });
    await actions.appendLog(ref("4"), "revision", { sha: "c".repeat(40), branch: "scopesoup/4" });
    await actions.appendLog(ref("4"), "session", { role: "implement", outcome: "succeeded", summary: "Built it.", next: "review" });
    const { jobs, events } = await deletedStore();
    const job = jobs[key("4")]!;
    assert.equal(stepAt(job), "review");
    // Issue 1's log says its implement step comes next, but it has no To do label: in Backlog no step is rebuilt (#268).
    assert.ok(logOf("1").length > 0);
    assert.equal(jobs[key("1")], undefined);
    assert.ok(events.some((each) => /^orchestrator\.recover_skipped: Not rebuilt from the item's comments on github: 1 is in Backlog, so its implement step does not start again/.test(each)), events.join("\n"));
    assert.equal(job.head, "c".repeat(40));
    assert.equal(job.branch, "scopesoup/4");
    assert.equal(job.triage?.size, "small");
    assert.ok(events.some((each) => each === "orchestrator.recovered: Rebuilt from the item's comments on github: the review step starts again"));
  });

  let store: Store;
  let server: ReturnType<typeof createServer>;
  let base: string;
  before(async () => {
    // Item 5 parked on round 2 of its triage (round 1 was answered otherwise), posted as the cycle posts it.
    const first = openStore(":memory:");
    const actions = actionsOn(first);
    first.put((await host.work.getWork(ref("5")))!, "sync", at);
    const old = await actions.postRewrite!(ref("5"), { round: 1, text: "Show the tides in feet." });
    await actions.askQuestions!(ref("5"), [{ ...QUESTION, parked: "needs-decision", step: "triage", rewrite: old!.id }]);
    fake.reply(5, "robin", "OWNER", "A1: Imperial");
    await actions.appendLog(ref("5"), "session", { role: "triage", outcome: "succeeded", summary: "Asks the units.", size: "small" });
    const rewrite = await actions.postRewrite!(ref("5"), { round: 2, text: REWRITE });
    await actions.askQuestions!(ref("5"), [{ ...QUESTION, parked: "needs-decision", step: "triage", rewrite: rewrite!.id }]);
    // Every question of round 2 answered with the recommendation by a reply: the rewrite waits for Accept, and the label stays.
    fake.reply(5, "robin", "OWNER", "A: Metric");
    first.close();
  });

  test("with the store deleted while a rewrite waits, one sync rebuilds the same rewrite, round and questions, and Accept still works", async () => {
    const recovered = await deletedStore();
    store = recovered.store;
    saveJobs(store, recovered.jobs);
    const job = loadJobs(store)[key("5")]!;
    const comments = fake.comments.get("5")!;
    const rewriteId = String(comments.filter((comment) => readMarker(comment.body)?.kind === "rewrite").at(-1)!.id);
    assert.equal(stepAt(job), "triage");
    assert.equal(job.rewriteRounds, 2);
    assert.deepEqual(rewriteOf(job), { original: "Show the tides.", text: REWRITE, questions: [QUESTION], round: 2 });
    assert.equal(parkedOf(job)?.as, "needs-decision");
    assert.equal(rewritePosted(job)?.id, rewriteId);
    assert.equal(rewritePosted(job)?.questions.length, 1);
    assert.doesNotMatch(parkedOf(job)?.reason ?? "", /no longer known/);
    // The board reads it from the job.
    const parked = loadSnapshot(store).parked?.find((each) => each.subject.id === "5");
    assert.deepEqual([parked?.rewrite?.text, parked?.rewrite?.round, parked?.rewrite?.questions.map((each) => each.question)], [REWRITE, 2, [QUESTION.question]]);
    assert.deepEqual(fake.issues.get("5")!.labels.map((label) => (typeof label === "string" ? label : label.name)), ["scopesoup:needs-decision"]);

    const actions = actionsOn(store);
    server = createServer({
      store, port: 0,
      questions: { host: "github", answer: actions.answerQuestion!, checkRewrite: actions.checkRewrite! },
      description: { host: "github", replace: actions.replaceDescription! },
      syncNow: async () => void (await syncInto(store)),
    });
    base = (await server.start()).url;
    try {
      fake.clear();
      const response = await fetch(`${base}/api/rewrite`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: key("5"), parkedAt: parkedOf(job)!.at, answers: ["Metric"], action: "accept" }) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { recorded: true, settled: "accepted", written: true });
      assert.equal(fake.issues.get("5")!.body, REWRITE);
      // The question had its answer from the reply: only the rewrite's answer is posted, then the label goes.
      assert.deepEqual(writes().filter((call) => !call.includes("/comments/")), [`PATCH ${R}/5`, `POST ${R}/5/comments`, `DELETE ${R}/5/labels/scopesoup%3Aneeds-decision`]);
      assert.deepEqual(fake.issues.get("5")!.labels, []);
      assert.equal(readMarker(fake.comments.get("5")!.at(-1)!.body)!.data.proposal, "accepted");
      assert.equal(linesOf("5").at(-1)!.kind, "edited");
    } finally {
      await server.stop();
      store.close();
    }
  });

  test("a rewrite whose body changed since is rebuilt with the current body as its original, and the parked Item says so", async () => {
    const actions = actionsOn(openStore(":memory:"));
    const rewrite = await actions.postRewrite!(ref("6"), { round: 1, text: "Show the tides, kindly." });
    assert.ok(rewrite);
    const issue = fake.issues.get("6")!;
    issue.body = "Show the tides, edited by a person.";
    issue.updated_at = fake.clock;
    const { jobs } = await deletedStore();
    const job = jobs[key("6")]!;
    assert.deepEqual(rewriteOf(job), { original: "Show the tides, edited by a person.", text: "Show the tides, kindly.", questions: [], round: 1 });
    assert.match(parkedOf(job)?.reason ?? "", /The description the rewrite read is no longer known: the current one is shown as the original\.$/);
  });
});
