import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubError, createClient, transient } from "./client.ts";
import { FAKE_API, fakeGitHub } from "./fakeFetch.ts";

const make = (fake: ReturnType<typeof fakeGitHub>, now = () => 1_000_000) =>
  createClient({ token: "t-synthetic", repo: "acme/widgets", fetchImpl: fake.fetch, apiUrl: FAKE_API, now });

test("sends the API version, the token and a user agent", async () => {
  const fake = fakeGitHub({ "/user": { body: { login: "robin" } } });
  await make(fake).get("/user");
  const sent = fake.calls[0]?.headers ?? {};
  assert.equal(sent["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(sent.Accept, "application/vnd.github+json");
  assert.equal(sent.Authorization, "Bearer t-synthetic");
  assert.ok(sent["User-Agent"]);
});

test("follows Link rel=next and stops at max", async () => {
  const fake = fakeGitHub({
    "/things?per_page=2": { body: [1, 2], next: "/things?per_page=2&page=2" },
    "/things?per_page=2&page=2": { body: [3, 4], next: "/things?per_page=2&page=3" },
    "/things?per_page=2&page=3": { body: [5] },
  });
  const client = make(fake);
  assert.deepEqual((await client.list<number>("/things?per_page=2")).data, [1, 2, 3, 4, 5]);
  fake.take();
  assert.deepEqual((await client.list<number>("/things?per_page=2", { max: 3 })).data, [1, 2, 3]);
  assert.equal(fake.take().length, 2);
});

test("reads wrapped lists by key", async () => {
  const fake = fakeGitHub({ "/runs": { body: { total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] } } });
  assert.deepEqual((await make(fake).list("/runs", { key: "workflow_runs" })).data, [{ id: 1 }, { id: 2 }]);
});

test("a second request is conditional; a 304 is free, unchanged and returns the cached data", async () => {
  const fake = fakeGitHub({
    "/things": { body: [1], next: "/things?page=2" },
    "/things?page=2": { body: [2] },
  });
  const client = make(fake);
  const first = await client.list<number>("/things");
  assert.equal(first.unchanged, false);
  assert.equal(fake.remaining, 4998);

  const second = await client.list<number>("/things");
  assert.deepEqual(second, { data: [1, 2], unchanged: true });
  assert.equal(fake.remaining, 4998);
  assert.deepEqual(fake.calls.slice(2).map((call) => call.status), [304, 304]);
  assert.ok(fake.calls[2]?.headers["If-None-Match"]);
  assert.deepEqual(client.stats(), { sent: 4, notModified: 2 });

  fake.set("/things?page=2", [2, 3]);
  const third = await client.list<number>("/things");
  assert.deepEqual(third, { data: [1, 2, 3], unchanged: false });
});

test("reports the budget from the response headers", async () => {
  const fake = fakeGitHub({ "/user": { body: {} } });
  const client = make(fake);
  assert.equal(client.budget(), null);
  await client.get("/user");
  assert.deepEqual(client.budget(), { remaining: 4999, resetAt: new Date(1795000000 * 1000).toISOString() });
});

test("an error carries the status and never the token", async () => {
  const client = make(fakeGitHub());
  await assert.rejects(client.get("/missing"), (error: unknown) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 404);
    assert.ok(!error.message.includes("t-synthetic"));
    return true;
  });
});

test("after a rate-limit answer no request is sent until the wait is over", async () => {
  let clock = 1_000_000;
  const fake = fakeGitHub({ "/user": { status: 403, body: { message: "secondary rate limit" }, headers: { "Retry-After": "60" } } });
  const client = make(fake, () => clock);
  await assert.rejects(client.get("/user"), /403/);
  await assert.rejects(client.get("/user"), /rate limited until/);
  assert.equal(fake.calls.length, 1);
  clock += 61_000;
  fake.set("/user", { body: { login: "robin" } });
  assert.deepEqual((await client.get("/user")).data, { login: "robin" });
});

test("a secondary limit with no retry-after holds requests a minute; a 403 for missing rights holds nothing and is no rate limit", async () => {
  let clock = 1_000_000;
  const fake = fakeGitHub({
    "/repos/acme/widgets/issues/1/comments": { status: 403, body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." } },
    "/repos/acme/widgets/issues/2/comments": { status: 403, body: { message: "Resource not accessible by personal access token" } },
  });
  const client = make(fake, () => clock);
  await assert.rejects(client.send("POST", "/repos/acme/widgets/issues/2/comments", { body: "Hi" }), (error: unknown) => {
    assert.ok(error instanceof GitHubError && !error.rateLimited && !transient(error));
    return true;
  });
  await assert.rejects(client.send("POST", "/repos/acme/widgets/issues/1/comments", { body: "Hi" }), (error: unknown) => {
    assert.ok(error instanceof GitHubError && error.rateLimited && transient(error));
    return true;
  });
  await assert.rejects(client.get("/user"), /rate limited until/);
  assert.equal(fake.calls.length, 2);
  clock += 61_000;
  fake.set("/user", { body: { login: "robin" } });
  assert.deepEqual((await client.get("/user")).data, { login: "robin" });
});

test("a 5xx, a 429 and a failed fetch can change by themselves; a 404 or 422 cannot", () => {
  assert.equal(transient(new GitHubError(502, "/x", "Bad Gateway")), true);
  assert.equal(transient(new GitHubError(429, "/x", "")), true);
  assert.equal(transient(new TypeError("fetch failed")), true);
  assert.equal(transient(new GitHubError(404, "/x", "")), false);
  assert.equal(transient(new GitHubError(422, "/x", "Validation Failed")), false);
  assert.equal(transient(new TypeError("Cannot read properties of undefined")), false);
});

test("a 301 asked not to be followed is an error with where it points", async () => {
  const fake = fakeGitHub({ "/repos/acme/widgets/issues/7": { status: 301, body: { message: "Moved Permanently" }, headers: { Location: "https://api.github.test/repositories/9/issues/3" } } });
  await assert.rejects(make(fake).get("/repos/acme/widgets/issues/7", { noRedirect: true }), (error: unknown) => {
    assert.ok(error instanceof GitHubError && error.status === 301);
    assert.equal(error.location, "https://api.github.test/repositories/9/issues/3");
    return true;
  });
});
