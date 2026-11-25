// Starts Scope Soup: the store, the sync from the configured host, the board's server and, when a
// project configuration is present, the orchestrator. Everything here is wiring.
//
// Settings that belong to this installation (not to the project) come from the environment:
//   SCOPESOUP_DATA           directory for the database (default: "data" beside the config file found, else ./data; refused inside a git working tree)
//   SCOPESOUP_HOST           address to listen on (default 127.0.0.1)
//   SCOPESOUP_PORT           port (default 4310)
//   SCOPESOUP_ALLOW_LAN      "1" to allow an address other than loopback; there is no login yet
//   SCOPESOUP_META_REPO      a git repository (path) whose meta ref holds the items (docs/DESIGN.md,
//                         "Items on a meta branch"); read straight from its object store; fetched and
//                         written only with SCOPESOUP_META_WRITE=1 ("Writing to the meta branch")
//   SCOPESOUP_META_WRITE     "1" to let Scope Soup create and edit items, append to their logs, and fetch and push the meta ref
//   SCOPESOUP_META_AUTHOR_NAME, SCOPESOUP_META_AUTHOR_EMAIL
//                         with SCOPESOUP_META_WRITE=1: the person meta commits are made as (required)
//   SCOPESOUP_META_PREFIX    with SCOPESOUP_META_WRITE=1: this machine's prefix of item ids (A gives A-12), one per
//                         machine; without it no item is created here
//   SCOPESOUP_META_REMOTE    the remote the meta ref is shared with (default origin; "none" for none)
//   SCOPESOUP_META_FETCH_SECONDS  how often a read fetches the meta ref first (default 60)
//   SCOPESOUP_MERGE_QUEUE=off     do not take the merge queue lease before merging (one machine only)
//   SCOPESOUP_GITHUB_REPO    "owner/name"; without it or SCOPESOUP_META_REPO nothing is synced
//   SCOPESOUP_GITHUB_TOKEN   a token that can read that repository
//   SCOPESOUP_WRITE          "1" to let Scope Soup write to GitHub: issues, labels and comments (docs/github-mapping.md), and at
//                         level 4 with mergeQueue.ci "github" the batches' branches and pull requests. Without it GitHub is
//                         only read. (The meta ref has SCOPESOUP_META_WRITE.) A push is made by git with this machine's own git
//                         credentials to the configured remote; the API calls use the token above.
//   SCOPESOUP_PIPELINES      comma-separated workflow names to keep run history for (estimates)
//   SCOPESOUP_POLL_SECONDS   how often to poll the host (default 20)
//   SCOPESOUP_UPDATE_CHECK   "off": do not ask GitHub for new Scope Soup releases (once a day otherwise)
//   SCOPESOUP_UPDATE_REPO    the repository whose releases are Scope Soup's (default mikaeltulldahl/scopesoup)
//   SCOPESOUP_UPDATE_TOKEN   a token that can read that repository's releases, when it is private
//   SCOPESOUP_UPDATE_API     the API's address (default https://api.github.com; the upgrade trial gives a local fake)
//   SCOPESOUP_CONFIG         this machine's private configuration (default ./scopesoup.config.json, else the config this machine
//                         knows for the git repository Scope Soup is started in, src/config/locate.ts); the project's shared
//                         settings are read from the meta ref refs/scopesoup/meta of the repository it names, fetched at
//                         start and every minute. Without the file the orchestrator stays off
//
// The project's host can instead be set in the shared settings (`host`). Then they win and
// the GITHUB_REPO, WRITE and META_* variables above are not read (src/hostSetup.ts). SCOPESOUP_MACHINE is never read: machineName names the machine.
// Tokens are read from the environment only.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startDataDir } from "./dataDir.ts";
import { createMedia } from "./orchestrator/media.ts";
import { createConfigLoader } from "./config/loader.ts";
import { findConfig } from "./config/locate.ts";
import { metaSettings } from "./config/metaSettings.ts";
import { repositoryOf } from "./config/shared.ts";
import { recommendations } from "./config/recommend.ts";
import { createHosts, describeHosts, hostSettings, ignoredVariables, machineSetup } from "./hostSetup.ts";
import { remoteBranches } from "./items/remoteBranch.ts";
import { jiraBoard } from "./items/jiraBackend.ts";
import type { JiraHost } from "./hosts/jira/index.ts";
import type { HostSettings } from "./hostSetup.ts";
import type { GitHubHost } from "./hosts/github/index.ts";
import { createMergeQueue } from "./orchestrator/mergeQueue.ts";
import { createResources, unitRef } from "./orchestrator/resources.ts";
import type { Resources } from "./orchestrator/resources.ts";
import type { MergeQueue } from "./orchestrator/mergeQueue.ts";
import type { MetaBranchHost } from "./hosts/metaBranch/index.ts";
import { describeMigration, migrateMetaFormat } from "./hosts/metaBranch/migrate.ts";
import { createHostActions } from "./orchestrator/hostActions.ts";
import { createLoop } from "./orchestrator/loop.ts";
import type { Loop } from "./orchestrator/loop.ts";
import { createKeepAwake, shouldStayAwake } from "./orchestrator/keepAwake.ts";
import type { KeepAwake } from "./orchestrator/keepAwake.ts";
import { dryActions } from "./orchestrator/ports.ts";
import type { LabelChange, Ref, WorkItem } from "./model/types.ts";
import { itemDiff } from "./orchestrator/diff.ts";
import { openInDiffTool } from "./orchestrator/diffTool.ts";
import { commitView, projectHistory } from "./orchestrator/history.ts";
import { loadSnapshot } from "./server/snapshot.ts";
import { desktopNotify, answerWaitTickHook } from "./orchestrator/answerWait.ts";
import { realGit, realProcesses } from "./orchestrator/process.ts";
import { createCheckRunner } from "./orchestrator/checkRunner.ts";
import { createSetupRunner } from "./orchestrator/setup.ts";
import { createQueueDriver, githubCiRefusal } from "./orchestrator/queueDriver.ts";
import { remoteMismatch } from "./orchestrator/remote.ts";
import { createRunner } from "./orchestrator/runner.ts";
import { allowancePlans } from "./orchestrator/allowance.ts";
import { usageReserve } from "./orchestrator/tick.ts";
import type { Runner } from "./orchestrator/runner.ts";
import type { AnswerWrite, Host, WorkPatch } from "./ports/host.ts";
import { createServer } from "./server/server.ts";
import { recordInManifest } from "./config/manifest.ts";
import { planFor } from "./offboard/cli.ts";
import { defaultOutFolder } from "./offboard/scan.ts";
import { githubPage, projectInfo } from "./server/project.ts";
import type { ProjectInfo } from "./server/project.ts";
import { gitRemoteUrl } from "./config/mergeQueue.ts";
import type { AssumptionHost } from "./server/server.ts";
import { createChat } from "./orchestrator/chat.ts";
import { mergeQueueOn, mergeQueueStopped, pauseRemembering, roleStopped, startAgain } from "./store/control.ts";
import { KEYS } from "./store/keys.ts";
import { createBranchProtection } from "./server/branchProtection.ts";
import { NEWER_STORE, STORE_VERSION } from "./store/schema.ts";
import { openStore } from "./store/store.ts";
import type { Store } from "./store/store.ts";
import { createSync } from "./sync/index.ts";
import { homeOf, revertFailedStart } from "./upgrade/home.ts";
import { DEFAULT_REPO } from "./upgrade/releases.ts";
import { createUpgrader } from "./upgrade/upgrader.ts";
import type { Upgrader } from "./upgrade/upgrader.ts";
import { RESTART_EXIT_CODE, isCheckout, versionOf } from "./upgrade/version.ts";
import type { QueueDriver } from "./orchestrator/queueDriver.ts";

