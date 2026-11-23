// The git side of writing the meta ref: objects, trees and commits made with plumbing, the ref
// moved only from the value it was read at, and the remote reached with explicit full refspecs.
// No checkout, no working directory, no index. Every argument is a constant or checked first.

import { createHash } from "node:crypto";
import { devNull } from "node:os";
import type { RunGit } from "./git.ts";
import { isItemId, isMetaRef, isSha } from "./ids.ts";
import type { TreeEntry } from "./merge.ts";

/**
 * Options for the local plumbing: no hooks (`update-ref` and `fetch` would run
 * `reference-transaction`), no signing, no automatic gc or maintenance in the middle of a write.
 * Not used for `push`: a push runs the repository's own hooks (`pre-push`), which is the project's call.
 */
const QUIET = ["-c", `core.hooksPath=${devNull}`, "-c", "commit.gpgSign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];

const failed = (what: string, result: { code: number; stderr: string }): Error =>
  new Error(`git ${what} failed (exit ${result.code})${result.stderr ? `: ${result.stderr.slice(-400)}` : ""}`);

const sha = (what: string, text: string): string => {
  const value = text.trim();
  if (!isSha(value) || (value.length !== 40 && value.length !== 64)) throw new Error(`git ${what} gave "${value.slice(0, 80)}", not an object id`);
  return value;
};

/** A remote's name as Scope Soup will pass it: a configured remote, never a URL or an option. */
export function isRemoteName(text: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text) && !text.includes("..") && !text.endsWith(".lock");
}

/** The person commits are made as. */
export interface Person {
  name: string;
  email: string;
}

/** Refuses a name or address git would misread in a commit header. */
export function checkPerson(person: Person): void {
  if (!/^[^\u0000-\u001f\u007f<>]{1,100}$/.test(person.name) || person.name !== person.name.trim()) throw new Error(`The commit author's name "${person.name}" is empty, too long, or holds <, > or a control character.`);
  if (!/^[^\s<>]{1,200}$/.test(person.email) || !person.email.includes("@")) throw new Error(`The commit author's email "${person.email}" is not an address.`);
}

/** Every entry of a commit's tree, trees included, by full path. Paths are kept byte for byte (latin1). */
export async function readTree(git: RunGit, commit: string | null): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  if (commit === null) return entries;
  if (!isSha(commit)) throw new Error(`"${commit}" is not a commit id`);
  const result = await git(["ls-tree", "-r", "-t", "-z", "--full-tree", commit]);
  if (result.code !== 0) throw failed("ls-tree", result);
  for (const record of result.stdout.toString("latin1").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, id] = record.slice(0, tab).split(" ");
    if (!mode || !type || !id) continue;
    entries.set(record.slice(tab + 1), { mode, type, sha: id });
  }
  return entries;
}

/** The blobs and submodules of a tree read by `readTree`: what the merge works on. */
export function filesOf(tree: ReadonlyMap<string, TreeEntry>): Map<string, TreeEntry> {
  return new Map([...tree].filter(([, entry]) => entry.type !== "tree"));
}

/** Reads blobs as UTF-8 text. A blob whose bytes are not UTF-8 is refused: decoding and writing it back would change it. */
export async function readTexts(git: RunGit, shas: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(shas)];
  const texts = new Map<string, string>();
  if (wanted.length === 0) return texts;
  for (const id of wanted) if (!isSha(id)) throw new Error(`"${id}" is not an object id`);
  const result = await git(["cat-file", "--batch"], `${wanted.join("\n")}\n`);
  if (result.code !== 0) throw failed("cat-file", result);
  const out = result.stdout;
  let at = 0;
  for (const id of wanted) {
    const end = out.indexOf(0x0a, at);
    const header = out.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    if (end < 0 || header.length !== 3 || header[1] !== "blob") throw new Error(`git cat-file: ${id} is not a readable blob`);
    const size = Number(header[2]);
    const bytes = out.subarray(at, at + size);
    at += size + 1;
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`The blob ${id} is not UTF-8 text; Scope Soup will not rewrite it.`);
    texts.set(id, text);
  }
  return texts;
}

/** Stores a text as a blob. `hash-object --stdin` applies no filters, so the bytes are exactly the text's UTF-8. */
export async function writeBlob(git: RunGit, text: string): Promise<string> {
  const result = await git(["hash-object", "-w", "-t", "blob", "--stdin"], Buffer.from(text, "utf8"));
  if (result.code !== 0) throw failed("hash-object", result);
  return sha("hash-object", result.stdout.toString("utf8"));
}

