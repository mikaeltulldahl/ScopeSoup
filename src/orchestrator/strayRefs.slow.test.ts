// The leftover sweep over real git: a clone of a throwaway remote, a reused worktree of it, and an agent's stash entry, tag and
// extra branch left behind when its Item closes, next to a person's own refs.

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
import { gitRefs, sweepLeftovers } from "./strayRefs.ts";

const AT = "2026-11-27T10:00:00.000Z";
const restoreGitConfig = isolateGitConfig();
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restoreGitConfig();
});

const work = (state: WorkItem["state"]): WorkItem => ({ ref: { host: "metaBranch", kind: "work", id: "7" }, title: "Item 7", state, hostState: state === "done" ? "closed" : "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: AT });

interface Setup {
  clone: string;
  slot: string;
  store: Store;
  refs: ReturnType<typeof gitRefs>;
}

/** A remote with a person's tag, a clone with a person's branch and stash entry, and the Item's worktree on its branch. */
function setup(): Setup {
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
  store.put(work("doing"), "test", AT);
  git(clone, "worktree", "add", "--quiet", "--detach", slot, "origin/main");
  git(slot, "checkout", "--quiet", "-b", "scopesoup/7");
  return { clone, slot, store, refs: gitRefs(realGit, clone, "origin", "main") };
}

/**
 * The agent's work: a commit, then a tag, an extra branch and a stash entry with a staged change and an untracked file.
 * `stashedCommitted`: the stashed changes are committed afterwards too.
 */
function agent(slot: string, stashedCommitted: boolean): void {
  writeFileSync(join(slot, "b.txt"), "the agent's work\n");
  git(slot, "add", "b.txt");
  git(slot, "commit", "--quiet", "-m", "work on 7");
  git(slot, "tag", "scopesoup/7-wip");
  git(slot, "branch", "scopesoup/7-extra");
  writeFileSync(join(slot, "a.txt"), "two\n");
  git(slot, "add", "a.txt");
  writeFileSync(join(slot, "c.txt"), "more\n");
  git(slot, "stash", "push", "--quiet", "--include-untracked", "-m", "agent");
  if (stashedCommitted) {
    writeFileSync(join(slot, "a.txt"), "two\n");
    writeFileSync(join(slot, "c.txt"), "more\n");
    git(slot, "add", "a.txt", "c.txt");
    git(slot, "commit", "--quiet", "-m", "more on 7");
  }
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
const sweep = (s: Setup) => sweepLeftovers({ store: s.store, git: s.refs, at: AT, live: [] });

describe("sweepLeftovers over real git", { concurrency: 3 }, () => {
  test("pushed work: the stash entry, tag and branch go, one event per ref with its sha; a person's refs and an annotated tag stay", async () => {
    const s = setup();
    agent(s.slot, true);
    git(s.slot, "push", "--quiet", "origin", "scopesoup/7");
    const tag = git(s.clone, "rev-parse", "refs/tags/scopesoup/7-wip");
    const stash = git(s.clone, "rev-parse", "refs/stash");
    // A person works in the clone meanwhile, at the Item's work (all on the remote): their refs are never the agent's.
    git(s.clone, "tag", "v2.0", tag);
    git(s.clone, "branch", "person/try", tag);
    git(s.clone, "tag", "-a", "-m", "a note", "scopesoup/7-note", tag);
    close(s);
    assert.deepEqual(await sweep(s), { removed: 3, kept: 1 });
    assert.equal(has(s.clone, "refs/tags/scopesoup/7-wip"), false);
    assert.equal(has(s.clone, "refs/heads/scopesoup/7-extra"), false);
    assert.equal(stashCount(s.clone), 1, "the person's stash entry stays");
    for (const ref of ["refs/tags/v1.0", "refs/tags/v2.0", "refs/heads/feature/by-hand", "refs/heads/person/try", "refs/tags/scopesoup/7-note", "refs/heads/scopesoup/7"]) assert.ok(has(s.clone, ref), ref);
    const removed = events(s.store, "orchestrator.leftover_removed").map((d) => `${String(d.ref)}@${String(d.sha)}`).sort();
    assert.deepEqual(removed, [`refs/heads/scopesoup/7-extra@${tag}`, `refs/stash@${stash}`, `refs/tags/scopesoup/7-wip@${tag}`]);
    // Swept again: nothing new is said.
    const said = s.store.eventsAfter(0, 1000).length;
    assert.deepEqual(await sweep(s), { removed: 0, kept: 0 });
    assert.equal(s.store.eventsAfter(0, 1000).length, said);
  });

  test("work found nowhere else: nothing is deleted, each ref is reported once with its sha", async () => {
    const s = setup();
    agent(s.slot, false);
    const tag = git(s.clone, "rev-parse", "refs/tags/scopesoup/7-wip");
    close(s);
    assert.deepEqual(await sweep(s), { removed: 0, kept: 3 });
    assert.equal(git(s.clone, "rev-parse", "refs/tags/scopesoup/7-wip"), tag);
    assert.equal(git(s.clone, "rev-parse", "refs/heads/scopesoup/7-extra"), tag);
    assert.equal(stashCount(s.clone), 2);
    const kept = events(s.store, "orchestrator.leftover_kept");
    assert.deepEqual(kept.map((d) => String(d.ref)).sort(), ["refs/heads/scopesoup/7-extra", "refs/stash", "refs/tags/scopesoup/7-wip"]);
    assert.ok(kept.every((d) => typeof d.sha === "string" && (d.sha as string).length === 40));
  });

  test("a stash entry whose staged change is found nowhere else is kept, though its work tree is on the remote", async () => {
    const s = setup();
    writeFileSync(join(s.slot, "a.txt"), "staged\n");
    git(s.slot, "add", "a.txt");
    writeFileSync(join(s.slot, "a.txt"), "one\n");
    git(s.slot, "stash", "push", "--quiet", "-m", "agent");
    close(s);
    assert.deepEqual(await sweep(s), { removed: 0, kept: 1 });
    assert.equal(stashCount(s.clone), 2);
  });

  test("with no remote main to compare with, nothing is removed: it is reported once as not judged", async () => {
    const s = setup();
    agent(s.slot, true);
    git(s.clone, "update-ref", "-d", "refs/remotes/origin/main");
    close(s);
    assert.deepEqual(await sweep(s), { removed: 0, kept: 0 });
    assert.equal(events(s.store, "orchestrator.leftover_unjudged").length, 3);
    await sweep(s);
    assert.equal(events(s.store, "orchestrator.leftover_unjudged").length, 3);
    assert.ok(has(s.clone, "refs/tags/scopesoup/7-wip") && has(s.clone, "refs/heads/scopesoup/7-extra"));
  });
});
