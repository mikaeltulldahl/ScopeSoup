// The setup runs once per folder and again when a watched file changes, with a fake command runner and real git folders.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";
import type { CheckRun, RunCheck } from "./checkRunner.ts";
import { realGit } from "./process.ts";
import { ensureSetup, setupEnv, setupPromptLine, setupReason, watchedFiles } from "./setup.ts";
import type { SetupDeps } from "./setup.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-setup-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSyncRetrying("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lock: 1\n");
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "pnpm-lock.yaml"), "lock: 1\n");
  writeFileSync(join(dir, "requirements-dev.txt"), "synthetic\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return dir;
}

/** A runner that records each run and does what `effect` says (in the folder) before it answers. */
function fakeRun(outcome: CheckRun["outcome"] = "passed", effect?: (cwd: string) => void): RunCheck & { runs: string[] } {
  const runs: string[] = [];
  const run = (async (command: readonly string[], cwd: string) => {
    runs.push(`${command.join(" ")} @ ${cwd}`);
    effect?.(cwd);
    return { outcome, code: outcome === "passed" ? 0 : 1, tail: outcome === "passed" ? "done" : "pnpm install failed: no network", ms: 1200 };
  }) as unknown as RunCheck & { runs: string[] };
  run.runs = runs;
  return run;
}

function deps(run: RunCheck): SetupDeps {
  return { git: realGit, run, timeoutMs: 60_000, stop: () => false, now: () => "2026-11-22T10:00:00.000Z" };
}

