// Settings' Jira filter (#141): `POST /api/config` with `host.filter` asks the fake Jira first. Jira's refusal of the JQL is the
// answer and nothing is saved; a filter that adds Items answers 409 with the counts until it is confirmed; then it is saved on the
// shared settings like any project setting, so History names who changed it. Components save the same way, with no question.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { T0 } from "../core/testing.ts";
import { memorySettings } from "../config/shared.ts";
import { fakeJira, FAKE_SITE } from "../hosts/jira/fakeJira.ts";
import { CLOUD_EMAIL, CLOUD_ROBIN, cloudIssues, TOKEN } from "../hosts/jira/fixtures.ts";
import { openStore } from "../store/store.ts";
import { createServer } from "./server.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const OWN = { version: 1, machineName: "laptop-a", repoPath: "repo", jira: { email: CLOUD_EMAIL } };
const HOST = { kind: "jira", site: FAKE_SITE, project: "DEMO", deployment: "cloud", write: true, filter: "labels = frontend" };

type Answer = { error?: { code: string; message: string }; errors?: string[]; filter?: { added: number; removed: number; lines: string[] }; changed?: boolean };

async function setUp(given: { level?: number; token?: boolean; host?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-filter-"));
  dirs.push(dir);
  const file = join(dir, "scopesoup.config.json");
  writeFileSync(file, JSON.stringify(OWN, null, 2) + "\n");
  const settings = memorySettings({ project: "demo", level: given.level ?? 1, host: given.host ?? HOST }, () => new Date(T0).toISOString());
  const jira = fakeJira({ deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, user: CLOUD_ROBIN, issues: cloudIssues() });
  const store = openStore(":memory:");
  const server = createServer({
    store, now: () => new Date(T0), port: 0, configFile: file, programFound: () => true, sharedSettings: settings, machine: "laptop-a",
    connect: { env: given.token === false ? {} : { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: jira.fetch },
  });
  const base = (await server.start()).url;
  const post = async (body: unknown) => {
    const response = await fetch(`${base}/api/config`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Answer };
  };
  const host = () => (settings.current()?.host ?? {}) as Record<string, unknown>;
  const stop = async () => {
    await server.stop();
    store.close();
  };
  return { post, host, settings, store, stop };
}

describe("Settings: the Jira filter", { concurrency: 4 }, () => {
  test("a filter that adds Items is counted and saved only when confirmed; History names who changed it", async () => {
    const s = await setUp();
    try {
      const asked = await s.post({ host: { filter: "labels = bug" } });
      assert.equal(asked.status, 409);
      assert.equal(asked.body.error?.code, "FILTER_WIDENS");
      // Open issues: DEMO-2 has the label bug (added), DEMO-1 had frontend (removed).
      assert.deepEqual({ added: asked.body.filter?.added, removed: asked.body.filter?.removed }, { added: 1, removed: 1 });
      const text = asked.body.filter!.lines.join(" ");
      assert.match(text, /adds 1 open issue of DEMO as Items/);
      assert.match(text, /Triage reads each of them and writes comments and labels on Jira/);
      assert.match(text, /removes 1 open issue from the board/);
      assert.equal(s.host().filter, "labels = frontend");
      assert.equal(s.settings.saves, 0);

      const done = await s.post({ host: { filter: "labels = bug" }, confirm: true });
      assert.equal(done.status, 200);
      assert.equal(s.host().filter, "labels = bug");
      assert.equal(s.host().site, FAKE_SITE);
      const entry = s.settings.log!("")[0]!;
      assert.equal(entry.who, "Ada");
      assert.deepEqual(entry.changes, [{ key: "host.filter", from: "labels = frontend", to: "labels = bug" }]);
      const event = s.store.eventsOfKinds(["config.changed"], 1)[0]!;
      assert.deepEqual((event.data as { fields: string[] }).fields, ["host"]);
    } finally {
      await s.stop();
    }
  });

  test("at level 0 the new Items only show; clearing the filter makes every open issue an Item", async () => {
    const s = await setUp({ level: 0 });
    try {
      const asked = await s.post({ host: { filter: null } });
      assert.equal(asked.status, 409);
      assert.equal(asked.body.filter?.added, 3);
      assert.match(asked.body.filter!.lines.join(" "), /At level 0 they only show on the board/);
      assert.equal((await s.post({ host: { filter: null }, confirm: true })).status, 200);
      assert.equal(Object.hasOwn(s.host(), "filter"), false);
    } finally {
      await s.stop();
    }
  });

  test("a narrower filter saves without asking", async () => {
    const s = await setUp({ host: { ...HOST, filter: "labels = frontend" } });
    try {
      const done = await s.post({ host: { filter: 'labels = frontend AND component = "Board"' } });
      assert.equal(done.status, 200);
      assert.equal(s.host().filter, 'labels = frontend AND component = "Board"');
    } finally {
      await s.stop();
    }
  });

  test("JQL Jira cannot read is refused with Jira's message, and nothing is saved", async () => {
    const s = await setUp();
    try {
      const refused = await s.post({ host: { filter: "assignee = currentUser()" }, confirm: true });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error!.message, /Jira refused the filter, so it was not saved: .*does not know this JQL filter/);
      const local = await s.post({ host: { filter: "labels = a ORDER BY created" }, confirm: true });
      assert.equal(local.status, 400);
      assert.match(local.body.error!.message, /ORDER BY/);
      assert.equal(s.settings.saves, 0);
    } finally {
      await s.stop();
    }
  });

  test("without the token the filter cannot be checked and is not saved", async () => {
    const s = await setUp({ token: false });
    try {
      const refused = await s.post({ host: { filter: "labels = bug" }, confirm: true });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error!.message, /SCOPESOUP_JIRA_TOKEN is not set/);
      assert.equal(s.settings.saves, 0);
    } finally {
      await s.stop();
    }
  });

  test("components save with no question; other host keys and a non-Jira host are refused", async () => {
    const s = await setUp();
    try {
      assert.equal((await s.post({ host: { components: ["Board", "Api"] } })).status, 200);
      assert.deepEqual(s.host().components, ["Board", "Api"]);
      assert.equal((await s.post({ host: { components: null } })).status, 200);
      assert.equal(Object.hasOwn(s.host(), "components"), false);
      const project = await s.post({ host: { project: "OTHER" } });
      assert.equal(project.status, 400);
      assert.match(project.body.error!.message, /host\.project cannot be changed from the board/);
    } finally {
      await s.stop();
    }
    const meta = await setUp({ host: { kind: "metaBranch", write: true } });
    try {
      const refused = await meta.post({ host: { components: ["Board"] } });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error!.message, /the project's host is not Jira/);
    } finally {
      await meta.stop();
    }
  });
});
