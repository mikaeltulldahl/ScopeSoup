// Writing the meta ref, against two clones of one temporary bare repository: each clone is a
// laptop with its own writer. The ref is a hidden one (`refs/scopesoup/meta`), not a branch. The
// machine's own git configuration is replaced by a hostile one (signing on with no signer, no
// identity, CRLF conversion, hooks everywhere), so nothing here leans on it. All data is synthetic.
// This is a separate file from writer.test.ts because it needs real clones and the hostile git
// configuration, which the unit tests there do not.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { WorkItem } from "../../model/types.ts";
import type { Ref } from "../../model/types.ts";
import type { MetaBranchConfig, MetaBranchHost } from "./adapter.ts";
import { createMetaBranchHost } from "./adapter.ts";
import type { RunGit } from "./git.ts";
import { gitIn } from "./git.ts";
import { parseLog } from "./log.ts";
import type { TestClone, TestRepo } from "./testRepo.ts";
import { cloneTestRepo, createTestRepo, itemMd } from "./testRepo.ts";

const REF = "refs/scopesoup/meta";

// --- a hostile machine configuration, for every git this process starts ---
const home = mkdtempSync(join(tmpdir(), "scopesoup-home-"));
const hooks = join(home, "hooks");
const marks = join(home, "marks");
mkdirSync(hooks);
mkdirSync(marks);
const slash = (path: string): string => path.replaceAll("\\", "/");
for (const hook of ["pre-push", "reference-transaction"]) {
  const file = join(hooks, hook);
  // With a `hang` file in marks, the pre-push hook never ends (and keeps writing, so a survivor shows).
  const hang = hook === "pre-push" ? `if [ -f "${slash(join(marks, "hang"))}" ]; then while :; do echo x >> "${slash(join(marks, "loop"))}"; sleep 0.2; done; fi\n` : "";
  // The marks are kept in the repository that ran the hook (the working tree's `.git`, or a bare repository itself), so tests side by side do not count each other's.
  writeFileSync(file, `#!/bin/sh\ncat > /dev/null\n${hang}d=.git\n[ -d "$d" ] || d=.\necho "$1" >> "$d/scopesoup-mark-${hook}"\nexit 0\n`);
  chmodSync(file, 0o755);
}
const globalConfig = join(home, "gitconfig");
writeFileSync(
  globalConfig,
  [
    "[user]\n\tuseConfigOnly = true",
    "[commit]\n\tgpgSign = true",
    "[gpg]\n\tprogram = scopesoup-no-such-signer",
    `[core]\n\tautocrlf = true\n\thooksPath = ${slash(hooks)}`,
    "[fetch]\n\tprune = true\n\trecurseSubmodules = yes",
    "[push]\n\tfollowTags = true\n\tgpgSign = true",
    "[init]\n\tdefaultBranch = main",
    "",
  ].join("\n"),
);
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
/** The times a hook ran in this clone, one entry each. */
const marked = (clone: TestClone, hook: string): string[] => {
  const file = join(clone.dir, ".git", `scopesoup-mark-${hook}`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  rmSync(home, { recursive: true, force: true });
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.global;
  if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
});

/** A clock that moves one second per reading, from a fixed start. */
function clock(start = "2026-11-18T09:00:00Z"): () => string {
  let at = Date.parse(start);
  return () => new Date((at += 1000)).toISOString();
}

interface Laptop {
  clone: TestClone;
  host: MetaBranchHost;
}

function remote(): TestRepo {
  const origin = createTestRepo();
  cleanups.push(() => origin.cleanup());
  origin.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  origin.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  return origin;
}

function laptop(origin: TestRepo, machine: string, prefix: string, more: Partial<MetaBranchConfig> = {}): Laptop {
  const clone = cloneTestRepo(origin);
  cleanups.push(() => clone.cleanup());
  const host = createMetaBranchHost({
    repoDir: clone.dir,
    ref: REF,
    allowWrites: true,
    person: { name: `Person ${machine}`, email: `${machine}@example.invalid` },
    machine,
    idPrefix: prefix,
    now: clock(),
    ...more,
  });
  return { clone, host };
}

const work = (id: string): Ref => ({ host: "metaBranch", kind: "work", id });
const write = (laptop: Laptop) => {
  assert.ok(laptop.host.write?.createWork && laptop.host.write.editWork && laptop.host.write.appendLog);
  return laptop.host.write as Required<NonNullable<MetaBranchHost["write"]>>;
};
const writer = (laptop: Laptop) => {
  assert.ok(laptop.host.writer);
  return laptop.host.writer;
};
const items = async (laptop: Laptop): Promise<Map<string, WorkItem>> => new Map((await laptop.host.work.listWork()).items.map((item) => [item.ref.id, item]));
const logOf = (repo: { git(args: string[]): string }, id: string, ref = REF): string => repo.git(["cat-file", "-p", `${ref}:items/${id}/log.jsonl`]);
const tryGit = (repo: { git(args: string[]): string }, args: string[]): string | null => {
  try {
    return repo.git(args);
  } catch {
    return null;
  }
};

