// Listing, recording and discarding a session's leftovers, in a throwaway repository with synthetic files.
// When and whether a discard happens is tested with the pool, in workspaces.test.ts.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { git, isolateGitConfig } from "./fixtures/git-env.ts";
import { followRestore, restoreCommands } from "./fixtures/restore.ts";
import { discardLeftovers, listLeftovers, recordLeftovers, TooLargeToRecord } from "./leftovers.ts";
import { realGit } from "./process.ts";

const restoreGitConfig = isolateGitConfig();
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restoreGitConfig();
});

function write(repo: string, path: string, content: string | Buffer): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function setup(): { dir: string; repo: string; records: string } {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-leftovers-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, ".gitignore", "*.ignored\n");
  write(repo, "src/a.txt", "a\n");
  write(repo, "src/gone.txt", "gone\n");
  write(repo, "build/tracked.out", "tracked output\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  return { dir, repo, records: join(dir, "streams", "discarded") };
}

const META = { item: "fake:work:1", clone: "/pool/a", branch: "scopesoup/1", at: "2026-11-18T10:00:00.000Z" };

/** Every file of the repository (not .git, not `skip`), byte for byte. */
function files(dir: string, skip: string[] = [], base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const name = relative(base, full).split("\\").join("/");
    if (entry.name === ".git" || skip.includes(name)) continue;
    if (entry.isDirectory()) files(full, skip, base, out);
    else out[name] = readFileSync(full).toString("base64");
  }
  return out;
}

/** What `git status`, the index and every byte say: a restore must bring back exactly this. */
function state(repo: string, skip: string[] = []): string {
  return `${git(repo, "status", "--porcelain", "--untracked-files=all")}\n${git(repo, "ls-files", "--stage")}\n${JSON.stringify(files(repo, skip), null, 1)}`;
}

async function discardAll(repo: string, records: string, keep: string[] = []) {
  const leftovers = await listLeftovers(realGit, repo, keep);
  const recorded = await recordLeftovers(realGit, repo, leftovers, records, META);
  return { leftovers, recorded, done: await discardLeftovers(realGit, repo, leftovers, recorded) };
}

test("what goes is listed exactly: ignored, kept, linked and nested paths stay, and a changed tracked file that is kept is left", async () => {
  const { repo, records } = setup();
  write(repo, "src/a.txt", "edited\n");
  rmSync(join(repo, "src/gone.txt"));
  write(repo, "src/staged.txt", "staged new\n");
  git(repo, "add", "src/staged.txt");
  write(repo, "src/new.txt", "new\n");
  write(repo, "deep/er/file.bin", Buffer.from([0, 1, 2, 255]));
  write(repo, "cache.ignored", "ignored\n");
  write(repo, "build/out.o", "untracked output\n");
  write(repo, "build/tracked.out", "tracked output, rebuilt\n");
  write(repo, "-rf", "a file named like an option\n");
  mkdirSync(join(repo, "nested"));
  git(join(repo, "nested"), "init", "-q");
  write(repo, "nested/inner.txt", "inner\n");
  // A link out of the repository (a junction on Windows needs no privilege): what it points at is never removed.
  const outside = join(repo, "..", "outside");
  write(outside, "precious.txt", "outside the repository\n");
  symlinkSync(outside, join(repo, "link"), process.platform === "win32" ? "junction" : "dir");

  const leftovers = await listLeftovers(realGit, repo, ["build/"]);
  // Git lists the link itself, or (Git for Windows, for a junction) the files behind it: kept either way.
  const linked = leftovers.keptUntracked.filter((path) => path === "link" || path.startsWith("link/"));
  assert.equal(linked.length, 1, JSON.stringify(leftovers));
  assert.deepEqual(leftovers.tracked.sort(), ["src/a.txt", "src/gone.txt", "src/staged.txt"]);
  assert.deepEqual(leftovers.untracked.sort(), ["-rf", "deep/er/file.bin", "src/new.txt"]);
  assert.deepEqual(leftovers.keptTracked, ["build/tracked.out"]);
  assert.deepEqual(leftovers.keptUntracked.filter((path) => !linked.includes(path)).sort(), ["build/out.o", "nested/"]);

  const recorded = await recordLeftovers(realGit, repo, leftovers, records, META);
  assert.ok(recorded.dir.startsWith(records));
  const done = await discardLeftovers(realGit, repo, leftovers, recorded);
  assert.deepEqual({ ...done, restored: done.restored.sort(), removed: done.removed.sort() }, { restored: ["src/a.txt", "src/gone.txt", "src/staged.txt"], removed: ["-rf", "deep/er/file.bin", "src/new.txt"], left: [] });
  assert.equal(readFileSync(join(repo, "src/a.txt"), "utf8"), "a\n");
  assert.equal(readFileSync(join(repo, "src/gone.txt"), "utf8"), "gone\n");
  for (const path of ["src/staged.txt", "src/new.txt", "deep/er/file.bin", "-rf"]) assert.equal(existsSync(join(repo, path)), false, path);
  assert.equal(readFileSync(join(repo, "cache.ignored"), "utf8"), "ignored\n");
  assert.equal(readFileSync(join(repo, "build/out.o"), "utf8"), "untracked output\n");
  assert.equal(readFileSync(join(repo, "build/tracked.out"), "utf8"), "tracked output, rebuilt\n");
  assert.equal(readFileSync(join(repo, "nested/inner.txt"), "utf8"), "inner\n");
  assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "outside the repository\n");
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), `M build/tracked.out\n?? build/out.o\n?? ${linked[0]}\n?? nested/`);
  const manifest = JSON.parse(readFileSync(join(recorded.dir, "discarded.json"), "utf8"));
  assert.deepEqual(manifest.kept.tracked, ["build/tracked.out"]);
  assert.match(manifest.state, /^Discarded\./);
});

