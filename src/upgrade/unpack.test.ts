import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fakeReleaseFolder, fakeReleaseZip } from "./testRelease.ts";
import { unpackRelease } from "./unpack.ts";
import { versionOf } from "./version.ts";

function withWork(run: (work: string, home: string) => void): void {
  const work = mkdtempSync(join(tmpdir(), "scopesoup-unpack-"));
  const home = join(work, "home");
  mkdirSync(home);
  try {
    run(work, home);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("unpacking a release into its own folder", { concurrency: 2 }, () => {
  test("a good zip becomes scopesoup-<version>/ beside the running version, which is not touched", () => withWork((work, home) => {
    const running = fakeReleaseFolder(home, "0.1.0");
    const { zip, bytes, sha } = fakeReleaseZip(work, "0.2.0");
    assert.equal(unpackRelease(zip, home, { version: "0.2.0", size: bytes.length, sha256: sha }, ["scopesoup-0.1.0"]), "scopesoup-0.2.0");
    assert.equal(versionOf(join(home, "scopesoup-0.2.0")), "0.2.0");
    assert.equal(versionOf(running), "0.1.0");
    assert.deepEqual(readdirSync(home).sort(), ["scopesoup-0.1.0", "scopesoup-0.2.0"], "no temporary folder left");
  }));

  test("a wrong hash, size, version or layout is refused, and nothing is left", () => withWork((work, home) => {
    const good = fakeReleaseZip(work, "0.2.0");
    assert.throws(() => unpackRelease(good.zip, home, { version: "0.2.0", sha256: "00".repeat(32) }), /SHA-256/);
    assert.throws(() => unpackRelease(good.zip, home, { version: "0.2.0", size: good.bytes.length + 1 }), /bytes/);
    assert.throws(() => unpackRelease(good.zip, home, { version: "0.3.0" }), /not one folder scopesoup-0\.3\.0/);
    const renamed = fakeReleaseZip(work, "0.2.0", "scopesoup-0.3.0");
    assert.throws(() => unpackRelease(renamed.zip, home, { version: "0.3.0" }), /it is version 0\.2\.0, not 0\.3\.0/);
    assert.deepEqual(readdirSync(home), []);
  }));

  test("the running version's folder is never replaced", () => withWork((work, home) => {
    fakeReleaseFolder(home, "0.2.0");
    const { zip } = fakeReleaseZip(work, "0.2.0");
    assert.throws(() => unpackRelease(zip, home, { version: "0.2.0" }, ["scopesoup-0.2.0"]), /in use here/);
    assert.ok(existsSync(join(home, "scopesoup-0.2.0", "src", "main.ts")));
  }));
});
