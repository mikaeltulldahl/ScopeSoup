// Writing the meta ref: each write is one commit made with plumbing and put on the ref only if
// the ref is still where the write read it; then the ref is shared with the remote, fast-forward
// only. The rules are in docs/DESIGN.md ("Writing to the meta branch").

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { RunGit } from "./git.ts";
import type { MetaFormat } from "./format.ts";
import { FORMAT_FILE, META_FORMAT, formatText, migrationChanges, readFormat, writeProblem } from "./format.ts";
import { allocateId, isIdPrefix, isItemId, isMetaRef } from "./ids.ts";
import type { ItemFields } from "./item.ts";
import { parseItem } from "./item.ts";
import { MAX_APPEND_LOG_BYTES, MAX_FILE_BYTES } from "./limits.ts";
import type { Files, PathChange, TreeEntry } from "./merge.ts";
import { addedLines, appendLines, appendOnlyProblem, isLogFile, itemPath, logLines, lostLines, mergeTrees, moveItemPaths, renameInHeader } from "./merge.ts";
import type { SettingChange } from "./settings.ts";
import { isSettingsPath, SETTINGS_FILE, SETTINGS_LOG } from "./settings.ts";
import type { CommitInfo, Person } from "./plumbing.ts";
import {
  changesSince,
  checkedOutRefs,
  checkGitVersion,
  checkPerson,
  commitsSince,
  commonDir,
  fetchRef,
  filesOf,
  gitDate,
  hasMerges,
  hasRemote,
  isAncestor,
  isRemoteName,
  itemFileNames,
  mergeBase,
  moveRef,
  networkEnvironment,
  pushRef,
  readCommits,
  readRefs,
  readTexts,
  readTree,
  relation,
  remoteRef,
  writeBlob,
  writeBlobs,
  writeCommit,
  writeTree,
  writeTreeEntries,
} from "./plumbing.ts";
import type { ItemInput } from "./serialize.ts";
import { RefusedWrite, canonicalItem, serializeItem, serializeLogLine } from "./serialize.ts";

/** The refs one round works from, read together: see `heads` in `createMetaWriter`. */
interface Heads {
  local: string | null;
  seen: string | null;
  shared: string | null;
  /** Where the scratch ref of a fetch points; only read when asked for. */
  incoming: string | null;
}

export interface WriterConfig {
  /** git in the repository, for local plumbing. */
  git: RunGit;
  /** git in the repository, for fetch, push and ls-remote (a longer time limit: a pre-push hook may be slow). */
  network: RunGit;
  /** The repository's folder: lock files are looked for under its git directory. */
  repoDir?: string;
  ref: string;
  /** The remote to share with; null for none. A name the repository does not have means none too. */
  remote: string | null;
  /** The author and committer of every commit. */
  person: Person;
  /** This machine's name, put in `by` on every line. */
  machine: string;
  /** The prefix of new ids (`A` gives `A-12`), one per machine. Without it no item can be created. */
  idPrefix?: string;
  now: () => string;
  /** How many pushes are tried when the remote keeps moving. Default 5. */
  pushAttempts?: number;
  /** How many times a write is done again when another local writer moved the ref first. Default 5. */
  localAttempts?: number;
  /** The most a log may hold after one of this machine's appends. Default MAX_APPEND_LOG_BYTES (768 KB). */
  maxAppendLogBytes?: number;
  /** How old a lock file of Scope Soup's refs must be to count as left behind. Default 10 minutes (longer than any git call may run). */
  staleLockMs?: number;
  /** For how long after one of this machine's new items was moved to a free id a write to its old id is refused. Default one hour. */
  movedWindowMs?: number;
  /** For how long the checked-out branches and whether the remote exists are kept before they are asked again. Default 10 seconds. */
  recheckMs?: number;
  /** Runs before every write and sharing round (the adapter checks the folder is a repository's top level). */
  before?: () => Promise<void>;
}

/** What one round of sharing did. */
export interface SharingReport {
  at: string;
  /** `local`: nothing to share with. `shared`: the remote has every commit. `pending`: some commits wait for the next push. */
  state: "local" | "shared" | "pending";
  /** Pushes tried, and how many the remote refused because it had moved. */
  pushes: number;
  refusedPushes: number;
  /** Own commits put again on top of fetched ones. */
  replayed: number;
  /** Items whose `item.md` was changed on both sides: both versions kept, the item waits for a person. */
  conflicts: string[];
  /** Items this machine created whose id another machine had taken meanwhile: they moved to a free id. */
  renamed: { from: string; to: string }[];
  /** Lock files of Scope Soup's refs left behind by an ended git: removed (Scope Soup's own scratch refs) or to be removed by a person. */
  locks: string[];
  /** Why something was not shared. Nothing is lost: unshared commits stay on the local ref. */
  problem?: string;
}

export interface WriteResult {
  /** The item written. For a new item whose id was taken by another machine meanwhile, the id it moved to. */
  id: string;
  /** The new commit; the old one when the write changed nothing. */
  commit: string | null;
  changed: boolean;
  /** The item has versions of `item.md` put aside: it waits for a person. */
  conflict: boolean;
  /** A new item that moved to `id` while it was shared, because another machine had made an item with this id first. */
  movedFrom?: string;
  sharing: SharingReport;
}

/** What accepting a refused fetched history did. */
export interface AcceptReport {
  /** The fetched commit now taken as the remote's history. */
  accepted: string;
  /** Where this machine's meta ref was saved before (null when there was none). */
  backup: string | null;
  /** This machine's own unshared commits put on top of it. */
  replayed: number;
  /** Unshared commits this machine did not make: not put on top (they are in the backup). */
  notReplayed: string[];
  renamed: { from: string; to: string }[];
  conflicts: string[];
  /** The push that followed. */
  sharing: SharingReport;
}

/** Who writes a line; the writer adds the machine. */
export interface LineBy {
  who: string;
  agent: boolean;
}

export interface LineWrite {
  kind: string;
  by: LineBy;
  fields?: Record<string, unknown>;
}

export type ItemEdit = ItemFields | ((current: ItemFields) => ItemFields);

export interface EditOptions {
  /**
   * The edit settles a conflict: it supersedes these versions put aside, named by their blob ids as
   * `versions(id)` gives them. Only those are removed; a version the person has not seen stays, and
   * the item stays in conflict. Without it an item in conflict cannot be edited.
   */
  resolveConflict?: { supersedes: string[] };
}

export interface ItemVersions {
  /** `item.md` as it stands. */
  itemMd: string | null;
  /** The versions put aside in a conflict: file name, blob id, text. */
  aside: { file: string; blob: string; text: string }[];
}

/** One item of a batch (`createItems`). */
export interface BatchItem {
  /** The caller's name for the item, unique in the batch: links inside the batch and the result use it. */
  key: string;
  /**
   * A header key and value that names where the item came from (`importedFrom`, `github:owner/name#12`). When an item on the
   * ref already has it (the value in any case), that item is this one: nothing is written for it, and links to the key go to its id.
   */
  unique?: [string, string];
  /** The item, made once the ids are known: `idOf` gives the id of any key of the batch (new or found), or undefined. */
  make(idOf: (key: string) => string | undefined): { input: ItemInput; lines?: LineWrite[] };
}

export interface BatchOptions {
  /** The commit's title. Default "Create N items". */
  message?: string;
  /** Plan only: read the ref, allocate the ids as a write would now, and change nothing (no commit, no fetch, no push). */
  dryRun?: boolean;
}

/** What `createItems` did, or (dry run) would do. */
export interface BatchResult {
  /** Key -> the item's id, and whether this batch creates it (false: an item on the ref already had its `unique` value). */
  items: Map<string, { id: string; created: boolean }>;
  /** The commit; the old tip when nothing was written. */
  commit: string | null;
  changed: boolean;
  /** Null on a dry run. */
  sharing: SharingReport | null;
}