test("after a partial discard the record holds only what was discarded, and following RESTORE.md literally brings that back and leaves newer work alone", async () => {
  const { repo, records } = setup();
  write(repo, "src/a.txt", "edited\n");
  write(repo, "src/gone.txt", "staged change\n");
  git(repo, "add", "src/gone.txt");
  write(repo, "build/tracked.out", "rebuilt\n");
  write(repo, "u.txt", "the session's scratch\n");
  write(repo, "v/w.txt", "another scratch file\n");
  const leftovers = await listLeftovers(realGit, repo, []);
  const recorded = await recordLeftovers(realGit, repo, leftovers, records, META);
  // After the record: a person rewrites one untracked file and one tracked file. Both must be left, and stay so.
  write(repo, "u.txt", "newer work by a person\n");
  write(repo, "build/tracked.out", "newer tracked work\n");
  const done = await discardLeftovers(realGit, repo, leftovers, recorded);
  assert.deepEqual(done.left.map((entry) => entry.path).sort(), ["build/tracked.out", "u.txt"]);
  assert.deepEqual(done.restored.sort(), ["src/a.txt", "src/gone.txt"]);
  assert.deepEqual(done.removed, ["v/w.txt"]);

  // The record describes the outcome, and holds no copy of what was left.
  const manifest = JSON.parse(readFileSync(join(recorded.dir, "discarded.json"), "utf8"));
  assert.deepEqual({ restored: manifest.restored.sort(), removed: manifest.removed, left: manifest.left.map((entry: { path: string }) => entry.path).sort() },
    { restored: ["src/a.txt", "src/gone.txt"], removed: ["v/w.txt"], left: ["build/tracked.out", "u.txt"] });
  assert.deepEqual(Object.keys(files(join(recorded.dir))).sort(), ["RESTORE.md", "discarded.json", "files/v/w.txt", "staged.diff", "worktree.diff"]);
  assert.doesNotMatch(readFileSync(join(recorded.dir, "worktree.diff"), "utf8"), /tracked\.out/);

  // Follow it literally.
  followRestore(recorded.dir);
  assert.equal(readFileSync(join(repo, "src/a.txt"), "utf8"), "edited\n");
  assert.equal(git(repo, "show", ":src/gone.txt"), "staged change");
  assert.equal(readFileSync(join(repo, "v/w.txt"), "utf8"), "another scratch file\n");
  assert.equal(readFileSync(join(repo, "u.txt"), "utf8"), "newer work by a person\n", "the file that was left keeps its newer content");
  assert.equal(readFileSync(join(repo, "build/tracked.out"), "utf8"), "newer tracked work\n");
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "M build/tracked.out\n M src/a.txt\nM  src/gone.txt\n?? u.txt\n?? v/w.txt");
});

test("a full discard of a staged-only change, a deletion, a binary, odd names and a file taken out of the index comes back exactly by RESTORE.md", async () => {
  const { repo, records } = setup();
  write(repo, "src/staged only.txt", "x\n");
  write(repo, "-tracked.txt", "tracked, named like an option\n");
  git(repo, "add", "--", "src/staged only.txt", "-tracked.txt");
  git(repo, "commit", "-q", "-m", "more");
  // Names a shell command would read as options.
  write(repo, "-tracked.txt", "changed\n");
  write(repo, "-rf", "untracked, named like an option\n");
  write(repo, "-n dir/x.bin", Buffer.from([1, 2, 3]));
  write(repo, "src/staged only.txt", "in the index only\n");
  git(repo, "add", "src/staged only.txt");
  write(repo, "src/staged only.txt", "x\n");
  rmSync(join(repo, "src/a.txt"));
  const binary = Buffer.alloc(3000);
  for (let index = 0; index < binary.length; index++) binary[index] = (index * 7) % 256;
  write(repo, "build/tracked.out", binary);
  write(repo, "src/sp äce é.txt", "an odd name\n");
  write(repo, "deep/sub dir/new.bin", Buffer.from([0, 255, 10, 13, 0]));
  git(repo, "rm", "-q", "--cached", "src/gone.txt");
  write(repo, "src/gone.txt", "changed after git rm --cached\n");
  const before = state(repo);

  const { recorded, done } = await discardAll(repo, records);
  assert.equal(done.left.length, 0, JSON.stringify(done.left));
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "");
  followRestore(recorded.dir);
  assert.equal(state(repo), before);
});

