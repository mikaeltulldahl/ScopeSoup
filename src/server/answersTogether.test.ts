// The board sends an Item's answers together: one POST /api/answers, one answer comment with `A1:` and `A2:` lines on
// GitHub (the real adapter on a fake GitHub), one transaction in the store, and the Item picked up once. All names are synthetic.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { T0, work } from "../core/testing.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { createHostActions } from "../orchestrator/hostActions.ts";
import type { Decision, Job } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs } from "../orchestrator/jobs.ts";
import { loadAnswers } from "../store/answers.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

const at = "2026-11-22T09:00:00Z";
const R = "/repos/harbour/tides/issues";
const fake = fakeIssues("harbour/tides", [1, 2, 3]);
const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
const ref = (id: string): Ref => ({ host: "github", kind: "work", id });
const key = (id: string): string => `github:work:${id}`;
const DECISIONS: Decision[] = [
  { question: "Round up or down?", options: [{ label: "down", description: "as the tables do" }, { label: "up", description: "safer" }], recommendation: "down" },
  { question: "Which unit?", options: [{ label: "metres", description: "SI" }, { label: "feet", description: "old charts" }], recommendation: "metres", multiSelect: true },
];

let store: Store;
let server: ScopeSoupServer;
let base: string;
let actions: ReturnType<typeof createHostActions>;

before(async () => {
  store = openStore(":memory:");
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store });
  server = createServer({
    store, port: 0,
    questions: { host: "github", answer: actions.answerQuestion!, answerMany: actions.answerQuestions!, checkRewrite: actions.checkRewrite! },
    description: { host: "github", replace: actions.replaceDescription! },
  });
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  store.close();
});

const jobOf = (item: Ref, over: Partial<Job>): Job => ({ item, workspace: `/srv/clone-${item.id}`, branch: `scopesoup/${item.id}`, step: "triage", failures: 0, fixRounds: 0, startedAt: at, ...over });

/** GitHub Item `id` parked on the two triage questions, posted as comments. */
async function parkedJob(id: string): Promise<string[]> {
  const asked = await actions.askQuestions!(ref(id), DECISIONS.map((each) => ({ ...each, parked: "needs-decision", step: "triage" })));
  saveJobs(store, {
    ...loadJobs(store),
    [key(id)]: jobOf(ref(id), {
      parked: { as: "needs-decision", reason: "Two questions.", at, questions: asked!.ids, askedAt: asked!.at },
      triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision: DECISIONS[0]!, decisions: DECISIONS },
    }),
  });
  return asked!.ids;
}

const post = (path: string, body: Record<string, unknown>) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
const answerComments = (id: string) => fake.sent.filter((each) => each.call === `POST ${R}/${id}/comments`).map((each) => (each.body as { body: string }).body);
const released = (since: number) => store.eventsAfter(since, 100).filter((event) => event.kind === "orchestrator.job_released");

