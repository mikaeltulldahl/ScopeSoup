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
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import { createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import type { Assumption, Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { createServer } from "../server/server.ts";
import type { AssumptionHost } from "../server/server.ts";
import { loadSnapshot } from "../server/snapshot.ts";
import { openStore } from "../store/store.ts";
import { AlreadyAnswered } from "../ports/host.ts";
import { overturnItem, splitAssumptionId } from "./assumptions.ts";
import { createHostActions } from "./hostActions.ts";
import { keepOverturn, overturnsFor } from "./overturns.ts";
import type { Actions } from "./ports.ts";
import type { Store } from "../store/store.ts";
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

/** One Accept sent on its own, as the board's Send does with one pick. */
const accept = async (actions: Actions, item: Ref, id: string) => (await actions.settleAssumptions!(item, [{ id, action: "accept" }], "robin"))?.[0];

/** One Overturn sent on its own; an answer that goes into the running work is kept, as the server does in its transaction. */
async function overturn(actions: Actions, store: Store, item: Ref, id: string, answer: string): Promise<Ref | "work" | null> {
  const before = store.get<WorkItem>(item)!;
  const outcome = (await actions.settleAssumptions!(item, [{ id, action: "overturn", answer }], "robin"))?.[0];
  if (outcome?.work) keepOverturn(store, before, before.assumptions!.find((each) => each.id === id)!, answer, "robin", new Date().toISOString());
  return outcome?.work ? "work" : outcome?.item ?? null;
}

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

  assert.deepEqual(await accept(actions, item, first!.id), { id: first!.id, verdict: "accepted" });
  read = store.get<WorkItem>(item)!;
  assert.equal(read.assumptions?.[0]?.settled?.verdict, "accepted");
  assert.equal(read.assumptions?.[0]?.settled?.by, "robin");
  // One is still open: the label stays. A second Accept is refused.
  assert.deepEqual(labelsOf(fake, "1"), ["scopesoup:assumption"]);
  await assert.rejects(accept(actions, item, first!.id), /accepted already/);

  const made = await overturn(actions, store, item, second!.id, "By distance from the user's harbour");
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

test("the board shows how many decisions an Item has open, and none is your turn; POST /api/decisions sends the picks of an Item together", async () => {
  const store = openStore(":memory:");
  const now = new Date("2026-11-22T12:00:00Z");
  const decision = (id: string, at: string, settled?: Assumption["settled"]): Assumption => ({ id, at, question: `Q ${id}?`, chosen: "x", others: [], why: "", ...(settled ? { settled } : {}) });
  const item = (id: string, assumptions: Assumption[]): WorkItem => ({ ref: { host: "fake", kind: "work", id }, title: `Item ${id}`, state: "doing", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-22T10:00:00Z", assumptions });
  store.put(item("1", [decision("a", "2026-11-22T09:00:00Z"), decision("old", "2026-11-01T09:00:00Z", { verdict: "accepted", at: "2026-11-02T09:00:00Z", by: "robin" })]), "sync", now.toISOString());
  store.put(item("2", [decision("b", "2026-11-22T11:00:00Z"), decision("c", "2026-11-21T09:00:00Z", { verdict: "accepted", at: "2026-11-21T10:00:00Z", by: "robin" })]), "sync", now.toISOString());
  const board = buildBoard(loadSnapshot(store), now);
  // The cards count the open ones only; none is your turn.
  assert.deepEqual(board.lanes.flatMap((lane) => lane.cards).map((card) => [card.label, card.openDecisions]).sort(), [["#1", 1], ["#2", 1]]);
  assert.deepEqual(board.yourTurn, []);
  assert.deepEqual(buildItemPage(loadSnapshot(store), "fake:work:2", now)?.assumptions.map((each) => each.id), ["c", "b"]);

  // A third Item with three open decisions, sent together; its change is under way, so an overturn goes into the work.
  store.put(item("3", [decision("d", "2026-11-22T09:00:00Z"), decision("e", "2026-11-22T09:01:00Z"), decision("f", "2026-11-22T09:02:00Z")]), "sync", now.toISOString());
  const calls: string[] = [];
  let refuse = false;
  const settles: AssumptionHost = {
    host: "fake",
    async settle(subject, picks, by) {
      if (refuse) throw new AlreadyAnswered("Decision e is accepted already.");
      calls.push(`${subject.id} ${picks.map((pick) => `${pick.action} ${pick.id}${pick.answer ? ` ${pick.answer}` : ""}`).join(", ")} by ${by}`);
      return picks.map((pick) => (pick.action === "accept" ? { id: pick.id, verdict: "accepted" as const } : pick.id === "f" ? { id: pick.id, verdict: "overturned" as const, work: true as const } : { id: pick.id, verdict: "overturned" as const, item: { host: "fake", kind: "work" as const, id: "9" } }));
    },
  };
  // Which events are written inside one top-level store transaction: each Send must be one.
  let transactions = 0;
  let depth = 0;
  const realTx = store.tx.bind(store);
  store.tx = <T>(fn: () => T): T => {
    if (depth === 0) transactions += 1;
    depth += 1;
    try {
      return realTx(fn);
    } finally {
      depth -= 1;
    }
  };
  const outside: string[] = [];
  const realAppend = store.appendEvent.bind(store);
  store.appendEvent = (event, at) => {
    if (depth === 0) outside.push(event.kind);
    return realAppend(event, at);
  };
  const server = createServer({ store, port: 0, now: () => now, assumptions: [settles] });
  const base = (await server.start()).url;
  const post = async (body: unknown) => {
    const response = await fetch(`${base}/api/decisions`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const personEvents = () => store.eventsAfter(0, 100).filter((event) => event.kind.startsWith("person.assumption_")).map((event) => `${event.kind} ${(event.data as { id: string }).id}`);
  try {
    const page = (await (await fetch(`${base}/api/item?ref=fake:work:1`)).json()) as { canSettle?: boolean };
    assert.equal(page.canSettle, true);
    // Malformed picks are refused before anything is looked at.
    assert.equal((await post({ ref: "fake:work:2", decisions: [{ id: "b", action: "overturn" }] })).status, 400);
    assert.equal((await post({ ref: "fake:work:2", decisions: [{ id: "b", action: "accept" }, { id: "b", action: "accept" }] })).status, 400);
    assert.equal((await post({ ref: "fake:work:2", decisions: [] })).status, 400);
    // One settled already (c) refuses the whole Send, b with it: nothing reaches the host, nothing is recorded.
    const refused = await post({ ref: "fake:work:2", decisions: [{ id: "b", action: "accept" }, { id: "c", action: "accept" }] });
    assert.equal(refused.status, 409);
    assert.match(JSON.stringify(refused.body), /ALREADY_SETTLED/);
    assert.equal((await post({ ref: "fake:work:2", decisions: [{ id: "nope", action: "accept" }] })).status, 404);
    // The host refuses (settled meanwhile on the host): 409, and nothing is recorded either.
    refuse = true;
    assert.equal((await post({ ref: "fake:work:3", decisions: [{ id: "d", action: "accept" }, { id: "e", action: "accept" }] })).status, 409);
    refuse = false;
    assert.deepEqual(calls, []);
    assert.deepEqual(personEvents(), []);
    assert.equal(transactions, 0);

    // Two accepts and an overturn sent together: one host call, one store transaction with an event for each and the overturn kept.
    const sent = await post({ ref: "fake:work:3", decisions: [{ id: "d", action: "accept" }, { id: "e", action: "accept" }, { id: "f", action: "overturn", answer: " Use y " }] });
    assert.deepEqual(sent, { status: 200, body: { settled: [{ id: "d", verdict: "accepted" }, { id: "e", verdict: "accepted" }, { id: "f", verdict: "overturned", work: true }] } });
    assert.deepEqual(calls, ["3 accept d, accept e, overturn f Use y by Ada"]);
    assert.equal(transactions, 1);
    assert.deepEqual(outside, []);
    assert.deepEqual(personEvents(), ["person.assumption_accepted d", "person.assumption_accepted e", "person.assumption_overturned f"]);
    assert.deepEqual(overturnsFor(store, "fake:work:3").map((each) => [each.id, each.answer]), [["f", "Use y"]]);
    // A partial Send: one of the open decisions; the others stay open.
    assert.deepEqual(await post({ ref: "fake:work:1", decisions: [{ id: "a", action: "overturn", answer: "z" }] }), { status: 200, body: { settled: [{ id: "a", verdict: "overturned", item: "fake:work:9" }] } });
    assert.equal(transactions, 2);
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
  await assert.rejects(overturn(actions, store, item, decision.id, "By distance"));
  assert.deepEqual([...fake.issues.keys()].sort(), ["1", "2"]);
  assert.equal(store.get<WorkItem>(item)!.assumptions![1]!.settled, undefined);
  // The filed issue carries the decision's mark, and the store has it already.
  assert.match(fake.issues.get("2")!.body ?? "", /<!-- scopesoup:overturns \{"item":"github:work:1","decision":"\d+-1"\} -->/);

  const again = await overturn(actions, store, item, decision.id, "By distance");
  assert.equal((again as Ref | null)?.id, "2");
  assert.deepEqual([...fake.issues.keys()].sort(), ["1", "2"]);
  const settled = store.get<WorkItem>(item)!.assumptions![1]!.settled;
  assert.deepEqual([settled?.verdict, settled?.item?.id], ["overturned", "2"]);
  // The other decision's Overturn is not taken for this one: it files its own Item.
  const other = await overturn(actions, store, item, store.get<WorkItem>(item)!.assumptions![0]!.id, "sea");
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

  // The verdict fails once: nothing is kept for the work; the second Send writes the verdict, and the answer is kept once.
  fake.fail((call) => call.startsWith("PATCH ") && call.includes("/issues/comments/"), 422, { times: 1 });
  await assert.rejects(overturn(actions, store, item, second!.id, "By distance"));
  // Nothing was kept for the work: the Send was refused whole.
  assert.deepEqual(overturnsFor(store, refKey(item)), []);
  assert.equal(await overturn(actions, store, item, second!.id, "By distance"), "work");
  assert.deepEqual([...fake.issues.keys()], ["1"]);
  assert.deepEqual(overturnsFor(store, refKey(item)).map((each) => [each.id, each.answer]), [[second!.id, "By distance"]]);
  assert.match(fake.comments.get("1")![0]!.body!, /_Overturned by robin: By distance It went into the running work\._/);
  const settled = store.get<WorkItem>(item)!.assumptions![1]!.settled;
  assert.deepEqual([settled?.verdict, settled?.work, settled?.item], ["overturned", true, undefined]);

  // Merged: the Item is closed as done, so an Overturn files a new Item that changes or reverts it, as before.
  Object.assign(fake.issues.get("1")!, { state: "closed", state_reason: "completed" });
  const made = await overturn(actions, store, item, first!.id, "sea");
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

const THREE = [...DECISIONS, { question: "Round depths to?", chosen: "10 cm", others: ["5 cm"], why: "As the tables do." }];

test("on GitHub two accepts and an overturn sent together are one edit of the decisions' comment; one settled already refuses them all before any write", async () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  const store = openStore(":memory:");
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store });
  const item: Ref = { host: "github", kind: "work", id: "1" };
  await actions.appendLog(item, "assumption", { decisions: THREE });
  saveJobs(store, { [refKey(item)]: { item, workspace: "w", branch: "scopesoup/1", step: "review", failures: 0, fixRounds: 0, agentSession: "agent-1", startedAt: "2026-11-22T10:00:00.000Z" } });
  const [a, b, c] = store.get<WorkItem>(item)!.assumptions!;
  const edits = () => fake.calls.filter((call) => call.startsWith("PATCH ") && call.includes("/issues/comments/")).length;
  const posts = () => fake.calls.filter((call) => call.startsWith("POST ")).length;

  // Accept a on its own first; then a Send of b, c and a (settled already) is refused whole: no edit, no post.
  await accept(actions, item, a!.id);
  const editsBefore = edits();
  const postsBefore = posts();
  await assert.rejects(actions.settleAssumptions!(item, [{ id: b!.id, action: "accept" }, { id: c!.id, action: "overturn", answer: "5 cm" }, { id: a!.id, action: "accept" }], "robin"), /accepted already/);
  assert.equal(edits(), editsBefore);
  assert.equal(posts(), postsBefore);
  assert.deepEqual(store.get<WorkItem>(item)!.assumptions!.map((each) => each.settled?.verdict), ["accepted", undefined, undefined]);

  // b accepted and c overturned (into the running work) in one Send: one edit, no new comment or issue.
  const outcomes = await actions.settleAssumptions!(item, [{ id: b!.id, action: "accept" }, { id: c!.id, action: "overturn", answer: "5 cm" }], "robin");
  assert.deepEqual(outcomes, [{ id: b!.id, verdict: "accepted" }, { id: c!.id, verdict: "overturned", work: true }]);
  assert.equal(edits(), editsBefore + 1);
  assert.equal(posts(), postsBefore);
  assert.deepEqual([...fake.issues.keys()], ["1"]);
  assert.equal(fake.comments.get("1")!.length, 1);
  assert.deepEqual(store.get<WorkItem>(item)!.assumptions!.map((each) => [each.settled?.verdict, each.settled?.by]), [["accepted", "robin"], ["accepted", "robin"], ["overturned", "robin"]]);
  // None is open any more: the label goes.
  assert.deepEqual(labelsOf(fake, "1"), []);
  store.close();
});

test("on the meta branch two accepts and an overturn sent together are one commit of three lines", async () => {
  const repo = createTestRepo();
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  let ms = Date.parse("2026-11-20T09:00:00Z");
  const host = createMetaBranchHost({ repoDir: repo.dir, allowWrites: true, remote: null, person: { name: "Ada", email: "ada@example.invalid" }, machine: "laptop-a", idPrefix: "A", now: () => new Date((ms += 1000)).toISOString() });
  const store = openStore(":memory:");
  try {
    const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store });
    const item = (await host.write!.createWork!({ title: "Tide table" })).work;
    await actions.appendLog(item, "assumption", { decisions: THREE });
    const decisions = (await host.work.getWork(item))!.assumptions!;
    assert.equal(decisions.length, 3);
    saveJobs(store, { [refKey(item)]: { item, workspace: "w", branch: "scopesoup/A-1", step: "review", failures: 0, fixRounds: 0, agentSession: "agent-1", startedAt: "2026-11-22T10:00:00.000Z" } });
    const commits = () => Number(repo.git(["rev-list", "--count", "refs/scopesoup/meta"]));
    const before = commits();
    const outcomes = await actions.settleAssumptions!(item, [{ id: decisions[0]!.id, action: "accept" }, { id: decisions[1]!.id, action: "accept" }, { id: decisions[2]!.id, action: "overturn", answer: "5 cm" }], "robin");
    assert.deepEqual(outcomes?.map((each) => [each.verdict, each.work]), [["accepted", undefined], ["accepted", undefined], ["overturned", true]]);
    assert.equal(commits(), before + 1);
    const lines = repo.git(["cat-file", "-p", `refs/scopesoup/meta:items/${item.id}/log.jsonl`]).split("\n").map((line) => JSON.parse(line) as { kind: string });
    assert.deepEqual(lines.slice(-3).map((line) => line.kind), ["accepted", "accepted", "overturned"]);
    assert.deepEqual((await host.work.getWork(item))!.assumptions!.map((each) => each.settled?.verdict), ["accepted", "accepted", "overturned"]);
    // Sent again: refused before anything is written.
    await assert.rejects(actions.settleAssumptions!(item, [{ id: decisions[0]!.id, action: "accept" }], "robin"), /accepted already/);
    assert.equal(commits(), before + 1);
  } finally {
    store.close();
    await host.stop();
    repo.cleanup();
  }
});