/**
 * A save of the shared settings. `update` gets the settings file's text as it stands on the ref (null when there is
 * none) and gives the new text and what changed, or null for no change; it may throw `RefusedWrite`. It is called again on
 * the newest settings when another writer moved the ref first (compare-and-swap), so it must not depend on an earlier read.
 */
export type SettingsUpdate = (current: string | null) => { text: string; changes: SettingChange[] } | null;

/** What a save of the settings did. */
export interface SettingsWriteResult {
  commit: string | null;
  changed: boolean;
  /** What the save changed, as written in its log line; empty when it changed nothing. */
  changes: SettingChange[];
  sharing: SharingReport;
}

export interface Writer {
  /**
   * One commit that writes the shared settings and one line in their log, naming `by` (a person) as the line's writer
   * and the commit's author. Then the ref is shared, as after any write.
   */
  writeSettings(update: SettingsUpdate, by: { who: string; email?: string }): Promise<SettingsWriteResult>;
  /** `lines` are written to the new item's log in the same commit. */
  createItem(input: ItemInput, lines?: LineWrite[]): Promise<WriteResult>;
  /**
   * Creates many items in one commit (an import), with links between them by key. The git processes it starts do not
   * grow with the number of items: one tree read, one read of the existing headers when `unique` is used, one `fast-import`
   * for every blob, one `mktree`, one commit, one move of the ref, then the sharing round.
   */
  createItems(batch: readonly BatchItem[], options?: BatchOptions): Promise<BatchResult>;
  editItem(id: string, edit: ItemEdit, options?: EditOptions): Promise<WriteResult>;
  /** Several lines go in one commit. */
  appendLog(id: string, line: LineWrite | readonly LineWrite[]): Promise<WriteResult>;
  /** Fetches, puts own unshared commits on top, pushes. Never throws for a sharing problem: it is in the report. */
  share(): Promise<SharingReport>;
  /**
   * Takes the fetched history that sharing refused (at `refs/scopesoup-incoming/...`): saves the local
   * meta ref under `refs/scopesoup-backup/<time>`, makes the fetched commit the local, the fetched and
   * the shared state, puts this machine's own unshared commits on top of it by the usual rules, and
   * pushes. Lines the accepted history removed stay removed.
   */
  accept(): Promise<AcceptReport>;
  /** `item.md` and the versions put aside, on the local ref. */
  versions(id: string): Promise<ItemVersions>;
  lastSharing(): SharingReport | null;
  /** The format of the local meta ref (no fetch); null when there is no ref. */
  format(): Promise<MetaFormat | null>;
  /** Whether the ref is shared with a remote (a remote is configured and the repository has it). */
  shares(): Promise<boolean>;
  /**
   * Brings a meta ref of an older format to this Scope Soup's in one commit, on top of the remote's (fetched first),
   * and pushes it. The caller holds the merge queue lease (migrate.ts). Never throws for a sharing problem: it is in the result.
   */
  migrate(): Promise<MigrationResult>;
}

/** What `Writer.migrate` did. */
export type MigrationResult =
  /** Nothing to do: there is no meta ref, or it is this Scope Soup's format already. */
  | { state: "empty" | "current" }
  /** Read only here: the format is newer than this Scope Soup's, or its entry cannot be read. */
  | { state: "newer" | "unreadable"; why: string }
  /** Not done now: the ref could not be brought up to the remote's first, or it moved meanwhile. */
  | { state: "waiting"; why: string }
  /** The one migration commit was made; `sharing` says whether it is on the remote yet. */
  | { state: "migrated"; from: number; to: number; commit: string; sharing: SharingReport };

/** A refusal that is about the history, not about one write: it stops sharing until a person looks. */
class RefusedHistory extends Error {}

const REGULAR = new Set(["100644", "100755"]);

interface ReadState {
  commit: string | null;
  tree: Map<string, TreeEntry>;
  /** A regular file's text, or null when there is no such file. */
  text(path: string): Promise<string | null>;
}

interface Plan {
  /** The item written: every changed path must be in its directory. */
  id: string;
  /** A write of many items (`createItems`): every changed path must be in one of their directories. Their blobs are written with one process. */
  ids?: string[];
  message: string;
  changes: Map<string, PathChange>;
  /** A save of the settings: every changed path must be the settings' file or log. */
  settings?: true;
  /** The commit's author, when it is not the writer's person (the committer stays the writer's). */
  author?: Person;
}

const itemIds = (paths: Iterable<string>): Set<string> => new Set([...paths].map((path) => /^items\/([^/]+)(\/|$)/.exec(path)?.[1]).filter((id): id is string => id !== undefined));

/** The prefix of an id Scope Soup made (`A` of `A-12`), or null for an id of another shape. */
const prefixOf = (id: string): string | null => /^([A-Za-z][A-Za-z0-9]{0,15})-[0-9]+$/.exec(id)?.[1] ?? null;

