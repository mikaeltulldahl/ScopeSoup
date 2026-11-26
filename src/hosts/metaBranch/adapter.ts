// The meta branch adapter: items and changes kept on a branch of the project's own repository
// (docs/DESIGN.md). Reading needs nothing; with `allowWrites` it also
// creates and edits items, appends to logs and shares the ref with the remote (writer.ts).

import type { Actor, Change, Ref, WorkItem } from "../../model/types.ts";
import type { Capability, ChangePort, Cursor, Host, HostInfo, Page, WorkPatch, WorkPort, WriteOutcome, WritePort } from "../../ports/host.ts";
import type { RunGit } from "./git.ts";
import { checkRepoRoot, gitIn, readMetaTree, resolveRef } from "./git.ts";
import type { MetaFormat } from "./format.ts";
import { META_FORMAT, writeProblem } from "./format.ts";
import type { StoppableGit } from "./git.ts";
import { isBranchName, isMetaRef } from "./ids.ts";
import type { ItemFields } from "./item.ts";
import { parseItem } from "./item.ts";
import type { Person } from "./plumbing.ts";
import { RefusedWrite } from "./serialize.ts";
import type { WriteResult, Writer } from "./writer.ts";
import { createWriter } from "./writer.ts";
import type { MetaScope, ReadReport } from "./map.ts";
import { mapItems } from "./map.ts";
import { META_REF } from "./settings.ts";

/** Every project's meta ref has this one name (settings.ts); `ref` below is for tests. */
export const DEFAULT_META_REF = META_REF;

export interface MetaBranchConfig {
  /** The repository (a working copy or a bare repository) whose object store holds the meta ref. */
  repoDir: string;
  /** Default `refs/scopesoup/meta` (fixed for a project; tests give their own). */
  ref?: string;
  /** The host id used in refs. Default "metaBranch". */
  id?: string;
  /** The main branch changes merge on. Default "main". */
  target?: string;
  /** Who this installation is, for `whoami`. Default "local". */
  user?: Actor;
  /** Replaces the git process, for tests. The directory is then not checked to be a repository's top level. */
  git?: RunGit;
  /** The most an `item.md` or `log.jsonl` may hold, in bytes; larger is malformed for its item. Default 1 MB. */
  maxFileBytes?: number;
  now?: () => string;
  /** Must be true for the host to get a write port. Without it nothing in the repository is changed: no commit, no fetch, no push. */
  allowWrites?: boolean;
  /** With writes: the author and committer of every commit. Required. */
  person?: Person;
  /** With writes: this machine's name, written in `by` on every log line. Required. */
  machine?: string;
  /** With writes: the prefix of the ids this machine creates (`A` gives `A-12`), one per machine. Without it no item can be created. */
  idPrefix?: string;
  /** With writes: the remote to share the ref with. Default "origin"; null for none. A repository without that remote is not shared. */
  remote?: string | null;
  /** With writes and a remote: asked before each fetch and push; false keeps the ref here (singleplayer). Default always. */
  shares?: () => boolean;
  /** With writes and a remote: how often a read fetches first. Default 60 s. */
  fetchIntervalMs?: number;
  /** With writes and a remote: pushes tried when the remote keeps moving. Default 5. */
  pushAttempts?: number;
  /** With writes: the most a log may hold after one of this machine's appends. Default 768 KB. */
  maxAppendLogBytes?: number;
  /** With writes: how old a lock file of Scope Soup's refs must be to count as left behind. Default 10 minutes. */
  staleLockMs?: number;
  /** The time limit of fetch, push and ls-remote (a pre-push hook may be slow). Default 5 minutes. */
  networkTimeoutMs?: number;
  /** Replaces git for fetch, push and ls-remote, for tests. Default: `git` when that is given. */
  network?: RunGit;
}

export interface MetaBranchHost extends Host {
  info: HostInfo;
  work: WorkPort;
  changes: ChangePort;
  /** What the last read found wrong (malformed items and lines, unknown kinds, skipped entries). Null before the first read. */
  lastReport(): ReadReport | null;
  /** The writer behind the write port, with what the port does not say (sharing, conflicts); null when writes are off. */
  writer: Writer | null;
  /** Ends every git this host still has running (a push in flight); later git calls fail. For shutdown. */
  stop(): Promise<void>;
}

/** An item's fields with a patch applied. */
function patched(current: ItemFields, patch: WorkPatch, idOf: (ref: Ref) => string): ItemFields {
  const next: ItemFields = { ...current, labels: [...current.labels], blockedBy: [...current.blockedBy], extra: [...current.extra] };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.body !== undefined) next.body = patch.body;
  if (patch.state !== undefined) next.state = patch.state;
  if (patch.labels !== undefined) next.labels = [...patch.labels];
  if (patch.blockedBy !== undefined) next.blockedBy = patch.blockedBy.map(idOf);
  if (patch.parent === null) delete next.parent;
  else if (patch.parent !== undefined) next.parent = idOf(patch.parent);
  if (patch.verification === null) delete next.verification;
  else if (patch.verification !== undefined) next.verification = patch.verification;
  if (patch.priority === null) delete next.priority;
  else if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.vote === 0) delete next.vote;
  else if (patch.vote !== undefined) next.vote = patch.vote;
  if (patch.duplicateOf !== undefined) next.duplicateOf = idOf(patch.duplicateOf);
  // Only an abandoned item is a duplicate: a reopen drops it.
  if (next.state !== "abandoned") delete next.duplicateOf;
  return next;
}

