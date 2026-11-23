// The offboarding trial on the synthetic stand-in, all in a temporary folder with local bare remotes and a
// fake GitHub. Onboard (the shared settings on the meta ref, the setup script, the CLAUDE.md section and plugin lines merged,
// the manifest), run one Item (filed with the item command; its branch pushed and merged, the merge queue lease and a shared
// resource's lease taken, a batch's branch and pull request left as after a failure, an unpushed branch in a pool clone, the
// .v* copies), then offboard with every group removed. Afterwards the project's remote has no Scope Soup refs or branches, the fake
// GitHub no Scope Soup labels and no open Scope Soup pull request, the patch takes Scope Soup's parts out of the project's files, this
// machine has no Scope Soup folder but the pool clones (the person's), and the person's own checkout is exactly as it was.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { recordInManifest } from "../config/manifest.ts";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";
import { runItemCli } from "../items/cli.ts";
import { createMergeQueue } from "../orchestrator/mergeQueue.ts";
import { realGit } from "../orchestrator/process.ts";
import { unitRef } from "../orchestrator/resources.ts";
import { buildStandin, STANDIN, standinConfig } from "../standin.ts";
import { offboard, recordThings } from "./cli.ts";
import type { FoundPull } from "./plan.ts";
import { SECTION_HEADING } from "./projectFiles.ts";
import type { OffboardGitHub } from "./scan.ts";

