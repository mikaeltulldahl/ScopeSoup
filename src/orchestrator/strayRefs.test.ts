// The leftover sweep over the simulator's fake git: what it removes, what it keeps and reports, and what it never touches.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { FakeGit } from "../sim/git.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import type { RefGit } from "./strayRefs.ts";
import { sweepLeftovers } from "./strayRefs.ts";

const AT = "2026-11-27T10:00:00.000Z";
const ref = (id: string) => ({ host: "metaBranch", kind: "work", id }) as const;
const work = (id: string, state: WorkItem["state"]): WorkItem => ({ ref: ref(id), title: `Item ${id}`, state, hostState: state === "done" ? "closed" : "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: AT });

/** An Item whose agent committed once on its branch. */
function started(store: Store, git: FakeGit, id: string): string {
  store.put(work(id, "doing"), "test", AT);
  git.ensureWorktree(`w-${id}`, `scopesoup/${id}`, refKey(ref(id)));
  const sha = git.commit([git.main], ["src/a.ts"], `work on ${id}`, "agent");
  git.branches.set(`scopesoup/${id}`, sha);
  return sha;
}

/** The agent's leftovers, named after its branch: a tag, an extra branch and a stash entry. */
function leave(git: FakeGit, id: string, at: string, stashSame?: string): string {
  git.tags.set(`scopesoup/${id}-wip`, at);
  git.owners.set(`refs/tags/scopesoup/${id}-wip`, { item: refKey(ref(id)), scopesoup: true });
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
const sweep = (store: Store, git: RefGit, live: { item: string; branch: string }[] = []) => sweepLeftovers({ store, git, at: AT, live });

describe("sweepLeftovers", { concurrency: 4 }, () => {
  test("a closed Item's stash, tag and branch that hold nothing unique are removed, one event per ref with its sha", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const head = started(store, git, "1");
    const stash = leave(git, "1", head, head);
    git.mergeToMain(head, "queue", refKey(ref("1")));
    close(store, git, "1");
    assert.deepEqual(await sweep(store, git.refGit()), { removed: 3, kept: 0 });
    assert.equal(git.tags.has("scopesoup/1-wip"), false);
    assert.equal(git.branches.has("scopesoup/1-extra"), false);
    assert.equal(git.stash.some((s) => s.sha === stash), false);
    const removed = kinds(store, "orchestrator.leftover_removed").map((e) => `${String(e.data.ref)}@${String(e.data.sha)}`).sort();
    assert.deepEqual(removed, [`refs/heads/scopesoup/1-extra@${head}`, `refs/stash@${stash}`, `refs/tags/scopesoup/1-wip@${head}`]);
    assert.equal(git.deleted.filter((d) => d.unmerged).length, 0);
    assert.ok(git.branches.has("feature/by-hand") && git.tags.has("v1.0") && git.stash.some((s) => !s.scopesoup));
  });

  test("a ref with commits found nowhere else is never deleted: it is reported once and not judged again", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const head = started(store, git, "2");
    const stash = leave(git, "2", head);
    close(store, git, "2");
    assert.deepEqual(await sweep(store, git.refGit()), { removed: 0, kept: 3 });
    assert.equal(git.tags.get("scopesoup/2-wip"), head);
    assert.equal(git.branches.get("scopesoup/2-extra"), head);
    assert.ok(git.stash.some((s) => s.sha === stash));
    assert.equal(git.deleted.length, 0);
    const kept = kinds(store, "orchestrator.leftover_kept");
    assert.equal(kept.length, 3);
    assert.ok(kept.every((e) => e.subject === "metaBranch:work:2" && typeof e.data.sha === "string"));
    let judged = 0;
    const counting: RefGit = { ...git.refGit(), refSafe: async () => (judged++, false), stashSafe: async () => (judged++, false) };
    assert.deepEqual(await sweep(store, counting), { removed: 0, kept: 0 });
    assert.equal(judged, 0);
    assert.equal(kinds(store, "orchestrator.leftover_kept").length, 3);
  });

  test("refs on the Item's pushed branch only are removed: nothing is lost", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const head = started(store, git, "3");
    leave(git, "3", head, head);
    git.remoteBranches.set("scopesoup/3", head);
    close(store, git, "3");
    assert.deepEqual(await sweep(store, git.refGit()), { removed: 3, kept: 0 });
  });

  test("an open Item's, or a live job's, leftovers stay", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const a = started(store, git, "4");
    leave(git, "4", a, a);
    git.mergeToMain(a, "queue", refKey(ref("4")));
    assert.deepEqual(await sweep(store, git.refGit()), { removed: 0, kept: 0 });
    close(store, git, "4");
    assert.deepEqual(await sweep(store, git.refGit(), [{ item: "metaBranch:work:4", branch: "scopesoup/4" }]), { removed: 0, kept: 0 });
    assert.ok(git.tags.has("scopesoup/4-wip"));
  });

  test("refs not named after the Item are never touched, even when nothing would be lost (I6)", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const head = started(store, git, "5");
    git.personRefs(1);
    git.tags.set("wip", head);
    git.tags.set("scopesoup/50", head);
    git.branches.set("scopesoup/5x", head);
    git.mergeToMain(head, "queue", refKey(ref("5")));
    close(store, git, "5");
    const before = { tags: new Map(git.tags), branches: new Map(git.branches), stash: git.stash.length };
    assert.deepEqual(await sweep(store, git.refGit()), { removed: 0, kept: 0 });
    assert.deepEqual(git.tags, before.tags);
    assert.deepEqual(git.branches, before.branches);
    assert.equal(git.stash.length, before.stash);
    assert.equal(store.eventsAfter(0, 1000).filter((e) => e.kind.startsWith("orchestrator.leftover_")).length, 0);
  });

  test("a ref that cannot be judged is reported once and judged again later; an annotated tag is kept", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const head = started(store, git, "6");
    git.branches.set("scopesoup/6-extra", head);
    git.tags.set("scopesoup/6", head);
    git.mergeToMain(head, "queue", refKey(ref("6")));
    close(store, git, "6");
    const real = git.refGit();
    const broken: RefGit = {
      ...real,
      refs: async () => new Map([...(await real.refs())].map(([name, info]) => [name, { ...info, annotated: name.startsWith("refs/tags/") }])),
      refSafe: async () => {
        throw new Error("refs/remotes/origin/main is not there");
      },
    };
    assert.deepEqual(await sweep(store, broken), { removed: 0, kept: 1 });
    assert.deepEqual(await sweep(store, broken), { removed: 0, kept: 0 });
    assert.equal(kinds(store, "orchestrator.leftover_unjudged").length, 1);
    assert.equal(kinds(store, "orchestrator.leftover_kept")[0]!.data.ref, "refs/tags/scopesoup/6");
    assert.deepEqual(await sweep(store, real), { removed: 1, kept: 0 });
    assert.equal(git.branches.has("scopesoup/6-extra"), false);
    assert.ok(git.tags.has("scopesoup/6"));
  });

  test("a deletion that fails is reported once and not tried, nor announced, again", async () => {
    const store = openStore(":memory:");
    const git = new FakeGit();
    const head = started(store, git, "7");
    git.branches.set("scopesoup/7-extra", head);
    git.mergeToMain(head, "queue", refKey(ref("7")));
    close(store, git, "7");
    const failing: RefGit = { ...git.refGit(), deleteRef: async () => {
      throw new Error("cannot lock ref");
    } };
    await sweep(store, failing);
    await sweep(store, failing);
    assert.equal(kinds(store, "orchestrator.leftover_removed").length, 1);
    assert.equal(kinds(store, "orchestrator.leftover_not_removed").length, 1);
    assert.ok(git.branches.has("scopesoup/7-extra"));
  });
});
