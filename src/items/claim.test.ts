// `item new --claim`: the item is created already held, in one write, so Scope Soup cannot pick it up
// between the create and the claim. And a handed-back item is "in review" in the list, not "free".
// A real temporary meta ref for meta branch, a fake API for GitHub. Synthetic data.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import type { FetchLike } from "../hosts/github/client.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import { readyItems } from "../orchestrator/candidates.ts";
import { fixedBranches } from "./remoteBranch.ts";
import type { Backend } from "./service.ts";
import { createItem, handBackItem, listItems, rowText, claimItem } from "./service.ts";

const repos: TestRepo[] = [];
const hosts: MetaBranchHost[] = [];
after(async () => {
  for (const host of hosts) await host.stop();
  for (const repo of repos) repo.cleanup();
});

function meta(): { repo: TestRepo; host: MetaBranchHost; backend: Backend } {
  const repo = createTestRepo();
  repos.push(repo);
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  let ms = Date.parse("2026-11-20T09:00:00Z");
  const now = () => new Date((ms += 1000));
  const host = createMetaBranchHost({ repoDir: repo.dir, allowWrites: true, remote: null, person: { name: "Ada", email: "ada@example.invalid" }, machine: "laptop-a", idPrefix: "A", now: () => now().toISOString() });
  hosts.push(host);
  return { repo, host, backend: { kind: "metaBranch", host: "metaBranch", machine: "laptop-a", who: "Ada", work: host.work, write: host.write!, now, mainBranch: "main", branches: fixedBranches(() => ({ state: "ready", sha: "a".repeat(40), ahead: 1 })) } };
}

const META_REF = "refs/scopesoup/meta";

describe("claim", { concurrency: 4 }, () => {
test("metaBranch: new --claim is one commit that holds the item from its first state", async () => {
  const { repo, host, backend } = meta();
  const made = await createItem(backend, { title: "Cache the tide table", claim: true, from: "claude-code" });
  assert.match(made.message, /Filed A-1: Cache the tide table\. Note: Ada holds it/);
  // The meta ref has exactly one commit, and it already holds the item, its `created` line and the claim.
  assert.equal(repo.git(["rev-list", "--count", META_REF]), "1");
  const log = repo.git(["cat-file", "-p", `${META_REF}:items/A-1/log.jsonl`]).split("\n").map((line) => JSON.parse(line) as { kind: string; by: { who: string; agent: boolean }; from?: string; until?: string });
  assert.deepEqual(log.map((line) => line.kind), ["created", "claimed"]);
  assert.equal(log[1]!.by.agent, false);
  assert.equal(log[1]!.from, "claude-code");
  // So the first thing any tick can read is an item a person holds: it is not ready to start.
  const item = (await host.work.getWork({ host: "metaBranch", kind: "work", id: "A-1" }))!;
  assert.equal(item.holder?.actor.name, "Ada on laptop-a");
  const readiness = readyItems([item], [], {}, "2026-11-20T09:05:00Z");
  assert.deepEqual(readiness.ready, []);
  assert.match(readiness.held[0]!.reason, /held by Ada on laptop-a/);
  // Without --claim the item is free and the same single commit holds `created`.
  await createItem(backend, { title: "Chart the harbour" });
  assert.equal(repo.git(["rev-list", "--count", META_REF]), "2");
  const free = readyItems([(await host.work.getWork({ host: "metaBranch", kind: "work", id: "A-2" }))!], [], {}, "2026-11-20T09:05:00Z");
  assert.equal(free.ready.length, 1);
});

test("metaBranch: list shows a handed-back item as in review, not free", async () => {
  const { backend } = meta();
  await createItem(backend, { title: "Mark the buoy", claim: true });
  await createItem(backend, { title: "Sound the channel" });
  await handBackItem(backend, "A-1");
  const rows = await listItems(backend);
  assert.deepEqual(rows.map((row) => [row.id, row.free, row.inReview ?? false]), [["A-1", false, true], ["A-2", true, false]]);
  assert.match(rowText(rows[0]!), /in review/);
  assert.deepEqual((await listItems(backend, { free: true })).map((row) => row.id), ["A-2"]);
  // It can still be taken (it is nobody's), and then it is held.
  assert.match((await claimItem(backend, "A-1")).message, /Ada holds A-1/);
});

test("github: new --claim creates the issue with the assignee set in the create call", async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.test", "");
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    const json = method === "GET" && path === "/user" ? { login: "ada", type: "User" } : { number: 5, html_url: "https://github.test/o/r/issues/5" };
    return { status: method === "POST" ? 201 : 200, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) };
  };
  const host = createGitHubHost({ token: "test-token", repo: "o/r", apiUrl: "https://api.github.test", fetchImpl, allowWrites: true });
  const backend: Backend = { kind: "github", host: "github", who: (await host.info.whoami()).id, work: host.work, write: host.write!, now: () => new Date("2026-11-20T10:00:00Z"), mainBranch: "main" };
  const made = await createItem(backend, { title: "Tune the buoy lights", claim: true });
  assert.match(made.message, /Filed 5: .*ada holds it/);
  const creates = calls.filter((call) => call.method === "POST");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0]!.body, { title: "Tune the buoy lights", assignees: ["ada"] });
});
});
