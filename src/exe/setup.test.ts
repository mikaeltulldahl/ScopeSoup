import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Script } from "node:vm";
import { BUNDLED_NODE, launcherCmd, launcherSh } from "../upgrade/home.ts";
import { fakeReleaseFolder } from "../upgrade/testRelease.ts";
import { exeName, exeProgram, exeRefusal, packEntries, runsScopeSoup } from "./build.ts";
import { NODE_DIR, defaultHome, entryProblem, install, nextSteps, packFiles, parseArgs, partsOf, readPack, setupHomeCommand, type PackEntry } from "./setup.ts";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const HEADER = { version: "1.2.3", folder: "scopesoup-1.2.3", node: "v26.0.0" };
const ENTRIES: PackEntry[] = [
  { path: "scopesoup-1.2.3/package.json", bytes: text(JSON.stringify({ name: "scopesoup", version: "1.2.3" })) },
  { path: "scopesoup-1.2.3/src/scopesoup.ts", bytes: text("// the command\n") },
  { path: "node/node.exe", bytes: text("not really node") },
];

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-exe-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the Windows .exe: the pack, the arguments and what goes where", { concurrency: 4 }, () => {
  test("only the release folder and node/ may be written, with no way out of the home", () => {
    assert.equal(entryProblem("scopesoup-1.2.3/src/main.ts", "scopesoup-1.2.3"), null);
    assert.equal(entryProblem("node/node.exe", "scopesoup-1.2.3"), null);
    for (const bad of ["../x", "scopesoup-1.2.3/../../x", "/etc/x", "C:/x", "scopesoup-1.2.3\\x", "other/x", "node", "scopesoup-1.2.3//x", ""]) {
      assert.notEqual(entryProblem(bad, "scopesoup-1.2.3"), null, bad);
    }
  });

  test("a pack reads back as it was packed, and the parts split into the release and Node", () => {
    const { header, entries } = readPack(packFiles(HEADER, ENTRIES));
    assert.equal(header.folder, "scopesoup-1.2.3");
    assert.equal(header.node, "v26.0.0");
    assert.deepEqual(entries.map((entry) => [entry.path, Buffer.from(entry.bytes).toString()]), ENTRIES.map((entry) => [entry.path, Buffer.from(entry.bytes).toString()]));
    assert.deepEqual(partsOf(header), { release: ["scopesoup-1.2.3/package.json", "scopesoup-1.2.3/src/scopesoup.ts"], node: ["node/node.exe"] });
  });

  test("a pack without Node or the command, or not named after its version, is refused", () => {
    assert.throws(() => packFiles(HEADER, [...ENTRIES, { path: "../evil", bytes: text("") }]), /not a relative path|\.\. part|not inside/);
    assert.throws(() => readPack(packFiles(HEADER, ENTRIES.slice(0, 2))), /no node\/node\.exe/);
    assert.throws(() => readPack(packFiles(HEADER, ENTRIES.slice(1))), /no scopesoup-1\.2\.3\/package\.json/);
    assert.throws(() => readPack(packFiles({ ...HEADER, version: "1.2.4" }, ENTRIES)), /not named after version 1\.2\.4/);
  });

  test("the arguments: --home in two spellings, --help, nothing else", () => {
    assert.deepEqual(parseArgs([]), { home: null, help: false });
    assert.deepEqual(parseArgs(["--home", "D:\\Soup"]), { home: "D:\\Soup", help: false });
    assert.deepEqual(parseArgs(["--home=D:/Soup"]), { home: "D:/Soup", help: false });
    assert.equal(parseArgs(["/?"]).help, true);
    assert.throws(() => parseArgs(["--home"]), /needs a folder/);
    assert.throws(() => parseArgs(["--yes"]), /Unknown argument/);
  });

  test("the default home is in the person's own LOCALAPPDATA", () => {
    assert.equal(defaultHome({ LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" }), "C:\\Users\\sam\\AppData\\Local\\ScopeSoup");
    assert.equal(defaultHome({ USERPROFILE: "C:\\Users\\sam" }), "C:\\Users\\sam\\AppData\\Local\\ScopeSoup");
    assert.throws(() => defaultHome({}), /--home/);
  });

  test("setup-home runs with the bundled Node, and the summary names the launcher", () => {
    assert.deepEqual(setupHomeCommand("D:\\Soup", "scopesoup-1.2.3"), { command: "D:\\Soup\\node\\node.exe", args: ["--disable-warning=ExperimentalWarning", "D:\\Soup\\scopesoup-1.2.3\\src\\scopesoup.ts", "setup-home"] });
    assert.match(nextSteps("D:\\Soup").join("\n"), /D:\\Soup\\bin\\scopesoup\.cmd/);
  });

  test("install writes the release and Node into the home, and leaves the running version and the same Node alone", () => withDir((home) => {
    const packed = packFiles(HEADER, ENTRIES);
    const first = install(packed, home);
    assert.deepEqual(first, { home, folder: "scopesoup-1.2.3", node: "v26.0.0", releaseWritten: true, nodeWritten: true });
    assert.equal(readFileSync(join(home, "scopesoup-1.2.3", "src", "scopesoup.ts"), "utf8"), "// the command\n");
    assert.equal(readFileSync(join(home, "node", "node.exe"), "utf8"), "not really node");
    assert.equal(readFileSync(join(home, "node", "VERSION"), "utf8"), "v26.0.0");
    // Not yet the version that runs: a second run replaces it (an unpacking that did not finish).
    writeFileSync(join(home, "scopesoup-1.2.3", "stray.txt"), "left over");
    assert.equal(install(packed, home).releaseWritten, true);
    assert.equal(existsSync(join(home, "scopesoup-1.2.3", "stray.txt")), false);
    // The version that runs is left as it is, and the same Node is not written again.
    writeFileSync(join(home, "current"), "scopesoup-1.2.3");
    writeFileSync(join(home, "scopesoup-1.2.3", "stray.txt"), "kept");
    const again = install(packed, home);
    assert.equal(again.releaseWritten, false);
    assert.equal(again.nodeWritten, false);
    assert.equal(readFileSync(join(home, "scopesoup-1.2.3", "stray.txt"), "utf8"), "kept");
    // Another Node is written over the old one.
    assert.equal(install(packFiles({ ...HEADER, node: "v26.1.0" }, ENTRIES), home).nodeWritten, true);
    assert.equal(readFileSync(join(home, "node", "VERSION"), "utf8"), "v26.1.0");
    // No temporary folders are left behind.
    assert.deepEqual(readdirSync(home).sort(), ["current", "node", "scopesoup-1.2.3"]);
  }));

  test("the launchers use the bundled Node only when the PATH has no Node 22.18 or newer", () => {
    assert.equal(BUNDLED_NODE, NODE_DIR);
    assert.match(launcherCmd(), /if not exist "%SCOPESOUP_HOME%\\node\\node\.exe" goto run\r\nnode -e "[^"]+" >nul 2>nul && goto run\r\nset "PATH=%SCOPESOUP_HOME%\\node;%PATH%"\r\n:run/);
    assert.match(launcherSh(), /if \[ -f "\$SCOPESOUP_HOME\/node\/node\.exe" \] && ! node -e "[^"]+" >\/dev\/null 2>&1; then PATH="\$SCOPESOUP_HOME\/node:\$PATH"/);
  });

  test("the build: the program is one script with no exports, Node 22.18 or newer on Windows x64", () => {
    const program = exeProgram(readFileSync(new URL("./setup.ts", import.meta.url), "utf8"));
    assert.doesNotThrow(() => new Script(program));
    assert.doesNotMatch(program, /^\s*export\s/m);
    assert.throws(() => exeProgram('import { x } from "./y.ts";\n'), /must import nothing/);
    assert.equal(runsScopeSoup("v22.18.0"), true);
    assert.equal(runsScopeSoup("v22.17.1"), false);
    assert.equal(runsScopeSoup("v26.0.0"), true);
    assert.equal(runsScopeSoup("v20.19.0"), false);
    assert.equal(exeRefusal({ platform: "win32", arch: "x64", nodeVersion: "v26.0.0" }), null);
    assert.match(exeRefusal({ platform: "linux", arch: "x64", nodeVersion: "v26.0.0" }) ?? "", /Windows x64/);
    assert.match(exeRefusal({ platform: "win32", arch: "x64", nodeVersion: "v22.12.0" }) ?? "", /22\.18 or newer/);
    assert.equal(exeName("1.2.3"), "scopesoup-1.2.3-win-x64.exe");
  });

  test("the build packs the release folder under its name and node.exe under node/", () => withDir((dir) => {
    const folder = fakeReleaseFolder(dir, "1.2.3");
    const nodeExe = join(dir, "node.exe");
    writeFileSync(nodeExe, "fake node");
    const paths = packEntries(folder, nodeExe).map((entry) => entry.path).sort();
    assert.ok(paths.includes("scopesoup-1.2.3/src/scopesoup.ts") && paths.includes("scopesoup-1.2.3/web/dist/index.html"));
    assert.ok(paths.includes("node/node.exe"));
    assert.ok(paths.every((path) => entryProblem(path, "scopesoup-1.2.3") === null));
  }));
});
