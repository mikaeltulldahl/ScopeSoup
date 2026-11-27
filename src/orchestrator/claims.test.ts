// Claims across machines: two laptops, two meta branch hosts, one bare remote. The claim lines are the
// real ones (hostActions), shared by the writer and read back by the fold. All data is synthetic.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { ProjectConfig } from "../config/types.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/adapter.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/adapter.ts";
import type { TestClone, TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { cloneTestRepo, createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createHostActions } from "./hostActions.ts";
import type { Actions } from "./ports.ts";
import { readyItems } from "./candidates.ts";
import { openStore } from "../store/store.ts";

const REF = "refs/scopesoup/meta";
const cleanups: (() => void)[] = [];
after(() => cleanups.reverse().forEach((cleanup) => cleanup()));

interface Laptop {
  host: MetaBranchHost;
  actions: Actions;
  clock: { ms: number };
  clone: TestClone;
}

function origin(): TestRepo {
  const repo = createTestRepo();
  cleanups.push(() => repo.cleanup());
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  repo.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  return repo;
}

function laptop(remote: TestRepo, machine: string, prefix: string, start = "2026-11-18T09:00:00Z"): Laptop {
  const clone = cloneTestRepo(remote);
  cleanups.push(() => clone.cleanup());
  const clock = { ms: Date.parse(start) };
  // Fetching is done on every read, so that a laptop sees what the other one wrote.
  const host = createMetaBranchHost({
    repoDir: clone.dir, ref: REF, allowWrites: true, person: { name: machine, email: `${machine}@example.invalid` }, machine, idPrefix: prefix,
    now: () => new Date((clock.ms += 1000)).toISOString(), fetchIntervalMs: 0,
  });
  cleanups.push(() => void host.stop?.());
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => ({}) as ProjectConfig, store: openStore(":memory:") });
  return { host, actions, clock, clone };
}

const ref = (id: string): Ref => ({ host: "metaBranch", kind: "work", id });
const at = (l: Laptop): string => new Date(l.clock.ms).toISOString();
const untilFrom = (l: Laptop, minutes: number): string => new Date(l.clock.ms + minutes * 60_000).toISOString();

async function listed(l: Laptop): Promise<WorkItem[]> {
  return (await (l.host.work as NonNullable<MetaBranchHost["work"]>).listWork()).items;
}

describe("claims", { concurrency: 4 }, () => {
test("two laptops claim the same item: one wins, and the picker of the other skips it", async () => {
  const remote = origin();
  const a = laptop(remote, "laptop-a", "A");
  const b = laptop(remote, "laptop-b", "B");
  await (a.host.write?.createWork?.({ title: "Shared work", state: "todo", lane: "todo" }) as Promise<unknown>);
  await (a.host.write?.createWork?.({ title: "Other work", state: "todo", lane: "todo" }) as Promise<unknown>);
  assert.equal(a.actions.claimant, "scopesoup@laptop-a");
  await listed(b); // B syncs before it picks, as the sync loop does

  assert.deepEqual(await a.actions.claim(ref("A-1"), untilFrom(a, 60), at(a)), { won: true });
  // B has not looked yet when it claims; it learns by sharing and reading back that A was first.
  const lost = await b.actions.claim(ref("A-1"), untilFrom(b, 60), at(b));
  assert.equal(lost.won, false);
  assert.match((lost as { why: string }).why, /held by scopesoup on laptop-a/);

  // B's picker skips A-1 and takes A-2.
  const itemsB = await listed(b);
  const readiness = readyItems(itemsB, [], {}, at(b));
  assert.deepEqual(readiness.ready.map((item) => item.ref.id), ["A-2"]);
  assert.deepEqual(readiness.held.map((entry) => `${entry.item.ref.id}: ${entry.reason}`), ["A-1: held by scopesoup on laptop-a"]);
  assert.deepEqual(await b.actions.claim(ref("A-2"), untilFrom(b, 60), at(b)), { won: true });

  // A sees both claims after its next read.
  const itemsA = await listed(a);
  assert.deepEqual(itemsA.map((item) => `${item.ref.id}:${item.holder?.actor.id}`).sort(), ["A-1:scopesoup@laptop-a", "A-2:scopesoup@laptop-b"]);
});

test("a claim expires without a renewing line, and renewal keeps it", async () => {
  const remote = origin();
  const a = laptop(remote, "laptop-a", "A");
  const b = laptop(remote, "laptop-b", "B");
  await (a.host.write?.createWork?.({ title: "Long work", state: "todo", lane: "todo" }) as Promise<unknown>);
  await listed(b);
  await a.actions.claim(ref("A-1"), untilFrom(a, 30), at(a));

  // 20 minutes on: A renews, so B's claim 25 minutes after the first still does not take it.
  a.clock.ms += 20 * 60_000;
  assert.deepEqual(await a.actions.claim(ref("A-1"), untilFrom(a, 30), at(a)), { won: true });
  b.clock.ms = a.clock.ms + 5 * 60_000;
  assert.equal((await b.actions.claim(ref("A-1"), untilFrom(b, 30), at(b))).won, false);

  // No renewal from A for longer than the claim lasts: B takes it.
  b.clock.ms = a.clock.ms + 40 * 60_000;
  assert.deepEqual(await b.actions.claim(ref("A-1"), untilFrom(b, 30), at(b)), { won: true });
  assert.equal((await listed(b))[0]?.holder?.actor.id, "scopesoup@laptop-b");
  // Once it has expired and nobody took it, the picker offers it again.
  const idle = readyItems(await listed(b), [], {}, new Date(b.clock.ms + 60 * 60_000).toISOString());
  assert.deepEqual(idle.ready.map((item) => item.ref.id), ["A-1"]);
});

test("a claim that cannot be shared is not won", async () => {
  const remote = origin();
  const a = laptop(remote, "laptop-a", "A");
  await (a.host.write?.createWork?.({ title: "Work", state: "todo", lane: "todo" }) as Promise<unknown>);
  // The remote goes away: the claim is written here but cannot be shared.
  a.clone.git(["remote", "set-url", "origin", `${remote.dir}-gone`]);
  const result = await a.actions.claim(ref("A-1"), untilFrom(a, 60), at(a));
  assert.equal(result.won, false);
  assert.match((result as { why: string }).why, /could not be shared/);
});

test("a shared meta branch with writes on is claimed on by itself, with no rule in any file; one with no remote is not", () => {
  const remote = origin();
  const a = laptop(remote, "laptop-a", "A");
  assert.equal(a.host.info.shared, true);
  assert.equal(a.actions.claims, true);
  const clone = cloneTestRepo(remote);
  cleanups.push(() => clone.cleanup());
  const local = createMetaBranchHost({ repoDir: clone.dir, ref: REF, allowWrites: true, person: { name: "laptop-c", email: "laptop-c@example.invalid" }, machine: "laptop-c", idPrefix: "C", remote: null });
  cleanups.push(() => void local.stop?.());
  const actions = createHostActions({ host: local, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => ({}) as ProjectConfig, store: openStore(":memory:") });
  assert.equal(local.info.shared, undefined);
  assert.equal(actions.claims, undefined);
  const readOnly = createMetaBranchHost({ repoDir: clone.dir, ref: REF });
  assert.equal(createHostActions({ host: readOnly, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => ({}) as ProjectConfig, store: openStore(":memory:") }).claims, undefined);
});
});
