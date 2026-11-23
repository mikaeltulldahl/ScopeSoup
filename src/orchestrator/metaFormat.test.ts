// The meta branch's format with real git. The fixtures in src/hosts/metaBranch/fixtures (one meta tree per released format) are
// committed to a bare "remote", and laptops are clones of it with the meta branch host and the real merge queue lease. An older
// branch is migrated in one commit by the lease holder only; a newer one is read only; the current fixture still reads.
// Synthetic data.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import type { Ref } from "../model/types.ts";
import { createMergeQueue } from "./mergeQueue.ts";
import type { MergeQueue } from "./mergeQueue.ts";
import { realGit } from "./process.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/adapter.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/adapter.ts";
import { FORMAT_FILE, NEWER_META } from "../hosts/metaBranch/format.ts";
import { migrateMetaFormat } from "../hosts/metaBranch/migrate.ts";
import type { MigrationLease } from "../hosts/metaBranch/migrate.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { cloneTestRepo, createTestRepo, itemMd } from "../hosts/metaBranch/testRepo.ts";

const REF = "refs/scopesoup/meta";
const FIXTURES = join(import.meta.dirname, "..", "hosts", "metaBranch", "fixtures");
const T0 = "2026-11-18T12:00:00Z";
const cleanups: (() => void)[] = [];
after(() => cleanups.reverse().forEach((cleanup) => cleanup()));

/** A fixture's files, path (with `/`) to text. */
function fixture(name: string): Record<string, string> {
  const root = join(FIXTURES, name);
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path).split("\\").join("/")] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return files;
}

function clock(start = "2026-11-18T13:00:00Z"): () => string {
  let at = Date.parse(start);
  return () => new Date((at += 1000)).toISOString();
}

/** A bare remote whose meta ref holds `files`. */
function remote(files?: Record<string, string>): TestRepo {
  const origin = createTestRepo();
  cleanups.push(() => origin.cleanup());
  origin.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  if (files) origin.commit(REF, files, T0);
  return origin;
}

interface Laptop {
  host: MetaBranchHost;
  mergeQueue: MergeQueue;
  machine: string;
  now: () => string;
}

function laptop(origin: TestRepo, machine: string, prefix: string): Laptop {
  const clone = cloneTestRepo(origin);
  cleanups.push(() => clone.cleanup());
  const now = clock();
  const host = createMetaBranchHost({ repoDir: clone.dir, ref: REF, allowWrites: true, person: { name: `Person ${machine}`, email: `${machine}@example.invalid` }, machine, idPrefix: prefix, now });
  return { host, mergeQueue: createMergeQueue({ git: realGit, repo: clone.dir, remote: "origin", machine }), machine, now };
}

const migrate = (side: Laptop) => migrateMetaFormat({ writer: side.host.writer!, lease: side.mergeQueue, machine: side.machine, now: side.now });
const work = (id: string): Ref => ({ host: "metaBranch", kind: "work", id });
const by = { who: "robin", agent: false };
const picture = async (host: MetaBranchHost) => (await host.work.listWork()).items.map((item) => [item.ref.id, item.title, item.state, item.needsDecision === true]);
const tryGit = (repo: TestRepo, args: string[]): string | null => {
  try {
    return repo.git(args);
  } catch {
    return null;
  }
};