/**
 * Stores many texts as blobs with one `git fast-import`, for a write of many items at once, and gives their ids in the
 * same order (`get-mark`). Like `hash-object --stdin`, fast-import applies no filters: the bytes are exactly the texts' UTF-8.
 */
export async function writeBlobs(git: RunGit, texts: readonly string[]): Promise<string[]> {
  if (texts.length === 0) return [];
  const parts: Buffer[] = [];
  texts.forEach((text, index) => {
    const bytes = Buffer.from(text, "utf8");
    parts.push(Buffer.from(`blob\nmark :${index + 1}\ndata ${bytes.length}\n`), bytes, Buffer.from("\n"));
  });
  texts.forEach((_, index) => parts.push(Buffer.from(`get-mark :${index + 1}\n`)));
  const result = await git([...QUIET, "fast-import", "--quiet"], Buffer.concat(parts));
  if (result.code !== 0) throw failed("fast-import", result);
  const ids = result.stdout.toString("utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (ids.length !== texts.length) throw new Error(`git fast-import gave ${ids.length} object ids for ${texts.length} blobs`);
  return ids.map((id) => sha("fast-import", id));
}

const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * The tree of `base` with these paths set (or removed when null), as a new tree object. Only the
 * directories on the way to a changed path are written again (`git mktree` each); everything else
 * is kept by id. A directory left empty is dropped.
 */
export async function writeTree(git: RunGit, base: ReadonlyMap<string, TreeEntry>, changes: ReadonlyMap<string, TreeEntry | null>): Promise<string> {
  return (await writeTreeEntries(git, base, changes)).id;
}

/**
 * `writeTree`, and also the new tree's entries as `readTree` would give them (computed, not read
 * back), so the next write on top of it needs no `ls-tree`. One `git mktree` call.
 */
export async function writeTreeEntries(git: RunGit, base: ReadonlyMap<string, TreeEntry>, changes: ReadonlyMap<string, TreeEntry | null>): Promise<{ id: string; tree: Map<string, TreeEntry> }> {
  const dirty = new Set<string>([""]);
  for (const path of changes.keys()) for (let dir = parentOf(path); dir !== ""; dir = parentOf(dir)) dirty.add(dir);
  const children = new Map<string, Map<string, TreeEntry>>();
  for (const dir of dirty) children.set(dir, new Map());
  for (const [path, entry] of base) children.get(parentOf(path))?.set(nameOf(path), entry);
  for (const [path, entry] of changes) {
    const siblings = children.get(parentOf(path)) as Map<string, TreeEntry>;
    if (entry === null) siblings.delete(nameOf(path));
    else siblings.set(nameOf(path), entry);
  }
  // Deepest first, so each directory's id is known before its parent's entries are made. The ids
  // are computed here, so all the trees go to one `git mktree --batch`, which must agree with them.
  const order = [...dirty].sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1));
  const known = [...changes.values(), ...base.values()].find((entry) => entry !== null)?.sha;
  const algorithm = known?.length === 64 ? "sha256" : "sha1";
  const batch: Buffer[] = [];
  const expected: string[] = [];
  const full = new Map(base);
  for (const [path, entry] of changes) {
    if (entry === null) full.delete(path);
    else full.set(path, entry);
  }
  for (const dir of order) {
    const entries = children.get(dir) as Map<string, TreeEntry>;
    if (dir !== "" && entries.size === 0) {
      children.get(parentOf(dir))?.delete(nameOf(dir));
      full.delete(dir);
      continue;
    }
    const id = treeId(algorithm, entries);
    batch.push(...[...entries].map(([name, entry]) => Buffer.from(`${entry.mode} ${entry.type} ${entry.sha}\t${name}\0`, "latin1")), Buffer.from("\0"));
    expected.push(id);
    if (dir !== "") {
      const entry: TreeEntry = { mode: "040000", type: "tree", sha: id };
      children.get(parentOf(dir))?.set(nameOf(dir), entry);
      full.set(dir, entry);
    }
  }
  const result = await git([...QUIET, "mktree", "-z", "--batch"], Buffer.concat(batch));
  if (result.code !== 0) throw failed("mktree", result);
  const made = result.stdout.toString("utf8").split("\n").filter(Boolean);
  if (made.length !== expected.length || made.some((id, index) => id !== expected[index])) throw new Error("git mktree made other trees than expected; nothing was written");
  return { id: expected[expected.length - 1] as string, tree: full };
}

