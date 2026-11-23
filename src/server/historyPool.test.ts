// History of a project that is a folder of its own repository inside each clone of a pool
// (`projectSubdir`): it reads the project's repository, not the outer one. Names are synthetic.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { T0, work } from "../core/testing.ts";
import type { CommitView, HistoryView } from "../core/views.ts";
import { git, isolateGitConfig } from "../orchestrator/fixtures/git-env.ts";
import { commitView, projectHistory } from "../orchestrator/history.ts";
import { workBranch } from "../orchestrator/paths.ts";
import { realGit } from "../orchestrator/process.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";
import { loadSnapshot } from "./snapshot.ts";

const restore = isolateGitConfig();
const dir = realpathSync(mkdtempSync(join(tmpdir(), "scopesoup-history-pool-")));
let store: Store;
let server: ScopeSoupServer;
let base: string;
let itemSha = "";

function commitFile(repo: string, file: string, message: string): void {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", message);
}

before(async () => {
  // The outer repository Scope Soup is configured with: one commit of its own.
  const outer = join(dir, "outer");
  mkdirSync(outer);
  git(outer, "init", "-q", "-b", "main");
  commitFile(outer, "o.txt", "outer only");

  // The project's own repository, and a pool of two clones that hold it in libs/proj.
  const project = join(dir, "project-src");
  mkdirSync(project);
  git(project, "init", "-q", "-b", "main");
  commitFile(project, "one.txt", "project one");
  commitFile(project, "two.txt", "project two");
  const repos = ["one", "two"].map((name) => {
    const clone = join(dir, "pool", name);
    mkdirSync(join(clone, "libs"), { recursive: true });
    const repo = join(clone, "libs", "proj");
    git(clone, "clone", "-q", project, repo);
    return repo;
  });
  // An item branch in the second clone only, one commit past main.
  git(repos[1]!, "checkout", "-q", "-b", workBranch(work(8).ref));
  commitFile(repos[1]!, "eight.txt", "Start eight");
  itemSha = git(repos[1]!, "rev-parse", "HEAD");

  const checked = validateConfig(
    { project: "tides", machineName: "laptop-a", repoPath: outer, workspaces: { kind: "pool", paths: [join(dir, "pool", "one"), join(dir, "pool", "two")], projectSubdir: "libs/proj" } },
    dir,
  );
  if (!checked.ok) assert.fail(checked.errors.join("\n"));
  store = openStore(":memory:");
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

test("with a projectSubdir the history is the project's, with an item branch from any clone", async () => {
  const view = (await (await fetch(`${base}/api/history`)).json()) as HistoryView;
  assert.ok(view.available);
  if (!view.available) return;
  assert.deepEqual(view.commits.map((each) => each.subject), ["Start eight", "project two", "project one"]);
  const open = view.commits[0]!;
  assert.equal(open.item, "demo:work:8");
  assert.equal(open.onMain, false);
  assert.deepEqual(open.refs, [workBranch(work(8).ref)]);
  assert.equal(view.commits[1]!.onMain, true);
  assert.ok(view.commits[1]!.refs.includes("main"));
  // A commit that only a clone other than the first has can still be opened.
  const opened = (await (await fetch(`${base}/api/commit?sha=${itemSha}`)).json()) as CommitView;
  assert.ok(opened.available);
  if (!opened.available) return;
  assert.deepEqual(opened.files.map((file) => file.path), ["eight.txt"]);
});
