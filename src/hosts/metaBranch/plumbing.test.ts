import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunGit } from "./git.ts";
import { gitIn, resolveRef } from "./git.ts";
import type { TreeEntry } from "./merge.ts";
import { changedFiles, changesSince, checkGitVersion, commitsSince, gitDate, readCommit, readCommits, readTree, sshCommand, writeBlob, writeCommit, writeTreeEntries } from "./plumbing.ts";
import { createTestRepo } from "./testRepo.ts";

test("writeTreeEntries gives the entries readTree gives for the commit made from the tree, through adds, changes, deletes and emptied directories", async () => {
  const repo = createTestRepo();
  try {
    const git = gitIn(repo.dir);
    const person = { name: "Test Person", email: "test.person@example.invalid" };
    const date = gitDate("2026-01-01T00:00:00.000Z");
    const file = async (text: string): Promise<TreeEntry> => ({ mode: "100644", type: "blob", sha: await writeBlob(git, text) });
    const commitOf = (tree: string, parents: string[]): Promise<string> => writeCommit(git, { tree, parents, message: "t", author: person, authorDate: date, committer: person, committerDate: date });

    const first = await writeTreeEntries(git, new Map(), new Map([
      ["items/1/item.md", await file("one")],
      ["items/1/log.jsonl", await file("log")],
      ["items/2/item.md", await file("two")],
      ["only/deep/er/x.txt", await file("x")],
      ["top.txt", await file("top")],
    ]));
    const firstCommit = await commitOf(first.id, []);
    assert.deepEqual(first.tree, await readTree(git, firstCommit));

    const second = await writeTreeEntries(git, first.tree, new Map<string, TreeEntry | null>([
      ["items/1/item.md", await file("one, changed")],
      ["items/3/item.md", await file("three")],
      ["items/2/item.md", null],
      ["only/deep/er/x.txt", null],
      ["new/dir/y.txt", await file("y")],
    ]));
    const secondCommit = await commitOf(second.id, [firstCommit]);
    const read = await readTree(git, secondCommit);
    assert.deepEqual(second.tree, read);
    assert.equal(read.has("items/2"), false);
    assert.equal(read.has("only"), false);

    // A further write on the computed map, as the writer does.
    const third = await writeTreeEntries(git, second.tree, new Map<string, TreeEntry | null>([["top.txt", null], ["items/1/log.jsonl", null], ["items/1/item.md", null]]));
    assert.deepEqual(third.tree, await readTree(git, await commitOf(third.id, [secondCommit])));
  } finally {
    repo.cleanup();
  }
});

test("the batched reads give what the one-at-a-time reads give, in one git call each", async () => {
  const repo = createTestRepo();
  try {
    const ref = "refs/scopesoup/meta";
    const first = repo.commit(ref, { "items/A-1/item.md": "one\n", "items/A-1/log.jsonl": "{}\n", "keep.txt": "k\n" }, "2026-11-18T10:00:00Z");
    const second = repo.commit(ref, { "items/A-1/item.md": "one\n", "items/A-1/log.jsonl": "{}\n{\"a\":1}\n", "keep.txt": "k\n", "items/A-2/item.md": "two\n" }, "2026-11-18T11:00:00Z");
    const third = repo.commit(ref, { "items/A-2/item.md": "two\n", "items/A-2/log.jsonl": "{}\n", "keep.txt": "k\n", "items/A-1/log.jsonl": "{}\n{\"a\":1}\n" }, "2026-11-18T12:00:00Z");
    const fourth = repo.commit(ref, { "items/A-2/item.md": "two\n", "keep.txt": "k\n" }, "2026-11-18T13:00:00Z");
    const real = gitIn(repo.dir);
    let calls = 0;
    const git: RunGit = (args, input, env) => {
      calls++;
      return real(args, input, env);
    };

    const infos = await readCommits(git, [first, second, third, fourth]);
    assert.equal(calls, 1);
    for (const id of [first, second, third, fourth]) assert.deepEqual(infos.get(id), await readCommit(real, id));
    assert.deepEqual(infos.get(second)?.parents, [first]);

    calls = 0;
    const since = await changesSince(git, first, fourth);
    assert.equal(calls, 1);
    assert.deepEqual(since.map((step) => step.commit), await commitsSince(real, first, fourth));
    let previous = first;
    for (const step of since) {
      assert.deepEqual(step.changes, await changedFiles(real, previous, step.commit));
      previous = step.commit;
    }
    // Added, changed and deleted files all show, with null for the absent side.
    assert.deepEqual(since[1]?.changes.map((change) => [change.path, change.from === null, change.to === null]), [["items/A-1/item.md", false, true], ["items/A-2/log.jsonl", true, false]]);
    assert.deepEqual(await changesSince(git, fourth, fourth), []);
  } finally {
    repo.cleanup();
  }
});