/** A tree object's id, as git computes it: entries in git's order (a tree's name compared as if it ended in "/"). */
function treeId(algorithm: "sha1" | "sha256", entries: ReadonlyMap<string, TreeEntry>): string {
  const key = (name: string, entry: TreeEntry): string => (entry.type === "tree" ? `${name}/` : name);
  const sorted = [...entries].sort(([a, x], [b, y]) => (key(a, x) < key(b, y) ? -1 : key(a, x) > key(b, y) ? 1 : 0));
  const body = Buffer.concat(sorted.map(([name, entry]) => Buffer.concat([Buffer.from(`${entry.mode.replace(/^0+/, "")} ${name}\0`, "latin1"), Buffer.from(entry.sha, "hex")])));
  return createHash(algorithm).update(`tree ${body.length}\0`).update(body).digest("hex");
}

export interface CommitInput {
  tree: string;
  parents: string[];
  message: string;
  author: Person;
  /** Unix seconds and offset, as git keeps them: `1763456400 +0000`. */
  authorDate: string;
  committer: Person;
  committerDate: string;
}

/** `git commit-tree` with the identity passed in, never from the machine's git config. */
export async function writeCommit(git: RunGit, input: CommitInput): Promise<string> {
  checkPerson(input.author);
  checkPerson(input.committer);
  for (const date of [input.authorDate, input.committerDate]) if (!/^\d{1,12} [+-]\d{4}$/.test(date)) throw new Error(`"${date}" is not a git date`);
  for (const id of [input.tree, ...input.parents]) if (!isSha(id)) throw new Error(`"${id}" is not an object id`);
  const args = [...QUIET, "commit-tree", "--no-gpg-sign", input.tree, ...input.parents.flatMap((parent) => ["-p", parent])];
  const env = {
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_AUTHOR_DATE: input.authorDate,
    GIT_COMMITTER_NAME: input.committer.name,
    GIT_COMMITTER_EMAIL: input.committer.email,
    GIT_COMMITTER_DATE: input.committerDate,
  };
  const result = await git(args, Buffer.from(input.message, "utf8"), env);
  if (result.code !== 0) throw failed("commit-tree", result);
  return sha("commit-tree", result.stdout.toString("utf8"));
}

/** A time as git keeps it in a commit, in UTC. */
export function gitDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`"${iso}" is not a time`);
  return `${Math.floor(ms / 1000)} +0000`;
}

export interface CommitInfo {
  parents: string[];
  author: Person;
  authorDate: string;
  message: string;
}

function parseCommit(commit: string, raw: string): CommitInfo {
  const split = raw.indexOf("\n\n");
  const header = split < 0 ? raw : raw.slice(0, split);
  const message = split < 0 ? "" : raw.slice(split + 2);
  const parents = [...header.matchAll(/^parent ([0-9a-f]+)$/gm)].map((match) => match[1] as string);
  const author = /^author (.*) <([^<>]*)> (\d+ [+-]\d{4})$/m.exec(header);
  if (!author) throw new Error(`The commit ${commit} has no readable author`);
  return { parents, author: { name: author[1] as string, email: author[2] as string }, authorDate: author[3] as string, message };
}

/** Parents, author and message of these commits, from the raw objects, with one `git cat-file --batch`. */
export async function readCommits(git: RunGit, commits: string[]): Promise<Map<string, CommitInfo>> {
  const wanted = [...new Set(commits)];
  const infos = new Map<string, CommitInfo>();
  if (wanted.length === 0) return infos;
  for (const id of wanted) if (!isSha(id)) throw new Error(`"${id}" is not a commit id`);
  const result = await git(["cat-file", "--batch"], `${wanted.join("\n")}\n`);
  if (result.code !== 0) throw failed("cat-file", result);
  const out = result.stdout;
  let at = 0;
  for (const id of wanted) {
    const end = out.indexOf(0x0a, at);
    const header = end < 0 ? [] : out.subarray(at, end).toString("utf8").split(" ");
    if (header.length !== 3 || header[1] !== "commit") throw new Error(`git cat-file: ${id} is not a readable commit`);
    at = end + 1;
    const size = Number(header[2]);
    if (!Number.isInteger(size) || size < 0 || at + size > out.length) throw new Error("git cat-file --batch gave an unreadable header");
    infos.set(id, parseCommit(id, out.subarray(at, at + size).toString("utf8")));
    at += size + 1;
  }
  return infos;
}

