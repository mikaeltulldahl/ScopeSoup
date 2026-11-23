// How many git processes one write of the meta ref starts. The budget is 5 and is not raised
// to pass: a write that needs more has to do less. The first write of a writer is not counted (its
// one-time checks, such as the git version and the list of checked-out branches, are cached). The
// writers here keep those checks for an hour (`recheckMs`): on a busy machine a test can run longer than
// the default 10 s, and the re-check would then merge in a measured write.
// Real git in temporary repositories, synthetic data.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { RunGit } from "./git.ts";
import { gitIn } from "./git.ts";
import { createTestRepo, cloneTestRepo } from "./testRepo.ts";
import { createWriter } from "./writer.ts";
import type { Writer } from "./writer.ts";

const REF = "refs/scopesoup/meta";
const BUDGET = 5;
const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

const RECHECK_MS = 60 * 60_000;
const person = { name: "Test Person", email: "test.person@example.invalid" };
const by = { who: "tester", agent: false };

/** A RunGit that keeps the arguments of every call. */
function counting(dir: string): { git: RunGit; calls: string[][] } {
  const inner = gitIn(dir);
  const calls: string[][] = [];
  const git: RunGit = (args, input, env) => {
    calls.push(args);
    return inner(args, input, env);
  };
  return { git, calls };
}

const isMetaMove = (args: string[]): boolean => args.includes("update-ref") && args.includes(REF);

