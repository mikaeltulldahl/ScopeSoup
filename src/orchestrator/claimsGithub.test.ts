// Claims on GitHub: a claim comment plus the `scopesoup:claimed` label, no assignee. Two Scope Soup instances (two machines, one
// token) run the real adapter and host actions on one fake repository. All names are synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { createGitHubHost } from "../hosts/github/adapter.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import type { FakeIssues } from "../hosts/github/fakeIssues.ts";
import type { Ref } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import { createHostActions } from "./hostActions.ts";

const R = "/repos/harbour/tides/issues";
const ONE: Ref = { host: "github", kind: "work", id: "1" };
const config = (() => {
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
})();

function instance(fake: FakeIssues, machine: string) {
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true, login: "scopesoup-bot", machine, now: () => Date.parse(fake.clock) });
  const store = openStore(":memory:");
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => config, store });
  return { host, store, actions };
}

const at = (fake: FakeIssues): string => fake.clock;
const inMinutes = (fake: FakeIssues, minutes: number): string => new Date(Date.parse(fake.clock) + minutes * 60_000).toISOString();
const claimComments = (fake: FakeIssues) => (fake.comments.get("1") ?? []).filter((comment) => readMarker(comment.body)?.kind === "claim");
const labels = (fake: FakeIssues): string[] => fake.issues.get("1")!.labels.map((label) => (typeof label === "string" ? label : label.name));

test("two instances claim at once: only the lower comment id starts; the other releases its comment and does not start", async () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const a = instance(fake, "laptop-a");
  const b = instance(fake, "laptop-b");
  assert.equal(a.actions.claimant, "scopesoup@laptop-a");
  // Claims are written with no switch; the configuration has no rules at all.
  assert.equal(a.actions.claims, true);
  const until = inMinutes(fake, 120);
  const [wonA, wonB] = await Promise.all([a.actions.claim(ONE, until, at(fake)), b.actions.claim(ONE, until, at(fake))]);

  const comments = claimComments(fake);
  assert.equal(comments.length, 2, "both instances posted a claim comment");
  const [lower, higher] = comments as [(typeof comments)[0], (typeof comments)[0]];
  const lowerMachine = readMarker(lower.body)!.data.machine;
  assert.deepEqual(readMarker(lower.body)!.data, { v: 1, machine: lowerMachine, until, released: false });
  assert.match(lower.body ?? "", new RegExp(`^Scope Soup \\(${lowerMachine}\\) works on this until ${until.slice(11, 16)} UTC\\.`));
  assert.equal(readMarker(higher.body)!.data.released, true);
  assert.match(higher.body ?? "", /^Released: Scope Soup/);
  const winner = lowerMachine === "laptop-a" ? wonA : wonB;
  const loser = lowerMachine === "laptop-a" ? wonB : wonA;
  assert.deepEqual(winner, { won: true });
  assert.deepEqual(loser, { won: false, why: `scopesoup on ${lowerMachine} claimed it first` });
  // The label stays for the winner, and nobody is assigned.
  assert.deepEqual(labels(fake), ["scopesoup:claimed"]);
  assert.deepEqual(fake.issues.get("1")!.assignees, []);

  // Both read it as doing, held by the winner's machine until `until`.
  for (const each of [a, b]) {
    const item = (await each.host.work.getWork(ONE))!;
    assert.equal(item.state, "doing");
    assert.deepEqual(item.holder, { actor: { id: `scopesoup@${lowerMachine}`, name: `scopesoup on ${lowerMachine}`, bot: true }, until });
  }
});