/** A commit's parents, author and message, from the raw object. */
export async function readCommit(git: RunGit, commit: string): Promise<CommitInfo> {
  return (await readCommits(git, [commit])).get(commit) as CommitInfo;
}

/**
 * Where each of these refs points, with one `git for-each-ref`: a commit id, or null when the ref
 * does not exist. A ref at anything but a commit is an error.
 */
export async function readRefs(git: RunGit, refs: string[]): Promise<Map<string, string | null>> {
  for (const ref of refs) if (!isMetaRef(ref)) throw new Error(`"${ref}" is not a ref Scope Soup will read`);
  const result = await git(["for-each-ref", "--format=%(objecttype) %(objectname) %(refname)", ...refs]);
  if (result.code !== 0) throw failed("for-each-ref", result);
  const found = new Map<string, string | null>(refs.map((ref) => [ref, null]));
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const [type, id, name] = line.trim().split(" ");
    // A pattern also matches refs below it (refs/x matches refs/x/y): only exact names count.
    if (!name || !found.has(name)) continue;
    if (type !== "commit") throw new Error(`${name} points at a ${type}, not a commit.`);
    found.set(name, sha("for-each-ref", id ?? ""));
  }
  return found;
}

/** The zero id that tells `update-ref` the ref must not exist yet. */
const zero = (like: string): string => "0".repeat(like.length);

/**
 * Moves a ref to `next` only if it is still at `expected` (null: only if it does not exist).
 * True when it moved; false when someone else moved it first.
 */
export async function moveRef(git: RunGit, ref: string, next: string, expected: string | null): Promise<boolean> {
  if (!isMetaRef(ref)) throw new Error(`"${ref}" is not a ref Scope Soup will write`);
  if (!isSha(next) || (expected !== null && !isSha(expected))) throw new Error("update-ref needs object ids");
  const result = await git([...QUIET, "update-ref", "-m", "scopesoup: meta write", ref, next, expected ?? zero(next)]);
  if (result.code === 0) return true;
  // Lost the race, or something else went wrong: tell them apart by looking.
  const now = await git(["rev-parse", "--verify", "--quiet", ref]);
  const at = now.code === 0 ? now.stdout.toString("utf8").trim() : null;
  if (at !== expected) return false;
  throw failed("update-ref", result);
}

/** True when `ancestor` is `descendant` or one of its ancestors. */
export async function isAncestor(git: RunGit, ancestor: string, descendant: string): Promise<boolean> {
  if (!isSha(ancestor) || !isSha(descendant)) throw new Error("merge-base needs object ids");
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw failed("merge-base", result);
}

/** How `local` stands to `other`, with one `git merge-base`: the same, behind it (a fast-forward), ahead of it, or apart. */
export async function relation(git: RunGit, local: string, other: string): Promise<"same" | "behind" | "ahead" | "apart"> {
  if (!isSha(local) || !isSha(other)) throw new Error("merge-base needs object ids");
  if (local === other) return "same";
  const result = await git(["merge-base", local, other]);
  if (result.code !== 0 && result.code !== 1) throw failed("merge-base", result);
  const base = result.stdout.toString("utf8").trim();
  return base === local ? "behind" : base === other ? "ahead" : "apart";
}

/** The blob paths that differ between two commits, with their ids on each side (null: absent). */
export async function changedFiles(git: RunGit, from: string, to: string): Promise<{ path: string; from: string | null; to: string | null }[]> {
  if (!isSha(from) || !isSha(to)) throw new Error("diff-tree needs object ids");
  const result = await git(["diff-tree", "-r", "-z", "--no-renames", "--no-ext-diff", from, to]);
  if (result.code !== 0) throw failed("diff-tree", result);
  const fields = result.stdout.toString("latin1").split("\0");
  const changed: { path: string; from: string | null; to: string | null }[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    // ":<old mode> <new mode> <old id> <new id> <status>", then the path.
    const [, , before, after] = (fields[index] ?? "").slice(1).split(" ");
    const path = fields[index + 1];
    if (!before || !after || path === undefined) continue;
    const none = (id: string): string | null => (/^0+$/.test(id) ? null : id);
    changed.push({ path, from: none(before), to: none(after) });
  }
  return changed;
}

/**
 * What each commit on `tip`'s first-parent line that `stop` does not have changed against its
 * first parent (blob paths, ids on each side, null: absent), oldest first, with one `git log`.
 * A commit that changed nothing is listed with no changes. The same commits as `commitsSince`.
 */
