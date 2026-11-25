// Settings' connect dialogs (#127): `POST /api/connect` says what connecting would do, or why it cannot, and writes only when
// confirmed. The token comes from the given environment, the hosts are the fakes, and the shared settings are in memory.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { T0, work } from "../core/testing.ts";
import { memorySettings } from "../config/shared.ts";
import { FAKE_API, fakeGitHub } from "../hosts/github/fakeFetch.ts";
import { fakeJira, FAKE_SITE } from "../hosts/jira/fakeJira.ts";
import { CLOUD_EMAIL, CLOUD_ROBIN, cloudIssues, TOKEN } from "../hosts/jira/fixtures.ts";
import { openStore } from "../store/store.ts";
import type { ConnectDeps } from "./connect.ts";
import { createServer } from "./server.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const OWN = { version: 1, machineName: "laptop-a", repoPath: "repo", meta: { authorName: "Test Person", authorEmail: "test.person@example.invalid", prefix: "A" } };
const SHARED = { project: "demo", host: { kind: "metaBranch", write: true } };

/** A server on a fresh private file and in-memory shared settings, connecting through `deps`. */
async function setUp(deps: ConnectDeps) {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-connect-"));
  dirs.push(dir);
  const file = join(dir, "scopesoup.config.json");
  writeFileSync(file, JSON.stringify(OWN, null, 2) + "\n");
  const settings = memorySettings(SHARED, () => new Date(T0).toISOString());
  const store = openStore(":memory:");
  let changes = 0;
  const server = createServer({ store, now: () => new Date(T0), port: 0, configFile: file, programFound: () => true, sharedSettings: settings, connect: deps, onConfigChanged: () => changes++ });
  const base = (await server.start()).url;
  const post = async (body: unknown, person = "Ada") => {
    const response = await fetch(`${base}/api/connect`, { method: "POST", headers: { "Content-Type": "application/json", ...(person ? { "X-ScopeSoup-Person": person } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as { lines: string[]; problems: string[]; done?: boolean; config?: { host?: unknown } } };
  };
  const own = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const stop = async () => {
    await server.stop();
    store.close();
  };
  return { post, own, settings, store, stop, changes: () => changes };
}

const repoRoute = (push: boolean) => ({ "/repos/acme/widgets": { body: { full_name: "acme/widgets", has_issues: true, permissions: { push } } } });

describe("POST /api/connect", { concurrency: 4 }, () => {
  test("without the token it names the variable to set, looks at no host and writes nothing", async () => {
    const github = fakeGitHub(repoRoute(true));
    const s = await setUp({ env: {}, fetchImpl: github.fetch, githubApi: FAKE_API });
    try {
      const plan = await s.post({ kind: "github", repo: "acme/widgets", confirm: true });
      assert.equal(plan.status, 400);
      assert.match(plan.body.problems.join(" "), /SCOPESOUP_GITHUB_TOKEN is not set/);
      assert.equal(github.calls.length, 0);
      assert.deepEqual(s.own(), OWN);
      assert.deepEqual(s.settings.current(), SHARED);
    } finally {
      await s.stop();
    }
  });

  test("GitHub: says what it would do and that the meta branch's Items stay; connects only when confirmed", async () => {
    const github = fakeGitHub(repoRoute(true));
    const s = await setUp({ env: { SCOPESOUP_GITHUB_TOKEN: "ghp-synthetic" }, fetchImpl: github.fetch, githubApi: FAKE_API });
    try {
      const plan = await s.post({ kind: "github", repo: "https://github.com/acme/widgets.git" });
      assert.equal(plan.status, 200);
      assert.deepEqual(plan.body.problems, []);
      const text = plan.body.lines.join("\n");
      assert.match(text, /reads acme\/widgets, with write access/);
      assert.match(text, /no open Items on the meta branch/);
      assert.match(text, /remove meta from its scopesoup\.config\.json and set SCOPESOUP_GITHUB_TOKEN/);
      assert.deepEqual(s.settings.current(), SHARED, "a plan writes nothing");

      const done = await s.post({ kind: "github", repo: "acme/widgets", confirm: true });
      assert.equal(done.status, 200);
      assert.equal(done.body.done, true);
      assert.deepEqual(s.settings.current(), { project: "demo", host: { kind: "github", repo: "acme/widgets", write: true } });
      const own = s.own();
      assert.equal(own.meta, undefined, "the meta branch host's part of this machine is removed");
      assert.doesNotMatch(JSON.stringify(own) + JSON.stringify(s.settings.current()), /ghp-synthetic/);
      assert.equal(s.changes(), 1);
      assert.equal(s.store.eventsOfKinds(["config.changed"], 10).length, 1);
    } finally {
      await s.stop();
    }
  });

  test("GitHub: a read-only token connects read-only only, and open Items are said to stay where they are", async () => {
    const github = fakeGitHub(repoRoute(false));
    const s = await setUp({ env: { SCOPESOUP_GITHUB_TOKEN: "ghp-synthetic" }, fetchImpl: github.fetch, githubApi: FAKE_API });
    try {
      s.store.put(work(1), "sync", T0);
      s.store.put(work(2, { state: "done" }), "sync", T0);
      const read = await s.post({ kind: "github", repo: "acme/widgets", write: false });
      assert.deepEqual(read.body.problems, []);
      assert.match(read.body.lines.join("\n"), /The 1 open Item\(s\) on the meta branch \(refs\/scopesoup\/meta\) stay there: Scope Soup cannot move them to GitHub Issues/);
      const plan = await s.post({ kind: "github", repo: "acme/widgets", confirm: true });
      assert.equal(plan.status, 400);
      assert.match(plan.body.problems.join(" "), /cannot write to acme\/widgets/);
      assert.deepEqual(s.settings.current(), SHARED);
    } finally {
      await s.stop();
    }
  });

  test("Jira Cloud: counts the issues within the filter, keeps the email on this machine and the token nowhere", async () => {
    const jira = fakeJira({ deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, user: CLOUD_ROBIN, issues: cloudIssues() });
    const s = await setUp({ env: { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: jira.fetch });
    try {
      const body = { kind: "jira", site: `${FAKE_SITE}/`, project: "demo", deployment: "cloud", email: CLOUD_EMAIL, filter: "", components: ["Board"] };
      const plan = await s.post(body);
      assert.deepEqual(plan.body.problems, []);
      const text = plan.body.lines.join("\n");
      assert.match(text, new RegExp(`signs in to ${FAKE_SITE} as ${CLOUD_ROBIN.displayName}`));
      assert.match(text, new RegExp(`${cloudIssues().filter((issue) => issue.fields.status?.statusCategory?.key !== "done").length} open issue\\(s\\) of DEMO would be the Items`));
      assert.match(text, /add jira\.email/);

      const done = await s.post({ ...body, confirm: true });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual(s.settings.current(), { project: "demo", host: { kind: "jira", site: FAKE_SITE, project: "DEMO", deployment: "cloud", write: true, components: ["Board"] } });
      const own = s.own();
      assert.deepEqual(own.jira, { email: CLOUD_EMAIL });
      assert.equal(own.meta, undefined);
      assert.doesNotMatch(JSON.stringify(own) + JSON.stringify(s.settings.current()), new RegExp(TOKEN));
    } finally {
      await s.stop();
    }
  });

  test("what the configuration refuses is said before any host is asked", async () => {
    const jira = fakeJira({ deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, user: CLOUD_ROBIN });
    const s = await setUp({ env: { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: jira.fetch });
    try {
      const plan = await s.post({ kind: "jira", site: FAKE_SITE, project: "DEMO", deployment: "cloud", email: "" });
      assert.match(plan.body.problems.join(" "), /jira\.email/);
      assert.equal(jira.calls.length, 0);
      const bad = await s.post({ kind: "gitlab" });
      assert.equal(bad.status, 400);
    } finally {
      await s.stop();
    }
  });

  test("confirming needs a person, as every save of the shared settings does", async () => {
    const github = fakeGitHub(repoRoute(true));
    const s = await setUp({ env: { SCOPESOUP_GITHUB_TOKEN: "ghp-synthetic" }, fetchImpl: github.fetch, githubApi: FAKE_API });
    try {
      const done = await s.post({ kind: "github", repo: "acme/widgets", confirm: true }, "");
      assert.equal(done.status, 400);
      assert.match(done.body.problems.join(" "), /pick who you are/);
      assert.deepEqual(s.settings.current(), SHARED);
      assert.deepEqual(s.own(), OWN);
    } finally {
      await s.stop();
    }
  });
});
