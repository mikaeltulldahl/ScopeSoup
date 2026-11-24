import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSnapshot } from "../server/snapshot.ts";
import { openStore } from "../store/store.ts";
import { createSync } from "./sync.ts";
import { createJiraHost } from "../hosts/jira/adapter.ts";
import { FAKE_SITE, fakeJira } from "../hosts/jira/fakeJira.ts";
import { CLOUD_EMAIL, CLOUD_ROBIN, cloudIssues, TOKEN } from "../hosts/jira/fixtures.ts";

test("a Jira project's Items reach the board's snapshot through the sync, and a later change comes in from the cursor", async () => {
  const fake = fakeJira({ deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, user: CLOUD_ROBIN, issues: cloudIssues() });
  const host = createJiraHost({ site: FAKE_SITE, project: "DEMO", deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, fetchImpl: fake.fetch });
  const store = openStore(":memory:");
  let clock = Date.parse("2026-11-20T12:00:00Z");
  const sync = createSync({ store, hosts: [host], intervalMs: 1000, now: () => new Date((clock += 1000)), setTimer: () => () => {} });
  await sync.refreshNow();
  const works = () => new Map(loadSnapshot(store).works.map((item) => [item.ref.id, item]));
  assert.deepEqual([...works().keys()].sort(), ["DEMO-1", "DEMO-2", "DEMO-3", "DEMO-5"]);
  assert.equal(works().get("DEMO-2")?.blockedBy[0]?.id, "DEMO-3");

  // DEMO-3 is closed on Jira: the next listing (from the cursor) brings it as done.
  const three = fake.issues.get("DEMO-3");
  assert.ok(three);
  three.fields.status = { name: "Done", statusCategory: { key: "done", name: "Done" } };
  three.fields.updated = "2026-11-20T11:30:00.000+0000";
  await sync.refreshNow();
  assert.equal(works().get("DEMO-3")?.state, "done");
});
