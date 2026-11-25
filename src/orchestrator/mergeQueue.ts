// The merge queue lease: only one machine merges at a time (decision 31). The lease is a chain of empty
// commits on `refs/scopesoup/merge-queue` of the remote, next to the meta ref. Each commit's message holds
// one JSON line: who took the lease, until when, or that it was let go.
//
// Why a chain of commits, and not a line in the meta branch's logs:
// - Taking the lease is a fast-forward push of a new commit on top of the one that was read. Git
//   itself lets only one of two machines that raced do it; the other's push is rejected. Nothing
//   depends on the two clocks, and nothing is forced.
// - It is append-only like the logs: the history of the ref is the history of the lease.
// - The meta branch's writer works on items; a project-wide log would have changed it for one use.
//
// An expired lease (its `until` passed without a release or a renewing commit) is free: a machine
// that died while merging does not block the others for longer than the lease's length.
//
// The same lease holds a unit of a shared resource (`resources.ts`): one ref per unit, named by `ref`.
//
// Singleplayer (`multiplayer: false`, decision 93): nothing is fetched or pushed under `refs/scopesoup/`, and what an earlier
// multiplayer run left there is left alone. The same chain is kept on a local ref instead (`refs/scopesoup-local/lease/...`),
// moved by compare-and-swap (`update-ref` with the old value) and never pushed, so two Scope Soup processes on one clone still
// exclude each other. Its lines name the process too (`pid`): a lease of a process that is no longer running is free.

import type { Git } from "./process.ts";

export const MERGE_QUEUE_REF = "refs/scopesoup/merge-queue";
const AUTHOR = ["-c", "user.name=Scope Soup merge queue lease", "-c", "user.email=scopesoup@users.noreply.invalid", "-c", "commit.gpgsign=false"];

/** What the newest commit of the lease ref says. */
export interface LeaseInfo {
  /** The machine. */
  holder: string;
  /** When the line was written. */
  at: string;
  /** Singleplayer's local lease: the process that holds it. */
  pid?: number;
  /** When the lease lapses without a renewal. */
  until: string;
  /** The holder let go. */
  released: boolean;
}

export type Lease =
  | { held: true; until: string }
  /** `holder` and `until` are known when another machine holds the lease. */
  | { held: false; why: string; holder?: string; until?: string };

export interface MergeQueue {
  /** Takes the lease for `minutes` from `at`, or renews it when this machine holds it. Never throws. */
  acquire(at: string, minutes: number): Promise<Lease>;
  /** Lets the lease go, if this machine holds it. Never throws: a lease not released lapses by itself. */
  release(at: string): Promise<void>;
  /** The lease as the remote has it now: null when there is none, or when it is free. */
  peek(at: string): Promise<LeaseInfo | null>;
}

export interface MergeQueueDeps {
  git: Git;
  /** A repository that has `remote`. */
  repo: string;
  remote: string;
  /** This machine's name. */
  machine: string;
  /** The lease's ref, under `refs/scopesoup/`. Default: the merge queue lease, `MERGE_QUEUE_REF`. */
  ref?: string;
  /** What the holder does while it holds the lease, in a refusal ("laptop-a merges until ..."). Default: "merges". */
  doing?: string;
  /** Asked at each call: true (singleplayer) keeps the lease on a local ref, never fetched or pushed. Default never. */
  alone?: () => boolean;
}

const tail = (text: string): string => text.trim().slice(-300);

function parseLease(message: string): LeaseInfo | null {
  for (const line of message.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.holder !== "string" || typeof value.at !== "string" || typeof value.until !== "string") return null;
      if (Number.isNaN(Date.parse(value.until))) return null;
      return { holder: value.holder, at: value.at, until: value.until, released: value.kind === "release", ...(typeof value.pid === "number" ? { pid: value.pid } : {}) };
    } catch {
      return null;
    }
  }
  return null;
}