describe("the git processes of one write", { concurrency: 2 }, () => {
  test("a local write (no remote) starts at most 5 git processes, result included", async () => {
    const repo = createTestRepo();
    cleanups.push(() => repo.cleanup());
    const local = counting(repo.dir);
    const writer = createWriter({ git: local.git, network: local.git, repoDir: repo.dir, ref: REF, remote: null, person, machine: "m1", idPrefix: "A", now: () => "2026-01-01T00:00:00.000Z", recheckMs: RECHECK_MS });
    const first = await writer.createItem({ title: "First", body: "Body one." });
    const second = await writer.createItem({ title: "Second", body: "Body two." });
    const writes: [string, () => Promise<unknown>][] = [
      ["createItem", () => writer.createItem({ title: "Third", body: "Body three." }, [{ kind: "note", by }])],
      ["editItem", () => writer.editItem(first.id, (item) => ({ ...item, title: "First, edited" }))],
      ["editItem again", () => writer.editItem(first.id, (item) => ({ ...item, title: "First, edited twice" }))],
      ["appendLog", () => writer.appendLog(second.id, { kind: "note", by, fields: { n: 1 } })],
      ["appendLog again", () => writer.appendLog(second.id, { kind: "note", by, fields: { n: 2 } })],
      ["appendLog on another item", () => writer.appendLog(first.id, { kind: "note", by })],
    ];
    for (const [name, write] of writes) {
      const before = local.calls.length;
      await write();
      const used = local.calls.slice(before);
      assert.ok(used.length <= BUDGET, `${name} started ${used.length} git processes (budget ${BUDGET}): ${used.map((args) => args.filter((arg) => !arg.startsWith("-") && !arg.includes("=")).slice(0, 1).join(" ")).join(", ")}`);
    }
  });

  test("a batch of items is one commit whose git processes do not grow with its size, links by key included", async () => {
    const repo = createTestRepo();
    cleanups.push(() => repo.cleanup());
    const local = counting(repo.dir);
    const writer = createWriter({ git: local.git, network: local.git, repoDir: repo.dir, ref: REF, remote: null, person, machine: "m1", idPrefix: "A", now: () => "2026-01-01T00:00:00.000Z", recheckMs: RECHECK_MS });
    await writer.createItem({ title: "First", body: "Body one." });
    const batch = (from: number, count: number) => Array.from({ length: count }, (_, index) => {
      const n = from + index;
      return {
        key: String(n),
        unique: ["importedFrom", `test:${n}`] as [string, string],
        make: (idOf: (key: string) => string | undefined) => ({
          input: { title: `Item ${n}`, body: `Number ${n}.`, ...(n > from ? { blockedBy: [idOf(String(n - 1)) as string] } : {}) },
          lines: [{ kind: "created", by }],
        }),
      };
    });
    const used: number[] = [];
    for (const [from, count] of [[1, 2], [3, 20]] as const) {
      const before = local.calls.length;
      const done = await writer.createItems(batch(from, count));
      used.push(local.calls.length - before);
      assert.equal(done.changed, true);
      assert.equal([...done.items.values()].filter((item) => item.created).length, count);
    }
    assert.equal(used[0], used[1], `a batch of 2 started ${used[0]} git processes and one of 20 started ${used[1]}`);
    assert.ok((used[1] as number) <= 6, `a batch started ${used[1]} git processes (budget 6)`);
    assert.equal(repo.git(["rev-list", "--count", REF]), "3");
    assert.match((await writer.versions("A-5")).itemMd ?? "", /\nblockedBy: A-4\n/);
    // Again, with one new item: the 22 found by `importedFrom` keep their ids and nothing is written for them.
    const again = await writer.createItems([...batch(1, 2), ...batch(3, 21)]);
    assert.deepEqual([...again.items.values()].filter((item) => item.created).map((item) => item.id), ["A-24"]);
    assert.equal(again.items.get("2")?.id, "A-3");
    // A dry run allocates as a write would and writes nothing.
    const dry = await writer.createItems(batch(30, 2), { dryRun: true });
    assert.deepEqual([...dry.items.values()].map((item) => item.id), ["A-25", "A-26"]);
    assert.equal(repo.git(["rev-list", "--count", REF]), "4");
  });

  test("a write that is stale (another process wrote first) is done again from a fresh read", async () => {
    const repo = createTestRepo();
    cleanups.push(() => repo.cleanup());
    const git = gitIn(repo.dir);
    const make = (machine: string, idPrefix: string): Writer => createWriter({ git, network: git, repoDir: repo.dir, ref: REF, remote: null, person, machine, idPrefix, now: () => "2026-01-01T00:00:00.000Z" });
    const one = make("m1", "A");
    const two = make("m2", "B");
    const mine = await one.createItem({ title: "One", body: "x" });
    const other = await two.createItem({ title: "Two", body: "y" });
    // `one` holds the tip it made, which is not the tip any more.
    const next = await one.createItem({ title: "Three", body: "z" });
    assert.ok(next.changed);
    assert.equal((await two.versions(other.id)).itemMd?.includes("title: Two"), true);
    assert.equal((await one.versions(next.id)).itemMd?.includes("title: Three"), true);
    assert.equal((await two.versions(mine.id)).itemMd?.includes("title: One"), true);
  });

  test("with a remote the write itself, up to the move of the ref, starts at most 5 git processes", async () => {
    const origin = createTestRepo();
    cleanups.push(() => origin.cleanup());
    const clone = cloneTestRepo(origin);
    cleanups.push(() => clone.cleanup());
    const local = counting(clone.dir);
    const network = counting(clone.dir);
    const writer = createWriter({ git: local.git, network: network.git, repoDir: clone.dir, ref: REF, remote: "origin", person, machine: "m1", idPrefix: "A", now: () => "2026-01-01T00:00:00.000Z", recheckMs: RECHECK_MS });
    const first = await writer.createItem({ title: "First", body: "Body one." });
    for (const [name, write] of [
      ["createItem", () => writer.createItem({ title: "Second", body: "Body two." })],
      ["editItem", () => writer.editItem(first.id, (item) => ({ ...item, title: "First, edited" }))],
      ["appendLog", () => writer.appendLog(first.id, { kind: "note", by })],
    ] as [string, () => Promise<unknown>][]) {
      const before = local.calls.length;
      await write();
      const used = local.calls.slice(before);
      const moved = used.findIndex(isMetaMove);
      assert.ok(moved >= 0, `${name} never moved ${REF}`);
      assert.ok(moved + 1 <= BUDGET, `${name} started ${moved + 1} git processes before the ref moved (budget ${BUDGET})`);
    }
    assert.equal((await writer.share()).state, "shared");
  });
});
