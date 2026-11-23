import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { commandText, commandWords } from "./commandLine.ts";
import { checkCandidates, checkCommandProblem, gitRemoteUrl, proposeCheckCommand, workflowRuns } from "./mergeQueue.ts";

const root = mkdtempSync(join(tmpdir(), "scopesoup-merge-queue-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
let n = 0;

/** A project folder with the given files. */
function project(files: Record<string, string>): string {
  const dir = join(root, `p${n++}`);
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const manifest = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "demo", scripts, ...extra });

test("the proposal: the check script before the test script, with the package manager package.json or the lock file names", () => {
  const linux = { platform: "linux" as const };
  assert.deepEqual(proposeCheckCommand(project({ "package.json": manifest({ check: "a", test: "b" }), "pnpm-lock.yaml": "" }), linux).command, ["pnpm", "run", "check"]);
  assert.deepEqual(proposeCheckCommand(project({ "package.json": manifest({ test: "b" }), "yarn.lock": "" }), linux).command, ["yarn", "run", "test"]);
  assert.deepEqual(proposeCheckCommand(project({ "package.json": manifest({ test: "b" }, { packageManager: "pnpm@10.0.0" }), "package-lock.json": "" }), linux).command, ["pnpm", "run", "test"]);
  assert.deepEqual(proposeCheckCommand(project({ "package.json": manifest({ test: "b" }) }), linux).command, ["npm", "run", "test"]);
  const none = proposeCheckCommand(project({ "package.json": manifest({ build: "c" }) }), linux);
  assert.deepEqual([none.command, none.from], [null, "package.json has no check or test script"]);
  assert.equal(proposeCheckCommand(project({}), linux).command, null);
});

// The Windows lookups join paths the Windows way, so they run on Windows only.
const windowsOnly = { skip: process.platform !== "win32" };

test("on Windows a package manager that is only a .cmd shim is proposed through cmd.exe; a real .exe directly", windowsOnly, () => {
  const bin = project({ "pnpm.cmd": "", "bun.exe": "" });
  const env = { PATH: bin };
  const shim = proposeCheckCommand(project({ "package.json": manifest({ check: "a" }), "pnpm-lock.yaml": "" }), { platform: "win32", env });
  assert.deepEqual(shim.command, ["cmd.exe", "/d", "/c", "pnpm", "run", "check"]);
  assert.match(shim.from, /through cmd\.exe/);
  const exe = proposeCheckCommand(project({ "package.json": manifest({ check: "a" }), "bun.lock": "" }), { platform: "win32", env });
  assert.deepEqual(exe.command, ["bun", "run", "check"]);
});

test("checkCommandProblem: the program must be found on PATH, or in the repository when named with a folder", () => {
  const bin = project({ "tool": "" });
  const repo = project({ "check.sh": "" });
  const linux = { platform: "linux" as const, env: { PATH: bin } };
  assert.equal(checkCommandProblem(["tool", "--all"], repo, linux), null);
  assert.equal(checkCommandProblem(["./check.sh"], repo, linux), null);
  assert.match(checkCommandProblem(["absent"], repo, linux) ?? "", /^Could not find absent on PATH\./);
  assert.match(checkCommandProblem(["./missing.sh"], repo, linux) ?? "", /^Could not find \.\/missing\.sh\./);
});

test("checkCommandProblem on Windows: a shim is refused with the reason, and the program cmd.exe runs must be found too", windowsOnly, () => {
  const bin = project({ "npm.cmd": "", "cmd.exe": "", "node.exe": "" });
  const repo = project({});

  const win = { platform: "win32" as const, env: { PATH: bin, PATHEXT: ".EXE;.CMD" } };
  assert.equal(checkCommandProblem(["node", "--test"], repo, win), null);
  assert.match(checkCommandProblem(["npm", "test"], repo, win) ?? "", /shell shim.*cmd\.exe/);
  assert.equal(checkCommandProblem(["cmd.exe", "/d", "/c", "npm", "test"], repo, win), null);
  assert.equal(checkCommandProblem(["cmd.exe", "/d", "/c", "npm test"], repo, win), null);
  assert.match(checkCommandProblem(["cmd.exe", "/d", "/c", "yarn", "test"], repo, win) ?? "", /^Could not find yarn on PATH, which cmd\.exe is told to run/);
  assert.match(checkCommandProblem(["cmd.exe", "/d"], repo, win) ?? "", /needs \/c/);
});

test("gitRemoteUrl reads the remote's URL from the clone's configuration, contacting nothing", () => {
  const repo = project({});
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@example.invalid:demo.git"]);
  assert.equal(gitRemoteUrl(repo, "origin"), "git@example.invalid:demo.git");
  assert.throws(() => gitRemoteUrl(repo, "upstream"));
});

test("a command line and its words, both ways", () => {
  assert.deepEqual(commandWords(' cmd.exe /d /c  "npm run check" ""'), ["cmd.exe", "/d", "/c", "npm run check", ""]);
  assert.equal(commandText(["cmd.exe", "/c", "npm run check", ""]), 'cmd.exe /c "npm run check" ""');
  assert.deepEqual(commandWords(commandText(["a b", "c"])), ["a b", "c"]);
});

test("the check question's candidates: package.json scripts, CI workflow steps and Makefile targets, likely names first", () => {
  const dir = project({
    "package.json": manifest({ build: "tsc", lint: "eslint .", test: "node --test", start: "node server.js", postinstall: "x" }),
    "pnpm-lock.yaml": "",
    Makefile: "all: build\nbuild:\n\tcc main.c\ncheck: build\n\t./run-tests\nVAR := 1\n.PHONY: all build check\n",
  });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), [
    "name: CI", "on: [push]", "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4",
    "      - run: pnpm install --frozen-lockfile", "      - run: pnpm run lint", "      - name: Tests", "        run: |", "          pnpm test", "          echo done", "      - run: cd web && pnpm build",
  ].join("\n"));
  const candidates = checkCandidates(dir, { platform: "linux" });
  assert.deepEqual(candidates.map((each) => [commandText(each.command), each.from]), [
    ["pnpm run test", "the test script in package.json"],
    ["pnpm run lint", "the lint script in package.json"],
    ["pnpm run build", "the build script in package.json"],
    ["pnpm test", "the workflow .github/workflows/ci.yml"],
    ["make check", "the Makefile"],
    ["make build", "the Makefile"],
    ["make all", "the Makefile"],
  ]);
  assert.deepEqual(workflowRuns("steps:\n  - run: npm test\n  - run: |\n      a\n      b\n  - name: x\n"), ["npm test", "a", "b"]);
  assert.deepEqual(checkCandidates(project({}), { platform: "linux" }), []);
});
