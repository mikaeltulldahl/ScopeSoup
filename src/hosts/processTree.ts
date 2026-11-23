// Ends a Windows process tree without ending processes that are not in it.
//
// `taskkill /PID <pid> /T` follows parent pids, and Windows reuses pids: after a parent exits, the
// parent pid recorded on its children can belong to an unrelated process, so a tree kill can end
// processes that have nothing to do with Scope Soup. Node has no job-object API, so instead one listing
// of every process (pid, parent pid, creation time) is taken and walked down from the root, and a
// child is accepted only when it was created no earlier than its parent: a process created before
// its supposed parent got that parent pid from some other, older process that has since exited. The
// root itself must be the process that was started: its creation time must lie in the window known
// from the spawn (or the exact time read earlier). Each accepted process is then ended by its own
// pid (no /T), after its creation time is checked once more, right before the kill.
//
// This sits under src/hosts because a host may import only hosts, ports and model; the orchestrator
// imports it from here (as it does src/hosts/spawnRetry.ts).

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface ProcessEntry {
  pid: number;
  /** The parent pid Windows recorded at creation. That parent may have exited, and its pid be reused since. */
  parent: number;
  /** Creation time, in ms since the epoch. */
  createdMs: number;
}

/** When the root process was created, at the earliest and the latest, in ms since the epoch. */
export interface CreationWindow {
  notBeforeMs: number;
  notAfterMs: number;
}

/**
 * The processes of `root`'s tree in `table`, the root first and each parent before its children;
 * empty when the root is not there or is not the process that was started (created outside `window`):
 * then its pid now belongs to another program and nothing may be ended by it.
 */
export function treeToEnd(table: readonly ProcessEntry[], root: number, window: CreationWindow): ProcessEntry[] {
  const top = table.find((entry) => entry.pid === root);
  if (!top || top.createdMs < window.notBeforeMs || top.createdMs > window.notAfterMs) return [];
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    // The idle and system processes name themselves (or 0) as parent.
    if (entry.pid === entry.parent) continue;
    children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry]);
  }
  const tree: ProcessEntry[] = [top];
  const seen = new Set<number>([top.pid]);
  for (let index = 0; index < tree.length; index++) {
    const parent = tree[index] as ProcessEntry;
    for (const child of children.get(parent.pid) ?? []) {
      // Created before its supposed parent: an unrelated process whose real parent had this pid before.
      if (child.createdMs < parent.createdMs || seen.has(child.pid)) continue;
      seen.add(child.pid);
      tree.push(child);
    }
  }
  return tree;
}

/**
 * Takes a process listing, lets `choose` pick from it, and ends the chosen processes, each by its own
 * pid and only when its creation time is still the listed one. While `choose` asks for it (`again`),
 * another listing follows the kills, in the same session, and `choose` is called with it and with the
 * time the kills before it were done (`endedByMs`). `listed` is false when no listing could be had
 * (then nothing was ended); `ended` are the pids that were ended, in every round.
 */
export type ProcessTableSession = (choose: (table: ProcessEntry[], endedByMs?: number) => Promise<{ end: ProcessEntry[]; again: boolean }>) => Promise<{ listed: boolean; ended: number[] }>;

/** How long the whole PowerShell run (the listings and the kills) may take. */
const SESSION_TIMEOUT_MS = 20_000;

/**
 * Windows PowerShell (built in, no admin rights): lists Win32_Process with pid, parent pid and creation
 * time, then reads "<pid> <createdMs>" lines and ends each process whose start time still matches. On
 * "again" it says when the kills were done ("killed <ms>") and lists once more; on "end" it says "done".
 */
const SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ms = { param($d) [DateTimeOffset]::new($d.ToUniversalTime()).ToUnixTimeMilliseconds() }
do {
  foreach ($p in Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate) {
    if ($p.CreationDate) { [Console]::Out.WriteLine(('{0} {1} {2}' -f $p.ProcessId, $p.ParentProcessId, (& $ms $p.CreationDate))) }
  }
  [Console]::Out.WriteLine('listed')
  [Console]::Out.Flush()
  $again = $false
  while ($null -ne ($line = [Console]::In.ReadLine()) -and $line -ne 'end') {
    if ($line -eq 'again') { $again = $true; break }
    $id, $created = $line.Split(' ')
    $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
    if ($p -and [Math]::Abs((& $ms $p.StartTime) - [long]$created) -le 1) {
      try { $p.Kill(); [Console]::Out.WriteLine("ended $id") } catch {}
    }
  }
  if ($again) { [Console]::Out.WriteLine(('killed {0}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())) }
  [Console]::Out.Flush()
} while ($again)
[Console]::Out.WriteLine('done')
[Console]::Out.Flush()
`;

/** Parses the listing lines "<pid> <parent> <createdMs>"; lines that do not parse are left out. */
export function parseListing(lines: readonly string[]): ProcessEntry[] {
  const table: ProcessEntry[] = [];
  for (const line of lines) {
    const parts = line.trim().split(" ").map(Number);
    if (parts.length !== 3 || !parts.every((part) => Number.isSafeInteger(part) && part >= 0)) continue;
    const [pid, parent, createdMs] = parts as [number, number, number];
    table.push({ pid, parent, createdMs });
  }
  return table;
}

/** The real `ProcessTableSession`: one Windows PowerShell process does the listings and the kills. */
export const windowsProcessTable: ProcessTableSession = (choose) =>
  new Promise((done) => {
    let child: ChildProcess;
    try {
      const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false });
    } catch {
      return done({ listed: false, ended: [] });
    }
    let out = "";
    // How much of `out` has been read as listings; a listing is being chosen from while `choosing`.
    let read = 0;
    let choosing = false;
    let listed = false;
    let over = false;
    const finish = (): void => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      const lines = out.split(/\r?\n/);
      const ended = lines.filter((line) => line.startsWith("ended ")).map((line) => Number(line.slice(6)));
      done({ listed, ended });
    };
    // A PowerShell that hangs must not hold the kill forever; what it already ended is still reported.
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, SESSION_TIMEOUT_MS);
    const nextListing = (): void => {
      if (choosing || over) return;
      const marker = /(^|\n)listed\r?\n/.exec(out.slice(read));
      if (!marker) return;
      const lines = out.slice(read, read + marker.index).split(/\r?\n/);
      read += marker.index + marker[0].length;
      listed = true;
      choosing = true;
      const killed = lines.find((line) => line.startsWith("killed "));
      choose(parseListing(lines), killed ? Number(killed.slice(7)) : undefined).then(
        ({ end, again }) => {
          choosing = false;
          const kills = end.map((entry) => `${entry.pid} ${entry.createdMs}\n`).join("");
          if (again) child.stdin?.write(`${kills}again\n`);
          else child.stdin?.end(`${kills}end\n`);
          nextListing();
        },
        () => child.stdin?.end("end\n"),
      );
    };
    child.stdin?.on("error", () => undefined);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      // The last kills are done: no need to wait for PowerShell to exit, which can take seconds on a busy machine.
      if (/(^|\n)done\r?\n/.test(out.slice(read))) finish();
      else nextListing();
    });
    child.on("error", finish);
    child.on("close", finish);
  });

export interface EndTreeOptions {
  /** The listing and the kills; the real PowerShell one by default. Tests pass a fake table. */
  table?: ProcessTableSession;
  /**
   * More processes of the tree that the parent pids do not reach (git.ts: MSYS children); taken only from `table`.
   * `tree` starts with the root; from the second round on it also holds the processes already ended, which are gone
   * from `table`, and `cutoffMs` is when they were ended at the latest: a child of one of them was created before that.
   */
  extend?: (tree: ProcessEntry[], table: ProcessEntry[], cutoffMs?: number) => Promise<ProcessEntry[]>;
}

/** How many listings a tree kill takes at most: the first, and more while each finds processes the one before missed. */
const MAX_ROUNDS = 5;

/**
 * The processes in `table` that `members` (already ended, or chosen before) started and that are not
 * members themselves, with what those started, each parent before its children. A member
 * may have started a process after the listing it was chosen from and before it was ended: such a
 * process was created no earlier than the member and no later than `cutoffMs`, when the member was
 * ended. A member's pid that a living non-member holds now was reused: nothing is taken by it.
 */
export function startedByMembers(table: readonly ProcessEntry[], members: readonly ProcessEntry[], cutoffMs: number): ProcessEntry[] {
  const key = (entry: ProcessEntry): string => `${entry.pid} ${entry.createdMs}`;
  const memberKeys = new Set(members.map(key));
  const reused = new Set(table.filter((entry) => !memberKeys.has(key(entry))).map((entry) => entry.pid));
  const byPid = new Map<number, ProcessEntry[]>();
  for (const member of members) if (!reused.has(member.pid)) byPid.set(member.pid, [...(byPid.get(member.pid) ?? []), member]);
  const found: ProcessEntry[] = [];
  const seen = new Set<string>();
  for (const entry of table) {
    if (entry.pid === entry.parent || memberKeys.has(key(entry))) continue;
    const parents = byPid.get(entry.parent) ?? [];
    if (!parents.some((parent) => entry.createdMs >= parent.createdMs && entry.createdMs <= cutoffMs)) continue;
    seen.add(key(entry));
    found.push(entry);
  }
  // What those started since: they are alive in `table`, so the usual walk applies below them.
  for (let index = 0; index < found.length; index++) {
    const parent = found[index] as ProcessEntry;
    for (const entry of table) {
      if (entry.parent !== parent.pid || entry.pid === entry.parent || entry.createdMs < parent.createdMs || seen.has(key(entry)) || memberKeys.has(key(entry))) continue;
      seen.add(key(entry));
      found.push(entry);
    }
  }
  return found;
}

/**
 * Ends `root` and every process it started, on Windows, by the rules at the top of this file.
 * `listed` is false when no listing could be had: then nothing was ended, and the caller may end
 * the root alone if it knows the root is still its own (Node holds the handle of a child that has
 * not exited, so its pid cannot have been reused).
 *
 * One listing is not enough: between the listing and the kills, a process of the tree
 * can start another (a hook's shell forking, or a fork exec'ing its program), and that one is in no
 * listing. Once the first round has ended the tree, nothing in it starts anything more, so later
 * listings find what was started in between, until one finds nothing new.
 */
export async function endWindowsTree(root: number, window: CreationWindow, options: EndTreeOptions = {}): Promise<{ listed: boolean; tree: number[]; ended: number[] }> {
  const members: ProcessEntry[] = [];
  let round = 0;
  const result = await (options.table ?? windowsProcessTable)(async (table, endedByMs) => {
    // Everything chosen so far was ended (or had exited) by then: whatever it started was started before.
    const cutoffMs = (endedByMs ?? Date.now()) + CLOCK_SLACK_MS;
    const chosen = round === 0 ? treeToEnd(table, root, window) : startedByMembers(table, members, cutoffMs);
    if ((round === 0 ? chosen.length > 0 : members.length > 0) && options.extend) {
      const key = (entry: ProcessEntry): string => `${entry.pid} ${entry.createdMs}`;
      const known = new Set([...members, ...chosen].map(key));
      for (const extra of await options.extend([...members, ...chosen], table, round === 0 ? undefined : cutoffMs)) {
        if (!known.has(key(extra))) {
          known.add(key(extra));
          chosen.push(extra);
        }
      }
    }
    round++;
    members.push(...chosen);
    return { end: chosen, again: chosen.length > 0 && round < MAX_ROUNDS };
  });
  return { ...result, tree: members.map((entry) => entry.pid) };
}

/** Kernel creation times can trail the clock reading taken just before the spawn by a timer tick or so. */
const CLOCK_SLACK_MS = 100;

/** The creation windows of the children started through `trackSpawn` that have not exited. */
const tracked = new Map<number, CreationWindow>();

/**
 * Records the creation window of a child just spawned (`beforeMs`: the clock read right before the
 * spawn call), until it exits. After the exit its pid may be reused, so it is no longer known.
 */
export function trackSpawn(child: ChildProcess, beforeMs: number): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const window: CreationWindow = { notBeforeMs: beforeMs - CLOCK_SLACK_MS, notAfterMs: Date.now() + CLOCK_SLACK_MS };
  tracked.set(pid, window);
  child.once("exit", () => {
    if (tracked.get(pid) === window) tracked.delete(pid);
  });
}

/** The creation window of a child started through `trackSpawn` that has not exited; undefined otherwise. */
export function trackedWindow(pid: number): CreationWindow | undefined {
  return tracked.get(pid);
}

/** A window around a creation time read earlier (`startTimeMs`), allowing for the rounding of the two readings. */
export function windowAround(createdMs: number): CreationWindow {
  return { notBeforeMs: createdMs - 1, notAfterMs: createdMs + 1 };
}
