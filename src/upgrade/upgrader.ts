// Checking for a new Scope Soup and switching to it, behind the Settings page's buttons:
//
// - The check reads the newest GitHub release of Scope Soup's own repository once a day and when asked. No automatic upgrade.
// - "Get latest" downloads the release zip, checks it, unpacks it into its own folder in the home, pauses agents and
//   merging and waits until no session and no queue batch runs (a running check is never cut), copies the database and
//   the config, switches the pointer and asks the launcher to start the new version (exit code 75).
// - Pausing is only for the wait: what was running (agents, the merge queue) is remembered, kept across the restart in the
//   store, and started again once the version that comes up is listening; what was paused stays paused. The board says so.
// - "Go back to X.Y.Z" waits the same way and switches the pointer one step back, to the version the last switch left.
// - At most two versions on disk: the older one goes at the next upgrade, or once the current one ran cleanly for a day.
//
// Everything outside (the network, the store, the clock, the exit) comes in through the deps, so tests use fakes.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cleanUp, markStarted, previousFolder, readPointer, readState, switchPointer } from "./home.ts";
import type { Release, ReleasesDeps } from "./releases.ts";
import { downloadAsset, latestRelease } from "./releases.ts";
import { unpackRelease } from "./unpack.ts";
import { compareVersions, folderOf, versionOfFolder } from "./version.ts";

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const LOOK_EVERY_MS = 60 * 60 * 1000;
/** How long the note "Upgraded to ...; agents started again as before" stays on the board. */
export const NOTE_FOR_MS = 60 * 60 * 1000;
/** A remembered state older than this is not restored: it belongs to a switch that did not lead to a restart. */
const RESUME_FOR_MS = 60 * 60 * 1000;

export type { TaskState, UpgradeTask, UpgradeView } from "./view.ts";
import type { TaskState, UpgradeTask, UpgradeView } from "./view.ts";

/** What was running when Get latest or Go back paused: the switches to start again afterwards. */
export interface Resume {
  agents: boolean;
  mergeQueue: boolean;
}

interface Remembered extends Resume {
  kind: "upgrade" | "back";
  /** The version switched to. */
  to: string;
  at: string;
}

