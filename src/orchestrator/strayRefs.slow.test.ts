// The leftover sweep over real git: Scope Soup's clone of a throwaway remote, a reused worktree of it, and an agent's stash entry,
// tag and extra branch left behind when its Item closes.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { WorkItem } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { git, isolateGitConfig } from "./fixtures/git-env.ts";
import { realGit } from "./process.ts";
import { gitRefs, noteBaseline, sweepLeftovers } from "./strayRefs.ts";

const AT = "2026-11-27T10:00:00.000Z";
const ITEM = "metaBranch:work:7";
const restoreGitConfig = isolateGitConfig();
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restoreGitConfig();
});

const work = (state: WorkItem["state"]): WorkItem => ({ ref: { host: "metaBranch", kind: "work", id: "7" }, title: "Item 7", state, hostState: state === "done" ? "closed" : "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: AT });

interface Setup {
  remote: string;
  clone: string;
  slot: string;
  store: Store;
  refs: ReturnType<typeof gitRefs>;
}

/** A remote with a person's tag, Scope Soup's clone with a person's branch and stash entry, the Item's baseline, and its worktree. */
async function setup(): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-strayrefs-"));
  dirs.push(dir);
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  const clone = join(dir, "clone");
  const slot = join(dir, "slot-1");
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(dir, "init", "--quiet", "--initial-branch=main", seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", "a.txt");
  git(seed, "commit", "--quiet", "-m", "start");
  git(seed, "tag", "v1.0");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--quiet", "origin", "main", "v1.0");
  git(dir, "clone", "--quiet", remote, clone);
  git(clone, "branch", "feature/by-hand");
  writeFileSync(join(clone, "a.txt"), "a person's edit\n");
  git(clone, "stash", "push", "--quiet", "-m", "a person's");
  const store = openStore(":memory:");
  const refs = gitRefs(realGit, clone, "origin", "main");
  // As the Item takes the worktree: the refs then are its baseline.
  await noteBaseline(refs, ITEM);
  store.put(work("doing"), "test", AT);
  git(clone, "worktree", "add", "--quiet", "--detach", slot, "origin/main");
  git(slot, "checkout", "--quiet", "-b", "scopesoup/7");
  return { remote, clone, slot, store, refs };
}

/** The agent's work: a commit, then a stash entry, a tag and an extra branch. `stashedCommitted`: its stashed change is also committed. */
function agent(slot: string, stashedCommitted: boolean): string {
  writeFileSync(join(slot, "b.txt"), "the agent's work\n");
  git(slot, "add", "b.txt");
  git(slot, "commit", "--quiet", "-m", "work on 7");
  git(slot, "tag", "wip-7");
  git(slot, "branch", "scopesoup/7-extra");
  writeFileSync(join(slot, "c.txt"), "more\n");
  git(slot, "stash", "push", "--quiet", "--include-untracked", "-m", "agent");
  if (stashedCommitted) {
    writeFileSync(join(slot, "c.txt"), "more\n");
    git(slot, "add", "c.txt");
    git(slot, "commit", "--quiet", "-m", "more on 7");
  }
  return git(slot, "rev-parse", "HEAD");
}

/** The Item closes: its worktree is freed (detached, as a released slot is). */
function close(s: Setup): void {
  git(s.slot, "checkout", "--quiet", "--detach");
  s.store.put(work("done"), "test", AT);
}

const has = (repo: string, ref: string): boolean => {
  try {
    git(repo, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};
const stashCount = (repo: string): number => git(repo, "stash", "list").split("\n").filter(Boolean).length;
const events = (store: Store, kind: string) => store.eventsAfter(0, 1000).filter((e) => e.kind === kind).map((e) => e.data as Record<string, unknown>);

describe("sweepLeftovers over real git", { concurrency: 2 }, () => {
  test("pushed work: the stash entry, tag and branch go, one event per ref with its sha; a person's refs and a fetched tag stay", async () => {
    const s = await setup();
    agent(s.slot, true);
    git(s.slot, "push", "--quiet", "origin", "scopesoup/7");
    const tag = git(s.clone, "rev-parse", "refs/tags/wip-7");
    const stash = git(s.clone, "rev-parse", "refs/stash");
    // A person tags main on the remote meanwhile; the next fetch brings the tag into the clone.
    git(s.clone, "push", "--quiet", "origin", "refs/remotes/origin/main:refs/tags/v2.0");
    git(s.clone, "fetch", "--quiet", "--tags", "origin");
    close(s);
    const result = await sweepLeftovers({ store: s.store, git: s.refs, at: AT, live: [] });
    assert.deepEqual(result, { removed: 3, kept: 0 });
    assert.equal(has(s.clone, "refs/tags/wip-7"), false);
    assert.equal(has(s.clone, "refs/heads/scopesoup/7-extra"), false);
    assert.equal(stashCount(s.clone), 1, "the person's stash entry stays");
    assert.ok(has(s.clone, "refs/tags/v1.0") && has(s.clone, "refs/tags/v2.0") && has(s.clone, "refs/heads/feature/by-hand") && has(s.clone, "refs/heads/scopesoup/7"));
    const removed = events(s.store, "orchestrator.leftover_removed").map((d) => `${String(d.ref)}@${String(d.sha)}`).sort();
    assert.deepEqual(removed, [`refs/heads/scopesoup/7-extra@${tag}`, `refs/stash@${stash}`, `refs/tags/wip-7@${tag}`]);
  });

  test("work found nowhere else: nothing is deleted, each ref is reported once with its sha", async () => {
    const s = await setup();
    agent(s.slot, false);
    const tag = git(s.clone, "rev-parse", "refs/tags/wip-7");
    close(s);
    const result = await sweepLeftovers({ store: s.store, git: s.refs, at: AT, live: [] });
    assert.deepEqual(result, { removed: 0, kept: 3 });
    assert.equal(git(s.clone, "rev-parse", "refs/tags/wip-7"), tag);
    assert.equal(git(s.clone, "rev-parse", "refs/heads/scopesoup/7-extra"), tag);
    assert.equal(stashCount(s.clone), 2);
    const kept = events(s.store, "orchestrator.leftover_kept");
    assert.deepEqual(kept.map((d) => String(d.ref)).sort(), ["refs/heads/scopesoup/7-extra", "refs/stash", "refs/tags/wip-7"]);
    assert.ok(kept.every((d) => typeof d.sha === "string" && (d.sha as string).length === 40));
  });
});
