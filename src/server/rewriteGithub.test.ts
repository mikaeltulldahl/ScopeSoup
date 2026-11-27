// Settling a triage rewrite on a GitHub Item replaces the issue's description, and the board's edits are written
// through, by the real GitHub adapter on a fake GitHub that keeps its issues and records what it is sent. Nothing reaches the
// network. All names and texts are synthetic.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import type { ItemPage } from "../core/views.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import type { FetchLike } from "../hosts/github/client.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { itemTextHash } from "../core/answerReuse.ts";
import { createHostActions } from "../orchestrator/hostActions.ts";
import type { Job } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs } from "../orchestrator/jobs.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";
import { where } from "../orchestrator/jobs.ts";
import { jobOf } from "../orchestrator/jobs.ts";

const API = "https://api.github.test";
const at = "2026-11-21T09:00:00Z";
const calls: { method: string; path: string; body: unknown }[] = [];
/** Issue numbers whose PATCH GitHub refuses. */
const refused = new Set<string>();
const ISSUE_BODY = "Tide table units.\n\n## Verification\n\nThe table shows metres.";
const issues = new Map<string, { number: number; title: string; body: string; state: string; state_reason: string | null; labels: { name: string }[]; updated_at: string }>();
const issueOf = (number: string) => {
  if (!issues.has(number)) issues.set(number, { number: Number(number), title: `Tide table ${number}`, body: ISSUE_BODY, state: "open", state_reason: null, labels: [], updated_at: at });
  return issues.get(number)!;
};
const fetchImpl: FetchLike = async (url, init) => {
  const method = init?.method ?? "GET";
  const path = url.replace(API, "");
  const sentBody = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body: sentBody });
  const number = /\/issues\/(\d+)(?:\/|$)/.exec(path)?.[1];
  let answer: [number, unknown] = [404, { message: "not found" }];
  if (method === "POST" && path === "/repos/harbour/tides/labels") answer = [201, sentBody];
  else if (number && method === "GET" && path.endsWith(`/issues/${number}`)) answer = [200, issueOf(number)];
  else if (number && method === "PATCH") answer = refused.has(number) ? [403, { message: "Resource not accessible by integration" }] : [200, Object.assign(issueOf(number), sentBody)];
  else if (number && method === "POST" && path.endsWith("/labels")) {
    const issue = issueOf(number);
    issue.labels.push(...(sentBody.labels as string[]).map((name) => ({ name })));
    answer = [200, issue.labels];
  }
  return { status: answer[0], headers: { get: () => null }, json: async () => answer[1], text: async () => JSON.stringify(answer[1]) };
};
let synced = 0;

let store: Store;
let server: ScopeSoupServer;
let base: string;

before(async () => {
  store = openStore(":memory:");
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: API, fetchImpl, allowWrites: true });
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store });
  server = createServer({ store, port: 0, description: { host: "github", replace: actions.replaceDescription! }, hostEdit: { host: "github", edit: actions.editItem! }, syncNow: async () => { synced += 1; } });
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  store.close();
});

const question = { question: "Metric or imperial?", options: [{ label: "Metric", description: "Metres." }, { label: "Imperial", description: "Feet." }], recommendation: "Metric" };

/** A GitHub issue whose triage rewrite parked for a person. */
function parkedJob(id: string, hostId = "github"): string {
  const ref: Ref = { host: hostId, kind: "work", id };
  const key = `${hostId}:work:${id}`;
  store.put({ ref, title: `Tide table ${id}`, body: "Tide table units.", state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: at }, "sync", at);
  const job: Job = jobOf({
    item: ref, workspace: "w", branch: `scopesoup/${id}`, step: "triage", failures: 0, fixRounds: 0, startedAt: at,
    triage: { ready: true, size: "small", paths: [], hidesDecision: true, decisions: [question], rewrite: "Show the tide table in metres." },
    rewrite: { original: "Tide table units.", text: "Show the tide table in metres.", questions: [question], round: 1 }, rewriteRounds: 1,
    parked: { as: "needs-decision", reason: "Triage, round 1.", at },
  });
  store.tx(() => saveJobs(store, { ...loadJobs(store), [key]: job }));
  return key;
}

