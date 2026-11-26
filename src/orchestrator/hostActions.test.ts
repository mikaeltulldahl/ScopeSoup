import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import type { Host, WorkPatch } from "../ports/host.ts";
import { openStore } from "../store/store.ts";
import { createHostActions } from "./hostActions.ts";
import type { Git } from "./process.ts";

const T0 = "2026-01-01T00:00:00Z";
const item: WorkItem = { ref: { host: "github", kind: "work", id: "7" }, title: "Cache tide data", state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: T0 };

function world(level = 0) {
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone", level }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const git: { args: string[]; cwd: string }[] = [];
  const fakeGit: Git = async (args, cwd) => {
    git.push({ args, cwd });
    return { code: 0, stdout: "", stderr: "" };
  };
  const comments: { subject: Ref; markdown: string }[] = [];
  const host: Host = {
    info: { id: "github", capabilities: new Set(["write"]), whoami: async () => ({ id: "me", name: "me" }) },
    write: {
      async comment(subject, markdown) {
        comments.push({ subject, markdown });
      },
    },
  };
  const store = openStore(":memory:");
  const actions = createHostActions({ host, git: fakeGit, config: () => result.config, store });
  return { actions, git, comments, store };
}

test("a merged item is closed with a comment naming the commit and the batch; without writes it is left to a person", async () => {
  const w = world();
  const closed: { work: Ref; comment: string }[] = [];
  const host: Host = {
    info: { id: "github", capabilities: new Set(["write"]), whoami: async () => ({ id: "me", name: "me" }) },
    write: { async closeWork(work, comment) { closed.push({ work, comment }); } },
  };
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store: w.store });
  assert.equal(await actions.closeMerged!(item.ref, { sha: "180c44b1111", target: "main", batch: 1 }), "closed");
  assert.equal(closed.length, 1);
  assert.match(closed[0]!.comment, /^Merged on main as 180c44b in batch 1\./);
  assert.equal(await actions.closeMerged!({ host: "local", kind: "work", id: "1" }, { sha: "abc", target: "main" }), "not-needed");
  assert.equal(closed.length, 1);
  const readOnly = createHostActions({ host: { info: host.info }, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store: w.store });
  assert.equal(await readOnly.closeMerged!(item.ref, { sha: "abc", target: "main" }), "by-hand");
});

test("on the meta branch a merged item is marked done by Scope Soup itself", async () => {
  const w = world();
  const patches: { work: Ref; state?: string }[] = [];
  const host: Host = {
    info: { id: "local", capabilities: new Set(["write"]), whoami: async () => ({ id: "me", name: "me" }) },
    write: { async appendLog() { return { shared: "local" } as never; }, async editWork(work, patch) { patches.push({ work, ...(patch.state ? { state: patch.state } : {}) }); return {} as never; } },
  };
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store: w.store });
  assert.equal(actions.closesItself, true);
  const local: Ref = { host: "local", kind: "work", id: "1" };
  assert.equal(await actions.closeMerged!(local, { sha: "abc", target: "main" }), "closed");
  assert.deepEqual(patches, [{ work: local, state: "done" }]);
});

test("items of another host are left alone", async () => {
  const w = world();
  const local: Ref = { host: "local", kind: "work", id: "1" };
  await w.actions.answerTurn(local, "decision", "Which?");
  await w.actions.release(local, "x");
  assert.deepEqual([w.git.length, w.comments.length], [0, 0]);
});