test("an expired claim counts as no claim: the next instance removes its stale label, and the other instance can claim the Item", async () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const a = instance(fake, "laptop-a");
  const b = instance(fake, "laptop-b");
  const until = inMinutes(fake, 30);
  assert.deepEqual(await a.actions.claim(ONE, until, at(fake)), { won: true });
  // While it is live, the other instance does not take it, and writes nothing.
  fake.clear();
  assert.deepEqual(await b.actions.claim(ONE, inMinutes(fake, 120), at(fake)), { won: false, why: "held by scopesoup on laptop-a" });
  assert.equal(fake.calls.some((call) => !call.startsWith("GET")), false);

  // laptop-a stops (no renewal); its claim runs out.
  fake.clock = new Date(Date.parse(until) + 60_000).toISOString().replace(".000Z", "Z");
  fake.clear();
  const seen = (await b.host.work.listWork()).items.find((item) => item.ref.id === "1")!;
  assert.deepEqual([seen.state, seen.holder, seen.labels], ["todo", undefined, []]);
  assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET")), [`DELETE ${R}/1/labels/scopesoup%3Aclaimed`]);
  assert.deepEqual(labels(fake), []);

  const later = inMinutes(fake, 120);
  assert.deepEqual(await b.actions.claim(ONE, later, at(fake)), { won: true });
  const item = (await a.host.work.getWork(ONE))!;
  assert.deepEqual([item.state, item.holder?.actor.id, item.holder?.until], ["doing", "scopesoup@laptop-b", later]);
  assert.deepEqual(labels(fake), ["scopesoup:claimed"]);
  assert.equal(claimComments(fake).length, 2);
});

test("a release edits the claim comment to released and removes the label; a renewal edits the same comment", async () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const a = instance(fake, "laptop-a");
  assert.deepEqual(await a.actions.claim(ONE, inMinutes(fake, 120), at(fake)), { won: true });
  const id = claimComments(fake)[0]!.id;

  // Renew: one PATCH of the claim comment, nothing posted, the label left as it is.
  fake.clear();
  const renewed = inMinutes(fake, 180);
  assert.deepEqual(await a.actions.claim(ONE, renewed, at(fake)), { won: true });
  assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET")), [`PATCH ${R}/comments/${id}`]);
  assert.equal(readMarker(claimComments(fake)[0]!.body)!.data.until, renewed);
  assert.equal(a.store.get<{ holder?: { until?: string } }>(ONE)?.holder?.until, renewed, "the re-read went into the store");

  fake.clear();
  await a.actions.release(ONE, "blocked by #2");
  assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET")), [`PATCH ${R}/comments/${id}`, `DELETE ${R}/1/labels/scopesoup%3Aclaimed`]);
  const comment = claimComments(fake)[0]!;
  assert.match(comment.body ?? "", /^Released: Scope Soup \(laptop-a\) no longer works on this\./);
  assert.deepEqual(readMarker(comment.body)!.data, { v: 1, machine: "laptop-a", until: renewed, released: true });
  assert.deepEqual(labels(fake), []);
  const item = (await a.host.work.getWork(ONE))!;
  assert.deepEqual([item.state, item.holder], ["todo", undefined]);
});

test("after a store loss, this machine's live claim is its own: claiming again renews that comment", async () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const before = instance(fake, "laptop-a");
  assert.deepEqual(await before.actions.claim(ONE, inMinutes(fake, 120), at(fake)), { won: true });
  // A new store on the same machine.
  const after = instance(fake, "laptop-a");
  const item = (await after.host.work.getWork(ONE))!;
  assert.equal(item.holder?.actor.id, after.actions.claimant);
  assert.deepEqual(await after.actions.claim(ONE, inMinutes(fake, 120), at(fake)), { won: true });
  assert.equal(claimComments(fake).length, 1);
});

test("a person's hold is the assignee and has no expiry; an agent's claim has one; Scope Soup does not claim over a person", async () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const a = instance(fake, "laptop-a");
  fake.issues.get("1")!.assignees = [{ login: "harbour-dev" }] as never;
  const held = (await a.host.work.getWork(ONE))!;
  assert.deepEqual([held.state, held.holder?.actor.id, held.holder?.until, held.holder?.actor.bot], ["doing", "harbour-dev", undefined, undefined]);
  fake.clear();
  assert.deepEqual(await a.actions.claim(ONE, inMinutes(fake, 120), at(fake)), { won: false, why: "held by harbour-dev" });
  assert.equal(fake.calls.some((call) => !call.startsWith("GET")), false);
  assert.equal(claimComments(fake).length, 0);
});

test("without a machine name or writes, the GitHub host makes no claims", () => {
  const fake = fakeIssues("harbour/tides", [1]);
  const noMachine = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true, conventions: true });
  assert.equal(noMachine.write?.claim, undefined);
  assert.equal(noMachine.info.claimMachine, undefined);
  const readOnly = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, conventions: true, machine: "laptop-a" });
  assert.equal(readOnly.info.claimMachine, undefined);
});
