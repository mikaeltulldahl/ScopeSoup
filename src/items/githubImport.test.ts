// Importing GitHub Issues into Items once, against a fake GitHub (src/hosts/github/fakeIssues.ts) and a real temporary
// repository for the meta branch. Open issues with labels, sub-issues and blocked-by links; a second run imports nothing new;
// links are rewritten; closed issues are left out unless asked for; GitHub is only read. All names and texts are synthetic.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createClient } from "../hosts/github/client.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import type { FakeIssues } from "../hosts/github/fakeIssues.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import { createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import type { WorkItem } from "../model/types.ts";
import type { SourceIssue } from "./githubImport.ts";
import { cleanLabel, importBatch, importIssues, importKey, isRepoName, rewriteLinks } from "./githubImport.ts";

const REPO = "harbour/tides";
const REF = "refs/scopesoup/meta";
const R = `${ISSUES_API}/repos/${REPO}/issues`;
const NOW = new Date("2026-11-22T10:00:00Z");

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** A GitHub with six issues: labels, a parent and a sub-issue, a blocker, one assigned to the token's user, a closed one and a pull request. */
function github(): FakeIssues {
  const fake = fakeIssues(REPO, [1, 2, 3, 4, 5, 6, 7]);
  const issue = (number: number) => fake.issues.get(String(number))!;
  Object.assign(issue(1), { title: "Read the tide gauge", labels: [{ name: "sensors" }, { name: "priority:major" }, { name: "scopesoup:claimed" }], assignees: [{ login: "scopesoup-bot" }] });
  Object.assign(issue(2), { title: "Tide tables, overview", body: "The sub-issues: #3.\n\n## Verification\nThe table shows the next two tides.", assignees: [{ login: "bea" }] });
  Object.assign(issue(3), { title: "Tide table for one harbour", parent_issue_url: `${R}/2`, labels: ["tables"] });
  Object.assign(issue(4), {
    title: "Warn before a spring tide",
    body: "Needs the gauge (#1) and the old table (#5), see https://github.com/harbour/tides/issues/3 and [the overview](https://github.com/harbour/tides/issues/2).\n\n```\nnot a link: #1\n```\nAlso `#3` in code.",
  });
  Object.assign(issue(5), { title: "Old tide table", state: "closed", state_reason: "completed", updated_at: "2026-11-21T09:00:00Z" });
  Object.assign(issue(6), { title: "Dropped idea", state: "closed", state_reason: "not_planned", updated_at: "2026-11-20T09:00:00Z" });
  Object.assign(issue(7), { title: "Add the gauge driver", pull_request: { url: `${ISSUES_API}/repos/${REPO}/pulls/7` } });
  fake.blockedBy.set("4", new Set([9001, 9005]));
  return fake;
}

function meta(): { repo: TestRepo; host: MetaBranchHost } {
  const repo = createTestRepo();
  const host = createMetaBranchHost({ repoDir: repo.dir, ref: REF, allowWrites: true, remote: null, person: { name: "Ada", email: "ada@example.invalid" }, machine: "laptop-a", idPrefix: "A", now: () => NOW.toISOString() });
  cleanups.push(async () => {
    await host.stop();
    repo.cleanup();
  });
  return { repo, host };
}

const commits = (repo: TestRepo): number => {
  try {
    return Number(repo.git(["rev-list", "--count", REF]));
  } catch {
    return 0;
  }
};

async function run(fake: FakeIssues, host: MetaBranchHost, more: { closed?: "none" | "all" | number; dryRun?: boolean; comments?: number } = {}) {
  const client = createClient({ token: "t", repo: REPO, apiUrl: ISSUES_API, fetchImpl: fake.fetch });
  return importIssues({ client, writer: host.writer!, repo: REPO, person: "Ada", now: NOW, ...more });
}

async function items(host: MetaBranchHost): Promise<Map<string, WorkItem>> {
  const page = await host.work.listWork();
  return new Map(page.items.map((item) => [item.title, item]));
}