export function createMergeQueue(deps: MergeQueueDeps): MergeQueue {
  const { git, repo, remote, machine } = deps;
  const ref = deps.ref ?? MERGE_QUEUE_REF;
  const doing = deps.doing ?? "merges";
  const tracking = `refs/scopesoup-remote/${ref.replace(/^refs\/scopesoup\//, "")}`;
  const title = ref === MERGE_QUEUE_REF ? "Scope Soup merge queue lease" : `Scope Soup lease ${ref}`;

  const local = `refs/scopesoup-local/lease/${ref.replace(/^refs\/scopesoup\//, "")}`;
  const alone = (): boolean => deps.alone?.() === true;

  /** The lease ref as the remote has it (singleplayer: the local one): its commit and what it says. `commit` null: there is no ref. */
  async function look(here: boolean): Promise<{ commit: string | null; info: LeaseInfo | null } | { error: string }> {
    let at = local;
    if (!here) {
      const listed = await git(["ls-remote", remote, ref], repo);
      if (listed.code !== 0) return { error: `could not reach ${remote}: ${tail(listed.stderr)}` };
      if (listed.stdout.trim() === "") return { commit: null, info: null };
      const fetched = await git(["fetch", "--quiet", "--no-tags", remote, `+${ref}:${tracking}`], repo);
      if (fetched.code !== 0) return { error: `could not fetch the lease ${ref} from ${remote}: ${tail(fetched.stderr)}` };
      at = tracking;
    }
    const parsed = await git(["rev-parse", "--verify", "--quiet", `${at}^{commit}`], repo);
    if (parsed.code !== 0) return here ? { commit: null, info: null } : { error: `could not read the lease ${ref}: ${tail(parsed.stderr)}` };
    const commit = parsed.stdout.trim();
    const message = await git(["log", "-1", "--format=%B", commit], repo);
    return { commit, info: message.code === 0 ? parseLease(message.stdout) : null };
  }

  /**
   * Writes a commit on top of `parent` and pushes it as a fast-forward (singleplayer: moves the local ref from `parent`, compare-
   * and-swap). Returns the problem, or null.
   */
  async function write(here: boolean, parent: string | null, line: Record<string, unknown>): Promise<string | null> {
    const tree = await git(["hash-object", "-t", "tree", "-w", "--stdin"], repo, "");
    if (tree.code !== 0) return `could not make the lease commit: ${tail(tree.stderr)}`;
    const made = await git([...AUTHOR, "commit-tree", tree.stdout.trim(), ...(parent ? ["-p", parent] : []), "-m", `${title}\n\n${JSON.stringify(here ? { ...line, pid: process.pid } : line)}`], repo);
    if (made.code !== 0) return `could not make the lease commit: ${tail(made.stderr)}`;
    if (here) {
      // The old value makes it a compare-and-swap: another process that moved the ref first wins.
      const moved = await git(["update-ref", local, made.stdout.trim(), parent ?? "0".repeat(40)], repo);
      return moved.code === 0 ? null : tail(moved.stderr);
    }
    // No force: a commit that is not on top of the remote's is rejected, which is how a lost race shows.
    const pushed = await git(["push", "--quiet", remote, `${made.stdout.trim()}:${ref}`], repo);
    return pushed.code === 0 ? null : tail(pushed.stderr);
  }

  /** Whether a process is still running: a local lease of one that is not is free. */
  const running = (pid: number): boolean => {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const live = (info: LeaseInfo | null, at: string): info is LeaseInfo =>
    info !== null && !info.released && Date.parse(info.until) > Date.parse(at) && (info.pid === undefined || running(info.pid));
  /** This holder: the machine, and in singleplayer this process. */
  const ours = (info: LeaseInfo, here: boolean): boolean => info.holder === machine && (!here || info.pid === process.pid);
  const by = (info: LeaseInfo, here: boolean): string => (here && info.holder === machine ? `another Scope Soup process on ${machine} (pid ${info.pid ?? "?"})` : info.holder);

  return {
    async acquire(at, minutes) {
      const here = alone();
      const seen = await look(here);
      if ("error" in seen) return { held: false, why: seen.error };
      if (live(seen.info, at) && !ours(seen.info, here)) {
        return { held: false, why: `${by(seen.info, here)} ${doing} until ${seen.info.until}`, holder: seen.info.holder, until: seen.info.until };
      }
      const until = new Date(Date.parse(at) + minutes * 60_000).toISOString();
      const problem = await write(here, seen.commit, { kind: "lease", holder: machine, at, until });
      if (problem === null) return { held: true, until };
      // Most likely another machine (or process) was first: say who, when the ref shows it.
      const after = await look(here);
      if (!("error" in after) && live(after.info, at) && !ours(after.info, here)) {
        return { held: false, why: `${by(after.info, here)} took the lease first`, holder: after.info.holder, until: after.info.until };
      }
      return { held: false, why: `the lease could not be written: ${problem}` };
    },

    async release(at) {
      try {
        const here = alone();
        const seen = await look(here);
        if ("error" in seen || !live(seen.info, at) || !ours(seen.info, here)) return;
        await write(here, seen.commit, { kind: "release", holder: machine, at, until: at });
      } catch {
        // The lease lapses by itself.
      }
    },

    async peek(at) {
      const seen = await look(alone());
      return "error" in seen || !live(seen.info, at) ? null : seen.info;
    },
  };
}
