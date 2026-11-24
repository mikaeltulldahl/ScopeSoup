import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { cutRelease, type Git } from "./release.ts";
import { checkedRecordName } from "./releasePublish.ts";
import { versionOf } from "./upgrade/version.ts";

const COMMIT = "c".repeat(40);

describe("cutting a release records what publishing needs", { concurrency: 1 }, () => {
  const root = join(import.meta.dirname, "..");
  const version = versionOf(root);
  // A fake git: a clean tree at one commit, no tags anywhere.
  const git: Git = (args) => ({ code: 0, stdout: args[0] === "rev-parse" ? `${COMMIT}\n` : "", stderr: "" });

  test("the exe is built by default, the checked commit is recorded, and a test build records none", () => {
    const work = mkdtempSync(join(tmpdir(), "scopesoup-cutexe-"));
    try {
      const dist = join(work, "dist");
      mkdirSync(dist);
      writeFileSync(join(dist, "index.html"), "<html></html>");
      const outDir = join(work, "release", `scopesoup-${version}`);
      const lines: string[] = [];
      const built: string[] = [];
      const base = { root, git, webDist: dist, outDir, print: (line: string) => lines.push(line), check: () => true, exeRefusal: () => null,
        buildExe: ({ releaseFolder }: { releaseFolder: string }) => { built.push(releaseFolder); writeFileSync(`${releaseFolder}-win-x64.exe`, "exe"); return { exe: `${releaseFolder}-win-x64.exe`, bytes: 3 }; } };
      const record = join(work, "release", checkedRecordName(version));
      const result = cutRelease(base);
      assert.deepEqual(built, [outDir]);
      assert.equal(result.exe, `${outDir}-win-x64.exe`);
      assert.ok(existsSync(`${result.exe}.sha256`));
      assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { version, commit: COMMIT });
      assert.ok(lines.some((line) => line.includes(`pnpm release:publish ${version} --notes-file`)));

      lines.length = 0;
      built.length = 0;
      assert.equal(cutRelease({ ...base, exe: false }).exe, null);
      assert.deepEqual(built, []);
      assert.ok(!existsSync(`${outDir}-win-x64.exe`), "an older .exe is not kept for this release");

      lines.length = 0;
      assert.equal(cutRelease({ ...base, exeRefusal: () => "Windows only." }).exe, null);
      assert.ok(lines.some((line) => line.startsWith("No .exe was built: Windows only.")));
      assert.ok(existsSync(record));

      cutRelease({ ...base, noCheck: true, exe: false });
      assert.ok(!existsSync(record), "a --no-check build has no record, so it cannot be published");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("an .exe that fails to build is said, and the release goes on", () => {
    const work = mkdtempSync(join(tmpdir(), "scopesoup-cutexe-"));
    try {
      const dist = join(work, "dist");
      mkdirSync(dist);
      writeFileSync(join(dist, "index.html"), "<html></html>");
      const lines: string[] = [];
      const result = cutRelease({ root, git, webDist: dist, outDir: join(work, "release", `scopesoup-${version}`), print: (line) => lines.push(line), check: () => true,
        exeRefusal: () => null, buildExe: () => { throw new Error("needs Node 25.5"); } });
      assert.equal(result.exe, null);
      assert.ok(lines.some((line) => line.includes("No .exe was built: needs Node 25.5")));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
