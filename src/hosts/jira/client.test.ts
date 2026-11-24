import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiraClient, JiraError, transient } from "./client.ts";
import { FAKE_DC_SITE, FAKE_SITE, fakeJira } from "./fakeJira.ts";
import { CLOUD_EMAIL, CLOUD_ROBIN, cloudIssues, DC_ROBIN, dcIssues, TOKEN } from "./fixtures.ts";

const cloudFake = (pageSize?: number) => fakeJira({ deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, user: CLOUD_ROBIN, issues: cloudIssues(), ...(pageSize ? { pageSize } : {}) });
const dcFake = (pageSize?: number) => fakeJira({ deployment: "datacenter", token: TOKEN, user: DC_ROBIN, issues: dcIssues(), ...(pageSize ? { pageSize } : {}) });

test("Cloud sends Basic authentication of email and API token to /rest/api/3", async () => {
  const fake = cloudFake();
  const client = createJiraClient({ site: `${FAKE_SITE}/`, deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, fetchImpl: fake.fetch });
  assert.deepEqual(await client.get(`${client.api}/myself`), CLOUD_ROBIN);
  const sent = fake.calls[0];
  assert.equal(sent?.path, "/rest/api/3/myself");
  assert.equal(sent?.headers.Authorization, `Basic ${Buffer.from(`${CLOUD_EMAIL}:${TOKEN}`).toString("base64")}`);
  assert.equal(sent?.headers.Accept, "application/json");
  assert.ok(sent?.headers["User-Agent"]);
});

test("Data Center sends the personal access token as Bearer to /rest/api/2", async () => {
  const fake = dcFake();
  const client = createJiraClient({ site: FAKE_DC_SITE, deployment: "datacenter", token: TOKEN, fetchImpl: fake.fetch });
  assert.deepEqual(await client.get(`${client.api}/myself`), DC_ROBIN);
  assert.equal(fake.calls[0]?.path, "/rest/api/2/myself");
  assert.equal(fake.calls[0]?.headers.Authorization, `Bearer ${TOKEN}`);
});

test("Cloud without an email is refused before any request", () => {
  assert.throws(() => createJiraClient({ site: FAKE_SITE, deployment: "cloud", token: TOKEN }), /email/);
});

test("a refused token is a 401 that says it may have expired, and never shows the token", async () => {
  const fake = fakeJira({ deployment: "cloud", token: "another", email: CLOUD_EMAIL, user: CLOUD_ROBIN });
  const client = createJiraClient({ site: FAKE_SITE, deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, fetchImpl: fake.fetch });
  await assert.rejects(client.get("/rest/api/3/myself"), (error: unknown) => {
    assert.ok(error instanceof JiraError && error.status === 401);
    assert.match(error.message, /may have expired/);
    assert.ok(!error.message.includes(TOKEN));
    assert.equal(transient(error), false);
    return true;
  });
});

test("Jira's error body is read into the message", async () => {
  const fake = cloudFake();
  const client = createJiraClient({ site: FAKE_SITE, deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, fetchImpl: fake.fetch });
  await assert.rejects(client.get("/rest/api/3/issue/DEMO-99"), /Jira 404 on \/rest\/api\/3\/issue\/DEMO-99: Issue does not exist/);
});

test("Cloud search pages by nextPageToken until the last page", async () => {
  const fake = cloudFake(2);
  const client = createJiraClient({ site: FAKE_SITE, deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, fetchImpl: fake.fetch });
  const found = await client.search<{ key: string }>('project = "DEMO" ORDER BY updated ASC, key ASC', ["summary"]);
  assert.deepEqual(found.map((issue) => issue.key), ["DEMO-6", "DEMO-4", "DEMO-1", "DEMO-2", "DEMO-3", "DEMO-5"]);
  assert.deepEqual(fake.calls.map((call) => (call.body as { nextPageToken?: string }).nextPageToken ?? null), [null, "2", "4"]);
  assert.ok(fake.calls.every((call) => call.method === "POST" && call.path === "/rest/api/3/search/jql"));
});

test("Data Center search pages by startAt until total", async () => {
  const fake = dcFake(4);
  const client = createJiraClient({ site: FAKE_DC_SITE, deployment: "datacenter", token: TOKEN, fetchImpl: fake.fetch });
  const found = await client.search<{ key: string }>('project = "DEMO" ORDER BY updated ASC, key ASC', ["summary"]);
  assert.equal(found.length, 6);
  assert.deepEqual(fake.calls.map((call) => new URL(`${FAKE_DC_SITE}${call.path}`).searchParams.get("startAt")), ["0", "4"]);
});

test("a 429 is waited out as Retry-After says and tried again", async () => {
  const fake = cloudFake();
  const waits: number[] = [];
  const client = createJiraClient({ site: FAKE_SITE, deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, fetchImpl: fake.fetch, sleep: async (ms) => void waits.push(ms) });
  fake.limit(2, { "Retry-After": "3", "RateLimit-Reason": "jira-burst-based" });
  assert.deepEqual(await client.get("/rest/api/3/myself"), CLOUD_ROBIN);
  assert.deepEqual(fake.calls.map((call) => call.status), [429, 429, 200]);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((ms) => ms >= 3000 && ms < 3500));
  assert.deepEqual(client.stats(), { sent: 3, retried: 2 });
});

test("a 429 after the last try, or with a long Retry-After, holds every request until it is over", async () => {
  let clock = 1_000_000;
  const fake = cloudFake();
  const client = createJiraClient({ site: FAKE_SITE, deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, fetchImpl: fake.fetch, now: () => clock, sleep: async () => {} });
  fake.limit(1, { "Retry-After": "120", "RateLimit-Reason": "jira-quota-tenant-based" });
  await assert.rejects(client.get("/rest/api/3/myself"), (error: unknown) => {
    assert.ok(error instanceof JiraError && error.rateLimited && transient(error));
    assert.match(error.message, /jira-quota-tenant-based/);
    return true;
  });
  await assert.rejects(client.get("/rest/api/3/myself"), /rate limited until/);
  assert.equal(fake.calls.length, 1);
  clock += 121_000;
  assert.deepEqual(await client.get("/rest/api/3/myself"), CLOUD_ROBIN);

  fake.limit(4, { "Retry-After": "1" });
  await assert.rejects(client.get("/rest/api/3/myself"), (error: unknown) => error instanceof JiraError && error.status === 429);
  assert.equal(fake.calls.filter((call) => call.status === 429).length, 5);
});

test("a 5xx and a failed fetch can change by themselves; a 400, 403 or 404 cannot", () => {
  assert.equal(transient(new JiraError(503, "/x", "")), true);
  assert.equal(transient(new TypeError("fetch failed")), true);
  for (const status of [400, 403, 404]) assert.equal(transient(new JiraError(status, "/x", "")), false);
});
