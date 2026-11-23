// Offboarding never removes a path that is the person's, Scope Soup's installation or the export folder.

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathRefusal } from "./act.ts";
import type { OffboardSetup } from "./scan.ts";

const root = resolve("/work");
const setup = {
  configFile: join(root, "shop-scopesoup", "scopesoup.config.json"), configFolder: join(root, "shop-scopesoup"), repoPath: join(root, "shop-scopesoup", "repo"), remote: "origin", mainBranch: "main",
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