async function post(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/rewrite`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The `orchestrator.text_wait` events of an Item. */
const waitEvents = (key: string): number => store.eventsAfter(0, 10_000).filter((event) => event.kind === "orchestrator.text_wait" && event.subject === key).length;
const page = async (key: string): Promise<ItemPage> => (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;
/** What was written to an issue (not the reads). */
const sent = (id: string) => calls.filter((call) => call.method !== "GET" && call.path === `/repos/harbour/tides/issues/${id}`);

describe("a triage rewrite on a GitHub Item", () => {
  test("Accept sends one issue-body update with the rewrite as the description, keeping the Verification section", async () => {
    const key = parkedJob("11");
    const answered = await post({ ref: key, parkedAt: at, answers: ["Metric"], action: "accept" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.deepEqual([answered.body.settled, answered.body.written], ["accepted", true]);
    assert.deepEqual(sent("11"), [{ method: "PATCH", path: "/repos/harbour/tides/issues/11", body: { body: "Show the tide table in metres.\n\n## Verification\n\nThe table shows metres." } }]);
    const shown = await page(key);
    assert.match(shown.answers.at(-1)!.answer, /^Accepted the triage's rewrite: the description above is the new text\.$/);
    // Written on the host, not yet read back into the store: the job waits for it, and says so.
    assert.equal(where(loadJobs(store)[key])?.writing?.from, itemTextHash(store.get<WorkItem>({ host: "github", kind: "work", id: "11" })!));
    assert.equal(waitEvents(key), 1);
  });

  test("Edit sends a person's text, made inert like other host text", async () => {
    const key = parkedJob("12");
    const answered = await post({ ref: key, parkedAt: at, answers: ["Metric"], action: "edit", text: "Metres. Fixes #3, ask @robin." });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const calls12 = sent("12");
    assert.equal(calls12.length, 1);
    const body = (calls12[0]!.body as { body: string }).body;
    assert.deepEqual(Object.keys(calls12[0]!.body as object), ["body"]);
    assert.doesNotMatch(body, /Fixes #3|@robin/);
    assert.equal(body.replaceAll("​", ""), "Metres. Fixes #3, ask @robin.\n\n## Verification\n\nThe table shows metres.");
  });

  test("Reject sends nothing", async () => {
    const key = parkedJob("13");
    const answered = await post({ ref: key, parkedAt: at, answers: ["Metric"], action: "reject" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.settled, "rejected");
    assert.deepEqual(sent("13"), []);
    assert.equal(where(loadJobs(store)[key])?.writing, undefined);
    assert.equal(waitEvents(key), 0);
  });

  test("another answer runs the triage again and sends nothing", async () => {
    const key = parkedJob("14");
    const answered = await post({ ref: key, parkedAt: at, answers: ["Imperial"], action: "accept" });
    assert.equal(answered.body.rerun, true);
    assert.deepEqual(sent("14"), []);
  });

  test("a refused update keeps the accepted text as the answer and shows the failure on the Item page", async () => {
    refused.add("15");
    const key = parkedJob("15");
    const answered = await post({ ref: key, parkedAt: at, answers: ["Metric"], action: "accept" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.deepEqual([answered.body.settled, answered.body.written], ["accepted", false]);
    assert.match(String(answered.body.problem), /403/);
    assert.equal(sent("15").length, 1);
    const shown = await page(key);
    const last = shown.answers.at(-1)!;
    assert.equal(last.question, "Triage rewrite, round 1");
    assert.match(last.answer, /could not write it to the issue \(.*403.*\)/);
    assert.match(last.answer, /Use this description instead of the one written above:\nShow the tide table in metres\.$/);
    assert.equal(loadJobs(store)[key]?.rewrite?.settled, "accepted");
    const events = store.eventsAfter(0, 10_000).filter((event) => event.kind === "orchestrator.host_write_failed" && event.subject === key);
    assert.equal(events.length, 1);
    // Nothing was written, so nothing is waited for.
    assert.equal(where(loadJobs(store)[key])?.writing, undefined);
    assert.equal(waitEvents(key), 0);
  });

  test("an issue that reads as the rewrite already is not written, and nothing is waited for", async () => {
    const key = parkedJob("16");
    store.put({ ...store.get<WorkItem>({ host: "github", kind: "work", id: "16" })!, body: "Show the tide table in metres." }, "sync", at);
    const answered = await post({ ref: key, parkedAt: at, answers: ["Metric"], action: "accept" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.deepEqual(sent("16"), []);
    assert.equal(where(loadJobs(store)[key])?.writing, undefined);
  });

  test("an Item on a host whose description cannot be written here keeps the text as the answer, and nothing is waited for", async () => {
    const key = parkedJob("17", "elsewhere");
    const answered = await post({ ref: key, parkedAt: at, answers: ["Metric"], action: "accept" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.settled, "accepted");
    assert.equal(where(loadJobs(store)[key])?.writing, undefined);
    assert.equal(waitEvents(key), 0);
  });

  test("a replace that answers false writes nothing, and nothing is waited for", async () => {
    const other = createServer({ store, port: 0, description: { host: "github", replace: async () => false } });
    const url = (await other.start()).url;
    try {
      const key = parkedJob("18");
      const response = await fetch(`${url}/api/rewrite`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: key, parkedAt: at, answers: ["Metric"], action: "accept" }) });
      assert.equal(response.status, 200);
      assert.equal(loadJobs(store)[key]?.rewrite?.settled, "accepted");
      assert.equal(where(loadJobs(store)[key])?.writing, undefined);
      assert.equal(waitEvents(key), 0);
    } finally {
      await other.stop();
    }
  });
});

async function postEdit(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/item/edit`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A GitHub Item in the store, as the poll left it. */
function cached(id: string): string {
  const ref: Ref = { host: "github", kind: "work", id };
  store.put({ ref, title: `Tide table ${id}`, body: "Tide table units.", verification: "The table shows metres.", state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: at }, "sync", at);
  return `github:work:${id}`;
}

describe("the board's edits of a GitHub Item", () => {
  test("the Item can be edited; a title and a priority are written, then the store is brought up to date", async () => {
    const key = cached("21");
    assert.equal(((await page(key)) as ItemPage & { canEdit: boolean }).canEdit, true);
    const before = synced;
    const edited = await postEdit({ ref: key, title: "Tide table in metres", priority: "minor" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(calls.filter((call) => call.method !== "GET" && call.path.includes("/21")).map((call) => [call.method, call.path, call.body]), [
      ["PATCH", "/repos/harbour/tides/issues/21", { title: "Tide table in metres" }],
      ["POST", "/repos/harbour/tides/issues/21/labels", { labels: ["priority:minor"] }],
    ]);
    assert.equal(synced, before + 1);
  });

  test("waiting is not offered for the Item, and an edit to it is refused with nothing written", async () => {
    const key = cached("24");
    assert.deepEqual((await page(key)).states, ["todo", "doing", "done", "abandoned"]);
    const edited = await postEdit({ ref: key, state: "waiting" });
    assert.equal(edited.status, 400);
    assert.equal((edited.body.error as { code: string }).code, "BAD_FIELD");
    assert.equal(calls.filter((call) => call.path.includes("/24")).length, 0);
  });

  test("a new verification replaces only that section, made inert", async () => {
    const key = cached("22");
    const edited = await postEdit({ ref: key, verification: "Ask @robin to read it." });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const body = (sent("22")[0]!.body as { body: string }).body;
    assert.doesNotMatch(body, /@robin/);
    assert.equal(body.replaceAll("\u200b", ""), "Tide table units.\n\n## Verification\n\nAsk @robin to read it.");
  });

  test("a refused PATCH leaves the store row unchanged and writes orchestrator.host_write_failed", async () => {
    refused.add("23");
    const key = cached("23");
    const row = () => JSON.stringify(store.get({ host: "github", kind: "work", id: "23" }));
    const was = row();
    const edited = await postEdit({ ref: key, title: "Never written" });
    assert.equal(edited.status, 400);
    assert.equal((edited.body.error as { code: string }).code, "WRITE_REFUSED");
    assert.equal(row(), was);
    const events = store.eventsAfter(0, 10_000).filter((event) => event.kind === "orchestrator.host_write_failed" && event.subject === key);
    assert.equal(events.length, 1);
    assert.match(JSON.stringify(events[0]!.data), /title.*403/);
  });

  test("labels and blockers are not changed from here", async () => {
    const key = cached("24");
    const edited = await postEdit({ ref: key, labels: ["tidy"] });
    assert.equal(edited.status, 400);
    assert.deepEqual(sent("24"), []);
  });
});
