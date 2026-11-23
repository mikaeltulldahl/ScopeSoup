import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildRelease, cutRelease, realGitSync, releaseRefusal, writeChecksum, zipFolder } from "./release.ts";

// The release refuses a dirty tree or a version already tagged, and checks the exact commit it would tag.
function syntheticRepo(work: string): { repo: string; git: (...args: string[]) => string } {
  const repo = join(work, "repo");
  const remote = join(work, "remote.git");
  mkdirSync(repo);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "scopesoup", version: "0.1.0" }));
  writeFileSync(join(repo, ".gitignore"), "release/\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main");
  return { repo, git };
}

describe("cutting a release: what is refused", { concurrency: 3 }, () => {
  test("a dirty tree, or an untracked file, is refused", () => {
    const work = mkdtempSync(join(tmpdir(), "scopesoup-cut-"));
    try {
      const { repo, git } = syntheticRepo(work);
      const head = git("rev-parse", "HEAD").trim();
      assert.deepEqual(releaseRefusal(repo), { commit: head, version: "0.1.0", tag: "v0.1.0" });
      writeFileSync(join(repo, "new.txt"), "x");
      assert.match((releaseRefusal(repo) as { refused: string }).refused, /not clean.*new\.txt/s);
      rmSync(join(repo, "new.txt"));
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "scopesoup", version: "0.1.1" }));
      assert.match((releaseRefusal(repo) as { refused: string }).refused, /not clean.*package\.json/s);
      git("checkout", "--", "package.json");
      mkdirSync(join(repo, "release"));
      writeFileSync(join(repo, "release", "ignored.zip"), "x");
      assert.ok("commit" in releaseRefusal(repo), "ignored files do not count");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a version tagged here or on the remote is refused", () => {
    const work = mkdtempSync(join(tmpdir(), "scopesoup-cut-"));
    try {
      const { repo, git } = syntheticRepo(work);
      git("tag", "v0.1.0");
      assert.match((releaseRefusal(repo) as { refused: string }).refused, /v0\.1\.0 is already a tag here/);
      git("push", "-q", "origin", "v0.1.0");
      git("tag", "-d", "v0.1.0");
      assert.match((releaseRefusal(repo) as { refused: string }).refused, /v0\.1\.0 is already a tag on origin/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("the check runs on the commit to tag; a failed check or a HEAD that moved makes no release, and nothing is tagged", () => {
    const work = mkdtempSync(join(tmpdir(), "scopesoup-cut-"));
    try {
      const { repo, git } = syntheticRepo(work);
      const dist = join(work, "dist");
      mkdirSync(dist);
      writeFileSync(join(dist, "index.html"), "<html></html>");
      const lines: string[] = [];
      const base = { git: realGitSync, outDir: join(work, "out", "scopesoup-0.1.0"), webDist: dist, print: (line: string) => lines.push(line) };
      // A synthetic repository has no Scope Soup sources: the build is pointed at this checkout's, the checks at the synthetic one.
      assert.throws(() => cutRelease({ ...base, root: repo, check: () => false }), /check failed on [0-9a-f]{40}/);
      assert.throws(() => cutRelease({ ...base, root: repo, check: () => {
        writeFileSync(join(repo, "late.txt"), "x");
        git("add", "late.txt");
        git("commit", "-q", "-m", "merged meanwhile");
        return true;
      } }), /HEAD moved/);
      assert.equal(git("tag", "--list").trim(), "", "no tag is ever made");
      assert.ok(!existsSync(base.outDir));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a release says which commit it was built from, whether it was checked, and the formats; the zip gets its SHA-256", () => {
    const work = mkdtempSync(join(tmpdir(), "scopesoup-release-"));
    try {
      const dist = join(work, "dist");
      mkdirSync(dist);
      writeFileSync(join(dist, "index.html"), "<html></html>");
      const out = buildRelease({ outDir: join(work, "scopesoup-0.9.0"), webDist: dist, commit: "a".repeat(40), checked: true, version: "0.9.0" });
      const manifest = JSON.parse(readFileSync(join(out, "release.json"), "utf8")) as { version: string; commit: string; checked: boolean; formats: Record<string, number> };
      assert.equal(manifest.version, "0.9.0");
      assert.equal(manifest.checked, true);
      assert.deepEqual(Object.keys(manifest.formats), ["config", "meta", "store"]);
      assert.ok(existsSync(join(out, "src", "scopesoup.ts")), "the launcher's entry");
      const zip = zipFolder(out);
      assert.ok(zip);
      const hex = writeChecksum(zip);
      assert.match(readFileSync(`${zip}.sha256`, "utf8"), new RegExp(`^${hex}  scopesoup-0\.9\.0\.zip`));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