/** What a working copy looks like: HEAD, the index's bytes, and git status. A write must change none of it. */
const workingCopy = (clone: TestClone): string[] => [
  clone.git(["rev-parse", "HEAD"]),
  createHash("sha256").update(readFileSync(join(clone.dir, ".git", "index"))).digest("hex"),
  clone.git(["-c", "core.hooksPath=", "status", "--porcelain", "--untracked-files=all"]),
];

const claimed = { kind: "claimed", by: { who: "robin", agent: false }, fields: { until: "2026-11-18T17:00:00+01:00" } };

/** A remote and two laptops on it, each test with its own, so the tests can run side by side. `items`: what the story so far has made. */
async function pair(items: "none" | "parser" | "three" = "none"): Promise<{ origin: TestRepo; a: Laptop; b: Laptop }> {
  const origin = remote();
  const a = laptop(origin, "laptop-a", "A");
  const b = laptop(origin, "laptop-b", "B");
  // The clones' own set-up ran the hooks: start counting from here.
  for (const hook of ["pre-push", "reference-transaction"]) for (const laptop of [a, b]) rmSync(join(laptop.clone.dir, ".git", `scopesoup-mark-${hook}`), { force: true });
  if (items !== "none") {
    // A-1, claimed by a's person.
    await write(a).createWork({ title: "Write the parser" });
    await write(a).appendLog(work("A-1"), claimed);
  }
  if (items === "three") {
    // Also A-2 from a and B-1 from b, all shared.
    await write(a).createWork({ title: "From a" });
    await write(b).createWork({ title: "From b" });
    await writer(a).share();
  }
  return { origin, a, b };
}

