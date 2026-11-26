// Sharing the meta ref when things go wrong: a hook that never ends, a lock left behind, three
// machines on one item, two machines with one id prefix, histories that do not fit. Two or three
// clones of one temporary bare repository each; a hidden ref; a global git config with signing
// switched on and a pre-push hook. All data is synthetic.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import type { Ref } from "../../model/types.ts";
import type { MetaBranchConfig, MetaBranchHost } from "./adapter.ts";
import { main as acceptMain } from "./accept.ts";
import { createMetaBranchHost } from "./adapter.ts";
import type { RunGit } from "./git.ts";
import { gitIn } from "./git.ts";
import { parseLog } from "./log.ts";
import type { TestClone, TestRepo } from "./testRepo.ts";
import { cloneTestRepo, createTestRepo } from "./testRepo.ts";
import { retrySpawn } from "../spawnRetry.ts";

const REF = "refs/scopesoup/meta";
const TRACKING = "refs/scopesoup-remote/origin/scopesoup/meta";
const INCOMING = "refs/scopesoup-incoming/origin/scopesoup/meta";

const home = mkdtempSync(join(tmpdir(), "scopesoup-home-"));
const hooks = join(home, "hooks");
mkdirSync(hooks);
const slash = (path: string): string => path.replaceAll("\\", "/");
// A sleep length no other program or test process uses, so counting these counts only this file's own.
// Each hanging test gets its own (the base plus one), so tests may run side by side.
const LONG_SLEEP_BASE = 100000 + (process.pid % 800000);
let sleepCount = 0;
const nextSleep = (): string => String(LONG_SLEEP_BASE + ++sleepCount);
// A pre-push hook runs in the root of the working tree, so it finds the flag of the clone that is pushing. With a
// `hang` file in the clone's `.git` (holding the sleep length) the hook never ends. It starts children the way hooks do
// (a background subshell, a background sleep) and keeps writing to `loop` and `loop-child` there, so that any survivor shows.
const hangFlag = (clone: TestClone): string => join(clone.dir, ".git", "hang");
const loopFile = (clone: TestClone): string => join(clone.dir, ".git", "loop");
const childLoopFile = (clone: TestClone): string => join(clone.dir, ".git", "loop-child");
writeFileSync(
  join(hooks, "pre-push"),
  `#!/bin/sh\ncat > /dev/null\nif [ -f .git/hang ]; then\n  read secs < .git/hang\n  ( while :; do echo y >> .git/loop-child; sleep 0.2; done ) &\n  sleep "$secs" &\n  while :; do echo x >> .git/loop; sleep 0.2; done\nfi\nexit 0\n`,
);
chmodSync(join(hooks, "pre-push"), 0o755);
writeFileSync(join(home, "gitconfig"), `[core]\n\thooksPath = ${slash(hooks)}\n[push]\n\tgpgSign = true\n[gpg]\n\tprogram = scopesoup-no-such-signer\n`);
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  rmSync(home, { recursive: true, force: true });
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.global;
  if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
});

function clock(start = "2026-11-18T09:00:00Z"): () => string {
  let at = Date.parse(start);
  return () => new Date((at += 1000)).toISOString();
}

function remote(): TestRepo {
  const origin = createTestRepo();
  cleanups.push(() => origin.cleanup());
  origin.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  origin.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  return origin;
}

interface Laptop {
  clone: TestClone;
  host: MetaBranchHost;
  /** While `on`, fetch, push and ls-remote fail as if the network were down; `timeoutMs` is how long each may run. */
  offline: { on: boolean; timeoutMs: number };
}

/** A machine with a clone. `wrapped`: its network can be switched off; without it the adapter runs its own git (and `stop()` ends it). */
function laptop(origin: TestRepo, machine: string, prefix: string, more: Partial<MetaBranchConfig> = {}, clone = cloneTestRepo(origin), wrapped = true): Laptop {
  cleanups.push(() => clone.cleanup());
  const offline = { on: false, timeoutMs: more.networkTimeoutMs ?? 60_000 };
  // The time limit can change during a test: a short one while a hook hangs, a long one after, so a slow machine does not end an honest push.
  const network: RunGit = async (args, input, env) => (offline.on ? { code: 128, stdout: Buffer.alloc(0), stderr: "fatal: the network is down (test)" } : gitIn(clone.dir, { timeoutMs: offline.timeoutMs })(args, input, env));
  const host = createMetaBranchHost({ repoDir: clone.dir, ref: REF, allowWrites: true, person: { name: `Person ${machine}`, email: `${machine}@example.invalid` }, machine, idPrefix: prefix, now: clock(), ...(wrapped ? { network } : {}), ...more });
  return { clone, host, offline };
}

