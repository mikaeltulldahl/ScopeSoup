// On a GitHub Item the questions are comments and the answers are answer comments, written through by the real
// adapter on a fake GitHub that keeps its issues, comments and labels. Nothing reaches the network. All names are synthetic.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { reusableAnswer } from "../core/answerReuse.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { createHostActions } from "../orchestrator/hostActions.ts";
import type { Decision, Job } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs, parkedOf } from "../orchestrator/jobs.ts";
import { knownAnswers } from "../store/answers.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

const at = "2026-11-22T09:00:00Z";
const R = "/repos/harbour/tides/issues";
const LABEL = "scopesoup:needs-decision";
const fake = fakeIssues("harbour/tides", [1, 2, 3]);
const hostOf = () => createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
const ref = (id: string): Ref => ({ host: "github", kind: "work", id });
const key = (id: string): string => `github:work:${id}`;
const DECISIONS: Decision[] = [
  { question: "Round up or down?", options: [{ label: "down", description: "as the tables do" }, { label: "up", description: "safer" }], recommendation: "down" },
  { question: "Which unit?", options: ["metres", "feet"], recommendation: "metres" },
];
const asking = DECISIONS.map((each) => ({ ...each, parked: "needs-decision", step: "triage" }));

let store: Store;
let server: ScopeSoupServer;
let base: string;
let actions: ReturnType<typeof createHostActions>;

before(async () => {
  store = openStore(":memory:");
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  actions = createHostActions({ host: hostOf(), git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store });
  server = createServer({ store, port: 0, questions: { host: "github", answer: actions.answerQuestion! } });
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  store.close();
});

/** Item `id` parked on the two triage questions, posted as comments. */
async function parkedJob(id: string): Promise<Job> {
  const asked = await actions.askQuestions!(ref(id), asking);
  assert.ok(asked);
  const job: Job = {
    item: ref(id), workspace: `/srv/clone-${id}`, branch: `scopesoup/${id}`, failures: 0, fixRounds: 0, startedAt: at,
    triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision: DECISIONS[0]!, decisions: DECISIONS }, at: { kind: "parked", step: "triage", parked: { as: "needs-decision", reason: "Two questions.", at, questions: asked.ids, askedAt: asked.at }, ask: { is: "questions", list: DECISIONS } }
  };
  saveJobs(store, { ...loadJobs(store), [key(id)]: job });
  return job;
}