test("a question for a person is written on the item, and its text is made inert", async () => {
  const w = world(3);
  await w.actions.answerTurn(item.ref, "decision", "Keep the old name or the new one?");
  await w.actions.answerTurn(item.ref, "handover", "Resolves #8, ask @bob");
  assert.deepEqual(w.comments.map((comment) => comment.subject.id), ["7", "7"]);
  assert.match(w.comments[0]!.markdown, /^\*\*A decision is needed\*\*\n\nKeep the old name or the new one\?\n\nAnswer on Scope Soup's board/);
  assert.match(w.comments[1]!.markdown, /^\*\*Waiting for you to merge it\*\*/);
  assert.doesNotMatch(w.comments[1]!.markdown, /Resolves|@b/);
});

test("blockers go to the item's own blockedBy field where Scope Soup keeps the item's log; a host without editWork gets no such action", async () => {
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const ref = (id: string): Ref => ({ host: "metaBranch", kind: "work", id });
  const edits: unknown[] = [];
  const lines: string[] = [];
  const current: WorkItem = { ...item, ref: ref("A-2"), blockedBy: [ref("A-1")] };
  const meta: Host = {
    info: { id: "metaBranch", capabilities: new Set(["write"]), whoami: async () => ({ id: "me", name: "me" }) },
    work: { getWork: async () => current } as unknown as Host["work"],
    write: {
      async editWork(work, patch) { edits.push(patch.blockedBy?.map((each) => each.id)); return { work, shared: "shared", conflict: false }; },
      async appendLog(work, line) { lines.push(`${line.kind} ${JSON.stringify(line.fields)}`); return { work, shared: "shared", conflict: false }; },
    },
  };
  const actions = createHostActions({ host: meta, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store: openStore(":memory:") });
  await actions.addBlockers!(ref("A-2"), [ref("A-1"), ref("A-3")]);
  assert.deepEqual(edits, [["A-1", "A-3"]]);
  assert.deepEqual(lines, ['edited {"changed":["blocked by"],"via":"triage"}']);
  // Nothing new: nothing written.
  await actions.addBlockers!(ref("A-2"), [ref("A-1")]);
  assert.equal(edits.length, 1);
  assert.equal(world().actions.addBlockers, undefined);
});

test("an accepted rewrite replaces the GitHub issue's body, made inert; another host's item and a host without the write are left alone", async () => {
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const bodies: { work: Ref; body: string }[] = [];
  const host: Host = {
    info: { id: "github", capabilities: new Set(["write"]), whoami: async () => ({ id: "me", name: "me" }) },
    write: { async editWork(work, patch) { bodies.push({ work, body: patch.body ?? "" }); return { work, shared: "shared", conflict: false }; } },
  };
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store: openStore(":memory:") });
  assert.equal(await actions.replaceDescription!(item.ref, "Fixes #3. Ask @robin."), true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.work.id, "7");
  assert.doesNotMatch(bodies[0]!.body, /Fixes #3|@robin/);
  assert.equal(bodies[0]!.body.replaceAll("\u200b", ""), "Fixes #3. Ask @robin.");
  assert.equal(await actions.replaceDescription!({ host: "metaBranch", kind: "work", id: "A-1" }, "Text."), false);
  assert.equal(bodies.length, 1);
  assert.equal(world().actions.replaceDescription, undefined);
});

test("the board's edit of a GitHub Item makes the new description and verification inert, and leaves the rest as given", async () => {
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const patches: WorkPatch[] = [];
  const host: Host = {
    info: { id: "github", capabilities: new Set(["write"]), whoami: async () => ({ id: "me", name: "me" }) },
    write: { async editWork(work, patch) { patches.push(patch); return { work, shared: "shared", conflict: false }; } },
  };
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store: openStore(":memory:") });
  assert.equal(await actions.editItem!(item.ref, { title: "Tides", body: "Fixes #3.", verification: "Ask @robin.", priority: "minor" }), true);
  assert.equal(patches[0]!.title, "Tides");
  assert.equal(patches[0]!.priority, "minor");
  assert.doesNotMatch(`${patches[0]!.body} ${patches[0]!.verification}`, /Fixes #3|@robin/);
  assert.equal(await actions.editItem!(item.ref, { verification: null }), true);
  assert.deepEqual(patches[1], { verification: null });
  assert.equal(await actions.editItem!({ host: "metaBranch", kind: "work", id: "A-1" }, { title: "X" }), false);
  assert.equal(patches.length, 2);
  assert.equal(world().actions.editItem, undefined);
});

test("on the meta branch the labels a triage may propose are every label the host's items have; none where writes are off", async () => {
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: "/srv/clone" }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const store = openStore(":memory:");
  const meta = (id: string, labels: string[]): WorkItem => ({ ...item, ref: { host: "metaBranch", kind: "work", id }, labels });
  store.put(meta("A-1", ["question", "bug"]), "sync", T0);
  store.put(meta("A-2", ["Bug", "harbour"]), "sync", T0);
  const ok = async () => ({ work: item.ref, shared: "local" as const, conflict: false });
  const host: Host = { info: { id: "metaBranch", capabilities: new Set(["write"]), whoami: async () => ({ id: "me", name: "me" }) }, write: { editWork: ok, appendLog: ok } };
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store });
  assert.deepEqual(await actions.repoLabels!({ host: "metaBranch", kind: "work", id: "A-1" }), [{ name: "bug" }, { name: "harbour" }, { name: "question" }]);
  assert.equal(await actions.repoLabels!(item.ref), null);
  assert.equal(createHostActions({ host: { info: host.info }, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store }).repoLabels, undefined);
});

