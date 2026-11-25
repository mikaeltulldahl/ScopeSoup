// Agents' images on disk and in git (the rules are `src/core/media.ts`'s).
//
// Before a session the clone gets `.scopesoup/media/` with a `.gitignore` of `*`, so nothing saved there is committed. After
// it, the files that pass the checks are moved into this machine's data folder, `<data>/media/<item>/`, and the folder is left
// empty; what was refused is deleted and named in the event. With `media.push` on (a project setting, off by default) the
// Item's images are also committed to `refs/scopesoup/media/<id>` in Scope Soup's clone, never merged anywhere, and pushed to
// the remote, fast-forward only; the ref goes on the manifest. The board reads the data folder first, then the ref (fetched
// from the remote when sharing is on). A delete removes the file and, when the ref exists, writes the ref without it.
// `media.keepDaysAfterClose` deletes a closed Item's images, folder and refs, that many days after this machine saw it closed.

import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { recordInManifest } from "../config/manifest.ts";
import type { ProjectConfig } from "../config/types.ts";
import { mediaSettings } from "../config/types.ts";
import type { MediaPlan, MediaType } from "../core/media.ts";
import { MEDIA_FOLDER, MEDIA_HEAD_BYTES, isMediaName, mediaExpired, mediaKey, mediaRef, mediaType, planMedia } from "../core/media.ts";
import { gitIn } from "../hosts/metaBranch/git.ts";
import type { RunGit } from "../hosts/metaBranch/git.ts";
import { gitDate, moveRef, networkEnvironment, pushRef, readRefs, readTree, writeCommit, writeTreeEntries, fetchRef } from "../hosts/metaBranch/plumbing.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Store } from "../store/store.ts";

const ACTOR = "scopesoup";
const COMMITTER = { name: "Scope Soup", email: "scopesoup@localhost.invalid" };
/** A missing image is fetched from the remote at most this often per Item. */
const FETCH_EVERY_MS = 60_000;
const CLOSED_KEY = (key: string): string => `media.closed:${key}`;

export interface MediaDeps {
  /** The data folder; images are kept in `<dataDir>/media/<item>/`. */
  dataDir: string;
  store: Store;
  /** The configuration in use: Scope Soup's clone, the remote, the media setting. Null: no git, local images only. */
  config: () => Pick<ProjectConfig, "repoPath" | "remote" | "media"> | null;
  /** The manifest the media refs are recorded on. */
  configFile?: string;
  now?: () => string;
  /** Git in a repository; default `gitIn`. Tests give a repository of their own. */
  git?: (repoPath: string) => RunGit;
  env?: NodeJS.ProcessEnv;
}

export interface RemoveResult {
  removed: boolean;
  /** "none": it was never on the media ref; "updated": the ref was written without it (and pushed when it is on the remote). */
  ref: "none" | "updated" | "failed";
  problem?: string;
}

