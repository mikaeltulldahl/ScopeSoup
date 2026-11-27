// On a GitHub Item each triage round's rewrite is a comment, and a proposed restructuring is a question comment. A person's
// Accept, Edit and Reject are answer comments, written through by the real adapter on a fake GitHub that keeps its issues,
// comments, labels and sub-issues. Nothing reaches the network. All names are synthetic.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { createHostActions } from "../orchestrator/hostActions.ts";
import type { Job } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs } from "../orchestrator/jobs.ts";
import { TooLarge } from "../ports/host.ts";
import { knownAnswers } from "../store/answers.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";
import { where } from "../orchestrator/jobs.ts";
import { jobOf } from "../orchestrator/jobs.ts";
import type { Where } from "../orchestrator/jobs.ts";

const at = "2026-11-22T09:00:00Z";
const R = "/repos/harbour/tides/issues";
const LABEL_PATH = `${R}/%s/labels/scopesoup%3Aneeds-decision`;
const fake = fakeIssues("harbour/tides", [1, 2, 3, 4, 5]);
const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
const ref = (id: string): Ref => ({ host: "github", kind: "work", id });
const key = (id: string): string => `github:work:${id}`;
const QUESTION = { question: "Metric or imperial?", options: [{ label: "Metric", description: "Metres." }, { label: "Imperial", description: "Feet." }], recommendation: "Metric" };
const REWRITE = "Show the tide table in metres.";
const PARTS = [
  { title: "Tide heights", description: "Read the heights.", verification: "Heights show.", goes: "child" as const },
  { title: "Tide times", description: "Read the times.", verification: "Times show.", goes: "child" as const },
  { title: "Tide chart", description: "Draw the chart.", verification: "The chart shows.", goes: "child" as const },
];
const REASON = "Triage: too large for one change; it proposes 3 parts.";

let store: Store;
let server: ScopeSoupServer;
let base: string;
let actions: ReturnType<typeof createHostActions>;
const config = (() => {
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
})();

/** Everything GitHub has, into `into`: what the server's sync does. */
async function syncInto(into: Store): Promise<void> {
  for (const each of (await host.work.listWork()).items) into.put(each, "sync", at);
}

function serverOn(into: Store, acts: ReturnType<typeof createHostActions>): ScopeSoupServer {
  return createServer({
    store: into, port: 0,
    questions: { host: "github", answer: acts.answerQuestion!, checkRewrite: acts.checkRewrite! },
    description: { host: "github", replace: acts.replaceDescription! },
    restructure: [{ host: "github", write: host.write!, verificationInBody: true, issueNumbers: true }],
    syncNow: () => syncInto(into),
  });
}

before(async () => {
  store = openStore(":memory:");
  actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store });
  server = serverOn(store, actions);
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  store.close();
});

const jobFor = (id: string, over: Partial<Job & Where>): Job => (jobOf({ item: ref(id), workspace: `/srv/clone-${id}`, branch: `scopesoup/${id}`, step: "triage", failures: 0, fixRounds: 0, startedAt: at, ...over }));

/** Item `id` parked on round 1 of its triage, posted as the cycle does: the rewrite comment, then its question. */
async function rewriteParked(id: string): Promise<{ rewrite: string; question: string }> {
  store.put((await host.work.getWork(ref(id)))!, "sync", at);
  const rewrite = await actions.postRewrite!(ref(id), { round: 1, text: REWRITE });
  const asked = await actions.askQuestions!(ref(id), [{ ...QUESTION, parked: "needs-decision", step: "triage", rewrite: rewrite!.id }]);
  const job = jobFor(id, ({
    triage: { ready: true, size: "small", paths: [], hidesDecision: true, decisions: [QUESTION], rewrite: REWRITE },
    rewrite: { original: "Show the tides.", text: REWRITE, questions: [QUESTION], round: 1 }, rewriteRounds: 1,
    parked: { as: "needs-decision", reason: "Triage, round 1.", at, rewrite: { id: rewrite!.id, questions: asked!.ids } },
  }));
  saveJobs(store, { ...loadJobs(store), [key(id)]: job });
  return { rewrite: rewrite!.id, question: asked!.ids[0]! };
}

