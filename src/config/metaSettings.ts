// The project's shared settings on the meta ref `refs/scopesoup/meta` of the repository this machine's private file names
// (src/hosts/metaBranch/settings.ts has the files). Read with git straight from the object store, the same ref on every host:
// a meta branch project keeps it next to its Items, a GitHub project has it for the settings alone (as `refs/scopesoup/merge-queue`).
// A save is one commit made by the meta writer (src/hosts/metaBranch/writer.ts): compare-and-swap on the local ref, the person
// named in the commit and in a line of the settings' log, then pushed fast-forward only; a save that lost a race with another
// machine is made again on top of theirs. Other machines see it at their next fetch (`fetch`, once a minute from main.ts).

import { execFileSync } from "node:child_process";
import { checkRepoRoot, gitEnvironment, gitIn, type StoppableGit } from "../hosts/metaBranch/git.ts";
import { parseLog } from "../hosts/metaBranch/log.ts";
import { RefusedWrite } from "../hosts/metaBranch/serialize.ts";
import { META_REF, SETTINGS_FILE, SETTINGS_LOG, type SettingChange, settingChanges, settingsText } from "../hosts/metaBranch/settings.ts";
import { createWriter, type SharingReport, type Writer } from "../hosts/metaBranch/writer.ts";
import { SaveRefused, type SaveRequest, type SaveResult, type SettingsLogEntry, SHARED_WHERE, type SharedRead, type SharedSettings } from "./shared.ts";

/** The committer of settings commits (the author is the person who saved): no one's own address. */
const COMMITTER = { name: "Scope Soup", email: "scopesoup@localhost.invalid" };

export interface MetaSettings extends SharedSettings {
  save(request: SaveRequest): Promise<SaveResult>;
  log(repoPath: string): SettingsLogEntry[];
  /** Fetches the meta ref and pushes what waits: the other machines' saves arrive this way. Never throws for a sharing problem. */
  fetch(repoPath: string, remote: string, machine: string, multiplayer?: boolean): Promise<SharingReport>;
  /** Ends every git still running (a push in flight). */
  stop(): Promise<void>;
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

function gitText(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: gitEnvironment() });
}

export function metaSettings(options: { now?: () => string; git?: (args: string[], cwd: string) => string } = {}): MetaSettings {
  const now = options.now ?? (() => new Date().toISOString());
  const git = options.git ?? gitText;
  // One writer per clone and machine, so its lock covers every save; singleplayer or multiplayer is asked at each round (`shares`).
  const writers = new Map<string, { writer: Writer; runners: StoppableGit[]; remote: string; multiplayer: boolean }>();
  const writerFor = (repoPath: string, remote: string, machine: string, multiplayer = true): Writer => {
    const key = JSON.stringify([repoPath, machine]);
    const known = writers.get(key);
    if (known && known.remote === remote) {
      known.multiplayer = multiplayer;
      return known.writer;
    }
    const local = gitIn(repoPath);
    const network = gitIn(repoPath, { timeoutMs: 5 * 60_000 });
    let checked: Promise<void> | undefined;
    const writer = createWriter({
      git: local,
      network,
      ref: META_REF,
      remote,
      shares: () => entry.multiplayer,
      person: COMMITTER,
      machine,
      now,
      repoDir: repoPath,
      before: async () => {
        checked ??= checkRepoRoot(local, repoPath);
        await checked.catch((error: unknown) => {
          checked = undefined;
          throw error;
        });
      },
    });
    const entry = { writer, runners: [local, network], remote, multiplayer };
    writers.set(key, entry);
    return writer;
  };

  // The settings at the meta commit last read, so an unchanged ref costs one git process.
  let last: { repo: string; commit: string; read: SharedRead } | null = null;
  const tip = (repoPath: string): string | null => {
    try {
      return git(["rev-parse", "--verify", "--quiet", `${META_REF}^{commit}`], repoPath).trim() || null;
    } catch {
      return null;
    }
  };

  return {
    read(repoPath) {
      const commit = tip(repoPath);
      if (commit === null) return { ok: false, error: `${repoPath} has no ${META_REF}, so there are no shared settings to read. On a project Scope Soup already runs, start Scope Soup (it fetches ${META_REF}) or fetch it: git -C "${repoPath}" fetch origin ${META_REF}:${META_REF}. On a new project, the onboarding skill writes them (pnpm settings:init).` };
      if (last && last.repo === repoPath && last.commit === commit) return last.read;
      let read: SharedRead;
      try {
        read = { ok: true, text: git(["cat-file", "blob", `${commit}:${SETTINGS_FILE}`], repoPath), commit };
      } catch {
        read = { ok: false, error: `${META_REF} in ${repoPath} (${commit.slice(0, 7)}) has no ${SETTINGS_FILE}: the project's shared settings were never written. The onboarding skill writes them (pnpm settings:init).` };
      }
      last = { repo: repoPath, commit, read };
      return read;
    },

    async save(request) {
      const writer = writerFor(request.repoPath, request.remote, request.machine, request.multiplayer);
      try {
        const done = await writer.writeSettings((text) => {
          let current: unknown = {};
          if (text !== null) {
            try {
              current = JSON.parse(text);
            } catch {
              throw new RefusedWrite(`${SHARED_WHERE} are not valid JSON; fix them on ${META_REF} first.`);
            }
          }
          if (!isObj(current)) throw new RefusedWrite(`${SHARED_WHERE} are not a JSON object; fix them on ${META_REF} first.`);
          const next = request.update(structuredClone(current));
          const changes: SettingChange[] = settingChanges(current, next);
          return changes.length === 0 ? null : { text: settingsText(next), changes };
        }, { who: request.by });
        return { ok: true, commit: done.commit, changed: done.changed, changes: done.changes, sharing: { state: done.sharing.state, ...(done.sharing.problem ? { problem: done.sharing.problem } : {}) } };
      } catch (error) {
        return { ok: false, refused: error instanceof SaveRefused || error instanceof RefusedWrite, error: error instanceof Error ? error.message : String(error) };
      }
    },

    log(repoPath) {
      const commit = tip(repoPath);
      if (commit === null) return [];
      let text: string;
      try {
        text = git(["cat-file", "blob", `${commit}:${SETTINGS_LOG}`], repoPath);
      } catch {
        return [];
      }
      const entries: SettingsLogEntry[] = [];
      for (const entry of parseLog(text).entries) {
        if (entry.kind !== "settings" || !Array.isArray(entry.data.changes)) continue;
        const changes = (entry.data.changes as unknown[]).filter((change): change is SettingChange => isObj(change) && typeof change.key === "string");
        entries.push({ at: entry.at, who: entry.by.who, ...(entry.by.machine ? { machine: entry.by.machine } : {}), changes });
      }
      // Newest first: by time, and for the same time the later line first.
      return entries.reverse().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    },

    fetch(repoPath, remote, machine, multiplayer) {
      return writerFor(repoPath, remote, machine, multiplayer).share();
    },

    async stop() {
      await Promise.all([...writers.values()].flatMap((each) => each.runners.map((runner) => runner.stop())));
    },
  };
}
