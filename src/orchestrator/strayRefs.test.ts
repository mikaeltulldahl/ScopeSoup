// The leftover sweep over the simulator's fake git: what it removes, what it keeps and reports, and what it never touches.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { FakeGit } from "../sim/git.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { noteBaseline, sweepLeftovers } from "./strayRefs.ts";

const AT = "2026-11-27T10:00:00.000Z";
const ref = (id: string) => ({ host: "metaBranch", kind: "work", id }) as const;
const work = (id: string, state: WorkItem["state"]): WorkItem => ({ ref: ref(id), title: `Item ${id}`, state, hostState: state === "done" ? "closed" : "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: AT });

/** An Item that took a worktree (baseline noted), whose agent committed once on its branch. */
async function started(store: Store, git: FakeGit, id: string): Promise<string> {
  await noteBaseline(git.refGit(), refKey(ref(id)));
  store.put(work(id, "doing"), "test", AT);
  git.ensureWorktree(`w-${id}`, `scopesoup/${id}`, refKey(ref(id)));
  const sha = git.commit([git.main], ["src/a.ts"], `work on ${id}`, "agent");
  git.branches.set(`scopesoup/${id}`, sha);
  return sha;
}

function leave(git: FakeGit, id: string, at: string, stashSame?: string): string {
  git.tags.set(`wip-${id}`, at);
  git.owners.set(`refs/tags/wip-${id}`, { item: refKey(ref(id)), scopesoup: true });
  git.branches.set(`scopesoup/${id}-extra`, at);
  git.owners.set(`refs/heads/scopesoup/${id}-extra`, { item: refKey(ref(id)), scopesoup: true });
  const stash = git.commit([at], [], `WIP on scopesoup/${id}`, "agent");
  git.stash.push({ workspace: `w-${id}`, item: refKey(ref(id)), scopesoup: true, sha: stash, branch: `scopesoup/${id}`, ...(stashSame ? { same: stashSame } : {}) });
  return stash;
}

function close(store: Store, git: FakeGit, id: string): void {
  store.put(work(id, "done"), "test", AT);
  git.removeWorktree(`w-${id}`);
}

const kinds = (store: Store, kind: string) => store.eventsAfter(0, 1000).filter((e) => e.kind === kind).map((e) => ({ ...e, data: e.data as Record<string, unknown> }));

describe("sweepLeftovers", { concurrency: 4 }, () => {
  test("a closed Item's stash, tag and branch that hold nothing unique are removed, one event per ref with its sha", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const head = await started(store, git, "1");
    const stash = leave(git, "1", head, head);
    git.mergeToMain(head, "queue", refKey(ref("1")));
    close(store, git, "1");
    const result = await sweepLeftovers({ store, git: git.refGit(), at: AT, live: [] });
    assert.deepEqual(result, { removed: 3, kept: 0 });
    assert.equal(git.tags.has("wip-1"), false);
    assert.equal(git.branches.has("scopesoup/1-extra"), false);
    assert.equal(git.stash.some((s) => s.sha === stash), false);
    const removed = kinds(store, "orchestrator.leftover_removed").map((e) => `${String(e.data.ref)}@${String(e.data.sha)}`).sort();
    assert.deepEqual(removed, [`refs/heads/scopesoup/1-extra@${head}`, `refs/stash@${stash}`, `refs/tags/wip-1@${head}`]);
    assert.equal(git.deleted.filter((d) => d.unmerged).length, 0);
    // A person's refs, there before the Item started, are untouched (I6), and the baseline is gone.
    assert.ok(git.branches.has("feature/by-hand") && git.tags.has("v1.0") && git.stash.some((s) => !s.scopesoup));
    assert.equal(git.baselines["metaBranch:work:1"], undefined);
  });

  test("a ref with commits found nowhere else is never deleted: it is reported once and kept", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const head = await started(store, git, "2");
    const stash = leave(git, "2", head);
    close(store, git, "2");
    const result = await sweepLeftovers({ store, git: git.refGit(), at: AT, live: [] });
    assert.deepEqual(result, { removed: 0, kept: 3 });
    assert.equal(git.tags.get("wip-2"), head);
    assert.equal(git.branches.get("scopesoup/2-extra"), head);
    assert.ok(git.stash.some((s) => s.sha === stash));
    assert.equal(git.deleted.length, 0);
    const kept = kinds(store, "orchestrator.leftover_kept");
    assert.equal(kept.length, 3);
    assert.ok(kept.every((e) => e.subject === "metaBranch:work:2" && typeof e.data.sha === "string"));
    // Seen again (the Item reopened and closed, say): not reported twice.
    git.baselines["metaBranch:work:2"] = ["refs/heads/main"];
    await sweepLeftovers({ store, git: git.refGit(), at: AT, live: [] });
    assert.equal(kinds(store, "orchestrator.leftover_kept").length, 3);
  });

  test("refs on the Item's pushed branch only are removed: nothing is lost", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const head = await started(store, git, "3");
    leave(git, "3", head, head);
    git.remoteBranches.set("scopesoup/3", head);
    close(store, git, "3");
    assert.deepEqual(await sweepLeftovers({ store, git: git.refGit(), at: AT, live: [] }), { removed: 3, kept: 0 });
  });

  test("an open Item's, or a live job's, leftovers stay", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const a = await started(store, git, "4");
    leave(git, "4", a, a);
    git.mergeToMain(a, "queue", refKey(ref("4")));
    assert.deepEqual(await sweepLeftovers({ store, git: git.refGit(), at: AT, live: [] }), { removed: 0, kept: 0 });
    close(store, git, "4");
    assert.deepEqual(await sweepLeftovers({ store, git: git.refGit(), at: AT, live: [{ item: "metaBranch:work:4", branch: "scopesoup/4" }] }), { removed: 0, kept: 0 });
    assert.ok(git.tags.has("wip-4"));
  });

  test("a unique tag new since another live job's baseline is left for that job's close", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    await started(store, git, "5");
    const b = await started(store, git, "6");
    // Item 6's agent tags its own work; Item 5 closes first: the tag may be 6's, so 5 does not report it.
    git.tags.set("try", b);
    git.owners.set("refs/tags/try", { item: "metaBranch:work:6", scopesoup: true });
    close(store, git, "5");
    assert.deepEqual(await sweepLeftovers({ store, git: git.refGit(), at: AT, live: [{ item: "metaBranch:work:6", branch: "scopesoup/6" }] }), { removed: 0, kept: 0 });
    close(store, git, "6");
    assert.deepEqual(await sweepLeftovers({ store, git: git.refGit(), at: AT, live: [] }), { removed: 0, kept: 1 });
    assert.equal(kinds(store, "orchestrator.leftover_kept")[0]!.subject, "metaBranch:work:6");
  });
});
