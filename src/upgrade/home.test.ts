import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CLEAN_DAY_MS, cleanUp, homeOf, launcherCmd, launcherSh, markStarted, previousFolder, readPointer, readState, revertFailedStart, setupHome, switchPointer, versionFolders, writePointer } from "./home.ts";
import { fakeReleaseFolder } from "./testRelease.ts";

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "scopesoup-home-"));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const T0 = new Date("2026-11-20T10:00:00Z");
const later = (ms: number): Date => new Date(T0.getTime() + ms);

describe("Scope Soup's home: the pointer, going back and cleaning up", { concurrency: 4 }, () => {
  test("setup-home writes the launcher and the pointer, and leaves the PATH alone", () => withHome((home) => {
    const root = fakeReleaseFolder(home, "0.1.0");
    const path = process.env.PATH;
    const setup = setupHome(root, "win32");
    assert.equal(process.env.PATH, path);
    assert.equal(readPointer(home), "scopesoup-0.1.0");
    assert.equal(readFileSync(join(home, "current"), "utf8"), "scopesoup-0.1.0", "no line end, for `set /p`");
    assert.ok(existsSync(join(home, "bin", "scopesoup.cmd")) && existsSync(join(home, "bin", "scopesoup")));
    assert.match(setup.pathAdvice.join("\n"), /yourself; Scope Soup does not change it/);
    assert.equal(homeOf(root), home);
    // A second setup (another release unpacked later) keeps the pointer.
    const newer = fakeReleaseFolder(home, "0.2.0");
    setupHome(newer, "linux");
    assert.equal(readPointer(home), "scopesoup-0.1.0");
  }));

  test("setup-home refuses a folder not named after its version", () => withHome((home) => {
    const root = fakeReleaseFolder(home, "0.1.0", "unpacked");
    assert.throws(() => setupHome(root), /must be named scopesoup-0\.1\.0/);
  }));

  test("the launchers run the pointer's version and start it again on exit code 75, only for start", () => {
    assert.match(launcherCmd(), /set \/p SCOPESOUP_CURRENT=<"%SCOPESOUP_HOME%\\current"/);
    assert.match(launcherCmd(), /if "%SCOPESOUP_CODE%"=="75" if \/i "%~1"=="start" goto run/);
    assert.match(launcherSh(), /\[ "\$code" = 75 \] && \[ "\$1" = start \]/);
    assert.match(launcherSh(), /src\/scopesoup\.ts" "\$@"/);
  });

  test("switching the pointer and going back one step", () => withHome((home) => {
    fakeReleaseFolder(home, "0.1.0");
    fakeReleaseFolder(home, "0.2.0");
    writePointer(home, "scopesoup-0.1.0");
    assert.equal(previousFolder(home), null);
    switchPointer(home, "scopesoup-0.2.0", T0.toISOString(), join(home, "backups", "x"));
    assert.equal(readPointer(home), "scopesoup-0.2.0");
    assert.equal(previousFolder(home), "scopesoup-0.1.0");
    switchPointer(home, "scopesoup-0.1.0", later(1000).toISOString());
    assert.equal(readPointer(home), "scopesoup-0.1.0");
    assert.equal(previousFolder(home), "scopesoup-0.2.0", "only the version just left");
    assert.throws(() => writePointer(home, "scopesoup-9.9.9"), /not a Scope Soup release folder/);
  }));

  test("a version that cannot start gives the pointer back, once", () => withHome((home) => {
    fakeReleaseFolder(home, "0.1.0");
    fakeReleaseFolder(home, "0.2.0");
    writePointer(home, "scopesoup-0.1.0");
    switchPointer(home, "scopesoup-0.2.0", T0.toISOString());
    assert.equal(revertFailedStart(home, "scopesoup-0.2.0", later(5).toISOString()), "scopesoup-0.1.0");
    assert.equal(readPointer(home), "scopesoup-0.1.0");
    assert.equal(readState(home)?.failedStart, later(5).toISOString());
    assert.equal(revertFailedStart(home, "scopesoup-0.1.0", later(6).toISOString()), null, "the old one does not switch again");
    assert.equal(readPointer(home), "scopesoup-0.1.0");
  }));

  test("a version that started keeps the pointer when it later fails", () => withHome((home) => {
    fakeReleaseFolder(home, "0.1.0");
    fakeReleaseFolder(home, "0.2.0");
    writePointer(home, "scopesoup-0.1.0");
    switchPointer(home, "scopesoup-0.2.0", T0.toISOString());
    markStarted(home, "scopesoup-0.2.0", later(5).toISOString());
    assert.equal(revertFailedStart(home, "scopesoup-0.2.0", later(6).toISOString()), null);
  }));

  test("at most two versions: the older goes after a clean day or at the next upgrade", () => withHome((home) => {
    for (const version of ["0.1.0", "0.2.0", "0.3.0"]) fakeReleaseFolder(home, version);
    writePointer(home, "scopesoup-0.2.0");
    switchPointer(home, "scopesoup-0.3.0", T0.toISOString());
    assert.deepEqual(cleanUp(home, later(1000)), ["scopesoup-0.1.0"], "neither current nor previous");
    assert.deepEqual(cleanUp(home, later(CLEAN_DAY_MS * 2)), [], "not started yet: no clean day");
    markStarted(home, "scopesoup-0.3.0", later(60_000).toISOString());
    assert.deepEqual(cleanUp(home, later(CLEAN_DAY_MS)), [], "less than a day");
    assert.deepEqual(cleanUp(home, later(CLEAN_DAY_MS + 60_000)), ["scopesoup-0.2.0"]);
    assert.deepEqual(versionFolders(home), ["scopesoup-0.3.0"]);
    assert.equal(previousFolder(home), null, "nothing to go back to");
  }));

  test("the next upgrade removes the previous version at once", () => withHome((home) => {
    fakeReleaseFolder(home, "0.1.0");
    fakeReleaseFolder(home, "0.2.0");
    writePointer(home, "scopesoup-0.1.0");
    switchPointer(home, "scopesoup-0.2.0", T0.toISOString());
    assert.deepEqual(cleanUp(home, later(1), true), ["scopesoup-0.1.0"]);
    writeFileSync(join(home, "notes.txt"), "kept");
    assert.ok(existsSync(join(home, "notes.txt")), "only release folders are touched");
  }));
});
