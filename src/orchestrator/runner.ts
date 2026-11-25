// The agent runner: one agent CLI child per session (started, read and resumed through its provider, `agent.ts`), in a
// worktree the runner makes itself or in a clone it takes from the project's pool (workspaces.ts).
// It writes the raw stream to a file, keeps the Session object in the store current, kills
// whole process trees on stall, timeout and stop, and leaves no orphan behind a restart.

import type { ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../config/types.ts";
import { refKey } from "../model/types.ts";
import type { Ref, Session, SessionRole, SessionStatus, UsageSample } from "../model/types.ts";
import { ROLES } from "../store/control.ts";
import type { Store } from "../store/store.ts";
import { resetAfterRejection } from "./usageCheck.ts";
import { identityEnv, sessionIdentity } from "./identity.ts";
import { BRANCH_PREFIX, PathRefused } from "./paths.ts";
import type { AgentRunner, SessionRequest, SessionResultRecord } from "./ports.ts";
import { realGit, realProcesses } from "./process.ts";
import type { Git, ProcessControl } from "./process.ts";
import type { AgentProvider, EventReader, Launch } from "./agent.ts";
import { providerFor } from "./providers/index.ts";
import { loadRole, renderTemplate } from "./roles.ts";
import { restoreWip, wipPatchPath } from "./wip.ts";
import { baseRef, changedPaths, changeStat, commitsAhead, commitsTouching, deleteBranch, fetchMain, isAncestor, squashedOnMain } from "./worktree.ts";
import type { RunCheck } from "./checkRunner.ts";
import { createSetupRunner, ensureSetup, setupPromptLine } from "./setup.ts";
import { prepareSlot, releaseSlot } from "./slots.ts";
import { cloneRepoForBranch, deleteBranchInPool, loadHoldings, NoFreeClone, poolRepoPath, prepareClone, releaseClone, takeClone } from "./workspaces.ts";
import type { PoolDeps } from "./workspaces.ts";
import { NO_DECISIONS } from "./jobs.ts";
import type { Resources } from "./resources.ts";

export const SESSION_HOST = "scopesoup";
const ACTOR = "orchestrator";
/** When a limit was hit and nothing said when it resets. */
const UNKNOWN_RESET_WAIT_MS = 30 * 60_000;

export interface RunnerDeps {
  store: Store;
  /** The configuration in use now. Read at every start and every reconcile. */
  config: () => ProjectConfig;
  /** Milliseconds since the epoch. */
  now?: () => number;
  processes?: ProcessControl;
  git?: Git;
  newId?: () => string;
  /** The environment children inherit. */
  env?: NodeJS.ProcessEnv;
  /** Called after a session is over and stored. */
  onFinished?: (session: Session) => void;
  /** The Session object is rewritten at most this often while events stream in. */
  storeWriteIntervalMs?: number;
  /** Runs `setupCommand`. Default: a check runner over `processes` with `setupEnv` of `env` and the configuration. */
  runSetup?: RunCheck;
  /** True once a person pressed Stop and the role was not resumed since: a setup under way for its session is ended. */
  stopped?: (role: SessionRole) => boolean;
  /** The agent provider for a session. Default: `providerFor` (`providers/index.ts`); tests give a fake. */
  provider?: (config: ProjectConfig, request: SessionRequest) => AgentProvider;
  /** The limited resources: the units the caller took for a session are given back here once it is over, however it ended. */
  resources?: Resources;
}

export interface Runner extends AgentRunner {
  /** Resolves with the stored Session once it is over. */
  finished(sessionId: string): Promise<Session>;
  busy(subject: Ref): boolean;
}

interface Live {
  session: Session;
  child: ChildProcess;
  provider: AgentProvider;
  /** The environment the child got, for `readUsage`. */
  env: NodeJS.ProcessEnv;
  parser: EventReader;
  file: WriteStream;
  workspace: string;
  hasSchema: boolean;
  startedMs: number;
  lastEventMs: number;
  lastWriteMs: number;
  stderrTail: string;
  /** Set when the runner itself ended the session; decides the final status. */
  kill?: { status: SessionStatus; endReason: string };
  over: boolean;
  done: Promise<Session>;
  settle: (session: Session) => void;
}

export function sessionResultKey(sessionId: string): string {
  return `session.result:${sessionId}`;
}

export function readSessionResult(store: Store, sessionId: string): SessionResultRecord {
  const text = store.getValue(sessionResultKey(sessionId));
  if (!text) return {};
  try {
    return JSON.parse(text) as SessionResultRecord;
  } catch {
    return {};
  }
}

/** How far a process's creation time may differ from the recorded session start and still be that session's. */
const SPAWN_BEFORE_MS = 5 * 60_000;
const SPAWN_AFTER_MS = 10_000;

export function createRunner(deps: RunnerDeps): Runner {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const processes = deps.processes ?? realProcesses;
  const git = deps.git ?? realGit;
  const writeInterval = deps.storeWriteIntervalMs ?? 2000;
  let counter = 0;
  const newId = deps.newId ?? (() => `s${now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  const live = new Map<string, Live>();
  /** Starts being prepared, by subject: counted from the moment `start` is called, so `busy` sees them before the first await. */
  const preparing = new Map<string, number>();
  const finishedSessions = new Map<string, Promise<Session>>();

  const runSetup = deps.runSetup ?? createSetupRunner(processes, deps.env ?? process.env, deps.config, now);
  /** Raised by every Stop: a setup under way ends when it changes. */
  /** Counts the stops per role, so a setup under way sees one that happened meanwhile. */
  const stops: Record<SessionRole, number> = { triage: 0, implement: 0, review: 0 };
  const iso = (ms: number): string => new Date(ms).toISOString();
  const poolDeps = (config: ProjectConfig): PoolDeps => ({ store, config, git, at: iso(now()), processes });

  function save(entry: Live): void {
    entry.lastWriteMs = now();
    store.put(entry.session, ACTOR, iso(now()));
  }

  /** A session that never got a process: refused, or its preparation failed. */
  function stillborn(request: SessionRequest, endReason: string, extra: { status?: SessionStatus; setupFailed?: true; setupOutcome?: string; cwd?: string } = {}): Session {
    const at = iso(now());
    const session: Session = {
      ref: { host: SESSION_HOST, kind: "session", id: newId() },
      role: request.role,
      subject: request.subject,
      status: extra.status ?? "failed",
      attempt: request.attempt,
      startedAt: at,
      finishedAt: at,
      endReason,
      ...(extra.setupFailed ? { setupFailed: true as const } : {}),
      ...(extra.setupOutcome ? { setupOutcome: extra.setupOutcome } : {}),
      ...(extra.cwd ? { cwd: extra.cwd } : {}),
    };
    store.tx(() => {
      store.put(session, ACTOR, at);
      store.setValue(sessionResultKey(session.ref.id), "{}");
    });
    finishedSessions.set(session.ref.id, Promise.resolve(session));
    void deps.resources?.give(refKey(request.subject));
    deps.onFinished?.(session);
    return session;
  }

  function finish(entry: Live, code: number | null, signal: string | null, spawnError?: Error): void {
    if (entry.over) return;
    entry.over = true;
    for (const event of entry.parser.end()) {
      if (event.kind === "usage") store.addUsageSample(event.sample);
    }
    if (!entry.provider.readUsage) {
      conclude(entry, code, signal, spawnError);
      return;
    }
    // A provider whose stream carries no usage reads it once the session is over: the reading tells a limit hit apart.
    void entry.provider.readUsage(deps.config(), entry.env).catch(() => null).then((sample) => {
      if (sample) store.addUsageSample(sample);
      conclude(entry, code, signal, spawnError, sample ?? undefined);
    });
  }

  function conclude(entry: Live, code: number | null, signal: string | null, spawnError?: Error, readUsage?: UsageSample): void {
    // The session counts as over only once its stream file is on disk: whoever is told it finished may read the file.
    const flushed = new Promise<void>((resolve) => entry.file.end(() => resolve()));
    entry.file.on("error", () => undefined);
    const summary = entry.parser.summary();
    const lastUsage = readUsage ?? summary.lastUsage;
    const at = now();
    const record: SessionResultRecord = { malformedLines: summary.malformed };
    if (summary.result?.turns !== undefined) record.turns = summary.result.turns;
    if (summary.result?.subtype !== undefined) record.subtype = summary.result.subtype;
    if (summary.result?.denied) record.denied = summary.result.denied;
    if (summary.result?.premiumRequests !== undefined) record.premiumRequests = summary.result.premiumRequests;
    if (summary.result?.aiCredits !== undefined) record.aiCredits = summary.result.aiCredits;

    let status: SessionStatus;
    let endReason: string;
    const exit = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    if (entry.kill) {
      ({ status, endReason } = entry.kill);
    } else if (spawnError) {
      status = "failed";
      endReason = `Could not start the agent: ${spawnError.message}`;
    } else if (entry.parser.limitHit(lastUsage)) {
      status = "limit";
      const reset = lastUsage ? resetAfterRejection(lastUsage, iso(at)) : undefined;
      record.resumeAt = reset ?? iso(at + UNKNOWN_RESET_WAIT_MS);
      endReason = reset
        ? `Usage limit hit; it resets at ${reset}.`
        : `Usage limit hit; the reset time is unknown, trying again at ${record.resumeAt}.`;
    } else if (!summary.result) {
      status = "failed";
      endReason = `The agent exited with ${exit} and no result.${entry.stderrTail ? ` Last error output: ${entry.stderrTail.trim().slice(-300)}` : ""}`;
    } else if (summary.result.isError) {
      status = "failed";
      endReason = `The agent ended with an error (${summary.result.subtype ?? "unknown"})${summary.result.text ? `: ${summary.result.text.slice(0, 300)}` : "."}`;
    } else if (entry.hasSchema && !summary.result.hasStructuredOutput) {
      status = "failed";
      endReason = "The agent ended without an answer that fits the schema.";
    } else if (code !== 0) {
      status = "failed";
      endReason = `The agent gave a result but exited with ${exit}.`;
    } else {
      status = "succeeded";
      endReason = "Completed.";
      // A chat turn's reply is free text: never kept as the role's answer, whatever the stream says.
      if (summary.result.hasStructuredOutput && !entry.session.chat) record.output = summary.result.structuredOutput;
    }

    const session = entry.session;
    session.status = status;
    session.endReason = endReason;
    session.finishedAt = iso(at);
    if (summary.sessionId) session.agentSessionId = summary.sessionId;
    if (summary.lastAction) session.lastAction = summary.lastAction;
    if (summary.result?.costUsd !== undefined) session.costUsd = summary.result.costUsd;
    store.tx(() => {
      store.setValue(sessionResultKey(session.ref.id), JSON.stringify(record));
      store.put(session, ACTOR, iso(at));
    });
    live.delete(session.ref.id);
    void deps.resources?.give(refKey(session.subject));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000).unref());
    void Promise.race([flushed, timeout]).then(() => {
      entry.settle(session);
      deps.onFinished?.(session);
    });
  }

  function onChunk(entry: Live, chunk: string): void {
    entry.file.write(chunk);
    const events = entry.parser.push(chunk);
    if (events.length === 0) return;
    const at = now();
    entry.lastEventMs = at;
    const session = entry.session;
    session.lastEventAt = iso(at);
    let important = false;
    for (const event of events) {
      if (event.kind === "init") {
        session.agentSessionId = event.sessionId;
        important = true;
      } else if (event.kind === "action") session.lastAction = event.text;
      else if (event.kind === "usage") store.addUsageSample(event.sample);
      else if (event.kind === "result" && event.result.costUsd !== undefined) session.costUsd = event.result.costUsd;
    }
    if (important || at - entry.lastWriteMs >= writeInterval) save(entry);
  }

  function kill(entry: Live, status: SessionStatus, endReason: string): void {
    if (entry.kill || entry.over) return;
    entry.kill = { status, endReason };
    entry.session.status = status === "stalled" ? "stalled" : entry.session.status;
    const pid = entry.child.pid;
    if (pid !== undefined) processes.killTree(pid);
    else finish(entry, null, null);
  }

  /** Puts the item's worktree, or the project's repository in its clone, on its branch, and returns the path. */
  async function prepareWorkspace(config: ProjectConfig, subject: Ref, workspace: string, branch: string): Promise<string> {
    const onFetchFailed = (reason: string): void => {
      store.appendEvent({
        kind: "orchestrator.fetch_failed", subject: refKey(subject), actor: ACTOR,
        data: { remote: config.remote, branch: config.mainBranch, reason: `Could not fetch ${config.remote}/${config.mainBranch}; the branch starts from the local ${config.mainBranch}. ${reason}` },
      }, iso(now()));
    };
    if (config.workspaces.kind === "pool") {
      const cwd = await prepareClone(poolDeps(config), { item: subject, workspace, branch, mainBranch: config.mainBranch, remote: config.remote, onFetchFailed });
      // Checked again on what is on disk now: the subfolder must not have become a link elsewhere.
      const holding = loadHoldings(store)[workspace];
      if (!holding || poolRepoPath(config, holding.clone) !== cwd) throw new PathRefused(`${cwd} is no longer the project's repository in the item's clone.`);
      return cwd;
    }
    // A worktree reused across Items, put on this Item's branch.
    const cwd = await prepareSlot({ store, config, git, at: iso(now()) }, { item: subject, workspace, branch, mainBranch: config.mainBranch, remote: config.remote, onFetchFailed });
    return cwd;
  }

  /**
   * The project's setup in the folder, when it must run (`setup.ts`). Not before a triage, which only reads. Null when the
   * session may start; else the stillborn session (setup failed, or Stop ended it).
   */
  async function setUp(config: ProjectConfig, request: SessionRequest, cwd: string): Promise<Session | null> {
    if (!config.setupCommand || request.role === "triage") return null;
    const key = refKey(request.subject);
    const begun = stops[request.role];
    const result = await ensureSetup({
      git, run: runSetup, timeoutMs: config.settings.checkTimeoutMinutes.value * 60_000, stop: () => stops[request.role] !== begun || deps.stopped?.(request.role) === true, now: () => iso(now()),
    }, config, cwd);
    if (result.kind === "ran") {
      store.appendEvent({ kind: "orchestrator.setup_ran", subject: key, actor: ACTOR, data: { cwd, ms: result.ms, reason: `The setup ran in ${cwd} before the ${request.role} session (${result.why}) and passed in ${Math.round(result.ms / 1000)} s.` } }, iso(now()));
    } else if (result.kind === "stopped") {
      return stillborn(request, "Stopped while the setup ran; the session did not start.", { status: "cancelled", cwd });
    } else if (result.kind === "failed") {
      // The whole reason, with the end of the output, stays on this machine: the local event and the session the Item page shows.
      // What the cycle writes to the host is built from `setupOutcome` (`setupFailedText`), never from this.
      const reason = `Setup failed in ${cwd} (${result.why}), so no ${request.role} session started. ${result.reason}`;
      store.appendEvent({ kind: "orchestrator.setup_failed", subject: key, actor: ACTOR, data: { cwd, outcome: result.outcome, reason } }, iso(now()));
      return stillborn(request, reason, { setupFailed: true, setupOutcome: result.outcome, cwd });
    }
    return null;
  }

  /**
   * Fetches the remote's main branch into the repository the session works in and names what the
   * change is compared with: the remote's main branch, or the local one when there is no such
   * ref. A local main branch is never moved: in a pool clone it stays where the clone was made.
   * A failed fetch is not logged here; the ref fetched last is used.
   */
  async function freshBase(config: ProjectConfig, cwd: string): Promise<string> {
    await git(["fetch", "--quiet", config.remote, `+refs/heads/${config.mainBranch}:refs/remotes/${config.remote}/${config.mainBranch}`], cwd);
    const ref = await baseRef(git, cwd, config.mainBranch, config.remote);
    return ref === config.mainBranch ? ref : `${config.remote}/${config.mainBranch}`;
  }

  async function start(request: SessionRequest): Promise<Session> {
    // Marked before anything is awaited: a caller that checks `busy` and then starts (the tick, a chat turn) cannot be overtaken.
    const key = refKey(request.subject);
    preparing.set(key, (preparing.get(key) ?? 0) + 1);
    try {
      return await startSession(request);
    } finally {
      const left = (preparing.get(key) ?? 1) - 1;
      if (left > 0) preparing.set(key, left);
      else preparing.delete(key);
    }
  }

  async function startSession(request: SessionRequest): Promise<Session> {
    const config = deps.config();
    const provider = deps.provider?.(config, request) ?? providerFor(config, request.role);
    // A core rule: a session runs only where the CLI itself refuses the commands its role may not run.
    if (provider.commandLimit !== "allowlist") {
      return stillborn(request, `Refused: the agent provider ${provider.name} cannot hold a session to the role's allowedTools (it limits commands with a ${provider.commandLimit} only), and whether that is enough is a person's decision.`);
    }
    const id = newId();
    const streamPath = join(config.streamsDir, `${id}.ndjson`);
    let cwd: string;
    let command: Launch;
    let hasSchema: boolean;
    let schema: string | undefined;
    try {
      if (request.chat && !(request.resume && request.message)) throw new Error("a chat turn needs the session to resume and a person's message");
      const role = loadRole(config.promptsDir, request.role);
      // A chat turn keeps the role's model, permission mode and tools but not its answer schema: the reply is free text.
      const spec = request.chat ? { role: role.role, template: role.template } : role;
      hasSchema = spec.schema !== undefined;
      schema = spec.schema;
      cwd = await prepareWorkspace(config, request.subject, request.workspace, request.branch);
      const base = await freshBase(config, cwd);
      // A fresh worktree gets back the edits the item's last session left uncommitted; the session is told.
      const restored = config.workspaces.kind === "worktree" ? await restoreWip(git, cwd, wipPatchPath(config.streamsDir, request.workspace)) : null;
      const unset = await setUp(config, request, cwd);
      if (unset) return unset;
      // A reused worktree may not be the folder the session to resume ran in; the agent CLI keeps a session per folder, so it starts afresh with the prompt.
      if (request.resume && config.workspaces.kind === "worktree" && !request.chat) {
        const ran = store.list<Session>("session", SESSION_HOST).find((each) => each.agentSessionId === request.resume && each.cwd !== undefined);
        if (ran?.cwd && ran.cwd !== cwd) {
          const { resume: _elsewhere, ...fresh } = request;
          request = fresh;
        }
      }
      // A resumed session with a message (findings, a failed merging) is sent only the message: it has the prompt already.
      const rendered = request.resume && request.message ? request.message : renderTemplate(spec.template, { setup: setupPromptLine(config), decisions: NO_DECISIONS, recheck: "", ...request.vars, base });
      const prompt = request.message && rendered !== request.message ? `${rendered}\n\n${request.message}` : rendered;
      command = provider.launch({
        config, role: spec.role, prompt: restored ? `${prompt}\n\n${restored}\n` : prompt, partial: request.chat === true, env: { ...(deps.env ?? process.env) }, streamPath, nodePath: process.execPath,
        ...(spec.schema ? { schema: spec.schema } : {}), ...(request.resume ? { resume: request.resume } : {}),
      });
      mkdirSync(config.streamsDir, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return stillborn(request, error instanceof PathRefused ? `Refused: ${message}` : error instanceof NoFreeClone ? message : `Could not prepare the session: ${message}`);
    }

    const startedMs = now();
    const session: Session = {
      ref: { host: SESSION_HOST, kind: "session", id },
      role: request.role,
      subject: request.subject,
      status: "starting",
      model: config.roles[request.role].model,
      provider: provider.name,
      attempt: request.attempt,
      startedAt: iso(startedMs),
      streamPath,
      cwd,
    };
    if (request.resume) session.agentSessionId = request.resume;
    if (request.chat) session.chat = true;

    const env = { ...command.env };
    // Commits are the session's, not the person's whose machine this is.
    Object.assign(env, identityEnv(sessionIdentity(request.role, request.subject.id, session.model ?? "", config.machineName)));
    // The instance of each resource unit the session holds (its emulator's port, its database's name).
    if (request.env) Object.assign(env, request.env);

    let settle: (session: Session) => void = () => undefined;
    const done = new Promise<Session>((resolve) => (settle = resolve));
    finishedSessions.set(id, done);

    let child: ChildProcess;
    try {
      child = processes.spawn(command.command, command.args, { cwd, env, stdin: command.stdin !== undefined, advice: provider.advice });
    } catch (error) {
      finishedSessions.delete(id);
      return stillborn(request, `Could not start the agent: ${error instanceof Error ? error.message : String(error)}`);
    }

    const entry: Live = {
      session, child, provider, env, workspace: request.workspace, hasSchema, startedMs,
      parser: provider.reader(() => iso(now()), cwd, schema),
      file: createWriteStream(streamPath, { flags: "a" }),
      lastEventMs: startedMs, lastWriteMs: 0, stderrTail: "", over: false, done, settle,
    };
    entry.file.on("error", () => undefined);
    live.set(id, entry);
    if (child.pid !== undefined) {
      session.pid = child.pid;
      session.status = "running";
    }
    save(entry);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => onChunk(entry, chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (entry.stderrTail = (entry.stderrTail + chunk).slice(-2000)));
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
      // Without a pid there will be no close event.
      if (child.pid === undefined) finish(entry, null, null, error);
    });
    child.on("close", (code, signal) => finish(entry, code, signal, spawnError));
    if (command.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(command.stdin);
    }
    return session;
  }

  async function reconcile(): Promise<void> {
    const config = deps.config();
    const at = now();
    const stallMs = config.settings.stallTimeoutMinutes.value * 60_000;
    const hardMs = config.settings.sessionTimeoutMinutes.value * 60_000;
    for (const entry of live.values()) {
      if (entry.kill || entry.over) continue;
      if (at - entry.startedMs > hardMs) {
        kill(entry, "failed", `Timed out: still running after ${config.settings.sessionTimeoutMinutes.value} minutes. Killed.`);
      } else if (at - entry.lastEventMs > stallMs) {
        kill(entry, "stalled", `Stalled: no event for ${config.settings.stallTimeoutMinutes.value} minutes. Killed.`);
        save(entry);
      }
    }

    // Sessions the store calls live that this process does not hold: left by an earlier run.
    for (const session of store.list<Session>("session", SESSION_HOST)) {
      if (session.status !== "starting" && session.status !== "running" && session.status !== "stalled") continue;
      if (session.finishedAt || live.has(session.ref.id)) continue;
      let what = "its process is gone";
      if (session.pid !== undefined && processes.isAlive(session.pid)) {
        const startedMs = Date.parse(session.startedAt);
        if (startedMs < processes.bootTimeMs()) {
          what = `the machine restarted since, so process ${session.pid} is another program and was left alone`;
        } else {
          // Pids are reused (Windows does it quickly, and a shutdown that hibernates does not reset the boot time), so the process
          // must also have been created when this session started: at most SPAWN_BEFORE_MS before it was recorded, not after.
          const created = await processes.startTimeMs(session.pid);
          if (created === null) what = `process ${session.pid} is there but its start time could not be read, so it was left alone`;
          else if (created > startedMs + SPAWN_AFTER_MS || created < startedMs - SPAWN_BEFORE_MS) {
            what = `process ${session.pid} was created at ${iso(created)}, not when the session started, so it is another program and was left alone`;
          } else {
            processes.killTree(session.pid, created);
            what = `its process ${session.pid} was still there and was killed`;
          }
        }
      }
      const over: Session = { ...session, status: "failed", finishedAt: iso(at), endReason: `Orphaned: left by an earlier run of Scope Soup; ${what}.` };
      store.tx(() => {
        if (store.getValue(sessionResultKey(session.ref.id)) === null) store.setValue(sessionResultKey(session.ref.id), "{}");
        store.put(over, ACTOR, iso(at));
      });
    }
  }

  return {
    start,
    reconcile,

    stopAll(reason, roles) {
      for (const role of roles ?? ROLES) stops[role]++;
      let stopped = 0;
      for (const entry of live.values()) {
        if (entry.kill || entry.over || (roles && !roles.includes(entry.session.role))) continue;
        kill(entry, "cancelled", reason);
        stopped++;
      }
      return stopped;
    },

    stopFor(subject, reason) {
      let stopped = 0;
      for (const entry of live.values()) {
        if (entry.kill || entry.over || refKey(entry.session.subject) !== refKey(subject)) continue;
        kill(entry, "cancelled", reason);
        stopped++;
      }
      return stopped;
    },

    running() {
      return live.size;
    },

    async takeWorkspace(item, workspace, branch, head) {
      const config = deps.config();
      if (config.workspaces.kind !== "pool") return null;
      return takeClone(poolDeps(config), item, workspace, branch, head);
    },

    async releaseWorkspace(workspace, reason) {
      for (const entry of live.values()) {
        if (entry.workspace === workspace) throw new Error(`Workspace ${workspace} is in use by session ${entry.session.ref.id}.`);
      }
      const config = deps.config();
      if (config.workspaces.kind === "pool") await releaseClone(poolDeps(config), workspace, reason);
      else await releaseSlot({ store, config, git, at: iso(now()) }, workspace, wipPatchPath(config.streamsDir, workspace), reason);
    },

    async deleteBranch(branch) {
      const config = deps.config();
      if (branch === config.mainBranch || !branch.startsWith(BRANCH_PREFIX) || branch.length === BRANCH_PREFIX.length) {
        throw new Error(`Refusing to delete ${branch}: only item branches (${BRANCH_PREFIX}...) are deleted, never the main branch.`);
      }
      if (config.workspaces.kind === "pool") await deleteBranchInPool(poolDeps(config), branch);
      else await deleteBranch(git, config.repoPath, branch);
    },

    async changedPaths(branch) {
      const config = deps.config();
      const repo = config.workspaces.kind === "pool" ? cloneRepoForBranch(store, config, branch) : config.repoPath;
      return changedPaths(git, repo, config.mainBranch, config.remote, branch);
    },

    async changeStat(branch) {
      const config = deps.config();
      const repo = config.workspaces.kind === "pool" ? cloneRepoForBranch(store, config, branch) : config.repoPath;
      return changeStat(git, repo, config.mainBranch, config.remote, branch);
    },

    async commitsAhead(branch) {
      const config = deps.config();
      const repo = config.workspaces.kind === "pool" ? cloneRepoForBranch(store, config, branch) : config.repoPath;
      return commitsAhead(git, repo, config.mainBranch, config.remote, branch);
    },

    async head(branch) {
      const config = deps.config();
      const repo = config.workspaces.kind === "pool" ? cloneRepoForBranch(store, config, branch) : config.repoPath;
      const result = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], repo);
      if (result.code !== 0) throw new Error(`The branch ${branch} is not there.`);
      return result.stdout.trim();
    },

    async fetchMain(branch) {
      const config = deps.config();
      const repo = config.workspaces.kind === "pool" ? cloneRepoForBranch(store, config, branch) : config.repoPath;
      return { repo, main: await fetchMain(git, repo, config.mainBranch, config.remote) };
    },

    async contains(branch, ancestor, descendant) {
      const config = deps.config();
      const repo = config.workspaces.kind === "pool" ? cloneRepoForBranch(store, config, branch) : config.repoPath;
      return isAncestor(git, repo, ancestor, descendant);
    },

    async squashed(branch, commit, base, head, tip) {
      const config = deps.config();
      const repo = config.workspaces.kind === "pool" ? cloneRepoForBranch(store, config, branch) : config.repoPath;
      return squashedOnMain(git, repo, commit, base, head, tip);
    },

    async commitsTouching(branch, since, until, paths, max) {
      const config = deps.config();
      const repo = config.workspaces.kind === "pool" ? cloneRepoForBranch(store, config, branch) : config.repoPath;
      return commitsTouching(git, repo, since, until, paths, max);
    },

    busy(subject) {
      const key = refKey(subject);
      if (preparing.has(key)) return true;
      for (const entry of live.values()) if (!entry.over && refKey(entry.session.subject) === key) return true;
      return false;
    },

    finished(sessionId) {
      return finishedSessions.get(sessionId) ?? Promise.reject(new Error(`No session ${sessionId} was started by this runner.`));
    },
  };
}