export async function changesSince(git: RunGit, stop: string, tip: string): Promise<{ commit: string; changes: { path: string; from: string | null; to: string | null }[] }[]> {
  if (!isSha(stop) || !isSha(tip)) throw new Error("log needs object ids");
  const result = await git(["log", "--first-parent", "--reverse", "-z", "--raw", "-r", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-show-signature", "--format=%x01%H", tip, `^${stop}`]);
  if (result.code !== 0) throw failed("log", result);
  const none = (id: string): string | null => (/^0+$/.test(id) ? null : id);
  const out: { commit: string; changes: { path: string; from: string | null; to: string | null }[] }[] = [];
  const fields = result.stdout.toString("latin1").split("\0");
  for (let index = 0; index < fields.length; index++) {
    let field = (fields[index] ?? "").replace(/^\n+/, "");
    const header = /^\u0001([0-9a-f]{40,64})/.exec(field);
    if (header) {
      out.push({ commit: header[1] as string, changes: [] });
      field = field.slice(header[0].length).replace(/^\n+/, "");
    }
    if (!field.startsWith(":")) continue;
    // ":<old mode> <new mode> <old id> <new id> <status>", then the path in the next field.
    const [, , before, after] = field.slice(1).split(" ");
    const path = fields[++index];
    const current = out[out.length - 1];
    if (!current || !before || !after || path === undefined) continue;
    current.changes.push({ path, from: none(before), to: none(after) });
  }
  return out;
}

/** The commits on `tip`'s first-parent line that `stop` does not have, oldest first. */
export async function commitsSince(git: RunGit, stop: string | null, tip: string): Promise<string[]> {
  if ((stop !== null && !isSha(stop)) || !isSha(tip)) throw new Error("rev-list needs object ids");
  // No stop: the whole first-parent line.
  const result = await git(["rev-list", "--first-parent", "--reverse", tip, ...(stop === null ? [] : [`^${stop}`])]);
  if (result.code !== 0) throw failed("rev-list", result);
  return result.stdout.toString("utf8").split("\n").filter(Boolean).map((line) => sha("rev-list", line));
}

/** True when `tip`'s history since `stop` has a merge commit. */
export async function hasMerges(git: RunGit, stop: string, tip: string): Promise<boolean> {
  if (!isSha(stop) || !isSha(tip)) throw new Error("rev-list needs object ids");
  const result = await git(["rev-list", "--merges", "--count", tip, `^${stop}`]);
  if (result.code !== 0) throw failed("rev-list", result);
  return Number(result.stdout.toString("utf8").trim()) > 0;
}

/** The newest commit both have, or null when the histories are unrelated. */
export async function mergeBase(git: RunGit, a: string, b: string): Promise<string | null> {
  if (!isSha(a) || !isSha(b)) throw new Error("merge-base needs object ids");
  const result = await git(["merge-base", a, b]);
  if (result.code === 1) return null;
  if (result.code !== 0) throw failed("merge-base", result);
  return sha("merge-base", result.stdout.toString("utf8"));
}

/** The names under one item's directory in a commit. */
export async function itemFileNames(git: RunGit, commit: string, id: string): Promise<string[]> {
  if (!isSha(commit) || !isItemId(id)) throw new Error("ls-tree needs a commit and an item id");
  const result = await git(["ls-tree", "--name-only", "-z", commit, "--", `items/${id}/`]);
  if (result.code !== 0) throw failed("ls-tree", result);
  return result.stdout.toString("latin1").split("\0").filter(Boolean).map((path) => path.slice(path.lastIndexOf("/") + 1));
}

/** Every branch checked out in the repository's working copies (`git worktree list`). */
export async function checkedOutRefs(git: RunGit): Promise<string[]> {
  const result = await git(["worktree", "list", "--porcelain"]);
  if (result.code !== 0) return [];
  return result.stdout.toString("utf8").split(/\r?\n/).filter((line) => line.startsWith("branch ")).map((line) => line.slice("branch ".length));
}

/** The oldest git that writing works with: `fetch --no-write-fetch-head` and `maintenance.auto` came in 2.29. */
export const MIN_GIT: readonly [number, number] = [2, 29];

/** Refuses a git older than MIN_GIT, with the version it found. */
export async function checkGitVersion(git: RunGit): Promise<void> {
  const result = await git(["version"]);
  const text = result.stdout.toString("utf8").trim();
  const match = /^git version (\d+)\.(\d+)/.exec(text);
  if (result.code !== 0 || !match) throw new Error(`Could not tell which git this is ("${text.slice(0, 80)}"); writing to the meta ref needs git ${MIN_GIT.join(".")} or newer.`);
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) throw new Error(`${text} is too old: writing to the meta ref needs git ${MIN_GIT.join(".")} or newer.`);
}

/** The repository's common git directory (where refs and their lock files live), as git names it. */
export async function commonDir(git: RunGit): Promise<string> {
  const result = await git(["rev-parse", "--git-common-dir"]);
  if (result.code !== 0) throw failed("rev-parse", result);
  return result.stdout.toString("utf8").trim();
}

// --- the remote ---

/**
 * The ssh command for fetch and push: the user's own (`GIT_SSH_COMMAND`, else `core.sshCommand`)
 * with `-o BatchMode=yes` added, so ssh never asks for a password or a host key; plain ssh in batch
 * mode when there is none. Null when `GIT_SSH` names a program that cannot take ssh's options:
 * then nothing is changed.
 */
export function sshCommand(fromEnv: string | undefined, configured: string | undefined, gitSsh: string | undefined): string | null {
  const own = fromEnv?.trim() || configured?.trim();
  if (own) {
    // PuTTY's plink (and TortoisePlink) take -batch, not OpenSSH's -o.
    const program = (/^"([^"]+)"|^(\S+)/.exec(own)?.slice(1).find(Boolean) ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
    return program === "plink" || program === "tortoiseplink" ? `${own} -batch` : `${own} -o BatchMode=yes`;
  }
  if (gitSsh?.trim()) return null;
  return "ssh -o BatchMode=yes";
}

