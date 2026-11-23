// The read of the meta ref against real temporary repositories, some of them hostile.
// All names and texts are synthetic.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createMetaBranchHost, DEFAULT_META_REF } from "./adapter.ts";
import { gitEnvironment, gitIn } from "./git.ts";
import type { TestRepo } from "./testRepo.ts";
import { createTestRepo, itemMd, jsonl } from "./testRepo.ts";
import { execFileSyncRetrying } from "../spawnRetry.ts";

const robin = { who: "robin", machine: "laptop-a" };
const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((cleanup) => cleanup()));
const repoWith = (ref: string, files: Parameters<TestRepo["commit"]>[1]): TestRepo => {
  const repo = createTestRepo();
  cleanups.push(() => repo.cleanup());
  repo.commit(ref, files, "2026-11-18T10:00:00Z");
  return repo;
};
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-meta-dir-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const run = (cwd: string, args: string[]): string =>
  execFileSyncRetrying("git", ["-c", "protocol.file.allow=always", ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();

test("a ref that points at a tree is an error, not an empty project", async () => {
  const repo = repoWith(DEFAULT_META_REF, { "items/A-1/item.md": itemMd("A-1", "One", "todo") });
  repo.git(["update-ref", "refs/scopesoup/tree", repo.git(["rev-parse", `${DEFAULT_META_REF}^{tree}`])]);
  const host = createMetaBranchHost({ repoDir: repo.dir, ref: "refs/scopesoup/tree" });
  await assert.rejects(host.work.listWork(), /points at a tree, not a commit/);
});

test("a hostile tree: a symlink, a submodule and an oversized blob spoil only their own items", async () => {
  const repo = repoWith(DEFAULT_META_REF, {
    "items/A-1/item.md": itemMd("A-1", "Fine", "todo"),
    "items/A-1/log.jsonl": jsonl({ at: "2026-11-18T09:00:00Z", by: robin, kind: "claimed", until: "2026-11-18T17:00:00Z" }),
    // item.md is a symlink to a file outside the tree.
    "items/B-1/item.md": { mode: "120000", content: "../../../../etc/passwd" },
    "items/B-1/log.jsonl": jsonl({ at: "2026-11-18T09:00:00Z", by: robin, kind: "claimed", until: "2026-11-18T17:00:00Z" }),
    // log.jsonl is a submodule entry.
    "items/B-2/item.md": itemMd("B-2", "Submodule log", "todo"),
    "items/B-2/log.jsonl": { mode: "160000", sha: "1".repeat(40) },
    // Over the cap (the cap is lowered below, so no megabyte is written).
    "items/B-3/item.md": itemMd("B-3", "Big header", "todo", ["labels: " + "x, ".repeat(200)]),
    "items/B-4/item.md": itemMd("B-4", "Big log", "todo"),
    "items/B-4/log.jsonl": jsonl({ at: "2026-11-18T09:00:00Z", by: robin, kind: "session", summary: "y".repeat(600) }),
  });
  const host = createMetaBranchHost({ repoDir: repo.dir, maxFileBytes: 500 });
  const works = (await host.work.listWork()).items;
  const byId = new Map(works.map((work) => [work.ref.id, work]));
  assert.deepEqual([...byId.keys()], ["A-1", "B-1", "B-2", "B-3", "B-4"]);
  assert.equal(byId.get("A-1")?.state, "todo");
  assert.ok(byId.get("A-1")?.holder);
  // A symlinked item.md is skipped like a stray file, so the item has no readable item.md; its log is read.
  assert.match(byId.get("B-1")?.hostState ?? "", /item\.md is missing/);
  assert.equal(byId.get("B-1")?.holder?.actor.id, "robin@laptop-a");
  // A submodule as log.jsonl: the item.md is read, the log is not.
  assert.equal(byId.get("B-2")?.state, "todo");
  assert.match(byId.get("B-3")?.hostState ?? "", /^malformed: item\.md is \d+ bytes, over the limit of 500; not read$/);
  assert.equal(byId.get("B-4")?.state, "todo");
  assert.deepEqual(host.lastReport(), {
    items: 5,
    malformedItems: ["B-1", "B-3"],
    malformedLines: 1,
    unknownKinds: 0,
    skipped: ["items/B-1/item.md", "items/B-2/log.jsonl"],
    // A meta branch without the format entry is format 0.
    format: { format: 0, note: "The meta branch is format 0; the machine that holds the merge queue lease migrates it to format 1, and writes go on meanwhile." },
  });
});

test("a few hundred items are read in reasonable time", async () => {
  const files: Parameters<TestRepo["commit"]>[1] = {};
  for (let n = 0; n < 400; n++) {
    const id = `N-${n}`;
    files[`items/${id}/item.md`] = itemMd(id, `Item ${n}`, "todo");
    files[`items/${id}/log.jsonl`] = jsonl({ at: "2026-11-18T09:00:00Z", by: robin, kind: "session", summary: "x" });
  }
  for (const id of ["a-1", "B-1", "N_1"]) files[`items/${id}/item.md`] = itemMd(id, id, "todo");
  const repo = repoWith(DEFAULT_META_REF, files);
  const host = createMetaBranchHost({ repoDir: repo.dir });
  const started = Date.now();
  const works = (await host.work.listWork()).items;
  assert.equal(works.length, 403);
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  // Plain code-unit order, not the locale's ("B-1" before "a-1", "N-9" before "N_1").
  const ids = works.map((work) => work.ref.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(ids[0], "B-1");
});

test("git runs without the variables that name a repository, and a hung git is ended", async () => {
  assert.deepEqual(
    Object.keys(gitEnvironment({ GIT_DIR: "x", git_work_tree: "x", GIT_INDEX_FILE: "x", GIT_OBJECT_DIRECTORY: "x", GIT_ALTERNATE_OBJECT_DIRECTORIES: "x", GIT_COMMON_DIR: "x", GIT_NAMESPACE: "x", KEEP: "y" })).sort(),
    ["GCM_INTERACTIVE", "GIT_NO_REPLACE_OBJECTS", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "KEEP"],
  );
  const repo = repoWith(DEFAULT_META_REF, { "items/A-1/item.md": itemMd("A-1", "One", "todo") });
  const other = repoWith(DEFAULT_META_REF, { "items/Z-9/item.md": itemMd("Z-9", "Other", "todo") });
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = other.dir;
  try {
    const works = (await createMetaBranchHost({ repoDir: repo.dir }).work.listWork()).items;
    assert.deepEqual(works.map((work) => work.ref.id), ["A-1"]);
  } finally {
    if (before === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = before;
  }
  const hung = gitIn(repo.dir, { executable: process.execPath, timeoutMs: 300 });
  await assert.rejects(hung(["-e", "setInterval(() => {}, 1000)"]), /did not finish within 300 ms/);
});

const sizeOf = (file: string): number => (existsSync(file) ? statSync(file).size : 0);
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
/**
 * Ends the process whose pid a test's child wrote to `file`, once the pid is there. The file can exist
 * before its text is written, and `process.kill(0)` (Number("")) ends this process itself on Windows: the
 * whole file then failed with no test named.
 */
async function endPidIn(file: string): Promise<void> {
  for (let tries = 0; tries < 50; tries++) {
    const pid = existsSync(file) ? Number(readFileSync(file, "utf8")) : NaN;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
      return;
    }
    await pause(100);
  }
}

// Were the tree not ended, the call would not return at all (the child holds the pipes for ever): the
// test's own time limit only fails a stuck call instead of hanging the run. The call is the 700 ms and then
// the tree kill (PowerShell's listing and the MSYS `ps` on Windows), which took 6.6 s on a machine running
// two checks side by side, so the limit is not a measure of speed.
test("the time limit bounds the call: what git started (a hook, ssh) is ended with it, even while it holds the pipes", { timeout: 60_000 }, async () => {
  const dir = tempDir();
  const file = join(dir, "ticks");
  // The "git" starts a child that shares its output pipes and keeps writing, then waits for ever.
  const parent = `const { spawn } = require("child_process"); spawn(process.execPath, ["-e", "setInterval(() => require('fs').appendFileSync(process.argv[1], 'x'), 50)", process.argv[1]], { stdio: "inherit" }); setInterval(() => {}, 1000);`;
  await assert.rejects(gitIn(dir, { executable: process.execPath, timeoutMs: 700 })(["-e", parent, file]), /did not finish within 700 ms; it and what it started were ended/);
  await pause(300);
  const size = sizeOf(file);
  assert.ok(size > 0, "the child ran");
  await pause(500);
  assert.equal(sizeOf(file), size, "the child was ended too");
});

test("a git that exits shortly before its time limit is not ended by the limit afterwards (its pid may be reused)", async () => {
  const dir = tempDir();
  const file = join(dir, "pid");
  // Exits as soon as the child it started (which shares the pipes) is running, and the limit (1900 ms) passes during
  // the pipes' grace period (2000 ms from the exit). The exit is not at a fixed time: node's own start on a busy
  // machine used up the old 300 ms of a 1000 ms limit, and the limit then ended a git that had not exited yet.
  const parent = `const { spawn } = require("child_process"); const fs = require("fs"); spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)", process.argv[1]], { stdio: "inherit" }); setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(0); }, 10);`;
  try {
    const result = await gitIn(dir, { executable: process.execPath, timeoutMs: 1900 })(["-e", parent, file]);
    assert.equal(result.code, 0);
  } finally {
    await endPidIn(file);
  }
});

test("a git that exits while something it started still holds its output settles anyway", async () => {
  const dir = tempDir();
  const file = join(dir, "pid");
  const parent = `const { spawn } = require("child_process"); spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)", process.argv[1]], { stdio: "inherit" }); setTimeout(() => process.exit(0), 300);`;
  try {
    const started = Date.now();
    const result = await gitIn(dir, { executable: process.execPath, timeoutMs: 20_000 })(["-e", parent, file]);
    assert.equal(result.code, 0);
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  } finally {
    await endPidIn(file);
  }
});

test("a plain subdirectory of another repository is refused, a submodule's folder is accepted", async () => {
  const outer = tempDir();
  run(outer, ["init", "--quiet"]);
  const inner = join(outer, "docs");
  mkdirSync(inner);
  await assert.rejects(createMetaBranchHost({ repoDir: inner }).work.listWork(), /is not the top level of a repository/);
  // Also inside a bare repository's folder.
  // A branch here, so the submodule's clone brings it (the fixed refs/scopesoup/meta is not a branch, and a clone does not fetch it).
  const branch = "refs/heads/scopesoup-meta";
  const bare = repoWith(branch, { "items/A-1/item.md": itemMd("A-1", "One", "todo") });
  mkdirSync(join(bare.dir, "sub"));
  await assert.rejects(createMetaBranchHost({ repoDir: join(bare.dir, "sub") }).work.listWork(), /is not the top level of a repository/);
  // A folder that is not in a repository at all.
  await assert.rejects(createMetaBranchHost({ repoDir: join(tempDir(), "nowhere") }).work.listWork(), /does not exist/);

  // The bare repository itself is fine, and so is a submodule's folder (its .git is a file).
  assert.equal((await createMetaBranchHost({ repoDir: bare.dir, ref: branch }).work.listWork()).items.length, 1);
  bare.git(["symbolic-ref", "HEAD", branch]);
  run(outer, ["submodule", "add", "--quiet", bare.dir, "meta"]);
  const submodule = join(outer, "meta");
  const host = createMetaBranchHost({ repoDir: submodule, ref: "refs/remotes/origin/scopesoup-meta" });
  assert.deepEqual((await host.work.listWork()).items.map((work) => work.ref.id), ["A-1"]);
});
