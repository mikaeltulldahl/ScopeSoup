import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { WorkGone } from "../../ports/host.ts";
import { createJiraHost } from "./adapter.ts";
import type { Deployment } from "./client.ts";
import { FAKE_DC_SITE, FAKE_SITE, fakeJira } from "./fakeJira.ts";
import { CLOUD_EMAIL, CLOUD_ROBIN, cloudComments, cloudIssues, COMMENT_PROPERTIES, DC_ROBIN, dcComments, dcIssues, ISSUE_PROPERTIES, TOKEN } from "./fixtures.ts";
import { jqlTime } from "./map.ts";

function setup(deployment: Deployment, more: { pageSize?: number; moved?: Record<string, string> } = {}) {
  const cloud = deployment === "cloud";
  const fake = fakeJira({
    deployment, token: TOKEN, ...(cloud ? { email: CLOUD_EMAIL } : {}), user: cloud ? CLOUD_ROBIN : DC_ROBIN,
    issues: cloud ? cloudIssues() : dcIssues(), comments: cloud ? cloudComments() : dcComments(),
    issueProperties: ISSUE_PROPERTIES, commentProperties: COMMENT_PROPERTIES, ...more,
  });
  const host = createJiraHost({
    site: cloud ? FAKE_SITE : FAKE_DC_SITE, project: "DEMO", deployment, token: TOKEN, ...(cloud ? { email: CLOUD_EMAIL } : {}),
    fetchImpl: fake.fetch, now: () => Date.parse("2026-11-20T12:00:00Z"),
  });
  return { fake, host };
}

