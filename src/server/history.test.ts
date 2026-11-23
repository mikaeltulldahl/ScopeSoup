// GET /api/history and /api/commit against a temporary repository: a main branch, two item branches
// (one still open, one merged on main) and a merge. All names are synthetic.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { T0, work } from "../core/testing.ts";
import type { CommitView, HistoryView } from "../core/views.ts";
import { git as gitIn, isolateGitConfig } from "../orchestrator/fixtures/git-env.ts";
import { commitView, projectHistory } from "../orchestrator/history.ts";
import { workBranch } from "../orchestrator/paths.ts";
import { realGit } from "../orchestrator/process.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";
import { loadSnapshot } from "./snapshot.ts";

const restore = isolateGitConfig();
const dir = mkdtempSync(join(tmpdir(), "scopesoup-history-"));
let store: Store;
let server: ScopeSoupServer;
let base: string;

const git = (...args: string[]): string => gitIn(dir, ...args);
function commit(file: string, text: string, message: string) {
  writeFileSync(join(dir, file), text);
  git("add", ".");
  git("commit", "-q", "-m", message);
}

before(async () => {
  git("init", "-q", "-b", "main");
  commit("a.txt", "one\n", "first");
  // Item 7 is merged: its branch was merged into main.
  git("checkout", "-q", "-b", workBranch(work(7).ref));
  commit("seven.txt", "seven <b>\n", "Add seven <script>alert(1)</script>\n\nA longer explanation.");
  git("checkout", "-q", "main");
  commit("b.txt", "two\n", "second on main");
  git("merge", "-q", "--no-ff", "-m", "Merge seven", workBranch(work(7).ref));
  // Item 8 is still open, off an older commit.
  git("checkout", "-q", "-b", workBranch(work(8).ref), "main~2");
  commit("eight.txt", "eight\n", "Start eight");
  git("checkout", "-q", "main");

  const checked = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: dir }, dir);
  if (!checked.ok) assert.fail(checked.errors.join("\n"));
  store = openStore(":memory:");
  store.put(work(7), "sync", T0);
  store.put(work(8), "sync", T0);
  const deps = { config: () => checked.config, git: realGit, now: () => new Date(T0) };
  server = createServer({
    store,
    port: 0,
    history: (limit) => projectHistory({ ...deps, works: () => loadSnapshot(store).works }, limit),
    commit: (sha) => commitView(deps, sha),
  });
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restore();
});

const history = async (query = "") => (await fetch(`${base}/api/history${query}`)).json() as Promise<HistoryView>;

test("the history has main, both item branches, the merge, and links the items", async () => {
  const view = await history();
  assert.ok(view.available);
  if (!view.available) return;
  assert.equal(view.commits.length, 5);
  assert.equal(view.more, false);
  assert.ok(view.lanes >= 2);
  const bySubject = Object.fromEntries(view.commits.map((each) => [each.subject, each]));
  const merge = bySubject["Merge seven"]!;
  assert.equal(merge.parents.length, 2);
  assert.equal(merge.onMain, true);
  assert.deepEqual(merge.refs, ["main"]);
  const open = bySubject["Start eight"]!;
  assert.equal(open.onMain, false);
  assert.equal(open.item, "demo:work:8");
  assert.equal(open.merged, undefined);
  assert.deepEqual(open.refs, [workBranch(work(8).ref)]);
  // Item 7's branch tip is reachable from main: it is merged.
  const seven = view.commits.find((each) => each.item === "demo:work:7")!;
  assert.equal(seven.onMain, true);
  assert.equal(seven.merged, true);
  // Text stays text.
  assert.match(seven.subject, /<script>/);
  // Every row has a lane drawn.
  for (const each of view.commits) assert.ok(each.graph.lane >= 0 && each.graph.lane < view.lanes);
});

test("the history is bounded to the newest commits", async () => {
  const view = await history("?limit=2");
  assert.ok(view.available);
  if (!view.available) return;
  assert.equal(view.commits.length, 2);
  assert.equal(view.more, true);
});

test("a commit opens its message and files", async () => {
  const view = await history();
  assert.ok(view.available);
  if (!view.available) return;
  const sha = view.commits.find((each) => each.item === "demo:work:7")!.sha;
  const opened = (await (await fetch(`${base}/api/commit?sha=${sha}`)).json()) as CommitView;
  assert.ok(opened.available);
  if (!opened.available) return;
  assert.match(opened.message, /^Add seven <script>alert\(1\)<\/script>\n\nA longer explanation\.$/);
  assert.deepEqual(opened.files.map((file) => file.path), ["seven.txt"]);
  assert.match(opened.files[0]!.diff!, /\+seven <b>/);
  // The root commit has no parent: its files are all added.
  const root = view.commits.find((each) => each.parents.length === 0)!;
  const first = (await (await fetch(`${base}/api/commit?sha=${root.sha}`)).json()) as CommitView;
  assert.ok(first.available && first.files.length === 1);
});

test("a bad or unknown commit id is refused or unavailable", async () => {
  assert.equal((await fetch(`${base}/api/commit?sha=--output=x`)).status, 400);
  assert.equal(((await (await fetch(`${base}/api/commit?sha=${"0".repeat(40)}`)).json()) as CommitView).available, false);
});