describe("writer", { concurrency: 6 }, () => {
test("create, edit and append: one commit each on the hidden ref, as the configured person, with no checkout and only the pre-push hook run", async () => {
  const { origin, a } = await pair();
  const copy = workingCopy(a.clone);
  const { work: first, shared } = await write(a).createWork({ title: "Write the parser", body: "It reads `item.md`.", labels: ["parser"] });
  assert.deepEqual([first, shared], [work("A-1"), "shared"]);
  assert.equal(writer(a).lastSharing()?.state, "shared");
  await write(a).editWork(first, { state: "doing", verification: "the parser test passes" });
  await write(a).appendLog(first, { kind: "claimed", by: { who: "robin", agent: false }, fields: { until: "2026-11-18T17:00:00+01:00" } });

  // Three commits, each with the configured author and committer, and nothing else in their trees but the format entry of a new meta branch.
  assert.deepEqual(a.clone.git(["log", "--format=%an <%ae>|%cn|%s", REF]).split("\n"), [
    "Person laptop-a <laptop-a@example.invalid>|Person laptop-a|A-1: append claimed",
    "Person laptop-a <laptop-a@example.invalid>|Person laptop-a|A-1: edit item.md",
    "Person laptop-a <laptop-a@example.invalid>|Person laptop-a|A-1: create",
  ]);
  assert.deepEqual(a.clone.git(["ls-tree", "-r", "--name-only", REF]).split("\n"), ["format", "items/A-1/item.md", "items/A-1/log.jsonl"]);
  // Pushed: the remote's ref is the clone's, and it is not a branch.
  assert.equal(origin.git(["rev-parse", REF]), a.clone.git(["rev-parse", REF]));
  assert.equal(tryGit(origin, ["rev-parse", "--verify", "--quiet", "refs/heads/scopesoup/meta"]), null);
  // The files are as the reader wants them: LF line ends (core.autocrlf is on), times in UTC.
  assert.equal(a.clone.git(["cat-file", "-p", `${REF}:items/A-1/item.md`]), "---\nid: A-1\ntitle: Write the parser\nstate: doing\nlabels: parser\nverification: the parser test passes\n---\n\nIt reads `item.md`.");
  const line = JSON.parse(logOf(a.clone, "A-1")) as Record<string, unknown>;
  assert.match(String(line.at), /^2026-11-18T09:00:\d\dZ$/);
  assert.deepEqual({ ...line, at: "" }, { at: "", by: { who: "robin", machine: "laptop-a", agent: false }, kind: "claimed", until: "2026-11-18T16:00:00Z" });
  // The read sees it.
  const read = (await items(a)).get("A-1");
  assert.equal(read?.state, "doing");
  assert.equal(read?.holder?.actor.id, "robin@laptop-a");

  // The working copy was not touched; the hooks that plumbing could fire did not run; the pre-push hook did, once per push.
  assert.deepEqual(workingCopy(a.clone), copy);
  assert.deepEqual(marked(a.clone, "reference-transaction"), []);
  assert.equal(marked(a.clone, "pre-push").length, 3);
});

test("an item created with a parent is its child, and the parent counts it among its open children", async () => {
  const { a } = await pair();
  await write(a).createWork({ title: "Umbrella" });
  const child = await write(a).createWork({ title: "Part one", parent: work("A-1") });
  await write(a).createWork({ title: "Part two", parent: work("A-1") });
  assert.deepEqual(child.work, work("A-2"));
  assert.match(a.clone.git(["cat-file", "-p", `${REF}:items/A-2/item.md`]), /\nparent: A-1\n/);
  let read = await items(a);
  assert.deepEqual(read.get("A-2")?.parent, work("A-1"));
  assert.deepEqual([read.get("A-1")?.openChildren, read.get("A-1")?.children], [2, 2]);
  // A finished child no longer counts as open.
  await write(a).editWork(child.work, { state: "done" });
  read = await items(a);
  assert.deepEqual([read.get("A-1")?.openChildren, read.get("A-1")?.children], [1, 2]);
});

test("two laptops append to the same log: the second push is refused, retried, and both lines survive", async () => {
  const { origin, a, b } = await pair("parser");
  await writer(b).share();
  assert.ok((await items(b)).has("A-1"));
  await write(a).appendLog(work("A-1"), { kind: "session", by: { who: "implement", agent: true }, fields: { role: "implement", outcome: "succeeded", summary: "from a" } });
  // b has not fetched: its push is refused, and it fetches, puts its line on top and pushes again.
  await write(b).appendLog(work("A-1"), { kind: "question", by: { who: "triage", agent: true }, fields: { question: "Which syntax?", options: ["a", "b"] } });
  const sharing = writer(b).lastSharing();
  assert.deepEqual([sharing?.state, sharing?.pushes, sharing?.refusedPushes, sharing?.replayed], ["shared", 2, 1, 1]);
  await writer(a).share();
  for (const side of [a.clone, b.clone, origin]) {
    const kinds = parseLog(logOf(side, "A-1")).entries.map((entry) => `${entry.kind}@${entry.by.machine}`);
    assert.deepEqual(kinds, ["claimed@laptop-a", "session@laptop-a", "question@laptop-b"]);
  }
  // The history is a line, not a merge: the pushed commits were never rewritten.
  assert.equal(origin.git(["rev-list", "--merges", REF]), "");
  assert.equal((await items(a)).get("A-1")?.needsDecision, true);
  // Ids from different prefixes never collide.
  await write(a).createWork({ title: "From a" });
  await write(b).createWork({ title: "From b" });
  await writer(a).share();
  assert.deepEqual([...(await items(a)).keys()], ["A-1", "A-2", "B-1"]);
});

test("two laptops edit the same item.md: a conflict on that item, both versions kept, other items unaffected, and an edit resolves it", async () => {
  const { a, b } = await pair("three");
  await writer(b).share();
  await write(a).editWork(work("A-2"), { title: "From a, edited on a" });
  await write(b).editWork(work("A-2"), { title: "From a, edited on b" });
  assert.deepEqual(writer(b).lastSharing()?.conflicts, ["A-2"]);
  await writer(a).share();

  for (const side of [a, b]) {
    const versions = await writer(side).versions("A-2");
    assert.match(versions.itemMd ?? "", /title: From a, edited on a/);
    assert.equal(versions.aside.length, 1);
    assert.match(versions.aside[0]?.file ?? "", /^item\.conflict-[0-9a-f]{12}\.md$/);
    assert.match(versions.aside[0]?.text ?? "", /title: From a, edited on b/);
    const read = (await items(side)).get("A-2");
    assert.equal(read?.needsDecision, true);
    assert.equal(read?.title, "From a, edited on a");
    assert.match(read?.hostState ?? "", /^todo; conflict: item\.md was changed on two machines/);
    assert.deepEqual(side.host.lastReport()?.conflicts, ["A-2"]);
  }

  // The item in conflict refuses a plain edit, but takes log lines; other items read and write as before.
  await assert.rejects(write(a).editWork(work("A-2"), { state: "doing" }), /A-2 is in conflict/);
  await write(a).appendLog(work("A-2"), { kind: "assumption", by: { who: "robin", agent: false }, fields: { assumption: "a's title is right" } });
  await write(b).editWork(work("B-1"), { state: "doing" });
  await writer(a).share();
  assert.equal((await items(a)).get("B-1")?.state, "doing");

  // A person picks: the edit that resolves removes the version put aside.
  const seenAside = (await writer(a).versions("A-2")).aside.map((version) => version.blob);
  const resolved = await write(a).editWork(work("A-2"), { title: "From a, merged" }, { resolveConflict: { supersedes: seenAside } });
  assert.deepEqual([resolved.conflict, resolved.shared], [false, "shared"]);
  await writer(b).share();
  const read = (await items(b)).get("A-2");
  assert.deepEqual([read?.title, read?.needsDecision, read?.hostState], ["From a, merged", undefined, "todo"]);
  assert.equal((await writer(b).versions("A-2")).aside.length, 0);
  assert.equal(b.host.lastReport()?.conflicts, undefined);
});

test("a remote that keeps moving: pushes are bounded, the commit stays local, and the next round pushes it", async () => {
  const { origin, a, b } = await pair("three");
  await writer(b).share();
  const network = gitIn(b.clone.dir);
  let sabotage = true;
  // Before each of b's pushes, a pushes something first.
  const racing: RunGit = async (args, input, env) => {
    if (sabotage && args.includes("push")) await write(a).appendLog(work("A-1"), { kind: "session", by: { who: "implement", agent: true }, fields: { summary: "racing" } });
    return network(args, input, env);
  };
  const c: Laptop = { clone: b.clone, host: createMetaBranchHost({ repoDir: b.clone.dir, ref: REF, allowWrites: true, person: { name: "Person laptop-b", email: "laptop-b@example.invalid" }, machine: "laptop-b", now: clock("2026-11-18T12:00:00Z"), network: racing, pushAttempts: 3 }) };
  await write(c).appendLog(work("B-1"), { kind: "released", by: { who: "sam", agent: false } });
  const sharing = writer(c).lastSharing();
  assert.deepEqual([sharing?.state, sharing?.pushes, sharing?.refusedPushes], ["pending", 3, 3]);
  assert.match(sharing?.problem ?? "", /gave up after 3/);
  assert.match(logOf(b.clone, "B-1"), /"kind":"released"/);
  assert.equal(tryGit(origin, ["cat-file", "-p", `${REF}:items/B-1/log.jsonl`]), null);
  sabotage = false;
  assert.equal((await writer(c).share()).state, "shared");
  assert.match(logOf(origin, "B-1"), /"kind":"released"/);
  assert.equal(parseLog(logOf(origin, "A-1")).entries.filter((entry) => entry.data.summary === "racing").length, 3);
});

test("two writers with the same prefix on one laptop: the one that lost the race takes the next number", async () => {
  const solo = remote();
  const plain = (git: RunGit | undefined): MetaBranchHost =>
    createMetaBranchHost({ repoDir: solo.dir, ref: REF, allowWrites: true, remote: null, person: { name: "Person", email: "p@example.invalid" }, machine: "laptop-a", idPrefix: "A", now: clock(), ...(git ? { git } : {}) });
  const second = plain(undefined);
  const real = gitIn(solo.dir);
  let raced = false;
  // The first writer reads, then the second writes a whole item before the first moves the ref.
  const first = plain(async (args, input, env) => {
    if (!raced && args.includes("update-ref")) {
      raced = true;
      await second.write?.createWork?.({ title: "Second" });
    }
    return real(args, input, env);
  });
  const id = await first.write?.createWork?.({ title: "First" });
  assert.deepEqual(id?.work, { host: "metaBranch", kind: "work", id: "A-2" });
  assert.deepEqual(solo.git(["ls-tree", "--name-only", `${REF}:items`]).split("\n"), ["A-1", "A-2"]);
  assert.match(solo.git(["cat-file", "-p", `${REF}:items/A-1/item.md`]), /title: Second/);
  assert.match(solo.git(["cat-file", "-p", `${REF}:items/A-2/item.md`]), /title: First/);
  // No remote: nothing is shared, and that is not a problem.
  assert.deepEqual([first.writer?.lastSharing()?.state, first.writer?.lastSharing()?.problem], ["local", undefined]);
});

test("an id with .. or a slash, or a ref of another host, is refused before anything is written", async () => {
  const { a } = await pair("parser");
  const before = a.clone.git(["rev-parse", REF]);
  for (const id of ["..", "../A-1", "A-1/../B-1", "A/1", "A\\1", "-A-1", "A-1/"]) {
    await assert.rejects(write(a).appendLog(work(id), { kind: "session", by: { who: "robin", agent: false } }), /is not an item id/, id);
    await assert.rejects(write(a).editWork(work(id), { title: "x" }), /is not an item id/, id);
  }
  await assert.rejects(write(a).createWork({ title: "Child", parent: work("../A-1") }), /is not an item id/);
  await assert.rejects(write(a).createWork({ title: "Blocked", blockedBy: [work("A/1")] }), /is not an item id/);
  await assert.rejects(write(a).appendLog({ host: "github", kind: "work", id: "A-1" }, { kind: "session", by: { who: "robin", agent: false } }), /is not an item of metaBranch/);
  // Untrusted text goes into files, never into paths or the header's structure.
  await assert.rejects(write(a).createWork({ title: "Two\nlines" }), /line break/);
  await assert.rejects(write(a).appendLog(work("A-1"), { kind: "Not a kind", by: { who: "robin", agent: false } }), /not a short lower-case word/);
  await assert.rejects(write(a).appendLog(work("A-9"), { kind: "session", by: { who: "robin", agent: false } }), /There is no item A-9/);
  assert.equal(a.clone.git(["rev-parse", REF]), before);
  const odd = await write(a).createWork({ title: "../../outside: --- and \"quotes\"" });
  assert.match(a.clone.git(["ls-tree", "--name-only", `${REF}:items/${odd.work.id}`]), /^item\.md$/);
  assert.equal((await items(a)).get(odd.work.id)?.title, "../../outside: --- and \"quotes\"");
});

test("a fetched history that dropped log lines or was rewritten is refused, and nothing here changes", async () => {
  const { origin, b } = await pair("parser");
  await writer(b).share();
  const seen = b.clone.git(["rev-parse", REF]);
  const tracking = b.clone.git(["rev-parse", "refs/scopesoup-remote/origin/scopesoup/meta"]);
  assert.equal(tracking, seen);
  // Someone pushes a commit on top that empties A-1's log.
  const files: Record<string, string> = {};
  for (const path of origin.git(["ls-tree", "-r", "--name-only", REF]).split("\n")) files[path] = path === "items/A-1/log.jsonl" ? "" : origin.git(["cat-file", "-p", `${REF}:${path}`]) + "\n";
  origin.commit(REF, files, "2026-11-18T13:00:00Z");
  const dropped = await writer(b).share();
  assert.match(dropped.problem ?? "", /removed or changed log lines/);
  assert.deepEqual([b.clone.git(["rev-parse", REF]), b.clone.git(["rev-parse", "refs/scopesoup-remote/origin/scopesoup/meta"])], [seen, tracking]);
  // Someone force-pushes an unrelated history.
  origin.git(["update-ref", REF, origin.git(["rev-parse", "refs/heads/main"])]);
  const rewritten = await writer(b).share();
  assert.match(rewritten.problem ?? "", /was rewritten/);
  assert.equal(b.clone.git(["rev-parse", REF]), seen);
  // Writing still works here; the commit waits.
  await write(b).appendLog(work("A-1"), { kind: "session", by: { who: "sam", agent: false } });
  assert.equal(writer(b).lastSharing()?.state, "pending");
  assert.notEqual(b.clone.git(["rev-parse", REF]), seen);
});

test("without allowWrites there is no write port, and a read neither fetches nor changes anything", async () => {
  const repo = createTestRepo();
  cleanups.push(() => repo.cleanup());
  repo.commit(REF, { "items/R-1/item.md": itemMd("R-1", "Read only", "todo") }, "2026-11-18T10:00:00Z");
  const reader = laptop(repo, "laptop-r", "R", { allowWrites: false });
  assert.equal(reader.host.write, undefined);
  assert.equal(reader.host.writer, null);
  assert.equal(reader.host.info.capabilities.has("write"), false);
  assert.deepEqual((await reader.host.work.listWork()).items, []);
  assert.equal(tryGit(reader.clone, ["rev-parse", "--verify", "--quiet", REF]), null);
  // With writes, the first read fetches the ref.
  const writing = createMetaBranchHost({ repoDir: reader.clone.dir, ref: REF, allowWrites: true, person: { name: "Person", email: "p@example.invalid" }, machine: "laptop-r", now: clock() });
  assert.deepEqual((await writing.work.listWork()).items.map((item) => item.ref.id), ["R-1"]);
  // No id prefix: nothing can be created.
  await assert.rejects(writing.write?.createWork?.({ title: "New" }) ?? Promise.resolve(), /No id prefix/);
});
});
