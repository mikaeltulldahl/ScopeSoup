// The tree kill that ends only processes Scope Soup started. Windows cannot be made to reuse
// a chosen pid, so the reuse cases run on an injected process table; one real Windows test ends a
// real tree and leaves an unrelated process running.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { msysAdditions } from "./metaBranch/git.ts";
import { endWindowsTree, parseListing, trackSpawn, trackedWindow, treeToEnd, windowAround } from "./processTree.ts";
import type { ProcessEntry, ProcessTableSession } from "./processTree.ts";

const T = 1_800_000_000_000;
const p = (pid: number, parent: number, createdMs: number): ProcessEntry => ({ pid, parent, createdMs });
const started = { notBeforeMs: T - 100, notAfterMs: T + 100 };
const pids = (entries: readonly ProcessEntry[]): number[] => entries.map((entry) => entry.pid);

/** A listing per round, from `tables` in turn (the last one again after that), recording what each round chose; each round's kills are done at `endedByMs`. */
function tablesInTurn(tables: ProcessEntry[][], listed = true, endedByMs = T + 1000): ProcessTableSession & { rounds: number[][] } {
  const rounds: number[][] = [];
  const session: ProcessTableSession = async (choose) => {
    if (!listed) return { listed: false, ended: [] };
    for (let again = true; again; ) {
      const answer = await choose(tables[Math.min(rounds.length, tables.length - 1)] as ProcessEntry[], rounds.length === 0 ? undefined : endedByMs);
      rounds.push(pids(answer.end));
      again = answer.again;
    }
    return { listed: true, ended: rounds.flat() };
  };
  return Object.assign(session, { rounds });
}

/** A fake listing that is the same in every round. */
const fakeTable = (table: ProcessEntry[], listed = true) => tablesInTurn([table], listed);

test("the tree is the root and what it started, parents before children", () => {
  const table = [p(4, 0, T - 9_000_000), p(10, 4, T - 5000), p(100, 10, T), p(101, 100, T + 50), p(102, 100, T + 60), p(103, 101, T + 70), p(200, 10, T + 10)];
  assert.deepEqual(pids(treeToEnd(table, 100, started)), [100, 101, 102, 103]);
});

test("a process whose parent pid was reused by the tree is not in it, nor is anything below it", () => {
  // 300 and its child 301 were started by an older process with pid 101, which exited; then the
  // root started a child that got pid 101 again. 300 was created before the new 101: not ours.
  const table = [p(100, 10, T), p(101, 100, T + 5000), p(300, 101, T + 1000), p(301, 300, T + 9000), p(102, 101, T + 6000)];
  assert.deepEqual(pids(treeToEnd(table, 100, started)), [100, 101, 102]);
});

test("a reused pid deeper in the ancestry: a grandchild's exited parent pid now names an unrelated, later process", () => {
  // The root started 101, which started 102 and exited; pid 101 now belongs to an unrelated process
  // created later, whose parent pid is something else. 102 hangs off no living parent and is not
  // reached (as with taskkill /T); the unrelated 101 is not reached either, and neither is its child.
  const table = [p(100, 10, T), p(102, 101, T + 2000), p(101, 55, T + 8000), p(400, 101, T + 9000)];
  assert.deepEqual(pids(treeToEnd(table, 100, started)), [100]);
});

test("a root that has exited ends nothing: its pid is gone, or belongs to a process created before or after it was started", () => {
  const children = [p(101, 100, T + 9000), p(102, 101, T + 9500)];
  assert.deepEqual(treeToEnd(children, 100, started), []);
  assert.deepEqual(treeToEnd([p(100, 10, T + 60_000), ...children], 100, started), []);
  assert.deepEqual(treeToEnd([p(100, 10, T - 60_000), ...children], 100, started), []);
  // A creation time read earlier (the startup sweep) must still match to the millisecond.
  assert.deepEqual(pids(treeToEnd([p(100, 10, T), ...children], 100, windowAround(T))), [100, 101, 102]);
  assert.deepEqual(treeToEnd([p(100, 10, T + 2), ...children], 100, windowAround(T)), []);
});

test("a cycle in the parent pids (reuse can make one) does not loop and does not take older processes", () => {
  const table = [p(100, 102, T), p(101, 100, T + 10), p(102, 101, T - 50)];
  assert.deepEqual(pids(treeToEnd(table, 100, started)), [100, 101]);
});

test("endWindowsTree ends the tree by its own pids, and nothing when the root has exited or there is no listing", async () => {
  const table = [p(100, 10, T), p(101, 100, T + 5000), p(300, 101, T + 1000), p(55, 1, T - 100_000)];
  const live = fakeTable(table);
  assert.deepEqual(await endWindowsTree(100, started, { table: live }), { listed: true, ended: [100, 101], tree: [100, 101] });
  assert.deepEqual(live.rounds, [[100, 101], []]);

  const exited = fakeTable(table.filter((entry) => entry.pid !== 100));
  assert.deepEqual((await endWindowsTree(100, started, { table: exited })).ended, []);
  const reused = fakeTable([p(100, 7, T + 30_000), ...table.slice(1)]);
  assert.deepEqual((await endWindowsTree(100, started, { table: reused })).ended, []);

  const none = fakeTable(table, false);
  assert.deepEqual(await endWindowsTree(100, started, { table: none }), { listed: false, ended: [], tree: [] });
});

test("endWindowsTree adds what `extend` finds, and asks nothing of it when the root has exited", async () => {
  const table = [p(100, 10, T), p(500, 999, T + 3000)];
  let asked = 0;
  const extend = async () => {
    asked++;
    return [p(500, 999, T + 3000)];
  };
  assert.deepEqual((await endWindowsTree(100, started, { table: fakeTable(table), extend })).ended, [100, 500]);
  // Asked again in the second round, which finds nothing new and is the last.
  assert.equal(asked, 2);
  assert.deepEqual((await endWindowsTree(100, started, { table: fakeTable(table.slice(1)), extend })).ended, []);
  assert.equal(asked, 2);
});

