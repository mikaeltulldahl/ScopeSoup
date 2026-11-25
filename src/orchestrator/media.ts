// Agents' images on disk and in git (the rules are `src/core/media.ts`'s).
//
// Before a session the clone gets an empty `.scopesoup/media/` with a `.gitignore` of `*`, so nothing saved there is committed
// and nothing a killed session left reaches another Item. After it, the plain files that pass the checks are moved into this
// machine's data folder, `<data>/media/<key>/` (`mediaKey` of the Item's whole key), and the folder is emptied; what was refused
// is deleted and named in the event. A link anywhere on the way (the folder, `.scopesoup`, an entry) is never followed: a
// linked folder is left alone and a linked entry refused, so no file from elsewhere on the machine is taken, served or pushed.
// With `media.push` on (a project setting, off by default) the Item's images are also committed to `refs/scopesoup/media/<key>`
// in Scope Soup's clone, never merged anywhere, and pushed to the remote, fast-forward only; the ref goes on the manifest.
// The board reads the data folder first, then the ref (fetched from the remote when sharing is on). A delete removes the file
// and the image from the ref, here and on the remote; with sharing off since, the remote's ref only shrinks to what is still
// here. A remote update that fails is kept pending and tried again every hour. `media.keepDaysAfterClose` deletes a closed
// Item's images, folder and refs, that many days after this machine saw it closed.
// Singleplayer (`multiplayer: false`, decision 93) touches no remote: with `media.push` on the images still go on the local ref,
// kept pending, and the first retry in multiplayer pushes them; a delete or an expiry waits the same way. The remote is left alone.

import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { recordInManifest } from "../config/manifest.ts";
import type { ProjectConfig } from "../config/types.ts";
import { mediaSettings, mediaShared } from "../config/types.ts";
import type { MediaPlan, MediaType } from "../core/media.ts";
import { MAX_MEDIA_BYTES, MAX_MEDIA_PER_ITEM, MEDIA_FOLDER, MEDIA_HEAD_BYTES, isMediaName, mediaExpired, mediaKey, mediaRef, mediaType, planMedia } from "../core/media.ts";
import { gitIn } from "../hosts/metaBranch/git.ts";
import type { RunGit } from "../hosts/metaBranch/git.ts";
import { fetchRef, gitDate, moveRef, networkEnvironment, pushRef, readRefs, readTree, remoteRef, writeCommit, writeTreeEntries } from "../hosts/metaBranch/plumbing.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "../store/store.ts";

const ACTOR = "scopesoup";
const COMMITTER = { name: "Scope Soup", email: "scopesoup@localhost.invalid" };
/** A missing image is fetched from the remote at most this often per Item. */
const FETCH_EVERY_MS = 60_000;
const CLOSED_KEY = (key: string): string => `media.closed:${key}`;
/** The Items whose remote media ref is not what it should be yet: a failed push, delete or expiry, tried again. */
const PENDING_KEY = "media.pending";

export interface MediaDeps {
  /** The data folder; images are kept in `<dataDir>/media/<key>/`. */
  dataDir: string;
  store: Store;
  /** The configuration in use: Scope Soup's clone, the remote, the media setting. Null: no git, local images only. */
  config: () => Pick<ProjectConfig, "repoPath" | "remote" | "media" | "multiplayer"> | null;
  /** The manifest the media refs are recorded on. */
  configFile?: string;
  now?: () => string;
  /** Git in a repository; default `gitIn`. Tests give a repository of their own. */
  git?: (repoPath: string) => RunGit;
  env?: NodeJS.ProcessEnv;
}

export interface RemoveResult {
  removed: boolean;
  /** "none": no media ref to change; "updated": the ref was written without it, here and on the remote; "failed": the remote still has it. */
  ref: "none" | "updated" | "failed";
  problem?: string;
}

