import assert from "node:assert/strict";
import { test } from "node:test";
import { ENDED_FROM_OUTSIDE, gitCommand, isSafeToRepeat, retryGitOnce, retryGitOnceSync, shouldRetryGit } from "./gitRetry.ts";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);

test("the command is the first argument that is not an option or a -c value", () => {
  assert.equal(gitCommand(["-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "update-ref", "-m", "x", "refs/a", SHA, OLD]), "update-ref");
  assert.equal(gitCommand(["--no-pager", "log"]), "log");
  assert.equal(gitCommand(["-C", "some/dir", "status"]), "status");
  assert.equal(gitCommand([]), "");
});

test("reads and writes by content are safe to repeat; a ref move only with its old value", () => {
  for (const args of [
    ["cat-file", "--batch"],
    ["ls-tree", "-r", "-z", SHA],
    ["rev-parse", "--verify", "HEAD"],
    ["for-each-ref", "refs/scopesoup"],
    ["-c", "gc.auto=0", "hash-object", "-w", "-t", "blob", "--stdin"],
    ["mktree", "-z", "--batch"],
    ["commit-tree", "--no-gpg-sign", SHA, "-p", OLD],
    ["update-ref", "-m", "scopesoup: meta write", "refs/scopesoup/meta", SHA, OLD],
    ["update-ref", "-d", "refs/scopesoup/incoming", OLD],
    ["config", "user.name"],
    ["config", "--get", "remote.origin.url"],
  ]) assert.equal(isSafeToRepeat(args), true, args.join(" "));
  for (const args of [
    ["update-ref", "refs/scopesoup/meta", SHA], // no old value: a repeat could move it again
    ["update-ref", "-d", "refs/scopesoup/meta"],
    ["update-ref", "--stdin"],
    ["config", "user.name", "someone"],
    ["config", "--unset", "user.name"],
    ["commit", "-m", "x"],
    ["push", "origin", "main"],
    ["fetch", "origin"],
    ["merge", "main"],
    ["checkout", "main"],
    ["reset", "--hard"],
    ["fast-import", "--quiet"],
    ["worktree", "add", "x"],
    ["-e", "setInterval(() => {}, 1000)"],
  ]) assert.equal(isSafeToRepeat(args), false, args.join(" "));
});

test("only an exit of 4294967295 with nothing on stderr is retried", () => {
  const safe = ["hash-object", "-w", "--stdin"];
  assert.equal(shouldRetryGit(safe, ENDED_FROM_OUTSIDE, ""), true);
  assert.equal(shouldRetryGit(safe, ENDED_FROM_OUTSIDE, " \n"), true);
  assert.equal(shouldRetryGit(safe, ENDED_FROM_OUTSIDE, "fatal: bad object"), false, "git said why");
  assert.equal(shouldRetryGit(safe, 128, ""), false);
  assert.equal(shouldRetryGit(safe, 1, ""), false);
  assert.equal(shouldRetryGit(safe, null, ""), false);
  assert.equal(shouldRetryGit(["commit", "-m", "x"], ENDED_FROM_OUTSIDE, ""), false, "not safe to repeat");
});

test("a git that exits 4294967295 with empty stderr is run once more for a safe command, and the retry is logged", async () => {
  const lines: string[] = [];
  let tries = 0;
  const result = await retryGitOnce(["-c", "gc.auto=0", "commit-tree", SHA], async () => {
    tries++;
    return tries === 1 ? { code: ENDED_FROM_OUTSIDE, stderr: "" } : { code: 0, stderr: "" };
  }, { log: (line) => lines.push(line) });
  assert.deepEqual(result, { code: 0, stderr: "" });
  assert.equal(tries, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^git commit-tree: exited with 4294967295 and no output on stderr after \d+ ms \(ended from outside\); running it once more$/);
});

test("only once: a second exit of 4294967295 is returned as it is", async () => {
  const lines: string[] = [];
  let tries = 0;
  const result = await retryGitOnce(["ls-tree", SHA], async () => {
    tries++;
    return { code: ENDED_FROM_OUTSIDE, stderr: "" };
  }, { log: (line) => lines.push(line) });
  assert.equal(result.code, ENDED_FROM_OUTSIDE);
  assert.equal(tries, 2);
  assert.equal(lines.length, 1);
});

test("an unsafe command that exits 4294967295 with empty stderr is never run again", async () => {
  const lines: string[] = [];
  for (const args of [["commit", "-m", "x"], ["push", "origin", "main"], ["update-ref", "refs/scopesoup/meta", SHA]]) {
    let tries = 0;
    const result = await retryGitOnce(args, async () => {
      tries++;
      return { code: ENDED_FROM_OUTSIDE, stderr: "" };
    }, { log: (line) => lines.push(line) });
    assert.equal(result.code, ENDED_FROM_OUTSIDE);
    assert.equal(tries, 1, args.join(" "));
  }
  assert.deepEqual(lines, []);
});

test("the synchronous form retries a thrown exit of 4294967295 for a safe command only", () => {
  const ended = (stderr: string | Buffer): Error => Object.assign(new Error("Command failed"), { status: ENDED_FROM_OUTSIDE, stderr });
  const lines: string[] = [];
  let tries = 0;
  const value = retryGitOnceSync(["rev-parse", "HEAD"], () => {
    tries++;
    if (tries === 1) throw ended(Buffer.from(""));
    return "ok";
  }, { log: (line) => lines.push(line) });
  assert.equal(value, "ok");
  assert.equal(tries, 2);
  assert.equal(lines.length, 1);

  tries = 0;
  assert.throws(() => retryGitOnceSync(["commit", "-m", "x"], () => {
    tries++;
    throw ended("");
  }, { log: (line) => lines.push(line) }), /Command failed/);
  assert.equal(tries, 1);
  tries = 0;
  assert.throws(() => retryGitOnceSync(["rev-parse", "HEAD"], () => {
    tries++;
    throw ended("fatal: not a git repository");
  }, { log: (line) => lines.push(line) }), /Command failed/);
  assert.equal(tries, 1);
  assert.equal(lines.length, 1);
});