test("when RESTORE.md cannot be written, discarded.json does not claim it", async () => {
  const { repo, records } = setup();
  write(repo, "new.txt", "new\n");
  const leftovers = await listLeftovers(realGit, repo, []);
  const recorded = await recordLeftovers(realGit, repo, leftovers, records, META);
  mkdirSync(join(recorded.dir, "RESTORE.md"));
  const done = await discardLeftovers(realGit, repo, leftovers, recorded);
  assert.deepEqual(done.removed, ["new.txt"]);
  assert.match(done.recordError ?? "", /RESTORE\.md could not be written/);
  const manifest = JSON.parse(readFileSync(join(recorded.dir, "discarded.json"), "utf8"));
  assert.equal(manifest.restoreSteps, null);
  assert.match(manifest.state, /RESTORE\.md could not be written .*bring it back by hand/);
  assert.deepEqual(manifest.removed, ["new.txt"]);
});

test("with nothing staged RESTORE.md has no staged step, and its steps run; with nothing to bring back it has none", async () => {
  const { repo, records } = setup();
  write(repo, "src/a.txt", "edited\n");
  write(repo, "new.txt", "new\n");
  const before = state(repo);
  const { recorded } = await discardAll(repo, records);
  const commands = restoreCommands(recorded.dir);
  assert.equal(commands.some((words) => words.includes("--cached")), false, JSON.stringify(commands));
  assert.equal(existsSync(join(recorded.dir, "staged.diff")), false);
  followRestore(recorded.dir);
  assert.equal(state(repo), before);

  // Only untracked files: no diff step at all.
  git(repo, "checkout", "--", "src/a.txt");
  const { recorded: second } = await discardAll(repo, records);
  assert.deepEqual(restoreCommands(second.dir).map((words) => words[0]), ["cd", "cp"]);
  followRestore(second.dir);
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "new\n");
});

test("a tracked file whose path is now a folder of untracked files is left, with that folder, and the rest goes", async () => {
  const { repo, records } = setup();
  rmSync(join(repo, "src/gone.txt"));
  write(repo, "src/gone.txt/inside.txt", "a folder where a tracked file was\n");
  write(repo, "src/a.txt", "edited\n");
  const leftovers = await listLeftovers(realGit, repo, []);
  assert.deepEqual(leftovers.keptTracked, ["src/gone.txt"]);
  assert.deepEqual(leftovers.keptUntracked, ["src/gone.txt/inside.txt"]);
  assert.deepEqual(leftovers.tracked, ["src/a.txt"]);
  const recorded = await recordLeftovers(realGit, repo, leftovers, records, META);
  const done = await discardLeftovers(realGit, repo, leftovers, recorded);
  assert.deepEqual([done.restored, done.removed], [["src/a.txt"], []]);
  assert.equal(readFileSync(join(repo, "src/gone.txt/inside.txt"), "utf8"), "a folder where a tracked file was\n");
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "D src/gone.txt\n?? src/gone.txt/inside.txt");
});

test("with core.autocrlf on in the repository, RESTORE.md brings the content back; only line endings may differ", async () => {
  const { repo, records } = setup();
  git(repo, "config", "core.autocrlf", "true");
  write(repo, "src/a.txt", "edited\nsecond line\n");
  write(repo, "notes.txt", "untracked\n");
  const { recorded } = await discardAll(repo, records);
  followRestore(recorded.dir);
  assert.equal(readFileSync(join(repo, "src/a.txt"), "utf8").replace(/\r\n/g, "\n"), "edited\nsecond line\n");
  assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "untracked\n", "a copied file comes back byte for byte");
});

test("staged content the working tree no longer shows comes back from staged.diff", async () => {
  const { repo, records } = setup();
  write(repo, "src/a.txt", "only in the index\n");
  git(repo, "add", "src/a.txt");
  write(repo, "src/a.txt", "a\n");
  const { recorded } = await discardAll(repo, records);
  assert.equal(git(repo, "status", "--porcelain"), "");
  followRestore(recorded.dir);
  assert.equal(git(repo, "show", ":src/a.txt"), "only in the index");
});

