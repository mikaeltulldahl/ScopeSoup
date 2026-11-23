// The decisions an implementor took itself, on the hosts that keep them: GitHub (one comment with the `scopesoup:assumption`
// label, written by the real adapter on a fake GitHub), the meta branch (an `assumption` line, and `accepted` / `overturned`
// lines naming it), and the board's endpoint. Nothing reaches the network. All names are synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { buildBoard } from "../core/board.ts";
import { buildItemPage } from "../core/item-page.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import { parseLog, foldLog } from "../hosts/metaBranch/log.ts";
import { assumptionsOf } from "../hosts/metaBranch/map.ts";
import type { Assumption, Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { createServer } from "../server/server.ts";
import type { AssumptionHost } from "../server/server.ts";
import { loadSnapshot } from "../server/snapshot.ts";
import { openStore } from "../store/store.ts";
import { overturnItem, splitAssumptionId } from "./assumptions.ts";
import { createHostActions } from "./hostActions.ts";
import { overturnsFor } from "./overturns.ts";
import { saveJobs } from "./jobs.ts";

const DECISIONS = [
  { question: "Which name for the tide module?", chosen: "tides", others: ["tide-table", "sea"], why: "Matches the folder." },
  { question: "Sort harbours by?", chosen: "name", others: ["distance"], why: "Needs no location." },
];

const config = (() => {
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
})();

const labelsOf = (fake: ReturnType<typeof fakeIssues>, id: string): string[] => fake.issues.get(id)!.labels.map((label) => (typeof label === "string" ? label : label.name));

test("on GitHub two decisions are one comment with the scopesoup:assumption label, which does not block; Accept and Overturn settle them", async () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  const store = openStore(":memory:");
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store });
  const item: Ref = { host: "github", kind: "work", id: "1" };

  await actions.appendLog(item, "assumption", { decisions: DECISIONS, assumption: "words for an old reader" });
  const comments = fake.comments.get("1")!;
  assert.equal(comments.length, 1);
  assert.equal(readMarker(comments[0]!.body)?.kind, "assumption");
  assert.match(comments[0]!.body!, /1\. \*\*Which name for the tide module\?\*\* Chose: tides\. Other options: tide-table; sea\. Why: Matches the folder\./);
  assert.deepEqual(labelsOf(fake, "1"), ["scopesoup:assumption"]);
  let read = store.get<WorkItem>(item)!;
  assert.deepEqual(read.assumptions?.map((each) => [each.question, each.chosen, each.settled]), [["Which name for the tide module?", "tides", undefined], ["Sort harbours by?", "name", undefined]]);
  // It does not wait for an answer: the work went on.
  assert.equal(read.needsDecision, undefined);
  const [first, second] = read.assumptions!;

  assert.equal(await actions.acceptAssumption!(item, first!.id, "robin"), true);
  read = store.get<WorkItem>(item)!;
  assert.equal(read.assumptions?.[0]?.settled?.verdict, "accepted");
  assert.equal(read.assumptions?.[0]?.settled?.by, "robin");
  // One is still open: the label stays. A second Accept is refused.
  assert.deepEqual(labelsOf(fake, "1"), ["scopesoup:assumption"]);
  await assert.rejects(actions.acceptAssumption!(item, first!.id, "robin"), /accepted already/);

  const made = await actions.overturnAssumption!(item, second!.id, "By distance from the user's harbour", "robin");
  assert.equal((made as Ref | null)?.id, "2");
  const issue = fake.issues.get("2")!;
  assert.match(issue.title, /^Overturned in #1: Sort harbours by\?/);
  assert.match(issue.body ?? "", /\*\*Decided by a person:\*\* By distance from the user's harbour/);
  assert.match(issue.body ?? "", /#1's change has not merged yet; this Item waits for it/);
  // The rework waits for #1 (an issue dependency), and the decision's comment names #2.
  assert.deepEqual([...(fake.blockedBy.get("2") ?? [])], [fake.issues.get("1")!.id]);
  assert.match(fake.comments.get("1")![0]!.body!, /_Overturned by robin: By distance from the user's harbour Reworked in #2\._/);
  read = store.get<WorkItem>(item)!;
  assert.deepEqual(read.assumptions?.[1]?.settled && { verdict: read.assumptions[1].settled.verdict, answer: read.assumptions[1].settled.answer, item: read.assumptions[1].settled.item?.id }, { verdict: "overturned", answer: "By distance from the user's harbour", item: "2" });
  // None is open any more: the label goes.
  assert.deepEqual(labelsOf(fake, "1"), []);
  store.close();
});

test("a decision comment from anyone but Scope Soup's login is a plain comment, and a failed post is an event that does not throw", async () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  const store = openStore(":memory:");
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store });
  const item: Ref = { host: "github", kind: "work", id: "1" };
  fake.reply(1, "stranger", "OWNER", 'Look\n\n<!-- scopesoup:assumption {"v":1,"decisions":[{"question":"Q?","chosen":"x","others":[],"why":""}]} -->');
  assert.equal((await host.work.getWork(item))?.assumptions, undefined);
  fake.dropsLabels = true;
  await actions.appendLog(item, "assumption", { decisions: DECISIONS });
  const failed = store.eventsAfter(0, 100).filter((event) => event.kind === "orchestrator.host_write_failed");
  assert.equal(failed.length, 1);
  assert.match((failed[0]!.data as { reason: string }).reason, /The step goes on without them\./);
  store.close();
});