export interface Media {
  /** Makes the clone's media folder, ignored by git. Never throws. */
  prepare(cwd: string): void;
  /** Moves the session's images into the data folder; pushes them when sharing is on (in the background). Never throws. */
  collect(subject: Ref, cwd: string): MediaPlan | null;
  /** The Item's images, by name. */
  list(subject: Ref): Promise<string[]>;
  read(subject: Ref, name: string): Promise<{ bytes: Buffer; type: MediaType } | null>;
  remove(subject: Ref, name: string, by: string): Promise<RemoveResult>;
  /** Deletes the images of Items closed longer than `media.keepDaysAfterClose`. */
  expire(items: readonly WorkItem[]): Promise<void>;
  /** Whether images are pushed to the remote now. */
  pushing(): boolean;
  /** Resolves once the pushes started so far are over (tests). */
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
  const folderOf = (subject: Ref): string => join(deps.dataDir, "media", mediaKey(subject.id));
  const localNames = (subject: Ref): string[] => {
    const folder = folderOf(subject);
    if (!existsSync(folder)) return [];
    return readdirSync(folder).filter(isMediaName).sort();
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

  /** The commit of the Item's media ref in Scope Soup's clone, or null. */
  const localRef = async (git: RunGit, subject: Ref): Promise<string | null> => (await readRefs(git, [mediaRef(subject.id)])).get(mediaRef(subject.id)) ?? null;

  /** Writes the ref with `changes` (a name to a file, or null to drop it) on top of what it holds; null when nothing changed. */
  async function writeRef(git: RunGit, subject: Ref, changes: Map<string, string | null>, message: string): Promise<{ commit: string | null; before: string | null } | null> {
    const ref = mediaRef(subject.id);
    const before = await localRef(git, subject);
    const base = await readTree(git, before);
    const entries = new Map<string, { mode: string; type: string; sha: string } | null>();
    for (const [name, file] of changes) {
      if (file === null) {
        if (base.has(name)) entries.set(name, null);
        continue;
      }
      const hashed = await git(["hash-object", "-w", "--no-filters", "-t", "blob", file]);
      if (hashed.code !== 0) throw new Error(`git hash-object failed: ${hashed.stderr.slice(-300)}`);
      const sha = hashed.stdout.toString("utf8").trim();
      if (base.get(name)?.sha !== sha) entries.set(name, { mode: "100644", type: "blob", sha });
    }
    if (entries.size === 0) return null;
    const { id: tree, tree: after } = await writeTreeEntries(git, base, entries);
    if (after.size === 0) {
      // Nothing left: the ref goes.
      if (before) await git(["update-ref", "-d", ref, before]);
      return { commit: null, before };
    }
    const date = gitDate(now());
    const commit = await writeCommit(git, { tree, parents: before ? [before] : [], message, author: COMMITTER, authorDate: date, committer: COMMITTER, committerDate: date });
    if (!(await moveRef(git, ref, commit, before))) throw new Error(`${ref} moved while it was written`);
    return { commit, before };
  }

  /** Puts the ref's new state on the remote: the commit pushed fast-forward, or the ref deleted. */
  async function share(git: RunGit, remote: string, subject: Ref, commit: string | null): Promise<void> {
    const env = await networkEnvironment(git, deps.env);
    const ref = mediaRef(subject.id);
    if (commit === null) {
      const result = await git(["push", "--quiet", remote, "--delete", ref], undefined, env);
      // A ref the remote never had is gone already.
      if (result.code !== 0 && !/remote ref does not exist|unable to delete/i.test(result.stderr)) throw new Error(`git push --delete failed: ${result.stderr.slice(-300)}`);
      return;
    }
    const pushed = await pushRef(git, remote, commit, ref, env);
    if (!pushed.ok) throw new Error(`git push failed: ${pushed.message}`);
    if (deps.configFile) recordInManifest(deps.configFile, [{ kind: "ref", ref, what: `the images of Item ${subject.id}` }], ACTOR, now());
  }

  function publish(subject: Ref): void {
    const config = deps.config();
    if (!config || !mediaSettings(config).push) return;
    const names = localNames(subject);
    if (names.length === 0) return;
    void serial(async () => {
      try {
        const git = gitFor(config.repoPath);
        const written = await writeRef(git, subject, new Map(names.map((name) => [name, join(folderOf(subject), name)])), `Images of Item ${subject.id}`);
        if (!written) return;
        await share(git, config.remote, subject, written.commit);
        event("media.pushed", subject, { ref: mediaRef(subject.id), names, reason: `The images of ${subject.id} were pushed to ${mediaRef(subject.id)} on ${config.remote}: everyone with the repository sees them.` });
      } catch (error) {
        event("media.push_failed", subject, { reason: `The images of ${subject.id} could not be pushed: ${error instanceof Error ? error.message : String(error)}. They are on this machine; the next session's push tries again.` });
      }
    });
  }

  /** The Item's media ref in Scope Soup's clone, fetched from the remote first when sharing is on and it was not lately. */
  async function refFor(subject: Ref, fetch: boolean): Promise<{ git: RunGit; commit: string } | null> {
    const config = deps.config();
    if (!config) return null;
    const git = gitFor(config.repoPath);
    const key = refKey(subject);
    if (fetch && mediaSettings(config).push && Date.now() - (lastFetch.get(key) ?? 0) >= FETCH_EVERY_MS) {
      lastFetch.set(key, Date.now());
      try {
        await fetchRef(git, config.remote, mediaRef(subject.id), mediaRef(subject.id), await networkEnvironment(git, deps.env));
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

  const refNames = async (subject: Ref, fetch: boolean): Promise<Map<string, string>> => {
    const at = await refFor(subject, fetch);
    if (!at) return new Map();
    try {
      return new Map([...(await readTree(at.git, at.commit))].filter(([name, entry]) => entry.type === "blob" && isMediaName(name)).map(([name, entry]) => [name, entry.sha]));
    } catch {
      return new Map();
    }
  };

  return {
    prepare(cwd) {
      try {
        const folder = join(cwd, MEDIA_FOLDER);
        mkdirSync(folder, { recursive: true });
        const ignore = join(folder, ".gitignore");
        if (!existsSync(ignore)) writeFileSync(ignore, "# Scope Soup: images for the board, never committed.\n*\n");
      } catch {
        // A clone that cannot take the folder: the agent's images are simply not there.
      }
    },

    collect(subject, cwd) {
      try {
        const source = join(cwd, MEDIA_FOLDER);
        if (!existsSync(source)) return null;
        const files = readdirSync(source).filter((name) => name !== ".gitignore");
        if (files.length === 0) return null;
        const found = files.flatMap((name) => {
          const path = join(source, name);
          const stat = statSync(path);
          return stat.isFile() ? [{ name, size: stat.size, head: stat.size > 0 ? headOf(path) : new Uint8Array() }] : [];
        });
        const plan = planMedia(found, localNames(subject));
        const folder = folderOf(subject);
        if (plan.keep.length > 0) mkdirSync(folder, { recursive: true });
        for (const { name } of plan.keep) {
          const from = join(source, name);
          const to = join(folder, name);
          try {
            renameSync(from, to);
          } catch {
            copyFileSync(from, to);
          }
        }
        // The folder is left empty for the next session in this clone, whichever Item it is for.
        for (const name of files) rmSync(join(source, name), { recursive: true, force: true });
        event("media.collected", subject, {
          kept: plan.keep.map((each) => each.name),
          refused: plan.refused,
          reason: `${plan.keep.length} image${plan.keep.length === 1 ? "" : "s"} kept from the session${plan.refused.length > 0 ? `; refused: ${plan.refused.map((each) => `${each.name} (${each.why})`).join(", ")}` : ""}.`,
        });
        if (plan.keep.length > 0) publish(subject);
        return plan;
      } catch (error) {
        event("media.collect_failed", subject, { reason: `The session's images could not be taken: ${error instanceof Error ? error.message : String(error)}.` });
        return null;
      }
    },

    async list(subject) {
      const names = new Set(localNames(subject));
      for (const name of (await refNames(subject, names.size === 0)).keys()) names.add(name);
      return [...names].sort();
    },

    async read(subject, name) {
      if (!isMediaName(name)) return null;
      const local = join(folderOf(subject), name);
      let bytes: Buffer | null = null;
      if (existsSync(local)) bytes = readFileSync(local);
      else {
        const at = await refFor(subject, true);
        const sha = (await refNames(subject, false)).get(name);
        if (at && sha) {
          const blob = await at.git(["cat-file", "blob", sha]);
          if (blob.code === 0) bytes = blob.stdout;
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
        const hadLocal = existsSync(local);
        if (hadLocal) rmSync(local, { force: true });
        const result: RemoveResult = { removed: hadLocal, ref: "none" };
        const config = deps.config();
        if (config) {
          try {
            const git = gitFor(config.repoPath);
            const written = await writeRef(git, subject, new Map([[name, null]]), `Image ${name} of Item ${subject.id} deleted by ${by.replace(/[\r\n]/g, " ").slice(0, 80)}`);
            if (written) {
              result.removed = true;
              // The ref was pushed when it was shared once: the remote loses the image too, whatever the setting is now.
              await share(git, config.remote, subject, written.commit);
              result.ref = "updated";
            }
          } catch (error) {
            result.ref = "failed";
            result.problem = error instanceof Error ? error.message : String(error);
          }
        }
        if (result.removed) {
          event("media.deleted", subject, {
            name, by, ref: result.ref,
            reason: `${by} deleted the image ${name}${result.ref === "updated" ? `, also from ${mediaRef(subject.id)}` : result.ref === "failed" ? `; ${mediaRef(subject.id)} could not be written: ${result.problem}` : ""}.`,
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
          if (deps.store.getValue(CLOSED_KEY(key)) !== null) deps.store.setValue(CLOSED_KEY(key), "");
          continue;
        }
        let since = deps.store.getValue(CLOSED_KEY(key)) || "";
        if (!since) {
          since = item.updatedAt;
          deps.store.setValue(CLOSED_KEY(key), since);
        }
        if (!mediaExpired(since, keep, now())) continue;
        const names = localNames(item.ref);
        const onRef = config ? await refNames(item.ref, false) : new Map<string, string>();
        if (names.length === 0 && onRef.size === 0) continue;
        await serial(async () => {
          rmSync(folderOf(item.ref), { recursive: true, force: true });
          let problem = "";
          if (config && onRef.size > 0) {
            try {
              const written = await writeRef(gitFor(config.repoPath), item.ref, new Map([...onRef.keys()].map((name) => [name, null])), "expired");
              if (written) await share(gitFor(config.repoPath), config.remote, item.ref, null);
            } catch (error) {
              problem = ` ${mediaRef(item.ref.id)} could not be deleted: ${error instanceof Error ? error.message : String(error)}.`;
            }
          }
          event("media.expired", item.ref, { names: [...new Set([...names, ...onRef.keys()])], reason: `The images of ${item.ref.id} were deleted ${keep} days after it closed (media.keepDaysAfterClose).${problem}` });
        });
      }
    },

    pushing() {
      const config = deps.config();
      return config ? mediaSettings(config).push : false;
    },

    idle() {
      return pending;
    },
  };
}
