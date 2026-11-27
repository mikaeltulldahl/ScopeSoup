import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubHost } from "./adapter.ts";
import type { FetchLike } from "./client.ts";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fake GitHub that answers from `routes` ("METHOD /path" -> [status, body]) and records what it was sent. */
function fake(routes: Record<string, [number, unknown]>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.test", "");
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    const [status, body] = routes[`${method} ${path}`] ?? [404, { message: "not found" }];
    return { status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

const config = { token: "t", repo: "harbour/tides", apiUrl: "https://api.github.test" };
const HEAD = "/repos/harbour/tides/pulls?state=open&head=harbour%3Ascopesoup%2F7&per_page=5";
const input = { branch: "scopesoup/7", target: "main", title: "Cache tide data", body: "Summary.\n\nCloses #7" };

test("without allowWrites the host has no write port", () => {
  const host = createGitHubHost({ ...config, fetchImpl: fake({}).fetchImpl });
  assert.equal(host.write, undefined);
  assert.equal(host.info.capabilities.has("write"), false);
});

test("openChange creates a pull request for the branch and returns its ref", async () => {
  const f = fake({ [`GET ${HEAD}`]: [200, []], "POST /repos/harbour/tides/pulls": [201, { number: 41, html_url: "https://github.test/harbour/tides/pull/41" }] });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  assert.equal(host.info.capabilities.has("write"), true);
  const ref = await host.write!.openChange!(input);
  assert.deepEqual(ref, { host: "github", kind: "change", id: "41", url: "https://github.test/harbour/tides/pull/41" });
  assert.deepEqual(f.calls.at(-1), { method: "POST", path: "/repos/harbour/tides/pulls", body: { title: "Cache tide data", head: "scopesoup/7", base: "main", body: input.body, draft: false } });
});

test("openChange returns the open pull request of the branch instead of making a second", async () => {
  const f = fake({ [`GET ${HEAD}`]: [200, [{ number: 40, html_url: "u" }]] });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  assert.equal((await host.write!.openChange!(input)).id, "40");
  assert.equal(f.calls.some((call) => call.method === "POST"), false);
});

test("a refused create is an error that says why", async () => {
  const f = fake({ [`GET ${HEAD}`]: [200, []], "POST /repos/harbour/tides/pulls": [422, { message: "No commits between main and scopesoup/7" }] });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  await assert.rejects(host.write!.openChange!(input), /422.*No commits between/);
});

test("comment and setLabels use the issues endpoints; removing a label that is not there is fine", async () => {
  const f = fake({
    "POST /repos/harbour/tides/issues/7/comments": [201, { id: 1 }],
    "POST /repos/harbour/tides/labels": [201, { name: "ready" }],
    "POST /repos/harbour/tides/issues/7/labels": [200, []],
    "DELETE /repos/harbour/tides/issues/7/labels/needs%20owner": [404, { message: "Label does not exist" }],
    "GET /repos/harbour/tides/issues/7": [200, { number: 7, labels: [{ name: "ready" }] }],
  });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  const subject = { host: "github", kind: "work" as const, id: "7" };
  await host.write!.comment!(subject, "Hello.");
  await host.write!.setLabels!(subject, ["ready"], ["needs owner"]);
  // A label the repository may lack is made first (a plain one for a name that is not Scope Soup's own).
  assert.deepEqual(f.calls.filter((call) => call.path !== "/repos/harbour/tides/labels").map((call) => [call.method, call.body]), [["POST", { body: "Hello." }], ["POST", { labels: ["ready"] }], ["DELETE", undefined], ["GET", undefined]]);
  assert.equal(f.calls.filter((call) => call.path === "/repos/harbour/tides/labels").length, 1);
});

test("closeWork comments, then closes the issue as completed; the re-read must show it closed", async () => {
  const routes: Record<string, [number, unknown]> = {
    "POST /repos/harbour/tides/issues/7/comments": [201, { id: 1 }],
    "PATCH /repos/harbour/tides/issues/7": [200, { number: 7, state: "closed" }],
    "GET /repos/harbour/tides/issues/7": [200, { number: 7, state: "closed", state_reason: "completed" }],
  };
  const f = fake(routes);
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  await host.write!.closeWork!({ host: "github", kind: "work", id: "7" }, "Merged in abc123 (batch 1).");
  assert.deepEqual(f.calls.map((call) => [call.method, call.path, call.body]), [
    ["POST", "/repos/harbour/tides/issues/7/comments", { body: "Merged in abc123 (batch 1)." }],
    ["PATCH", "/repos/harbour/tides/issues/7", { state: "closed", state_reason: "completed" }],
    ["GET", "/repos/harbour/tides/issues/7", undefined],
  ]);
  routes["GET /repos/harbour/tides/issues/7"] = [200, { number: 7, state: "open" }];
  await assert.rejects(host.write!.closeWork!({ host: "github", kind: "work", id: "7" }, "Merged."), /did not apply it on #7 \(state not closed\)/);
});

test("closeChange comments on an open pull request, then closes it", async () => {
  const f = fake({
    "POST /repos/harbour/tides/issues/41/comments": [201, { id: 1 }],
    "GET /repos/harbour/tides/pulls/41": [200, { number: 41, state: "open", merged: false }],
    "PATCH /repos/harbour/tides/pulls/41": [200, { number: 41, state: "closed" }],
  });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  await host.write!.closeChange!({ host: "github", kind: "change", id: "41" }, "Merged in abc123.");
  assert.deepEqual(f.calls.map((call) => [call.method, call.path, call.body]), [
    ["POST", "/repos/harbour/tides/issues/41/comments", { body: "Merged in abc123." }],
    ["GET", "/repos/harbour/tides/pulls/41", undefined],
    ["PATCH", "/repos/harbour/tides/pulls/41", { state: "closed" }],
  ]);
});

test("closeChange only comments on a pull request that is merged or already closed", async () => {
  for (const pull of [{ number: 41, state: "closed", merged: true }, { number: 41, state: "closed", merged: false }]) {
    const f = fake({
      "POST /repos/harbour/tides/issues/41/comments": [201, { id: 1 }],
      "GET /repos/harbour/tides/pulls/41": [200, pull],
    });
    const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
    await host.write!.closeChange!({ host: "github", kind: "change", id: "41" }, "Merged.");
    assert.equal(f.calls.some((call) => call.method === "PATCH"), false);
    assert.equal(f.calls[0]!.method, "POST");
  }
});

test("openChange returns the pull request that a racing writer made first", async () => {
  const calls: string[] = [];
  let listings = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.test", "");
    calls.push(`${method} ${path}`);
    let status = 404;
    let body: unknown = { message: "not found" };
    if (method === "GET" && path === HEAD) {
      listings += 1;
      [status, body] = listings === 1 ? [200, []] : [200, [{ number: 44, html_url: "u" }]];
    } else if (method === "POST" && path === "/repos/harbour/tides/pulls") {
      [status, body] = [422, { message: "A pull request already exists" }];
    }
    return { status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const host = createGitHubHost({ ...config, fetchImpl, allowWrites: true });
  assert.equal((await host.write!.openChange!(input)).id, "44");
  assert.equal(listings, 2);
});

test("createWork with a parent makes the issue, then links it as a sub-issue by its id", async () => {
  const f = fake({
    "POST /repos/harbour/tides/issues": [201, { number: 12, id: 9001, html_url: "https://github.test/harbour/tides/issues/12" }],
    "POST /repos/harbour/tides/issues/5/sub_issues": [201, { number: 5 }],
  });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  const done = await host.write!.createWork!({ title: "Child", parent: { host: "github", kind: "work", id: "5" } });
  assert.equal(done.work.id, "12");
  assert.deepEqual(f.calls.map((call) => [call.method, call.path, call.body]), [
    ["POST", "/repos/harbour/tides/issues", { title: "Child" }],
    ["POST", "/repos/harbour/tides/issues/5/sub_issues", { sub_issue_id: 9001 }],
  ]);
});

test("createWork whose sub-issue link fails keeps the issue and says it is not linked; linkChild links it later by its id", async () => {
  const f = fake({
    "POST /repos/harbour/tides/issues": [201, { number: 12, id: 9001, html_url: "https://github.test/harbour/tides/issues/12" }],
    "POST /repos/harbour/tides/issues/5/sub_issues": [500, { message: "boom" }],
  });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  const done = await host.write!.createWork!({ title: "Child", parent: { host: "github", kind: "work", id: "5" } });
  assert.equal(done.work.id, "12");
  assert.equal(done.linked, false);
  assert.match(done.problem ?? "", /Created #12 but could not link it under #5/);

  const g = fake({
    "GET /repos/harbour/tides/issues/12": [200, { number: 12, id: 9001, html_url: "https://github.test/harbour/tides/issues/12" }],
    "POST /repos/harbour/tides/issues/5/sub_issues": [201, { number: 5 }],
  });
  const again = createGitHubHost({ ...config, fetchImpl: g.fetchImpl, allowWrites: true });
  await again.write!.linkChild!({ host: "github", kind: "work", id: "5" }, done.work);
  assert.deepEqual(g.calls.map((call) => [call.method, call.path, call.body]), [
    ["GET", "/repos/harbour/tides/issues/12", undefined],
    ["POST", "/repos/harbour/tides/issues/5/sub_issues", { sub_issue_id: 9001 }],
  ]);

  // Already under that parent: nothing to do.
  const h = fake({ "GET /repos/harbour/tides/issues/12": [200, { number: 12, id: 9001, parent_issue_url: "https://api.github.test/repos/harbour/tides/issues/5" }] });
  const linked = createGitHubHost({ ...config, fetchImpl: h.fetchImpl, allowWrites: true });
  await linked.write!.linkChild!({ host: "github", kind: "work", id: "5" }, done.work);
  assert.deepEqual(h.calls.map((call) => call.method), ["GET"]);
});

test("createWork without a parent makes no link call", async () => {
  const f = fake({ "POST /repos/harbour/tides/issues": [201, { number: 12, id: 9001, html_url: "u" }] });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  await host.write!.createWork!({ title: "Alone" });
  assert.deepEqual(f.calls.map((call) => call.path), ["/repos/harbour/tides/issues"]);
});

test("setLabels does not hide an error other than a missing label", async () => {
  const f = fake({ "DELETE /repos/harbour/tides/issues/7/labels/ready": [500, { message: "boom" }] });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  await assert.rejects(host.write!.setLabels!({ host: "github", kind: "work", id: "7" }, [], ["ready"]), /500/);
});

test("createWork with labels makes the label first when the repository lacks it, then the issue carries it", async () => {
  const f = fake({
    "POST /repos/harbour/tides/labels": [201, { name: "ai-generated" }],
    "POST /repos/harbour/tides/issues": [201, { number: 13, id: 9002, html_url: "https://github.test/harbour/tides/issues/13" }],
  });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  await host.write!.createWork!({ title: "Made by an agent", labels: ["ai-generated"] });
  assert.deepEqual(f.calls.map((call) => [call.method, call.path]), [["POST", "/repos/harbour/tides/labels"], ["POST", "/repos/harbour/tides/issues"]]);
  assert.deepEqual(f.calls[1]!.body, { title: "Made by an agent", labels: ["ai-generated"] });
});

test("Backlog and To do (decision 120): a new issue is in Backlog without the label; To do gives it scopesoup:todo, and an edit moves it", async () => {
  const issue = (labels: string[]) => ({ number: 14, id: 9003, title: "Tide graph", state: "open", labels: labels.map((name) => ({ name })), assignees: [], updated_at: "2026-11-27T10:00:00Z", html_url: "u" });
  const f = fake({
    "POST /repos/harbour/tides/labels": [201, { name: "scopesoup:todo" }],
    "POST /repos/harbour/tides/issues": [201, { number: 14, id: 9003, html_url: "u" }],
    "GET /repos/harbour/tides/issues/14": [200, issue([])],
    "POST /repos/harbour/tides/issues/14/labels": [200, [{ name: "scopesoup:todo" }]],
  });
  const host = createGitHubHost({ ...config, fetchImpl: f.fetchImpl, allowWrites: true });
  await host.write!.createWork!({ title: "Tide graph" });
  assert.deepEqual(f.calls[0]!.body, { title: "Tide graph" });
  await host.write!.createWork!({ title: "Tide graph", lane: "todo" });
  assert.deepEqual(f.calls.slice(1).map((call) => [call.method, call.path]), [["POST", "/repos/harbour/tides/labels"], ["POST", "/repos/harbour/tides/issues"]]);
  assert.deepEqual(f.calls[2]!.body, { title: "Tide graph", labels: ["scopesoup:todo"] });
  f.calls.length = 0;
  // The re-read still lacks the label in this fake, so the edit says it was not applied: the add was sent.
  await assert.rejects(host.write!.editWork!({ host: "github", kind: "work", id: "14" }, { lane: "todo" }));
  assert.deepEqual(f.calls.find((call) => call.method === "POST" && call.path.endsWith("/14/labels"))?.body, { labels: ["scopesoup:todo"] });
});
