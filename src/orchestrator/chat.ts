// A person's chat with an Item's sessions. Each message is one more turn of a session Scope Soup ran on the Item (a first
// look, an implementor or a reviewer): the session resumed through its agent provider in the Item's worktree, by the runner, with that
// role's model, permission mode and tools but without its answer schema. The reply is free text: it is shown on the board and
// never read as the role's answer, so a turn moves nothing. Scope Soup decides when a session runs: a message is refused while any
// session runs on the Item, and while a turn runs the tick starts nothing on it (`busy` in the runner).
// The conversation is kept in the store (`chat:<item>`), not posted on the host.

import { existsSync, readFileSync } from "node:fs";
import type { ProjectConfig } from "../config/types.ts";
import type { ChatSessionView, ChatTurnView, ChatView } from "../core/views.ts";
import { refKey } from "../model/types.ts";
import type { Ref, Session, SessionRole, WorkItem } from "../model/types.ts";
import { roleStopped, SWITCH_WORDS } from "../store/control.ts";
import type { Resources } from "./resources.ts";
import type { Store } from "../store/store.ts";
import { errorText } from "./context.ts";
import { loadJobs, saveJobs } from "./jobs.ts";
import type { Job } from "./jobs.ts";
import { workspacePath } from "./paths.ts";
import { heldSlot, holderOf, lastSlotPath, slotPathFor } from "./slots.ts";
import type { AgentRunner } from "./ports.ts";
import { usageDecision } from "./tick.ts";
import { providerNamed } from "./providers/index.ts";
import { poolRepoPath, readHoldings, samePath } from "./workspaces.ts";

/** One turn as stored. `agentSession` is the session it continued (or the one the reply came from, when the agent forked it). */
export interface ChatTurn {
  id: string;
  at: string;
  agentSession: string;
  role: SessionRole;
  message: string;
  /** The runner's session for the turn. */
  session?: string;
  /** The reply's text, kept once the turn is over. */
  reply?: string;
  /** Set when the turn ended without a reply that counts. */
  failed?: string;
  finishedAt?: string;
}

export type ChatRunner = Pick<AgentRunner, "start" | "running" | "takeWorkspace" | "releaseWorkspace"> & {
  busy(subject: Ref): boolean;
  finished(sessionId: string): Promise<Session>;
};

export interface ChatDeps {
  store: Store;
  runner: ChatRunner;
  config: () => ProjectConfig;
  now: () => string;
  newId?: () => string;
  /** The limited resources the role needs: a turn takes a unit like any session, or is refused while none is free. */
  resources?: Resources;
}

export type ChatSendResult =
  | { ok: true; turn: ChatTurn }
  | { ok: false; status: number; code: string; message: string };

export interface Chat {
  view(item: string): ChatView;
  /** `by`: who sent it (the board's picked person). */
  send(item: string, agentSession: string, message: string, by?: string): Promise<ChatSendResult>;
  /** Resolves once every turn started here is over and stored. For tests and shutdown. */
  idle(): Promise<void>;
}

export const MAX_MESSAGE = 20_000;
const LIVE: readonly Session["status"][] = ["starting", "running", "stalled"];
const ROLE_WORDS: Record<string, string> = { triage: "triage", implement: "implement", review: "review" };

export function chatKey(item: string): string {
  return `chat:${item}`;
}

export function readTurns(store: Pick<Store, "getValue">, item: string): ChatTurn[] {
  const text = store.getValue(chatKey(item));
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as ChatTurn[]) : [];
  } catch {
    return [];
  }
}

function isLive(session: Session | null | undefined): boolean {
  return session !== null && session !== undefined && LIVE.includes(session.status) && !session.finishedAt;
}

/** The reply in a chat turn's stream, as the provider that wrote it reads it. */
export function replyFromStream(text: string, provider?: string): string {
  return providerNamed(provider).replyIn(text);
}

function readReply(session: Session | null): string {
  if (!session?.streamPath) return "";
  try {
    return replyFromStream(readFileSync(session.streamPath, "utf8"), session.provider);
  } catch {
    return "";
  }
}

