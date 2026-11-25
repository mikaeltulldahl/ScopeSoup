// Moving issues back to the meta branch (#134): GitHub against its fake (src/hosts/github/fakeIssues.ts), Jira against its fake
// (Data Center flavour), the meta branch in memory (fakeMeta.ts). All names and texts are synthetic.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createClient } from "../hosts/github/client.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import { createJiraHost } from "../hosts/jira/index.ts";
import { FAKE_DC_SITE, fakeJira } from "../hosts/jira/fakeJira.ts";
import { DC_ROBIN, TOKEN } from "../hosts/jira/fixtures.ts";
import type { JiraIssue } from "../hosts/jira/rest.ts";
import { readIssues } from "./githubImport.ts";
import { MOVED_LABEL } from "./githubMove.ts";
import { fakeMeta } from "./fakeMeta.ts";
import { backMarker, fromGitHub, fromJira, githubOldHost, jiraOldHost, moveBack, moveBackLines } from "./moveToMeta.ts";
import { rewriteIds } from "./moveToHost.ts";

const REPO = "harbour/tides";
const SOURCE = "github:harbour/tides";

function github() {
  const fake = fakeIssues(REPO, [1, 2, 3]);
  Object.assign(fake.issues.get("1")!, { title: "Tide table", body: "Needs #2 first; see `#2` and https://github.test/harbour/tides/issues/2. Fixes #3, ask @robin.\n\n## Verification\n\nOpen the table." });
  Object.assign(fake.issues.get("2")!, { title: "Tide chart", body: "After harbour/tides#1.", labels: [{ name: "charts" }, { name: "priority:major" }] });
  fake.reply(2, "robin", "COLLABORATOR", "Weekly or daily?");
  // #2 is blocked by #1 (open) and by #3, closed: only open blockers come along.
  Object.assign(fake.issues.get("3")!, { state: "closed", state_reason: "completed" });
  fake.blockedBy.set("2", new Set([9001, 9003]));
  return fake;
}

const clientOf = (fake: ReturnType<typeof fakeIssues>) => createClient({ token: "t", repo: REPO, apiUrl: ISSUES_API, fetchImpl: fake.fetch });
const read = async (fake: ReturnType<typeof fakeIssues>, names: string[]) => fromGitHub((await readIssues(clientOf(fake), "none", 1000)).filter((issue) => names.includes(`#${issue.number}`)), REPO);
const movedComments = (fake: ReturnType<typeof fakeIssues>, number: number) => (fake.comments.get(String(number)) ?? []).filter((comment) => readMarker(comment.body)?.kind === "moved");