export interface Media {
  /** Makes the clone's media folder empty, ignored by git. Never throws. */
  prepare(cwd: string): void;
  /** Moves the session's images into the data folder; pushes them when sharing is on (in the background). Never throws. */
  collect(subject: Ref, cwd: string): MediaPlan | null;
  /** The Item's images, by name. */
  list(subject: Ref): Promise<string[]>;
  read(subject: Ref, name: string): Promise<{ bytes: Buffer; type: MediaType } | null>;
  remove(subject: Ref, name: string, by: string): Promise<RemoveResult>;
  /** Deletes the images of Items closed longer than `media.keepDaysAfterClose`, and tries the pending remote updates again. */
  expire(items: readonly WorkItem[]): Promise<void>;
  /** Tries again each remote media ref that a push, delete or expiry left out of date. */
  retry(): Promise<void>;
  /** Whether images are pushed to the remote now. */
  pushing(): boolean;
  /** Resolves once the git work started so far is over (tests). */
  idle(): Promise<void>;
}

/** The first bytes of a file, for `mediaType`. */
function headOf(path: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MEDIA_HEAD_BYTES);
    const read = readSync(fd, buffer, 0, MEDIA_HEAD_BYTES, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** What is at a path, without following a link: "none", "link" (a symbolic link or a junction), "dir", "file" or "other". */
function kindAt(path: string): "none" | "link" | "dir" | "file" | "other" {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "none";
  }
  if (stat.isSymbolicLink()) return "link";
  if (stat.isDirectory()) return "dir";
  return stat.isFile() ? "file" : "other";
}

/** Removes one entry of the media folder: a link itself (never what it points at), a file, or a real folder with what is in it. */
function removeEntry(path: string): void {
  const kind = kindAt(path);
  if (kind === "link") {
    try {
      unlinkSync(path);
    } catch {
      // A directory junction on Windows goes with rmdir; neither ever touches the target.
      rmdirSync(path);
    }
  } else if (kind === "dir") rmSync(path, { recursive: true, force: true });
  else if (kind !== "none") rmSync(path, { force: true });
}

/** The clone's media folder when it and `.scopesoup` are real folders; null (and why) when either is a link or not a folder. */
function mediaFolderIn(cwd: string): { folder: string } | { refused: string } | null {
  const outer = join(cwd, ".scopesoup");
  const folder = join(cwd, MEDIA_FOLDER);
  for (const path of [outer, folder]) {
    const kind = kindAt(path);
    if (kind === "none") return null;
    if (kind !== "dir") return { refused: `${path} is ${kind === "link" ? "a link" : "not a folder"}, so nothing in it is taken` };
  }
  return { folder };
}