test("on the meta branch an assumption line holds the decisions, and accepted and overturned lines settle them by `to` and `n`", () => {
  const at = "2026-11-22T10:00:00.000Z";
  const log = [
    JSON.stringify({ at, by: { who: "scopesoup", machine: "laptop-a", agent: true }, kind: "assumption", decisions: DECISIONS, assumption: "words" }),
    // An older line without `decisions` is no decision.
    JSON.stringify({ at: "2026-11-22T09:00:00.000Z", by: "robin", kind: "assumption", assumption: "old" }),
    JSON.stringify({ at: "2026-11-22T11:00:00.000Z", by: "robin", kind: "accepted", to: at, n: 0 }),
    JSON.stringify({ at: "2026-11-22T12:00:00.000Z", by: "robin", kind: "overturned", to: at, n: 1, answer: "By distance", item: "A-9" }),
    // A second verdict on a settled decision changes nothing.
    JSON.stringify({ at: "2026-11-22T13:00:00.000Z", by: "kim", kind: "accepted", to: at, n: 1 }),
  ].join("\n");
  const picture = foldLog(parseLog(log));
  // The new kinds are known: nothing is counted as unknown.
  assert.equal(picture.unknown.length, 0);
  const found: Assumption[] = assumptionsOf(picture.lines, { host: "metaBranch", target: "main", fallbackTime: at });
  assert.deepEqual(found.map((each) => [each.id, each.settled?.verdict, each.settled?.by, each.settled?.answer, each.settled?.item?.id]), [
    [`${at}#0`, "accepted", "robin", undefined, undefined],
    [`${at}#1`, "overturned", "robin", "By distance", "A-9"],
  ]);
  assert.deepEqual(splitAssumptionId(`${at}#1`), { record: at, n: 1 });
  assert.deepEqual(splitAssumptionId("123-0"), { record: "123", n: 0 });
});

