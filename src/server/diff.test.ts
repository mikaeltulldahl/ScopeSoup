// GET /api/diff against a temporary repository: the item's worktree is on its branch, which adds,
// changes and deletes a file and adds a binary one, while main has moved on. All names are synthetic.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { ref, T0, work } from "../core/testing.ts";
import type { DiffView } from "../core/views.ts";
import { itemDiff, MAX_FILE_LINES } from "../orchestrator/diff.ts";
import { git, isolateGitConfig } from "../orchestrator/fixtures/git-env.ts";
import { workBranch, workspaceKey } from "../orchestrator/paths.ts";
import { realGit } from "../orchestrator/process.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

const restore = isolateGitConfig();
const dir = mkdtempSync(join(tmpdir(), "scopesoup-diff-"));
let store: Store;
let server: ScopeSoupServer;
let base: string;

before(async () => {
  const item = ref("work", 7);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "keep.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "gone.txt"), "bye\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  const spaces = join(dir, "spaces");
  mkdirSync(spaces);
  const clone = join(spaces, workspaceKey(item));
  git(dir, "clone", "-q", repo, clone);
  git(clone, "checkout", "-q", "-b", workBranch(item));
  writeFileSync(join(clone, "keep.txt"), "one\nTWO <b>bold</b>\nthree\n");
  writeFileSync(join(clone, "new.txt"), "fresh\n");
  writeFileSync(join(clone, "big.txt"), "x\n".repeat(MAX_FILE_LINES + 1));
  writeFileSync(join(clone, "pic.bin"), Buffer.from([0, 1, 2, 0, 255]));
  git(clone, "rm", "-q", "gone.txt");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "the change");
  // Main moves on afterwards: its own change must not show in the item's diff.
  writeFileSync(join(repo, "later.txt"), "later\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "later");
  git(clone, "fetch", "-q", "origin");

  const checked = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: repo, workspacesDir: spaces }, dir);
  if (!checked.ok) assert.fail(checked.errors.join("\n"));
  store = openStore(":memory:");
  store.put(work(7), "sync", T0);
  store.put(work(8), "sync", T0);
  const deps = { store, config: () => checked.config, git: realGit, now: () => new Date(T0) };
  server = createServer({ store, port: 0, diff: (each) => itemDiff(deps, each) });
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restore();
});

const read = async (key: string) => (await fetch(`${base}/api/diff?ref=${encodeURIComponent(key)}`)).json() as Promise<DiffView>;

test("the diff lists added, changed, deleted, binary and large files against where the branch left main", async () => {
  const view = await read("demo:work:7");
  assert.ok(view.available);
  if (!view.available) return;
  const files = Object.fromEntries(view.files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(files).sort(), ["big.txt", "gone.txt", "keep.txt", "new.txt", "pic.bin"]);
  assert.deepEqual([files["new.txt"]!.added, files["new.txt"]!.removed], [1, 0]);
  assert.deepEqual([files["gone.txt"]!.added, files["gone.txt"]!.removed], [0, 1]);
  assert.deepEqual([files["keep.txt"]!.added, files["keep.txt"]!.removed], [1, 1]);
  // Text is returned as text, markup and all, for the page to show as text.
  assert.match(files["keep.txt"]!.diff!, /\+TWO <b>bold<\/b>/);
  assert.match(files["gone.txt"]!.diff!, /-bye/);
  assert.equal(files["pic.bin"]!.binary, true);
  assert.equal(files["pic.bin"]!.diff, undefined);
  assert.match(files["pic.bin"]!.note!, /Binary/);
  assert.equal(files["big.txt"]!.diff, undefined);
  assert.match(files["big.txt"]!.note!, /Too large/);
  assert.equal(view.omitted, 0);
});

test("an item without a branch is unavailable, and an unknown item is 404", async () => {
  assert.equal((await read("demo:work:8")).available, false);
  assert.equal((await fetch(`${base}/api/diff?ref=demo:work:99`)).status, 404);
});
