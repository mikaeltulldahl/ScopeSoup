// Merging through the batching merge queue. The engine in `src/queue` is pure; this module
// is the caller its README describes: it keeps the queue's state in the store, feeds the engine
// what happened, performs each effect with git and the check command, and feeds the answer back.
//
// Everything happens in the queue's own clone of the project's repository (`<workspacesDir>/queue`),
// never in an item's workspace or a person's checkout. The safety rules of merging hold:
// - nothing is pushed unless the remote is the configured repository (every push URL is checked);
// - only a commit on which the check passed is pushed, and the engine only asks for such a commit;
// - the push is a plain fast-forward `git push` of that commit's id: never forced, hooks never skipped;
// - no new batch starts while merging is paused (a batch under way finishes); after Stop nothing is pushed and a running check is stopped.
//
// With `mergeQueue.ci: "github"` the project's own CI checks a commit instead of the check command: the commit is pushed to a
// branch of its own (`scopesoup/batch-<batch>-<commit>`), a pull request is opened for it, and every check run and commit status on
// that exact commit is waited for, across ticks. All green: the run passed, and the same commit is pushed to the main branch as
// above. Red: the run failed, with the failing check's name, conclusion and the end of its log. Pending past
// `mergeQueue.ciTimeoutMinutes`, or no check at all after a short grace: the Items of that commit are parked for a person. While merging is
// paused nothing is merged (a wait under way is left as it is).
//
// Once a batch's pull request is over it is tidied, at the start of each drain until it is done: not merged, it gets a comment
// why, is closed and its branch deleted; merged, only its branch is deleted. The host refuses a pull request that is not Scope Soup's own.
//
// What the engine asked for and has not had answered is not kept apart from its state: it is read
// back from the state (`awaited`), so a restart, or a stop in the middle of a check, loses nothing.
// What only the orchestrator can do (a change merged, a change sent back) waits in an outbox, stored
// with the state, until the caller has taken it.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ProjectConfig } from "../config/types.ts";
import { DEFAULT_CI_TIMEOUT_MINUTES, mergeQueueCi } from "../config/types.ts";
import type { Ref } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { initialState, configWith, defaultConfig, step, toBatch } from "../queue/index.ts";
import type { ChainResult, QueueBatch, QueueConfig, QueueEffect, QueueInput, QueueState } from "../queue/index.ts";
import type { ExternalCheck, QueueCiPort } from "../ports/host.ts";
import { NotScopeSoups, WriteLater } from "../ports/host.ts";
import { inertText } from "./hostText.ts";
import type { Store } from "../store/store.ts";
import type { CheckRun, RunCheck } from "./checkRunner.ts";
import { workspacePath } from "./paths.ts";
import type { Git } from "./process.ts";
import { QUEUE_KEY } from "./queueHealth.ts";
import { ensureSetup, setupFailedText } from "./setup.ts";
import { CHECK_HOLDER } from "./resources.ts";
import type { Resources } from "./resources.ts";
import { remoteMismatch, sameRepository } from "./remote.ts";
import { plural } from "../model/plural.ts";

export { QUEUE_KEY };
const ACTOR = "orchestrator";
/** Stands for "the check command" when its output names no failing test file. */
export const WHOLE_CHECK = "(the check command)";
const EXCERPT_CHARS = 1800;
const MAX_FILES = 50;

/** No check run and no commit status this long after the commit was pushed: no CI ran for it, and its Items are parked for a person. */
export const NO_CHECKS_GRACE_MS = 5 * 60_000;
/** How much of a failing check's log goes into the failure report (the engine keeps the last 1500 characters of it). */
const LOG_CHARS = 1200;

/** The Items of a commit whose CI did not finish in time, or never ran, are parked for a person with `message`; nothing was merged or resumed. */
export interface ParkedNotice {
  kind: "parked";
  batch: number;
  changes: Ref[];
  message: string;
}

/** Effects only the orchestrator can carry out: it knows the items, their jobs and their logs. */
export type Notice =
  | Extract<QueueEffect, { kind: "mark-merged" | "send-back" | "file-flake" | "suspect-order-dependence" | "report-outside-write" | "report-problem" }>
  | ParkedNotice;

export interface QueueSink {
  /** Something worth a line in the log, with its reason in words. */
  note(kind: string, reason: string, data?: Record<string, unknown>): void;
  /** Takes one notice. A throw keeps it for the next time. */
  deliver(notice: Notice): Promise<void>;
}

export interface QueueDriverDeps {
  store: Store;
  config: () => ProjectConfig;
  git: Git;
  runCheck: RunCheck;
  /** Runs `setupCommand` in the queue's clone before a check. Default: `runCheck`. */
  runSetup?: RunCheck;
  /** ISO 8601, UTC. */
  now: () => string;
  /** True while merging is not started (Pause merge queue, Stop, start-up): no new batch starts; a batch under way finishes. */
  paused: () => boolean;
  /** True once Stop was pressed: a running check is stopped and nothing is pushed. */
  stopped: () => boolean;
  /** Settings of the engine, fixed. Absent: they come from the project's configuration (the queue settings) at every step. */
  queue?: QueueConfig;
  /** The project's CI on GitHub, used when `mergeQueue.ci` is "github"; absent without a GitHub host Scope Soup may write to. */
  ci?: QueueCiPort;
  /** Why `ci` was refused at start (the remote is not the GitHub repository), said instead of the general reason. */
  ciRefused?: string;
  /** The limited resources the check may need: a unit is taken before each check and given back after it. */
  resources?: Resources;
}

export type Enqueued = { ok: true; sha: string } | { ok: false; reason: string };

