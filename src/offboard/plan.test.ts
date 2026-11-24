// The list offboarding shows: every leftover of Scope Soup's, grouped, keeping by default whatever holds work.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chosen, offboardPlan, planText, type Found, type PlanEntry } from "./plan.ts";

const found = (patch: Partial<Found> = {}): Found => ({
  configFolder: "/work/shop-scopesoup",
  manifest: [
    { kind: "label", repo: "owner/shop", name: "priority:major", at: "t", by: "scopesoup" },
    { kind: "ref", ref: "refs/scopesoup/meta", what: "settings", at: "t", by: "onboarding" },
  ],
  remote: "origin",
  mainBranch: "main",
  remoteRefs: ["refs/scopesoup/merge-queue", "refs/scopesoup/meta", "refs/scopesoup/resources/emulator/1"],
  remoteBranches: [
    { name: "scopesoup/batch-3-abcdef0", sha: "abcdef0123", merged: false },
    { name: "scopesoup/A-1", sha: "1111111aaa", merged: true },
    { name: "scopesoup/A-2", sha: "2222222bbb", merged: false },
  ],
  localBranches: [{ repo: "/work/shop-scopesoup/repo", name: "scopesoup/A-3", sha: "3333333ccc", merged: false, onRemote: false }],
  github: {
    repo: "owner/shop",
    labels: ["bug", "scopesoup:claimed", "scopesoup:needs-decision", "scopesoup:review", "priority:major", "priority:minor", "moved-to-scopesoup"],
    pulls: [{ number: 41, title: "Batch 3", head: "scopesoup/batch-3-abcdef0" }],
  },
  projectFiles: [{ path: "CLAUDE.md", change: "claude-md-section" }, { path: ".scopesoup/scopesoup-setup.mjs", change: "setup-script" }],
  folders: [
    { path: "/work/shop-scopesoup/repo", what: "Scope Soup's clone of the project", exists: true, holdsWork: "commits on a branch that no remote has" },
    { path: "/work/shop-scopesoup/data", what: "the data folder", exists: true },
    { path: "/work/gone", what: "a folder", exists: false },
    { path: "/work/pool/one", what: "a clone of the pool", exists: true, yours: true },
    { path: "/work/shop-scopesoup", what: "the config folder", exists: true },
  ],
  copies: ["/work/shop-scopesoup/scopesoup.config.v0.json", "/work/shop-scopesoup/data/scopesoup.v1.sqlite"],
  install: "/opt/scopesoup-0.5.0",
  ...patch,
});

const byKey = (entries: PlanEntry[]) => new Map(entries.map((entry) => [entry.key, entry]));