const work = (id: string): Ref => ({ host: "metaBranch", kind: "work", id });
const port = (laptop: Laptop) => laptop.host.write as Required<NonNullable<MetaBranchHost["write"]>>;
const writer = (laptop: Laptop) => {
  assert.ok(laptop.host.writer);
  return laptop.host.writer;
};
const show = (repo: { git(args: string[]): string }, path: string): string => repo.git(["cat-file", "-p", `${REF}:${path}`]);
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const sizeOf = (file: string): number => (existsSync(file) ? statSync(file).size : 0);
/**
 * The running `sleep <seconds>` processes, by command line (synthetic durations, so another program's sleep never matches).
 * Not synchronous: on a busy machine the listing takes seconds, and the tests running beside this one must not stop for it.
 */
async function sleepers(seconds: string): Promise<string[]> {
  const [command, args] =
    process.platform === "win32"
      ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='sleep.exe'\" | ForEach-Object { $_.CommandLine }"]]
      : ["ps", ["-eo", "args"]];
  const { stdout } = await retrySpawn(command, () => promisify(execFile)(command, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
  return stdout.split(/\r?\n/).filter((line) => new RegExp(`sleep(\\.exe"?)? +${seconds}\\s*$`).test(line.trim()));
}
const claim = { kind: "claimed", by: { who: "robin", agent: false }, fields: { until: "2026-11-18T18:00:00Z" } };

describe("sharing", { concurrency: 6 }, () => {
test("a pre-push hook that never ends: the push is ended with everything it started, the write is pending, and the next round shares it", async () => {
  const origin = remote();
  const a = laptop(origin, "laptop-a", "A");
  await port(a).createWork({ title: "Before the hang" });
  const longSleep = nextSleep();
  writeFileSync(hangFlag(a.clone), longSleep);
  // Short only while the hook hangs; the honest push after it gets the usual limit, so a busy machine cannot make it time out too.
  a.offline.timeoutMs = 1500;
  try {
    const started = Date.now();
    const outcome = await port(a).appendLog(work("A-1"), claim);
    // Were the hook not ended, the call would not return at all; this only fails a stuck call early. It times a whole
    // write (a dozen git processes, then the kill), which took up to 42 s on a machine running two checks side by side.
    assert.ok(Date.now() - started < 60_000, `took ${Date.now() - started} ms`);
    assert.equal(outcome.shared, "pending");
    assert.match(outcome.problem ?? "", /did not finish within 1500 ms; it and what it started were ended/);
    // Nothing the hook started runs on: not the hook, not the subshell it put in the background.
    await pause(400);
    const sizes = [sizeOf(loopFile(a.clone)), sizeOf(childLoopFile(a.clone))];
    assert.ok(sizes.every((size) => size > 0), "the hook and its child ran");
    await pause(700);
    assert.deepEqual([sizeOf(loopFile(a.clone)), sizeOf(childLoopFile(a.clone))], sizes, "the hook and what it started were ended with the push");
    // And the background `sleep <longSleep>` is gone too.
    assert.deepEqual(await sleepers(longSleep), []);
  } finally {
    rmSync(hangFlag(a.clone), { force: true });
    a.offline.timeoutMs = 60_000;
  }
  // A read is not held up either, and the next round pushes the waiting commit.
  assert.equal((await writer(a).share()).state, "shared");
  assert.match(show(origin, "items/A-1/log.jsonl"), /"kind":"claimed"/);
});

test("a lock left behind by an ended git: Scope Soup's own scratch ref is unlocked, the meta ref's lock is reported and left", async () => {
  const origin = remote();
  const a = laptop(origin, "laptop-a", "A");
  await port(a).createWork({ title: "One" });
  const gitDir = join(a.clone.dir, ".git");
  const old = new Date(Date.now() - 60 * 60_000);
  const lock = (ref: string): string => {
    const path = join(gitDir, `${ref}.lock`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    utimesSync(path, old, old);
    return path;
  };
  const incomingLock = lock(INCOMING);
  const metaLock = lock(REF);
  const fresh = join(gitDir, `${TRACKING}.lock`);
  writeFileSync(fresh, ""); // young: another git may be using it right now
  const report = await writer(a).share();
  assert.equal(existsSync(incomingLock), false);
  assert.equal(existsSync(metaLock), true);
  assert.equal(existsSync(fresh), true);
  assert.ok(report.locks.some((line) => line.startsWith("removed ") && line.includes("scopesoup-incoming")));
  assert.ok((report.problem ?? "").includes(metaLock) && /delete that file/.test(report.problem ?? ""));
  assert.equal(writer(a).lastSharing(), report);
  rmSync(metaLock);
  rmSync(fresh);
});

test("three laptops edit one item.md: both other versions are kept, and a resolution removes only the version its person saw", async () => {
  const origin = remote();
  const [a, b, c] = [laptop(origin, "laptop-a", "A"), laptop(origin, "laptop-b", "B"), laptop(origin, "laptop-c", "C")];
  await port(a).createWork({ title: "Shared" });
  await writer(b).share();
  await writer(c).share();
  await port(a).editWork(work("A-1"), { title: "Title from a" });
  assert.equal((await port(b).editWork(work("A-1"), { title: "Title from b" })).conflict, true);
  await writer(a).share();
  // a's person sees one version put aside (b's); then c's edit arrives too.
  const seen = (await writer(a).versions("A-1")).aside;
  assert.deepEqual(seen.map((version) => /title: (.*)/.exec(version.text)?.[1]), ["Title from b"]);
  assert.equal((await port(c).editWork(work("A-1"), { title: "Title from c" })).conflict, true);
  // A resolution that names nothing settles nothing: refused.
  await assert.rejects(port(a).editWork(work("A-1"), { title: "Merged by a" }, { resolveConflict: { supersedes: [] } }), /must name the versions/);
  const outcome = await port(a).editWork(work("A-1"), { title: "Merged by a" }, { resolveConflict: { supersedes: seen.map((version) => version.blob) } });
  // c's version was never seen: it stays, and the item is still in conflict.
  assert.deepEqual([outcome.shared, outcome.conflict], ["shared", true]);
  const after = await writer(c).share().then(() => writer(c).versions("A-1"));
  assert.match(after.itemMd ?? "", /title: Merged by a/);
  assert.deepEqual(after.aside.map((version) => /title: (.*)/.exec(version.text)?.[1]), ["Title from c"]);
});

test("a round that cannot push counts the commits that wait, and a later one that pushes counts none", async () => {
  const origin = remote();
  const a = laptop(origin, "laptop-a", "W");
  await port(a).createWork({ title: "Shared" });
  a.offline.on = true;
  await port(a).createWork({ title: "Waits one" });
  await port(a).createWork({ title: "Waits two" });
  const offline = await writer(a).share();
  assert.deepEqual([offline.state, offline.waiting], ["pending", 2]);
  a.offline.on = false;
  const back = await writer(a).share();
  assert.deepEqual([back.state, back.waiting], ["shared", 0]);
});

test("two laptops with one id prefix: the item created second moves to the next free id with its own lines, and is never merged into the other", async () => {
  const origin = remote();
  const a = laptop(origin, "laptop-a", "X");
  const c = laptop(origin, "laptop-c", "X");
  await writer(c).share();
  await port(a).createWork({ title: "From a" });
  await port(a).appendLog(work("X-1"), claim);
  // c is offline while it creates its own X-1 and claims it.
  c.offline.on = true;
  assert.equal((await port(c).createWork({ title: "From c" })).shared, "pending");
  await port(c).appendLog(work("X-1"), { ...claim, by: { who: "sam", agent: false } });
  c.offline.on = false;
  const report = await writer(c).share();
  assert.deepEqual([report.state, report.renamed], ["shared", [{ from: "X-1", to: "X-2" }]]);
  await writer(a).share();
  for (const side of [a.clone, c.clone, origin]) {
    assert.match(show(side, "items/X-1/item.md"), /^---\nid: X-1\ntitle: From a\n/);
    assert.match(show(side, "items/X-2/item.md"), /^---\nid: X-2\ntitle: From c\n/);
    assert.deepEqual(parseLog(show(side, "items/X-1/log.jsonl")).entries.map((entry) => entry.by.who), ["robin"]);
    assert.deepEqual(parseLog(show(side, "items/X-2/log.jsonl")).entries.map((entry) => entry.by.who), ["sam"]);
  }
  assert.deepEqual(origin.git(["ls-tree", "--name-only", `${REF}:items/X-1`]).split("\n"), ["item.md", "log.jsonl"]);
  const read = (await a.host.work.listWork()).items.map((item) => [item.ref.id, item.title, item.needsDecision ?? false]);
  assert.deepEqual(read, [["X-1", "From a", false], ["X-2", "From c", false]]);
});

test("a first share with an unrelated local history: this machine's commits go on top by the rules, nothing is overwritten", async () => {
  const origin = remote();
  const a = laptop(origin, "laptop-a", "A");
  const b = laptop(origin, "laptop-b", "B");
  await port(a).createWork({ title: "From a" });
  // b never fetched: its meta ref starts its own history.
  b.offline.on = true;
  await port(b).createWork({ title: "From b" });
  b.offline.on = false;
  assert.equal((await writer(b).share()).state, "shared");
  assert.deepEqual(origin.git(["ls-tree", "--name-only", `${REF}:items`]).split("\n"), ["A-1", "B-1"]);
  // a's commit is still in the history: b's went on top of it.
  assert.equal(origin.git(["rev-list", "--count", REF]), "2");
});

test("a fetched history is checked commit by commit: a line removed and written back changed, or a merge commit, is refused", async () => {
  const origin = remote();
  const a = laptop(origin, "laptop-a", "A");
  await port(a).createWork({ title: "One" });
  await port(a).appendLog(work("A-1"), claim);
  const log = show(origin, "items/A-1/log.jsonl") + "\n";
  const itemMd = show(origin, "items/A-1/item.md") + "\n";
  // Someone empties the log in one commit and writes it back with the line changed in the next: the ends alone look like an append.
  origin.commit(REF, { "items/A-1/item.md": itemMd, "items/A-1/log.jsonl": "" }, "2026-11-18T13:00:00Z");
  origin.commit(REF, { "items/A-1/item.md": itemMd, "items/A-1/log.jsonl": log.replace("robin", "robyn") + log }, "2026-11-18T13:01:00Z");
  const before = a.clone.git(["rev-parse", TRACKING]);
  const dropped = await writer(a).share();
  assert.match(dropped.problem ?? "", /removed or changed log lines in commit/);
  assert.equal(a.clone.git(["rev-parse", TRACKING]), before);

  const other = remote();
  const b = laptop(other, "laptop-b", "B");
  await port(b).createWork({ title: "Two" });
  const tip = other.git(["rev-parse", REF]);
  const side = other.git(["commit-tree", `${tip}^{tree}`, "-p", tip], "side\n", { GIT_AUTHOR_NAME: "S", GIT_AUTHOR_EMAIL: "s@example.invalid", GIT_COMMITTER_NAME: "S", GIT_COMMITTER_EMAIL: "s@example.invalid" });
  const merge = other.git(["commit-tree", `${tip}^{tree}`, "-p", tip, "-p", side], "merge\n", { GIT_AUTHOR_NAME: "S", GIT_AUTHOR_EMAIL: "s@example.invalid", GIT_COMMITTER_NAME: "S", GIT_COMMITTER_EMAIL: "s@example.invalid" });
  other.git(["update-ref", REF, merge]);
  assert.match((await writer(b).share()).problem ?? "", /has a merge commit/);
});

test("logs over the size limit: one write cannot add past it, a merge past it never blocks sharing, the same line is not written twice", async () => {
  const origin = remote();
  const limits = { maxAppendLogBytes: 900 };
  const a = laptop(origin, "laptop-a", "A", limits);
  const b = laptop(origin, "laptop-b", "B", limits);
  await port(a).createWork({ title: "Busy" });
  await port(a).createWork({ title: "Quiet" });
  await writer(b).share();
  const line = (summary: string) => ({ kind: "session", by: { who: "implement", agent: true }, fields: { summary } });
  await port(a).appendLog(work("A-1"), line("a".repeat(500)));
  await port(b).appendLog(work("A-1"), line("b".repeat(500)));
  // Merged, the log is over 900 bytes; b's push still went, and b's later write to another item is shared.
  assert.equal(writer(b).lastSharing()?.state, "shared");
  assert.ok(Buffer.byteLength(show(origin, "items/A-1/log.jsonl")) > 900);
  assert.equal((await port(b).appendLog(work("A-2"), line("other item"))).shared, "shared");
  await assert.rejects(port(b).appendLog(work("A-1"), line("more")), /would be over 900 bytes/);

  const fixed = laptop(origin, "laptop-f", "F", { now: () => "2026-11-18T09:00:00Z" }, cloneTestRepo(origin));
  await writer(fixed).share();
  const first = await (fixed.host.writer as NonNullable<MetaBranchHost["writer"]>).appendLog("A-2", line("same"));
  const second = await (fixed.host.writer as NonNullable<MetaBranchHost["writer"]>).appendLog("A-2", line("same"));
  assert.deepEqual([first.changed, second.changed], [true, false]);
});

/** Makes the remote's meta ref a new history with the same files, except those given: every commit id changes. */
function rewrite(origin: TestRepo, change: Record<string, string | null>): void {
  const files: Record<string, string> = {};
  for (const path of origin.git(["ls-tree", "-r", "--name-only", REF]).split("\n")) files[path] = `${show(origin, path)}\n`;
  for (const [path, text] of Object.entries(change)) {
    if (text === null) delete files[path];
    else files[path] = text;
  }
  origin.git(["update-ref", "-d", REF]);
  origin.commit(REF, files, "2026-11-18T14:00:00Z");
}

test("accepting a rewritten history: only this machine's own unshared commits go on top, nothing is duplicated, removed lines stay removed", async () => {
  const origin = remote();
  const a = laptop(origin, "laptop-a", "A");
  const b = laptop(origin, "laptop-b", "B");
  await port(a).createWork({ title: "From a" });
  await port(b).createWork({ title: "From b" });
  await port(a).appendLog(work("A-1"), claim);
  await writer(b).share();
  // Someone rewrites the remote's history without a's line; meanwhile b writes a line while it cannot reach the remote.
  rewrite(origin, { "items/A-1/log.jsonl": null });
  b.offline.on = true;
  await port(b).appendLog(work("B-1"), { ...claim, by: { who: "sam", agent: false } });
  b.offline.on = false;
  assert.match((await writer(b).share()).problem ?? "", /was rewritten/);
  // Without the record of what was fetched (as after the remote setting changed), the last shared commit still catches it.
  b.clone.git(["update-ref", "-d", TRACKING]);
  assert.match((await writer(b).share()).problem ?? "", /does not contain [0-9a-f]{12}, the last commit this machine shared/);
  const before = b.clone.git(["rev-parse", REF]);

  // The person runs the command (`pnpm meta:accept --machine laptop-b`) with Scope Soup's settings; without the name it does nothing.
  const printed: string[] = [];
  const env = { SCOPESOUP_META_REPO: b.clone.dir, SCOPESOUP_META_REF: REF, SCOPESOUP_META_AUTHOR_NAME: "Person laptop-b", SCOPESOUP_META_AUTHOR_EMAIL: "laptop-b@example.invalid" };
  assert.equal(await acceptMain(env, (line) => printed.push(line), []), 2);
  assert.match(printed.pop() ?? "", /^Usage: pnpm meta:accept --machine <name>/);
  assert.equal(b.clone.git(["rev-parse", REF]), before);
  assert.equal(await acceptMain(env, (line) => printed.push(line), ["--machine", "laptop-b"]), 0);
  const backup = /as (refs\/scopesoup-backup\/\d{8}T\d+Z) /.exec(printed[0] ?? "")?.[1] ?? "";
  assert.equal(b.clone.git(["rev-parse", backup]), before);
  assert.match(printed[1] ?? "", /^Took the fetched history [0-9a-f]{12} as the remote's\.$/);
  // No item moved, nothing left out: b had one own unshared commit, and only that went on top.
  assert.deepEqual(printed.slice(2), ["Put 1 of this machine's unshared commit on top of it.", "Pushed: the remote has it all.", "Lines the accepted history removed stay removed."]);
  assert.deepEqual(origin.git(["ls-tree", "--name-only", `${REF}:items`]).split("\n"), ["A-1", "B-1"]);
  assert.deepEqual(origin.git(["ls-tree", "--name-only", `${REF}:items/A-1`]).split("\n"), ["item.md"]);
  assert.deepEqual(parseLog(show(origin, "items/B-1/log.jsonl")).entries.map((entry) => entry.by.who), ["sam"]);
  assert.equal((await writer(b).share()).state, "shared");
});

test("no record of sharing and a local history of another machine's commits: an unrelated remote is refused, not merged", async () => {
  const one = remote();
  const a = laptop(one, "laptop-a", "A");
  await port(a).createWork({ title: "On one" });
  const two = remote();
  const t = laptop(two, "laptop-t", "T");
  await port(t).createWork({ title: "On two" });
  // c's meta ref holds a's history, fetched by hand; then its remote is pointed at the other repository.
  const c = laptop(one, "laptop-c", "C");
  c.clone.git(["fetch", "--quiet", "origin", `${REF}:${REF}`]);
  c.clone.git(["remote", "set-url", "origin", two.dir]);
  const local = c.clone.git(["rev-parse", REF]);
  assert.match((await writer(c).share()).problem ?? "", /commits this machine did not make .* unrelated, and Scope Soup does not guess/);
  assert.equal(c.clone.git(["rev-parse", REF]), local);
  assert.deepEqual(two.git(["ls-tree", "--name-only", `${REF}:items`]).split("\n"), ["T-1"]);
});

test("a moved item claims this machine's references along, the move is remembered, and a write to the old id is refused naming the new one", async () => {
  const origin = remote();
  const a = laptop(origin, "laptop-a", "Q");
  const c = laptop(origin, "laptop-c", "Q");
  await writer(c).share();
  await port(a).createWork({ title: "From a" });
  c.offline.on = true;
  await port(c).createWork({ title: "Parent on c" });
  await port(c).createWork({ title: "Child on c", parent: work("Q-1"), blockedBy: [work("Q-1")] });
  c.offline.on = false;
  assert.deepEqual((await writer(c).share()).renamed, [{ from: "Q-1", to: "Q-3" }]);
  assert.match(show(origin, "items/Q-3/item.md"), /^---\nid: Q-3\ntitle: Parent on c\n/);
  assert.match(show(origin, "items/Q-2/item.md"), /\nparent: Q-3\nblockedBy: Q-3\n/);
  assert.match(show(origin, "items/Q-1/item.md"), /title: From a/);
  // a's next item collides with c's Q-2 while a shares it: the outcome says where it went.
  const moved = await port(a).createWork({ title: "Second on a" });
  assert.deepEqual([moved.work.id, moved.movedFrom], ["Q-4", "Q-2"]);
  // Remembered past this round: a new Scope Soup on c's clone refuses a write to the old id.
  const again = laptop(origin, "laptop-c", "Q", {}, c.clone);
  await assert.rejects(port(again).appendLog(work("Q-1"), claim), /Q-1 is another machine's item now: this machine's Q-1 was moved to Q-3 .* Write to Q-3\./);
});

test("stop() ends a push in flight with everything its hook started", async () => {
  const origin = remote();
  const a = laptop(origin, "laptop-a", "A", {}, cloneTestRepo(origin), false);
  await port(a).createWork({ title: "One" });
  const longSleep = nextSleep();
  writeFileSync(hangFlag(a.clone), longSleep);
  try {
    let settled: unknown;
    const writing = port(a).appendLog(work("A-1"), claim).then(
      (outcome) => (settled = { outcome }),
      (error: unknown) => (settled = { error: error instanceof Error ? error.message : String(error) }),
    );
    // Waits for the condition (the hook has written), not a fixed time; a busy machine may take a while to start it.
    // A write that ended without the hook (it never pushed, or the push failed) cannot start it any more: say how it ended.
    for (let tries = 0; tries < 300 && sizeOf(loopFile(a.clone)) === 0 && settled === undefined; tries++) await pause(100);
    assert.ok(sizeOf(loopFile(a.clone)) > 0, `the hook runs (the write ${settled === undefined ? "is still going" : `ended first: ${JSON.stringify(settled)}`})`);
    const started = Date.now();
    await a.host.stop();
    await writing;
    assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
    const size = sizeOf(loopFile(a.clone));
    await pause(700);
    assert.equal(sizeOf(loopFile(a.clone)), size, "the hook was ended");
    assert.deepEqual(await sleepers(longSleep), []);
  } finally {
    rmSync(hangFlag(a.clone), { force: true });
  }
});
});