for (const deployment of ["cloud", "datacenter"] as const) {
  const site = deployment === "cloud" ? FAKE_SITE : FAKE_DC_SITE;
  describe(`Jira ${deployment}`, { concurrency: 4 }, () => {
    test("is read-only: work only, no write port", () => {
      const { host } = setup(deployment);
      assert.deepEqual([...host.info.capabilities], ["work"]);
      assert.equal(host.write, undefined);
    });

    test("whoami is the token's user", async () => {
      const { host } = setup(deployment);
      assert.deepEqual(await host.info.whoami(), deployment === "cloud" ? { id: CLOUD_ROBIN.accountId, name: "Robin Example" } : { id: "robin", name: "Robin Example" });
    });

    test("the first listing is the open issues, mapped", async () => {
      const { host } = setup(deployment);
      const page = await host.work.listWork();
      assert.deepEqual(page.items.map((item) => item.ref.id), ["DEMO-1", "DEMO-2", "DEMO-3", "DEMO-5"]);
      assert.equal(page.cursor, "2026-11-20T10:00:30.000Z");
      const [one, two, three, five] = page.items;
      assert.deepEqual(one, {
        ref: { host: "jira", kind: "work", id: "DEMO-1", url: `${site}/browse/DEMO-1` },
        title: "Board shows the demo project",
        state: "doing",
        hostState: "In Progress",
        labels: ["frontend"],
        blockedBy: [],
        openChildren: 1,
        children: 2,
        priority: "critical",
        updatedAt: "2026-11-20T09:00:00.000Z",
        body: deployment === "cloud"
          ? "## Goal\n\nShow **every** Item, see [the notes](https://example.test/notes).\n\n- columns\n- cards"
          : "## Goal\n\nShow **every** Item, see [the notes](https://example.test/notes).\n- columns\n- cards",
        verification: "Open the board and see DEMO-1.",
      });
      // Blocked by the open DEMO-3 only: DEMO-4 is done, DEMO-6 is blocked by DEMO-2, Relates is no blocker.
      assert.deepEqual(two?.blockedBy.map((ref) => ref.id), ["DEMO-3"]);
      assert.equal(two?.state, "todo");
      assert.equal(two?.hostState, "Backlog");
      assert.equal(two?.priority, "blocker");
      assert.deepEqual(two?.labels, ["bug", "scopesoup-needs-decision"]);
      assert.deepEqual(two?.holder, { actor: deployment === "cloud" ? { id: CLOUD_ROBIN.accountId, name: "Robin Example" } : { id: "robin", name: "Robin Example" } });
      assert.deepEqual(host.simplified("DEMO-2"), deployment === "cloud" ? ["mention", "status", "panel"] : ["panel", "mention", "color"]);
      assert.deepEqual(host.simplified("DEMO-1"), []);
      assert.equal(three?.body, undefined);
      assert.equal(three?.priority, "major");
      assert.deepEqual(five?.parent, { host: "jira", kind: "work", id: "DEMO-1", url: `${site}/browse/DEMO-1` });
      assert.equal(five?.priority, "minor");
    });

    test("a listing from a cursor asks from two minutes before it, in the user's time zone, and pages", async () => {
      const { host, fake } = setup(deployment, { pageSize: 1 });
      const zone = deployment === "cloud" ? "Asia/Tokyo" : "America/New_York";
      const page = await host.work.listWork("2026-11-20T10:01:00.000Z");
      // DEMO-3 (10:00:00) and DEMO-5 (10:00:30) are within the overlap; nothing else changed since.
      assert.deepEqual(page.items.map((item) => item.ref.id), ["DEMO-3", "DEMO-5"]);
      assert.equal(page.cursor, "2026-11-20T10:01:00.000Z");
      const jql = deployment === "cloud"
        ? (fake.calls.find((call) => call.method === "POST")?.body as { jql: string }).jql
        : new URL(`${site}${fake.calls.find((call) => call.path.includes("/search"))?.path}`).searchParams.get("jql");
      assert.equal(jql, `project = "DEMO" AND updated >= "${jqlTime("2026-11-20T09:59:00.000Z", zone)}" ORDER BY updated ASC, key ASC`);
      assert.equal(fake.calls.filter((call) => call.path.includes("/search")).length, 2);
    });

    test("closed issues come in from a cursor: done, and abandoned for a won't-do resolution", async () => {
      const { host } = setup(deployment);
      const page = await host.work.listWork("2026-11-18T00:00:00.000Z");
      const byId = new Map(page.items.map((item) => [item.ref.id, item]));
      assert.equal(byId.get("DEMO-4")?.state, "done");
      assert.equal(byId.get("DEMO-6")?.state, "abandoned");
      assert.equal(byId.get("DEMO-6")?.priority, "minor");
      assert.equal(page.cursor, "2026-11-20T10:00:30.000Z");
    });

    test("an empty project starts its cursor a minute back", async () => {
      const fake = fakeJira({ deployment, token: TOKEN, email: CLOUD_EMAIL, user: CLOUD_ROBIN });
      const host = createJiraHost({ site, project: "DEMO", deployment, token: TOKEN, email: CLOUD_EMAIL, fetchImpl: fake.fetch, now: () => Date.parse("2026-11-20T12:00:00Z") });
      assert.deepEqual(await host.work.listWork(), { items: [], cursor: "2026-11-20T11:59:00.000Z" });
    });

    test("get: one issue; null when Jira does not know it; WorkGone when it was moved", async () => {
      const { host } = setup(deployment, { moved: { "DEMO-9": "OTHER-3" } });
      assert.equal((await host.work.getWork({ host: "jira", kind: "work", id: "DEMO-6" }))?.state, "abandoned");
      assert.equal(await host.work.getWork({ host: "jira", kind: "work", id: "DEMO-99" }), null);
      const { fake: other, host: moving } = setup(deployment, { moved: { "DEMO-9": "OTHER-3" } });
      const issue = cloudIssues()[2];
      if (issue) other.issues.set("OTHER-3", { ...issue, key: "OTHER-3" });
      await assert.rejects(moving.work.getWork({ host: "jira", kind: "work", id: "DEMO-9" }), (error: unknown) => error instanceof WorkGone && error.movedTo === "OTHER-3");
    });

    test("thread: comments as Markdown with Scope Soup's comment and issue properties", async () => {
      const { host, fake } = setup(deployment);
      const thread = await host.thread({ host: "jira", kind: "work", id: "DEMO-2" });
      assert.deepEqual(thread.comments.map((comment) => [comment.id, comment.author.name, comment.created, comment.markdown, comment.properties]), [
        ["30001", "Robin Example", "2026-11-20T09:10:00.000Z", "Is SSO affected too?", {}],
        ["30002", "Scope Soup Bot", "2026-11-20T09:20:00.000Z", "Scope Soup question Q1\n\nWhich page should the redirect go to?", { scopesoup: { kind: "question", n: 1 } }],
      ]);
      assert.deepEqual(thread.properties, { "scopesoup.log": { lines: [{ kind: "claimed", at: "2026-11-20T09:00:00Z" }] } });
      // Cloud's fake expands properties on the list; Data Center's reads them per comment.
      const perComment = fake.calls.filter((call) => call.path.includes("/comment/")).length;
      assert.equal(perComment, deployment === "cloud" ? 0 : 3);
    });
  });
}

test("the fixtures name only the example sites and hold no real-looking email or token", () => {
  const text = ["fixtures.ts", "fakeJira.ts"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
  for (const url of text.match(/https?:\/\/[^\s"'`/]+/g) ?? []) assert.match(url, /^https:\/\/(example\.atlassian\.net|jira\.example\.test|example\.test)$/, url);
  for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) assert.match(email, /@example\.test$/, email);
});