interface Read {
  commit: string | null;
  works: WorkItem[];
  changes: Change[];
  report: ReadReport;
}

/** A listing's cursor: the meta commit it read and the ids it returned, so a later listing can say what went. */
interface MetaCursor {
  commit: string | null;
  ids: string[];
}

function parseCursor(cursor: Cursor | undefined): MetaCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor) as Partial<MetaCursor>;
    if ((typeof value.commit !== "string" && value.commit !== null) || !Array.isArray(value.ids)) return null;
    return { commit: value.commit, ids: value.ids.filter((id): id is string => typeof id === "string") };
  } catch {
    return null;
  }
}

/** What the read report says of a meta branch that is not at this Scope Soup's format; undefined when it is. */
function formatNote(found: MetaFormat): ReadReport["format"] {
  if (found.ok && found.format === META_FORMAT) return undefined;
  if (found.ok && found.format < META_FORMAT) {
    return { format: found.format, note: writeProblem(found) ?? `The meta branch is format ${found.format}; the machine that holds the merge queue lease migrates it to format ${META_FORMAT}, and writes go on meanwhile.` };
  }
  return { format: found.ok ? found.format : null, note: writeProblem(found) as string };
}

export function createMetaBranchHost(config: MetaBranchConfig): MetaBranchHost {
  const ref = config.ref ?? DEFAULT_META_REF;
  if (!isMetaRef(ref)) throw new Error(`The meta ref "${ref}" is not a ref name Scope Soup accepts (refs/..., letters, digits, . _ - /).`);
  const target = config.target ?? "main";
  if (!isBranchName(target)) throw new Error(`The target branch "${target}" is not a branch name Scope Soup accepts.`);
  const own = config.git ? null : gitIn(config.repoDir);
  const git: RunGit = config.git ?? (own as StoppableGit);
  const ownNetwork = config.network ?? config.git ? null : gitIn(config.repoDir, { timeoutMs: config.networkTimeoutMs ?? 5 * 60_000 });
  const now = config.now ?? (() => new Date().toISOString());
  const host = config.id ?? "metaBranch";
  const capabilities = new Set<Capability>(["work", "changes"]);
  let report: ReadReport | null = null;
  // Once per host: the directory is a repository of its own, not a folder inside another one.
  let checked: Promise<void> | undefined;
  async function ready(): Promise<void> {
    if (config.git) return;
    checked ??= checkRepoRoot(git, config.repoDir);
    await checked.catch((error: unknown) => {
      checked = undefined; // try again on the next read: the folder may be fixed meanwhile
      throw error;
    });
  }

  let writer: Writer | null = null;
  if (config.allowWrites) {
    if (!config.person) throw new Error("Writing to the meta ref needs the commit author (name and email).");
    if (!config.machine) throw new Error("Writing to the meta ref needs this machine's name.");
    writer = createWriter({
      git,
      network: config.network ?? config.git ?? (ownNetwork as StoppableGit),
      ref,
      remote: config.remote === undefined ? "origin" : config.remote,
      person: config.person,
      machine: config.machine,
      ...(config.idPrefix === undefined ? {} : { idPrefix: config.idPrefix }),
      now,
      before: ready,
      repoDir: config.repoDir,
      ...(config.shares === undefined ? {} : { shares: config.shares }),
      ...(config.pushAttempts === undefined ? {} : { pushAttempts: config.pushAttempts }),
      ...(config.maxAppendLogBytes === undefined ? {} : { maxAppendLogBytes: config.maxAppendLogBytes }),
      ...(config.staleLockMs === undefined ? {} : { staleLockMs: config.staleLockMs }),
    });
    capabilities.add("write");
  }
  const fetchEvery = config.fetchIntervalMs ?? 60_000;
  let lastFetch = Number.NEGATIVE_INFINITY;

  // The work and change listings of one sync pass read the same commit: read it once.
  let cached: Read | null = null;
  async function read(): Promise<Read> {
    await ready();
    // Fetch first, now and then: the other machines' writes arrive this way. A problem goes to the sharing report, not into the read.
    const clock = Date.parse(now());
    if (writer && !(clock - lastFetch < fetchEvery)) {
      lastFetch = clock;
      await writer.share();
    }
    const commit = await resolveRef(git, ref);
    if (cached && cached.commit === commit) return cached;
    const tree = await readMetaTree(git, commit, now, config.maxFileBytes === undefined ? {} : { maxFileBytes: config.maxFileBytes });
    const scope: MetaScope = { host, target, fallbackTime: tree.time };
    const mapped = mapItems(scope, tree.files, tree.skipped);
    const format = formatNote(tree.format);
    report = format ? { ...mapped.report, format } : mapped.report;
    cached = { commit: tree.commit, ...mapped };
    return cached;
  }

  function page<T extends { ref: Ref }>(objects: T[], commit: string | null, since: Cursor | undefined, kind: Ref["kind"]): Page<T> {
    const before = parseCursor(since);
    const ids = objects.map((object) => object.ref.id);
    const cursor = JSON.stringify({ commit, ids } satisfies MetaCursor);
    if (before && before.commit === commit) return { items: [], cursor, unchanged: true };
    const present = new Set(ids);
    const removed = (before?.ids ?? []).filter((id) => !present.has(id)).map((id): Ref => ({ host, kind, id }));
    return removed.length > 0 ? { items: objects, cursor, removed } : { items: objects, cursor };
  }

  const work: WorkPort = {
    async listWork(since) {
      const got = await read();
      return page(got.works, got.commit, since, "work");
    },
    async getWork(wanted) {
      return (await read()).works.find((item) => item.ref.id === wanted.id) ?? null;
    },
  };

  const changes: ChangePort = {
    async listChanges(since) {
      const got = await read();
      return page(got.changes, got.commit, since, "change");
    },
    async getChange(wanted) {
      return (await read()).changes.find((change) => change.ref.id === wanted.id) ?? null;
    },
  };

  /** The id of one of this host's items; anything else is refused before it reaches a path. */
  const idOf = (wanted: Ref): string => {
    if (wanted.host !== host || wanted.kind !== "work") throw new RefusedWrite(`${wanted.host}:${wanted.kind}:${wanted.id} is not an item of ${host}.`);
    return wanted.id;
  };
  const outcome = (result: WriteResult): WriteOutcome => {
    const done: WriteOutcome = { work: { host, kind: "work", id: result.id }, shared: result.sharing.state, conflict: result.conflict };
    if (result.sharing.problem) done.problem = result.sharing.problem;
    if (result.movedFrom) done.movedFrom = result.movedFrom;
    return done;
  };
  const write: WritePort | null =
    writer === null
      ? null
      : {
          async createWork(input) {
            const created = await (writer as Writer).createItem({
              title: input.title,
              ...(input.body === undefined ? {} : { body: input.body }),
              ...(input.state === undefined ? {} : { state: input.state }),
              ...(input.labels === undefined ? {} : { labels: input.labels }),
              ...(input.parent === undefined ? {} : { parent: idOf(input.parent) }),
              ...(input.blockedBy === undefined ? {} : { blockedBy: input.blockedBy.map(idOf) }),
              ...(input.verification === undefined ? {} : { verification: input.verification }),
              ...(input.priority === undefined ? {} : { priority: input.priority }),
            }, input.log);
            return outcome(created);
          },
          async editWork(target, patch, options) {
            const supersedes = options?.resolveConflict?.supersedes;
            return outcome(await (writer as Writer).editItem(idOf(target), (current) => patched(current, patch, idOf), supersedes ? { resolveConflict: { supersedes } } : {}));
          },
          async conflictVersions(target) {
            const got = await (writer as Writer).versions(idOf(target));
            if (got.aside.length === 0) return null;
            return { current: got.itemMd, aside: got.aside.map(({ file, blob, text }) => ({ id: blob, name: file, text })) };
          },
          async resolveConflict(target, text, supersedes) {
            const id = idOf(target);
            const parsed = parseItem(text, id);
            if (!parsed.ok) throw new RefusedWrite(`The result cannot be read as item.md: ${parsed.problems.join("; ")}.`);
            return outcome(await (writer as Writer).editItem(id, parsed.fields, { resolveConflict: { supersedes } }));
          },
          async appendLog(target, line) {
            return outcome(await (writer as Writer).appendLog(idOf(target), line));
          },
          async appendLogs(target, lines) {
            return outcome(await (writer as Writer).appendLog(idOf(target), lines));
          },
        };

  const user = config.user ?? { id: "local", name: "local" };
  return {
    info: {
      id: host, capabilities, whoami: async () => user, ...(config.machine ? { machine: config.machine } : {}),
      // A meta branch with writes and a remote to share it with is shared, and Scope Soup claims what it starts there. Read each
      // time: singleplayer (`shares` false) is not shared, and it can be switched while Scope Soup runs.
      get shared(): true | undefined {
        return config.allowWrites && config.remote !== null && config.shares?.() !== false ? true : undefined;
      },
    },
    work,
    changes,
    ...(write ? { write } : {}),
    lastReport: () => report,
    writer,
    async stop() {
      await Promise.all([own?.stop(), ownNetwork?.stop()]);
    },
  };
}
