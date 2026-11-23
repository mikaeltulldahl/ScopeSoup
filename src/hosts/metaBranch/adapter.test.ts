// The meta branch adapter against a real temporary repository. All names and texts are synthetic.
// The sync loop and the board on top of it are tested in src/sync/metaBranch.test.ts.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createMetaBranchHost, DEFAULT_META_REF } from "./adapter.ts";
import type { RunGit } from "./git.ts";
import { gitIn } from "./git.ts";
import type { TestRepo } from "./testRepo.ts";
import { createTestRepo, itemMd, jsonl } from "./testRepo.ts";

const SHA1 = "1111111111111111111111111111111111111111";
const robin = { who: "robin", machine: "laptop-a" };

let repo: TestRepo;
before(() => {
  repo = createTestRepo();
  repo.commit(
    DEFAULT_META_REF,
    {
      "items/E-1/item.md": itemMd("E-1", "Readable", "doing"),
      "items/E-1/log.jsonl": jsonl({ at: "2026-11-18T09:00:00Z", by: robin, kind: "revision", sha: SHA1, branch: "scopesoup/E-1" }) + "not json\n" + jsonl({ at: "2026-11-18T09:01:00Z", by: robin, kind: "waved" }),
      "items/E-2/item.md": "---\ntitle: No state\n---\n",
      "items/..x/item.md": itemMd("..x", "Dots", "todo"),
    },
    "2026-11-18T10:00:00Z",
  );
});
after(() => repo.cleanup());

test("reads the default ref: a malformed item.md, a malformed line and an unknown kind are counted, the rest is read", async () => {
  const host = createMetaBranchHost({ repoDir: repo.dir });
  const works = (await host.work.listWork()).items;
  assert.deepEqual(works.map((item) => [item.ref.id, item.state, item.title]), [
    ["E-1", "doing", "Readable"],
    ["E-2", "waiting", "E-2: item.md cannot be read"],
  ]);
  const changes = (await host.changes.listChanges()).items;
  assert.deepEqual(changes.map((change) => [change.ref, change.branch, change.target, change.state]), [[{ host: "metaBranch", kind: "change", id: "E-1" }, "scopesoup/E-1", "main", "open"]]);
  assert.equal((await host.changes.getChange({ host: "metaBranch", kind: "change", id: "E-1" }))?.revisions[0]?.sha, SHA1);
  assert.deepEqual(host.lastReport(), { items: 2, malformedItems: ["E-2"], malformedLines: 1, unknownKinds: 1, skipped: ["items/..x/item.md"], format: { format: 0, note: "The meta branch is format 0; the machine that holds the merge queue lease migrates it to format 1, and writes go on meanwhile." } });
  assert.equal((await host.info.whoami()).id, "local");
});

test("a repository without the meta ref is an empty project, not an error", async () => {
  const host = createMetaBranchHost({ repoDir: repo.dir, ref: "refs/scopesoup/not-there" });
  assert.deepEqual((await host.work.listWork()).items, []);
  assert.deepEqual((await host.changes.listChanges()).items, []);
  assert.equal(await host.work.getWork({ host: "metaBranch", kind: "work", id: "E-1" }), null);
});

test("the ref is a setting, and one git could misread is refused up front", () => {
  assert.throws(() => createMetaBranchHost({ repoDir: repo.dir, ref: "--upload-pack=evil" }), /not a ref name/);
  assert.throws(() => createMetaBranchHost({ repoDir: repo.dir, ref: "refs/heads/../main" }), /not a ref name/);
  assert.throws(() => createMetaBranchHost({ repoDir: repo.dir, target: "-x" }), /not a branch name/);
});

test("a folder that is not a repository is an error, not an empty project", async () => {
  const host = createMetaBranchHost({ repoDir: repo.dir, git: async () => ({ code: 128, stdout: Buffer.from(""), stderr: "fatal: not a git repository" }) });
  await assert.rejects(host.work.listWork(), /git for-each-ref failed \(exit 128\): fatal: not a git repository/);
});

test("listings: unchanged while the ref stands still, everything plus what went once it moves, and git is only read", async () => {
  const other = createTestRepo();
  try {
    const ref = "refs/scopesoup/meta";
    other.commit(ref, { "items/C-1/item.md": itemMd("C-1", "One", "todo"), "items/C-2/item.md": itemMd("C-2", "Two", "todo") }, "2026-11-18T10:00:00Z");
    const calls: string[][] = [];
    const real = gitIn(other.dir);
    const git: RunGit = (args, input) => {
      calls.push(args);
      return real(args, input);
    };
    const host = createMetaBranchHost({ repoDir: other.dir, ref, git });

    const first = await host.work.listWork();
    assert.deepEqual(first.items.map((item) => item.ref.id), ["C-1", "C-2"]);
    const again = await host.work.listWork(first.cursor);
    assert.deepEqual([again.items, again.unchanged, again.cursor], [[], true, first.cursor]);

    other.commit(ref, { "items/C-1/item.md": itemMd("C-1", "One, renamed", "doing"), "items/C-3/item.md": itemMd("C-3", "Three", "todo") }, "2026-11-18T11:00:00Z");
    const moved = await host.work.listWork(first.cursor);
    assert.deepEqual(moved.items.map((item) => [item.ref.id, item.title]), [["C-1", "One, renamed"], ["C-3", "Three"]]);
    assert.deepEqual(moved.removed, [{ host: "metaBranch", kind: "work", id: "C-2" }]);
    assert.equal((await host.work.getWork({ host: "metaBranch", kind: "work", id: "C-3" }))?.title, "Three");

    // Only the object store is read: no checkout, no fetch, no write.
    const used = new Set(calls.map((args) => args[0]));
    assert.deepEqual([...used].sort(), ["cat-file", "for-each-ref", "ls-tree"]);
  } finally {
    other.cleanup();
  }
});
