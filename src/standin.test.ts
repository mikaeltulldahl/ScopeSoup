// The stand-in of issue built into a temporary folder, its configuration loads with the real
// loader and its check passes in a pool clone. All names are synthetic.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createConfigLoader } from "./config/loader.ts";
import { resolveExecutable } from "./orchestrator/executable.ts";
import { sameRepository } from "./orchestrator/remote.ts";
import { buildStandin, startInstructions, STANDIN } from "./standin.ts";
import { execFileSyncRetrying } from "./hosts/spawnRetry.ts";

const dir = mkdtempSync(join(tmpdir(), "scopesoup-standin-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const git = (cwd: string, ...args: string[]): string => execFileSyncRetrying("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

describe("standin", { concurrency: 4 }, () => {
test("the stand-in's configuration passes Scope Soup's own validation and its check passes in a pool clone", async () => {
  const standin = await buildStandin(join(dir, "standin"));
  const state = createConfigLoader(standin.configFile).load();
  assert.equal(state.error, undefined);
  const config = state.config;
  assert.ok(config);

  assert.equal(config.level, 4);
  assert.equal(config.roles.implement.model, "haiku");
  assert.equal(config.roles.review.model, "sonnet");
  assert.ok(config.host?.kind === "metaBranch" && config.host.write && config.host.prefix === "A" && config.host.remote === "origin");
  assert.equal(config.host.repoPath, standin.metaRepo);
  // The shared settings are on the meta ref, pushed to the project's remote.
  assert.equal(git(standin.projectRemote, "rev-parse", "refs/scopesoup/meta"), git(standin.metaRepo, "rev-parse", "refs/scopesoup/meta"));
  assert.ok(sameRepository(git(standin.metaRepo, "remote", "get-url", "origin"), standin.projectRemote));
  assert.ok(config.workspaces.kind === "pool");
  assert.deepEqual(config.workspaces.paths, standin.pool);
  assert.ok(config.streamsDir.startsWith(standin.folder) && config.workspacesDir.startsWith(standin.folder));

  for (const clone of standin.pool) {
    const project = join(clone, config.workspaces.projectSubdir);
    // The submodule is a repository of its own whose remote is the one Scope Soup merges on.
    assert.equal(git(project, "rev-parse", "--show-toplevel").toLowerCase(), project.replace(/\\/g, "/").toLowerCase());
    assert.ok(config.remoteUrl && sameRepository(git(project, "remote", "get-url", config.remote), config.remoteUrl));
  }

  // The check, run as merging runs it: without a shell, in the project's folder of a clone. Without
  // NODE_TEST_CONTEXT, which this test runner sets and which would make the check report to it.
  const [program, ...args] = config.checkCommand ?? [];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  assert.ok(program);
  const output = execFileSyncRetrying(resolveExecutable(program, { advice: { shim: "shim", missing: "missing" } }), args, {
    cwd: join(standin.pool[0]!, config.workspaces.projectSubdir), stdio: "pipe", encoding: "utf8", env,
  });
  assert.match(output, /pass 1/);

  const text = startInstructions(standin);
  assert.match(text, new RegExp(`SCOPESOUP_PORT = "${STANDIN.port}"`));
  assert.match(text, /http:\/\/127\.0\.0\.1:4330/);
});

test("the stand-in is not built into a folder that is not empty", async () => {
  const full = join(dir, "full");
  mkdirSync(full);
  writeFileSync(join(full, "keep.txt"), "a person's file\n");
  await assert.rejects(() => buildStandin(full), /not empty/);
});
});
