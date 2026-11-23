// Uncommitted work kept as a patch when a worktree is removed when the Item is parked, and put back after.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { git, isolateGitConfig } from "./fixtures/git-env.ts";
import { realGit } from "./process.ts";
import { ensureWorktree, removeWorktree } from "./worktree.ts";
import { restoreWip, saveWip, wipPatchPath } from "./wip.ts";

const restoreGitConfig = isolateGitConfig();
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restoreGitConfig();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-wip-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  const spec = { repoPath: repo, path: join(dir, "wt"), branch: "scopesoup/1", mainBranch: "main", remote: "origin" };
  return { dir, repo, spec, patch: wipPatchPath(join(dir, "streams"), "github_work_1") };
}

test("an uncommitted edit and a new file survive the removal of the worktree and come back uncommitted", async () => {
  const r = setup();
  await ensureWorktree(realGit, r.spec);
  writeFileSync(join(r.spec.path, "a.txt"), "edited\n");
  writeFileSync(join(r.spec.path, "new.txt"), "new\n");
  assert.equal(await saveWip(realGit, r.spec.path, r.patch), true);
  await removeWorktree(realGit, r.repo, r.spec.path);
  assert.equal(existsSync(r.spec.path), false);

  await ensureWorktree(realGit, r.spec);
  assert.equal(readFileSync(join(r.spec.path, "a.txt"), "utf8"), "a\n", "a fresh worktree is clean");
  const note = await restoreWip(realGit, r.spec.path, r.patch);
  assert.match(note ?? "", /not committed/);
  assert.equal(readFileSync(join(r.spec.path, "a.txt"), "utf8"), "edited\n");
  assert.equal(readFileSync(join(r.spec.path, "new.txt"), "utf8"), "new\n");
  assert.equal(git(r.spec.path, "log", "--oneline", "-n", "5").split("\n").length, 1, "nothing was committed");
  assert.equal(existsSync(r.patch), false, "the patch is used up");
});

test("a clean worktree keeps no patch, and restoring without one says nothing", async () => {
  const r = setup();
  await ensureWorktree(realGit, r.spec);
  assert.equal(await saveWip(realGit, r.spec.path, r.patch), false);
  assert.equal(await restoreWip(realGit, r.spec.path, r.patch), null);
});

test("a patch that does not apply is kept and the note says so", async () => {
  const r = setup();
  await ensureWorktree(realGit, r.spec);
  writeFileSync(join(r.spec.path, "a.txt"), "edited\n");
  await saveWip(realGit, r.spec.path, r.patch);
  await removeWorktree(realGit, r.repo, r.spec.path);
  // The branch moved on in the same lines, so the patch no longer fits.
  await ensureWorktree(realGit, r.spec);
  writeFileSync(join(r.spec.path, "a.txt"), "other\n");
  git(r.spec.path, "commit", "-q", "-am", "other");
  const note = await restoreWip(realGit, r.spec.path, r.patch);
  assert.match(note ?? "", /do not apply cleanly/);
  assert.ok(note?.includes(r.patch));
  assert.equal(existsSync(r.patch), true, "not dropped");
  assert.equal(readFileSync(join(r.spec.path, "a.txt"), "utf8"), "other\n");
});