export interface QueueDriver {
  /** Takes the change into the queue: its branch's head is fetched into the queue's clone and the engine is told it is ready. */
  enqueue(item: Ref, branch: string, repo: string | null, paths: string[]): Promise<Enqueued>;
  /** Tells the engine that every change not in `keep` (refKeys of items waiting in the queue) left it. */
  reconcile(keep: ReadonlySet<string>): void;
  /** Does what the engine is waiting for, until it waits for nothing, Stop is pressed, or (merging paused) the next step would start a new batch. */
  drain(sink: QueueSink): Promise<void>;
  /** The engine's state as stored. */
  state(): QueueState;
  /** The engine is paused: why, or null. */
  pausedWhy(): string | null;
  /** Lets a paused queue go on. */
  resume(by: string): void;
  /** Why no batch can be checked now (no check command, or with `mergeQueue.ci: "github"` no GitHub host to write to), or null. */
  checkMissing(): string | null;
}

/** A change handed to the queue that the engine has not been told about yet: they are told together, so they can share a batch. */
interface Ready {
  change: Ref;
  sha: string;
  paths: string[];
}

/**
 * A commit whose checks are waited for on GitHub: its branch, its pull request and when it was pushed. Kept after the
 * checks passed (`passed`), until its batch is over, so the pull request is tidied whether it merged or not.
 */
interface CiWait {
  branch: string;
  change: Ref;
  since: string;
  /** The batch it belongs to. Absent in a wait stored earlier. */
  batch?: number;
  passed?: true;
}

/** A batch's pull request to tidy: with `comment` it did not merge (comment, close, delete the branch); without, it merged (delete the branch). */
interface Cleanup {
  change: Ref;
  branch: string;
  comment?: string;
}

interface Stored {
  v: 1;
  state: QueueState;
  outbox: Notice[];
  ready: Ready[];
  /** By commit id. */
  waits?: Record<string, CiWait>;
  /** Oldest first; each is tried at every drain until it is done. */
  cleanups?: Cleanup[];
}

const NOTICE: readonly QueueEffect["kind"][] = ["mark-merged", "send-back", "file-flake", "suspect-order-dependence", "report-outside-write", "report-problem"];

const isNotice = (effect: QueueEffect): effect is Extract<Notice, QueueEffect> => NOTICE.includes(effect.kind);

const tail = (text: string, chars: number): string => {
  const trimmed = text.trim();
  return trimmed.length > chars ? `...${trimmed.slice(-chars)}` : trimmed;
};

const slashed = (path: string): string => path.replace(/\\/g, "/");

/** The test files a failed check names: node's `test at <file>:<line>:<column>` and lines that start with FAIL, not ok or a cross. Never empty. */
export function failedFiles(output: string, cwd = ""): string[] {
  const files: string[] = [];
  const add = (raw: string): void => {
    let file = raw.trim().replace(/^file:\/\/\/?/, "");
    try {
      file = decodeURIComponent(file);
    } catch {
      // Not encoded.
    }
    file = slashed(file);
    const root = slashed(cwd).replace(/\/+$/, "");
    if (root && file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) file = file.slice(root.length + 1);
    file = file.replace(/^\.\//, "");
    if (file !== "" && !files.includes(file)) files.push(file);
  };
  for (const match of output.matchAll(/^\s*test at (\S+?):\d+:\d+\s*$/gm)) add(match[1] ?? "");
  for (const line of output.split(/\r?\n/)) {
    if (!/^\s*(?:FAIL|not ok|✖|×)\b/.test(line)) continue;
    const match = line.match(/([\w@.:/\\-]+\.[cm]?[jt]sx?)\b/);
    if (match) add(match[1] ?? "");
  }
  // A runner's `N failed:` block: indented `<path>:<line>  <name>` lines, each with the detail lines indented deeper below it.
  let inBlock = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*\d+ failed:?\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) {
      inBlock = false;
      continue;
    }
    const match = line.match(/^\s+([\w@.:/\\-]+\.[cm]?[jt]sx?):\d+(?:\s|$)/);
    if (match) add(match[1] ?? "");
  }
  return files.length > 0 ? files.slice(0, MAX_FILES) : [WHOLE_CHECK];
}

/** A name in a failure report that may be handed to the check command as a file: relative, inside the repository, not an option, and there. */
export function safeFile(repo: string, file: string): boolean {
  if (file === "" || file.startsWith("-") || file.includes("\0") || file.includes("\\") || isAbsolute(file) || /^[A-Za-z]:/.test(file)) return false;
  if (file.split("/").some((part) => part === ".." || part === "")) return false;
  return existsSync(join(repo, file));
}

/** The command with `{files}` replaced by one argument per file. Undefined without a command. */
export function filesCommand(command: readonly string[] | undefined, files: readonly string[]): string[] | undefined {
  return command?.flatMap((part) => (part === "{files}" ? [...files] : [part]));
}

/**
 * Why `mergeQueue.ci: "github"` is refused at start, or null: the batches are pushed to `remoteUrl` and their pull requests opened
 * on the GitHub host, so the two must be one repository.
 */
export function githubCiRefusal(config: Pick<ProjectConfig, "mergeQueue" | "remoteUrl">, githubRepo: string | undefined): string | null {
  if (mergeQueueCi(config) !== "github" || githubRepo === undefined || config.remoteUrl === undefined) return null;
  const expected = `https://github.com/${githubRepo}`;
  if (sameRepository(config.remoteUrl, expected)) return null;
  return `mergeQueue.ci is "github", but remoteUrl (${config.remoteUrl}) is not the GitHub repository ${githubRepo} (${expected}): a batch pushed there could not get a pull request on GitHub, so nothing merges. Make remoteUrl that repository, or set mergeQueue.ci to "local"`;
}