const post = (url: string, body: Record<string, unknown>, where = base) => fetch(`${where}${url}`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
const writes = (): string[] => fake.calls.filter((call) => !call.startsWith("GET"));
const lastMarker = (id: string) => readMarker(fake.comments.get(id)!.at(-1)!.body)!;
const errorCode = async (response: Response): Promise<string> => ((await response.json()) as { error: { code: string } }).error.code;

describe("triage rewrites and restructurings as comments", () => {
  test("Accept: the body is checked, then PATCHed, then an answer comment to the question and one to the rewrite with proposal accepted", async () => {
    const { rewrite, question } = await rewriteParked("1");
    fake.clear();
    const response = await post("/api/rewrite", { ref: key("1"), parkedAt: at, answers: ["Metric"], action: "accept" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { recorded: true, settled: "accepted", written: true });
    // The body, the edited line in a new log comment, the answer, the rewrite's answer; the label goes only with the rewrite settled.
    assert.deepEqual(writes(), [`PATCH ${R}/1`, `POST ${R}/1/comments`, `POST ${R}/1/comments`, `POST ${R}/1/comments`, `DELETE ${LABEL_PATH.replace("%s", "1")}`]);
    assert.equal(fake.issues.get("1")!.body, REWRITE);
    const comments = fake.comments.get("1")!;
    const log = comments.map((comment) => readMarker(comment.body)).find((marker) => marker?.kind === "log")!;
    assert.deepEqual((log.data.lines as { kind: string; fields: unknown }[]).map((line) => [line.kind, line.fields]), [
      ["edited", { changed: ["description"], via: "triage, round 1", wasSha: createHash("sha256").update("Show the tides.").digest("hex") }],
    ]);
    assert.deepEqual([readMarker(comments.at(-2)!.body)!.data.to, readMarker(comments.at(-2)!.body)!.data.answer], [Number(question), "Metric"]);
    const decided = lastMarker("1");
    assert.equal(decided.kind, "answer");
    assert.equal(decided.data.to, Number(rewrite));
    assert.equal(decided.data.proposal, "accepted");
    assert.equal(loadJobs(store)[key("1")]?.rewrite?.settled, "accepted");
    // Nothing kept in the store's answers: the answers are read from the markers.
    assert.equal(store.getValue("person.answers"), null);
    assert.deepEqual(knownAnswers(store).filter((each) => each.subject.id === "1").map((each) => [each.question, each.answer]), [
      ["Metric or imperial?", "Metric"],
      ["Triage rewrite, round 1", "Accepted the triage's rewrite: the description above is the new text."],
    ]);
  });

  test("Accept after a person edited the body is a 409 BODY_CHANGED; nothing is written, the new body is in the store, and Edit still settles it", async () => {
    const { rewrite } = await rewriteParked("2");
    const issue = fake.issues.get("2")!;
    issue.body = "Show the tides, in feet please.";
    issue.updated_at = "2026-11-22T10:00:00Z";
    fake.clear();
    const refused = await post("/api/rewrite", { ref: key("2"), parkedAt: at, answers: ["Metric"], action: "accept" });
    assert.equal(refused.status, 409);
    assert.equal(await errorCode(refused), "BODY_CHANGED");
    assert.deepEqual(writes(), []);
    assert.equal(issue.body, "Show the tides, in feet please.");
    assert.equal(where(loadJobs(store)[key("2")])?.parked?.as, "needs-decision");
    // The board shows the new body next to the rewrite.
    assert.equal(store.get<WorkItem>(ref("2"))?.body, "Show the tides, in feet please.");

    const edited = await post("/api/rewrite", { ref: key("2"), parkedAt: at, answers: ["Metric"], action: "edit", text: "Show the tide table in metres and feet." });
    assert.equal(edited.status, 200, await edited.clone().text());
    assert.equal(issue.body, "Show the tide table in metres and feet.");
    assert.deepEqual([lastMarker("2").data.to, lastMarker("2").data.proposal], [Number(rewrite), "edited"]);
  });

  test("Reject posts an answer comment with proposal rejected and leaves the body", async () => {
    const { rewrite } = await rewriteParked("3");
    fake.clear();
    const response = await post("/api/rewrite", { ref: key("3"), parkedAt: at, answers: ["Metric"], action: "reject" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { recorded: true, settled: "rejected" });
    assert.ok(!writes().some((call) => call.startsWith("PATCH")));
    assert.equal(fake.issues.get("3")!.body, "Show the tides.");
    assert.deepEqual([lastMarker("3").data.to, lastMarker("3").data.proposal], [Number(rewrite), "rejected"]);
    // Pressing again: the rewrite has its answer.
    const again = await post("/api/rewrite", { ref: key("3"), parkedAt: at, answers: ["Metric"], action: "reject" });
    assert.equal(again.status, 409);
  });

  test("a restructuring too large for a comment posts nothing", async () => {
    fake.clear();
    const huge = [{ title: "All of it", description: "Tides. ".repeat(9000), verification: "", goes: "child" as const }];
    await assert.rejects(actions.askQuestions!(ref("5"), [{ question: `Proposed restructuring: ${REASON}`, options: [], parked: "needs-decision", step: "triage", proposal: { id: "abc12345", reason: REASON, original: "umbrella" as const, parts: huge } }]), TooLarge);
    assert.deepEqual(writes(), []);
  });

  test("with the store deleted mid-restructuring, the next Accept links the existing children and creates only the missing parts", async () => {
    store.put((await host.work.getWork(ref("4")))!, "sync", at);
    const asked = await actions.askQuestions!(ref("4"), [{ question: `Proposed restructuring: ${REASON}`, options: [], parked: "needs-decision", step: "triage", proposal: { id: "abc12345", reason: REASON, original: "umbrella" as const, parts: PARTS } }]);
    assert.deepEqual(readMarker(fake.comments.get("4")!.at(-1)!.body)!.data.proposal, { id: "abc12345", reason: REASON, original: "umbrella", parts: PARTS });
    saveJobs(store, { ...loadJobs(store), [key("4")]: jobFor("4", ({ proposal: { id: "abc12345", reason: REASON, original: "umbrella" as const, parts: PARTS }, parked: { as: "needs-decision", reason: REASON, at, questions: asked!.ids, askedAt: asked!.at } })) });

    // Part 1 is created and linked; part 2 is created, but GitHub refuses its link.
    let links = 0;
    fake.onCall = (call) => {
      if (call === `POST ${R}/4/sub_issues` && ++links === 1) fake.refusesSubIssues = true;
    };
    const first = await post("/api/proposal", { ref: key("4"), action: "accept" });
    fake.onCall = undefined;
    fake.refusesSubIssues = false;
    assert.equal(first.status, 502);
    assert.equal(await errorCode(first), "RESTRUCTURE_INCOMPLETE");
    assert.deepEqual([...fake.issues.keys()], ["1", "2", "3", "4", "5", "6", "7"]);
    // `created` is not stored: the children are the sub-issues with the part line.
    assert.equal(loadJobs(store)[key("4")]?.proposal?.created, undefined);

    // Part 1 was made before the line changed, naming the ref key: it is still found.
    const old = fake.issues.get("6")!;
    assert.match(old.body ?? "", /Part 1 of restructuring abc12345 of #4\.$/);
    old.body = (old.body ?? "").replace("Part 1 of restructuring abc12345 of #4.", "Part 1 of restructuring abc12345 of github:work:4.");
    old.updated_at = "2026-11-22T11:00:00Z";
    // The store is deleted: a new one is synced from GitHub, with no job.
    const fresh = openStore(":memory:");
    await syncInto(fresh);
    assert.equal(fresh.get<WorkItem>(ref("4"))?.openQuestions?.[0]?.proposal?.parts.length, 3);
    const freshActions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store: fresh });
    const second = serverOn(fresh, freshActions);
    const url = (await second.start()).url;
    try {
      fake.clear();
      const done = await post("/api/proposal", { ref: key("4"), action: "accept" }, url);
      assert.equal(done.status, 200, await done.clone().text());
      assert.deepEqual(((await done.json()) as { created: string[] }).created, [key("6"), key("7"), key("8")]);
      // #7 is linked, #8 created; nothing else is made.
      assert.deepEqual(writes(), [`POST ${R}/4/sub_issues`, `POST ${R}`, `POST ${R}/4/sub_issues`, `POST ${R}/4/comments`, `DELETE ${LABEL_PATH.replace("%s", "4")}`]);
      assert.deepEqual([...fake.issues.keys()], ["1", "2", "3", "4", "5", "6", "7", "8"]);
      for (const [index, child] of ["6", "7", "8"].entries()) {
        assert.equal(fake.issues.get(child)!.parent_issue_url, `${ISSUES_API}${R}/4`);
        assert.match(fake.issues.get(child)!.body ?? "", new RegExp(`Part ${index + 1} of restructuring abc12345 of ${child === "6" ? "github:work:4" : "#4"}\\.$`));
      }
      assert.deepEqual([lastMarker("4").data.to, lastMarker("4").data.proposal], [Number(asked!.ids[0]), "accepted"]);
      assert.equal(fresh.getValue("person.answers"), null);
      assert.match(knownAnswers(fresh).find((each) => each.subject.id === "4")?.question ?? "", /^Proposed restructuring: /);
    } finally {
      await second.stop();
      fresh.close();
    }
  });

  test("Reject of a restructuring posts an answer comment with proposal rejected and un-parks the Item", async () => {
    store.put((await host.work.getWork(ref("5")))!, "sync", at);
    const parts = PARTS.slice(0, 2).map((part) => ({ ...part, title: `${part.title} (5)` }));
    const asked = await actions.askQuestions!(ref("5"), [{ question: `Proposed restructuring: ${REASON}`, options: [], parked: "needs-decision", step: "triage", proposal: { id: "abc12345", reason: REASON, original: "umbrella" as const, parts } }]);
    saveJobs(store, { ...loadJobs(store), [key("5")]: jobFor("5", ({ proposal: { id: "abc12345", reason: REASON, original: "umbrella" as const, parts }, parked: { as: "needs-decision", reason: REASON, at, questions: asked!.ids, askedAt: asked!.at } })) });
    const response = await post("/api/proposal", { ref: key("5"), action: "reject" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { recorded: true, released: true });
    assert.deepEqual([lastMarker("5").data.to, lastMarker("5").data.proposal], [Number(asked!.ids[0]), "rejected"]);
    assert.equal(loadJobs(store)[key("5")], undefined);
    assert.equal(store.getValue("person.answers"), null);
  });
});

// The triage's label changes go with its rewrite: Accept applies them with one call per label, Reject applies none.
describe("label changes in a triage rewrite on GitHub", () => {
  const gh = fakeIssues("harbour/tides", [11, 12, 13, 14, 15]);
  const ghHost = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: gh.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  let db: Store;
  let acts: ReturnType<typeof createHostActions>;
  let board: ScopeSoupServer;
  let url: string;
  const CHANGE = { add: ["bug"], remove: ["question"] };
  let aiLabel: string | undefined;
  const labelsOf = (id: string): string[] => gh.issues.get(id)!.labels.map((label) => (typeof label === "string" ? label : label.name));
  const labelWrites = (): string[] => gh.calls.filter((call) => /\/labels/.test(call) && !call.startsWith("GET") && !call.includes("scopesoup"));

  before(async () => {
    for (const name of ["bug", "question", "scopesoup:claimed"]) gh.labels.add(name);
    for (const id of ["11", "12", "13", "14", "15"]) gh.issues.get(id)!.labels.push({ name: "question" });
    db = openStore(":memory:");
    acts = createHostActions({ host: ghHost, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => (aiLabel ? { ...config, labels: { aiGenerated: aiLabel } } : config), store: db });
    board = createServer({
      store: db, port: 0,
      questions: { host: "github", answer: acts.answerQuestion!, checkRewrite: acts.checkRewrite! },
      description: { host: "github", replace: acts.replaceDescription! },
      labels: { host: "github", change: acts.changeLabels! },
      aiLabel: () => aiLabel,
      syncNow: async () => {
        for (const each of (await ghHost.work.listWork()).items) db.put(each, "sync", at);
      },
    });
    url = (await board.start()).url;
  });

  after(async () => {
    await board.stop();
    db.close();
  });

  /** Item `id` parked on a rewrite (no questions) proposing +bug, −question, posted as the cycle posts it. */
  async function proposing(id: string): Promise<string> {
    db.put((await ghHost.work.getWork(ref(id)))!, "sync", at);
    const rewrite = await acts.postRewrite!(ref(id), { round: 1, text: REWRITE, labels: CHANGE });
    saveJobs(db, { ...loadJobs(db), [key(id)]: jobFor(id, ({
      triage: { ready: true, size: "small", paths: [], hidesDecision: false, rewrite: REWRITE },
      rewrite: { original: "Show the tides.", text: REWRITE, questions: [], round: 1, labels: CHANGE }, rewriteRounds: 1,
      parked: { as: "needs-decision", reason: "Triage, round 1.", at, rewrite: { id: rewrite!.id, questions: [] } },
    })) });
    return rewrite!.id;
  }

  test("Accept applies the description and +bug, −question together: exactly one add and one remove call, then the re-read", async () => {
    const rewrite = await proposing("11");
    assert.deepEqual(readMarker(gh.comments.get("11")!.at(-1)!.body)?.data.labels, CHANGE);
    gh.clear();
    const response = await post("/api/rewrite", { ref: key("11"), parkedAt: at, answers: [], action: "accept" }, url);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { recorded: true, settled: "accepted", written: true, labels: { added: ["bug"], removed: ["question"] } });
    assert.deepEqual(labelWrites(), [`POST ${R}/11/labels`, `DELETE ${R}/11/labels/question`]);
    assert.deepEqual(gh.sent.find((each) => each.call === `POST ${R}/11/labels`)?.body, { labels: ["bug"] });
    // A re-read follows the label calls.
    const after = gh.calls.slice(gh.calls.indexOf(`DELETE ${R}/11/labels/question`) + 1);
    assert.ok(after.includes(`GET ${R}/11`), gh.calls.join("\n"));
    assert.deepEqual(labelsOf("11"), ["bug"]);
    assert.equal(gh.issues.get("11")!.body, REWRITE);
    const decided = readMarker(gh.comments.get("11")!.at(-1)!.body)!;
    assert.deepEqual([decided.data.to, decided.data.proposal], [Number(rewrite), "accepted"]);
    assert.match(String(decided.data.answer), /Labels: \+bug, −question\.$/);
    assert.deepEqual(db.get<WorkItem>(ref("11"))?.labels, ["bug"]);
  });

  test("Accept with the AI label on: the label is made in the repository and put on the Item, beside the rewrite's own label changes", async () => {
    aiLabel = "ai-generated";
    try {
      await proposing("15");
      const response = await post("/api/rewrite", { ref: key("15"), parkedAt: at, answers: [], action: "accept" }, url);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(labelsOf("15").sort(), ["ai-generated", "bug"]);
      assert.equal(gh.labels.has("ai-generated"), true);
      assert.equal(gh.issues.get("15")!.body, REWRITE);
    } finally {
      aiLabel = undefined;
    }
  });

  test("Reject leaves the labels and the description unchanged", async () => {
    await proposing("12");
    gh.clear();
    const response = await post("/api/rewrite", { ref: key("12"), parkedAt: at, answers: [], action: "reject" }, url);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(labelWrites(), []);
    assert.deepEqual(labelsOf("12"), ["question"]);
    assert.equal(gh.issues.get("12")!.body, "Show the tides.");
  });

  test("labels a person changed after the rewrite stay as they set them: an add already there and a remove already gone are no-ops", async () => {
    await proposing("13");
    const issue = gh.issues.get("13")!;
    issue.labels = [{ name: "bug" }];
    gh.clear();
    const response = await post("/api/rewrite", { ref: key("13"), parkedAt: at, answers: [], action: "accept" }, url);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(labelWrites(), []);
    assert.deepEqual(labelsOf("13"), ["bug"]);
  });

  test("Edit lets a person change the labels with the description; scopesoup:* is never applied", async () => {
    await proposing("14");
    gh.clear();
    const response = await post("/api/rewrite", { ref: key("14"), parkedAt: at, answers: [], action: "edit", text: "Show the tides in metres.", labels: { add: ["bug", "scopesoup:claimed"], remove: [] } }, url);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(labelWrites(), [`POST ${R}/14/labels`]);
    assert.deepEqual(labelsOf("14"), ["question", "bug"]);
    assert.equal(gh.issues.get("14")!.body, "Show the tides in metres.");
  });
});

describe("scopesoup:needs-decision while a triage rewrite waits for an answer", () => {
  const gh = fakeIssues("harbour/tides", [21, 22, 23, 24, 25]);
  const ghHost = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: gh.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  let db: Store;
  let acts: ReturnType<typeof createHostActions>;
  let board: ScopeSoupServer;
  let url: string;
  const LABEL = "scopesoup:needs-decision";
  const labelled = (id: string): boolean => gh.issues.get(id)!.labels.some((label) => (typeof label === "string" ? label : label.name) === LABEL);

  before(async () => {
    db = openStore(":memory:");
    acts = createHostActions({ host: ghHost, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store: db });
    board = createServer({
      store: db, port: 0,
      questions: { host: "github", answer: acts.answerQuestion!, checkRewrite: acts.checkRewrite! },
      description: { host: "github", replace: acts.replaceDescription! },
      syncNow: async () => {
        for (const each of (await ghHost.work.listWork()).items) db.put(each, "sync", at);
      },
    });
    url = (await board.start()).url;
  });

  after(async () => {
    await board.stop();
    db.close();
  });

  /** Item `id` parked on round 1 of its triage with a changed description, posted as the cycle posts it: the rewrite, then its questions. */
  async function parkedJob(id: string, questions: (typeof QUESTION)[]): Promise<string[]> {
    db.put((await ghHost.work.getWork(ref(id)))!, "sync", at);
    const rewrite = await acts.postRewrite!(ref(id), { round: 1, text: REWRITE });
    const asked = questions.length > 0 ? await acts.askQuestions!(ref(id), questions.map((each) => ({ ...each, parked: "needs-decision", step: "triage", rewrite: rewrite!.id }))) : null;
    saveJobs(db, { ...loadJobs(db), [key(id)]: jobFor(id, ({
      triage: { ready: true, size: "small", paths: [], hidesDecision: questions.length > 0, decisions: questions, rewrite: REWRITE },
      rewrite: { original: "Show the tides.", text: REWRITE, questions, round: 1 }, rewriteRounds: 1,
      parked: { as: "needs-decision", reason: "Triage, round 1.", at, rewrite: { id: rewrite!.id, questions: asked?.ids ?? [] } },
    })) });
    return asked?.ids ?? [];
  }

  for (const action of ["accept", "edit", "reject"] as const) {
    test(`a rewrite with no question puts the label on; ${action} takes it off`, async () => {
      const id = { accept: "21", edit: "22", reject: "23" }[action];
      await parkedJob(id, []);
      assert.ok(labelled(id), "the label is on once the rewrite is posted");
      // The board agrees with GitHub: the Item waits for an answer, also with no question.
      assert.equal((await ghHost.work.getWork(ref(id)))?.needsDecision, true);
      const response = await post("/api/rewrite", { ref: key(id), parkedAt: at, answers: [], action, ...(action === "edit" ? { text: "Show the tide table in metres, please." } : {}) }, url);
      assert.equal(response.status, 200, await response.clone().text());
      assert.ok(!labelled(id), "the label is off once the rewrite is settled");
      assert.equal((await ghHost.work.getWork(ref(id)))?.needsDecision, undefined);
    });
  }

  test("a rewrite with one question: the answer leaves the label on until Accept", async () => {
    const [question] = await parkedJob("24", [QUESTION]);
    assert.ok(labelled("24"));
    await acts.answerQuestion!(ref("24"), question!, { answer: "Metric", textHash: "x" });
    assert.ok(labelled("24"), "answered with the recommendation, the rewrite still waits");
    assert.equal((await ghHost.work.getWork(ref("24")))?.needsDecision, true);
    const response = await post("/api/rewrite", { ref: key("24"), parkedAt: at, answers: ["Metric"], action: "accept" }, url);
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok(!labelled("24"));
  });

  test("a rewrite with one question: the answer leaves the label on until Reject", async () => {
    const [question] = await parkedJob("25", [QUESTION]);
    await acts.answerQuestion!(ref("25"), question!, { answer: "Metric", textHash: "x" });
    assert.ok(labelled("25"));
    const response = await post("/api/rewrite", { ref: key("25"), parkedAt: at, answers: ["Metric"], action: "reject" }, url);
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok(!labelled("25"));
  });
});