/** The environment for fetch, push and ls-remote: ssh that cannot prompt. */
export async function networkEnvironment(git: RunGit, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  const configured = await git(["config", "--get", "core.sshCommand"]);
  const command = sshCommand(env.GIT_SSH_COMMAND, configured.code === 0 ? configured.stdout.toString("utf8") : undefined, env.GIT_SSH);
  return command === null ? {} : { GIT_SSH_COMMAND: command };
}

/** True when the repository has a remote of this name. */
export async function hasRemote(git: RunGit, remote: string): Promise<boolean> {
  if (!isRemoteName(remote)) throw new Error(`"${remote}" is not a remote name Scope Soup accepts`);
  const result = await git(["remote"]);
  if (result.code !== 0) throw failed("remote", result);
  return result.stdout.toString("utf8").split(/\r?\n/).includes(remote);
}

/** Where the remote's ref is now, or null when it has none. Asks with the full ref name (never a trailing slash), and takes only an exact match. */
export async function remoteRef(network: RunGit, remote: string, ref: string, env: Record<string, string> = {}): Promise<string | null> {
  if (!isRemoteName(remote) || !isMetaRef(ref)) throw new Error("ls-remote needs a remote name and a ref");
  const result = await network(["ls-remote", "--refs", remote, ref], undefined, env);
  if (result.code !== 0) throw failed(`ls-remote ${remote}`, result);
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const [id, name] = line.trim().split("\t");
    if (name === ref && id) return sha("ls-remote", id);
  }
  return null;
}

/** Fetches the remote's ref into `into` (a ref of Scope Soup's own), whatever it was before: the caller checks it before trusting it. */
export async function fetchRef(network: RunGit, remote: string, ref: string, into: string, env: Record<string, string> = {}): Promise<void> {
  if (!isRemoteName(remote) || !isMetaRef(ref) || !isMetaRef(into)) throw new Error("fetch needs a remote name and refs");
  const result = await network([...QUIET, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-prune", remote, `+${ref}:${into}`], undefined, env);
  if (result.code !== 0) throw failed(`fetch ${remote}`, result);
}

/**
 * Pushes one commit to the remote's ref, fast-forward only: no `+`, no force. The repository's own
 * hooks run (a pre-push hook is the project's to keep); the push is not signed. Returns git's message
 * when the push was refused or failed.
 */
export async function pushRef(network: RunGit, remote: string, commit: string, ref: string, env: Record<string, string> = {}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isRemoteName(remote) || !isMetaRef(ref) || !isSha(commit)) throw new Error("push needs a remote name, a commit and a ref");
  const result = await network(["-c", "push.gpgSign=false", "push", "--quiet", "--no-follow-tags", "--recurse-submodules=no", remote, `${commit}:${ref}`], undefined, env);
  return result.code === 0 ? { ok: true } : { ok: false, message: `exit ${result.code}${result.stderr ? `: ${result.stderr.slice(-400)}` : ""}` };
}
