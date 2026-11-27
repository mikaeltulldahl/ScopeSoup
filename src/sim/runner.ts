// The simulator's runner: an AgentRunner whose sessions start when the tick asks and end when the simulator says, over the
// fake git. Below it (processes, streams, worktrees on disk) is not simulated.

import type { Ref, Session, SessionStatus } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { AgentRunner, SessionRequest } from "../orchestrator/ports.ts";
import { sessionResultKey } from "../orchestrator/runner.ts";
import type { Store } from "../store/store.ts";
import type { FakeGit } from "./git.ts";

export interface LiveSession {
  session: Session;
  request: SessionRequest;
  /** The maxParallelSessions in force when it started (rule D1). */
  limitAtStart: number;
  /** The simulator's step when it started. */
  startedStep: number;
}

export interface SimRunner extends AgentRunner {
  /** Sessions with a live process, by session id. */
  live: Map<string, LiveSession>;
  requests: SessionRequest[];
  /** Workspaces released, with the reason. */
  released: string[];
  /** Branch deletions refused (main, or outside the item prefix). */
  refusedDeletes: string[];
  /** Ends a live session with a status and a result. */
  end(sessionId: string, status: SessionStatus, output?: unknown, extra?: { resumeAt?: string; endReason?: string }): void;
}

export interface RunnerContext {
  store: Store;
  git: FakeGit;
  now: () => string;
  limit: () => number;
  step: () => number;
  /** Called inside a start, before it returns: the "request inside a tick's await" step uses it. */
  during?: () => Promise<void>;
}

const LIVE: readonly string[] = ["starting", "running", "stalled"];

export function simRunner(ctx: RunnerContext, firstId = 1): SimRunner {
  const { store, git, now } = ctx;
  let count = firstId - 1;
  const live = new Map<string, LiveSession>();
  const settle = (session: Session, status: SessionStatus, endReason: string, output?: unknown, resumeAt?: string): void => {
    const over: Session = { ...session, status, finishedAt: now(), endReason, agentSessionId: `agent-${session.ref.id}` };
    live.delete(session.ref.id);
    store.setValue(sessionResultKey(session.ref.id), JSON.stringify({ output, resumeAt }));
    store.put(over, "orchestrator", now());
  };
  const runner: SimRunner = {
    live, requests: [], released: [], refusedDeletes: [],
    async start(request) {
      const session: Session = {
        ref: { host: "scopesoup", kind: "session", id: `s${++count}` }, role: request.role, subject: request.subject, status: "running",
        attempt: request.attempt, startedAt: now(), pid: 1000 + count, model: `model-of-${request.role}`, cwd: request.workspace,
      };
      runner.requests.push(request);
      live.set(session.ref.id, { session, request, limitAtStart: ctx.limit(), startedStep: ctx.step() });
      git.ensureWorktree(request.workspace, request.branch, refKey(request.subject));
      store.put(session, "orchestrator", now());
      if (ctx.during) await ctx.during();
      return session;
    },
    async reconcile() {
      // Sessions the store calls running with no process behind them (after a restart) are over.
      for (const session of store.list<Session>("session")) {
        if (LIVE.includes(session.status) && !live.has(session.ref.id)) {
          store.put({ ...session, status: "failed", finishedAt: now(), endReason: "no process backs it (Scope Soup restarted)", orphaned: true }, "orchestrator", now());
        }
      }
    },
    stopAll(reason, roles) {
      let n = 0;
      for (const each of [...live.values()]) {
        if (roles && !roles.includes(each.session.role)) continue;
        settle(each.session, "cancelled", reason);
        n++;
      }
      return n;
    },
    stopFor(subject: Ref, reason: string) {
      let n = 0;
      for (const each of [...live.values()]) {
        if (refKey(each.session.subject) !== refKey(subject)) continue;
        settle(each.session, "cancelled", reason);
        n++;
      }
      return n;
    },
    running: () => live.size,
    busy: (subject) => [...live.values()].some((each) => refKey(each.session.subject) === refKey(subject)),
    async takeWorkspace() {
      return null;
    },
    async releaseWorkspace(workspace, reason) {
      runner.released.push(`${workspace}: ${reason ?? ""}`);
      git.removeWorktree(workspace);
    },
    async deleteBranch(branch) {
      if (branch === "main" || !branch.startsWith("scopesoup/")) {
        runner.refusedDeletes.push(branch);
        throw new Error(`refused to delete ${branch}`);
      }
      for (const [workspace, tree] of git.worktrees) if (tree.branch === branch) git.removeWorktree(workspace);
      git.deleteBranch(branch);
    },
    async changedPaths(branch) {
      const head = git.branches.get(branch);
      if (!head) return [];
      return [...new Set(git.between(git.main, head).flatMap((c) => c.paths))].sort();
    },
    async commitsAhead(branch) {
      const head = git.branches.get(branch);
      if (!head) throw new Error(`no branch ${branch}`);
      return git.between(git.main, head).filter((c) => c.by === "agent").length;
    },
    async head(branch) {
      const head = git.branches.get(branch);
      if (!head) throw new Error(`no branch ${branch}`);
      return head;
    },
    async fetchMain() {
      return { repo: "/srv/clone", main: git.main };
    },
    async contains(_branch, ancestor, descendant) {
      return git.contains(ancestor, descendant);
    },
    async commitsTouching(_branch, since, until, paths, max) {
      if (!git.commits.has(since)) return null;
      const touching = git.between(since, until).filter((c) => c.paths.some((p) => paths.includes(p)));
      return { commits: touching.slice(0, max).map((c) => ({ sha: c.sha, subject: c.subject })), count: touching.length };
    },
    end(sessionId, status, output, extra = {}) {
      const each = live.get(sessionId);
      if (!each) throw new Error(`no live session ${sessionId}`);
      settle(each.session, status, extra.endReason ?? status, output, extra.resumeAt);
    },
  };
  return runner;
}