export interface UpgraderDeps {
  /** The folder this version runs from. */
  root: string;
  version: string;
  home: string | null;
  checkout: boolean;
  now: () => Date;
  /** Where releases are read from; null when the update check is off (`checkOff` says why). */
  releases: ReleasesDeps | null;
  checkOff?: string;
  /** Null when no session and no queue batch runs; otherwise what is still running. */
  busy: () => string | null;
  /** Pauses agents and the merge queue, so nothing new starts while it waits; says which of them were running. */
  pause: () => Resume;
  /** Starts agents and/or the merge queue again (the ones that are true). */
  resume: (what: Resume) => void;
  /** Copies the database and the config into `dir`; returns the copies. */
  backup: (dir: string) => string[];
  /** Stops Scope Soup and exits with RESTART_EXIT_CODE; null when it was not started by the launcher, which owns the restart. */
  restart: (() => void) | null;
  /** Writes an event in the store. */
  record: (kind: string, data: Record<string, unknown>) => void;
  /** The last check, kept across restarts (the store's small values). */
  loadCheck: () => string | null;
  saveCheck: (value: string) => void;
  /** What to start again after the restart (JSON), kept in the store; "" when there is none. */
  loadResume: () => string | null;
  saveResume: (value: string) => void;
  /** The note on the board about it (JSON), kept in the store; "" when there is none. */
  loadNote: () => string | null;
  saveNote: (value: string) => void;
  pollMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Upgrader {
  view(): UpgradeView;
  check(): Promise<UpgradeView>;
  getLatest(): UpgradeView;
  goBack(): UpgradeView;
  /** Stops waiting for idle. What was unpacked stays; agents and the merge queue stay paused. */
  cancel(): UpgradeView;
  /** After the orchestrator came up paused: starts again what the switch paused, and puts the note on the board. */
  restore(): void;
  /** Takes the note off the board. */
  dismissNote(): UpgradeView;
  /** Marks this version as started, cleans up, and checks once a day. */
  start(): void;
  stop(): void;
  /** Resolves when the running task is over (tests). */
  settled(): Promise<void>;
}

interface Checked {
  at: string;
  latest: Release | null;
  problem: string | null;
}

export function createUpgrader(deps: UpgraderDeps): Upgrader {
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const pollMs = deps.pollMs ?? 5000;
  const iso = (): string => deps.now().toISOString();
  const folder = basename(deps.root);
  let checked: Checked | null = null;
  try {
    const raw = deps.loadCheck();
    if (raw) checked = JSON.parse(raw) as Checked;
  } catch {
    checked = null;
  }
  let checking: Promise<void> | null = null;
  let task: UpgradeTask | null = null;
  let running: Promise<void> | null = null;
  let waitTimer: unknown;
  let lookTimer: unknown;
  let cancelled = false;
  /** What was running before the pause of the switch under way. */
  let remembered: Resume | null = null;

  const install = deps.checkout ? "checkout" : deps.home ? "release" : "folder";
  const active = (): boolean => task !== null && task.state !== "done" && task.state !== "failed";
  const setTask = (state: TaskState, text: string, kind = task?.kind ?? "upgrade", to = task?.to ?? ""): void => {
    task = { kind, to, state, text, at: iso() };
  };

  function noHome(): string | null {
    if (deps.checkout) return "This Scope Soup runs from a development checkout: update it with git. Get latest is for a release in Scope Soup's home (docs/RUNNING.md, \"Installing and upgrading\").";
    if (!deps.home) return `This release does not run from Scope Soup's home: the folder above ${deps.root} has no file "current". Run \`pnpm setup-home\` in the release folder once (docs/RUNNING.md, "Installing and upgrading").`;
    if (readPointer(deps.home) !== folder) return `The home's pointer names ${readPointer(deps.home) ?? "nothing"}, not this version (${folder}): restart Scope Soup with the launcher first.`;
    return null;
  }

  function view(): UpgradeView {
    const latest = checked?.latest ?? null;
    const available = latest !== null && compareVersions(latest.version, deps.version) > 0;
    const home = deps.home;
    const blocked = noHome();
    let getLatest: UpgradeView["getLatest"];
    if (blocked) getLatest = { can: false, why: blocked };
    else if (active()) getLatest = { can: false, why: "A switch is under way." };
    else if (!available) getLatest = { can: false, why: latest ? `This is the newest release (${latest.version}).` : "No newer release is known." };
    else if (!latest?.zip) getLatest = { can: false, why: `The release ${latest?.version} has no scopesoup-${latest?.version}.zip attached.` };
    else getLatest = { can: true };
    const previous = home && !deps.checkout ? previousFolder(home) : null;
    const backVersion = previous ? versionOfFolder(previous) : null;
    const back: UpgradeView["back"] = backVersion
      ? { version: backVersion, newer: compareVersions(backVersion, deps.version) > 0, ...(blocked ? { can: false, why: blocked } : active() ? { can: false, why: "A switch is under way." } : { can: true }) }
      : null;
    const state = home ? readState(home) : null;
    return {
      now: iso(),
      version: deps.version,
      install,
      home,
      checking: checking !== null,
      checkedAt: checked?.at ?? null,
      checkProblem: checked?.problem ?? null,
      checkOff: deps.releases ? null : (deps.checkOff ?? "The update check is off."),
      latest: latest ? { version: latest.version, notes: latest.notes, page: latest.page, publishedAt: latest.publishedAt } : null,
      available,
      getLatest,
      back,
      task,
      note: readNote(),
      lastSwitch: state ? { from: state.from, to: state.to, at: state.at, ...(state.failedStart ? { failedStart: state.failedStart } : {}), ...(state.backup ? { backup: state.backup } : {}) } : null,
    };
  }

  function readNote(): { text: string; at: string } | null {
    try {
      const raw = deps.loadNote();
      const note = raw ? (JSON.parse(raw) as { text?: unknown; at?: unknown }) : null;
      if (!note || typeof note.text !== "string" || typeof note.at !== "string") return null;
      return deps.now().getTime() - Date.parse(note.at) < NOTE_FOR_MS ? { text: note.text, at: note.at } : null;
    } catch {
      return null;
    }
  }

  async function check(): Promise<UpgradeView> {
    if (!deps.releases) return view();
    if (!checking) {
      const releases = deps.releases;
      checking = (async () => {
        try {
          const latest = await latestRelease(releases);
          checked = { at: iso(), latest, problem: null };
        } catch (error) {
          checked = { at: iso(), latest: checked?.latest ?? null, problem: `The check failed: ${error instanceof Error ? error.message : String(error)}.` };
        }
        deps.saveCheck(JSON.stringify(checked));
        const newer = checked.latest && compareVersions(checked.latest.version, deps.version) > 0 ? checked.latest.version : null;
        deps.record("scopesoup.update_checked", { version: deps.version, latest: checked.latest?.version ?? null, available: newer, ...(checked.problem ? { reason: checked.problem } : {}) });
      })().finally(() => {
        checking = null;
      });
    }
    await checking;
    return view();
  }

  /** Pauses, waits until nothing runs, then copies and switches. */
  function switchWhenIdle(to: string, kind: "upgrade" | "back", resolve: () => void): void {
    const home = deps.home!;
    remembered = deps.pause();
    const look = (): void => {
      waitTimer = undefined;
      if (cancelled) return resolve();
      const busy = deps.busy();
      if (busy) {
        setTask("waiting", `Waiting until nothing runs: ${busy}. Agents and merging are paused, so nothing new starts.`);
        waitTimer = setTimer(look, pollMs);
        return;
      }
      try {
        setTask("switching", `Switching to ${versionOfFolder(to)}.`);
        let backup: string | undefined;
        if (kind === "upgrade") {
          // Before the new version may migrate anything: the database and the config, and only the newest such copy.
          backup = join(home, "backups", `before-${to}`);
          const backups = join(home, "backups");
          mkdirSync(backups, { recursive: true });
          for (const old of readdirSync(backups)) rmSync(join(backups, old), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          mkdirSync(backup, { recursive: true });
          const copies = deps.backup(backup);
          writeFileSync(join(backup, "from.txt"), `${folder}\n${copies.join("\n")}\n`);
        }
        const state = switchPointer(home, to, iso(), backup);
        // Kept for the version that starts: it starts what was running, once it listens.
        deps.saveResume(JSON.stringify({ ...remembered!, kind, to: versionOfFolder(to) ?? to, at: iso() } satisfies Remembered));
        deps.record(kind === "upgrade" ? "scopesoup.upgraded" : "scopesoup.went_back", { from: state.from, to: state.to, ...(backup ? { backup } : {}) });
        if (deps.restart) {
          setTask("restarting", `Restarting on ${versionOfFolder(to)}. The board comes back in a moment.`);
          resolve();
          deps.restart();
        } else {
          setTask("done", `The pointer names ${versionOfFolder(to)} now. Scope Soup was not started by the launcher, so start it again with \`scopesoup start\`.`);
          resolve();
        }
      } catch (error) {
        fail(error);
        resolve();
      }
    };
    look();
  }

  function fail(error: unknown): void {
    const text = `${task?.kind === "back" ? "Going back" : "Get latest"} stopped: ${error instanceof Error ? error.message : String(error)}`;
    setTask("failed", text);
    deps.record("scopesoup.upgrade_failed", { reason: text });
    // Nothing switched, so nothing restarts: start again what the wait paused.
    if (remembered) {
      deps.resume(remembered);
      deps.record("scopesoup.resumed", { ...remembered, why: "the switch failed" });
      remembered = null;
    }
  }

  function getLatest(): UpgradeView {
    const now = view();
    if (!now.getLatest.can || !checked?.latest?.zip || !deps.releases) return now;
    const release = checked.latest;
    const zip = release.zip!;
    const releases = deps.releases;
    const home = deps.home!;
    cancelled = false;
    setTask("downloading", `Downloading ${zip.name}.`, "upgrade", folderOf(release.version));
    deps.record("scopesoup.upgrade_started", { from: deps.version, to: release.version });
    running = new Promise<void>((resolve) => {
      void (async () => {
        try {
          // At the next upgrade the version before the current one goes: at most two versions on disk.
          for (const removed of cleanUp(home, deps.now(), true)) deps.record("scopesoup.version_removed", { folder: removed, why: "the next upgrade" });
          const bytes = await downloadAsset(releases, zip);
          let sha = zip.sha256;
          if (!sha && release.checksum) sha = new TextDecoder().decode(await downloadAsset(releases, release.checksum)).trim().split(/\s+/)[0]?.toLowerCase();
          const downloads = join(home, "downloads");
          mkdirSync(downloads, { recursive: true });
          const file = join(downloads, zip.name);
          writeFileSync(file, bytes);
          try {
            if (cancelled) return resolve();
            setTask("downloading", `Checking and unpacking ${zip.name}.`);
            unpackRelease(file, home, { version: release.version, size: zip.size, ...(sha ? { sha256: sha } : {}) }, [folder]);
          } finally {
            rmSync(file, { force: true });
          }
          if (cancelled) return resolve();
          switchWhenIdle(folderOf(release.version), "upgrade", resolve);
        } catch (error) {
          fail(error);
          resolve();
        }
      })();
    });
    return view();
  }

  function goBack(): UpgradeView {
    const now = view();
    if (!now.back?.can) return now;
    const to = folderOf(now.back.version);
    cancelled = false;
    setTask("waiting", `Going back to ${now.back.version}.`, "back", to);
    running = new Promise<void>((resolve) => switchWhenIdle(to, "back", resolve));
    return view();
  }

  function cancel(): UpgradeView {
    if (task && (task.state === "waiting" || task.state === "downloading")) {
      cancelled = true;
      if (waitTimer !== undefined) clearTimer(waitTimer);
      waitTimer = undefined;
      remembered = null;
      setTask("failed", `Cancelled. Agents and merging stay paused: press Start to go on.`);
      deps.record("scopesoup.upgrade_cancelled", { to: task.to });
    }
    return view();
  }

  function restore(): void {
    let raw: string | null = null;
    try {
      raw = deps.loadResume();
    } catch {
      raw = null;
    }
    if (!raw) return;
    deps.saveResume("");
    let kept: Remembered;
    try {
      kept = JSON.parse(raw) as Remembered;
      if (typeof kept.to !== "string" || typeof kept.at !== "string" || typeof kept.agents !== "boolean" || typeof kept.mergeQueue !== "boolean") return;
    } catch {
      return;
    }
    if (deps.now().getTime() - Date.parse(kept.at) > RESUME_FOR_MS) return;
    const what: Resume = { agents: kept.agents, mergeQueue: kept.mergeQueue };
    if (what.agents || what.mergeQueue) deps.resume(what);
    const started = what.agents && what.mergeQueue ? "agents and the merge queue started again as before" : what.agents ? "agents started again as before" : what.mergeQueue ? "the merge queue started again as before" : "agents and the merge queue were paused before and stay paused";
    const lead = deps.version === kept.to ? `${kept.kind === "back" ? "Went back to" : "Upgraded to"} ${kept.to}` : `Version ${kept.to} did not start; back on ${deps.version}`;
    const text = `${lead}; ${started}`;
    deps.record("scopesoup.resumed", { ...what, version: deps.version, text });
    deps.saveNote(JSON.stringify({ text, at: iso() }));
  }

  function dismissNote(): UpgradeView {
    deps.saveNote("");
    return view();
  }

  function look(): void {
    lookTimer = undefined;
    if (deps.home && !deps.checkout && !active()) {
      try {
        for (const removed of cleanUp(deps.home, deps.now())) deps.record("scopesoup.version_removed", { folder: removed, why: "the current version ran cleanly for a day" });
      } catch (error) {
        deps.record("scopesoup.upgrade_failed", { reason: `Removing the older version failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const due = !checked || deps.now().getTime() - Date.parse(checked.at) >= CHECK_EVERY_MS;
    if (deps.releases && due) void check();
    lookTimer = setTimer(look, LOOK_EVERY_MS);
    if (typeof (lookTimer as { unref?: () => void } | undefined)?.unref === "function") (lookTimer as { unref: () => void }).unref();
  }

  return {
    view,
    check,
    getLatest,
    goBack,
    cancel,
    restore,
    dismissNote,
    start() {
      if (deps.home && !deps.checkout) markStarted(deps.home, folder, iso());
      look();
    },
    stop() {
      if (lookTimer !== undefined) clearTimer(lookTimer);
      if (waitTimer !== undefined) clearTimer(waitTimer);
      lookTimer = waitTimer = undefined;
    },
    async settled() {
      await checking;
      await running;
    },
  };
}