test("what the tree started between the listing and the kills is ended by the next listing, until one finds nothing new", async () => {
  // Round 1 sees git 100 and its hook 101. Before the kills, 101 started 102 (and 102 started 103): in no
  // listing of round 1. Round 2 sees them; 104 claims 101 as parent but was created after 101 was ended
  // (another process had pid 101 by then), and 105 belongs to someone else.
  const first = [p(100, 10, T), p(101, 100, T + 100)];
  const second = [p(102, 101, T + 200), p(103, 102, T + 300), p(104, 101, T + 60_000), p(105, 7, T + 250)];
  const table = tablesInTurn([first, second, second]);
  const result = await endWindowsTree(100, started, { table });
  assert.deepEqual(table.rounds, [[100, 101], [102, 103], []]);
  assert.deepEqual(result, { listed: true, tree: [100, 101, 102, 103], ended: [100, 101, 102, 103] });
});

test("a later round takes nothing by a pid of the tree that a living process outside it holds now", async () => {
  // 101 was ended in round 1; by round 2 an unrelated process 101 runs, and 102 is its child.
  const table = tablesInTurn([[p(100, 10, T), p(101, 100, T + 100)], [p(101, 3, T + 150), p(102, 101, T + 200)]]);
  assert.deepEqual((await endWindowsTree(100, started, { table })).ended, [100, 101]);
});

test("MSYS: a child of a process ended in an earlier round is taken when it was created before that round ended", () => {
  // Round 2: sh (MSYS 1) was ended; its fork 2 exec'd into Windows 202 after round 1's listing, through a fork
  // stub that exited, so only the MSYS parent links it. 3 is a child of 1 created after round 1 ended: not ours.
  const table = [p(202, 77, T + 400), p(203, 78, T + 5000)];
  const msys = [
    { pid: 2, parent: 1, winpid: 202 },
    { pid: 3, parent: 1, winpid: 203 },
  ];
  const tree = [p(100, 10, T), p(101, 100, T + 100)];
  assert.deepEqual(pids(msysAdditions(tree, table, msys, new Set([1]), T + 1000)), [202]);
  assert.deepEqual(pids(msysAdditions(tree, table, msys)), []);
});

test("MSYS children of the tree are added only when created after the root and their MSYS parent", () => {
  // Windows: root 100 (git) started sh 101 (MSYS 1), whose child went through an exited process,
  // so 102 (MSYS 2, parent MSYS 1) hangs off a dead Windows parent. 103 (MSYS 3) reuses a Windows pid
  // of an older, unrelated process; 104 is MSYS but not in the tree at all.
  const table = [p(100, 10, T), p(101, 100, T + 100), p(102, 77, T + 400), p(103, 78, T - 5000), p(104, 79, T + 500)];
  const msys = [
    { pid: 1, parent: 0, winpid: 101 },
    { pid: 2, parent: 1, winpid: 102 },
    { pid: 3, parent: 1, winpid: 103 },
    { pid: 4, parent: 9, winpid: 104 },
  ];
  const tree = treeToEnd(table, 100, started);
  assert.deepEqual(pids(tree), [100, 101]);
  assert.deepEqual(pids(msysAdditions(tree, table, msys)), [102]);
  assert.deepEqual(msysAdditions([], table, msys), []);
});

test("parseListing reads '<pid> <parent> <createdMs>' lines and skips anything else", () => {
  assert.deepEqual(parseListing(["4 0 1700000000000", "", "  12 4 1700000000500 ", "x y z", "5 4", "6 4 -1", "7 4 1.5"]), [p(4, 0, 1700000000000), p(12, 4, 1700000000500)]);
});

// --- Real processes, Windows only -------------------------------------------------------------

const started2: number[] = [];
after(() => {
  for (const pid of started2) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
});

const TREE = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
process.stdout.write("grandchild " + grandchild.pid + "\\n");
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(check: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("on Windows a real tree it started is ended, and an unrelated process is left running", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  started2.push(unrelated.pid ?? 0);
  const before = Date.now();
  const root = spawn(process.execPath, ["-e", TREE], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  trackSpawn(root, before);
  const rootPid = root.pid ?? 0;
  started2.push(rootPid);
  let out = "";
  root.stdout?.setEncoding("utf8");
  root.stdout?.on("data", (chunk: string) => (out += chunk));
  await until(() => /grandchild \d+/.test(out), "the grandchild to start");
  const grandchild = Number(/grandchild (\d+)/.exec(out)?.[1]);
  started2.push(grandchild);
  const window = trackedWindow(rootPid);
  assert.ok(window, "the spawn was tracked");

  const result = await endWindowsTree(rootPid, window);

  assert.equal(result.listed, true);
  // The tree also holds the console hosts (conhost) Windows started for the node processes.
  assert.equal(result.tree[0], rootPid);
  assert.ok(result.tree.includes(grandchild), `tree ${result.tree.join(" ")}`);
  assert.ok(!result.tree.includes(unrelated.pid ?? 0));
  assert.ok(!result.tree.includes(process.pid));
  await until(() => !alive(rootPid) && !alive(grandchild), "the tree to be gone");
  assert.equal(alive(unrelated.pid ?? 0), true, "the unrelated process is still running");
  // Once the root has exited it is no longer known, so a second kill by its pid touches nothing.
  await until(() => trackedWindow(rootPid) === undefined, "the exit to be seen");
});