describe("answers sent together on GitHub", () => {
  test("two answers, one an Other text, go up as one comment with A1 and A2, and the Item is picked up once", async () => {
    const ids = await parkedJob("1");
    fake.clear();
    const since = store.lastSeq();
    const response = await post("/api/answers", { ref: key("1"), parkedAt: at, answers: [{ question: 0, answer: "down: as the tables do" }, { question: 1, answer: "metres; fathoms, for the old harbour charts" }] });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { recorded: true, released: true, open: 0 });
    const posted = answerComments("1");
    assert.equal(posted.length, 1);
    assert.match(posted[0]!, /^\*\*A1:\*\* down: as the tables do\n\n\*\*A2:\*\* metres; fathoms, for the old harbour charts\n\n<!-- scopesoup:answer /);
    const marker = readMarker(posted[0]!)!;
    assert.deepEqual((marker.data.answers as { to: number; n: number; answer: string }[]).map((each) => [each.to, each.n, each.answer]), [
      [Number(ids[0]), 1, "down: as the tables do"],
      [Number(ids[1]), 2, "metres; fathoms, for the old harbour charts"],
    ]);
    // Read back as the answer to each question; the Item no longer waits, and its triage starts once.
    const item = store.get<WorkItem>(ref("1"))!;
    assert.deepEqual(item.answers?.map((each) => [each.to, each.answer]), [[ids[0], "down: as the tables do"], [ids[1], "metres; fathoms, for the old harbour charts"]]);
    assert.equal(item.openQuestions, undefined);
    assert.equal(loadJobs(store)[key("1")], undefined);
    assert.equal(released(since).length, 1);
    assert.deepEqual(store.eventsAfter(since, 100).filter((event) => event.kind === "person.answered").length, 2);
  });

  test("a partial Send answers one question; the other stays open and is answered later on its own", async () => {
    const ids = await parkedJob("2");
    fake.clear();
    const first = await post("/api/answers", { ref: key("2"), parkedAt: at, answers: [{ question: 1, answer: "feet: old charts" }] });
    assert.deepEqual(await first.json(), { recorded: true, released: false, open: 1 });
    assert.equal(answerComments("2").length, 1);
    assert.deepEqual(store.get<WorkItem>(ref("2"))!.openQuestions?.map((each) => each.id), [ids[0]]);
    assert.equal(loadJobs(store)[key("2")]?.parked?.as, "needs-decision");
    // Two answers to one question in one Send, or one already answered, are refused, and nothing is posted.
    fake.clear();
    const twice = await post("/api/answers", { ref: key("2"), parkedAt: at, answers: [{ question: 0, answer: "down" }, { question: 0, answer: "up" }] });
    assert.equal(twice.status, 400);
    const again = await post("/api/answers", { ref: key("2"), parkedAt: at, answers: [{ question: 0, answer: "down" }, { question: 1, answer: "metres" }] });
    assert.equal(again.status, 409);
    assert.deepEqual(answerComments("2"), []);
    const last = await post("/api/answers", { ref: key("2"), parkedAt: at, answers: [{ question: 0, answer: "up" }] });
    assert.deepEqual(await last.json(), { recorded: true, released: true, open: 0 });
  });

  test("a rewrite settled with its questions answered is one comment: the answers and the decision on the rewrite", async () => {
    store.put((await host.work.getWork(ref("3")))!, "sync", at);
    const question = { question: "Metric or imperial?", options: [{ label: "Metric", description: "Metres." }, { label: "Imperial", description: "Feet." }], recommendation: "Metric" };
    const rewrite = await actions.postRewrite!(ref("3"), { round: 1, text: "Show the tides in metres." });
    const asked = await actions.askQuestions!(ref("3"), [{ ...question, parked: "needs-decision", step: "triage", rewrite: rewrite!.id }]);
    saveJobs(store, {
      ...loadJobs(store),
      [key("3")]: jobOf(ref("3"), {
        triage: { ready: true, size: "small", paths: [], hidesDecision: true, decisions: [question], rewrite: "Show the tides in metres." },
        rewrite: { original: fake.issues.get("3")!.body ?? "", text: "Show the tides in metres.", questions: [question], round: 1 }, rewriteRounds: 1,
        parked: { as: "needs-decision", reason: "Triage, round 1.", at, rewrite: { id: rewrite!.id, questions: asked!.ids } },
      }),
    });
    fake.clear();
    const response = await post("/api/rewrite", { ref: key("3"), parkedAt: at, answers: ["Metric"], action: "reject" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { recorded: true, settled: "rejected" });
    const posted = answerComments("3");
    assert.equal(posted.length, 1);
    const entries = readMarker(posted[0]!)!.data.answers as { to: number; answer: string; proposal?: string }[];
    assert.deepEqual(entries.map((each) => [each.to, each.proposal ?? null]), [[Number(asked!.ids[0]), null], [Number(rewrite!.id), "rejected"]]);
    assert.equal(loadJobs(store)[key("3")]?.rewrite?.settled, "rejected");
  });
});

describe("answers sent together in Scope Soup's store", () => {
  const DECIDE: Decision[] = [
    { question: "Paint or stain?", options: ["paint", "stain"], recommendation: "paint" },
    { question: "Which side first?", options: ["north", "south"], recommendation: "north" },
  ];
  const parkedHere = (id: number): string => {
    const item = work(id, { title: "Mend the fence" });
    store.put(item, "sync", T0);
    const k = refKey(item.ref);
    saveJobs(store, { ...loadJobs(store), [k]: jobOf(item.ref, { parked: { as: "needs-decision", reason: "Two questions.", at: T0 }, triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision: DECIDE[0]!, decisions: DECIDE } }) });
    return k;
  };

  test("both answers are recorded in one transaction and the Item is released once; an Other text is kept as written", async () => {
    const k = parkedHere(41);
    const since = store.lastSeq();
    const response = await post("/api/answers", { ref: k, parkedAt: T0, answers: [{ question: 0, answer: "stain" }, { question: 1, answer: "Whichever side is dry first" }] });
    assert.deepEqual([response.status, await response.json()], [200, { recorded: true, released: true, open: 0 }]);
    assert.deepEqual(loadAnswers(store).filter((each) => refKey(each.subject) === k).map((each) => each.answer), ["stain", "Whichever side is dry first"]);
    assert.equal(released(since).length, 1);
    assert.equal(loadJobs(store)[k], undefined);
  });

  test("a refused answer in a Send rolls back the others; a partial Send leaves the rest open", async () => {
    const k = parkedHere(42);
    assert.deepEqual(await (await post("/api/answers", { ref: k, parkedAt: T0, answers: [{ question: 0, answer: "paint" }] })).json(), { recorded: true, released: false, open: 1 });
    const refused = await post("/api/answers", { ref: k, parkedAt: T0, answers: [{ question: 1, answer: "north" }, { question: 0, answer: "stain" }] });
    assert.equal(refused.status, 409);
    assert.deepEqual(loadAnswers(store).filter((each) => refKey(each.subject) === k).map((each) => each.answer), ["paint"]);
    assert.deepEqual(loadJobs(store)[k]?.answered?.map((each) => each.index), [0]);
  });
});