test("only what was listed and recorded goes: a file that appears or changes afterwards stays, as does a tracked file changed after the record", async () => {
  const { repo, records } = setup();
  write(repo, "src/new.txt", "new\n");
  write(repo, "src/changes.txt", "first\n");
  write(repo, "src/a.txt", "edited\n");
  write(repo, "src/gone.txt", "edited too\n");
  const leftovers = await listLeftovers(realGit, repo, []);
  const recorded = await recordLeftovers(realGit, repo, leftovers, records, META);
  write(repo, "src/appeared.txt", "after the listing\n");
  write(repo, "src/changes.txt", "second, longer\n");
  write(repo, "src/a.txt", "edited again\n");
  const done = await discardLeftovers(realGit, repo, leftovers, recorded);
  assert.deepEqual(done.restored, ["src/gone.txt"]);
  assert.deepEqual(done.removed, ["src/new.txt"]);
  assert.deepEqual(done.left.map((entry) => `${entry.path}: ${entry.why}`).sort(), ["src/a.txt: it changed after it was recorded", "src/changes.txt: it changed after it was copied"]);
  assert.equal(readFileSync(join(repo, "src/appeared.txt"), "utf8"), "after the listing\n");
  assert.equal(readFileSync(join(repo, "src/changes.txt"), "utf8"), "second, longer\n");
  assert.equal(readFileSync(join(repo, "src/a.txt"), "utf8"), "edited again\n");
  const again = await recordLeftovers(realGit, repo, await listLeftovers(realGit, repo, []), records, META);
  assert.notEqual(again.dir, recorded.dir, "a second record at the same time gets a folder of its own");
});

test("a file that cannot be removed is left and named, and the rest goes; leftovers over the cap, copies or diffs, are not recorded at all", async () => {
  const { repo, records } = setup();
  write(repo, "one.txt", "1\n");
  write(repo, "two.txt", "2\n");
  write(repo, "src/a.txt", "edited\n");
  const leftovers = await listLeftovers(realGit, repo, []);
  await assert.rejects(recordLeftovers(realGit, repo, leftovers, records, META, 3), (error) => error instanceof TooLargeToRecord && /come to 4 bytes, more than the 3 bytes/.test(error.message));
  assert.equal(existsSync(records), false, "nothing was written");
  // The copies fit; with the diff they do not.
  await assert.rejects(recordLeftovers(realGit, repo, leftovers, records, META, 50), (error) => error instanceof TooLargeToRecord);
  assert.deepEqual(readdirSync(records), [], "the partial record is removed again");
  const recorded = await recordLeftovers(realGit, repo, leftovers, records, META, 100_000);
  const done = await discardLeftovers(realGit, repo, leftovers, recorded, (path) => {
    if (path.endsWith("one.txt")) throw new Error("EBUSY: resource busy or locked");
    rmSync(path);
  });
  assert.deepEqual(done, { restored: ["src/a.txt"], removed: ["two.txt"], left: [{ path: "one.txt", why: "it could not be removed: EBUSY: resource busy or locked" }] });
  assert.equal(readFileSync(join(repo, "one.txt"), "utf8"), "1\n");
  assert.equal(existsSync(join(recorded.dir, "files", "one.txt")), false, "no copy of what was left");
});

test("a pattern in the machine's global excludes file counts as ignored: such a file is kept", async () => {
  const { dir, repo, records } = setup();
  write(dir, "global-excludes", "*.cache\n");
  const config = join(dir, "global-gitconfig");
  writeFileSync(config, `[core]\n\texcludesFile = ${join(dir, "global-excludes").split("\\").join("/")}\n`);
  write(repo, "model.cache", "a compile cache the machine's git ignores\n");
  write(repo, "scratch.txt", "the session's\n");
  // The machine's configuration is given to these git calls only, never through process.env (shared with the other tests).
  const machine: typeof realGit = (args, cwd, input, env) => realGit(args, cwd, input, { GIT_CONFIG_GLOBAL: config, ...env });
  const leftovers = await listLeftovers(machine, repo, []);
  assert.deepEqual(leftovers.untracked, ["scratch.txt"]);
  await discardLeftovers(machine, repo, leftovers, await recordLeftovers(machine, repo, leftovers, records, META));
  assert.equal(readFileSync(join(repo, "model.cache"), "utf8"), "a compile cache the machine's git ignores\n");
  assert.equal(existsSync(join(repo, "scratch.txt")), false);
  // Without that file the same cache would be one of the leftovers.
  assert.deepEqual((await listLeftovers(realGit, repo, [])).untracked, ["model.cache"]);
});