describe("moving issues back to the meta branch", { concurrency: 4 }, () => {
  test("GitHub: one commit of Items with rewritten references, the comments in the log; then a comment and a label on each, left open", async () => {
    const fake = github();
    const meta = fakeMeta("P");
    const report = await moveBack({ kind: "github", source: SOURCE, items: await read(fake, ["#1", "#2"]), to: meta, from: githubOldHost(clientOf(fake)), close: false, by: "Ada" });
    assert.equal(report.failed, undefined, moveBackLines(report).join("\n"));
    assert.deepEqual(report.rows.map((row) => [row.name, row.to, row.did]), [["#1", "P-1", ["created", "labelled", "commented"]], ["#2", "P-2", ["created", "labelled", "commented"]]]);
    assert.equal(meta.commits, 1);
    const one = meta.items.get("P-1")!;
    const two = meta.items.get("P-2")!;
    assert.match(one.input.body!, /^Needs P-2 first; see `#2` and https:\/\/github\.test\/harbour\/tides\/issues\/2\./, "code and addresses are left alone");
    assert.match(one.input.body!, /F\u200bixes #3, ask @\u200brobin/, "made inert; #3 did not move");
    assert.equal(one.input.verification, "Open the table.");
    assert.equal(one.unique, "github:harbour/tides#1");
    assert.match(two.input.body!, /^After P-1\./);
    assert.deepEqual(two.input.labels, ["charts"]);
    assert.equal(two.input.priority, "major");
    assert.deepEqual(two.input.blockedBy, ["P-1"]);
    assert.doesNotMatch(two.input.body!, /Blocked there by/, "a closed blocker is not one");
    const moved = two.lines.find((line) => line.kind === "moved")!;
    assert.equal(moved.fields.from, "#2");
    assert.match(String(moved.fields.history), /@\u200brobin: Weekly or daily\?/);
    assert.match(movedComments(fake, 1)[0]!.body ?? "", /it is Item \*\*P-1\*\* on the project's meta branch/);
    assert.ok(fake.issues.get("1")!.labels.some((label) => (typeof label === "string" ? label : label.name) === MOVED_LABEL));
    assert.equal(fake.issues.get("1")!.state, "open");
    assert.equal(fake.issues.get("3")!.labels.length, 0, "an issue not ticked is not touched");
    assert.equal(two.lines.find((line) => line.kind === "moved")!.fields.source, "github:harbour/tides");

    // Run again: found by the marker, nothing made or written twice.
    const again = await moveBack({ kind: "github", source: SOURCE, items: await read(fake, ["#1", "#2"]), to: meta, from: githubOldHost(clientOf(fake)), close: false, by: "Ada" });
    assert.deepEqual(again.rows.map((row) => row.did), [["found"], ["found"]]);
    assert.equal(meta.items.size, 2);
    assert.equal(movedComments(fake, 1).length, 1);
  });

  test("GitHub: a run that stops at a comment is finished by the next, closing as chosen", async () => {
    const fake = github();
    const meta = fakeMeta("P");
    fake.fail((call) => call === `POST /repos/${REPO}/issues/2/comments`, 502);
    const first = await moveBack({ kind: "github", source: SOURCE, items: await read(fake, ["#1", "#2"]), to: meta, from: githubOldHost(clientOf(fake)), close: true, by: "Ada" });
    assert.equal(first.failed?.name, "#2");
    assert.match(moveBackLines(first).at(-1)!, /Stopped at #2: .*Move back again/);
    const second = await moveBack({ kind: "github", source: SOURCE, items: await read(fake, ["#2"]), to: meta, from: githubOldHost(clientOf(fake)), close: true, by: "Ada" });
    assert.equal(second.failed, undefined);
    assert.deepEqual(second.rows.map((row) => [row.to, row.did]), [["P-2", ["found", "commented", "closed"]]]);
    assert.equal(meta.items.size, 2);
    for (const number of ["1", "2"]) assert.deepEqual([fake.issues.get(number)!.state, fake.issues.get(number)!.state_reason], ["closed", "not_planned"]);
  });

  test("an issue moved later gets its new id in the text of one moved before", async () => {
    const fake = github();
    const meta = fakeMeta("P");
    await moveBack({ kind: "github", source: SOURCE, items: await read(fake, ["#1"]), to: meta, from: githubOldHost(clientOf(fake)), close: false, by: "Ada" });
    assert.match(meta.items.get("P-1")!.input.body!, /^Needs #2 first/);
    const later = await moveBack({ kind: "github", source: SOURCE, items: await read(fake, ["#2"]), to: meta, from: githubOldHost(clientOf(fake)), close: false, by: "Ada" });
    assert.equal(later.failed, undefined);
    assert.match(meta.items.get("P-1")!.input.body!, /^Needs P-2 first; see `#2`/);
    assert.match(meta.items.get("P-2")!.input.body!, /^After P-1\./, "the earlier one's id comes from its moved line");
  });

  test("host text is cleaned (control characters, lone surrogates); an Item the meta branch still refuses is named, nothing written", async () => {
    const fake = github();
    Object.assign(fake.issues.get("1")!, { title: "Tide \u001b[31mtable", body: "Red \u001b[31mtext and a lone \ud800 half.\n\n## Verification\n\nOpen \u001b the table." });
    fake.reply(1, "robin", "COLLABORATOR", "Bell \u0007 and \udc00 here");
    const meta = fakeMeta("P");
    const report = await moveBack({ kind: "github", source: SOURCE, items: await read(fake, ["#1", "#2"]), to: meta, from: githubOldHost(clientOf(fake)), close: false, by: "Ada" });
    assert.equal(report.failed, undefined, moveBackLines(report).join("\n"));
    const one = meta.items.get("P-1")!;
    assert.equal(one.input.title, "Tide [31mtable");
    assert.match(one.input.body!, /^Red \[31mtext and a lone \ufffd half\./);
    assert.equal(one.input.verification, "Open the table.");
    assert.match(String(one.lines.find((line) => line.kind === "moved")!.fields.history), /Bell and \ufffd here/);

    const refused = github();
    const strict = fakeMeta("P");
    strict.refuse = (input) => (input.title === "Tide chart" ? "it is too large" : undefined);
    const stopped = await moveBack({ kind: "github", source: SOURCE, items: await read(refused, ["#1", "#2"]), to: strict, from: githubOldHost(clientOf(refused)), close: false, by: "Ada" });
    assert.equal(stopped.failed?.name, "#2");
    assert.match(stopped.failed?.message ?? "", /the meta branch refuses it: .*too large/);
    assert.equal(strict.items.size, 0);
    assert.equal(movedComments(refused, 1).length, 0);
  });

  test("Items moved from another repository are not taken for this one's; &#12; is not a reference", async () => {
    const fake = github();
    const meta = fakeMeta("P");
    meta.items.set("Q-1", { input: { title: "Elsewhere", body: "See #2." }, unique: "github:other/repo#1", lines: [{ kind: "moved", fields: { from: "#1", host: "github", source: "github:other/repo" } }] });
    const report = await moveBack({ kind: "github", source: SOURCE, items: await read(fake, ["#2"]), to: meta, from: githubOldHost(clientOf(fake)), close: false, by: "Ada" });
    assert.equal(report.failed, undefined, moveBackLines(report).join("\n"));
    assert.equal(meta.items.get("Q-1")!.input.body, "See #2.");
    assert.match(meta.items.get(report.rows[0]!.to!)!.input.body!, /^After harbour\/tides#1\./);
    assert.equal(rewriteIds("&#12; and #12", new Map([["#12", "P-1"]])), "&#12; and P-1");
  });

  test("GitHub: without the token's login no marker can be trusted, so nothing is written there", async () => {
    const fake = github();
    fake.fail((call) => call === "GET /user", 500, { times: 5 });
    const report = await moveBack({ kind: "github", source: SOURCE, items: await read(fake, ["#1"]), to: fakeMeta("P"), from: githubOldHost(clientOf(fake)), close: true, by: "Ada" });
    assert.match(report.failed?.message ?? "", /did not say whose token this is/);
    assert.equal(movedComments(fake, 1).length, 0);
    assert.equal(fake.issues.get("1")!.state, "open");
  });

  test("the old issues are left alone while the Items are not on the remote, or while a machine is busy", async () => {
    for (const blocked of ["pending", "busy"] as const) {
      const fake = github();
      const meta = fakeMeta("P");
      if (blocked === "pending") meta.sharing = "pending";
      const report = await moveBack({ kind: "github", source: SOURCE, items: await read(fake, ["#1"]), to: meta, from: githubOldHost(clientOf(fake)), close: true, by: "Ada", beforeClose: () => (blocked === "busy" ? "Busy now: laptop-b." : undefined) });
      assert.match(report.failed?.message ?? "", blocked === "pending" ? /not on the remote yet/ : /Busy now: laptop-b\. The old issues were left as they are/);
      assert.equal(meta.items.size, 1);
      assert.equal(movedComments(fake, 1).length, 0);
      assert.equal(fake.issues.get("1")!.state, "open");
    }
  });

  test("Jira: the issues and their people's comments move; each issue gets one comment naming its Item and is closed", async () => {
    const status = { name: "To Do", statusCategory: { key: "new", name: "To Do" } };
    const issue = (key: string, summary: string, description: string, links: JiraIssue["fields"]["issuelinks"] = []): JiraIssue => ({
      id: String(20000 + Number(key.split("-")[1])), key,
      fields: { summary, description, status, resolution: null, priority: null, labels: ["tides"], issuetype: { name: "Task", subtask: false }, subtasks: [], issuelinks: links, assignee: null, updated: "2026-11-20T09:00:00.000+0000" },
    });
    const stub = (key: string) => ({ id: String(20000 + Number(key.split("-")[1])), key, fields: { summary: key, status } });
    const jira = fakeJira({
      deployment: "datacenter", site: FAKE_DC_SITE, token: TOKEN, user: DC_ROBIN, project: "HARB",
      issues: [issue("HARB-1", "Tide table", "Before HARB-2."), issue("HARB-2", "Tide chart", "After HARB-1.", [{ id: "1", type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: stub("HARB-1") }])],
      comments: {
        "HARB-2": [{ id: "40001", author: DC_ROBIN, created: "2026-11-20T09:10:00.000+0000", body: "Weekly or daily?" }],
        // Someone else's comment with the marker does not count as Scope Soup's own.
        "HARB-1": [{ id: "40002", author: { name: "mallory", displayName: "Mallory Example" }, created: "2026-11-20T09:20:00.000+0000", body: backMarker("P-1") }],
      },
    });
    const host = createJiraHost({ site: FAKE_DC_SITE, project: "HARB", deployment: "datacenter", token: TOKEN, allowWrites: true, conventions: true, fetchImpl: jira.fetch, log: () => undefined });
    const readJira = async () => {
      const works = (await host.work.listWork()).items;
      return fromJira(works, new Map(await Promise.all(works.map(async (work) => [work.ref.id, (await host.thread(work.ref)).comments] as const))), FAKE_DC_SITE);
    };
    const meta = fakeMeta("P");
    const items = await readJira();
    const report = await moveBack({ kind: "jira", source: "jira:jira.example.test/HARB", items, to: meta, from: jiraOldHost(host), close: true, by: "Ada" });
    assert.equal(report.failed, undefined, moveBackLines(report).join("\n"));
    assert.deepEqual(report.rows.map((row) => [row.name, row.to, row.did]), [["HARB-1", "P-1", ["created", "commented", "closed"]], ["HARB-2", "P-2", ["created", "commented", "closed"]]]);
    assert.match(meta.items.get("P-1")!.input.body!, /^Before P-2\./);
    assert.deepEqual(meta.items.get("P-2")!.input.blockedBy, ["P-1"]);
    assert.equal(meta.items.get("P-2")!.unique, "jira:jira.example.test/HARB-2");
    assert.match(String(meta.items.get("P-2")!.lines.find((line) => line.kind === "moved")!.fields.history), /Robin Example: Weekly or daily\?/);
    const marked = (key: string) => (jira.comments[key] ?? []).filter((comment) => JSON.stringify(comment.body).includes(backMarker(key === "HARB-1" ? "P-1" : "P-2")));
    assert.equal(marked("HARB-1").length, 2, "its own comment besides the other account's");
    assert.equal(jira.issues.get("HARB-1")!.fields.status?.statusCategory?.key, "done");

    // A retry with the same issues (closed now, so a new plan would not list them): nothing made or written twice.
    const again = await moveBack({ kind: "jira", source: "jira:jira.example.test/HARB", items, to: meta, from: jiraOldHost(host), close: true, by: "Ada" });
    assert.deepEqual(again.rows.map((row) => row.did), [["found"], ["found"]]);
    assert.equal(marked("HARB-2").length, 1);
    assert.equal(marked("HARB-1").length, 2);
  });
});
