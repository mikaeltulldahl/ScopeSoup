// For tests: a real temporary git repository, with commits made by plumbing so no working
// directory or checkout is involved (git fast-import, so hundreds of files cost one process). The repository's own config pins everything the machine's
// git config could change (line ends, signing, hooks, identity), so the tests run the same on
// Windows and Linux.

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryGitOnceSync } from "../gitRetry.ts";
import { execFileSyncRetrying } from "../spawnRetry.ts";

/** An `item.md` as Scope Soup writes it. */
export const itemMd = (id: string, title: string, state: string, more: string[] = [], body = `What ${title.toLowerCase()} means.`): string =>
  ["---", `id: ${id}`, `title: ${title}`, `state: ${state}`, ...more, "---", "", body, ""].join("\n");

/** Log lines, one JSON object each. */
export const jsonl = (...lines: object[]): string => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

/** A file's content, or an entry of another mode: a symlink (`120000`, content is its target) or a submodule (`160000`, `sha`). */
export type TestFile = string | { mode: string; content?: string; sha?: string };

export interface TestRepo {
  dir: string;
  git(args: string[], input?: string | Buffer, env?: Record<string, string>): string;
  /** Makes one commit on `ref` whose tree is exactly `files` (path -> content); returns its id. */
  commit(ref: string, files: Record<string, TestFile>, time: string): string;
  cleanup(): void;
}

export function createTestRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-meta-"));
  const git = (args: string[], input?: string | Buffer, env: Record<string, string> = {}): string =>
    // A git ended from outside is run once more when that is safe (src/hosts/gitRetry.ts).
    retryGitOnceSync(args, () => execFileSyncRetrying("git", args, { cwd: dir, input: input ?? "", env: { ...process.env, ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }))
      .toString("utf8")
      .trim();

  git(["init", "--quiet", "--bare"]);
  // Written to the config file directly: one git process per setting made this the larger part of
  // making a repository. Forward slashes, because a backslash is an escape in a git config value.
  appendFileSync(
    join(dir, "config"),
    [
      "[core]",
      "\tautocrlf = false",
      "\tsafecrlf = false",
      `\thooksPath = ${join(dir, "no-hooks").split("\\").join("/")}`,
      "[commit]",
      "\tgpgsign = false",
      "[user]",
      "\tname = Test Person",
      "\temail = test.person@example.invalid",
      "",
    ].join("\n"),
  );

  return {
    dir,
    git,
    commit(ref, files, time) {
      let parent: string | null = null;
      try {
        parent = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      } catch {
        parent = null;
      }
      const when = `${Math.floor(Date.parse(time) / 1000)} +0000`;
      const text = (value: string): Buffer => Buffer.from(value);
      const parts: Buffer[] = [text(`commit ${ref}\ncommitter Test Person <test.person@example.invalid> ${when}\ndata 4\ntest\n`)];
      if (parent) parts.push(text(`from ${parent}\n`));
      parts.push(text("deleteall\n"));
      for (const [path, file] of Object.entries(files)) {
        const entry = typeof file === "string" ? { mode: "100644", content: file } : file;
        if (entry.sha !== undefined) parts.push(text(`M ${entry.mode} ${entry.sha} ${path}\n`));
        else {
          const data = text(entry.content ?? "");
          parts.push(text(`M ${entry.mode} inline ${path}\ndata ${data.length}\n`), data, text("\n"));
        }
      }
      git(["fast-import", "--quiet"], Buffer.concat(parts));
      return git(["rev-parse", `${ref}^{commit}`]);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestClone {
  dir: string;
  git(args: string[]): string;
  cleanup(): void;
}

/** A clone of a test repository, as a person's working copy of it: a checkout, an index, `origin`. */
export function cloneTestRepo(origin: TestRepo): TestClone {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-clone-"));
  const git = (args: string[]): string =>
    execFileSyncRetrying("git", args, { cwd: dir, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      .toString("utf8")
      .trim();
  git(["-c", "core.autocrlf=false", "clone", "--quiet", origin.dir, "."]);
  return {
    dir,
    git,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
