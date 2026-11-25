// The merge queue lease between two machines: real git, one bare remote, two clones. Synthetic data.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { TestClone, TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { cloneTestRepo, createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createMergeQueue, MERGE_QUEUE_REF } from "./mergeQueue.ts";
import { realGit } from "./process.ts";

const cleanups: (() => void)[] = [];
after(() => cleanups.reverse().forEach((cleanup) => cleanup()));

function remote(): TestRepo {
  const origin = createTestRepo();
  cleanups.push(() => origin.cleanup());
  origin.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  return origin;
}

function machine(origin: TestRepo, name: string) {
  const clone: TestClone = cloneTestRepo(origin);
  cleanups.push(() => clone.cleanup());
  return createMergeQueue({ git: realGit, repo: clone.dir, remote: "origin", machine: name });
}

const T = (minutes: number): string => new Date(Date.parse("2026-11-18T09:00:00Z") + minutes * 60_000).toISOString();

describe("merge queue", { concurrency: 4 }, () => {
test("one machine holds the lease; the other waits until it is let go, and then takes it", async () => {
  const origin = remote();
  const a = machine(origin, "laptop-a");
  const b = machine(origin, "laptop-b");
  assert.deepEqual(await a.acquire(T(0), 30), { held: true, until: T(30) });
  const refused = await b.acquire(T(1), 30);
  assert.equal(refused.held, false);
  assert.equal((refused as { holder?: string }).holder, "laptop-a");
  assert.match((refused as { why: string }).why, /laptop-a merges until/);
  assert.equal((await b.peek(T(1)))?.holder, "laptop-a");

  // The holder asks again: that is a renewal, not a refusal.
  assert.deepEqual(await a.acquire(T(10), 30), { held: true, until: T(40) });
  // Another machine cannot let it go.
  await b.release(T(11));
  assert.equal((await b.acquire(T(12), 30)).held, false);

  await a.release(T(20));
  assert.equal(await b.peek(T(21)), null);
  assert.deepEqual(await b.acquire(T(21), 30), { held: true, until: T(51) });
  assert.equal((await a.acquire(T(22), 30)).held, false);

  // The ref's history is every lease line, one commit each; none was rewritten.
  const log = origin.git(["log", "--format=%B", MERGE_QUEUE_REF]).split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { kind: string; holder: string });
  assert.deepEqual(log.map((line) => `${line.kind} ${line.holder}`), ["lease laptop-b", "release laptop-a", "lease laptop-a", "lease laptop-a"]);
});

test("a lease that was not renewed or released lapses, and the other machine takes it", async () => {
  const origin = remote();
  const a = machine(origin, "laptop-a");
  const b = machine(origin, "laptop-b");
  await a.acquire(T(0), 30);
  assert.equal((await b.acquire(T(29), 30)).held, false);
  assert.deepEqual(await b.acquire(T(31), 30), { held: true, until: T(61) });
  assert.equal((await a.peek(T(32)))?.holder, "laptop-b");
});

test("two machines asking at the same moment: exactly one gets it", async () => {
  const origin = remote();
  const a = machine(origin, "laptop-a");
  const b = machine(origin, "laptop-b");
  const c = machine(origin, "laptop-c");
  const results = await Promise.all([a.acquire(T(0), 30), b.acquire(T(0), 30), c.acquire(T(0), 30)]);
  assert.equal(results.filter((result) => result.held).length, 1);
  const loser = results.find((result) => !result.held) as { why: string };
  assert.match(loser.why, /merges until|took the lease first/);
});

test("when the remote cannot be reached nobody merges", async () => {
  const origin = remote();
  const clone = cloneTestRepo(origin);
  cleanups.push(() => clone.cleanup());
  clone.git(["remote", "set-url", "origin", `${origin.dir}-gone`]);
  const lone = createMergeQueue({ git: realGit, repo: clone.dir, remote: "origin", machine: "laptop-a" });
  const result = await lone.acquire(T(0), 30);
  assert.equal(result.held, false);
  assert.match((result as { why: string }).why, /could not reach origin/);
});

test("singleplayer holds the lease here, touching no remote; another machine's lease there is left alone", async () => {
  const origin = remote();
  const other = machine(origin, "laptop-b");
  await other.acquire(T(0), 30);
  const before = origin.git(["rev-parse", MERGE_QUEUE_REF]);
  const clone = cloneTestRepo(origin);
  cleanups.push(() => clone.cleanup());
  let alone = true;
  const lone = createMergeQueue({ git: realGit, repo: clone.dir, remote: "origin", machine: "laptop-a", alone: () => alone });
  assert.deepEqual(await lone.acquire(T(1), 30), { held: true, until: T(31) });
  assert.equal(await lone.peek(T(1)), null);
  await lone.release(T(2));
  assert.equal(origin.git(["rev-parse", MERGE_QUEUE_REF]), before);
  // Asked at each call: back in multiplayer the remote's lease counts again.
  alone = false;
  assert.equal((await lone.acquire(T(3), 30)).held, false);
});
});
