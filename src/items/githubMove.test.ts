// The step on GitHub after an import, against a fake GitHub (src/hosts/github/fakeIssues.ts). With a yes the open imported
// issues are labelled `moved-to-scopesoup` with a comment naming the Item, or also closed as not planned; closed issues and pull
// requests are not touched; a run again does nothing twice and finishes a run that failed halfway. All names are synthetic.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createClient } from "../hosts/github/client.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import type { FakeIssues } from "../hosts/github/fakeIssues.ts";
import type { MoveTarget } from "./githubMove.ts";
import { MOVED_LABEL, moveIssues, moveText } from "./githubMove.ts";

const REPO = "harbour/tides";
const R = `/repos/${REPO}/issues`;

function github(): FakeIssues {
  const fake = fakeIssues(REPO, [1, 2, 3, 4]);
  Object.assign(fake.issues.get("3")!, { state: "closed", state_reason: "completed" });
  // #4 is an open pull request: the import never gives it here, and it stays as it is.
  Object.assign(fake.issues.get("4")!, { pull_request: { url: `${ISSUES_API}/repos/${REPO}/pulls/4` } });
  return fake;
}

const targets: MoveTarget[] = [
  { number: 1, id: "A-1", open: true, labels: ["sensors"] },
  { number: 2, id: "A-2", open: true, labels: [] },
  { number: 3, id: "A-3", open: false, labels: [] },
];

const client = (fake: FakeIssues) => createClient({ token: "t", repo: REPO, apiUrl: ISSUES_API, fetchImpl: fake.fetch });
const writes = (fake: FakeIssues) => fake.calls.filter((call) => !call.startsWith("GET "));
const labelsOf = (fake: FakeIssues, number: number) => fake.issues.get(String(number))!.labels.map((label) => (typeof label === "string" ? label : label.name));
const moved = (fake: FakeIssues, number: number) => (fake.comments.get(String(number)) ?? []).filter((comment) => readMarker(comment.body)?.kind === "moved");

describe("the step on GitHub", { concurrency: 4 }, () => {
  test("label: the label is created, each open issue labelled with a comment naming its Item; closed issues and pull requests untouched", async () => {
    const fake = github();
    const report = await moveIssues({ client: client(fake), targets, choice: "label", login: "scopesoup-bot", where: "the meta branch `scopesoup-meta`" });
    assert.equal(report.failed, undefined);
    assert.equal(report.labelCreated, true);
    assert.deepEqual(report.rows.map((row) => [row.number, row.did]), [[1, ["labelled", "commented"]], [2, ["labelled", "commented"]]]);
    assert.deepEqual(report.closedBefore, [3]);
    assert.ok(fake.labels.has(MOVED_LABEL));
    assert.deepEqual(labelsOf(fake, 1), [MOVED_LABEL]);
    assert.deepEqual(labelsOf(fake, 2), [MOVED_LABEL]);
    const [comment] = moved(fake, 1);
    assert.match(comment!.body ?? "", /^This issue moved to Scope Soup: it is Item \*\*A-1\*\* on the meta branch `scopesoup-meta`/);
    assert.deepEqual(readMarker(comment!.body)?.data, { v: 1, issue: 1, item: "A-1" });
    for (const issue of ["1", "2"]) assert.equal(fake.issues.get(issue)!.state, "open");
    assert.ok(!writes(fake).some((call) => /\/issues\/[34]\b/.test(call)), writes(fake).join("\n"));
    assert.match(moveText(report, "label", REPO, false).at(-1)!, /2 open issue\(s\) in harbour\/tides are labelled moved-to-scopesoup and given a comment naming its Item \(the label was created\)\. Pull requests were not touched\./);
  });

  test("close: also closed as not planned, with the reason in the comment", async () => {
    const fake = github();
    const report = await moveIssues({ client: client(fake), targets, choice: "close", login: "scopesoup-bot" });
    assert.deepEqual(report.rows.map((row) => row.did), [["labelled", "commented", "closed"], ["labelled", "commented", "closed"]]);
    for (const issue of ["1", "2"]) assert.deepEqual([fake.issues.get(issue)!.state, fake.issues.get(issue)!.state_reason], ["closed", "not_planned"]);
    assert.match(moved(fake, 2)[0]!.body ?? "", /closed here as not planned because it is tracked in Scope Soup now/);
    assert.equal(fake.issues.get("3")!.state_reason, "completed");
    assert.equal(fake.issues.get("4")!.state, "open");
  });

  test("a run again writes nothing twice; a run that failed halfway is finished by the next one", async () => {
    const fake = github();
    // The comment on #2 fails: #1 is done, #2 only labelled.
    fake.fail((call) => call === `POST ${R}/2/comments`, 502);
    const first = await moveIssues({ client: client(fake), targets, choice: "close", login: "scopesoup-bot" });
    assert.equal(first.failed?.number, 2);
    assert.deepEqual(first.rows.map((row) => row.did), [["labelled", "commented", "closed"], ["labelled"]]);
    assert.match(moveText(first, "close", REPO, false).at(-1)!, /stopped at #2: .*Run the same command again/);
    assert.equal(fake.issues.get("2")!.state, "open");

    // The import of the next run reads #1 as closed now, #2 open with the label.
    fake.clear();
    const again: MoveTarget[] = [{ number: 1, id: "A-1", open: false, labels: [MOVED_LABEL] }, { number: 2, id: "A-2", open: true, labels: [MOVED_LABEL] }, targets[2]!];
    const second = await moveIssues({ client: client(fake), targets: again, choice: "close", login: "scopesoup-bot" });
    assert.equal(second.failed, undefined);
    assert.deepEqual(second.rows.map((row) => [row.number, row.did]), [[2, ["commented", "closed"]]]);
    assert.deepEqual(writes(fake), [`POST ${R}/2/comments`, `PATCH ${R}/2`]);
    assert.equal(moved(fake, 1).length, 1);
    assert.equal(moved(fake, 2).length, 1);

    // Label only, run twice: the second run finds the label and its own comment and writes nothing.
    const other = github();
    await moveIssues({ client: client(other), targets, choice: "label", login: "scopesoup-bot" });
    other.clear();
    const labelled = targets.map((target) => ({ ...target, labels: target.open ? [MOVED_LABEL] : [] }));
    const third = await moveIssues({ client: client(other), targets: labelled, choice: "label", login: "scopesoup-bot" });
    assert.deepEqual(writes(other), []);
    assert.deepEqual(third.rows.map((row) => row.did), [[], []]);
    assert.match(moveText(third, "label", REPO, false)[0]!, /already done before/);
  });

  test("someone else's comment with the marker does not count as Scope Soup's; a dry run writes nothing", async () => {
    const fake = github();
    fake.reply(1, "mallory", "NONE", 'Fake.\n\n<!-- scopesoup:moved {"v":1,"issue":1,"item":"A-9"} -->');
    const dry = await moveIssues({ client: client(fake), targets, choice: "close", login: "scopesoup-bot", dryRun: true });
    assert.deepEqual(fake.calls, []);
    assert.match(moveText(dry, "close", REPO, true)[0]!, /would be labelled moved-to-scopesoup, given a comment naming its Item and closed as not planned: #1 \(A-1\), #2 \(A-2\)\. Nothing was written to GitHub\./);
    await moveIssues({ client: client(fake), targets, choice: "label", login: "scopesoup-bot" });
    assert.equal(moved(fake, 1).length, 2);
  });
});