describe("import from GitHub Issues", { concurrency: 4 }, () => {
  test("open issues become Items in one commit by the person, with labels, priority, parent, blockers and the holder", async () => {
    const fake = github();
    const { repo, host } = meta();
    const report = await run(fake, host);
    assert.deepEqual(report.rows.map((row) => [row.number, row.id, row.created]), [[1, "A-1", true], [2, "A-2", true], [3, "A-3", true], [4, "A-4", true]]);
    assert.equal(commits(repo), 1);
    assert.match(repo.git(["log", "-1", "--format=%an <%ae>%n%s", REF]), /^Ada <ada@example\.invalid>\nImport 4 issues from GitHub harbour\/tides$/);

    const got = await items(host);
    const gauge = got.get("Read the tide gauge")!;
    assert.deepEqual(gauge.labels, ["sensors"]);
    assert.equal(gauge.priority, "major");
    assert.equal(gauge.state, "todo");
    // Assigned to the token's user: held by the person who ran the import.
    assert.equal(gauge.holder?.actor.name, "Ada on laptop-a");
    const overview = got.get("Tide tables, overview")!;
    assert.equal(overview.holder, undefined);
    assert.equal(overview.verification, "The table shows the next two tides.");
    assert.match(overview.body ?? "", /^The sub-issues: A-3\.\n\n_Imported from GitHub: \[harbour\/tides#2\]\(https:\/\/github\.test\/harbour\/tides\/issues\/2\)\. Assigned there to @bea\._$/);
    assert.equal(got.get("Tide table for one harbour")!.parent?.id, "A-2");
    assert.deepEqual(got.get("Tide table for one harbour")!.labels, ["tables"]);
    const warn = got.get("Warn before a spring tide")!;
    // #5 is closed and not imported: not a blocker here, and named in the text.
    assert.deepEqual(warn.blockedBy.map((ref) => ref.id), ["A-1"]);
    assert.equal(
      warn.body,
      "Needs the gauge (A-1) and the old table (harbour/tides#5), see A-3 and [the overview](https://github.com/harbour/tides/issues/2).\n\n```\nnot a link: #1\n```\nAlso `#3` in code.\n\n_Imported from GitHub: [harbour/tides#4](https://github.test/harbour/tides/issues/4)._",
    );
    // Where it came from is in the header.
    assert.match(repo.git(["show", `${REF}:items/A-4/item.md`]), /\nimportedFrom: github:harbour\/tides#4\n/);
    // Pull requests and closed issues are not imported, and nothing was written to GitHub.
    assert.equal(got.size, 4);
    assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET ")), []);
    assert.deepEqual(fake.sent, []);
  });

  test("a second run imports nothing new and makes no commit; a new issue is linked to the Items of the first run", async () => {
    const fake = github();
    const { repo, host } = meta();
    await run(fake, host);
    const again = await run(fake, host);
    assert.deepEqual(again.rows.map((row) => [row.number, row.id, row.created]), [[1, "A-1", false], [2, "A-2", false], [3, "A-3", false], [4, "A-4", false]]);
    assert.equal(again.commit, undefined);
    assert.equal(commits(repo), 1);

    const added = fake.issues.get("3")!;
    fake.issues.set("8", { ...structuredClone(added), number: 8, id: 9008, title: "Second harbour", body: "Like #3.", parent_issue_url: `${R}/2`, html_url: "https://github.test/harbour/tides/issues/8" });
    const third = await run(fake, host);
    assert.deepEqual(third.rows.filter((row) => row.created).map((row) => [row.number, row.id]), [[8, "A-5"]]);
    assert.equal(commits(repo), 2);
    const second = (await items(host)).get("Second harbour")!;
    assert.equal(second.parent?.id, "A-2");
    assert.match(second.body ?? "", /^Like A-3\./);
  });

  test("closed issues are left out unless asked for: the last N, or all, as done or abandoned", async () => {
    const fake = github();
    const { host } = meta();
    const one = await run(fake, host, { closed: 1, dryRun: true });
    assert.deepEqual(one.rows.map((row) => row.number), [1, 2, 3, 4, 5]);
    const all = await run(fake, host, { closed: "all" });
    assert.deepEqual(all.rows.map((row) => [row.number, row.id, row.state]), [[1, "A-1", "todo"], [2, "A-2", "todo"], [3, "A-3", "todo"], [4, "A-4", "todo"], [5, "A-5", "done"], [6, "A-6", "abandoned"]]);
    const warn = (await items(host)).get("Warn before a spring tide")!;
    // With #5 imported, it is a blocker and its link is rewritten.
    assert.deepEqual(warn.blockedBy.map((ref) => ref.id), ["A-1", "A-5"]);
    assert.match(warn.body ?? "", /the old table \(A-5\)/);
  });

  test("a dry run says what would be imported and writes nothing", async () => {
    const fake = github();
    const { repo, host } = meta();
    const report = await run(fake, host, { dryRun: true });
    assert.deepEqual(report.rows.map((row) => [row.number, row.id, row.created, row.held]), [[1, "A-1", true, true], [2, "A-2", true, false], [3, "A-3", true, false], [4, "A-4", true, false]]);
    assert.equal(report.commit, undefined);
    assert.equal(commits(repo), 0);
  });
});

describe("comments", { concurrency: 4 }, () => {
  /** Issue 1 with five comments of people, one of Scope Soup's own, one bot's and an empty one; issue 2 with one. */
  function talkative(): FakeIssues {
    const fake = github();
    fake.reply(1, "bea", "MEMBER", "First thoughts.");
    fake.reply(1, "cy", "NONE", "Second: see #3.");
    fake.reply(1, "scopesoup-bot", "OWNER", "Claimed.\n\n<!-- scopesoup:claim {\"v\":1} -->");
    fake.reply(1, "dependabot[bot]", "NONE", "Bumped a thing.");
    fake.reply(1, "bea", "MEMBER", "Third,\u0007 with a bell.\r\n\n## Not a heading\n```\n#1\n```");
    fake.reply(1, "dan", "NONE", "   ");
    fake.reply(1, "cy", "NONE", "Fourth.");
    fake.reply(1, "ed", "NONE", "Fifth and last.");
    fake.reply(2, "bea", "MEMBER", "Only one here.");
    const bot = fake.comments.get("1")!.find((comment) => comment.user?.login === "dependabot[bot]")!;
    bot.user = { login: "dependabot[bot]", type: "Bot" };
    return fake;
  }

  test("the last 3 comments of people come along, marked as imported: who, when, a link; Scope Soup's own and bots' are skipped", async () => {
    const fake = talkative();
    const { host } = meta();
    const report = await run(fake, host);
    assert.deepEqual(report.rows.map((row) => [row.number, row.comments]), [[1, 3], [2, 1], [3, 0], [4, 0]]);
    const got = await items(host);
    const gauge = got.get("Read the tide gauge")!.body ?? "";
    const section = gauge.slice(gauge.indexOf("## Comments imported from GitHub"));
    assert.match(section, /^## Comments imported from GitHub\n\n_The last 3 of 5 comments on \[harbour\/tides#1\]\(https:\/\/github\.test\/harbour\/tides\/issues\/1\)\._\n\n\*\*@bea\*\* wrote on 2026-11-22 09:00 UTC \(\[link\]\(https:\/\/github\.test\/harbour\/tides\/issues\/1#issuecomment-\d+\)\):\n\n> Third, with a bell\.\n>\n> ## Not a heading\n> ```\n> #1\n> ```\n\n\*\*@cy\*\* wrote on [^\n]+\n\n> Fourth\.\n\n\*\*@ed\*\* wrote on [^\n]+\n\n> Fifth and last\.\n\n_Imported from GitHub/);
    for (const left of ["First thoughts", "Second", "Claimed", "Bumped", "scopesoup:claim"]) assert.ok(!gauge.includes(left), left);
    assert.match(got.get("Tide tables, overview")!.body ?? "", /_The comments on \[harbour\/tides#2\][^\n]*\n\n\*\*@bea\*\* wrote on [^\n]+\n\n> Only one here\.\n\n_Imported/);
    // No comments, no section.
    assert.ok(!(got.get("Tide table for one harbour")!.body ?? "").includes("## Comments"));
    assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET ")), []);
  });

  test("a number of comments, links in them rewritten; none with the option, and then no comment is read", async () => {
    const fake = talkative();
    const { host } = meta();
    await run(fake, host, { comments: 4 });
    const gauge = (await items(host)).get("Read the tide gauge")!.body ?? "";
    assert.match(gauge, /_The last 4 of 5 comments/);
    assert.match(gauge, /> Second: see A-3\./);

    const other = talkative();
    const second = meta();
    const report = await run(other, second.host, { comments: 0 });
    assert.deepEqual(report.rows.map((row) => row.comments), [0, 0, 0, 0]);
    for (const item of (await items(second.host)).values()) assert.ok(!(item.body ?? "").includes("## Comments"), item.title);
    assert.deepEqual(other.calls.filter((call) => call.includes("/comments")), []);
  });
});

describe("the mapping", { concurrency: 4 }, () => {
  const source = (more: Partial<SourceIssue>): SourceIssue => ({ number: 1, title: "T", body: "", open: true, labels: [], assignees: [], url: "https://github.test/x", blockedBy: [], ...more });

  test("links: #N, owner/name#N and the issue URL become ids; a #N not imported names the repository; code is left alone", () => {
    const ids = new Map([[3, "A-3"]]);
    const idOf = (number: number) => ids.get(number);
    assert.equal(rewriteLinks("See #3, Harbour/Tides#3 and https://github.com/harbour/tides/issues/3.", REPO, idOf), "See A-3, A-3 and A-3.");
    assert.equal(rewriteLinks("Not #9, nor other/repo#3, nor page#3, nor &#3; nor https://github.com/harbour/tides/issues/3#issuecomment-1.", REPO, idOf), "Not harbour/tides#9, nor other/repo#3, nor page#3, nor &#3; nor https://github.com/harbour/tides/issues/3#issuecomment-1.");
    assert.equal(rewriteLinks("[#3](https://github.com/harbour/tides/issues/3) <https://github.com/harbour/tides/issues/3>", REPO, idOf), "[A-3](https://github.com/harbour/tides/issues/3) <https://github.com/harbour/tides/issues/3>");
    assert.equal(rewriteLinks("~~~\n#3\n~~~\n`#3` #3", REPO, idOf), "~~~\n#3\n~~~\n`#3` A-3");
  });

  test("titles, labels and bodies are made writable; GitHub's own labels are dropped; the key is lower case", () => {
    assert.equal(isRepoName("harbour/tides"), true);
    assert.equal(isRepoName("harbour/.."), false);
    assert.equal(isRepoName("harbour"), false);
    assert.equal(importKey("Harbour/Tides", 4), "github:harbour/tides#4");
    assert.equal(cleanLabel(" a, [b] "), "a b");
    const [item] = importBatch([source({ title: "  Two\nlines\u2028here ", body: "x\u0007y\r\nz", labels: ["Priority: critical", "scopesoup:review", "area, core", "area, core"] })], { repo: REPO, person: "Ada", now: NOW });
    const made = item!.make(() => "A-1");
    assert.equal(made.input.title, "Two lines here");
    assert.deepEqual(made.input.labels, ["area core"]);
    assert.equal(made.input.priority, "critical");
    assert.match(made.input.body ?? "", /^xy\nz\n\n_Imported/);
    assert.deepEqual(item!.unique, ["importedFrom", "github:harbour/tides#1"]);
    // A Verification section over several lines stays in the description.
    const [long] = importBatch([source({ body: "Do it.\n\n## Verification\nOne.\nTwo." })], { repo: REPO, person: "Ada", now: NOW });
    const longMade = long!.make(() => "A-1");
    assert.equal(longMade.input.verification, undefined);
    assert.match(longMade.input.body ?? "", /## Verification\nOne\.\nTwo\./);
  });
});
