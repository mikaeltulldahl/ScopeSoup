// How many git processes each meta-branch operation starts, and a budget for each. The counts are
// taken at the one place every git process is started (the RunGit the host is given, for local
// plumbing and for the network), so a new git call in the writer or the adapter shows here. The
// budgets are today's counts; a later change that lowers a count lowers its budget in the same
// commit, and a change that raises one fails this test. All data is synthetic.
//
// Steady state: a first write has run before the measuring starts, so the one-time checks (the git
// version, the ssh environment) are not counted. The clock is held still while measuring, because
// the writer asks again which branches are checked out (and whether the remote exists) after ten
// seconds, and a slow machine would count more.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { MetaBranchHost } from "./adapter.ts";
import { createMetaBranchHost } from "./adapter.ts";
import type { RunGit } from "./git.ts";
import { gitIn } from "./git.ts";
import type { TestClone, TestRepo } from "./testRepo.ts";
import { cloneTestRepo, createTestRepo } from "./testRepo.ts";

/** The most git processes each operation may start. */
export const BUDGET = {
  "create an item (and share it)": 10,
  "edit an item (and share it)": 9,
  "append a log line (and share it)": 9,
  "claim an item (and share it)": 9,
  "share with nothing to do": 3,
  "create an item while the remote is unreachable": 9,
  "share: push one waiting commit": 3,
  "share: fetch and fast-forward": 12,
  "share: fetch, put own commit on top, push": 12,
} as const;

type Operation = keyof typeof BUDGET;

const REF = "refs/scopesoup/meta";

const home = mkdtempSync(join(tmpdir(), "scopesoup-budget-home-"));
writeFileSync(join(home, "gitconfig"), "");
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

/** Counts the git processes started through it, by the command (`rev-parse`, `push`, ...). */
function counting(inner: RunGit, offline: { on: boolean }, commands: string[]): RunGit {
  return async (args, input, env) => {
    // A call refused as if the network were down starts no process.
    if (offline.on && ["fetch", "push", "ls-remote"].includes(args.find((arg) => !arg.startsWith("-")) ?? "")) {
      return { code: 128, stdout: Buffer.alloc(0), stderr: "fatal: the network is down (test)" };
    }
    commands.push(args.filter((arg) => !arg.startsWith("-") || arg === "--batch").slice(0, 2).join(" "));
    return inner(args, input, env);
  };
}

interface Machine {
  clone: TestClone;
  host: MetaBranchHost;
  commands: string[];
  offline: { on: boolean };
}

function machine(origin: TestRepo, name: string, prefix: string): Machine {
  const clone = cloneTestRepo(origin);
  cleanups.push(() => clone.cleanup());
  const commands: string[] = [];
  const offline = { on: false };
  const run = gitIn(clone.dir);
  const git = counting(run, { on: false }, commands);
  const network = counting(run, offline, commands);
  const host = createMetaBranchHost({
    repoDir: clone.dir,
    ref: REF,
    allowWrites: true,
    person: { name: `Person ${name}`, email: `${name}@example.invalid` },
    machine: name,
    idPrefix: prefix,
    now: clock(),
    git,
    network,
    fetchIntervalMs: Number.POSITIVE_INFINITY,
  });
  return { clone, host, commands, offline };
}

const port = (m: Machine) => m.host.write as Required<NonNullable<MetaBranchHost["write"]>>;
const writer = (m: Machine) => m.host.writer as NonNullable<MetaBranchHost["writer"]>;
const by = { who: "robin", agent: false };

describe("git processes per meta-branch operation", () => {
  test("each operation stays within its budget", async () => {
    const origin = createTestRepo();
    cleanups.push(() => origin.cleanup());
    origin.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
    origin.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    const a = machine(origin, "alpha", "A");
    const b = machine(origin, "beta", "B");

    // The writer asks again which branches are checked out and whether the remote exists once ten
    // seconds have passed. A slow machine would then count more than a fast one, so time stands
    // still here: every operation is measured with those answers remembered.
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    cleanups.push(() => {
      Date.now = realNow;
    });

    const counts = new Map<Operation, number>();
    const measure = async (operation: Operation, machineOf: Machine, work: () => Promise<unknown>): Promise<void> => {
      machineOf.commands.length = 0;
      await work();
      counts.set(operation, machineOf.commands.length);
      console.log(`git processes: ${operation}: ${machineOf.commands.length} (budget ${BUDGET[operation]}): ${machineOf.commands.join(", ")}`);
    };

    // Warm-up: the first write checks the git version and the ssh environment once.
    await port(a).createWork({ title: "Warm up" });

    let id = "";
    await measure("create an item (and share it)", a, async () => {
      id = (await port(a).createWork({ title: "First item", body: "What the first item means.", log: [{ kind: "created", by }] })).work.id;
    });
    const item = { host: "metaBranch", kind: "work" as const, id: "" };
    item.id = id;
    await measure("edit an item (and share it)", a, () => port(a).editWork(item, { title: "First item, edited" }));
    await measure("append a log line (and share it)", a, () => port(a).appendLog(item, { kind: "comment", by, fields: { text: "A note." } }));
    await measure("claim an item (and share it)", a, () => port(a).appendLog(item, { kind: "claimed", by, fields: { until: "2026-11-18T18:00:00Z" } }));
    await measure("share with nothing to do", a, () => writer(a).share());

    a.offline.on = true;
    await measure("create an item while the remote is unreachable", a, () => port(a).createWork({ title: "Made offline" }));
    a.offline.on = false;
    await measure("share: push one waiting commit", a, () => writer(a).share());

    // Another machine's item arrives: the local ref is behind, so fetching fast-forwards it.
    await port(b).createWork({ title: "From beta" });
    await measure("share: fetch and fast-forward", a, () => writer(a).share());

    // Both machines have a commit the other lacks: this machine's is put on top of the fetched one.
    a.offline.on = true;
    await port(a).createWork({ title: "Made offline again" });
    a.offline.on = false;
    await port(b).createWork({ title: "From beta, again" });
    await measure("share: fetch, put own commit on top, push", a, () => writer(a).share());

    Date.now = realNow;
    const over = [...counts].filter(([operation, count]) => count > BUDGET[operation]).map(([operation, count]) => `${operation}: ${count} git processes, budget ${BUDGET[operation]}`);
    assert.deepEqual(over, [], `Operations over their git process budget. If one was lowered on purpose, lower its budget in budget.slow.test.ts; if it grew, find the new git call.`);
    assert.equal(counts.size, Object.keys(BUDGET).length);
  });
});
