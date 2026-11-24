import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkedRecordName, publishRelease, type Run } from "./releasePublish.ts";

const COMMIT = "c".repeat(40);

/** A release folder as `pnpm release` leaves it, with synthetic contents. */
function fakeRelease(dir: string, version: string, options: { exe?: boolean; record?: boolean; checked?: boolean } = {}): void {
  const folder = join(dir, `scopesoup-${version}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "release.json"), JSON.stringify({ version, commit: COMMIT, checked: options.checked ?? true }));
  writeFileSync(`${folder}.zip`, "zip");
  writeFileSync(`${folder}.zip.sha256`, "x");
  if (options.exe) {
    writeFileSync(join(dir, `scopesoup-${version}-win-x64.exe`), "exe");
    writeFileSync(join(dir, `scopesoup-${version}-win-x64.exe.sha256`), "x");
  }
  if (options.record ?? true) writeFileSync(join(dir, checkedRecordName(version)), JSON.stringify({ version, commit: COMMIT }));
}

/** A fake git and gh: records every call; `state` says which tags exist and what fails. */
function fakeRun(state: { localTag?: boolean; remoteTag?: boolean; unknownCommit?: boolean; pushFails?: boolean } = {}): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const run: Run = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    const ok = (stdout = ""): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout, stderr: "" });
    if (command === "git" && args[0] === "cat-file") return state.unknownCommit ? { code: 1, stdout: "", stderr: "bad object" } : ok();
    if (command === "git" && args[0] === "tag" && args[1] === "--list") return ok(state.localTag ? `${args[2]}\n` : "");
    if (command === "git" && args[0] === "ls-remote") return ok(state.remoteTag ? `${COMMIT}\t${args[3]}\n` : "");
    if (command === "git" && args[0] === "push" && state.pushFails) return { code: 1, stdout: "", stderr: "rejected" };
    return ok();
  };
  return { run, calls };
}

function inTemp(body: (dir: string, notes: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-publish-"));
  try {
    const notes = join(dir, "notes.md");
    writeFileSync(notes, "Notes.");
    body(join(dir, "release"), notes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("publishing a release", { concurrency: 3 }, () => {
  test("tags the checked commit, pushes the tag and creates the release with the zip, the .exe and their checksums", () => {
    inTemp((releaseDir, notes) => {
      fakeRelease(releaseDir, "1.2.3", { exe: true });
      const { run, calls } = fakeRun();
      const result = publishRelease({ version: "1.2.3", notesFile: notes, root: "/synthetic", releaseDir, run, print: () => {} });
      assert.equal(result.commit, COMMIT);
      assert.deepEqual(calls, [
        `git cat-file -e ${COMMIT}^{commit}`,
        "git tag --list v1.2.3",
        "git ls-remote --tags origin refs/tags/v1.2.3",
        `git tag -a v1.2.3 ${COMMIT} -m Scope Soup 1.2.3`,
        "git push origin v1.2.3",
        `gh release create v1.2.3 ${[
          join(releaseDir, "scopesoup-1.2.3.zip"), join(releaseDir, "scopesoup-1.2.3.zip.sha256"),
          join(releaseDir, "scopesoup-1.2.3-win-x64.exe"), join(releaseDir, "scopesoup-1.2.3-win-x64.exe.sha256"),
        ].join(" ")} --title Scope Soup 1.2.3 --notes-file ${notes}`,
      ]);
    });
  });

  test("without an .exe the release gets the zip only", () => {
    inTemp((releaseDir, notes) => {
      fakeRelease(releaseDir, "1.2.3");
      const lines: string[] = [];
      const { run, calls } = fakeRun();
      publishRelease({ version: "1.2.3", notesFile: notes, root: "/synthetic", releaseDir, run, print: (line) => lines.push(line) });
      assert.doesNotMatch(calls.at(-1) as string, /\.exe/);
      assert.ok(lines.some((line) => /No \.exe/.test(line)));
    });
  });

  test("refuses, and runs nothing that changes anything, without a notes file, a release, a record, or when the tag exists", () => {
    inTemp((releaseDir, notes) => {
      const refuse = (version: string, notesFile: string | undefined, run: Run, pattern: RegExp): void => {
        assert.throws(() => publishRelease({ version, notesFile, root: "/synthetic", releaseDir, run, print: () => {} }), pattern);
      };
      const mutating = (calls: string[]): string[] => calls.filter((call) => /^(git (tag -a|push)|gh )/.test(call));
      fakeRelease(releaseDir, "1.2.3");
      let fake = fakeRun();
      refuse("1.2.3", undefined, fake.run, /No notes file/);
      refuse("1.2.3", join(releaseDir, "missing.md"), fake.run, /does not exist/);
      refuse("1.2", notes, fake.run, /not a version/);
      refuse("1.2.4", notes, fake.run, /scopesoup-1\.2\.4 does not exist/);
      fakeRelease(releaseDir, "1.2.5", { record: false });
      refuse("1.2.5", notes, fake.run, /checked commit is unknown/);
      fakeRelease(releaseDir, "1.2.6", { checked: false });
      refuse("1.2.6", notes, fake.run, /does not say it was checked/);
      fake = fakeRun({ localTag: true });
      refuse("1.2.3", notes, fake.run, /already a tag here/);
      fake = fakeRun({ remoteTag: true });
      refuse("1.2.3", notes, fake.run, /already a tag on origin/);
      fake = fakeRun({ unknownCommit: true });
      refuse("1.2.3", notes, fake.run, /not in/);
      assert.deepEqual(mutating(fake.calls), []);
    });
  });

  test("a failed push removes the tag it made and creates no release", () => {
    inTemp((releaseDir, notes) => {
      fakeRelease(releaseDir, "1.2.3");
      const { run, calls } = fakeRun({ pushFails: true });
      assert.throws(() => publishRelease({ version: "1.2.3", notesFile: notes, root: "/synthetic", releaseDir, run, print: () => {} }), /git push failed: rejected/);
      assert.equal(calls.at(-1), "git tag -d v1.2.3");
      assert.ok(!calls.some((call) => call.startsWith("gh ")));
    });
  });
});
