// Offboarding never removes a path that is the person's, Scope Soup's installation or the export folder.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cloneTestRepo, createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import { realGit } from "../orchestrator/process.ts";
import { exportItems, pathRefusal } from "./act.ts";
import type { OffboardSetup } from "./scan.ts";

const root = resolve("/work");
const setup = {
  configFile: join(root, "shop-scopesoup", "scopesoup.config.json"), configFolder: join(root, "shop-scopesoup"), repoPath: join(root, "shop-scopesoup", "repo"), remote: "origin", singleplayer: false, mainBranch: "main",
  githubRepo: null, workspacesDir: null, streamsDir: null, pool: [{ clone: join(root, "pool", "one"), repo: join(root, "pool", "one", "lib") }],
  protectedPaths: [join(root, "shop"), join(root, "remotes", "shop.git")], manifest: [], problems: [],
} satisfies OffboardSetup;

test("a path is refused when it overlaps the person's checkout, a local remote, a pool clone, the install or the export folder", () => {
  const install = join(root, "scopesoup-0.5.0");
  const out = join(root, "shop-scopesoup-offboard");
  assert.equal(pathRefusal(join(root, "shop-scopesoup"), setup, install, out), null);
  assert.equal(pathRefusal(join(root, "shop-scopesoup", "repo"), setup, install, out), null);
  assert.match(pathRefusal(root, setup, install, out) ?? "", /your own/);
  assert.match(pathRefusal(join(root, "shop", "sub"), setup, install, out) ?? "", /your own/);
  assert.match(pathRefusal(join(root, "remotes"), setup, install, out) ?? "", /your own/);
  assert.match(pathRefusal(join(root, "pool"), setup, install, out) ?? "", /pool clone/);
  assert.match(pathRefusal(install, setup, install, out) ?? "", /installation/);
  assert.match(pathRefusal(join(root, "shop-scopesoup"), setup, install, join(root, "shop-scopesoup", "export")) ?? "", /export folder/);
});

test("singleplayer exports the Items from the meta ref in Scope Soup's clone, fetching nothing: a stale remote one is not read", async () => {
  const origin = createTestRepo();
  const clone = cloneTestRepo(origin);
  const out = mkdtempSync(join(tmpdir(), "soup-offboard-out-"));
  try {
    const item = (title: string) => `---\nid: A-1\ntitle: ${title}\nstate: ready\n---\n`;
    origin.commit("refs/scopesoup/meta", { format: "1\n", "items/A-1/item.md": item("Stale on the remote") }, "2026-11-20T08:00:00Z");
    origin.commit("refs/test/local", { format: "1\n", "items/A-1/item.md": item("Kept here"), "settings/settings.json": "{\"level\":0}\n" }, "2026-11-21T08:00:00Z");
    clone.git(["fetch", "-q", "origin", "+refs/test/local:refs/scopesoup/meta"]);
    const remoteBefore = origin.git(["rev-parse", "refs/scopesoup/meta"]);
    await exportItems(realGit, { repoPath: clone.dir, remote: "origin", singleplayer: true }, out);
    assert.match(readFileSync(join(out, "items", "A-1.md"), "utf8"), /title: Kept here/);
    assert.equal(readFileSync(join(out, "settings.json"), "utf8"), "{\"level\":0}\n");
    assert.equal(origin.git(["rev-parse", "refs/scopesoup/meta"]), remoteBefore);
    assert.equal(existsSync(join(clone.dir, ".git", "FETCH_HEAD")) ? readFileSync(join(clone.dir, ".git", "FETCH_HEAD"), "utf8").includes("refs/scopesoup/meta") : false, false);
  } finally {
    origin.cleanup();
    clone.cleanup();
    rmSync(out, { recursive: true, force: true });
  }
});
