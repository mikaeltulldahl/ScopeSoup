// What onboarding proposes for the setup of a fresh clone, and the setup script it writes: `--from-clone` copies the ignored
// personal files from the person's own clone, only where git ignores them, and prints names, never contents.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";
import { main, proposeSetup, renderSetupScript, SCRIPT_NAME } from "./setupScript.ts";
import { validateFiles } from "./shared.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-setupscript-"));
  dirs.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) => execFileSyncRetrying("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "pipe", encoding: "utf8" });

/** The person's own clone of a synthetic project: lockfiles, a Makefile with a setup target, and ignored personal files. */
function personsClone(): string {
  const dir = join(temp(), "shop");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, ".gitignore"), ".env\n*.local.json\nnode_modules/\nbig.local.json\nmade.txt\n");
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  mkdirSync(join(dir, "api"));
  writeFileSync(join(dir, "api", "requirements.txt"), "synthetic==1.0\n");
  writeFileSync(join(dir, "Makefile"), "setup:\n\techo set up\ntest:\n\techo test\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  writeFileSync(join(dir, ".env"), "API_TOKEN=synthetic-secret-value\n");
  writeFileSync(join(dir, "settings.local.json"), "{\"port\": 4000}\n");
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "x", ".env"), "not personal\n");
  return dir;
}

describe("setup script", { concurrency: 3 }, () => {
  test("the proposal: installs from the lockfiles, a venv for requirements, the Makefile's setup target, personal files and the files to watch", () => {
    const clone = personsClone();
    const folder = join(temp(), "repo");
    const proposal = proposeSetup(clone, folder);
    assert.deepEqual(proposal.steps.map((step) => [step.run.join(" "), step.cwd ?? ".", step.from]), [
      ["npm ci", ".", "package-lock.json"],
      ["python -m venv .venv", "api", "api/requirements.txt"],
      ["{venv-python} -m pip install -r requirements.txt", "api", "api/requirements.txt"],
      ["make setup", ".", "the setup target in Makefile"],
    ]);
    assert.deepEqual(proposal.personalFiles, [".env", "settings.local.json"]);
    assert.deepEqual(proposal.setupWatch, ["api/requirements.txt", "package-lock.json"]);
    assert.equal(proposal.setupCommand[0], "node");
    // The script is in the repository, run relative to each fresh folder; {{ownClone}} is each machine's own clone.
    assert.deepEqual(proposal.setupCommand, ["node", `.scopesoup/${SCRIPT_NAME}`, "--from-clone", "{{ownClone}}"]);
    assert.equal(proposal.script, join(folder, ".scopesoup", SCRIPT_NAME).replace(/\\/g, "/"));
    // What onboarding writes: setupCommand and setupWatch in the shared file, ownClone in this machine's file, valid as they are.
    const config = validateFiles({ machineName: "laptop-a", repoPath: "repo", ownClone: clone }, { project: "shop", setupCommand: proposal.setupCommand, setupWatch: proposal.setupWatch }, folder);
    assert.ok(config.ok, config.ok ? "" : config.errors.join("; "));
    if (config.ok) assert.deepEqual([config.config.setupCommand, config.config.setupWatch], [["node", `.scopesoup/${SCRIPT_NAME}`, "--from-clone", clone.replace(/\\/g, "/")], proposal.setupWatch]);
    const without = validateFiles({ machineName: "laptop-a", repoPath: "repo" }, { project: "shop", setupCommand: proposal.setupCommand }, folder);
    assert.equal(without.ok, false);
    if (!without.ok) assert.match(without.errors.join(" "), /setupCommand uses \{\{ownClone\}\}, so this machine's scopesoup\.config\.json needs ownClone/);
  });

  test("--write puts the script in the repository's .scopesoup folder; run with --from-clone in a fresh clone it copies the personal files and runs the steps", () => {
    const clone = personsClone();
    const folder = join(temp(), "repo");
    const logged: string[] = [];
    const log = console.log;
    console.log = (line: string) => void logged.push(line);
    let code: number;
    try {
      const steps = JSON.stringify([{ run: ["node", "-e", "require('fs').writeFileSync('made.txt','ok')"], from: "test" }]);
      code = main([clone, folder, "--write", "--project", "shop", "--steps", steps, "--files", JSON.stringify([".env", "settings.local.json", "Makefile", "missing.local.json"])]);
    } finally {
      console.log = log;
    }
    assert.equal(code, 0);
    const script = join(folder, ".scopesoup", SCRIPT_NAME);
    assert.ok(existsSync(script));
    assert.match(JSON.parse(logged.join("\n")).written ? "written" : "", /written/);

    // Scope Soup's fresh clone: no .env, nothing installed.
    const fresh = join(temp(), "work");
    git(clone, "clone", "-q", "-c", "core.autocrlf=false", clone, fresh);
    // The Makefile is tracked, not ignored: the script refuses to copy it, so a tracked or committable file is never overwritten with a secret.
    const refused = spawnSync(process.execPath, [script, "--from-clone", clone], { cwd: fresh, encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Makefile is not ignored by git here, so it is not copied/);

    const good = renderSetupScript("shop", [{ run: ["node", "-e", "require('fs').writeFileSync('made.txt','ok')"], from: "test" }], [".env", "settings.local.json", "missing.local.json"]);
    writeFileSync(script, good);
    const ran = spawnSync(process.execPath, [script, "--from-clone", clone], { cwd: fresh, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(readFileSync(join(fresh, ".env"), "utf8"), "API_TOKEN=synthetic-secret-value\n");
    assert.equal(readFileSync(join(fresh, "settings.local.json"), "utf8"), "{\"port\": 4000}\n");
    assert.equal(readFileSync(join(fresh, "made.txt"), "utf8"), "ok");
    // The refused run above had copied .env before it stopped at the Makefile.
    assert.match(refused.stdout, /Copied from your clone: \.env/);
    assert.match(ran.stdout, /Already there: \.env/);
    assert.match(ran.stdout, /Not in your clone, not copied: missing\.local\.json/);
    // Names only: the secret's value is never printed.
    assert.equal(`${ran.stdout}${ran.stderr}`.includes("synthetic-secret-value"), false);
    // The folder stays clean for git: what the setup made is ignored.
    assert.equal(git(fresh, "status", "--porcelain"), "");
    // Without --from-clone nothing is copied, and the steps still run.
    const bare = spawnSync(process.execPath, [script], { cwd: fresh, encoding: "utf8" });
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /Not copied \(no --from-clone\): \.env/);
  });

  test("a personal file outside the repository is refused when the script is written", () => {
    assert.throws(() => renderSetupScript("shop", [], ["../elsewhere/.env"]), /must be relative to the repository/);
    assert.throws(() => renderSetupScript("shop", [], ["C:/secrets/.env"]), /must be relative to the repository/);
  });
});