describe("the meta branch's format", { concurrency: 4 }, () => {
  test("an older meta branch is migrated in one commit, by the merge-queue-lease holder only", async () => {
    const origin = remote(fixture("format-0"));
    const old = origin.git(["rev-parse", REF]);
    const a = laptop(origin, "laptop-a", "A");
    const b = laptop(origin, "laptop-b", "B");
    const before = await picture(a.host);
    assert.equal(a.host.lastReport()?.format?.format, 0);
    await picture(b.host);

    // b holds the lease (it merges): a does not migrate, and nothing is written.
    assert.equal((await b.mergeQueue.acquire(b.now(), 30)).held, true);
    const waited = await migrate(a);
    assert.equal(waited.state, "lease");
    assert.match((waited as { why: string }).why, /laptop-b/);
    assert.equal(origin.git(["rev-parse", REF]), old);
    // A format-0 branch is still written to meanwhile: format 1 only adds the entry.
    await a.host.write!.appendLog!(work("F-2"), { kind: "released", by });
    const written = origin.git(["rev-parse", REF]);
    assert.equal(tryGit(origin, ["cat-file", "-p", `${REF}:${FORMAT_FILE}`]), null);

    // b lets go; both try at once: exactly one migrates.
    await b.mergeQueue.release(b.now());
    const tries = await Promise.all([migrate(a), migrate(b)]);
    assert.deepEqual(tries.filter((one) => one.state === "migrated").length, 1, JSON.stringify(tries));
    for (const other of tries.filter((one) => one.state !== "migrated")) assert.ok(other.state === "lease" || other.state === "current", JSON.stringify(other));
    const migrated = tries.find((one) => one.state === "migrated") as { from: number; to: number; commit: string; sharing: { state: string } };
    assert.deepEqual([migrated.from, migrated.to, migrated.sharing.state], [0, 1, "shared"]);

    // One commit on top of what was there, which only writes the format entry.
    assert.equal(origin.git(["rev-parse", REF]), migrated.commit);
    assert.deepEqual(origin.git(["rev-list", `${written}..${REF}`]).split("\n"), [migrated.commit]);
    assert.equal(origin.git(["diff", "--name-status", written, REF]), `A\t${FORMAT_FILE}`);
    assert.equal(origin.git(["cat-file", "-p", `${REF}:${FORMAT_FILE}`]), "1");
    assert.match(origin.git(["log", "-1", "--format=%B", REF]), /^Meta branch format 0 to 1\n\nFormat 0 to 1: the format entry is written; nothing else changes\.\n\nScopeSoup-Machine: laptop-(a|b)$/);
    // The lease was let go.
    assert.equal(await a.mergeQueue.peek(a.now()), null);

    // Once migrated, nobody migrates again, and the items read as before.
    await picture(a.host);
    await picture(b.host);
    assert.deepEqual((await Promise.all([migrate(a), migrate(b)])).map((one) => one.state), ["current", "current"]);
    assert.equal(origin.git(["rev-parse", REF]), migrated.commit);
    assert.deepEqual(await picture(a.host), before);
    assert.equal(a.host.lastReport()?.format, undefined);
  });

  test("a meta branch of a newer format is read only: reads work, every write is refused with the upgrade message", async () => {
    const origin = remote({ ...fixture("format-1"), [FORMAT_FILE]: "2\n" });
    const tip = origin.git(["rev-parse", REF]);
    const a = laptop(origin, "laptop-a", "A");
    // Read as this Scope Soup reads its own format.
    assert.deepEqual((await picture(a.host)).map(([id, title, , decision]) => [id, title, decision]), [
      ["F-1", "Add a regression suite", false],
      ["F-2", "Write the parser", true],
      ["F-3", "A merged change", false],
    ]);
    const report = a.host.lastReport()?.format;
    assert.equal(report?.format, 2);
    assert.ok(report?.note.includes(NEWER_META), report?.note);
    const write = a.host.write!;
    const upgrade = new RegExp(NEWER_META.replace(/[.*+?^${}()|[\]\\;']/g, "\\$&"));
    await assert.rejects(write.createWork!({ title: "A new item" }), upgrade);
    await assert.rejects(write.editWork!(work("F-1"), { title: "Edited" }), upgrade);
    await assert.rejects(write.appendLog!(work("F-1"), { kind: "released", by }), upgrade);
    await assert.rejects(write.appendLogs!(work("F-1"), [{ kind: "released", by }]), upgrade);
    await assert.rejects(write.resolveConflict!(work("F-2"), itemMd("F-2", "Write the parser", "todo"), ["0123456789ab"]), upgrade);
    const tried = await migrate(a);
    assert.equal(tried.state, "newer");
    assert.ok((tried as { why: string }).why.includes(NEWER_META));
    // Nothing changed: not the remote, not the local ref.
    assert.equal(origin.git(["rev-parse", REF]), tip);
    assert.equal(a.host.writer!.lastSharing()?.state, "shared");
    assert.deepEqual(await a.host.writer!.format(), { ok: true, format: 2 });
  });

  test("this machine's unshared commits are not put on top of a newer format: they stay here, and the remote is left alone", async () => {
    const origin = remote(fixture("format-1"));
    const a = laptop(origin, "laptop-a", "A");
    await picture(a.host);
    // Another machine, on a newer Scope Soup, moves the remote to format 2.
    const newer = origin.commit(REF, { ...fixture("format-1"), [FORMAT_FILE]: "2\n" }, "2026-11-18T12:30:00Z");
    const outcome = await a.host.write!.appendLog!(work("F-1"), { kind: "released", by });
    assert.equal(outcome.shared, "pending");
    assert.ok(outcome.problem?.includes(NEWER_META), outcome.problem);
    assert.match(outcome.problem ?? "", /1 unshared commit\(s\); they stay here and are not pushed/);
    assert.equal(origin.git(["rev-parse", REF]), newer);
  });

  test("the fixture of the current format still reads, and reads as the format-0 fixture does", async () => {
    const read = async (name: string) => {
      const origin = remote(fixture(name));
      const host = createMetaBranchHost({ repoDir: origin.dir, ref: REF });
      return { host, works: (await host.work.listWork()).items, changes: (await host.changes.listChanges()).items };
    };
    const zero = await read("format-0");
    const one = await read("format-1");
    assert.deepEqual(one.works, zero.works);
    assert.deepEqual(one.changes, zero.changes);
    const byId = new Map(one.works.map((item) => [item.ref.id, item]));
    assert.deepEqual(byId.get("F-1")?.labels, ["tests", "core"]);
    assert.equal(byId.get("F-1")?.priority, "major");
    assert.equal(byId.get("F-2")?.needsDecision, true);
    assert.equal(byId.get("F-2")?.parent?.id, "F-1");
    assert.equal(byId.get("F-3")?.state, "done");
    assert.equal(one.changes.find((change) => change.ref.id === "F-1")?.branch, "scopesoup/F-1");
    const report = one.host.lastReport();
    assert.deepEqual([report?.items, report?.malformedItems, report?.malformedLines, report?.unknownKinds, report?.conflicts, report?.format], [3, [], 0, 1, ["F-2"], undefined]);
    assert.equal(zero.host.lastReport()?.format?.format, 0);
  });

  test("a new meta branch starts at the current format; a first commit put on top of an older history leaves the entry out", async () => {
    const empty = remote();
    const a = laptop(empty, "laptop-a", "A");
    await a.host.write!.createWork!({ title: "The first item" });
    assert.equal(empty.git(["cat-file", "-p", `${REF}:${FORMAT_FILE}`]), "1");

    // b writes before it ever fetched: its first commit is a root with the entry; on top of the format-0 remote it goes without.
    const origin = remote(fixture("format-0"));
    const b = laptop(origin, "laptop-b", "B");
    const outcome = await b.host.write!.createWork!({ title: "Made before the first fetch" });
    assert.equal(outcome.shared, "shared");
    assert.equal(tryGit(origin, ["cat-file", "-p", `${REF}:${FORMAT_FILE}`]), null);
    assert.match(origin.git(["cat-file", "-p", `${REF}:items/B-1/item.md`]), /Made before the first fetch/);
  });

  test("a meta branch that is not shared is migrated without a lease; one whose format entry cannot be read is not written to", async () => {
    const repo = remote(fixture("format-0"));
    const now = clock();
    const host = createMetaBranchHost({ repoDir: repo.dir, ref: REF, allowWrites: true, person: { name: "Person solo", email: "solo@example.invalid" }, machine: "solo", idPrefix: "S", remote: null, now });
    const noLease: MigrationLease = {
      acquire: () => assert.fail("no lease is taken for a meta branch with no remote"),
      release: () => assert.fail("no lease is let go"),
      peek: () => assert.fail("no lease is looked at"),
    };
    const tried = await migrateMetaFormat({ writer: host.writer!, lease: noLease, machine: "solo", now });
    assert.equal(tried.state, "migrated");
    assert.equal(repo.git(["cat-file", "-p", `${REF}:${FORMAT_FILE}`]), "1");
    assert.equal((await migrateMetaFormat({ writer: host.writer!, lease: noLease, machine: "solo", now })).state, "current");

    const garbled = remote({ ...fixture("format-1"), [FORMAT_FILE]: "two\n" });
    const other = createMetaBranchHost({ repoDir: garbled.dir, ref: REF, allowWrites: true, person: { name: "Person solo", email: "solo@example.invalid" }, machine: "solo", idPrefix: "S", remote: null, now });
    assert.equal((await other.work.listWork()).items.length, 3);
    assert.equal(other.lastReport()?.format?.format, null);
    await assert.rejects(other.write!.appendLog!(work("F-1"), { kind: "released", by }), /cannot tell its format and writes nothing to it/);
    assert.equal((await migrateMetaFormat({ writer: other.writer!, lease: noLease, machine: "solo", now })).state, "unreadable");
  });
});