test("resolveRef reads a commit, a tag's commit and a missing ref, and refuses anything else, with one git call", async () => {
  const repo = createTestRepo();
  try {
    const commit = repo.commit("refs/scopesoup/meta", { "a.txt": "a\n" }, "2026-11-18T10:00:00Z");
    repo.git(["tag", "-a", "-m", "t", "tagged", commit]);
    repo.git(["update-ref", "refs/scopesoup/tagged", repo.git(["rev-parse", "refs/tags/tagged"])]);
    repo.git(["update-ref", "refs/scopesoup/blob", repo.git(["hash-object", "-w", "--stdin"], "x")]);
    repo.git(["update-ref", "refs/scopesoup/me/below", commit]);
    const real = gitIn(repo.dir);
    let calls = 0;
    const git: RunGit = (args, input, env) => {
      calls++;
      return real(args, input, env);
    };
    assert.equal(await resolveRef(git, "refs/scopesoup/meta"), commit);
    assert.equal(calls, 1);
    assert.equal(await resolveRef(git, "refs/scopesoup/tagged"), commit);
    assert.equal(await resolveRef(git, "refs/scopesoup/absent"), null);
    // A ref below the name does not make the name exist.
    assert.equal(await resolveRef(git, "refs/scopesoup/me"), null);
    await assert.rejects(resolveRef(git, "refs/scopesoup/blob"), /points at a blob, not a commit/);
  } finally {
    repo.cleanup();
  }
});

test("ssh never prompts, and the user's own ssh command is kept", () => {
  assert.equal(sshCommand(undefined, undefined, undefined), "ssh -o BatchMode=yes");
  assert.equal(sshCommand("ssh -i ~/.ssh/work", undefined, undefined), "ssh -i ~/.ssh/work -o BatchMode=yes");
  // GIT_SSH_COMMAND wins over core.sshCommand, as in git.
  assert.equal(sshCommand("ssh -p 2222", "ssh -i other\n", undefined), "ssh -p 2222 -o BatchMode=yes");
  assert.equal(sshCommand(undefined, "ssh -i other\n", "plink"), "ssh -i other -o BatchMode=yes");
  // PuTTY's plink takes -batch.
  assert.equal(sshCommand(undefined, '"C:\\Program Files\\PuTTY\\plink.exe" -i key.ppk', undefined), '"C:\\Program Files\\PuTTY\\plink.exe" -i key.ppk -batch');
  assert.equal(sshCommand("C:/TortoiseGit/bin/TortoisePlink.exe", undefined, undefined), "C:/TortoiseGit/bin/TortoisePlink.exe -batch");
  // GIT_SSH names a program that may not take ssh's options: left alone.
  assert.equal(sshCommand(undefined, undefined, "C:/tools/plink.exe"), null);
});

test("writing needs git 2.29 or newer, and says which git it found", async () => {
  const fake =
    (text: string): RunGit =>
    async () => ({ code: 0, stdout: Buffer.from(`${text}\n`), stderr: "" });
  await checkGitVersion(fake("git version 2.29.0"));
  await checkGitVersion(fake("git version 2.36.1.windows.1"));
  await checkGitVersion(fake("git version 3.0.0"));
  await assert.rejects(checkGitVersion(fake("git version 2.28.9")), /git version 2\.28\.9 is too old: .* needs git 2\.29 or newer/);
  await assert.rejects(checkGitVersion(fake("something else")), /Could not tell which git/);
});