describe("setup", { concurrency: 4 }, () => {
  test("watched files: plain paths, a * inside one part, nothing that is not there", () => {
    const dir = repo();
    assert.deepEqual(watchedFiles(dir, ["pnpm-lock.yaml", "web/pnpm-lock.yaml", "requirements*.txt", "yarn.lock", "*/pnpm-lock.yaml"]), ["pnpm-lock.yaml", "requirements-dev.txt", "web/pnpm-lock.yaml"]);
  });

  test("it runs once in a folder, not again while nothing watched changed, and again when a watched file or the command changes", async () => {
    const dir = repo();
    const run = fakeRun("passed", (cwd) => mkdirSync(join(cwd, "node_modules"), { recursive: true }));
    const config = { setupCommand: ["node", "setup.mjs"], setupWatch: ["pnpm-lock.yaml"] };
    const first = await ensureSetup(deps(run), config, dir);
    assert.equal(first.kind, "ran");
    if (first.kind === "ran") assert.equal(first.why, "it has not run in this folder yet");
    assert.equal((await ensureSetup(deps(run), config, dir)).kind, "current");
    // A file that is not watched changes nothing.
    writeFileSync(join(dir, "web", "pnpm-lock.yaml"), "lock: 2\n");
    assert.equal((await ensureSetup(deps(run), config, dir)).kind, "current");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lock: 2\n");
    const again = await ensureSetup(deps(run), config, dir);
    assert.equal(again.kind, "ran");
    if (again.kind === "ran") assert.equal(again.why, "watched files changed: pnpm-lock.yaml");
    const changed = await ensureSetup(deps(run), { ...config, setupCommand: ["node", "setup.mjs", "--from-clone", "/somewhere"] }, dir);
    assert.equal(changed.kind, "ran");
    assert.equal(run.runs.length, 3);
    // Without a setupCommand nothing runs.
    assert.equal((await ensureSetup(deps(run), {}, dir)).kind, "none");
  });

  test("a file the command names outside the repository (a log it writes) is not hashed: changing it does not run the setup again; a script inside is", async () => {
    const dir = repo();
    const outside = join(mkdtempSync(join(tmpdir(), "scopesoup-setup-out-")), "setup-runs.log");
    dirs.push(join(outside, ".."));
    writeFileSync(outside, "run 1\n");
    mkdirSync(join(dir, ".scopesoup"));
    writeFileSync(join(dir, ".scopesoup", "setup.mjs"), "// v1\n");
    const commit = (...args: string[]): void => void execFileSyncRetrying("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, stdio: "pipe" });
    commit("add", ".");
    commit("commit", "-q", "-m", "script");
    const run = fakeRun();
    const config = { setupCommand: ["node", ".scopesoup/setup.mjs", outside], setupWatch: ["pnpm-lock.yaml"] };
    assert.equal((await ensureSetup(deps(run), config, dir)).kind, "ran");
    writeFileSync(outside, "run 1\nrun 2\n");
    assert.equal((await ensureSetup(deps(run), config, dir)).kind, "current");
    writeFileSync(join(dir, ".scopesoup", "setup.mjs"), "// v2\n");
    commit("commit", "-qam", "v2");
    const again = await ensureSetup(deps(run), config, dir);
    assert.equal(again.kind, "ran");
    assert.equal(run.runs.length, 2);
  });

  test("each worktree has its own record: a new worktree runs the setup, the first does not again", async () => {
    const dir = repo();
    const run = fakeRun();
    const config = { setupCommand: ["node", "setup.mjs"] };
    assert.equal((await ensureSetup(deps(run), config, dir)).kind, "ran");
    const other = join(dir, "..", `${dir.split(/[\\/]/).pop()}-wt`);
    dirs.push(other);
    execFileSyncRetrying("git", ["worktree", "add", "-q", "--detach", other], { cwd: dir, stdio: "pipe" });
    assert.equal((await ensureSetup(deps(run), config, other)).kind, "ran");
    assert.equal((await ensureSetup(deps(run), config, dir)).kind, "current");
    assert.equal((await ensureSetup(deps(run), config, other)).kind, "current");
  });

  test("a failed setup is not recorded and runs again; one that leaves files git does not ignore fails", async () => {
    const dir = repo();
    const failing = fakeRun("failed");
    const config = { setupCommand: ["node", "setup.mjs"] };
    const failed = await ensureSetup(deps(failing), config, dir);
    assert.equal(failed.kind, "failed");
    if (failed.kind === "failed") assert.match(failed.reason, /exited with code 1\. The end of its output:\npnpm install failed: no network/);
    assert.equal((await ensureSetup(deps(fakeRun()), config, dir)).kind, "ran");

    const messy = repo();
    const result = await ensureSetup(deps(fakeRun("passed", (cwd) => writeFileSync(join(cwd, "generated.txt"), "x\n"))), config, messy);
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.match(result.reason, /changed or added files that git does not ignore \(\?\? generated\.txt\)/);
    // An ignored file (a copied .env) is fine.
    const clean = repo();
    assert.equal((await ensureSetup(deps(fakeRun("passed", (cwd) => writeFileSync(join(cwd, ".env"), "TOKEN=synthetic\n"))), config, clean)).kind, "ran");
  });

  test("the reasons, the prompt's line, and an environment without Scope Soup's tokens", () => {
    assert.equal(setupReason(null, { command: "a", files: {} }), "it has not run in this folder yet");
    assert.equal(setupReason({ v: 1, command: "a", files: { x: "1", y: "1" }, at: "" }, { command: "a", files: { x: "2", z: "1" } }), "watched files changed: x, z (new), y (gone)");
    assert.equal(setupPromptLine({}), "");
    assert.match(setupPromptLine({ setupCommand: ["node", "s.mjs"], setupWatch: ["pnpm-lock.yaml"] }), /^Scope Soup ran the project's setup in this clone before your session \(`node s\.mjs`\), and runs it again when pnpm-lock\.yaml changes.*Do not install them or run the setup again yourself\.$/);
    assert.deepEqual(setupEnv({ PATH: "/bin", SCOPESOUP_GITHUB_TOKEN: "t", SCOPESOUP_CONFIG: "c", ANTHROPIC_API_KEY: "k", HOME: "/h" }), { PATH: "/bin", HOME: "/h" });
  });

  test("GitHub tokens reach the setup unless a role runs on Copilot, which signs in with them", () => {
    const env = { PATH: "/bin", GH_TOKEN: "g", GITHUB_TOKEN: "h", COPILOT_GITHUB_TOKEN: "c", ANTHROPIC_API_KEY: "k" };
    const roles = (provider?: "copilot") => ({
      triage: { model: "m", maxTurns: 1, allowedTools: [], permissionMode: "dontAsk", ...(provider ? { provider } : {}) },
      implement: { model: "m", maxTurns: 1, allowedTools: [], permissionMode: "dontAsk" },
      review: { model: "m", maxTurns: 1, allowedTools: [], permissionMode: "dontAsk" },
    });
    assert.deepEqual(setupEnv(env, { roles: roles() }), { PATH: "/bin", GH_TOKEN: "g", GITHUB_TOKEN: "h", COPILOT_GITHUB_TOKEN: "c" });
    assert.deepEqual(setupEnv(env, { roles: roles("copilot") }), { PATH: "/bin" });
  });
});