const answer = (body: Record<string, unknown>) => fetch(`${base}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
const labels = (id: string): string[] => fake.issues.get(id)!.labels.map((label) => (typeof label === "string" ? label : label.name));
const item = (id: string): WorkItem => store.get<WorkItem>(ref(id))!;

describe("questions and answers as comments", () => {
  test("asking posts the label first, then one numbered comment per question with its marker; numbers are never reused", async () => {
    fake.clear();
    await parkedJob("1");
    assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET")), ["POST /repos/harbour/tides/labels", `POST ${R}/1/labels`, `POST ${R}/1/comments`, `POST ${R}/1/comments`]);
    const [first, second] = fake.comments.get("1")!;
    assert.match(first!.body!, /^\*\*Q1: Round up or down\?\*\*\n\n- \*\*down\*\* \(recommended\): as the tables do\n- \*\*up\*\*: safer\n\nAnswer on Scope Soup's board, or reply here with `A1: <your answer>`\./);
    assert.deepEqual(readMarker(second!.body)?.data, { v: 1, n: 2, question: "Which unit?", options: ["metres", "feet"], recommendation: "metres", parked: "needs-decision", step: "triage" });
    assert.deepEqual(labels("1"), [LABEL]);
    // The re-read is in the store at once.
    assert.deepEqual(item("1").openQuestions?.map((each) => each.question), ["Round up or down?", "Which unit?"]);
    assert.equal(item("1").needsDecision, true);
    // Asked again on the same issue: Q3, not Q1.
    const again = await actions.askQuestions!(ref("1"), [{ question: "And the rounding of half?", options: [], parked: "needs-decision", step: "implement" }]);
    assert.equal(readMarker(fake.comments.get("1")!.at(-1)!.body)?.data.n, 3);
    fake.deleteComment(Number(again!.ids[0]));
  });

  test("the board's answer is an answer comment; a second answer is a 409; the last one un-parks the Item and removes the label", async () => {
    const job = await parkedJob("2");
    fake.clear();
    const first = await answer({ ref: key("2"), answer: "down", question: 0, parkedAt: at });
    assert.equal(first.status, 200, await first.clone().text());
    assert.deepEqual(await first.json(), { recorded: true, released: false, open: 1 });
    const posted = fake.sent.find((each) => each.call === `POST ${R}/2/comments`)!.body as { body: string };
    const marker = readMarker(posted.body)!;
    assert.equal(marker.kind, "answer");
    assert.equal(marker.data.to, Number(parkedOf(job)!.questions![0]));
    assert.equal(marker.data.answer, "down");
    assert.equal(marker.data.n, 1);
    assert.equal(typeof marker.data.textHash, "string");
    assert.deepEqual(marker.data.options, ["down: as the tables do", "up: safer"]);
    assert.match(posted.body, /^\*\*A1:\*\* down/);
    assert.deepEqual(labels("2"), [LABEL]);

    const twice = await answer({ ref: key("2"), answer: "up", question: 0, parkedAt: at });
    assert.equal(twice.status, 409);
    assert.equal(((await twice.json()) as { error: { code: string } }).error.code, "ALREADY_ANSWERED");
    // An `A1:` reply to the answered question is a plain comment.
    fake.reply(2, "kim", "COLLABORATOR", "A1: up after all");
    store.put((await hostOf().work.getWork(ref("2")))!, "sync", at);
    assert.deepEqual(item("2").answers?.map((each) => each.answer), ["down"]);

    const last = await answer({ ref: key("2"), answer: "metres", question: 1, parkedAt: at });
    assert.deepEqual(await last.json(), { recorded: true, released: true, open: 0 });
    assert.equal(loadJobs(store)[key("2")], undefined);
    assert.deepEqual(labels("2"), []);
    // Nothing kept in the store's answers: the answers are the comments, and reuse reads them.
    assert.equal(store.getValue("person.answers"), null);
    assert.deepEqual(knownAnswers(store).filter((each) => each.subject.id === "2").map((each) => each.answer), ["down", "metres"]);
    assert.equal(reusableAnswer(knownAnswers(store), item("2"), { question: "Should the amounts round down or up?", options: DECISIONS[0]!.options })?.answer, "down");
  });

  test("an answer GitHub does not show fails, writes orchestrator.host_write_failed and leaves the Item parked", async () => {
    await parkedJob("3");
    fake.dropsLabels = true;
    const response = await answer({ ref: key("3"), answer: "down", question: 0, parkedAt: at });
    // The first answer posts; the label stays because GitHub keeps it, so only the last answer could fail on it. Answer the last.
    assert.equal(response.status, 200);
    const last = await answer({ ref: key("3"), answer: "metres", question: 1, parkedAt: at });
    fake.dropsLabels = false;
    assert.equal(last.status, 400);
    assert.match(((await last.json()) as { error: { message: string } }).error.message, /label scopesoup:needs-decision not removed/);
    assert.equal(store.eventsAfter(0, 10_000).filter((event) => event.kind === "orchestrator.host_write_failed" && event.subject === key("3")).length, 1);
    assert.equal(parkedOf(loadJobs(store)[key("3")])?.as, "needs-decision");
  });

  test("deleting the store and syncing brings back the open questions and every answer", async () => {
    const fresh = openStore(":memory:");
    for (const each of (await hostOf().work.listWork()).items) fresh.put(each, "sync", at);
    const one = fresh.get<WorkItem>(ref("1"))!;
    assert.deepEqual(one.openQuestions?.map((each) => each.question), ["Round up or down?", "Which unit?"]);
    assert.equal(one.needsDecision, true);
    const two = fresh.get<WorkItem>(ref("2"))!;
    assert.equal(two.openQuestions, undefined);
    assert.deepEqual(two.answers?.map((each) => [each.question, each.answer, each.by]), [["Round up or down?", "down", "Ada"], ["Which unit?", "metres", "Ada"]]);
    assert.ok(two.answers?.every((each) => each.textHash && each.options?.length === 2));
    const three = fresh.get<WorkItem>(ref("3"))!;
    assert.deepEqual(three.answers?.map((each) => each.answer), ["down", "metres"]);
    assert.deepEqual(knownAnswers(fresh).map((each) => `${each.subject.id} ${each.answer}`), ["2 down", "2 metres", "3 down", "3 metres"]);
    fresh.close();
  });
});
