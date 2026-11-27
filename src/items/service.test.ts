// The item commands over the host ports: a real temporary meta ref for meta branch, a fake API for GitHub.
// All names and texts are synthetic.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import type { FetchLike } from "../hosts/github/client.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import type { BranchOnRemote } from "./remoteBranch.ts";
import { fixedBranches } from "./remoteBranch.ts";
import type { Backend } from "./service.ts";
import { createItem, detailsText, handBackItem, itemDetails, listItems, Refused, releaseItem, rowText, claimItem } from "./service.ts";

const repos: TestRepo[] = [];
const hosts: MetaBranchHost[] = [];
after(async () => {
  for (const host of hosts) await host.stop();
  for (const repo of repos) repo.cleanup();
});

const SHA = "a".repeat(40);
/** A remote where every item branch is pushed, one commit beyond main, at SHA. */
const pushed = (): BranchOnRemote => ({ state: "ready", sha: SHA, ahead: 1 });

/** One laptop's view of a project's meta ref: its own host and the commands as `who`. */
function meta(repo: TestRepo, machine: string, who: string, start = "2026-11-18T09:00:00Z"): { host: MetaBranchHost; backend: Backend; clock: { ms: number } } {
  const clock = { ms: Date.parse(start) };
  const host = createMetaBranchHost({
    repoDir: repo.dir, allowWrites: true, remote: null, person: { name: who, email: `${who}@example.invalid` }, machine, idPrefix: machine === "laptop-a" ? "A" : "B",
    now: () => new Date((clock.ms += 1000)).toISOString(),
  });
  hosts.push(host);
  const backend: Backend = { kind: "metaBranch", host: "metaBranch", machine, who, work: host.work, write: host.write!, now: () => new Date(clock.ms), mainBranch: "main", branches: fixedBranches(pushed) };
  return { host, backend, clock };
}

function project(): TestRepo {
  const repo = createTestRepo();
  repos.push(repo);
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  return repo;
}