export function createQueueDriver(deps: QueueDriverDeps): QueueDriver {
  const { store, git } = deps;
  /** The engine's settings now: fixed when the caller gave them, otherwise the project's numbers. */
  function engineConfig(): QueueConfig {
    if (deps.queue) return deps.queue;
    try {
      const { settings } = deps.config();
      return configWith({
        batch: { min: settings.queueMinBatch.value, max: settings.queueMaxBatch.value, rerunCost: settings.queueRerunCost.value, minOutcomes: settings.queueMinOutcomes.value },
      });
    } catch {
      return defaultConfig;
    }
  }

  function load(): Stored {
    const text = store.getValue(QUEUE_KEY);
    if (text) {
      try {
        const stored = JSON.parse(text) as Stored;
        if (stored.v === 1 && stored.state?.v === 1) return { v: 1, state: stored.state, outbox: stored.outbox ?? [], ready: stored.ready ?? [], ...(stored.waits ? { waits: stored.waits } : {}), ...(stored.cleanups ? { cleanups: stored.cleanups } : {}) };
      } catch {
        // A damaged value starts the queue over: the changes are re-fed from the items' jobs.
      }
    }
    return { v: 1, state: initialState(), outbox: [], ready: [] };
  }

  /** One step: the input goes in, the new state, the batches for the board and the outbox are stored together. */
  function feed(input: QueueInput): QueueEffect[] {
    const at = deps.now();
    const stored = load();
    const result = step(stored.state, input, engineConfig(), at);
    const outbox = [...stored.outbox, ...result.effects.filter(isNotice)];
    store.tx(() => {
      store.setValue(QUEUE_KEY, JSON.stringify({ v: 1, state: result.state, outbox, ready: stored.ready, ...(stored.waits ? { waits: stored.waits } : {}), ...(stored.cleanups ? { cleanups: stored.cleanups } : {}) } satisfies Stored));
      for (const batch of toBatch(result.state)) store.put(batch, ACTOR, at);
    });
    return result.effects;
  }

  const git0 = async (args: string[], cwd: string): Promise<string> => {
    const result = await git(args, cwd);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim().slice(-400) || `code ${result.code}`}`);
    return result.stdout.trim();
  };

  /** The queue's clone: made once from the project's remote, then checked against it every time. */
  async function clone(): Promise<string> {
    const config = deps.config();
    if (!config.remoteUrl) throw new Error("The project names no remoteUrl, so nothing is pushed.");
    const path = workspacePath(config, "queue");
    if (!existsSync(`${path}/.git`)) {
      mkdirSync(dirname(path), { recursive: true });
      await git0(["clone", "--quiet", "--origin", config.remote, config.remoteUrl, path], dirname(path));
      await git0(["config", "user.name", "Scope Soup queue"], path);
      await git0(["config", "user.email", "queue@scopesoup.invalid"], path);
      await git0(["config", "advice.detachedHead", "false"], path);
    }
    const wrong = await remoteMismatch(git, path, config.remote, config.remoteUrl);
    if (wrong) throw new Error(`Nothing is fetched or pushed: ${wrong}.`);
    return path;
  }

  const trackingOf = (config: ProjectConfig): string => `refs/remotes/${config.remote}/${config.mainBranch}`;

  /** Fetches the main branch and returns its commit. */
  async function fetchMain(repo: string): Promise<string> {
    const config = deps.config();
    await git0(["fetch", "--quiet", config.remote, `+refs/heads/${config.mainBranch}:${trackingOf(config)}`], repo);
    return git0(["rev-parse", "--verify", trackingOf(config)], repo);
  }

  const queueRef = (change: Ref): string => `refs/scopesoup/queue/${refKey(change).replace(/[^A-Za-z0-9._-]/g, "-")}`;

  const save = (stored: Stored): void => store.setValue(QUEUE_KEY, JSON.stringify(stored));

  /**
   * Tells the engine about the changes handed over since the last time. The engine builds a batch
   * as soon as it knows a ready change, so it is paused while they are told: all of them are ready
   * when it looks, and they can share one batch.
   */
  function flushReady(): void {
    const stored = load();
    if (stored.ready.length === 0) return;
    const wasPaused = stored.state.paused !== undefined;
    save({ ...stored, ready: [] });
    if (!wasPaused) feed({ kind: "pause", reason: "taking in changes", by: "queue" });
    for (const r of stored.ready) feed({ kind: "change-ready", change: r.change, sha: r.sha, paths: r.paths, by: "orchestrator" });
    if (!wasPaused) feed({ kind: "resume", by: "queue" });
  }

  /** Feeds `main-moved` when the remote's main branch is not where the engine thinks. */
  async function syncMain(repo: string, sink?: QueueSink): Promise<string> {
    const main = await fetchMain(repo);
    if (load().state.main !== main) {
      feed({ kind: "main-moved", sha: main, by: "poll" });
      sink?.note("orchestrator.queue_main", `The main branch is at ${main.slice(0, 7)}.`, { sha: main });
    }
    return main;
  }

  // ------------------------------------------------------------ what the engine waits for

  /** The one thing the engine has asked for and not had answered, read from its state. */
  function awaited(state: QueueState): QueueEffect | null {
    const b = state.batches[state.batches.length - 1];
    if (!b || b.status === "done") return null;
    if (b.status === "building") return { kind: "build-chain", batch: b.id, base: b.base, changes: b.members.map((m) => ({ change: m.change, sha: m.head })) };
    if (b.merge) return { kind: "fast-forward", batch: b.id, prefix: b.merge.prefix, to: b.merge.to, expect: b.merge.expect };
    const p = b.probes.find((x) => x.status === "queued" || x.status === "running");
    if (!p) return null;
    return p.kind === "rerun"
      ? { kind: "rerun-files", batch: b.id, run: p.id, prefix: p.prefix, sha: p.sha, files: [...(p.files ?? [])] }
      : { kind: "start-run", batch: b.id, run: p.id, prefix: p.prefix, sha: p.sha };
  }

  // ------------------------------------------------------------ performing effects

  async function buildChain(repo: string, effect: Extract<QueueEffect, { kind: "build-chain" }>): Promise<QueueInput> {
    const config = deps.config();
    const tracking = trackingOf(config);
    try {
      await git0(["reset", "--hard", "--quiet"], repo);
      await git0(["checkout", "--quiet", "--detach", effect.base], repo);
    } catch (error) {
      return { kind: "chain-failed", batch: effect.batch, reason: `The base ${effect.base.slice(0, 7)} could not be checked out: ${(error as Error).message}`, by: "queue" };
    }
    const results: ChainResult[] = [];
    /** What each member added, for naming the change a later one conflicts with. */
    const added: { change: Ref; files: Set<string> }[] = [];
    let tip = effect.base;
    for (const { change, sha } of effect.changes) {
      let commits: string[];
      try {
        commits = (await git0(["rev-list", "--reverse", "--no-merges", sha, `^${tip}`, `^${tracking}`], repo)).split("\n").filter((line) => line !== "");
      } catch (error) {
        return { kind: "chain-failed", batch: effect.batch, reason: `The commits of ${change.id} could not be read: ${(error as Error).message}`, by: "queue" };
      }
      if (commits.length > 0) {
        // The authors stay; Scope Soup is the committer, whatever the clone's config or the server's environment says
        // (GIT_COMMITTER_* beats `-c`, so it is set in the environment of the command).
        const picked = await git(["cherry-pick", "--allow-empty", "--keep-redundant-commits", ...commits], repo, undefined, { GIT_COMMITTER_NAME: "Scope Soup", GIT_COMMITTER_EMAIL: "scopesoup@queue.invalid" });
        if (picked.code !== 0) {
          const unmerged = (await git(["diff", "--name-only", "--diff-filter=U"], repo)).stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
          await git(["cherry-pick", "--abort"], repo);
          await git(["reset", "--hard", "--quiet", tip], repo);
          const other = added.find((member) => unmerged.some((file) => member.files.has(file)));
          results.push({ change, conflict: other ? { with: other.change } : {} });
          continue;
        }
      }
      const files = (await git(["diff", "--name-only", tip, "HEAD"], repo)).stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      added.push({ change, files: new Set(files) });
      tip = await git0(["rev-parse", "--verify", "HEAD"], repo);
      results.push({ change, sha: tip, tree: await git0(["rev-parse", "--verify", "HEAD^{tree}"], repo) });
    }
    return { kind: "chain-built", batch: effect.batch, results, by: "queue" };
  }

  /** Puts the queue's clone on `sha` and runs the check there. Null: Stop ended it. */
  async function check(repo: string, sha: string, only?: string[], sinkNote?: QueueSink["note"], unitEnv?: Record<string, string>): Promise<{ run: CheckRun; files: string[]; excerpt: string } | { error: string; detail?: string } | null> {
    const config = deps.config();
    const command = only ? filesCommand(config.rerunFilesCommand, only) : config.checkCommand;
    if (!command) return { error: "The project names no checkCommand." };
    if (deps.stopped()) return null;
    try {
      await git0(["reset", "--hard", "--quiet"], repo);
      await git0(["checkout", "--quiet", "--detach", sha], repo);
    } catch (error) {
      return { error: (error as Error).message };
    }
    // The project's setup first, when it must run in this clone (first time, or a watched file differs on this commit). A
    // failed setup pauses the queue as the setup's failure: it is not a red check, and no change is sent back for it.
    const setup = await ensureSetup({ git, run: deps.runSetup ?? deps.runCheck, timeoutMs: config.settings.checkTimeoutMinutes.value * 60_000, stop: deps.stopped, now: deps.now }, config, repo);
    if (setup.kind === "stopped") return null;
    if (setup.kind === "failed") {
      // The pause reason may be shown beyond this machine: it names the outcome only. The output goes into the local note.
      const short = `${setupFailedText(`the queue's clone on ${sha.slice(0, 7)}`, setup.outcome, config.machineName)} This is the project's setup, not a red check.`;
      return { error: short, detail: `${short} (${setup.why}) ${setup.reason}` };
    }
    if (setup.kind === "ran") sinkNote?.("orchestrator.setup_ran", `The setup ran in the queue's clone on ${sha.slice(0, 7)} (${setup.why}) and passed in ${Math.round(setup.ms / 1000)} s.`, { sha });
    const run = await deps.runCheck(command, repo, config.settings.checkTimeoutMinutes.value * 60_000, deps.stopped, unitEnv);
    if (run.outcome === "stopped") return null;
    if (run.outcome === "not-started") return { error: run.tail };
    let excerpt = tail(run.tail, EXCERPT_CHARS);
    let outcome = run.outcome;
    if (outcome === "passed") {
      // What was checked must be what is there: the same commit, no tracked file changed by the check.
      const head = (await git(["rev-parse", "--verify", "HEAD"], repo)).stdout.trim();
      const status = await git(["status", "--porcelain", "--untracked-files=no"], repo);
      if (head !== sha || status.stdout.trim() !== "") {
        outcome = "failed";
        excerpt = `The check passed, but it changed tracked files (${status.stdout.trim().split("\n").slice(0, 5).join("; ") || "the commit moved"}), so what was checked is not what would be pushed. Make the check leave tracked files as they are.`;
      }
    } else if (outcome === "timed-out") {
      excerpt = `The check did not finish within ${config.settings.checkTimeoutMinutes.value} minutes and was stopped.\n${excerpt}`;
    }
    return { run: { ...run, outcome }, files: outcome === "passed" ? [] : failedFiles(run.tail, repo), excerpt };
  }

  /** The files to rerun alone: none (the whole check runs) when no command takes files, a name is not a plain file of the repository, or the report named no file. */
  function rerunFiles(repo: string, files: readonly string[]): string[] | undefined {
    if (!deps.config().rerunFilesCommand || files.length === 0 || files.includes(WHOLE_CHECK)) return undefined;
    return files.every((file) => safeFile(repo, file)) ? [...files] : undefined;
  }

  async function runOn(repo: string, effect: Extract<QueueEffect, { kind: "start-run" | "rerun-files" }>, sink: QueueSink): Promise<QueueInput | "stop" | "wait"> {
    // A unit of each resource the check needs. Without one the check waits for a later drain; the queue is not paused.
    const units = deps.resources ? await deps.resources.take(CHECK_HOLDER, `the check of batch ${effect.batch}`, "check") : null;
    if (units && !units.ok) {
      if (units.first) sink.note("orchestrator.queue_resource_wait", `The check of batch ${effect.batch} waits: ${units.why}.`, { batch: effect.batch, resource: units.resource });
      return "wait";
    }
    try {
      return await checkAndTell(repo, effect, sink, units?.env);
    } finally {
      await deps.resources?.give(CHECK_HOLDER);
    }
  }

  async function checkAndTell(repo: string, effect: Extract<QueueEffect, { kind: "start-run" | "rerun-files" }>, sink: QueueSink, unitEnv: Record<string, string> | undefined): Promise<QueueInput | "stop"> {
    // A rerun runs only the failed files when the project says how; otherwise the whole check runs again.
    const only = effect.kind === "rerun-files" ? rerunFiles(repo, effect.files) : undefined;
    const result = await check(repo, effect.sha, only, (kind, reason, data) => sink.note(kind, reason, data), unitEnv);
    if (result === null) return "stop";
    if ("error" in result) {
      sink.note("orchestrator.queue_problem", `The check could not be run on ${effect.sha.slice(0, 7)}: ${result.detail ?? result.error}`, { sha: effect.sha });
      return { kind: "pause", reason: `The check could not be run: ${result.error}`, by: "queue" };
    }
    const passed = result.run.outcome === "passed";
    sink.note("orchestrator.queue_check", `${effect.kind === "rerun-files" ? (only ? "Rerun of the failed files" : "Rerun of the whole check") : "Check"} on batch ${effect.batch}, first ${effect.prefix} of its chain (${effect.sha.slice(0, 7)}): ${passed ? "passed" : "failed"} in ${Math.round(result.run.ms / 1000)} s.`, { batch: effect.batch, sha: effect.sha, passed, ...(passed ? {} : { files: result.files, excerpt: result.excerpt }) });
    const outcome = passed ? "pass" : "fail";
    const report = { files: result.files, excerpt: result.excerpt };
    // A run that was cut short (timed out, or passed with tracked files changed) says nothing about how long a check takes.
    const timed = result.run.outcome === "passed" || result.run.outcome === "failed" ? { ms: result.run.ms } : {};
    if (effect.kind === "rerun-files") {
      // Either only the failed files ran, or the whole check ran again on the same commit: every failed file ran.
      return { kind: "rerun-finished", run: effect.run, sha: effect.sha, outcome, ran: effect.files, ...(passed ? {} : { report }), ...timed, by: "queue" };
    }
    return { kind: "run-finished", run: effect.run, sha: effect.sha, outcome, ...(passed ? {} : { report }), ...timed, by: "queue" };
  }

  async function fastForward(repo: string, effect: Extract<QueueEffect, { kind: "fast-forward" }>, sink: QueueSink): Promise<QueueInput | "stop"> {
    const config = deps.config();
    const answer = (ok: boolean, main?: string): QueueInput => ({ kind: "merge-result", batch: effect.batch, to: effect.to, ok, ...(main === undefined ? {} : { main }), by: "queue" });
    if (deps.stopped()) return "stop";
    if (!config.remoteUrl) return answer(false);
    const wrong = await remoteMismatch(git, repo, config.remote, config.remoteUrl);
    if (wrong) {
      sink.note("orchestrator.queue_problem", `Nothing is pushed: ${wrong}.`, { batch: effect.batch });
      return answer(false);
    }
    let main: string;
    try {
      main = await fetchMain(repo);
    } catch (error) {
      sink.note("orchestrator.queue_problem", `The main branch could not be fetched: ${(error as Error).message}`, { batch: effect.batch });
      return answer(false);
    }
    if (main !== effect.expect) return answer(false, main);
    // Only a commit on which the check passed, and only on top of what the main branch is now.
    const state = load().state;
    const tested = state.batches.find((b) => b.id === effect.batch)?.probes.some((p) => p.sha === effect.to && p.status === "passed" && !p.reused) ?? false;
    const known = state.known.some((k) => k.sha === effect.to && k.result === "passed");
    if (!tested && !known) return answer(false, main);
    if ((await git(["merge-base", "--is-ancestor", effect.expect, effect.to], repo)).code !== 0) return answer(false, main);
    if (deps.stopped()) return "stop";
    const pushed = await git(["push", "--quiet", config.remote, `${effect.to}:refs/heads/${config.mainBranch}`], repo);
    if (pushed.code === 0) {
      sink.note("orchestrator.queue_pushed", `Batch ${effect.batch}: the first ${effect.prefix} of its chain are on ${config.mainBranch} as ${effect.to.slice(0, 7)}; the check passed on that commit.`, { batch: effect.batch, sha: effect.to });
      return answer(true, effect.to);
    }
    sink.note("orchestrator.queue_problem", `The push of ${effect.to.slice(0, 7)} was refused: ${pushed.stderr.trim().slice(-300)}`, { batch: effect.batch });
    let after: string | undefined;
    try {
      after = await fetchMain(repo);
    } catch {
      after = undefined;
    }
    return answer(false, after);
  }

  // ------------------------------------------------------------ the project's CI on GitHub

  /** Why there is no CI on GitHub to wait for. */
  const noCi = (): string =>
    deps.ciRefused ?? `mergeQueue.ci is "github", but Scope Soup has no GitHub host it may write to (host kind "github" with write on, and the clone's remote pointing at that repository)`;

  const githubCi = (): boolean => {
    try {
      return mergeQueueCi(deps.config()) === "github";
    } catch {
      return false;
    }
  };

  /** The branch a commit is pushed to for its pull request: the batch and the commit, so a rebuilt batch or a fresh store never meets an old branch. */
  const batchBranch = (batch: number, sha: string): string => `scopesoup/batch-${batch}-${sha.slice(0, 7)}`;

  function setWait(sha: string, wait: CiWait | null): void {
    const stored = load();
    const waits = { ...stored.waits };
    if (wait) waits[sha] = wait;
    else delete waits[sha];
    save({ ...stored, waits });
  }

  /** The pull request of `sha` is over: its wait goes, and the tidying is kept until it is done. Text from elsewhere in `comment` is inert already. */
  function settle(sha: string, comment: string | undefined): void {
    const stored = load();
    const wait = stored.waits?.[sha];
    if (!wait) return;
    const waits = { ...stored.waits };
    delete waits[sha];
    const cleanup: Cleanup = { change: wait.change, branch: wait.branch, ...(comment === undefined ? {} : { comment }) };
    save({ ...stored, waits, cleanups: [...(stored.cleanups ?? []), cleanup] });
  }

  /**
   * The waits of batches that are over (merged, ended because main moved or a member left, or no longer in the state). A commit
   * that is on the main branch merged: only its branch is deleted. Any other did not: its pull request says why and is closed.
   */
  async function settleEnded(repo: string): Promise<void> {
    const { state, waits } = load();
    if (!waits) return;
    const config = deps.config();
    const live = new Set(state.batches.filter((b) => b.status !== "done").flatMap((b) => b.probes.filter((p) => p.status === "queued" || p.status === "running").map((p) => p.sha)));
    for (const [sha, wait] of Object.entries(waits)) {
      const batch = wait.batch === undefined ? undefined : state.batches.find((b) => b.id === wait.batch);
      const over = batch ? batch.status === "done" : !live.has(sha);
      if (!over) continue;
      const merged = (await git(["merge-base", "--is-ancestor", sha, trackingOf(config)], repo)).code === 0;
      settle(sha, merged ? undefined : `Not merged: batch ${wait.batch ?? "?"} ended${batch?.note ? ` (${inertText(batch.note)})` : ""}. Scope Soup closes this pull request and deletes its branch.`);
    }
  }

  /** Tidies the pull requests that are over. A failure is tried again at the next drain and never holds the queue up. */
  async function runCleanups(sink: QueueSink): Promise<void> {
    const ci = deps.ci;
    if (!ci) return;
    for (const job of [...(load().cleanups ?? [])]) {
      let done = true;
      try {
        await ci.cleanBatch(job);
        sink.note("orchestrator.queue_ci", job.comment === undefined ? `Pull request ${job.change.id} merged; its branch ${job.branch} is deleted.` : `Pull request ${job.change.id} did not merge: commented, closed, and its branch ${job.branch} deleted.`, { change: job.change.id, branch: job.branch });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof NotScopeSoups) sink.note("orchestrator.queue_problem", `Pull request ${job.change.id} was left as it is: ${message}`);
        else {
          done = false;
          sink.note("orchestrator.queue_problem", `Pull request ${job.change.id} (${job.branch}) could not be tidied: ${message}. Scope Soup tries again at the next tick.`);
        }
      }
      if (done) {
        const stored = load();
        save({ ...stored, cleanups: (stored.cleanups ?? []).filter((each) => !(each.change.id === job.change.id && each.branch === job.branch)) });
      }
    }
  }

  /** GitHub could not be asked: a failure that can pass by itself is tried again at the next tick; any other pauses the queue. */
  function hostTrouble(what: string, error: unknown, sink: QueueSink): QueueInput | "wait" {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WriteLater) {
      sink.note("orchestrator.queue_problem", `${what}: ${message}. Scope Soup tries again at the next tick.`);
      return "wait";
    }
    sink.note("orchestrator.queue_problem", `${what}: ${message}`);
    return { kind: "pause", reason: `${what}: ${message}`, by: "queue" };
  }

  /** The Items of the commit's prefix that are not merged yet are parked for a person: they leave the queue, and the batch ends. */
  function parkBatch(batch: QueueBatch, effect: Extract<QueueEffect, { kind: "start-run" }>, message: string, comment: string, sink: QueueSink): "parked" {
    const changes = batch.members.slice(batch.good, effect.prefix).map((m) => m.change);
    settle(effect.sha, comment);
    const stored = load();
    save({ ...stored, outbox: [...stored.outbox, { kind: "parked", batch: batch.id, changes, message }] });
    sink.note("orchestrator.queue_problem", message, { batch: batch.id, sha: effect.sha });
    for (const change of changes) feed({ kind: "change-left", change, by: "queue" });
    return "parked";
  }

  /**
   * The project's CI on GitHub checks the commit. The first time the commit is pushed to its own branch and a pull request is
   * opened for it; every time the checks on exactly that commit are read. "wait": not settled yet, asked again at the next tick.
   */
  async function ciRun(repo: string, effect: Extract<QueueEffect, { kind: "start-run" }>, sink: QueueSink): Promise<QueueInput | "wait" | "stop" | "parked"> {
    const config = deps.config();
    const ci = deps.ci;
    const short = effect.sha.slice(0, 7);
    const where = `batch ${effect.batch}, first ${effect.prefix} of its chain (${short})`;
    if (deps.stopped()) return "stop";
    if (!ci) {
      const reason = `${noCi()}, so ${where} cannot be checked.`;
      sink.note("orchestrator.queue_problem", reason, { batch: effect.batch });
      return { kind: "pause", reason, by: "queue" };
    }
    const batch = load().state.batches.find((b) => b.id === effect.batch);
    if (!batch) return "wait";
    let wait = load().waits?.[effect.sha];
    if (!wait) {
      if (!config.remoteUrl) return { kind: "pause", reason: "The project names no remoteUrl, so nothing is pushed.", by: "queue" };
      const wrong = await remoteMismatch(git, repo, config.remote, config.remoteUrl);
      if (wrong) {
        sink.note("orchestrator.queue_problem", `Nothing is pushed: ${wrong}.`, { batch: effect.batch });
        return { kind: "pause", reason: `Nothing is pushed: ${wrong}.`, by: "queue" };
      }
      const branch = batchBranch(effect.batch, effect.sha);
      if (deps.stopped()) return "stop";
      // A plain push of a new branch, never forced. The same commit pushed again (after a restart) changes nothing.
      const pushed = await git(["push", "--quiet", config.remote, `${effect.sha}:refs/heads/${branch}`], repo);
      if (pushed.code !== 0) {
        const reason = `The commit of ${where} could not be pushed to ${branch}: ${pushed.stderr.trim().slice(-300) || `code ${pushed.code}`}`;
        sink.note("orchestrator.queue_problem", reason, { batch: effect.batch });
        return { kind: "pause", reason, by: "queue" };
      }
      let change: Ref;
      try {
        change = await ci.openBatch({ branch, target: config.mainBranch, batch: effect.batch, sha: effect.sha, base: batch.base, members: batch.members.slice(0, effect.prefix).map((m) => m.change) });
      } catch (error) {
        return hostTrouble(`The pull request for ${branch} could not be opened`, error, sink);
      }
      wait = { branch, change, since: deps.now(), batch: effect.batch };
      setWait(effect.sha, wait);
      sink.note("orchestrator.queue_ci", `Batch ${effect.batch}, first ${effect.prefix} of its chain (${short}): pushed to ${branch}; pull request ${change.id} waits for every check on that commit.`, { batch: effect.batch, sha: effect.sha, branch, change: change.id });
    }
    let checks: ExternalCheck[];
    try {
      checks = await ci.checksOn(effect.sha);
    } catch (error) {
      return hostTrouble(`The checks on ${short} could not be read from GitHub`, error, sink);
    }
    const link = wait.change.url ?? `pull request ${wait.change.id}`;
    const failed = checks.filter((check) => check.state === "failed");
    if (failed.length > 0) {
      const first = failed[0] as ExternalCheck;
      let log: string | null;
      try {
        log = await ci.checkLog(first, LOG_CHARS);
      } catch {
        log = null;
      }
      const others = failed.length > 1 ? ` (also failed: ${failed.slice(1).map((check) => `"${check.name}"`).join(", ")})` : "";
      const excerpt = `The check "${first.name}" on GitHub ended ${first.conclusion} on ${short}${others}.\n${log ? `The end of its log:\n${log}` : `Its log could not be read: ${first.url ?? link}`}`;
      const alone = effect.prefix - batch.good === 1;
      settle(effect.sha, `Red: \`${inertText(first.name.replaceAll("`", ""))}\` ended ${inertText(first.conclusion)}; ${alone ? "the change went back to the implementor" : "the queue looks for the change that broke the batch"}.`);
      sink.note("orchestrator.queue_check", `Checks on GitHub for ${where}: failed ("${first.name}": ${first.conclusion}).`, { batch: effect.batch, sha: effect.sha, passed: false, check: first.name, conclusion: first.conclusion, excerpt });
      return { kind: "run-finished", run: effect.run, sha: effect.sha, outcome: "fail", report: { files: [], excerpt }, ref: wait.change, by: "queue" };
    }
    if (checks.length > 0 && checks.every((check) => check.state === "passed")) {
      setWait(effect.sha, { ...wait, passed: true });
      sink.note("orchestrator.queue_check", `Checks on GitHub for ${where}: all ${checks.length} passed.`, { batch: effect.batch, sha: effect.sha, passed: true });
      return { kind: "run-finished", run: effect.run, sha: effect.sha, outcome: "pass", ref: wait.change, by: "queue" };
    }
    const waited = Date.parse(deps.now()) - Date.parse(wait.since);
    const limitMinutes = config.mergeQueue?.ciTimeoutMinutes ?? DEFAULT_CI_TIMEOUT_MINUTES;
    const minutes = Math.round(waited / 60_000);
    if (checks.length === 0 && waited >= Math.min(NO_CHECKS_GRACE_MS, limitMinutes * 60_000)) {
      return parkBatch(batch, effect, `No CI ran on ${where}: ${minutes} minutes after it was pushed to ${wait.branch} (${link}), GitHub shows no check run and no commit status on that commit, so nothing was merged unchecked. Make the project's CI run on pull requests into ${config.mainBranch}, then answer here to hand the change to the queue again.`, `No CI ran on this commit within ${minutes} min; the Items wait for an answer.`, sink);
    }
    if (checks.length > 0 && waited >= limitMinutes * 60_000) {
      const pending = checks.filter((check) => check.state === "pending").map((check) => `"${check.name}" (${check.url ?? link})`);
      return parkBatch(batch, effect, `The checks on ${where} were still pending after ${minutes} minutes (mergeQueue.ciTimeoutMinutes is ${limitMinutes}): ${pending.join(", ")}. Nothing was merged and no implementor was resumed. Look at the check, then answer here to hand the change to the queue again.`, `Timed out after ${minutes} min; the Items wait for an answer.`, sink);
    }
    return "wait";
  }

  async function cleanup(repo: string, notice: Notice): Promise<void> {
    const changes: Ref[] = notice.kind === "mark-merged" ? notice.members.map((m) => m.change) : notice.kind === "send-back" ? [notice.change] : notice.kind === "parked" ? notice.changes : [];
    for (const change of changes) await git(["update-ref", "-d", queueRef(change)], repo);
  }

  // ------------------------------------------------------------ the driver

  async function deliverOutbox(repo: string | null, sink: QueueSink): Promise<void> {
    for (;;) {
      const next = load().outbox[0];
      if (!next) return;
      if (repo) await cleanup(repo, next);
      await sink.deliver(next);
      const stored = load();
      store.setValue(QUEUE_KEY, JSON.stringify({ ...stored, outbox: stored.outbox.slice(1) } satisfies Stored));
    }
  }

  return {
    async enqueue(item, branch, repo, paths) {
      if (!repo) return { ok: false, reason: `the item has no workspace holding ${branch}` };
      let queueRepo: string;
      try {
        queueRepo = await clone();
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }
      let sha: string;
      try {
        sha = await git0(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], repo);
        await git0(["fetch", "--quiet", repo, `+refs/heads/${branch}:${queueRef(item)}`], queueRepo);
        const fetched = await git0(["rev-parse", "--verify", `${queueRef(item)}^{commit}`], queueRepo);
        if (fetched !== sha) return { ok: false, reason: `${branch} is at ${sha.slice(0, 7)} in ${repo}, but ${fetched.slice(0, 7)} arrived in the queue's clone.` };
        const main = await fetchMain(queueRepo);
        if ((await git(["merge-base", "--is-ancestor", sha, main], queueRepo)).code === 0) {
          return { ok: false, reason: `${branch} has nothing that ${deps.config().mainBranch} does not have already, so there is nothing to merge.` };
        }
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }
      const stored = load();
      save({ ...stored, ready: [...stored.ready.filter((r) => refKey(r.change) !== refKey(item)), { change: item, sha, paths }] });
      return { ok: true, sha };
    },

    reconcile(keep) {
      const stored = load();
      if (stored.ready.some((r) => !keep.has(refKey(r.change)))) save({ ...stored, ready: stored.ready.filter((r) => keep.has(refKey(r.change))) });
      for (const entry of load().state.entries) {
        if (!keep.has(refKey(entry.change))) feed({ kind: "change-left", change: entry.change, by: "orchestrator" });
      }
    },

    async drain(sink) {
      const first = load();
      const busy = first.state.entries.length > 0 || first.ready.length > 0 || first.state.batches.some((b) => b.status !== "done") || first.outbox.length > 0
        || Object.keys(first.waits ?? {}).length > 0 || (first.cleanups ?? []).length > 0;
      if (!busy) return;
      let repo: string | null = null;
      try {
        repo = await clone();
        await syncMain(repo, sink);
        flushReady();
        // A chain asked for on a main branch that has moved since is not worth building.
        const b = load().state.batches.at(-1);
        const main = load().state.main;
        if (b?.status === "building" && main !== undefined && main !== b.base) {
          feed({ kind: "chain-failed", batch: b.id, reason: "the main branch moved before the chain was built", by: "queue" });
        }
        await settleEnded(repo);
      } catch (error) {
        sink.note("orchestrator.queue_problem", `The queue could not reach its clone or the remote: ${(error as Error).message}`);
        await deliverOutbox(null, sink);
        return;
      }
      // Never holds the queue up: every failure is kept for the next drain.
      await runCleanups(sink);
      for (let guard = 0; guard < 200; guard++) {
        await deliverOutbox(repo, sink);
        const { state } = load();
        if (state.paused || deps.stopped()) return;
        const effect = awaited(state);
        if (!effect) return;
        // Pause merge queue: the batch under way finishes (its checks, its push), but no new batch is built.
        if (effect.kind === "build-chain" && deps.paused()) return;
        // Waiting for CI on GitHub, Pause merge queue stops merging: a wait under way is left, and nothing is pushed to the main branch.
        if (effect.kind === "fast-forward" && deps.paused() && githubCi()) return;
        let answer: QueueInput | "stop" | "wait";
        if (effect.kind === "build-chain") {
          answer = await buildChain(repo, effect);
          if (answer.kind === "chain-built") {
            sink.note("orchestrator.queue_batch", `Batch ${effect.batch}: ${answer.results.filter((r) => "sha" in r).length} of ${plural(effect.changes.length, "change")} built into one chain on ${effect.base.slice(0, 7)}.`, { batch: effect.batch });
          }
        } else if (effect.kind === "start-run" && githubCi()) {
          const result = await ciRun(repo, effect, sink);
          if (result === "wait") return;
          if (result === "parked") continue;
          answer = result;
        } else if (effect.kind === "start-run" || effect.kind === "rerun-files") answer = await runOn(repo, effect, sink);
        else if (effect.kind === "fast-forward") answer = await fastForward(repo, effect, sink);
        else return;
        if (answer === "stop" || answer === "wait") return;
        feed(answer);
      }
      sink.note("orchestrator.queue_problem", "The queue did not settle after 200 steps; it goes on at the next tick.");
    },

    state: () => load().state,
    pausedWhy: () => load().state.paused?.reason ?? null,
    resume(by) {
      feed({ kind: "resume", by });
    },
    checkMissing() {
      const config = deps.config();
      if (mergeQueueCi(config) === "github") {
        return deps.ci ? null : `${noCi()}, so it cannot open the batch's pull request`;
      }
      return config.checkCommand ? null : "the project names no checkCommand";
    },
  };
}
