// Tests that run git, and code checking that runs git, see none of this machine's git settings:
// no global or system configuration (a laptop may have core.autocrlf or a global excludes file).
// Only the test process's own environment is changed; children (git, the fake agent CLI) inherit it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryGitOnceSync } from "../../hosts/gitRetry.ts";
import { execFileSyncRetrying } from "../../hosts/spawnRetry.ts";

// Background work git starts by itself (automatic gc after a push or fetch, maintenance, a file
// system monitor) and the index refresh a read-only command writes back make git processes of one
// test race each other, and other suites on the machine, for locks in the same clone. A test runs
// the commands it means to and nothing else.
const QUIET: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_COUNT: "5",
  GIT_CONFIG_KEY_0: "gc.auto", GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "receive.autogc", GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "maintenance.auto", GIT_CONFIG_VALUE_2: "false",
  GIT_CONFIG_KEY_3: "core.fsmonitor", GIT_CONFIG_VALUE_3: "false",
  GIT_CONFIG_KEY_4: "core.untrackedCache", GIT_CONFIG_VALUE_4: "false",
};

/** Points git at an empty global configuration and no system one, and keeps it from background work. Returns the undo, for an `after` hook. */
export function isolateGitConfig(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-gitconfig-"));
  const empty = join(dir, "gitconfig");
  writeFileSync(empty, "");
  const before = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const quiet = Object.keys(QUIET).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, QUIET);
  return () => {
    for (const [key, value] of quiet) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (before.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before.global;
    if (before.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = before.nosystem;
    rmSync(dir, { recursive: true, force: true });
  };
}

/** Runs git in `cwd` with a fixed identity and no line-ending conversion; returns trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  const full = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...args];
  // A git ended from outside is run once more when that is safe (src/hosts/gitRetry.ts).
  return retryGitOnceSync(full, () => execFileSyncRetrying("git", full, { cwd, stdio: "pipe", encoding: "utf8" })).trim();
}