describe("service", { concurrency: 4 }, () => {
test("metaBranch: file, claim, list, hand back and release, as lines in the item's log", async () => {
  const { backend, host } = meta(project(), "laptop-a", "Ada");
  const filed = await createItem(backend, { title: "Cache the tide table", body: "Keep it for an hour.", priority: "major" });
  assert.equal(filed.ref.id, "A-1");
  assert.deepEqual((await listItems(backend, { free: true })).map((row) => row.id), ["A-1"]);

  const taken = await claimItem(backend, "A-1", { from: "claude-code" });
  assert.match(taken.message, /Ada holds A-1/);
  const held = (await host.work.getWork({ host: "metaBranch", kind: "work", id: "A-1" }))!;
  assert.equal(held.holder?.actor.name, "Ada on laptop-a");
  assert.equal(held.holder?.actor.bot, undefined);
  const claim = held.log!.find((line) => line.kind === "claimed")!;
  assert.equal(claim.by.agent, false);
  assert.equal(claim.fields.from, "claude-code");
  // A person's hold is far ahead: no stall timer.
  assert.ok(Date.parse(String(claim.fields.until)) > Date.parse("2030-01-01T00:00:00Z"));
  assert.deepEqual((await listItems(backend, { mine: true })).map(rowText).map((text) => /held by Ada on laptop-a \(you\)/.test(text)), [true]);
  assert.deepEqual(await listItems(backend, { free: true }), []);

  const handed = await handBackItem(backend, "A-1", { note: "tests included" });
  assert.match(handed.message, /Handed back A-1 .* on scopesoup\/A-1 \(aaaaaaaaa\)/);
  const after = (await host.work.getWork({ host: "metaBranch", kind: "work", id: "A-1" }))!;
  assert.equal(after.holder, undefined);
  const revision = after.log!.find((line) => line.kind === "revision")!;
  assert.deepEqual({ ...revision.fields }, { sha: SHA, branch: "scopesoup/A-1", handback: true, note: "tests included" });
  assert.equal(revision.by.agent, false);
  // The claim moved it from Backlog to To do (decision 121): the `edited` line.
  assert.deepEqual(after.log!.map((line) => line.kind), ["created", "claimed", "edited", "revision", "released"]);
  assert.equal(after.backlog, undefined);

  // Taken again, then let go without a branch.
  await claimItem(backend, "A-1");
  await releaseItem(backend, "A-1", "not my area");
  const released = (await host.work.getWork({ host: "metaBranch", kind: "work", id: "A-1" }))!;
  assert.equal(released.holder, undefined);
  assert.match(String(released.log!.at(-1)!.fields.reason), /not my area/);
});

test("metaBranch: hand back reads the item's own branch from the remote; missing, empty or unreadable is refused and nothing is written", async () => {
  const { backend, host } = meta(project(), "laptop-a", "Ada");
  await createItem(backend, { title: "Cache the tide table", claim: true });
  const ref = { host: "metaBranch", kind: "work" as const, id: "A-1" };
  const lines = async () => (await host.work.getWork(ref))!.log!.map((line) => line.kind);
  const answers: Record<string, BranchOnRemote | Error> = {};
  const remote = fixedBranches((branch) => {
    const answer = answers[branch] ?? { state: "missing" };
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const on = { ...backend, branches: remote };
  await assert.rejects(handBackItem(on, "A-1"), (error: unknown) => error instanceof Refused && error.message === 'scopesoup/A-1 is not on origin. Push it with "git push origin scopesoup/A-1", then hand back.');
  answers["scopesoup/A-1"] = { state: "empty", sha: SHA };
  await assert.rejects(handBackItem(on, "A-1"), /scopesoup\/A-1 on origin has no commits beyond main: there is nothing to hand back/);
  answers["scopesoup/A-1"] = new Error("could not reach origin: no network");
  await assert.rejects(handBackItem(on, "A-1"), /scopesoup\/A-1 could not be read: could not reach origin: no network\./);
  const { branches: _none, ...without } = backend;
  await assert.rejects(handBackItem(without, "A-1"), /cannot read the project's remote here/);
  assert.deepEqual(await lines(), ["created", "claimed"]);
  assert.deepEqual(remote.fetched, ["scopesoup/A-1", "scopesoup/A-1", "scopesoup/A-1"]);
  // Pushed: its tip is the revision.
  const tip = "b".repeat(40);
  answers["scopesoup/A-1"] = { state: "ready", sha: tip, ahead: 2 };
  await handBackItem(on, "A-1");
  const revision = (await host.work.getWork(ref))!.log!.find((line) => line.kind === "revision")!;
  assert.deepEqual([revision.fields.sha, revision.fields.branch], [tip, "scopesoup/A-1"]);
});

test("metaBranch: an item an agent holds is refused, with the reason", async () => {
  const { backend, host } = meta(project(), "laptop-a", "Ada");
  await createItem(backend, { title: "Move the tide chart" });
  // The orchestrator's claim: an agent, until two hours ahead.
  await host.write!.appendLog!({ host: "metaBranch", kind: "work", id: "A-1" }, { kind: "claimed", by: { who: "scopesoup", agent: true }, fields: { until: "2026-11-18T11:00:00Z" } });
  await assert.rejects(claimItem(backend, "A-1"), (error) => error instanceof Refused && /held by scopesoup on laptop-a, an agent that is working on it/.test(error.message));
  // Nothing was written: the agent still holds it.
  const item = (await host.work.getWork({ host: "metaBranch", kind: "work", id: "A-1" }))!;
  assert.equal(item.holder?.actor.bot, true);
  assert.deepEqual(item.log!.map((line) => line.kind), ["created", "claimed"]);
  const rows = await listItems(backend);
  assert.equal(rows[0]?.holderKind, "agent");
  assert.equal(rows[0]?.free, false);
});

test("metaBranch: a claim that has run out no longer holds the item", async () => {
  const { backend, host, clock } = meta(project(), "laptop-a", "Ada");
  await createItem(backend, { title: "Chart the harbour" });
  await host.write!.appendLog!({ host: "metaBranch", kind: "work", id: "A-1" }, { kind: "claimed", by: { who: "scopesoup", agent: true }, fields: { until: "2026-11-18T09:30:00Z" } });
  clock.ms = Date.parse("2026-11-18T12:00:00Z");
  assert.equal((await listItems(backend, { free: true })).length, 1);
  await claimItem(backend, "A-1");
  assert.equal((await host.work.getWork({ host: "metaBranch", kind: "work", id: "A-1" }))!.holder?.actor.name, "Ada on laptop-a");
});

test("metaBranch: a person's hold has no stall timer: a passed until and a quiet year leave it held", async () => {
  const repo = project();
  const ada = meta(repo, "laptop-a", "Ada");
  const bo = meta(repo, "laptop-a", "Bo");
  await createItem(ada.backend, { title: "Survey the reef" });
  // A person's claimed line written by hand with a short until: it still never runs out.
  await ada.host.write!.appendLog!({ host: "metaBranch", kind: "work", id: "A-1" }, { kind: "claimed", by: { who: "Ada", agent: false }, fields: { until: "2026-11-18T09:30:00Z" } });
  bo.clock.ms = Date.parse("2027-11-18T12:00:00Z");
  assert.equal((await listItems(bo.backend, { free: true })).length, 0);
  await assert.rejects(claimItem(bo.backend, "A-1"), /held by Ada on laptop-a/);
});

test("metaBranch: another person's item cannot be taken or handed back; anyone releases it, and the log names both", async () => {
  const repo = project();
  const ada = meta(repo, "laptop-a", "Ada");
  const bo = meta(repo, "laptop-a", "Bo");
  await createItem(ada.backend, { title: "Sound the channel" });
  await claimItem(ada.backend, "A-1");
  // Both are on one machine here: the person is part of the claim's writer.
  bo.clock.ms = ada.clock.ms + 60_000;
  await assert.rejects(claimItem(bo.backend, "A-1"), /held by Ada on laptop-a\. Ask them, or release it first \(anyone may\): item release A-1/);
  await assert.rejects(handBackItem(bo.backend, "A-1"), /held by Ada on laptop-a, not by Bo/);
  const done = await releaseItem(bo.backend, "A-1", "Ada is away this week");
  assert.match(done.message, /Bo released Ada on laptop-a's hold on A-1/);
  const after = (await bo.host.work.getWork({ host: "metaBranch", kind: "work", id: "A-1" }))!;
  assert.equal(after.holder, undefined);
  const line = after.log!.at(-1)!;
  assert.deepEqual([line.kind, line.by.who, line.fields.of, line.fields.reason], ["released", "Bo", "Ada@laptop-a", "Ada is away this week"]);
  // Free again: Bo may claim it now.
  await claimItem(bo.backend, "A-1");
});

test("metaBranch: a person's hold is theirs from any machine: they see it as theirs, hand it back and release it from another laptop", async () => {
  const repo = project();
  const ada = meta(repo, "laptop-a", "Ada");
  const elsewhere = meta(repo, "laptop-b", "Ada");
  await createItem(ada.backend, { title: "Chart the reef" });
  await claimItem(ada.backend, "A-1");
  elsewhere.clock.ms = ada.clock.ms + 60_000;
  assert.match((await claimItem(elsewhere.backend, "A-1")).message, /already yours/);
  assert.deepEqual((await listItems(elsewhere.backend, { mine: true })).map((row) => row.id), ["A-1"]);
  await handBackItem(elsewhere.backend, "A-1");
  const ref = { host: "metaBranch", kind: "work" as const, id: "A-1" };
  assert.equal((await elsewhere.host.work.getWork(ref))!.holder, undefined);
  ada.clock.ms = elsewhere.clock.ms + 60_000;
  await claimItem(ada.backend, "A-1");
  elsewhere.clock.ms = ada.clock.ms + 60_000;
  const released = await releaseItem(elsewhere.backend, "A-1");
  assert.doesNotMatch(released.message, /hold on/);
  const after = (await elsewhere.host.work.getWork(ref))!;
  assert.equal(after.holder, undefined);
  assert.equal(after.log!.at(-1)!.fields.of, undefined);
});

test("metaBranch: a released line by someone else frees a person's hold only when it names the holder; an agent's claim is not released", async () => {
  const repo = project();
  const ada = meta(repo, "laptop-a", "Ada");
  const bo = meta(repo, "laptop-b", "Bo");
  await createItem(ada.backend, { title: "Paint the buoys" });
  await claimItem(ada.backend, "A-1");
  bo.clock.ms = ada.clock.ms + 60_000;
  const ref = { host: "metaBranch", kind: "work" as const, id: "A-1" };
  // A line by Bo that does not name Ada lets nothing go.
  await bo.backend.write.appendLog!(ref, { kind: "released", by: { who: "Bo", agent: false }, fields: { reason: "no of" } });
  assert.equal((await bo.host.work.getWork(ref))!.holder?.actor.id, "Ada@laptop-a");
  await bo.backend.write.appendLog!(ref, { kind: "released", by: { who: "Bo", agent: false }, fields: { reason: "wrong holder", of: "Cy@laptop-c" } });
  assert.equal((await bo.host.work.getWork(ref))!.holder?.actor.id, "Ada@laptop-a");
  await releaseItem(bo.backend, "A-1");
  assert.equal((await bo.host.work.getWork(ref))!.holder, undefined);
});

test("metaBranch: hand back and release need the hold; an item that is over is refused; the same claim twice is fine", async () => {
  const { backend } = meta(project(), "laptop-a", "Ada");
  await createItem(backend, { title: "Mark the buoy" });
  await assert.rejects(handBackItem(backend, "A-1"), /not held by anyone\. Claim it first/);
  await assert.rejects(releaseItem(backend, "A-1"), /not held by anyone/);
  await claimItem(backend, "A-1");
  assert.match((await claimItem(backend, "A-1")).message, /already yours/);
  await assert.rejects(claimItem(backend, "A-9"), /There is no item A-9/);
  await assert.rejects(claimItem(backend, "a b"), /not an item id/);
});

test("filing refuses an empty title and an unknown priority", async () => {
  const { backend } = meta(project(), "laptop-a", "Ada");
  await assert.rejects(createItem(backend, { title: "  " }), /Give the item a title/);
  await assert.rejects(createItem(backend, { title: "x", priority: "urgent" }), /priority must be one of/);
});

// --- GitHub, against a fake API ---

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(issues: Record<number, { title: string; assignees: string[]; state?: string }>) {
  const calls: Call[] = [];
  // Labels by issue or pull request number: the re-read after a label write shows them.
  const labels: Record<number, string[]> = {};
  const issueJson = (number: number) => {
    const issue = issues[number];
    if (!issue) return { number, labels: (labels[number] ?? []).map((name) => ({ name })) };
    return { number, title: issue.title, state: issue.state ?? "open", body: "", labels: (labels[number] ?? []).map((name) => ({ name })), assignees: issue.assignees.map((login) => ({ login, type: login.endsWith("[bot]") ? "Bot" : "User" })), html_url: `https://github.test/o/r/issues/${number}`, updated_at: "2026-11-18T09:00:00Z", created_at: "2026-11-18T08:00:00Z", user: { login: "owner" } };
  };
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.test", "");
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body });
    let status = 200;
    let json: unknown = {};
    const issue = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(path);
    if (method === "GET" && path === "/user") json = { login: "ada", name: "Ada", type: "User" };
    else if (method === "GET" && issue) json = issueJson(Number(issue[1]));
    else if (method === "GET" && path.startsWith("/repos/o/r/issues?")) json = Object.keys(issues).map((number) => issueJson(Number(number)));
    else if (method === "POST" && path === "/repos/o/r/issues") {
      const number = Object.keys(issues).length + 1;
      issues[number] = { title: String(body?.title), assignees: [] };
      status = 201;
      json = issueJson(number);
    } else if (method === "POST" && /\/assignees$/.test(path)) {
      const number = Number(/issues\/(\d+)\//.exec(path)![1]);
      issues[number]!.assignees.push(...((body?.assignees as string[]) ?? []));
      status = 201;
    } else if (method === "DELETE" && /\/assignees$/.test(path)) {
      const number = Number(/issues\/(\d+)\//.exec(path)![1]);
      issues[number]!.assignees = issues[number]!.assignees.filter((login) => !(body?.assignees as string[]).includes(login));
    } else if (method === "GET" && path.startsWith("/repos/o/r/pulls?")) json = [];
    else if (method === "POST" && path === "/repos/o/r/pulls") {
      status = 201;
      json = { number: 41, html_url: "https://github.test/o/r/pull/41" };
    } else if (method === "POST" && path === "/repos/o/r/labels") {
      status = 201;
      json = body;
    } else if (method === "POST" && /\/labels$/.test(path)) {
      const number = Number(/issues\/(\d+)\//.exec(path)![1]);
      labels[number] = [...(labels[number] ?? []), ...((body?.labels as string[]) ?? [])];
      json = [];
    }
    else if (method === "POST" && /\/comments$/.test(path)) status = 201;
    else {
      status = 404;
      json = { message: "not found" };
    }
    return { status, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { calls, fetchImpl };
}

async function github(issues: Record<number, { title: string; assignees: string[] }>) {
  const api = fakeApi(issues);
  const host = createGitHubHost({ token: "test-token", repo: "o/r", apiUrl: "https://api.github.test", fetchImpl: api.fetchImpl, allowWrites: true });
  const login = (await host.info.whoami()).id;
  const backend: Backend = { kind: "github", host: "github", who: login, work: host.work, write: host.write!, now: () => new Date("2026-11-18T10:00:00Z"), mainBranch: "main", branches: fixedBranches(pushed) };
  return { api, backend };
}

test("github: new creates an issue; claim assigns the token's user; release unassigns", async () => {
  const { api, backend } = await github({ 1: { title: "Existing", assignees: [] } });
  const filed = await createItem(backend, { title: "Tune the buoy lights", body: "Dim at dusk.", priority: "minor" });
  assert.equal(filed.ref.id, "2");
  assert.match(filed.message, /GitHub has no priority field/);
  assert.deepEqual(api.calls.find((call) => call.method === "POST" && call.path === "/repos/o/r/issues")!.body, { title: "Tune the buoy lights", body: "Dim at dusk." });

  // In Backlog (no scopesoup:todo label): the claim moves it to To do (decision 121).
  assert.match((await claimItem(backend, "#2")).message, /ada holds 2 .*It moved from Backlog to To do\./);
  assert.deepEqual(api.calls.find((call) => call.method === "POST" && call.path === "/repos/o/r/issues/2/labels")!.body, { labels: ["scopesoup:todo"] });
  assert.deepEqual(api.calls.find((call) => call.path === "/repos/o/r/issues/2/assignees")!.body, { assignees: ["ada"] });
  assert.deepEqual((await listItems(backend, { mine: true })).map((row) => row.id), ["2"]);
  assert.deepEqual((await listItems(backend, { free: true })).map((row) => row.id), ["1"]);

  await releaseItem(backend, "2", "later");
  const removed = api.calls.find((call) => call.method === "DELETE")!;
  assert.deepEqual(removed.body, { assignees: ["ada"] });
  assert.ok(api.calls.some((call) => call.path === "/repos/o/r/issues/2/comments"));
});

test("github: anyone releases another person's assignment, and a comment names both", async () => {
  const { api, backend } = await github({ 1: { title: "Held by a person", assignees: ["bo"] }, 2: { title: "Held by an app", assignees: ["scopesoup-app[bot]"] } });
  assert.match((await releaseItem(backend, "1")).message, /ada released bo's hold on 1/);
  assert.deepEqual(api.calls.find((call) => call.method === "DELETE")!.body, { assignees: ["bo"] });
  const comment = api.calls.find((call) => call.method === "POST" && call.path === "/repos/o/r/issues/1/comments")!;
  assert.match(String((comment.body as { body: string }).body), /Released by ada, held by bo\./);
  await assert.rejects(releaseItem(backend, "2"), /an agent that is working on it/);
});

test("github: list --search and show read the issues through the same backend", async () => {
  const { backend } = await github({ 1: { title: "Tune the buoy lights", assignees: [] }, 2: { title: "Wind arrows", assignees: ["bo"] } });
  assert.deepEqual((await listItems(backend, { search: "BUOY" })).map((row) => row.id), ["1"]);
  assert.deepEqual((await listItems(backend, { search: "#2" })).map((row) => row.id), ["2"]);
  const shown = await itemDetails(backend, "#2");
  assert.equal(shown.holder, "bo");
  assert.match(detailsText(shown), /^2 Wind arrows\nState: \w+\nHeld by: bo\nLink: https:\/\/github\.test\/o\/r\/issues\/2\n\n\(no description\)$/);
  await assert.rejects(itemDetails(backend, "A-1"), /not an issue number/);
});

test("github: claim is refused when someone else is assigned, an agent most plainly", async () => {
  const { backend } = await github({ 1: { title: "Held by a person", assignees: ["bo"] }, 2: { title: "Held by an app", assignees: ["scopesoup-app[bot]"] } });
  await assert.rejects(claimItem(backend, "1"), /held by bo\. Ask them, or release it first/);
  await assert.rejects(claimItem(backend, "2"), /an agent that is working on it/);
  await assert.rejects(claimItem(backend, "x1"), /not an issue number/);
});

test("github: hand back opens the pull request, labels it for Scope Soup's review and unassigns", async () => {
  const { api, backend } = await github({ 7: { title: "Cache tide data", assignees: ["ada"] } });
  const handed = await handBackItem(backend, "7", { note: "ready" });
  assert.equal(handed.change?.id, "41");
  const opened = api.calls.find((call) => call.method === "POST" && call.path === "/repos/o/r/pulls")!;
  assert.equal((opened.body as { head: string }).head, "scopesoup/7");
  assert.equal((opened.body as { base: string }).base, "main");
  assert.match((opened.body as { body: string }).body, /ready[\s\S]*Closes #7/);
  assert.deepEqual(api.calls.find((call) => call.path === "/repos/o/r/issues/41/labels")!.body, { labels: ["scopesoup:review"] });
  assert.deepEqual(api.calls.find((call) => call.method === "DELETE")!.body, { assignees: ["ada"] });
  // Not the holder: refused before anything is sent.
  const other = await github({ 8: { title: "Not mine", assignees: [] } });
  await assert.rejects(handBackItem(other.backend, "8"), /not held by anyone/);
  assert.equal(other.api.calls.some((call) => call.method === "POST"), false);
});
});
