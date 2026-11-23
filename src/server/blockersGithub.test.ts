// A GitHub Item's page shows the Items it blocks from GitHub's `dependencies/blocking`, with one request when it opens,
// and the board's change of its blockers is written through as dependencies. The real adapter on a fake GitHub; nothing
// reaches the network. All names are synthetic.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import type { ItemPage } from "../core/views.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { createHostActions } from "../orchestrator/hostActions.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

const at = "2026-11-22T09:00:00Z";
const R = "/repos/harbour/tides/issues";
const fake = fakeIssues("harbour/tides", [1, 2, 3, 4]);
const work = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({ ref: { host: "github", kind: "work", id }, title: `Tide table ${id}`, state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: at, ...over });
const ref = (id: string): Ref => ({ host: "github", kind: "work", id });

let store: Store;
let server: ScopeSoupServer;
let base: string;

before(async () => {
  store = openStore(":memory:");
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true });
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store });
  server = createServer({ store, port: 0, hostEdit: { host: "github", edit: actions.editItem! }, blocking: { host: "github", list: (item) => host.blocking(item) } });
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  store.close();
});

const page = async (key: string): Promise<ItemPage> => (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;

describe("a GitHub Item's dependencies on the board", () => {
  test("the page shows the Items it blocks as GitHub says, with one request", async () => {
    for (const id of ["1", "2", "3"]) store.put(work(id), "sync", at);
    // The store does not know yet that 2 is blocked by 1; GitHub does.
    fake.blockedBy.set("2", new Set([9001]));
    fake.clear();
    const shown = await page("github:work:1");
    assert.deepEqual(shown.blocks.map((other) => other.key), ["github:work:2"]);
    assert.deepEqual(fake.calls, [`GET ${R}/1/dependencies/blocking?per_page=100`]);
  });

  test("the board's change of the blockers adds and removes dependencies", async () => {
    store.put(work("4", { blockedBy: [ref("3")] }), "sync", at);
    fake.blockedBy.set("4", new Set([9003]));
    fake.clear();
    const response = await fetch(`${base}/api/item/edit`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: "github:work:4", blockedBy: ["#1"] }) });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET")), [`POST ${R}/4/dependencies/blocked_by`, `DELETE ${R}/4/dependencies/blocked_by/9003`]);
    assert.deepEqual([...fake.blockedBy.get("4")!], [9001]);
  });

  test("a change GitHub answers OK to but does not keep is refused, writes orchestrator.host_write_failed and leaves the store", async () => {
    store.put(work("3"), "sync", at);
    fake.dropsDependencies = true;
    const response = await fetch(`${base}/api/item/edit`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: "github:work:3", blockedBy: ["2"] }) });
    fake.dropsDependencies = false;
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: { message: string } }).error.message, /blocked by #2 not added/);
    const failed = store.eventsAfter(0, 10_000).filter((event) => event.kind === "orchestrator.host_write_failed" && event.subject === "github:work:3");
    assert.equal(failed.length, 1);
    assert.deepEqual(store.get<WorkItem>(ref("3"))?.blockedBy, []);
  });
});