export function createMedia(deps: MediaDeps): Media {
  const now = deps.now ?? (() => new Date().toISOString());
  const gits = new Map<string, RunGit>();
  const gitFor = (repoPath: string): RunGit => {
    let git = gits.get(repoPath);
    if (!git) {
      git = deps.git ? deps.git(repoPath) : gitIn(repoPath, { timeoutMs: 5 * 60_000 });
      gits.set(repoPath, git);
    }
    return git;
  };
  const root = join(deps.dataDir, "media");
  const refOf = (subject: Ref): string => mediaRef(refKey(subject));
  const folderOf = (subject: Ref): string => join(root, mediaKey(refKey(subject)));
  /** The plain image files in the Item's data folder (a link there is not one). */
  const localNames = (subject: Ref): string[] => {
    const folder = folderOf(subject);
    if (kindAt(folder) !== "dir") return [];
    return readdirSync(folder).filter((name) => isMediaName(name) && kindAt(join(folder, name)) === "file").sort();
  };
  const event = (kind: string, subject: Ref, data: Record<string, unknown>): void => {
    deps.store.appendEvent({ kind, subject: refKey(subject), actor: ACTOR, data }, now());
  };
  const lastFetch = new Map<string, number>();
  let pending: Promise<void> = Promise.resolve();
  // One git write at a time: a push and a delete of the same Item never race on its ref.
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = pending.then(run, run);
    pending = next.then(() => undefined, () => undefined);
    return next;
  };

  const pendingList = (): Ref[] => {
    try {
      const value = JSON.parse(deps.store.getValue(PENDING_KEY) ?? "[]") as unknown;
      return Array.isArray(value) ? value.filter((each): each is Ref => typeof each === "object" && each !== null && typeof (each as Ref).id === "string") : [];
    } catch {
      return [];
    }
  };
  const setPending = (subject: Ref, on: boolean): void => {
    const others = pendingList().filter((each) => refKey(each) !== refKey(subject));
    deps.store.setValue(PENDING_KEY, JSON.stringify(on ? [...others, { host: subject.host, kind: subject.kind, id: subject.id }] : others));
  };

  /** The commit of the Item's media ref in Scope Soup's clone, or null. */
  const localRef = async (git: RunGit, subject: Ref): Promise<string | null> => (await readRefs(git, [refOf(subject)])).get(refOf(subject)) ?? null;

  /** The image entries of a commit's tree: plain names, blobs only. */
  const imagesOf = async (git: RunGit, commit: string | null): Promise<Map<string, string>> =>
    new Map([...(await readTree(git, commit))].filter(([name, entry]) => entry.type === "blob" && isMediaName(name)).map(([name, entry]) => [name, entry.sha]));

  /** Writes `ref` from `base` with `changes` (a name to a file, or null to drop it); null when nothing changed. The ref goes when nothing is left. */
  async function writeRef(git: RunGit, ref: string, base: string | null, expected: string | null, changes: Map<string, string | null>, message: string): Promise<{ commit: string | null } | null> {
    const tree = await readTree(git, base);
    const entries = new Map<string, { mode: string; type: string; sha: string } | null>();
    for (const [name, file] of changes) {
      if (file === null) {
        if (tree.has(name)) entries.set(name, null);
        continue;
      }
      const hashed = await git(["hash-object", "-w", "--no-filters", "-t", "blob", file]);
      if (hashed.code !== 0) throw new Error(`git hash-object failed: ${hashed.stderr.slice(-300)}`);
      const sha = hashed.stdout.toString("utf8").trim();
      if (tree.get(name)?.sha !== sha) entries.set(name, { mode: "100644", type: "blob", sha });
    }
    if (entries.size === 0) return null;
    const { id, tree: after } = await writeTreeEntries(git, tree, entries);
    if (after.size === 0) {
      if (expected) await git(["update-ref", "-d", ref, expected]);
      return { commit: null };
    }
    const date = gitDate(now());
    const commit = await writeCommit(git, { tree: id, parents: base ? [base] : [], message, author: COMMITTER, authorDate: date, committer: COMMITTER, committerDate: date });
    if (!(await moveRef(git, ref, commit, expected))) throw new Error(`${ref} moved while it was written`);
    return { commit };
  }

  /**
   * Brings the remote's media ref to what it should be. Sharing on: Scope Soup's own ref, pushed fast-forward (or deleted when
   * there is none). Sharing off: the remote's ref only shrinks, to the images still here (the data folder or the local ref),
   * so a delete or an expiry also leaves the remote, and nothing new is pushed. Throws when the remote cannot be updated.
   */
  async function syncRemote(subject: Ref): Promise<"same" | "pushed" | "deleted" | "shrunk"> {
    const config = deps.config();
    if (!config) return "same";
    const git = gitFor(config.repoPath);
    const env = await networkEnvironment(git, deps.env);
    const ref = refOf(subject);
    const remoteAt = await remoteRef(git, config.remote, ref, env);
    const deleteRemote = async (): Promise<void> => {
      const result = await git(["push", "--quiet", config.remote, "--delete", ref], undefined, env);
      if (result.code !== 0) throw new Error(`git push --delete failed: ${result.stderr.slice(-300)}`);
    };
    if (mediaSettings(config).push) {
      const local = await localRef(git, subject);
      if (local === remoteAt) return "same";
      if (local === null) {
        await deleteRemote();
        return "deleted";
      }
      const pushed = await pushRef(git, config.remote, local, ref, env);
      if (!pushed.ok) throw new Error(`git push failed: ${pushed.message}`);
      if (deps.configFile) recordInManifest(deps.configFile, [{ kind: "ref", ref, what: `the images of Item ${subject.id}` }], ACTOR, now());
      return "pushed";
    }
    if (remoteAt === null) return "same";
    const incoming = `refs/scopesoup-incoming/media/${mediaKey(refKey(subject))}`;
    try {
      await fetchRef(git, config.remote, ref, incoming, env);
      const there = await imagesOf(git, remoteAt);
      const keep = new Set([...localNames(subject), ...(await imagesOf(git, await localRef(git, subject))).keys()]);
      const drop = [...there.keys()].filter((name) => !keep.has(name));
      if (drop.length === 0) return "same";
      if (drop.length === there.size) {
        await deleteRemote();
        return "deleted";
      }
      const before = await readRefs(git, [incoming]);
      const written = await writeRef(git, incoming, remoteAt, before.get(incoming) ?? null, new Map(drop.map((name) => [name, null])), `Images of Item ${subject.id} deleted here`);
      if (!written?.commit) return "same";
      const pushed = await pushRef(git, config.remote, written.commit, ref, env);
      if (!pushed.ok) throw new Error(`git push failed: ${pushed.message}`);
      return "shrunk";
    } finally {
      await git(["update-ref", "-d", incoming]);
    }
  }

  /** `syncRemote`, with a failure kept pending (and said) to be tried again. */
  async function share(subject: Ref): Promise<{ ok: true; how: string } | { ok: false; problem: string }> {
    // Singleplayer: the remote is not touched; the Item waits for a retry in multiplayer.
    if (deps.config()?.multiplayer === false) {
      setPending(subject, true);
      return { ok: true, how: "same" };
    }
    try {
      const how = await syncRemote(subject);
      setPending(subject, false);
      return { ok: true, how };
    } catch (error) {
      setPending(subject, true);
      return { ok: false, problem: error instanceof Error ? error.message : String(error) };
    }
  }

  function publish(subject: Ref): void {
    void serial(async () => {
      // The setting as it is when the push runs, not when the session ended.
      const config = deps.config();
      if (!config || !mediaSettings(config).push) return;
      const names = localNames(subject);
      try {
        const git = gitFor(config.repoPath);
        const ref = refOf(subject);
        const at = await localRef(git, subject);
        if (names.length > 0) await writeRef(git, ref, at, at, new Map(names.map((name) => [name, join(folderOf(subject), name)])), `Images of Item ${subject.id}`);
      } catch (error) {
        event("media.push_failed", subject, { reason: `The images of ${subject.id} could not be committed: ${error instanceof Error ? error.message : String(error)}. They are on this machine.` });
        return;
      }
      // Pushed whenever the remote differs, so a push that failed before goes now.
      const shared = await share(subject);
      if (!shared.ok) event("media.push_failed", subject, { reason: `The images of ${subject.id} could not be pushed: ${shared.problem}. They are on this machine; Scope Soup tries again every hour.` });
      else if (shared.how === "pushed") event("media.pushed", subject, { ref: refOf(subject), names, reason: `The images of ${subject.id} were pushed to ${refOf(subject)} on ${config.remote}: everyone with the repository sees them.` });
    });
  }

  /** The Item's media ref in Scope Soup's clone, fetched from the remote first when sharing is on and it was not lately. */
  async function refFor(subject: Ref, fetch: boolean): Promise<{ git: RunGit; commit: string } | null> {
    const config = deps.config();
    if (!config) return null;
    const git = gitFor(config.repoPath);
    const key = refKey(subject);
    if (fetch && mediaShared(config) && Date.now() - (lastFetch.get(key) ?? 0) >= FETCH_EVERY_MS) {
      lastFetch.set(key, Date.now());
      try {
        await fetchRef(git, config.remote, refOf(subject), refOf(subject), await networkEnvironment(git, deps.env));
      } catch {
        // No such ref on the remote, or no network: the images known here are shown.
      }
    }
    try {
      const commit = await localRef(git, subject);
      return commit ? { git, commit } : null;
    } catch {
      return null;
    }
  }

  /** The images on the Item's ref, at most `MAX_MEDIA_PER_ITEM` (a ref from elsewhere holds no more than that here). */
  const refNames = async (subject: Ref, fetch: boolean): Promise<{ git: RunGit; names: Map<string, string> } | null> => {
    const at = await refFor(subject, fetch);
    if (!at) return null;
    try {
      return { git: at.git, names: new Map([...(await imagesOf(at.git, at.commit))].slice(0, MAX_MEDIA_PER_ITEM)) };
    } catch {
      return null;
    }
  };

  /** A plain file inside the data folder's media folder, read; null for a link, anything else, or a path that leads out. */
  const readLocal = (subject: Ref, name: string): Buffer | null => {
    const path = join(folderOf(subject), name);
    if (kindAt(path) !== "file") return null;
    try {
      const real = realpathSync(path);
      const inside = realpathSync(root);
      if (!real.startsWith(inside + sep)) return null;
      return readFileSync(real);
    } catch {
      return null;
    }
  };

  const media: Media = {
    prepare(cwd) {
      try {
        const found = mediaFolderIn(cwd);
        if (found && "refused" in found) return;
        const folder = join(cwd, MEDIA_FOLDER);
        if (found) {
          // Whatever a session left (one that was killed before its images were taken) goes, so it reaches no other Item.
          for (const name of readdirSync(folder)) if (name !== ".gitignore") removeEntry(join(folder, name));
        } else {
          if (kindAt(join(cwd, ".scopesoup")) !== "none" && kindAt(join(cwd, ".scopesoup")) !== "dir") return;
          mkdirSync(folder, { recursive: true });
        }
        const ignore = join(folder, ".gitignore");
        if (kindAt(ignore) === "none") writeFileSync(ignore, "# Scope Soup: images for the board, never committed.\n*\n");
      } catch {
        // A clone that cannot take the folder: the agent's images are simply not there.
      }
    },

    collect(subject, cwd) {
      try {
        const found = mediaFolderIn(cwd);
        if (!found) return null;
        if ("refused" in found) {
          event("media.collect_refused", subject, { reason: `The session's images were not taken: ${found.refused}.` });
          return null;
        }
        const source = found.folder;
        const entries = readdirSync(source).filter((name) => name !== ".gitignore");
        if (entries.length === 0) return null;
        const refusedLinks: { name: string; why: string }[] = [];
        const files = entries.flatMap((name) => {
          const path = join(source, name);
          const kind = kindAt(path);
          if (kind !== "file") {
            refusedLinks.push({ name, why: kind === "link" ? "a link, not a file" : "not a plain file" });
            return [];
          }
          const size = lstatSync(path).size;
          return [{ name, size, head: size > 0 ? headOf(path) : new Uint8Array() }];
        });
        const planned = planMedia(files, localNames(subject));
        const plan: MediaPlan = { keep: planned.keep, refused: [...planned.refused, ...refusedLinks].sort((a, b) => (a.name < b.name ? -1 : 1)) };
        const folder = folderOf(subject);
        if (plan.keep.length > 0) mkdirSync(folder, { recursive: true });
        for (const { name } of plan.keep) {
          const from = join(source, name);
          const to = join(folder, name);
          if (kindAt(to) === "link") removeEntry(to);
          try {
            renameSync(from, to);
          } catch {
            copyFileSync(from, to);
          }
        }
        // The folder is left empty for the next session in this clone, whichever Item it is for; a link goes, its target stays.
        for (const name of entries) removeEntry(join(source, name));
        event("media.collected", subject, {
          kept: plan.keep.map((each) => each.name),
          refused: plan.refused,
          reason: `${plan.keep.length} image${plan.keep.length === 1 ? "" : "s"} kept from the session${plan.refused.length > 0 ? `; refused: ${plan.refused.map((each) => `${each.name} (${each.why})`).join(", ")}` : ""}.`,
        });
        if (plan.keep.length > 0) publish(subject);
        if (pendingList().length > 0) void media.retry();
        return plan;
      } catch (error) {
        event("media.collect_failed", subject, { reason: `The session's images could not be taken: ${error instanceof Error ? error.message : String(error)}.` });
        return null;
      }
    },

    async list(subject) {
      const names = new Set(localNames(subject));
      for (const name of (await refNames(subject, names.size === 0))?.names.keys() ?? []) names.add(name);
      return [...names].sort().slice(0, MAX_MEDIA_PER_ITEM);
    },

    async read(subject, name) {
      if (!isMediaName(name)) return null;
      let bytes = readLocal(subject, name);
      if (!bytes && kindAt(join(folderOf(subject), name)) === "none") {
        const on = await refNames(subject, true);
        const sha = on?.names.get(name);
        if (on && sha) {
          // A blob from the remote is no larger than an image Scope Soup would keep.
          const size = await on.git(["cat-file", "-s", sha]);
          if (size.code === 0 && Number(size.stdout.toString("utf8").trim()) <= MAX_MEDIA_BYTES) {
            const blob = await on.git(["cat-file", "blob", sha]);
            if (blob.code === 0) bytes = blob.stdout;
          }
        }
      }
      if (!bytes) return null;
      // Checked again as it is served: a file put there by hand is no exception.
      const type = mediaType(name, bytes.subarray(0, MEDIA_HEAD_BYTES));
      return type ? { bytes, type } : null;
    },

    remove(subject, name, by) {
      return serial(async () => {
        if (!isMediaName(name)) return { removed: false, ref: "none" as const, problem: "not an image name" };
        const local = join(folderOf(subject), name);
        const hadLocal = kindAt(local) !== "none";
        if (hadLocal) removeEntry(local);
        const result: RemoveResult = { removed: hadLocal, ref: "none" };
        const config = deps.config();
        if (config) {
          // Only an Item whose images were ever on a ref here (or whose remote update waits) can have them on the remote.
          let touched = pendingList().some((each) => refKey(each) === refKey(subject));
          try {
            const git = gitFor(config.repoPath);
            const at = await localRef(git, subject);
            if (at) touched = true;
            const written = await writeRef(git, refOf(subject), at, at, new Map([[name, null]]), `Image ${name} of Item ${subject.id} deleted by ${by.replace(/[\r\n]/g, " ").slice(0, 80)}`);
            if (written) {
              result.removed = true;
              touched = true;
            }
          } catch (error) {
            result.ref = "failed";
            result.problem = error instanceof Error ? error.message : String(error);
          }
          // The remote loses the image too, whatever the setting is now (with sharing off its ref only shrinks).
          if (result.ref !== "failed" && touched) {
            const shared = await share(subject);
            if (!shared.ok) {
              result.ref = "failed";
              result.problem = shared.problem;
            } else if (shared.how !== "same") {
              result.removed = true;
              result.ref = "updated";
            }
          }
        }
        if (result.removed) {
          event("media.deleted", subject, {
            name, by, ref: result.ref,
            reason: `${by} deleted the image ${name}${result.ref === "updated" ? `, also from ${refOf(subject)} on the remote` : result.ref === "failed" ? `; the remote still has it (${result.problem}); Scope Soup tries again every hour` : ""}.`,
          });
        }
        return result;
      });
    },

    async expire(items) {
      const config = deps.config();
      const keep = config ? mediaSettings(config).keepDaysAfterClose : null;
      for (const item of items) {
        const key = refKey(item.ref);
        const closed = item.state === "done" || item.state === "abandoned";
        if (!closed) {
          if (deps.store.getValue(CLOSED_KEY(key))) deps.store.setValue(CLOSED_KEY(key), "");
          continue;
        }
        let since = deps.store.getValue(CLOSED_KEY(key)) || "";
        if (!since) {
          since = item.updatedAt;
          deps.store.setValue(CLOSED_KEY(key), since);
        }
        if (!mediaExpired(since, keep, now())) continue;
        const names = localNames(item.ref);
        const onRef = config ? (await refNames(item.ref, false))?.names ?? new Map<string, string>() : new Map<string, string>();
        if (names.length === 0 && onRef.size === 0) continue;
        await serial(async () => {
          rmSync(folderOf(item.ref), { recursive: true, force: true });
          let problem = "";
          if (config) {
            try {
              const git = gitFor(config.repoPath);
              const at = await localRef(git, item.ref);
              if (at) await git(["update-ref", "-d", refOf(item.ref), at]);
            } catch (error) {
              problem = ` ${refOf(item.ref)} could not be deleted here: ${error instanceof Error ? error.message : String(error)}.`;
            }
            const shared = onRef.size > 0 ? await share(item.ref) : ({ ok: true, how: "same" } as const);
            if (!shared.ok) problem += ` The remote still has them (${shared.problem}); Scope Soup tries again every hour.`;
          }
          event("media.expired", item.ref, { names: [...new Set([...names, ...onRef.keys()])], reason: `The images of ${item.ref.id} were deleted ${keep} days after it closed (media.keepDaysAfterClose).${problem}` });
        });
      }
      await media.retry();
    },

    async retry() {
      for (const subject of pendingList()) {
        await serial(async () => {
          const shared = await share(subject);
          if (shared.ok && shared.how !== "same") event("media.remote_updated", subject, { reason: `${refOf(subject)} on the remote is up to date again (${shared.how}).` });
        });
      }
    },

    pushing() {
      const config = deps.config();
      return config ? mediaShared(config) : false;
    },

    idle() {
      return pending;
    },
  };
  return media;
}