const dir = mkdtempSync(join(tmpdir(), "scopesoup-offboard-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSyncRetrying("git", ["-c", `user.name=${STANDIN.author.name}`, "-c", `user.email=${STANDIN.author.email}`, "-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", ...args], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

function fakeGitHub(labels: string[], pulls: FoundPull[]): OffboardGitHub & { closed: number[] } {
  const state = { labels: [...labels], pulls: [...pulls], closed: [] as number[] };
  return {
    repo: "example/tidy-units",
    closed: state.closed,
    labels: async () => [...state.labels],
    pulls: async () => [...state.pulls],
    deleteLabel: async (name) => {
      state.labels = state.labels.filter((each) => each !== name);
    },
    closePull: async (number) => {
      state.pulls = state.pulls.filter((each) => each.number !== number);
      state.closed.push(number);
    },
  };
}

/** Every file under a folder with its content's hash, .git included: the person's checkout must not change at all. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!/[\\/]\.git[\\/](index|FETCH_HEAD|ORIG_HEAD)$/.test(path)) out.push(`${path.slice(root.length)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(root);
  return out;
}

const remoteRefs = (remote: string): string[] => git(remote, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean);

test("stand-in: onboard, run one Item, offboard every group; nothing of Scope Soup's is left but what was kept, and the person's checkout is unchanged", async () => {
  const standin = await buildStandin(join(dir, "standin"));
  const remote = standin.projectRemote;
  const configDir = join(standin.folder, "tidy-units-scopesoup");
  const dataDir = join(configDir, "data");
  mkdirSync(dataDir, { recursive: true });

  // Onboarding's changes, merged on main as the person would merge them: the setup script (from scopesoup/onboard), the CLAUDE.md section, the plugin lines.
  const seed = join(dir, "seed");
  git(dir, "clone", "-q", remote, seed);
  git(seed, "checkout", "-q", "-b", "scopesoup/onboard");
  mkdirSync(join(seed, ".scopesoup"));
  writeFileSync(join(seed, ".scopesoup", "scopesoup-setup.mjs"), "// Scope Soup's setup of a fresh clone (synthetic)\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "Scope Soup's setup of a fresh clone");
  git(seed, "push", "-q", "origin", "scopesoup/onboard");
  git(seed, "checkout", "-q", "main");
  git(seed, "merge", "-q", "--ff-only", "scopesoup/onboard");
  writeFileSync(join(seed, "CLAUDE.md"), ["# tidy-units", "", "Run the tests with node --test.", "", SECTION_HEADING, "", "The backlog is Scope Soup's Items.", ""].join("\n"));
  mkdirSync(join(seed, ".claude"));
  writeFileSync(join(seed, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(node --test)"] }, extraKnownMarketplaces: { scopesoup: { source: { source: "github", repo: "mikaeltulldahl/scopesoup" } } }, enabledPlugins: { "scopesoup@scopesoup": true } }, null, 2) + "\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "Work with Scope Soup");
  git(seed, "push", "-q", "origin", "main");

  // The person's own checkout, with a file of their own that git ignores.
  const person = join(dir, "person", STANDIN.project);
  git(dir, "clone", "-q", remote, person);
  writeFileSync(join(person, ".env"), "TEST_SETTING=1\n");
  writeFileSync(join(person, ".git", "info", "exclude"), ".env\n");
  const before = snapshot(person);

  // This machine's file in a config folder of its own, naming the person's checkout.
  const configFile = join(configDir, "scopesoup.config.json");
  const own = { ...standinConfig(remote), repoPath: standin.metaRepo, workspacesDir: join(dataDir, "workspaces"), streamsDir: join(dataDir, "streams"), workspaces: { kind: "pool", paths: standin.pool, projectSubdir: STANDIN.subdir }, ownClone: person, realPaths: [person] };
  writeFileSync(configFile, JSON.stringify(own, null, 2) + "\n");
  // The manifest, as onboarding's settings:init and `pnpm offboard record` write it, and Scope Soup's start.
  recordInManifest(configFile, [{ kind: "ref", ref: "refs/scopesoup/meta", what: "the shared settings and the Items" }, { kind: "folder", path: standin.metaRepo, what: "Scope Soup's clone of the project" }], "onboarding");
  for (const what of ["setup-script", "claude-md", "plugin-settings"]) recordInManifest(configFile, recordThings(what) ?? [], "onboarding");
  recordInManifest(configFile, [{ kind: "label", repo: "example/tidy-units", name: "priority:major" }], "scopesoup");

  // Run one Item: filed with the item command (on the meta ref, pushed), its branch made in a pool clone, pushed and merged.
  const lines: string[] = [];
  const code = await runItemCli(["new", "--title", "Add decimetres", "--config", configFile, "--no-server"], { env: {}, cwd: dir, out: (line) => lines.push(line), err: (line) => lines.push(line) });
  assert.equal(code, 0, lines.join("\n"));
  git(standin.metaRepo, "push", "-q", "origin", "refs/scopesoup/meta");
  assert.match(git(remote, "ls-tree", "-r", "--name-only", "refs/scopesoup/meta"), /items\/A-1\/item\.md/);
  const one = join(standin.pool[0]!, STANDIN.subdir);
  git(one, "fetch", "-q", "origin");
  git(one, "checkout", "-q", "-B", "scopesoup/A-1", "origin/main");
  writeFileSync(join(one, "src", "units.js"), readFileSync(join(one, "src", "units.js"), "utf8").replace("cm: 0.01,", "cm: 0.01, dm: 0.1,"));
  git(one, "commit", "-q", "-am", "Add decimetres (A-1)");
  git(one, "push", "-q", "origin", "scopesoup/A-1");
  const mergeQueue = createMergeQueue({ git: realGit, repo: standin.metaRepo, remote: "origin", machine: "standin" });
  const at = new Date().toISOString();
  assert.equal((await mergeQueue.acquire(at, 10)).held, true);
  git(one, "push", "-q", "origin", "scopesoup/A-1:main");
  await mergeQueue.release(new Date().toISOString());
  const unit = createMergeQueue({ git: realGit, repo: standin.metaRepo, remote: "origin", machine: "standin", ref: unitRef("emulator", 1), doing: "holds emulator unit 1" });
  assert.equal((await unit.acquire(at, 10)).held, true);
  // A batch's branch left after a failure, with its pull request; a branch only in the other pool clone.
  const batch = `scopesoup/batch-2-${git(one, "rev-parse", "HEAD").slice(0, 7)}`;
  git(one, "checkout", "-q", "-b", batch);
  writeFileSync(join(one, "NOTES.md"), "a batch that failed its check\n");
  git(one, "add", ".");
  git(one, "commit", "-q", "-m", "Batch 2");
  git(one, "push", "-q", "origin", batch);
  const two = join(standin.pool[1]!, STANDIN.subdir);
  git(two, "checkout", "-q", "-b", "scopesoup/A-2");
  writeFileSync(join(two, "WIP.md"), "unpushed work\n");
  git(two, "add", ".");
  git(two, "commit", "-q", "-m", "Unpushed work (A-2)");
  // The copies a format migration keeps.
  writeFileSync(join(configDir, "scopesoup.config.v0.json"), "{}\n");
  writeFileSync(join(dataDir, "scopesoup.sqlite"), "synthetic\n");
  writeFileSync(join(dataDir, "scopesoup.v1.sqlite"), "synthetic\n");
  const github = fakeGitHub(["bug", "scopesoup:claimed", "scopesoup:needs-decision", "priority:major", "priority:minor"], [{ number: 7, title: "Batch 2", head: batch }]);

  const options = { git: realGit, github: () => github, dataDir, running: async () => false, out: join(dir, "export") };
  // The plan only: everything is on it, and nothing is changed.
  const shown = await offboard(configFile, { ...options, remove: new Set(), includeKept: new Set() });
  const text = shown.lines.join("\n");
  for (const thing of ["refs/scopesoup/meta", "refs/scopesoup/merge-queue", "refs/scopesoup/resources/emulator/1", batch, "pull request #7", "scopesoup:claimed", "priority:major", "scopesoup.config.v0.json", "scopesoup.v1.sqlite", "CLAUDE.md", ".claude/settings.json", ".scopesoup/scopesoup-setup.mjs", "scopesoup/A-2", "scopesoup/onboard"]) assert.ok(text.includes(thing), `${thing} is not on the plan:\n${text}`);
  assert.ok(!text.includes("label bug") && !text.includes("Label priority:minor"), text);
  assert.ok(remoteRefs(remote).includes("refs/scopesoup/meta"));
  // Refused while Scope Soup runs.
  const refused = await offboard(configFile, { ...options, running: async () => true, remove: new Set(["work"]), includeKept: new Set() });
  assert.equal(refused.ok, false);
  assert.ok(remoteRefs(remote).includes(`refs/heads/${batch}`));

  // Offboard: every group, kept entries too.
  const all = new Set(["work", "items", "github", "project", "machine"] as const);
  const done = await offboard(configFile, { ...options, remove: all, includeKept: all });
  assert.equal(done.ok, true, done.lines.join("\n"));
  // The project's remote: no Scope Soup ref or branch; main and the merged work stay.
  assert.deepEqual(remoteRefs(remote).filter((ref) => ref.startsWith("refs/scopesoup/") || ref.startsWith("refs/heads/scopesoup/")), []);
  assert.match(git(remote, "log", "--format=%s", "main"), /Add decimetres \(A-1\)/);
  // GitHub (fake): Scope Soup's labels gone, the person's kept, the batch's pull request closed.
  assert.deepEqual(await github.labels(), ["bug", "priority:minor"]);
  assert.deepEqual(github.closed, [7]);
  // The export: the Item as Markdown, the settings, the patch, the report.
  const out = join(dir, "export");
  assert.match(readFileSync(join(out, "items", "A-1.md"), "utf8"), /title: Add decimetres/);
  assert.ok(existsSync(join(out, "settings.json")) && existsSync(join(out, "report.txt")));
  // The patch takes Scope Soup's parts out of the project's files, and nothing else.
  const scratch = join(dir, "scratch");
  git(dir, "clone", "-q", remote, scratch);
  git(scratch, "apply", join(out, "scopesoup-offboard.patch"));
  assert.equal(readFileSync(join(scratch, "CLAUDE.md"), "utf8"), "# tidy-units\n\nRun the tests with node --test.\n");
  assert.deepEqual(JSON.parse(readFileSync(join(scratch, ".claude", "settings.json"), "utf8")), { permissions: { allow: ["Bash(node --test)"] } });
  assert.equal(existsSync(join(scratch, ".scopesoup")), false);
  // This machine: Scope Soup's folders gone; the pool clones (the person's) stay, without Scope Soup's branches; the remotes stay.
  assert.equal(existsSync(configDir), false);
  assert.equal(existsSync(standin.metaRepo), false);
  for (const clone of standin.pool) {
    assert.ok(existsSync(clone));
    assert.equal(git(join(clone, STANDIN.subdir), "for-each-ref", "refs/heads/scopesoup/"), "");
  }
  assert.ok(existsSync(remote) && existsSync(standin.outerRemote));
  // The person's own checkout: not one byte changed.
  assert.deepEqual(snapshot(person), before);
});