/** The item's sessions that can be resumed (each with its own `agentSessionId`), newest first. */
export function knownSessions(store: Store, item: string): { agentSession: string; role: SessionRole; model?: string; startedAt: string }[] {
  const groups = new Map<string, { agentSession: string; role: SessionRole; model?: string; startedAt: string; step: boolean }>();
  for (const session of store.list<Session>("session")) {
    if (refKey(session.subject) !== item || !session.agentSessionId) continue;
    const step = !session.chat;
    const known = groups.get(session.agentSessionId);
    // A step session names the session's role and time; a chat turn only when no step session is known (a forked session).
    if (known && (known.step && !step || (known.step === step && known.startedAt >= session.startedAt))) continue;
    groups.set(session.agentSessionId, { agentSession: session.agentSessionId, role: session.role, ...(session.model ? { model: session.model } : {}), startedAt: session.startedAt, step });
  }
  return [...groups.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(({ step: _step, ...rest }) => rest);
}

/** The folder the session last ran in (a step or an earlier chat turn), when Scope Soup recorded it. */
export function sessionFolder(store: Store, item: string, agentSession: string): string | undefined {
  return store.list<Session>("session")
    .filter((session) => refKey(session.subject) === item && session.agentSessionId === agentSession && session.cwd)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .pop()?.cwd;
}

/** The project's repository in a clone of the pool, or null when the path check refuses it. */
function repoOf(config: ProjectConfig, clone: string): string | null {
  try {
    return poolRepoPath(config, clone);
  } catch {
    return null;
  }
}

/**
 * Why the session cannot be resumed in the folder it ran in, before a clone of the pool is taken for the turn; null when it can.
 * The agent CLI keeps a session per folder: resumed anywhere else it finds no conversation.
 */
export function poolRefusal(store: Store, config: ProjectConfig, job: Job, folder: string | undefined): string | null {
  if (config.workspaces.kind !== "pool") return null;
  if (!folder) return "Scope Soup did not record which clone of the pool this session ran in, and the agent keeps its session per folder, so it cannot be resumed.";
  if (!existsSync(folder)) return `The folder the session ran in (${folder}) is gone, so the session cannot be resumed.`;
  const clone = config.workspaces.paths.find((each) => {
    const repo = repoOf(config, each);
    return repo !== null && samePath(repo, folder);
  });
  if (!clone) return `The folder the session ran in (${folder}) is not a clone of the pool any more, so the session cannot be resumed.`;
  const holdings = readHoldings(store).holdings;
  const mine = holdings[job.workspace];
  if (mine && !samePath(mine.clone, clone)) {
    return `The session ran in the clone ${clone}, but the Item's work is in the clone ${mine.clone} now; the agent keeps its session per folder, so it cannot be resumed there.`;
  }
  const other = Object.entries(holdings).find(([key, holding]) => key !== job.workspace && holding.held && samePath(holding.clone, clone));
  if (other) return `The clone the session ran in (${clone}) now holds another Item's work (${other[1].item}), so the session cannot be resumed there.`;
  return null;
}

export function createChat(deps: ChatDeps): Chat {
  const { store, runner } = deps;
  let counter = 0;
  const newId = deps.newId ?? (() => `c${Date.parse(deps.now()).toString(36)}${(counter++).toString(36)}`);
  /** Items whose turn is being started here: from the check until its session is stored. */
  const pending = new Set<string>();
  const running = new Set<Promise<void>>();

  const session = (id: string | undefined): Session | null => (id ? store.get<Session>({ host: "scopesoup", kind: "session", id }) : null);

  function config(): ProjectConfig | null {
    try {
      return deps.config();
    } catch {
      return null;
    }
  }

  function work(item: string): WorkItem | undefined {
    return store.list<WorkItem>("work").find((each) => refKey(each.ref) === item);
  }

  /** Why no message can be sent on the item now; null when one can. Synchronous, so it can be checked right before the start. */
  function blocked(item: string, job: Job | undefined, at: string): string | null {
    const current = config();
    if (!current) return "This server has no project configuration, so it runs no sessions.";
    if (!job) return "The Item has no work under way here, so there is no worktree to talk to its sessions in.";
    if (job.merged) return "The Item is merged, so its sessions take no more messages.";
    // Level 4: the branch is the queue's now; a turn could change it under the merge.
    if (job.parked?.as === "queued" || job.queued !== undefined || job.owes === "hand-over") {
      return "The Item is queued for merging (or being merged); talk to its sessions once it merges or comes back.";
    }
    if (roleStopped(store, job.step)) return `Stop was pressed: no ${job.step} session runs until you press Resume ${SWITCH_WORDS[job.step]}.`;
    const turns = readTurns(store, item);
    if (pending.has(item) || turns.some((turn) => !turn.finishedAt && isLive(session(turn.session)))) return "Your last message is still being answered.";
    const live = store.list<Session>("session").find((each) => refKey(each.subject) === item && isLive(each));
    if (runner.busy(job.item) || live) {
      return `Scope Soup is running ${live ? `the ${ROLE_WORDS[live.role] ?? live.role} session` : "a session"} on this Item; you can write when it is over.`;
    }
    const holder = work(item)?.holder;
    if (holder && !holder.actor.bot) {
      return `${holder.actor.name} holds this Item, so Scope Soup leaves it alone.`;
    }
    const budget = usageDecision(store, current, job.step, at, runner.running());
    if (!budget.allow) return `The usage stop: ${budget.reason}`;
    return null;
  }

  function writeTurn(item: string, turn: ChatTurn): void {
    const turns = readTurns(store, item);
    const index = turns.findIndex((each) => each.id === turn.id);
    if (index >= 0) turns[index] = turn;
    else turns.push(turn);
    store.setValue(chatKey(item), JSON.stringify(turns));
  }

  /** Stores the reply once the turn is over, and frees a worktree or clone the turn made for an Item that had none. */
  async function settle(item: string, turn: ChatTurn, sessionId: string, made: string | null): Promise<void> {
    const over = await runner.finished(sessionId);
    const at = deps.now();
    const reply = readReply(over);
    const resumed = turn.agentSession;
    const done: ChatTurn = { ...turn, reply, finishedAt: over.finishedAt ?? at };
    if (over.agentSessionId) done.agentSession = over.agentSessionId;
    if (over.status !== "succeeded") done.failed = over.endReason ?? `The session ended ${over.status}.`;
    store.tx(() => {
      writeTurn(item, done);
      // Resumed under another id (a fork): the step that follows continues the session with the chat in it.
      if (over.agentSessionId && over.agentSessionId !== resumed) {
        const jobs = loadJobs(store);
        const job = jobs[item];
        if (job?.agentSession === resumed) {
          job.agentSession = over.agentSessionId;
          saveJobs(store, jobs);
        }
      }
      store.appendEvent({
        kind: done.failed ? "orchestrator.chat_failed" : "orchestrator.chat_answered", subject: item, actor: "orchestrator",
        data: { reason: done.failed ? `The ${ROLE_WORDS[turn.role] ?? turn.role} session gave no reply to a person's message: ${done.failed}` : `The ${ROLE_WORDS[turn.role] ?? turn.role} session answered a person's message (${reply.length} characters).`, turn: turn.id, session: sessionId, agentSession: done.agentSession },
      }, at);
    });
    // Parking the Item had freed its workspace: the turn made it again, and it goes back to how it was.
    if (made !== null) {
      const job = loadJobs(store)[item];
      if (!job?.sessionId && !runner.busy(over.subject)) {
        await runner.releaseWorkspace(made, `The chat turn on ${item} is over; the Item parked without its workspace, as before.`).catch((error: unknown) => {
          store.appendEvent({ kind: "orchestrator.action_failed", subject: item, actor: "orchestrator", data: { reason: `Could not free the workspace after the chat turn: ${errorText(error)}` } }, deps.now());
        });
      }
    }
  }

  function track(work: Promise<void>): void {
    running.add(work);
    void work.finally(() => running.delete(work));
  }

  return {
    view(item) {
      const at = deps.now();
      const turns = readTurns(store, item);
      const sessions: ChatSessionView[] = knownSessions(store, item).map((known) => ({
        ...known,
        turns: turns.filter((turn) => turn.agentSession === known.agentSession).map((turn): ChatTurnView => {
          const run = session(turn.session);
          const live = !turn.finishedAt && isLive(run);
          const view: ChatTurnView = { id: turn.id, at: turn.at, message: turn.message, reply: turn.reply ?? readReply(run), live };
          if (live && run?.lastAction) view.lastAction = run.lastAction;
          const failed = turn.failed ?? (!live && !turn.finishedAt && run && run.status !== "succeeded" ? run.endReason ?? `The session ended ${run.status}.` : undefined);
          if (failed) view.failed = failed;
          const finishedAt = turn.finishedAt ?? (!live ? run?.finishedAt : undefined);
          if (finishedAt) view.finishedAt = finishedAt;
          return view;
        }),
      }));
      const why = blocked(item, loadJobs(store)[item], at);
      return { now: at, sessions, ...(why ? { blocked: why } : {}) };
    },

    async send(item, agentSession, message, by = "someone") {
      const text = message.trim();
      if (text === "") return { ok: false, status: 400, code: "BAD_FIELD", message: "The message is empty." };
      if (text.length > MAX_MESSAGE) return { ok: false, status: 400, code: "BAD_FIELD", message: `The message is longer than ${MAX_MESSAGE} characters.` };
      const known = knownSessions(store, item).find((each) => each.agentSession === agentSession);
      if (!known) return { ok: false, status: 404, code: "NO_SESSION", message: `${item} has no known session ${agentSession}.` };
      let job = loadJobs(store)[item];
      const first = blocked(item, job, deps.now());
      if (first || !job) return { ok: false, status: 409, code: "CHAT_REFUSED", message: first ?? "No work under way." };
      const current = deps.config();
      const refuse = (reason: string): ChatSendResult => ({ ok: false, status: 409, code: "CHAT_REFUSED", message: reason });
      // The turn runs where the session ran: the agent CLI keeps a session per folder.
      const folder = sessionFolder(store, item, agentSession);
      const pool = current.workspaces.kind === "pool";
      if (pool) {
        const refused = poolRefusal(store, current, job, folder);
        if (refused) return refuse(refused);
      } else if (folder) {
        // Worktrees are reused across Items: the one the Item holds, or held last (taken again first for it).
        let path: string | null;
        try {
          path = slotPathFor(store, current, job.workspace) ?? lastSlotPath(store, current, job.workspace);
        } catch {
          path = null;
        }
        if (path === null || !samePath(path, folder)) return refuse(`The session ran in ${folder}, not in the Item's worktree, so it cannot be resumed there.`);
        const holder = holderOf(store, current, path);
        if (holder && holder.workspace !== job.workspace) return refuse(`The worktree the session ran in (${folder}) now holds another Item's work (${holder.item}), so the session cannot be resumed there.`);
      }
      pending.add(item);
      let made: string | null = null;
      let started = false;
      try {
        // A unit of each resource the role needs, before the workspace; the runner gives it back when the turn is over.
        const units = deps.resources ? await deps.resources.take(item, `a chat turn on ${job.item.id}`, known.role) : null;
        if (units && !units.ok) return refuse(`The turn waits for a resource: ${units.why}. Try again once one is free.`);
        // The workspace as it is now: parking the Item may have freed it, and then it is freed again after the turn.
        const had = pool ? readHoldings(store).holdings[job.workspace]?.held === true : heldSlot(store, job.workspace) !== null || existsSync(workspacePath(current, job.workspace));
        const giveBack = async (reason: string): Promise<void> => {
          if (!had) await runner.releaseWorkspace(job!.workspace, reason).catch(() => undefined);
        };
        if (pool) {
          const wait = await runner.takeWorkspace(job.item, job.workspace, job.branch, job.head);
          if (wait) return refuse(`The Item's workspace is not free: ${wait}.`);
          // The clone taken must be the one the session ran in.
          const holding = readHoldings(store).holdings[job.workspace];
          const repo = holding?.held ? repoOf(current, holding.clone) : null;
          if (repo === null || !folder || !samePath(repo, folder)) {
            const reason = `The clone the session ran in (${folder}) could not be taken for the turn${holding?.held ? `; the Item got ${holding.clone}` : ""}.`;
            await giveBack(reason);
            return refuse(reason);
          }
        }
        // Checked again with nothing awaited before the start: the tick may have started a step meanwhile.
        pending.delete(item);
        job = loadJobs(store)[item];
        const again = blocked(item, job, deps.now());
        if (again || !job) {
          await giveBack(`The chat turn on ${item} did not start: ${again ?? "no work under way"}`);
          return refuse(again ?? "No work under way.");
        }
        pending.add(item);
        if (!had) made = job.workspace;
        const starting = runner.start({
          role: known.role, subject: job.item, attempt: 1, workspace: job.workspace, branch: job.branch, vars: {},
          resume: agentSession, message: text, chat: true, ...(units && Object.keys(units.env).length > 0 ? { env: units.env } : {}),
          // An implementor's session may run on its size's model or a step-up (decision 105): the turn keeps the session's model.
          ...(known.role === "implement" && known.model && known.model !== current.roles.implement.model ? { model: known.model } : {}),
        });
        started = true;
        const run = await starting;
        const turn: ChatTurn = { id: newId(), at: run.startedAt, agentSession, role: known.role, message: text, session: run.ref.id };
        store.tx(() => {
          writeTurn(item, turn);
          store.appendEvent({
            kind: "orchestrator.chat_sent", subject: item, actor: by,
            data: { reason: `${by} sent a message to the ${ROLE_WORDS[known.role] ?? known.role} session of ${job!.item.id}; it is resumed for one turn.`, turn: turn.id, session: run.ref.id, agentSession },
          }, deps.now());
        });
        track(settle(item, turn, run.ref.id, made));
        return { ok: true, turn };
      } finally {
        pending.delete(item);
        if (!started) await deps.resources?.give(item);
      }
    },

    async idle() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}