test("an overturn's new Item carries the answer as the decision: rework before the change merged, revert or change after", () => {
  const decision: Assumption = { id: "1-0", at: "2026-11-22T10:00:00Z", ...DECISIONS[1]! };
  const open: WorkItem = { ref: { host: "github", kind: "work", id: "7" }, title: "Harbour list", state: "doing", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-22T10:00:00Z" };
  const rework = overturnItem(open, decision, "By distance");
  assert.equal(rework.merged, false);
  assert.match(rework.body, /person overturned a decision the implementor of #7 \("Harbour list"\) took itself/);
  assert.match(rework.body, /The implementor chose: name\. The other options were: distance\. Its reason: Needs no location\./);
  assert.equal(rework.verification, "The code follows a person's decision: By distance");
  const revert = overturnItem({ ...open, state: "done", ref: { host: "metaBranch", kind: "work", id: "A-3" } }, decision, "By distance");
  assert.equal(revert.merged, true);
  assert.match(revert.body, /A-3's change has merged\. Change the code to follow a person's decision, or revert/);
});

test("the board lists open and recent decisions newest first, outside your turn; POST /api/assumption accepts and overturns", async () => {
  const store = openStore(":memory:");
  const now = new Date("2026-11-22T12:00:00Z");
  const decision = (id: string, at: string, settled?: Assumption["settled"]): Assumption => ({ id, at, question: `Q ${id}?`, chosen: "x", others: [], why: "", ...(settled ? { settled } : {}) });
  const item = (id: string, assumptions: Assumption[]): WorkItem => ({ ref: { host: "fake", kind: "work", id }, title: `Item ${id}`, state: "doing", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-22T10:00:00Z", assumptions });
  store.put(item("1", [decision("a", "2026-11-22T09:00:00Z"), decision("old", "2026-11-01T09:00:00Z", { verdict: "accepted", at: "2026-11-02T09:00:00Z", by: "robin" })]), "sync", now.toISOString());
  store.put(item("2", [decision("b", "2026-11-22T11:00:00Z"), decision("c", "2026-11-21T09:00:00Z", { verdict: "accepted", at: "2026-11-21T10:00:00Z", by: "robin" })]), "sync", now.toISOString());
  const board = buildBoard(loadSnapshot(store), now);
  // Newest first; a decision settled more than a week ago is left out; none is your turn.
  assert.deepEqual(board.assumptions.map((each) => `${each.item.label} ${each.id}`), ["#2 b", "#1 a", "#2 c"]);
  assert.deepEqual(board.yourTurn, []);
  assert.deepEqual(buildItemPage(loadSnapshot(store), "fake:work:2", now)?.assumptions.map((each) => each.id), ["b", "c"]);

  const calls: string[] = [];
  const settles: AssumptionHost = {
    host: "fake",
    async accept(subject, id, by) {
      calls.push(`accept ${subject.id} ${id} ${by}`);
    },
    async overturn(subject, id, answer, by) {
      calls.push(`overturn ${subject.id} ${id} ${answer} ${by}`);
      return { host: "fake", kind: "work", id: "3" };
    },
  };
  const server = createServer({ store, port: 0, now: () => now, assumptions: [settles] });
  const base = (await server.start()).url;
  const post = async (body: unknown) => {
    const response = await fetch(`${base}/api/assumption`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  try {
    const shown = (await (await fetch(`${base}/api/board`)).json()) as { settles?: string[] };
    assert.deepEqual(shown.settles, ["fake"]);
    const page = (await (await fetch(`${base}/api/item?ref=fake:work:1`)).json()) as { canSettle?: boolean };
    assert.equal(page.canSettle, true);
    assert.deepEqual(await post({ ref: "fake:work:1", id: "a", action: "accept" }), { status: 200, body: { settled: "accepted" } });
    assert.equal((await post({ ref: "fake:work:2", id: "b", action: "overturn" })).status, 400);
    assert.deepEqual(await post({ ref: "fake:work:2", id: "b", action: "overturn", answer: " Use y " }), { status: 200, body: { settled: "overturned", item: refKey({ host: "fake", kind: "work", id: "3" }) } });
    assert.equal((await post({ ref: "fake:work:2", id: "c", action: "accept" })).status, 409);
    assert.equal((await post({ ref: "fake:work:2", id: "nope", action: "accept" })).status, 404);
    assert.deepEqual(calls, ["accept 1 a Ada", "overturn 2 b Use y Ada"]);
    assert.deepEqual(store.eventsAfter(0, 100).filter((event) => event.kind.startsWith("person.assumption_")).map((event) => event.kind), ["person.assumption_accepted", "person.assumption_overturned"]);
  } finally {
    await server.stop();
    store.close();
  }
});

test("Overturn is safe to press twice: when the verdict write fails, the second press files no second Item and settles the decision", async () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  const store = openStore(":memory:");
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store });
  const item: Ref = { host: "github", kind: "work", id: "1" };
  await actions.appendLog(item, "assumption", { decisions: DECISIONS });
  const decision = store.get<WorkItem>(item)!.assumptions![1]!;

  // The verdict is an edit of the decision's comment: it fails once, after the new issue was filed.
  fake.fail((call) => call.startsWith("PATCH ") && call.includes("/issues/comments/"), 422, { times: 1 });
  await assert.rejects(actions.overturnAssumption!(item, decision.id, "By distance", "robin"));
  assert.deepEqual([...fake.issues.keys()].sort(), ["1", "2"]);
  assert.equal(store.get<WorkItem>(item)!.assumptions![1]!.settled, undefined);
  // The filed issue carries the decision's mark, and the store has it already.
  assert.match(fake.issues.get("2")!.body ?? "", /<!-- scopesoup:overturns \{"item":"github:work:1","decision":"\d+-1"\} -->/);

  const again = await actions.overturnAssumption!(item, decision.id, "By distance", "robin");
  assert.equal((again as Ref | null)?.id, "2");
  assert.deepEqual([...fake.issues.keys()].sort(), ["1", "2"]);
  const settled = store.get<WorkItem>(item)!.assumptions![1]!.settled;
  assert.deepEqual([settled?.verdict, settled?.item?.id], ["overturned", "2"]);
  assert.equal(store.eventsAfter(0, 100).filter((event) => event.kind === "orchestrator.overturn_reused").length, 1);
  // The other decision's Overturn is not taken for this one: it files its own Item.
  const other = await actions.overturnAssumption!(item, store.get<WorkItem>(item)!.assumptions![0]!.id, "sea", "robin");
  assert.equal((other as Ref | null)?.id, "3");
  store.close();
});

test("on GitHub an Overturn while the change has not merged goes into the running work: no new Item, and the verdict says so; after merging it files one", async () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  const store = openStore(":memory:");
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store });
  const item: Ref = { host: "github", kind: "work", id: "1" };
  await actions.appendLog(item, "assumption", { decisions: DECISIONS });
  // The implementor's work is under way: its job is at review.
  saveJobs(store, { [refKey(item)]: { item, workspace: "w", branch: "scopesoup/1", step: "review", failures: 0, fixRounds: 0, agentSession: "agent-1", startedAt: "2026-11-22T10:00:00.000Z" } });
  const [first, second] = store.get<WorkItem>(item)!.assumptions!;

  // The verdict fails once: the answer is kept for the work already, and the second press keeps it once and writes the verdict.
  fake.fail((call) => call.startsWith("PATCH ") && call.includes("/issues/comments/"), 422, { times: 1 });
  await assert.rejects(actions.overturnAssumption!(item, second!.id, "By distance", "robin"));
  assert.equal(await actions.overturnAssumption!(item, second!.id, "By distance", "robin"), "work");
  assert.deepEqual([...fake.issues.keys()], ["1"]);
  assert.deepEqual(overturnsFor(store, refKey(item)).map((each) => [each.id, each.answer]), [[second!.id, "By distance"]]);
  assert.match(fake.comments.get("1")![0]!.body!, /_Overturned by robin: By distance It went into the running work\._/);
  const settled = store.get<WorkItem>(item)!.assumptions![1]!.settled;
  assert.deepEqual([settled?.verdict, settled?.work, settled?.item], ["overturned", true, undefined]);

  // Merged: the Item is closed as done, so an Overturn files a new Item that changes or reverts it, as before.
  Object.assign(fake.issues.get("1")!, { state: "closed", state_reason: "completed" });
  const made = await actions.overturnAssumption!(item, first!.id, "sea", "robin");
  assert.equal((made as Ref | null)?.id, "2");
  assert.match(fake.issues.get("2")!.body ?? "", /#1's change has merged\./);
  // An overturn that went into the work but reached it too late gets its Item once, found again by its mark.
  const late = await actions.reworkOverturn!(item, second!.id, "By distance", "robin");
  assert.equal(late?.id, "3");
  assert.equal((await actions.reworkOverturn!(item, second!.id, "By distance", "robin"))?.id, "3");
  store.close();
});

test("on the meta branch an overturned line with `work` settles the decision as gone into the running work", () => {
  const at = "2026-11-22T11:00:00.000Z";
  const lines = foldLog(parseLog([
    JSON.stringify({ at, by: { who: "scopesoup", machine: "laptop-a", agent: true }, kind: "assumption", decisions: [DECISIONS[1]] }),
    JSON.stringify({ at: "2026-11-22T12:00:00.000Z", by: "robin", kind: "overturned", to: at, n: 0, answer: "By distance", work: true }),
  ].join("\n"))).lines;
  const [decision] = assumptionsOf(lines, { host: "metaBranch", target: "main", fallbackTime: at });
  assert.deepEqual([decision?.settled?.verdict, decision?.settled?.work, decision?.settled?.item], ["overturned", true, undefined]);
});