describe("offboarding plan", () => {
  test("lists the leftover batch branch and pull request, Scope Soup's labels, the meta and merge queue refs and the .v* copies", () => {
    const plan = offboardPlan(found());
    assert.deepEqual(plan.groups.map((group) => group.group), ["work", "items", "github", "project", "machine"]);
    const all = byKey(plan.groups.flatMap((group) => group.entries));
    // The batch's pull request and its branch, left after a failure: listed, kept by default (not merged).
    assert.equal(all.get("pull 41")?.default, "keep");
    assert.match(all.get("pull 41")?.what ?? "", /batch left after a failure/);
    assert.equal(all.get("branch scopesoup/batch-3-abcdef0")?.default, "keep");
    assert.equal(all.get("branch scopesoup/A-1")?.default, "remove");
    assert.equal(all.get("branch scopesoup/A-2")?.why, "not merged into main");
    assert.equal(all.get("local /work/shop-scopesoup/repo scopesoup/A-3")?.default, "keep");
    // The Items: exported first, then the refs.
    const items = plan.groups.find((group) => group.group === "items")?.entries.map((entry) => entry.key);
    assert.deepEqual(items, ["export", "ref refs/scopesoup/merge-queue", "ref refs/scopesoup/meta", "ref refs/scopesoup/resources/emulator/1"]);
    // Scope Soup's labels, and priority:* only when it created them; the person's label is not listed.
    for (const name of ["scopesoup:claimed", "scopesoup:needs-decision", "scopesoup:review", "priority:major"]) assert.equal(all.get(`label ${name}`)?.default, "remove", name);
    assert.equal(all.has("label bug"), false);
    assert.equal(all.has("label priority:minor"), false);
    assert.equal(all.get("label moved-to-scopesoup")?.default, "keep");
    assert.equal(all.get("comments")?.action.do, "none");
    // The project's files, as a patch.
    assert.deepEqual(plan.groups.find((group) => group.group === "project")?.entries.map((entry) => entry.action), [
      { do: "patch", path: "CLAUDE.md", delete: false }, { do: "patch", path: ".scopesoup/scopesoup-setup.mjs", delete: true },
    ]);
    // This machine: the copies, the folders, the config folder last; the pool clone kept; the installation and the plugin are yours.
    const machine = plan.groups.find((group) => group.group === "machine")?.entries ?? [];
    assert.deepEqual(machine.map((entry) => entry.key), [
      "copy /work/shop-scopesoup/scopesoup.config.v0.json", "copy /work/shop-scopesoup/data/scopesoup.v1.sqlite",
      "folder /work/shop-scopesoup/repo", "folder /work/shop-scopesoup/data", "folder /work/pool/one", "folder /work/shop-scopesoup", "install", "plugin",
    ]);
    assert.equal(all.get("folder /work/shop-scopesoup/repo")?.default, "keep");
    assert.equal(all.get("folder /work/pool/one")?.action.do, "none");
    assert.match(all.get("plugin")?.onRemove ?? "", /\/plugin uninstall scopesoup@scopesoup/);
    assert.match(plan.notes[0] ?? "", /Pausing is not leaving/);
    assert.ok(planText(plan).some((line) => line.includes("refs/scopesoup/merge-queue")));
  });

  test("a yes for a group removes its 'remove' entries; its kept ones only when named too; never a manual one", () => {
    const plan = offboardPlan(found());
    const some = chosen(plan, new Set(["work", "machine"]), new Set());
    assert.deepEqual(some.map((entry) => entry.key), [
      "branch scopesoup/A-1",
      "copy /work/shop-scopesoup/scopesoup.config.v0.json", "copy /work/shop-scopesoup/data/scopesoup.v1.sqlite", "folder /work/shop-scopesoup/data", "folder /work/shop-scopesoup",
    ]);
    const every = chosen(plan, new Set(["work"]), new Set(["work"])).map((entry) => entry.key);
    assert.deepEqual(every, ["pull 41", "branch scopesoup/batch-3-abcdef0", "branch scopesoup/A-1", "branch scopesoup/A-2", "local /work/shop-scopesoup/repo scopesoup/A-3"]);
    assert.deepEqual(chosen(plan, new Set(), new Set(["work"])), []);
    const all = chosen(plan, new Set(["machine"]), new Set(["machine"])).map((entry) => entry.key);
    assert.ok(!all.includes("install") && !all.includes("plugin") && !all.includes("folder /work/pool/one"));
  });

  test("GitHub not reachable, or not used", () => {
    const unread = offboardPlan(found({ github: { repo: "owner/shop", problem: "SCOPESOUP_GITHUB_TOKEN is not set" } }));
    const github = unread.groups.find((group) => group.group === "github")?.entries ?? [];
    assert.match(github[0]?.what ?? "", /could not be read/);
    assert.equal(chosen(unread, new Set(["github"]), new Set(["github"])).length, 0);
    const none = offboardPlan(found({ github: null }));
    assert.equal(none.groups.find((group) => group.group === "github")?.entries.length, 0);
    assert.ok(none.notes.some((note) => note.includes("not on GitHub")));
  });
});

test("a config on this machine's list is taken off it, first in the machine group", () => {
  const registered = { home: "/opt", list: "/opt/configs.json", file: "/work/shop-scopesoup/scopesoup.config.json" };
  const machine = offboardPlan(found({ registered })).groups.find((group) => group.group === "machine")!;
  assert.equal(machine.entries[0]?.key, "registered");
  assert.equal(machine.entries[0]?.default, "remove");
  assert.deepEqual(machine.entries[0]?.action, { do: "unregister", home: "/opt", file: registered.file });
  assert.match(planText(offboardPlan(found({ registered }))).join("\n"), /on this machine's list of configs, \/opt\/configs\.json/);
  assert.equal(offboardPlan(found()).groups.find((group) => group.group === "machine")!.entries.some((entry) => entry.key === "registered"), false);
});

describe("shortcuts on the manifest", () => {
  test("a shortcut file is listed on this machine and deleted by default", () => {
    const lnk = "C:/Users/x/Start Menu/Programs/Scope Soup – shop.lnk";
    const folders = [...found().folders, { path: lnk, what: "a Scope Soup shortcut (Start menu) that starts Scope Soup and opens the board", exists: true }];
    const machine = offboardPlan(found({ folders })).groups.find((group) => group.group === "machine")!;
    const entry = machine.entries.find((each) => each.key === `folder ${lnk}`);
    assert.equal(entry?.default, "remove");
    assert.deepEqual(entry?.action, { do: "delete-path", path: lnk });
  });
});