const env = process.env;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iso = (): string => new Date().toISOString();
/** This version, and the home it runs from (a release folder beside the pointer), or null for a checkout. */
const version = versionOf(root);
const checkout = isCheckout(root);
const home = checkout ? null : homeOf(root);
const launched = env.SCOPESOUP_LAUNCHER === "1";

async function main(): Promise<void> {
  // The configuration file is read first: its `host`, when present, wins over the environment.
  // --config is not taken here; SCOPESOUP_CONFIG, ./scopesoup.config.json, else the config this machine knows for the repository.
  const found = findConfig({ env, cwd: env.INIT_CWD ?? process.cwd() });
  if (!found.ok) console.log(found.error);
  const configFile = found.file;
  const data = startDataDir(env, found.ok ? configFile : null);
  if (!data.ok) throw new Error(data.error);
  const dataDir = data.dir;
  mkdirSync(dataDir, { recursive: true });
  const storePath = join(dataDir, "scopesoup.sqlite");
  const store = openStore(storePath);
  // A newer database is read only: the server writes from its first tick, so it does not start on one.
  if (store.format.readOnly) {
    store.close();
    throw new Error(`${storePath} is version ${store.format.version} and this Scope Soup knows versions 0 to ${STORE_VERSION}: ${NEWER_STORE}. Nothing was changed.`);
  }
  store.appendEvent({ kind: "scopesoup.started", actor: "scopesoup", data: { pid: process.pid, version } }, iso());
  console.log(`Scope Soup ${version}${checkout ? " (development checkout)" : home ? ` from ${home}` : ""}.`);
  if (store.format.migratedFrom !== null) {
    const { migratedFrom: from, version: to, copy } = store.format;
    console.log(`${storePath} was migrated from version ${from} to version ${to}${copy ? `; the old database is kept as ${copy}` : ""}.`);
    store.appendEvent({ kind: "scopesoup.store_migrated", actor: "scopesoup", data: { from, to, copy } }, iso());
  }

  // The shared settings are on the meta ref: fetched before the first read (a new clone does not have it), then every minute.
  const shared = metaSettings({ now: iso });
  const fetchShared = async (): Promise<void> => {
    // Read each time: singleplayer (nothing fetched or pushed) can be switched on the Settings page.
    const repository = existsSync(configFile) ? privateWhere(configFile) : null;
    if (!repository?.machine) return;
    const report = await shared.fetch(repository.repoPath, repository.remote, repository.machine, repository.multiplayer);
    if (report.problem) console.log(`Fetching the shared settings (refs/scopesoup/meta): ${report.problem}`);
  };
  await fetchShared();
  const sharedTimer = setInterval(() => void fetchShared(), 60_000);
  sharedTimer.unref();
  const config = existsSync(configFile) ? createConfigLoader(configFile, undefined, { shared, sharedTtlMs: 2000 }) : null;
  const first = config?.load();
  if (first && !first.config) throw new Error(`${configFile}: ${first.error ?? "could not be read"}`);
  const hostSet = hostSettings(first?.config ?? null, env, (path) => resolve(path));
  // What this machine lacks for the project's host (a token, the Jira Cloud email): the board asks for it ("Set up this machine"),
  // and until it is there the host is not read and no agent starts (decision 98).
  const setup = machineSetup(first?.config ?? null, env);
  if (setup) {
    delete hostSet.github;
    delete hostSet.jira;
    console.log(`This machine is not set up for the project's ${setup.kind === "jira" ? "Jira" : "GitHub"} host: ${setup.missing.join(" and ")} missing. The board asks for it; no agent starts until it is there and Scope Soup is started again.`);
  }
  // Singleplayer or multiplayer as the file says now: a switch on the Settings page holds from the next sharing round.
  const multiplayer = (): boolean => config?.load().config?.multiplayer ?? first?.config?.multiplayer ?? true;
  if (hostSet.shares) hostSet.shares = multiplayer;
  const ignored = ignoredVariables(hostSet, env);
  if (ignored.length > 0) console.log(`The configuration file has a host, so these are not read: ${ignored.join(", ")}.`);
  if (env.SCOPESOUP_MACHINE !== undefined) console.log("SCOPESOUP_MACHINE is no longer read: the configuration file's machineName names this machine.");
  // What Scope Soup makes outside its config folder goes on the manifest, for offboarding.
  const configured = createHosts(hostSet, env, console.log, existsSync(configFile) ? (repo, name) => void recordInManifest(configFile, [{ kind: "label", repo, name }], "scopesoup") : undefined,
    (key, reason) => {
      console.log(`Jira: ${key} ${reason}`);
      store.appendEvent({ kind: "jira.created_outside_filter", subject: `jira:work:${key}`, actor: "scopesoup", data: { reason: `${key} ${reason}` } }, iso());
    });
  if (first?.config) {
    recordInManifest(configFile, [
      { kind: "folder", path: first.config.repoPath, what: "Scope Soup's clone of the project" },
      { kind: "folder", path: first.config.workspacesDir, what: "Scope Soup's worktrees and the merge queue's clone" },
      { kind: "folder", path: first.config.streamsDir, what: "the sessions' streams and saved leftovers" },
      { kind: "folder", path: dataDir, what: "the data folder (Scope Soup's database)" },
    ], "scopesoup");
  }
  // Agents' images: kept in the data folder, pushed to refs/scopesoup/media/<id> only when the project says so (`media.push`).
  const media = createMedia({ dataDir, store, config: () => config?.load().config ?? null, ...(existsSync(configFile) ? { configFile } : {}), now: iso, env });
  // A closed Item's images go `media.keepDaysAfterClose` days after it closed; looked at every hour.
  const mediaTimer = setInterval(() => void media.expire(store.list<WorkItem>("work")).catch(() => undefined), 60 * 60_000);
  mediaTimer.unref();
  const sync = createSync({
    store,
    hosts: configured,
    intervalMs: Number(env.SCOPESOUP_POLL_SECONDS ?? 20) * 1000,
    pipelines: (env.SCOPESOUP_PIPELINES ?? "").split(",").map((name) => name.trim()).filter(Boolean),
  });

  // The orchestrator needs a project configuration.
  let loop: Loop | null = null;
  let runner: Runner | null = null;
  let keepAwake: KeepAwake | null = null;
  // Set below: the orchestrator's writable host, which a restructuring accepted on the board may make parts on.
  let restructureHost: Host | undefined;
  // Set below: where an accepted triage draft replaces the issue's description (GitHub with writes on and the right remote).
  let description: { host: string; replace(item: Ref, text: string): Promise<boolean> } | undefined;
  // Set below: where the board's edits of a GitHub Item are written through (GitHub with writes on and the right remote).
  let hostEdit: { host: string; edit(item: Ref, patch: WorkPatch): Promise<boolean> } | undefined;
  // Set below: where the answers are answer comments (GitHub with writes on and the right remote).
  let questions: { host: string; answer(item: Ref, to: string | null, answer: AnswerWrite): Promise<{ open: number } | null>; answerMany?(item: Ref, answers: { to: string | null; answer: AnswerWrite }[]): Promise<{ open: number } | null>; checkDraft?(item: Ref, draft: string): Promise<void> } | undefined;
  // Set below: where a triage draft's label changes are written at Accept (GitHub with writes on and the right remote).
  let labels: { host: string; change(item: Ref, change: LabelChange): Promise<{ added: string[]; removed: string[] } | null> } | undefined;
  // Set below: where a person accepts and overturns the decisions implementors took themselves (the writable host).
  let assumptions: AssumptionHost[] | undefined;
  // Set below: the merge queue lease, which the meta branch's migration takes too.
  let mergeQueue: MergeQueue | undefined;
  // Set below: the limited resources.
  let resources: Resources | undefined;
  // Set below: the merge queue, which Get latest waits for.
  let queue: QueueDriver | undefined;
  if (config && first?.config && !setup) {
    for (const notice of first.notices ?? []) console.log(`Notice: ${notice}`);
    for (const advice of recommendations(first.config)) console.log(`Advice: ${advice}`);
    const current = () => {
      const state = config.load();
      if (!state.config) throw new Error("no project configuration");
      return state.config;
    };
    // The limited resources; a shared one is held on the project's remote, one lease per unit, named by this machine.
    const units = createResources({
      store, config: current, now: iso,
      lease: (resource, unit) => createMergeQueue({ git: realGit, repo: current().repoPath, remote: current().remote, machine: current().machineName, ref: unitRef(resource, unit), doing: `holds ${resource} unit ${unit}`, alone: () => !multiplayer() }),
    });
    // What an earlier run held goes back: its sessions did not survive it.
    resources = units;
    await units.recover();
    // A session's item commands (the triage's search) read this project's configuration, wherever the session runs.
    runner = createRunner({ store, config: current, env: { ...env, SCOPESOUP_CONFIG: configFile }, onFinished: () => loop?.refresh(), stopped: (role) => roleStopped(store, role), resources: units, media });
    // Without a host that may be written to, finished work stays on its local branch.
    // A host that can push branches and open changes; writing items (meta branch) is not that.
    // A host that keeps items' logs itself (meta branch) gets the check and merging lines.
    let writable = configured.find((host) => host.write?.openChange || host.write?.comment) ?? configured.find((host) => host.write?.appendLog);
    // The branches are pushed to the clone's remote, the pull request opened on the GitHub repository. They must be one repository.
    if (writable?.write?.openChange && hostSet.github) {
      const expected = `https://github.com/${hostSet.github.repo}`;
      const mismatch = await remoteMismatch(realGit, first.config.repoPath, first.config.remote, expected);
      if (mismatch) {
        console.log(`Writes stay off: ${mismatch}.`);
        writable = undefined;
      }
    }
    restructureHost = writable?.write?.createWork ? writable : undefined;
    const actions = writable ? createHostActions({ host: writable, git: realGit, config: current, store }) : dryActions;
    console.log(writable ? `Writes to ${writable.info.id} are on.` : "Writes are off: finished work stays on its local branch.");
    if (writable && actions.replaceDescription) description = { host: writable.info.id, replace: actions.replaceDescription };
    if (writable && actions.editItem) hostEdit = { host: writable.info.id, edit: actions.editItem };
    if (writable && actions.changeLabels) labels = { host: writable.info.id, change: actions.changeLabels };
    const settleAssumptions = actions.settleAssumptions;
    if (writable && settleAssumptions) {
      assumptions = [{
        host: writable.info.id,
        async settle(item, picks, by) {
          const outcomes = await settleAssumptions(item, picks, by);
          if (!outcomes) throw new Error(`${item.id} is not an item of ${writable.info.id}.`);
          return outcomes;
        },
      }];
    }
    if (writable && actions.answerQuestion) questions = { host: writable.info.id, answer: actions.answerQuestion, ...(actions.answerQuestions ? { answerMany: actions.answerQuestions } : {}), ...(actions.checkDraft ? { checkDraft: actions.checkDraft } : {}) };
    // Windows: the machine is kept from sleeping while sessions run or work waits (the project can switch it off).
    const awake = createKeepAwake({
      onChange: (holding) => store.appendEvent({ kind: "orchestrator.keep_awake", actor: "orchestrator", data: { holding, reason: holding ? "Keeping the machine awake: sessions run or work is waiting." : "Not keeping the machine awake: there is nothing to do." } }, iso()),
      onProblem: (reason) => store.appendEvent({ kind: "orchestrator.keep_awake_failed", actor: "orchestrator", data: { reason: `Could not keep the machine awake: ${reason}` } }, iso()),
    });
    keepAwake = awake;
    const answerWaitHook = answerWaitTickHook(store, desktopNotify(), () => loadSnapshot(store));
    // Several machines share the main branch: only the one that holds the merge queue lease merges (decision 31). SCOPESOUP_MERGE_QUEUE=off leaves it out.
    const machine = writable?.info.machine;
    mergeQueue = machine && env.SCOPESOUP_MERGE_QUEUE !== "off" ? createMergeQueue({ git: realGit, repo: first.config.repoPath, remote: first.config.remote, machine, alone: () => !multiplayer() }) : undefined;
    if (mergeQueue) console.log(multiplayer() ? `Merging waits for the merge queue lease on ${first.config.remote} (this machine: ${machine}).` : "Singleplayer: the merge queue lease is a local ref, never pushed.");
    // The batches go to remoteUrl and their pull requests to the GitHub host: refused at start when they are not one repository.
    const ciRefused = githubCiRefusal(first.config, hostSet.github?.repo) ?? undefined;
    if (ciRefused) console.log(`Merging waits for no CI: ${ciRefused}.`);
    loop = createLoop({
      store, runner, config, actions, now: iso, resources: units, ...(mergeQueue ? { mergeQueue } : {}),
      // Merging through the merge queue (level 4): its own clone, the check command, Start/Pause merge queue.
      // With mergeQueue.ci "github" the project's CI on the writable GitHub host (remote checked above) checks each batch.
      queue: queue = createQueueDriver({ store, config: current, git: realGit, runCheck: createCheckRunner(realProcesses), runSetup: createSetupRunner(realProcesses, process.env, () => config.load().config ?? undefined), now: iso, paused: () => !mergeQueueOn(store), stopped: () => mergeQueueStopped(store), resources: units, ...(writable?.queueCi && !ciRefused ? { ci: writable.queueCi } : {}), ...(ciRefused ? { ciRefused } : {}) }),
      onTick: (report) => {
        const state = config.load().config;
        awake.set(shouldStayAwake({ enabled: state?.keepAwake ?? false, level: state?.level ?? 0, paused: report.paused === true, running: report.running, queued: report.queued, waitingForTime: report.wakeAt !== undefined }));
        // Idle because everything ready waits for an answer: one desktop notification per stretch (the board's idle line is the fallback).
        void answerWaitHook(report);
      },
    });
  }

  // Start, Pause and Stop must act now, not at the next tick.
  store.onEvent((event) => {
    if (event.kind.startsWith("control.") || event.kind === "person.answered") loop?.refresh();
  });

  const staticDir = join(root, "web", "dist");
  // The Items an Item blocks are asked of GitHub when its page opens, with writes on or off.
  const blockingHost = configured.find((host): host is GitHubHost => "blocking" in host);
  // The host items are created and edited on from the board, with a log of their own (meta branch with SCOPESOUP_META_WRITE=1).
  // GitHub Items are edited through `hostEdit` instead.
  const itemHost = configured.find((host) => host.write?.createWork && host.write.editWork && host.write.appendLog);
  // Jira Items with writes on: the Item page's Claim, Hand back and Release act there for the board's person, through this token.
  const jiraHost = configured.find((host): host is JiraHost => "people" in host && !!host.write?.recordHandback && !!host.write.setAssignees);
  // A person's chat with an Item's sessions, through the runner (so the tick sees it as the Item's session).
  const chat = runner && config ? createChat({ store, runner, config: () => {
    const state = config.load();
    if (!state.config) throw new Error("no project configuration");
    return state.config;
  }, now: iso, ...(resources ? { resources } : {}) }) : undefined;
  // Which project the board belongs to. The remote's URL is read once per clone and remote (git, local only).
  const remoteUrls = new Map<string, string>();
  const remoteUrlOf = (repoPath: string, remote: string): string => {
    const key = `${remote} ${repoPath}`;
    if (!remoteUrls.has(key)) {
      let url = "";
      try {
        url = gitRemoteUrl(repoPath, remote);
      } catch {
        // No such remote, or not a clone: the board shows the remote's name.
      }
      remoteUrls.set(key, url);
    }
    return remoteUrls.get(key) ?? "";
  };
  const project = (): ProjectInfo | null => {
    const loaded = config?.load().config;
    if (loaded) return projectInfo(loaded, configFile, remoteUrlOf);
    // Board only: the host's repository names the project; there are no folders to open.
    const repo = hostSet.github?.repo;
    if (repo) return { name: repo.split("/").pop() ?? repo, repository: repo, github: githubPage(repo), folders: {} };
    return null;
  };
  // The update check, Get latest and Go back. The launcher owns the restart: Scope Soup exits with RESTART_EXIT_CODE.
  let restartAfterStop: (() => void) | null = null;
  const updateOff = env.SCOPESOUP_UPDATE_CHECK === "off";
  const upgrader: Upgrader = createUpgrader({
    root, version, home, checkout, now: () => new Date(),
    releases: updateOff ? null : { fetch, repo: env.SCOPESOUP_UPDATE_REPO || DEFAULT_REPO, token: env.SCOPESOUP_UPDATE_TOKEN || undefined, ...(env.SCOPESOUP_UPDATE_API ? { api: env.SCOPESOUP_UPDATE_API } : {}) },
    checkOff: "The update check is off (SCOPESOUP_UPDATE_CHECK=off).",
    busy: () => {
      const sessions = runner?.running() ?? 0;
      const batches = queue?.state().batches.filter((batch) => batch.status !== "done").length ?? 0;
      const parts = [sessions > 0 ? `${sessions} session${sessions === 1 ? "" : "s"}` : "", batches > 0 ? `${batches} queue batch${batches === 1 ? "" : "es"}` : ""].filter(Boolean);
      return parts.length > 0 ? `${parts.join(" and ")} still running` : null;
    },
    pause: () => pauseRemembering(store, iso(), "upgrade", "scopesoup"),
    resume: (what) => startAgain(store, what, iso(), "upgrade", "scopesoup"),
    backup: (dir) => {
      const copies: string[] = [];
      const db = join(dir, "scopesoup.sqlite");
      store.backupTo(db);
      copies.push(db);
      if (existsSync(configFile)) {
        const copy = join(dir, basename(configFile));
        copyFileSync(configFile, copy);
        copies.push(copy);
      }
      return copies;
    },
    restart: launched ? () => restartAfterStop?.() : null,
    record: (kind, data) => void store.appendEvent({ kind, actor: "scopesoup", data }, iso()),
    loadCheck: () => store.getValue(KEYS.updateCheck),
    saveCheck: (value) => store.setValue(KEYS.updateCheck, value),
    loadResume: () => store.getValue(KEYS.upgradeResume),
    saveResume: (value) => store.setValue(KEYS.upgradeResume, value),
    loadNote: () => store.getValue(KEYS.upgradeNote),
    saveNote: (value) => store.setValue(KEYS.upgradeNote, value),
  });

  // One warning on the board when the GitHub remote's main branch has no protection; nothing when it cannot be told.
  const githubRepo = hostSet.github?.repo;
  const branchProtection = blockingHost && githubRepo
    ? createBranchProtection({
      port: blockingHost.repository, repo: githubRepo, now: Date.now,
      branch: () => config?.load().config?.mainBranch ?? "main",
      loadDismissed: () => store.getValue(KEYS.branchProtectionDismissed),
      saveDismissed: (value) => store.setValue(KEYS.branchProtectionDismissed, value),
    })
    : undefined;

  const server = createServer({
    // This machine lacks what the project's host needs: the board asks for it ("Set up this machine").
    ...(setup ? { machineSetup: setup } : {}),
    upgrade: upgrader,
    media,
    ...(branchProtection ? { branchProtection } : {}),
    store,
    project,
    ...(chat ? { chat } : {}),
    ...(existsSync(staticDir) ? { staticDir } : {}),
    ...(env.SCOPESOUP_HOST ? { host: env.SCOPESOUP_HOST } : {}),
    ...(env.SCOPESOUP_PORT ? { port: Number(env.SCOPESOUP_PORT) } : {}),
    allowLan: env.SCOPESOUP_ALLOW_LAN === "1",
    ...(itemHost?.write ? { items: { host: itemHost.info.id, write: itemHost.write, ...(itemHost.work ? { work: itemHost.work } : {}) } } : {}),
    ...(itemHost?.info.machine ? { machine: itemHost.info.machine } : {}),
    ...(jiraHost ? { jiraItems: jiraBoard(jiraHost, { now: () => new Date() }) } : {}),
    ...(description ? { description } : {}),
    ...(hostEdit ? { hostEdit } : {}),
    ...(questions ? { questions } : {}),
    ...(labels ? { labels } : {}),
    ...(assumptions ? { assumptions } : {}),
    ...(blockingHost ? { blocking: { host: blockingHost.info.id, list: (item: Ref) => blockingHost.blocking(item) } } : {}),
    // Board-only mode has no configuration, and no Settings to change.
    ...(config
      ? {
          planning: () => {
            const loaded = config.load().config;
            return loaded
              ? {
                  bugLabels: loaded.bugLabels,
                  plannedSessions: loaded.settings.maxParallelSessions.value,
                  reserve: usageReserve(loaded),
                  allowances: allowancePlans(loaded, usageReserve(loaded).seven_day),
                  level: loaded.level,
                  ...(loaded.resources ? { resources: loaded.resources } : {}),
                }
              : { bugLabels: ["bug"] };
          },
        }
      : {}),
    ...(config
      ? {
          diff: (ref: Ref) =>
            itemDiff(
              {
                store,
                config: () => {
                  const state = config.load();
                  if (!state.config) throw new Error("no project configuration");
                  return state.config;
                },
                git: realGit,
                now: () => new Date(),
              },
              ref,
            ),
          openDiff: (ref: Ref, file?: string) =>
            openInDiffTool(
              {
                store,
                config: () => {
                  const state = config.load();
                  if (!state.config) throw new Error("no project configuration");
                  return state.config;
                },
                git: realGit,
                now: () => new Date(),
              },
              ref,
              file,
            ),
        }
      : {}),
    ...(config
      ? (() => {
          const deps = {
            config: () => {
              const state = config.load();
              if (!state.config) throw new Error("no project configuration");
              return state.config;
            },
            git: realGit,
            now: () => new Date(),
          };
          return {
            history: (limit: number) => projectHistory({ ...deps, works: () => loadSnapshot(store).works }, limit),
            commit: (sha: string) => commitView(deps, sha),
          };
        })()
      : {}),
    // A person's hand-back is read from the project's remote, into the repository Scope Soup works from.
    ...(config
      ? {
          branches: remoteBranches(realGit, () => {
            const loaded = config.load().config;
            if (!loaded) throw new Error("no project configuration");
            return { repo: loaded.repoPath, remote: loaded.remote, mainBranch: loaded.mainBranch };
          }),
        }
      : {}),
    // A project setting saved on the Settings page is one commit on the meta ref, in effect at once (src/config/metaSettings.ts).
    ...(config
      ? {
          configFile,
          onConfigChanged: () => loop?.refresh(),
          sharedSettings: shared,
          settingsLog: () => {
            const loaded = config.load().config;
            return loaded ? shared.log(loaded.repoPath) : [];
          },
          // The Settings page's "Stop using Scope Soup": the offboarding plan, read only.
          offboard: async () => {
            const { setup, plan } = await planFor(configFile, { dataDir });
            return { now: iso(), available: true as const, plan, configFolder: setup.configFolder, outFolder: defaultOutFolder(setup.configFolder) };
          },
        }
      : {}),
    // Each item's restructuring goes to its own host: the orchestrator's writable one (GitHub with writes on and the right remote), and the
    // host items are written on here (meta branch), when both are configured. GitHub keeps an item's verification in its text.
    restructure: [restructureHost, itemHost]
      .filter((host, index, all): host is Host => host?.write?.createWork !== undefined && all.findIndex((other) => other?.info.id === host.info.id) === index)
      .map((host) => ({ host: host.info.id, write: host.write!, ...(host.work ? { read: (ref: Ref) => host.work!.getWork(ref) } : {}), ...(host.info.id === "github" ? { verificationInBody: true, issueNumbers: true } : {}) })),
    syncNow: async () => {
      await sync.refreshNow();
      loop?.refresh();
    },
    onRefresh: () => {
      void sync.refreshNow();
      loop?.refresh();
    },
  });

  const where = await server.start();
  upgrader.start();
  if (configured.length > 0) sync.start();
  const stopMigration = startMetaMigration(configured, mergeQueue, hostSet.meta, store, multiplayer);
  loop?.start();
  // The orchestrator came up paused: start again what Get latest or Go back paused, as it was before.
  upgrader.restore();
  console.log(`Scope Soup is listening on ${where.url}`);
  console.log(describeHosts(hostSet));
  console.log(loop ? `Orchestrator on, configuration ${configFile}.` : `Orchestrator off: no ${configFile}.`);
  if (!existsSync(staticDir)) console.log("The web app is not built (pnpm web:build): only the API is served.");

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: stopping.`);
    sync.stop();
    upgrader.stop();
    stopMigration();
    clearInterval(sharedTimer);
    clearInterval(mediaTimer);
    await shared.stop();
    await Promise.all(configured.map((host) => host.stop?.()));
    await loop?.stop();
    runner?.stopAll("Scope Soup is stopping.");
    await keepAwake?.stop();
    await server.stop();
    store.appendEvent({ kind: "scopesoup.stopped", actor: "scopesoup", data: { signal } }, iso());
    store.close();
  };
  restartAfterStop = () => void stop("upgrade").then(() => process.exit(RESTART_EXIT_CODE));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

/** Where this machine's private file says the repository is; null when the file cannot be read (the loader says why). */
function privateWhere(file: string): ReturnType<typeof repositoryOf> | null {
  try {
    return repositoryOf(JSON.parse(readFileSync(file, "utf8")) as unknown, dirname(file));
  } catch {
    return null;
  }
}

/**
 * A meta branch of an older format is migrated, in one commit, by the machine that holds the merge queue lease. Tried
 * at start and every two minutes while it waits (for the lease, or for the remote); once the branch is this Scope Soup's
 * format, or a newer one (read only here), it stops. Each new outcome is printed and written as `scopesoup.meta_format`.
 * The lease is merging's (`merge queue`, on the project's remote); without one (SCOPESOUP_MERGE_QUEUE=off: one machine only, or a
 * meta branch with no remote) the migration needs none. Returns a function that stops the retries.
 */
function startMetaMigration(hosts: Host[], mergeQueue: MergeQueue | undefined, meta: HostSettings["meta"], store: Store, multiplayer: () => boolean): () => void {
  const host = hosts.find((one): one is MetaBranchHost => "writer" in one && (one as MetaBranchHost).writer !== null) as MetaBranchHost | undefined;
  const writer = host?.writer;
  const machine = host?.info.machine;
  if (!writer || !machine) return () => undefined;
  // No merging lease here (say, its remote is not the configured one): the lease is taken on the meta branch's own remote.
  const lease = env.SCOPESOUP_MERGE_QUEUE === "off" ? null : (mergeQueue ?? (meta?.remote ? createMergeQueue({ git: realGit, repo: meta.repoPath, remote: meta.remote, machine, alone: () => !multiplayer() }) : null));
  let said = "";
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const attempt = async (): Promise<void> => {
    let again = true;
    try {
      const result = await migrateMetaFormat({ writer, lease, machine, now: iso });
      again = result.state === "waiting" || result.state === "lease" || result.state === "empty";
      const line = describeMigration(result);
      if (line && line !== said) {
        said = line;
        console.log(line);
        store.appendEvent({ kind: "scopesoup.meta_format", actor: "scopesoup", data: { state: result.state, reason: line } }, iso());
      }
    } catch (error) {
      const line = `The meta branch's format could not be checked: ${error instanceof Error ? error.message : String(error)}. It is tried again.`;
      if (line !== said) console.log((said = line));
    }
    if (again && !stopped) {
      timer = setTimeout(() => void attempt(), 120_000);
      timer.unref();
    }
  };
  void attempt();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  // A version just switched to that cannot start (it cannot read the project's data) gives the pointer back to the
  // version before it, and the launcher starts that one.
  if (home) {
    const back = revertFailedStart(home, basename(root), iso());
    if (back) {
      console.error(`Scope Soup ${version} could not start, so the pointer names ${back} again${launched ? ": starting it." : ". Start Scope Soup again."}`);
      if (launched) process.exitCode = RESTART_EXIT_CODE;
    }
  }
});