export function createWriter(config: WriterConfig): Writer {
  const { git, network, ref, person, machine, now } = config;
  if (!isMetaRef(ref)) throw new Error(`The meta ref "${ref}" is not a ref name Scope Soup accepts.`);
  checkPerson(person);
  if (!/^[^\u0000-\u001f\u007f]{1,100}$/.test(machine) || machine !== machine.trim()) throw new Error(`The machine name "${machine}" must be 1 to 100 characters with no control characters and no white space around it.`);
  if (config.idPrefix !== undefined && !isIdPrefix(config.idPrefix)) throw new Error(`The id prefix "${config.idPrefix}" is not a letter followed by up to 15 letters or digits.`);
  const remote = config.remote;
  if (remote !== null && !isRemoteName(remote)) throw new Error(`"${remote}" is not a remote name Scope Soup accepts.`);
  const pushAttempts = config.pushAttempts ?? 5;
  const localAttempts = config.localAttempts ?? 5;
  const maxAppend = config.maxAppendLogBytes ?? MAX_APPEND_LOG_BYTES;
  const staleLockMs = config.staleLockMs ?? 10 * 60_000;
  // Scope Soup's own refs for the remote: what was last fetched and checked, and the last fetch as it came.
  const rest = ref.slice("refs/".length);
  const tracking = `refs/scopesoup-remote/${remote ?? "none"}/${rest}`;
  const incoming = `refs/scopesoup-incoming/${remote ?? "none"}/${rest}`;
  // The last commit of the local meta ref known to be on the remote: this machine's own unshared commits are the ones after it.
  const marker = `refs/scopesoup-local/shared/${remote ?? "none"}/${rest}`;
  // Every commit this machine makes says so; only such commits are ever put on top again.
  const trailer = `ScopeSoup-Machine: ${machine}`;
  const movedWindowMs = config.movedWindowMs ?? 60 * 60_000;
  const recheckMs = config.recheckMs ?? 10_000;
  let last: SharingReport | null = null;

  // One write or sharing round at a time in this process. Other processes are kept apart by update-ref's old value.
  let queue: Promise<unknown> = Promise.resolve();
  const before = config.before ?? (async () => undefined);
  let versionChecked: Promise<void> | null = null;
  let netEnv: Promise<Record<string, string>> | null = null;
  // Which branches are checked out, and whether the remote exists: asked again after a few seconds, not at every git step.
  let checkedOut: Promise<string[]> | null = null;
  let remoteThere: Promise<boolean> | null = null;
  let askedAt = 0;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const task = async (): Promise<T> => {
      if (Date.now() - askedAt > recheckMs) {
        checkedOut = null;
        remoteThere = null;
        askedAt = Date.now();
      }
      await before();
      versionChecked ??= checkGitVersion(git).catch((error: unknown) => {
        versionChecked = null;
        throw error;
      });
      await versionChecked;
      return work();
    };
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };
  const sshEnv = (): Promise<Record<string, string>> => (netEnv ??= networkEnvironment(git));

  /** Moves the meta ref, but never one that is checked out: that would leave a working copy behind its branch. */
  async function moveMeta(next: string, expected: string | null): Promise<boolean> {
    if ((await (checkedOut ??= checkedOutRefs(git))).includes(ref)) throw new Error(`${ref} is checked out in a working copy of this repository; Scope Soup does not move a branch under a working copy.`);
    return moveRef(git, ref, next, expected);
  }

  // The local ref's tip and its tree as this process last saw them, so a write does not ask for them
  // again. It can be stale (another process wrote): the ref is then moved only from the value
  // the write read, so a stale one makes `update-ref` refuse, the cache is dropped and the write is
  // done again from a fresh read.
  let tipCache: { commit: string; tree: Map<string, TreeEntry> } | null = null;
  // Texts of blobs this writer made, by blob id (content-addressed, so never stale), for the next edit of the same item.
  const textCache = new Map<string, string>();
  const rememberText = (blob: string, text: string): void => {
    if (text.length > MAX_FILE_BYTES) return;
    textCache.delete(blob);
    textCache.set(blob, text);
    if (textCache.size > 64) textCache.delete(textCache.keys().next().value as string);
  };

  // The format entry's reading, by its blob id (content-addressed, so never stale).
  const formats = new Map<string, MetaFormat>();
  /** The format of a tree read by `readTree`: one read of the entry's blob the first time it is seen, none for format 0. */
  async function formatAt(tree: ReadonlyMap<string, TreeEntry>): Promise<MetaFormat> {
    const entry = tree.get(FORMAT_FILE);
    if (!entry || entry.type !== "blob" || !REGULAR.has(entry.mode)) return readFormat(entry, null);
    const known = formats.get(entry.sha);
    if (known) return known;
    let text = textCache.get(entry.sha) ?? null;
    if (text === null) {
      try {
        text = (await readTexts(git, [entry.sha])).get(entry.sha) ?? null;
      } catch {
        text = null; // not UTF-8: it cannot be read
      }
    }
    const found = readFormat(entry, text);
    formats.set(entry.sha, found);
    return found;
  }

  /** The meta ref, what was last fetched from the remote's, and the last local commit known to be on the remote: one git call. */
  async function heads(withIncoming = false): Promise<Heads> {
    const refs = await readRefs(git, remote === null ? [ref] : withIncoming ? [ref, tracking, marker, incoming] : [ref, tracking, marker]);
    const local = refs.get(ref) ?? null;
    if (tipCache && tipCache.commit !== local) tipCache = null;
    return { local, seen: refs.get(tracking) ?? null, shared: refs.get(marker) ?? null, incoming: refs.get(incoming) ?? null };
  }

  /**
   * Records that `commit`, on the local ref, is on the remote. `shared` is the marker as the caller
   * just read it; without it the marker is read. A stale `shared` only makes the move refuse.
   */
  async function markShared(commit: string, known?: string | null): Promise<void> {
    if (remote === null) return;
    const shared = known === undefined ? (await heads()).shared : known;
    if (shared !== commit) await moveRef(git, marker, commit, shared);
  }

  /** Texts become blobs. The size limits apply to what one write adds (in the plan), never to a merge of existing history. */
  async function materialize(changes: Map<string, PathChange>): Promise<Map<string, TreeEntry | null>> {
    const out = new Map<string, TreeEntry | null>();
    for (const [path, change] of changes) {
      if (change !== null && "text" in change) {
        const blob = await writeBlob(git, change.text);
        out.set(path, { mode: "100644", type: "blob", sha: blob });
        rememberText(blob, change.text);
      } else out.set(path, change);
    }
    return out;
  }

  /** `materialize` with every text in one `fast-import`, for a write of many items. */
  async function materializeAll(changes: Map<string, PathChange>): Promise<Map<string, TreeEntry | null>> {
    const texts = [...changes].filter((entry): entry is [string, { text: string }] => entry[1] !== null && "text" in entry[1]);
    const blobs = await writeBlobs(git, texts.map(([, change]) => change.text));
    const made = new Map(texts.map(([path], index) => [path, blobs[index] as string]));
    const out = new Map<string, TreeEntry | null>();
    for (const [path, change] of changes) {
      const blob = made.get(path);
      out.set(path, blob === undefined ? (change as TreeEntry | null) : { mode: "100644", type: "blob", sha: blob });
    }
    return out;
  }

  /** A dry run of a write: the plan on a fresh read of the ref, and nothing written. */
  async function planOnly(plan: (state: ReadState) => Promise<Plan>): Promise<{ commit: string | null; plan: Plan }> {
    const parent = (await heads()).local;
    const tree = await readTree(git, parent);
    const refused = writeProblem(await formatAt(tree));
    if (refused) throw new RefusedWrite(refused);
    const state: ReadState = {
      commit: parent,
      tree,
      async text(path) {
        const entry = tree.get(path);
        if (!entry) return null;
        if (entry.type !== "blob" || !REGULAR.has(entry.mode)) throw new RefusedWrite(`${path} is not a regular file; Scope Soup will not write it.`);
        return (await readTexts(git, [entry.sha])).get(entry.sha) ?? null;
      },
    };
    return { commit: parent, plan: await plan(state) };
  }

  /** One write: read the ref, plan, commit, move the ref from where it was read. Done again when another writer was first. */
  async function commitWrite(plan: (state: ReadState) => Promise<Plan>): Promise<{ id: string; commit: string | null; changed: boolean; tree: Map<string, TreeEntry> }> {
    for (let attempt = 1; attempt <= localAttempts; attempt++) {
      let parent: string | null;
      let tree: Map<string, TreeEntry>;
      const fromCache = attempt === 1 && tipCache !== null;
      if (tipCache && fromCache) ({ commit: parent, tree } = tipCache);
      else {
        tipCache = null;
        parent = (await heads()).local;
        tree = await readTree(git, parent);
        if (parent) tipCache = { commit: parent, tree };
      }
      const here = tree;
      const state: ReadState = {
        commit: parent,
        tree,
        async text(path) {
          const entry = here.get(path);
          if (!entry) return null;
          if (entry.type !== "blob" || !REGULAR.has(entry.mode)) throw new RefusedWrite(`${path} is not a regular file; Scope Soup will not write it.`);
          const known = textCache.get(entry.sha);
          if (known !== undefined) return known;
          const text = (await readTexts(git, [entry.sha])).get(entry.sha) ?? null;
          if (text !== null) rememberText(entry.sha, text);
          return text;
        },
      };
      // An answer of "no" or "nothing to change" must not rest on a remembered tip: it is checked against a fresh read.
      let planned: Plan;
      try {
        // A newer format (or one that cannot be read) is read only; an older one waits for its migration unless it may be written as it is.
        const refused = writeProblem(await formatAt(tree));
        if (refused) throw new RefusedWrite(refused);
        planned = await plan(state);
      } catch (error) {
        if (!fromCache) throw error;
        tipCache = null;
        continue;
      }
      const id = planned.id;
      if (planned.changes.size === 0) {
        if (!fromCache) return { id, commit: parent, changed: false, tree };
        tipCache = null;
        continue;
      }
      // Nothing from a title or an id gets out of the item's own directory; a save of the settings changes only their files.
      const allowed = new Set(planned.ids ?? [id]);
      for (const path of planned.changes.keys()) {
        if (planned.settings) {
          if (!isSettingsPath(path)) throw new Error(`A save of the settings tried to change ${path}; nothing was written.`);
          continue;
        }
        const owner = itemPath(path)?.id;
        if (owner === undefined || !isItemId(owner) || !allowed.has(owner)) throw new Error(`A write for ${planned.ids ? `${planned.ids.length} items` : id} tried to change ${path}; nothing was written.`);
      }
      // A new meta branch starts at this Scope Soup's format. (Put on top of an existing history, `replay` leaves the entry out.)
      if (parent === null) planned.changes.set(FORMAT_FILE, { text: formatText(META_FORMAT) });
      const changes = planned.ids ? await materializeAll(planned.changes) : await materialize(planned.changes);
      const date = gitDate(now());
      const made = await writeTreeEntries(git, tree, changes);
      const commit = await writeCommit(git, {
        tree: made.id,
        parents: parent ? [parent] : [],
        // The trailer says which machine made the commit: only such commits are ever put on top again.
        message: `${planned.message.trimEnd()}\n\n${trailer}\n`,
        author: planned.author ?? person,
        authorDate: date,
        committer: person,
        committerDate: date,
      });
      if (await moveMeta(commit, parent)) {
        tipCache = { commit, tree: made.tree };
        return { id, commit, changed: true, tree: made.tree };
      }
      tipCache = null;
    }
    throw new Error(`${ref} was moved by another writer on each of ${localAttempts} tries; nothing was written.`);
  }

  const asideFiles = (tree: Map<string, TreeEntry>, id: string): string[] => [...tree.keys()].filter((path) => itemPath(path)?.id === id && itemPath(path)?.file === "conflict");

  const exists = (tree: Map<string, TreeEntry>, id: string): boolean => tree.has(`items/${id}/item.md`) || tree.has(`items/${id}/log.jsonl`);

  function checkId(id: string): void {
    if (typeof id !== "string" || !isItemId(id)) throw new RefusedWrite(`${JSON.stringify(id)} is not an item id: a letter or digit, then letters, digits, - or _.`);
  }

  // --- this repository's git directory: lock files and the record of moved ids ---

  let gitDirPath: Promise<string> | null = null;
  const gitDir = (): Promise<string> =>
    (gitDirPath ??= commonDir(git).then((dir) => (isAbsolute(dir) ? dir : resolve(config.repoDir ?? ".", dir))));

  interface Moved {
    from: string;
    to: string;
    at: string;
    ref: string;
  }

  /** The ids this machine's new items were moved away from, kept in `<git dir>/scopesoup/moved-ids.json` so a later round still knows. */
  async function movedIds(): Promise<Moved[]> {
    const file = join(await gitDir(), "scopesoup", "moved-ids.json");
    if (!existsSync(file)) return [];
    try {
      const list = JSON.parse(readFileSync(file, "utf8")) as Moved[];
      return Array.isArray(list) ? list.filter((entry) => entry.ref === ref && isItemId(entry.from) && isItemId(entry.to)) : [];
    } catch {
      return [];
    }
  }

  async function recordMoved(moves: { from: string; to: string }[]): Promise<void> {
    if (moves.length === 0) return;
    const dir = join(await gitDir(), "scopesoup");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "moved-ids.json");
    let list: Moved[] = [];
    try {
      list = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Moved[]) : [];
    } catch {
      list = [];
    }
    const at = now();
    writeFileSync(file, `${JSON.stringify([...list, ...moves.map((move) => ({ ...move, at, ref }))], null, 1)}\n`);
  }

  /**
   * A write from this machine to an id its own new item was moved away from (in the last
   * `movedWindowMs`) is refused, naming the new id: the caller may still hold the old one from an
   * outcome it got before, and the old id is now another machine's item.
   */
  async function refuseMovedId(id: string): Promise<void> {
    const recent = (await movedIds()).filter((entry) => entry.from === id && Date.parse(now()) - Date.parse(entry.at) < movedWindowMs).pop();
    if (recent) throw new RefusedWrite(`${id} is another machine's item now: this machine's ${id} was moved to ${recent.to} at ${recent.at}, when both machines had made an item ${id}. Write to ${recent.to}.`);
  }

  // --- sharing ---

  const newReport = (): SharingReport => ({ at: now(), state: "local", pushes: 0, refusedPushes: 0, replayed: 0, conflicts: [], renamed: [], locks: [] });

  async function sharing(): Promise<boolean> {
    if (remote === null) return false;
    return (remoteThere ??= hasRemote(git, remote));
  }

  /**
   * Lock files of Scope Soup's refs that a git ended mid-update left behind. Scope Soup's own scratch refs
   * (`refs/scopesoup-remote/...`, `refs/scopesoup-incoming/...`) are unlocked here; the meta ref's lock
   * and `packed-refs.lock` are only reported: they are the repository's, and a person removes them.
   * The check and the removal are not one step: another Scope Soup process on the same repository could
   * take the lock in between. That is accepted: the lock is older than any git call may run, so no
   * git of ours still holds it, and the worst case is that one fetch of the other process fails and
   * is tried again.
   */
  async function staleLocks(report: SharingReport): Promise<void> {
    const base = await gitDir();
    const at = Date.now();
    const old = (path: string): boolean => existsSync(path) && at - statSync(path).mtimeMs > staleLockMs;
    for (const own of [tracking, incoming, marker]) {
      const lock = join(base, `${own}.lock`);
      if (!old(lock)) continue;
      unlinkSync(lock);
      report.locks.push(`removed ${lock}, left behind by a git that was ended`);
    }
    for (const lock of [join(base, `${ref}.lock`), join(base, "packed-refs.lock")]) {
      if (!old(lock)) continue;
      report.locks.push(`${lock} was left behind by a git that was ended and blocks every write to ${ref}. If no git is running in this repository, delete that file.`);
    }
  }

  /** The texts of these blobs, for the lost-line checks. */
  async function textsOf(shas: (string | null | undefined)[]): Promise<Map<string, string>> {
    return readTexts(git, shas.filter((sha): sha is string => typeof sha === "string"));
  }

  const howToAccept = `the fetched commit is at ${incoming}; docs/RUNNING.md says how to look at it and accept it`;

  /**
   * Checks a fetched history before taking it: linear (first parents, no merge commit), and no
   * commit along it removes or changes a log line its parent had. Each step is checked, not only
   * the ends, so a line removed and then written again differently is seen.
   */
  async function checkFetched(seen: string, got: string): Promise<void> {
    if (!(await isAncestor(git, seen, got))) {
      throw new RefusedHistory(`The remote's ${ref} was rewritten: it no longer contains ${seen.slice(0, 12)}, which this machine fetched before. Scope Soup keeps its own copy, does not push, and waits for a person (${howToAccept}).`);
    }
    if (await hasMerges(git, seen, got)) {
      throw new RefusedHistory(`The remote's ${ref} has a merge commit since ${seen.slice(0, 12)}; Scope Soup keeps the meta history linear and does not take it (${howToAccept}).`);
    }
    const steps: { commit: string; path: string; from: string; to: string | null }[] = [];
    // The history is linear (no merge, checked above), so each commit's first parent is the one before it.
    for (const { commit, changes } of await changesSince(git, seen, got)) {
      for (const change of changes) {
        if (isLogFile(change.path) && change.from) steps.push({ commit, path: change.path, from: change.from, to: change.to });
      }
    }
    const texts = await textsOf(steps.flatMap((step) => [step.from, step.to]));
    for (const step of steps) {
      const lost = lostLines(texts.get(step.from) ?? "", step.to ? (texts.get(step.to) ?? "") : "");
      if (lost.length > 0) {
        throw new RefusedHistory(`The remote's ${ref} removed or changed log lines in commit ${step.commit.slice(0, 12)} (${step.path}, the first: ${lost[0]?.slice(0, 120)}). Scope Soup keeps its own copy, does not push, and waits for a person (${howToAccept}).`);
      }
    }
  }

  /**
   * Fetches the remote's ref when it moved (`there`, from ls-remote, when the caller already asked),
   * and takes it only when `checkFetched` passes. With nothing fetched before, any history is taken
   * as the remote's: there is nothing this machine saw there to lose, and what is put on top of it is
   * decided by `ownUnshared`, which never guesses.
   */
  async function fetchRemote(there?: string | null): Promise<Heads | null> {
    if (remote === null) return null;
    const env = await sshEnv();
    const now = there === undefined ? await remoteRef(network, remote, ref, env) : there;
    const before = await heads();
    const { seen } = before;
    if (now === null || now === seen) return before;
    await fetchRef(network, remote, ref, incoming, env);
    const after = await heads(true);
    const got = after.incoming;
    if (!got) throw new Error(`git fetch did not give ${incoming}`);
    if (seen) await checkFetched(seen, got);
    // false: another process here did the same fetch, so the caller reads the refs again.
    return (await moveRef(git, tracking, got, seen)) ? { ...after, seen: got } : null;
  }

  const madeHere = (message: string): boolean => message.split("\n").some((line) => line === trailer);

  /**
   * This machine's own unshared commits: the first-parent line from the marker (the last local
   * commit known to be on the remote) to the local tip, every one carrying this machine's trailer.
   * With no marker (nothing shared from here yet), the whole local line, and then every commit must
   * be this machine's: a history of others' commits that the remote does not have is not guessed at.
   */
  async function ownUnshared(local: string, shared: string | null): Promise<{ commits: { id: string; info: CommitInfo }[]; foreign: string[] }> {
    if (shared !== null && !(await isAncestor(git, shared, local))) {
      throw new RefusedHistory(`${ref} no longer contains ${shared.slice(0, 12)}, the last commit this machine knows to be on the remote: the local ref was moved by hand. Scope Soup does not guess which commits are its own; nothing was pushed.`);
    }
    const commits: { id: string; info: CommitInfo }[] = [];
    const foreign: string[] = [];
    const ids = await commitsSince(git, shared, local);
    const infos = await readCommits(git, ids);
    for (const id of ids) {
      const info = infos.get(id) as CommitInfo;
      if (madeHere(info.message)) commits.push({ id, info });
      else foreign.push(id);
    }
    return { commits, foreign };
  }

  /** Every line this machine's own commits (since `base`) added to a log is in `tip`, under the item's id there. */
  async function ownLinesKept(base: string | null, local: string, tip: string, renames: ReadonlyMap<string, string>): Promise<string | null> {
    let localFiles = filesOf(await readTree(git, local));
    let baseFiles = base ? filesOf(await readTree(git, base)) : new Map<string, TreeEntry>();
    const tipFiles = filesOf(await readTree(git, tip));
    // A moved item's lines are looked for under its new id.
    for (const [from, to] of renames) {
      localFiles = moveItemPaths(localFiles, from, to);
      baseFiles = moveItemPaths(baseFiles, from, to);
    }
    const logs = [...localFiles].filter(([path, entry]) => isLogFile(path) && baseFiles.get(path)?.sha !== entry.sha);
    const texts = await textsOf(logs.flatMap(([path, entry]) => [entry.sha, baseFiles.get(path)?.sha, tipFiles.get(path)?.sha]));
    for (const [path, entry] of logs) {
      const own = addedLines(texts.get(baseFiles.get(path)?.sha ?? "") ?? "", texts.get(entry.sha) ?? "");
      const there = new Set(logLines(texts.get(tipFiles.get(path)?.sha ?? "") ?? ""));
      const lost = own.filter((line) => !there.has(line));
      if (lost.length > 0) return `${path} would lose ${lost.length} of this machine's lines, the first: ${lost[0]?.slice(0, 120)}`;
    }
    return null;
  }

  /**
   * Puts this machine's own unshared commits on top of `onto`, one by one, by the merge rules.
   * An item created in those commits whose id `onto` already has (another machine made an item
   * with the same id) is created under the next free id instead: its files move, and the `id:`,
   * `parent:` and `blockedBy:` header lines of this machine's own new items follow the move. Log
   * lines move as they are, byte for byte. Only an item whose create is among these commits may
   * move: an item that existed at `shared` never does.
   */
  async function replay(onto: string, shared: string | null, own: { id: string; info: CommitInfo }[], local: string): Promise<{ tip: string; replayed: number; conflicts: string[]; renamed: { from: string; to: string }[] }> {
    const trees = new Map<string, Map<string, TreeEntry>>();
    const treeOf = async (commit: string | null): Promise<Map<string, TreeEntry>> => {
      if (commit === null) return new Map();
      const known = trees.get(commit);
      if (known) return known;
      const tree = await readTree(git, commit);
      trees.set(commit, tree);
      return tree;
    };
    const before = itemIds((await treeOf(shared)).keys());
    const ontoIds = itemIds((await treeOf(onto)).keys());
    const localIds = itemIds((await treeOf(local)).keys());
    // The items this machine created since it last shared, and those of them whose id the other side has.
    const created = [...localIds].filter((id) => !before.has(id)).sort();
    const moves = new Map<string, string>();
    const taken = new Set([...ontoIds, ...localIds]);
    for (const id of created) {
      if (!ontoIds.has(id)) continue;
      if (before.has(id)) throw new Error(`refusing to move ${id}: it existed before this machine's unshared commits`);
      const prefix = prefixOf(id);
      if (!prefix) throw new RefusedHistory(`This machine created ${id}, and the other side has an item ${id} too; it is not an id Scope Soup can number again. Nothing was pushed.`);
      const to = allocateId(prefix, taken);
      taken.add(to);
      moves.set(id, to);
    }
    // This machine's own new items, under the ids they will have.
    const ownNew = new Set(created.map((id) => moves.get(id) ?? id));
    const rewritten = new Map<string, string>();
    const translate = async (files: Files): Promise<Files> => {
      if (moves.size === 0) return files;
      let out = new Map(files);
      for (const [from, to] of moves) out = moveItemPaths(out, from, to);
      const headers = [...out].filter(([path, entry]) => {
        const id = itemPath(path);
        return id?.file === "item.md" && ownNew.has(id.id) && entry.type === "blob";
      });
      // One read for every item.md not rewritten yet.
      const texts = await readTexts(git, headers.map(([, entry]) => entry.sha).filter((sha) => !rewritten.has(sha)));
      for (const [path, entry] of headers) {
        let sha = rewritten.get(entry.sha);
        if (sha === undefined) {
          const text = texts.get(entry.sha) ?? "";
          const next = renameInHeader(text, moves);
          sha = next === text ? entry.sha : await writeBlob(git, next);
          rewritten.set(entry.sha, sha);
        }
        out.set(path, { ...entry, sha });
      }
      return out;
    };
    // Nothing of this machine's goes on top of a format this Scope Soup does not write (newer, or unreadable).
    if (own.length > 0) {
      const refused = writeProblem(await formatAt(await treeOf(onto)));
      if (refused) throw new RefusedHistory(`The remote's ${ref} cannot take this machine's ${own.length} unshared commit(s); they stay here and are not pushed. ${refused}`);
    }
    let tip = onto;
    const conflicts: string[] = [];
    let replayed = 0;
    for (const { id: commit, info } of own) {
      const base = await translate(filesOf(await treeOf(info.parents[0] ?? null)));
      let ours = await translate(filesOf(await treeOf(commit)));
      // A first commit's format entry was for a new branch. On top of another history it is left out: only the
      // migration, by the machine that holds the merge queue lease, changes the format of a shared branch.
      if (info.parents.length === 0 && ours.has(FORMAT_FILE)) {
        const without = new Map(ours);
        without.delete(FORMAT_FILE);
        ours = without;
      }
      const tipTree = await treeOf(tip);
      const theirs = filesOf(tipTree);
      let message = info.message;
      for (const [from, to] of moves) if (message.startsWith(`${from}:`)) message = `${to}:${message.slice(from.length + 1)}`;
      const needed: string[] = [];
      for (const [path, entry] of ours) {
        if (!(isLogFile(path) || path === SETTINGS_FILE) || base.get(path)?.sha === entry.sha) continue;
        for (const side of [base, ours, theirs]) {
          const sha = side.get(path)?.sha;
          if (sha) needed.push(sha);
        }
      }
      const texts = await readTexts(git, needed);
      const merged = mergeTrees(base, ours, theirs, (sha) => texts.get(sha) ?? "");
      if (merged.problems.length > 0) throw new RefusedHistory(`This machine's commit ${commit.slice(0, 12)} cannot be put on top of the remote's: ${merged.problems.join("; ")}. Nothing was pushed.`);
      if (merged.changes.size === 0) continue;
      tip = await writeCommit(git, {
        tree: await writeTree(git, tipTree, await materialize(merged.changes)),
        parents: [tip],
        message,
        author: info.author,
        authorDate: info.authorDate,
        committer: person,
        committerDate: gitDate(now()),
      });
      replayed++;
      conflicts.push(...merged.conflicts);
    }
    // Never lose anything: every line this machine's own commits wrote is still there.
    const lost = await ownLinesKept(shared, local, tip, moves);
    if (lost) throw new RefusedHistory(`Putting this machine's commits on top of the remote's would lose log lines (${lost}). Nothing was changed.`);
    return { tip, replayed, conflicts, renamed: [...moves].map(([from, to]) => ({ from, to })) };
  }

  function note(report: SharingReport, done: { replayed: number; conflicts: string[]; renamed: { from: string; to: string }[] }): void {
    report.replayed += done.replayed;
    for (const id of done.conflicts) if (!report.conflicts.includes(id)) report.conflicts.push(id);
    report.renamed.push(...done.renamed);
  }

  /**
   * Brings the local ref up to the fetched one: a fast-forward, or this machine's own unshared
   * commits put again on top (`ownUnshared`, `replay`).
   */
  async function integrate(report: SharingReport, known?: Heads | null): Promise<void> {
    // `known`: the refs as `fetchRemote` just left them, so they are not read again.
    const { local, seen, shared } = known ?? (await heads());
    if (!seen) return;
    if (!local) {
      // Nothing here yet: take the remote's history as it is.
      if (!(await moveMeta(seen, null))) throw new Error(`${ref} moved while it was being brought up to the remote; try again.`);
      await markShared(seen, shared);
      return;
    }
    const stand = await relation(git, local, seen);
    if (stand === "same" || stand === "behind") {
      if (stand === "behind" && !(await moveMeta(seen, local))) throw new Error(`${ref} moved while it was being brought up to the remote; try again.`);
      await markShared(seen, shared);
      return;
    }
    if (stand === "ahead") return;
    if (shared !== null && !(await isAncestor(git, shared, seen))) {
      throw new RefusedHistory(`The remote's ${ref} does not contain ${shared.slice(0, 12)}, the last commit this machine shared: it was rewritten, or the remote is another one. Scope Soup keeps its own copy, does not push, and waits for a person (${howToAccept}).`);
    }
    const own = await ownUnshared(local, shared);
    if (own.foreign.length > 0) {
      throw new RefusedHistory(
        shared === null
          ? `${ref} here has commits this machine did not make (${own.foreign.length}, the first ${own.foreign[0]?.slice(0, 12)}), and nothing was shared from here before: the two histories are unrelated, and Scope Soup does not guess which commits are its own. Nothing was pushed.`
          : `${ref} has ${own.foreign.length} unshared commit(s) this machine did not make (the first ${own.foreign[0]?.slice(0, 12)}); Scope Soup puts only its own commits on top again. Nothing was pushed.`,
      );
    }
    const done = await replay(seen, shared, own.commits, local);
    if (!(await moveMeta(done.tip, local))) throw new Error(`${ref} moved while this machine's commits were put on top of the remote's; try again.`);
    await markShared(seen, shared);
    await recordMoved(done.renamed);
    note(report, done);
  }

  /** Pushes the local ref, fast-forward only. A refusal because the remote moved: fetch, put own commits on top, push again, a bounded number of times. */
  async function push(report: SharingReport): Promise<void> {
    if (remote === null) return;
    const env = await sshEnv();
    for (;;) {
      let { local, seen, shared } = await heads();
      if (local && seen && local !== seen && (await relation(git, local, seen)) !== "ahead") {
        await integrate(report, { local, seen, shared, incoming: null });
        ({ local, seen, shared } = await heads());
      }
      if (!local || local === seen) {
        if (local) await markShared(local, shared);
        report.state = "shared";
        return;
      }
      if (report.pushes >= pushAttempts) {
        report.state = "pending";
        report.problem = `The remote refused ${report.refusedPushes} push(es) because it kept moving; gave up after ${pushAttempts}. The commits stay here and go with the next push.`;
        return;
      }
      report.pushes++;
      const pushed = await pushRef(network, remote, local, ref, env);
      if (pushed.ok) {
        await moveRef(git, tracking, local, seen);
        await markShared(local, shared);
        report.state = "shared";
        return;
      }
      // Refused because someone else was first, or for another reason (a hook, the network, rights)?
      const there = await remoteRef(network, remote, ref, env);
      if (there === seen || there === null) {
        report.state = "pending";
        report.problem = `git push to ${remote} failed, and not because the remote moved: ${pushed.message}`;
        return;
      }
      report.refusedPushes++;
      await integrate(report, await fetchRemote(there));
    }
  }

  async function shareNow(fetchFirst: boolean): Promise<SharingReport> {
    const report = newReport();
    try {
      if (!(await sharing())) return (last = report);
      report.state = "pending";
      await staleLocks(report);
      if (fetchFirst) {
        await integrate(report, await fetchRemote());
      }
      await push(report);
    } catch (error) {
      report.state = "pending";
      report.problem = error instanceof Error ? error.message : String(error);
    }
    const blocking = report.locks.filter((lock) => !lock.startsWith("removed "));
    if (blocking.length > 0) report.problem = [report.problem, ...blocking].filter(Boolean).join(" ");
    return (last = report);
  }

  async function write(plan: (state: ReadState) => Promise<Plan>): Promise<WriteResult> {
    const done = await commitWrite(plan);
    // A write that changed nothing still pushes what an earlier round left behind.
    const sharing = await shareNow(false);
    const moved = sharing.renamed.find((rename) => rename.from === done.id);
    const id = moved?.to ?? done.id;
    // The tree this write made is still the ref's when sharing did not move the ref (heads() in sharing drops the cache if it did): no read.
    let conflict: boolean;
    if (!moved && done.commit !== null && tipCache?.commit === done.commit) conflict = asideFiles(done.tree, id).length > 0;
    else {
      const head = (await heads()).local;
      conflict = head !== null && (await itemFileNames(git, head, id)).some((name) => itemPath(`items/${id}/${name}`)?.file === "conflict");
    }
    return { id, commit: done.commit, changed: done.changed, conflict, sharing, ...(moved ? { movedFrom: moved.from } : {}) };
  }

  /** Takes the fetched history that was refused: see `Writer.accept`. */
  async function acceptIncoming(): Promise<AcceptReport> {
    if (remote === null) throw new Error("There is no remote, so there is nothing fetched to accept.");
    const got = (await readRefs(git, [incoming])).get(incoming) ?? null;
    if (!got) throw new Error(`There is nothing fetched to accept: ${incoming} does not exist.`);
    const { local, seen, shared } = await heads();
    const report: AcceptReport = { accepted: got, backup: null, replayed: 0, notReplayed: [], renamed: [], conflicts: [], sharing: newReport() };
    let own: { id: string; info: CommitInfo }[] = [];
    if (local) {
      const stamp = now().replace(/[-:.]/g, "");
      report.backup = `refs/scopesoup-backup/${stamp}`;
      if (!(await moveRef(git, report.backup, local, null))) throw new Error(`${report.backup} exists already; try again.`);
      // Only this machine's own unshared commits are kept. If the marker is not on the local line any more, there is nothing known to be own.
      const found = shared === null || (await isAncestor(git, shared, local)) ? await ownUnshared(local, shared) : { commits: [], foreign: [] };
      own = found.commits;
      report.notReplayed = found.foreign;
    }
    // The accepted history becomes what the remote has and what this machine has shared...
    const done = local ? await replay(got, shared, own, local) : { tip: got, replayed: 0, conflicts: [], renamed: [] };
    if (!(await moveMeta(done.tip, local))) throw new Error(`${ref} moved while the fetched history was being accepted; nothing was changed but the backup.`);
    tipCache = null;
    await moveRef(git, tracking, got, seen);
    await moveRef(git, marker, got, shared);
    await recordMoved(done.renamed);
    report.replayed = done.replayed;
    report.renamed = done.renamed;
    report.conflicts = done.conflicts;
    // ...and this machine's own commits on top of it are pushed.
    report.sharing = await shareNow(false);
    return report;
  }

  /** See `Writer.migrate`. */
  async function migrateNow(): Promise<MigrationResult> {
    // On top of what the others have: fetch and share first. A problem with that leaves the migration for later.
    if (await sharing()) {
      const first = await shareNow(true);
      if (first.state !== "shared") return { state: "waiting", why: `${ref} could not be brought up to the remote's first: ${first.problem ?? "the remote kept moving"}` };
    }
    const parent = (await heads()).local;
    if (parent === null) return { state: "empty" };
    const tree = await readTree(git, parent);
    const found = await formatAt(tree);
    if (!found.ok) return { state: "unreadable", why: writeProblem(found) as string };
    if (found.format > META_FORMAT) return { state: "newer", why: writeProblem(found) as string };
    if (found.format === META_FORMAT) return { state: "current" };
    const steps = await migrationChanges(found.format, filesOf(tree), async (sha) => textCache.get(sha) ?? (await readTexts(git, [sha])).get(sha) ?? null);
    const made = await writeTreeEntries(git, tree, await materialize(steps.changes));
    const date = gitDate(now());
    const commit = await writeCommit(git, {
      tree: made.id,
      parents: [parent],
      message: `Meta branch format ${found.format} to ${META_FORMAT}\n\n${steps.notes.join("\n")}\n\n${trailer}\n`,
      author: person,
      authorDate: date,
      committer: person,
      committerDate: date,
    });
    if (!(await moveMeta(commit, parent))) {
      tipCache = null;
      return { state: "waiting", why: `${ref} was moved by another writer while the migration was made; it is tried again` };
    }
    tipCache = { commit, tree: made.tree };
    return { state: "migrated", from: found.format, to: META_FORMAT, commit, sharing: await shareNow(false) };
  }

  return {
    writeSettings(update, by) {
      return serial(async () => {
        const at = now();
        const author: Person = { name: by.who, email: by.email ?? person.email };
        try {
          checkPerson(author);
        } catch (error) {
          throw new RefusedWrite(error instanceof Error ? error.message : String(error));
        }
        let made: SettingChange[] = [];
        const done = await commitWrite(async (state) => {
          const current = await state.text(SETTINGS_FILE);
          const next = update(current);
          made = [];
          if (next === null || next.text === current) return { id: "settings", settings: true, message: "", changes: new Map() };
          const line = serializeLogLine({ at, by: { who: by.who, machine, agent: false }, kind: "settings", fields: { changes: next.changes } });
          const old = (await state.text(SETTINGS_LOG)) ?? "";
          const log = appendLines(old, [line]);
          if (Buffer.byteLength(log, "utf8") > Math.min(maxAppend, MAX_FILE_BYTES)) throw new RefusedWrite(`The settings' log would be over ${Math.min(maxAppend, MAX_FILE_BYTES)} bytes; nothing more is saved.`);
          made = next.changes;
          const keys = [...new Set(next.changes.map((change) => change.key))];
          return {
            id: "settings",
            settings: true,
            author,
            message: `Settings: ${keys.join(", ").slice(0, 200)}\n\nSaved by ${by.who} on ${machine}.`,
            changes: new Map<string, PathChange>([[SETTINGS_FILE, { text: next.text }], [SETTINGS_LOG, { text: log }]]),
          };
        });
        const sharing = await shareNow(false);
        return { commit: done.commit, changed: done.changed, changes: done.changed ? made : [], sharing };
      });
    },

    createItem(input, lines = []) {
      const prefix = config.idPrefix;
      if (prefix === undefined) return Promise.reject(new RefusedWrite("No id prefix is configured for this machine: items cannot be created here."));
      let fields: ItemFields;
      try {
        fields = canonicalItem(input);
      } catch (error) {
        return Promise.reject(error);
      }
      // The id comes from what the ref holds at each try, so a writer that lost the race takes the next number.
      return serial(() =>
        write(async (state) => {
          const id = allocateId(prefix, itemIds(state.tree.keys()));
          if ([...state.tree.keys()].some((path) => path === `items/${id}` || path.startsWith(`items/${id}/`))) throw new Error(`${id} is taken on ${ref}; no item was created.`);
          const changes = new Map<string, PathChange>([[`items/${id}/item.md`, { text: serializeItem(id, fields) }]]);
          if (lines.length > 0) {
            const texts = lines.map((line) => serializeLogLine({ at: now(), by: { who: line.by.who, machine, agent: line.by.agent }, kind: line.kind, ...(line.fields ? { fields: line.fields } : {}) }));
            const log = appendLines("", texts);
            if (Buffer.byteLength(log, "utf8") > Math.min(maxAppend, MAX_FILE_BYTES)) throw new RefusedWrite("The first log lines of a new item are too large.");
            changes.set(`items/${id}/log.jsonl`, { text: log });
          }
          return { id, message: `${id}: create`, changes };
        }),
      );
    },

    createItems(batch, options = {}) {
      const prefix = config.idPrefix;
      if (prefix === undefined) return Promise.reject(new RefusedWrite("No id prefix is configured for this machine: items cannot be created here."));
      const keys = new Set<string>();
      for (const item of batch) {
        if (keys.has(item.key)) return Promise.reject(new RefusedWrite(`The key ${JSON.stringify(item.key)} is twice in the batch.`));
        keys.add(item.key);
        if (item.unique && (!/^[A-Za-z][A-Za-z0-9]*$/.test(item.unique[0]) || item.unique[1].trim() === "")) {
          return Promise.reject(new RefusedWrite(`${JSON.stringify(item.unique[0])} with ${JSON.stringify(item.unique[1])} cannot name an item.`));
        }
      }
      const uniqueName = (key: string, value: string): string => `${key}\n${value.trim().toLowerCase()}`;
      let planned = new Map<string, { id: string; created: boolean }>();
      const plan = async (state: ReadState): Promise<Plan> => {
        // The items on the ref that already carry a batch item's `unique` value: one read of every item.md.
        const found = new Map<string, string>();
        if (batch.some((item) => item.unique)) {
          const headers = [...state.tree].filter(([path, entry]) => itemPath(path)?.file === "item.md" && entry.type === "blob" && REGULAR.has(entry.mode));
          const texts = await readTexts(git, headers.map(([, entry]) => entry.sha));
          for (const [path, entry] of headers) {
            const id = itemPath(path)?.id as string;
            const parsed = parseItem(texts.get(entry.sha) ?? "", id);
            if (!parsed.ok) continue;
            for (const [key, value] of parsed.fields.extra) {
              const name = uniqueName(key, value);
              const had = found.get(name);
              // The lowest id wins when two items carry the same value, so the answer does not hang on the order of the read.
              if (had === undefined || id < had) found.set(name, id);
            }
          }
        }
        const items = new Map<string, { id: string; created: boolean }>();
        const taken = itemIds(state.tree.keys());
        for (const item of batch) {
          const there = item.unique ? found.get(uniqueName(item.unique[0], item.unique[1])) : undefined;
          if (there !== undefined) {
            items.set(item.key, { id: there, created: false });
            continue;
          }
          const id = allocateId(prefix, taken);
          taken.add(id);
          items.set(item.key, { id, created: true });
        }
        const idOf = (key: string): string | undefined => items.get(key)?.id;
        const at = now();
        const changes = new Map<string, PathChange>();
        for (const item of batch) {
          const { id, created } = items.get(item.key) as { id: string; created: boolean };
          if (!created) continue;
          const made = item.make(idOf);
          const extra = [...(made.input.extra ?? [])];
          const unique = item.unique;
          if (unique && !extra.some(([key]) => key === unique[0])) extra.push([unique[0], unique[1].trim()]);
          changes.set(`items/${id}/item.md`, { text: serializeItem(id, canonicalItem({ ...made.input, extra })) });
          if (made.lines && made.lines.length > 0) {
            const log = appendLines("", made.lines.map((line) => serializeLogLine({ at, by: { who: line.by.who, machine, agent: line.by.agent }, kind: line.kind, ...(line.fields ? { fields: line.fields } : {}) })));
            if (Buffer.byteLength(log, "utf8") > Math.min(maxAppend, MAX_FILE_BYTES)) throw new RefusedWrite(`The first log lines of ${id} are too large.`);
            changes.set(`items/${id}/log.jsonl`, { text: log });
          }
        }
        planned = items;
        const ids = [...items.values()].filter((item) => item.created).map((item) => item.id);
        const title = options.message?.trim() || `Create ${ids.length} item${ids.length === 1 ? "" : "s"}`;
        return { id: ids[0] ?? "batch", ids, message: `${title}\n\n${ids.length > 0 ? `Items: ${ids.join(", ")}` : "No new items."}`, changes };
      };
      if (options.dryRun) {
        return serial(async () => {
          const { commit } = await planOnly(plan);
          return { items: planned, commit, changed: false, sharing: null };
        });
      }
      return serial(async () => {
        const done = await commitWrite(plan);
        const sharing = await shareNow(false);
        // An item this batch made whose id another machine had taken meanwhile moved while it was shared.
        const moves = new Map(sharing.renamed.map((rename) => [rename.from, rename.to]));
        const items = new Map([...planned].map(([key, item]) => [key, item.created && moves.has(item.id) ? { ...item, id: moves.get(item.id) as string } : item]));
        return { items, commit: done.commit, changed: done.changed, sharing };
      });
    },

    editItem(id, edit, options = {}) {
      return serial(async () => {
        checkId(id);
        await refuseMovedId(id);
        const supersedes = new Set(options.resolveConflict?.supersedes ?? []);
        if (options.resolveConflict && supersedes.size === 0) throw new RefusedWrite("A resolution must name the versions put aside that it settles (their blob ids, as versions() gives them).");
        return write(async (state) => {
          const path = `items/${id}/item.md`;
          const current = await state.text(path);
          if (!exists(state.tree, id)) throw new RefusedWrite(`There is no item ${id}.`);
          const aside = asideFiles(state.tree, id);
          if (aside.length > 0 && !options.resolveConflict) {
            throw new RefusedWrite(`${id} is in conflict: item.md was changed on two machines and the other version is kept beside it. Resolve the conflict to edit it.`);
          }
          let next: ItemFields;
          if (typeof edit === "function") {
            const parsed = current === null ? null : parseItem(current, id);
            if (!parsed?.ok) throw new RefusedWrite(`${id}'s item.md cannot be read, so it can only be replaced whole.`);
            next = edit(parsed.fields);
          } else next = edit;
          const text = serializeItem(id, canonicalItem(next));
          const changes = new Map<string, PathChange>();
          if (text !== current) changes.set(path, { text });
          // Only the versions the person saw and settled go; one that came in since stays.
          const settled = aside.filter((file) => supersedes.has(state.tree.get(file)?.sha ?? ""));
          for (const file of settled) changes.set(file, null);
          return { id, message: `${id}: ${settled.length > 0 ? "resolve the conflict in item.md" : "edit item.md"}`, changes };
        });
      });
    },

    appendLog(id, line) {
      return serial(async () => {
        checkId(id);
        await refuseMovedId(id);
        const each = Array.isArray(line) ? (line as readonly LineWrite[]) : [line as LineWrite];
        if (each.length === 0) throw new RefusedWrite(`No line to append to the log of ${id}.`);
        const at = now();
        const texts = each.map((one) => serializeLogLine({ at, by: { who: one.by.who, machine, agent: one.by.agent }, kind: one.kind, ...(one.fields ? { fields: one.fields } : {}) }));
        return write(async (state) => {
          if (!exists(state.tree, id)) throw new RefusedWrite(`There is no item ${id}.`);
          const path = `items/${id}/log.jsonl`;
          const old = (await state.text(path)) ?? "";
          // The same line twice is one line: it is not written again.
          const had = logLines(old);
          const fresh = texts.filter((text, index) => !had.includes(text) && texts.indexOf(text) === index);
          if (fresh.length === 0) return { id, message: "", changes: new Map() };
          const next = appendLines(old, fresh);
          const problem = appendOnlyProblem(old, next);
          if (problem) throw new RefusedWrite(`The log of ${id} is append-only: ${problem}.`);
          if (Buffer.byteLength(next, "utf8") > Math.min(maxAppend, MAX_FILE_BYTES)) throw new RefusedWrite(`The log of ${id} would be over ${Math.min(maxAppend, MAX_FILE_BYTES)} bytes; nothing more is appended to it.`);
          return { id, message: `${id}: append ${[...new Set(each.map((one) => one.kind))].join(", ")}`, changes: new Map<string, PathChange>([[path, { text: next }]]) };
        });
      });
    },

    share: () => serial(() => shareNow(true)),

    accept: () => serial(() => acceptIncoming()),

    async versions(id) {
      checkId(id);
      const commit = (await heads()).local;
      const tree = await readTree(git, commit);
      const paths = [`items/${id}/item.md`, ...asideFiles(tree, id)].filter((path) => tree.get(path)?.type === "blob");
      const texts = await readTexts(git, paths.map((path) => (tree.get(path) as TreeEntry).sha));
      const text = (path: string): string => texts.get((tree.get(path) as TreeEntry).sha) ?? "";
      return {
        itemMd: tree.has(`items/${id}/item.md`) ? text(`items/${id}/item.md`) : null,
        aside: paths
          .filter((path) => !path.endsWith("/item.md"))
          .map((path) => ({ file: path.slice(path.lastIndexOf("/") + 1), blob: (tree.get(path) as TreeEntry).sha, text: text(path) })),
      };
    },

    lastSharing: () => last,

    async format() {
      const commit = (await heads()).local;
      return commit === null ? null : formatAt(await readTree(git, commit));
    },

    shares: () => sharing(),

    migrate: () => serial(() => migrateNow()),
  };
}
