// The HTTP server: the board's JSON API, the event stream, and the built web app.
//
// NO LOGIN YET. Anyone who can reach the port can read the board and pause or resume the
// tool. That is why the server refuses to bind to anything but loopback unless `allowLan`
// is set explicitly. Put it behind a tunnel or a proxy that authenticates until the login
// exists (docs/DESIGN.md, "What is not here yet").

import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildBoard } from "../core/board.ts";
import type { HostConfig, ResourceConfig } from "../config/types.ts";
import type { OffboardView } from "../offboard/plan.ts";
import type { BranchProtection } from "./branchProtection.ts";
import type { Upgrader } from "../upgrade/upgrader.ts";
import { readResourceState, resourcesView } from "../orchestrator/resources.ts";
import type { Self } from "../core/holdings.ts";
import { knownPeople, peopleNames, PERSON_HEADER, readPersonHeader } from "./person.ts";
import { buildItemList, parseListQuery } from "../core/item-list.ts";
import { buildItemPage, busyWords } from "../core/item-page.ts";
import { buildIndex } from "../core/snapshot.ts";
import { toStatusView } from "../core/status.ts";
import { PRIORITIES, isPriority } from "../model/priority.ts";
import type { CommitView, DiffView, HistoryView, ItemBranchState, ItemPage } from "../core/views.ts";
import type { Assumption, CreatedPart, LabelChange, LogWriter, OpenQuestion, OriginalFate, Priority, ProposedPart, Ref, Parked, ParkedQuestion, Restructuring, UsageWindowKind, WorkItem, WorkState } from "../model/types.ts";
import { asParts, asRestructuring, ORIGINAL_FATES, refKey, restructuringProblem, restructuringWords } from "../model/types.ts";
import { applyChange, asLabelChange, changeText, isEmptyChange } from "../model/labels.ts";
import type { OpenDiffResult } from "../orchestrator/diffTool.ts";
import { planOrder } from "../orchestrator/candidates.ts";
import { explainOrder, voteForPlace, voteLimits } from "../orchestrator/score.ts";
import { setVote, voteInStore } from "../store/votes.ts";
import { isSha } from "../orchestrator/history.ts";
import { readMergeQueueNote } from "../orchestrator/mergeQueueLease.ts";
import { answerQuestion, answerRefusal, draftRefusal, keepsRecommendations, loadJobs, questionsSettled, releaseJob, parkedDraft, resumesStep, settleDraft } from "../orchestrator/jobs.ts";
import type { AnswerRefusal, DraftRefusal, Refinement } from "../orchestrator/jobs.ts";
import { workBranch } from "../orchestrator/paths.ts";
import type { Media } from "../orchestrator/media.ts";
import type { Chat } from "../orchestrator/chat.ts";
import { requestQueueResume } from "../orchestrator/queueHealth.ts";
import { acceptRestructuring, adoptFound, currentRestructuring, finishRestructuring, goesWords, intoBody, intoWritten, keptPatch, markedParts, partWork, recordPart, restructuringText, stopRestructuring } from "../orchestrator/restructure.ts";
import type { AnswerWrite, WorkPatch, WorkPort, WriteOutcome, WritePort } from "../ports/host.ts";
import { AlreadyAnswered, BodyChanged } from "../ports/host.ts";
import type { Backend } from "../items/service.ts";
import type { RemoteBranches } from "../items/remoteBranch.ts";
import { branchCommands, farUntil, handBackItem, holdsIt, itemDetails, itemRef as itemRefOn, listItems, Refused, releaseItem, claimItem, whyNotHandBack, whyNotRelease, whyNotClaim } from "../items/service.ts";
import type { JiraBoard } from "../items/jiraBackend.ts";
import { connectHost, editConfig, type EditOptions, type HostConnection, type MetaPart, metaPartOf, readConfigView, type SharedSaved } from "../config/edit.ts";
import { busyMachines, busyText, type ConnectDeps, connectionOf, HOST_NAME, hostFor, type HostKind, hostWhere, joinConnection, lookAtHost, metaPartProblems, type MoveSource, sourceOf, TOKEN_VARIABLE } from "./connect.ts";
import { type MoveReport, moveItems, moveLines } from "../items/moveToHost.ts";
import { type MetaTarget, moveBack, type MoveBackReport, moveBackLines } from "../items/moveToMeta.ts";
import type { MachineSetup } from "../hostSetup.ts";
import type { SettingsLogEntry, SharedSettings } from "../config/shared.ts";
import { activityView } from "./activity.ts";
import { decide as decideItemDraft, draftRequest, draftViews } from "./drafts.ts";
import type { MergeQueueOptions } from "../config/mergeQueue.ts";
import { addAnswer, loadAnswers } from "../store/answers.ts";
import { applyControl, pauseRemembering, startAgain } from "../store/control.ts";
import { countWithoutTriage, withoutTriageKeys } from "./triage.ts";
import type { ControlAction } from "../store/control.ts";
import { itemTextHash, optionTexts } from "../core/answerReuse.ts";
import type { Store } from "../store/store.ts";
import { hostParts, loadSnapshot } from "./snapshot.ts";
import { inertText } from "../orchestrator/hostText.ts";
import type { AssumptionOutcome, AssumptionPick } from "../orchestrator/assumptions.ts";
import { keepOverturn } from "../orchestrator/overturns.ts";
import { createEventStreams } from "./sse.ts";
import { serveStatic } from "./static.ts";
import { sessionDetails } from "./sessionDetails.ts";
import { buildUsageView, parseSpan } from "./usage.ts";
import type { AllowancePlan } from "../orchestrator/allowance.ts";
import { isFolder, isFolderName, openFolder, projectView } from "./project.ts";
import type { FolderOpener, ProjectInfo } from "./project.ts";

export interface ServerOptions {
  store: Store;
  /** The built web app (`web/dist`). Without it only the API is served. */
  staticDir?: string;
  /** The clock. Defaults to the system's. */
  now?: () => Date;
  /** Defaults to 127.0.0.1. */
  host?: string;
  /** Defaults to 4310. 0 picks a free port. */
  port?: number;
  /** Must be true to bind to an address other than loopback. There is no login. */
  allowLan?: boolean;
  /** Called by `POST /api/refresh`. Should only note that a sync is wanted and return. */
  onRefresh?: () => void;
  /** How often an idle event stream gets a comment line. Defaults to 15 s. */
  heartbeatMs?: number;
  /**
   * The host items are created and edited on (meta branch with writes on). Without it the board
   * cannot write items: `POST /api/items` and `POST /api/item/edit` are refused.
   */
  items?: { host: string; write: WritePort; /** With it a person can claim, hand back and release items here (the item commands, `src/items`). */ work?: WorkPort };
  /**
   * The Jira host the project's Items are on, with writes on: the Item page's Claim, Hand back and Release act there for the
   * board's picked person, through the server's token (`src/items/jiraBackend.ts`).
   */
  jiraItems?: JiraBoard;
  /**
   * The machine this board runs on. With it, the board shows who holds what across machines. The person is not the
   * server's: each request names who is at the board (`X-ScopeSoup-Person`, from the board's picker).
   */
  machine?: string;
  /** Brings the store up to date after a write, so the answer and the board show it. */
  syncNow?: () => Promise<void>;
  /**
   * The project's configuration file. The Settings page reads it and changes its safe fields
   * (src/config/edit.ts). Absent in board-only mode.
   */
  configFile?: string;
  /** The label for Items an AI made or rewrote (`labels.aiGenerated`), or undefined when the project keeps none. Read at each use. */
  aiLabel?: () => string | undefined;
  /** The orchestrator's labels, which order the backlog column. Defaults to bug label "bug". */
  planning?: () => { bugLabels: string[]; plannedSessions?: number; level?: number; resources?: ResourceConfig[]; reserve?: Record<UsageWindowKind, number>; allowances?: AllowancePlan[] };
  /** Reads the diff of an item's branch for `GET /api/diff`. Absent in board-only mode. */
  diff?: (ref: Ref) => Promise<DiffView>;
  /** Opens an Item's change, or one of its files, in the person's own diff tool for `POST /api/open-diff` (`src/orchestrator/diffTool.ts`). Absent in board-only mode. */
  openDiff?: (ref: Ref, file?: string) => Promise<OpenDiffResult>;
  /** The newest `limit` commits of the project for `GET /api/history`, and one commit for `GET /api/commit`. Absent in board-only mode. */
  history?: (limit: number) => Promise<HistoryView>;
  commit?: (sha: string) => Promise<CommitView>;
  /** Called after the configuration file was changed, so the orchestrator acts on it now. */
  onConfigChanged?: () => void;
  /** Whether a program can be started, for what each level needs (the agent CLI from level 1). Defaults to a PATH lookup; tests give a fake. */
  programFound?: (command: string) => boolean;
  /** Why a check command cannot be started; default: its program is looked up (`checkCommandProblem` in config/mergeQueue.ts). */
  checkCommandProblem?: (command: readonly string[], repoPath: string) => string | null;
  /** How level 4's proposals are read: the environment, platform and `git remote get-url`. Tests give a fake. */
  mergeQueue?: MergeQueueOptions;
  /**
   * The project's remote, where a person's hand-back reads the Item's branch (`src/items/remoteBranch.ts`). Without it
   * (board-only mode) Hand back cannot be pressed.
   */
  branches?: RemoteBranches;
  /** Where the shared settings are read from and saved to: the meta ref (`metaSettings`) by default. */
  sharedSettings?: SharedSettings;
  /** How Settings' connect dialogs read the token and look at GitHub or Jira (#127): `process.env` and `fetch` by default. Tests and the demo give fakes. */
  connect?: ConnectDeps;
  /**
   * The meta branch on this machine, written with this machine's meta part, for "Move back to the meta branch" (#134) while the
   * project's host is GitHub or Jira. `stop` ends its git processes after the move. Tests and the demo give a fake.
   */
  metaBranch?: (part: MetaPart) => MetaTarget & { stop?: () => Promise<void> };
  /** What this machine lacks for the project's host, found at start (`machineSetup`): the board asks "Set up this machine", and no agent runs. */
  machineSetup?: MachineSetup;
  /** The saves of the shared settings, newest first, for History (`GET /api/settings/log`). */
  settingsLog?: () => SettingsLogEntry[];
  /**
   * The hosts a proposed restructuring makes its parts on (`createWork`, `editWork`, `linkChild`), one per host Scope Soup may create
   * items on; an item's restructuring goes to its own host. For an item of a host not listed, the host is read-only here: accepting
   * records it and a person carries it out by hand.
   */
  restructure?: RestructureHost[];
  /**
   * Replaces an issue's description with the triage draft a person accepted or edited, on a host whose items cannot
   * be edited here otherwise (GitHub, with writes on). `replace` makes the text safe for the host (`hostActions`), throws when the
   * host refuses, and gives false for an item of another host.
   */
  description?: { host: string; replace(item: Ref, text: string): Promise<boolean> };
  /**
   * The board's edits of an Item on a host whose items are issues (GitHub, with writes on): title, description,
   * verification, state and priority, written through (`hostActions`). Throws when the host refuses or did not apply it; then
   * the store is left as it was and `orchestrator.host_write_failed` says why.
   */
  hostEdit?: { host: string; edit(item: Ref, patch: WorkPatch): Promise<boolean> };
  /** The open Items an Item blocks, asked of its host (GitHub's `dependencies/blocking`) once when its page opens. */
  blocking?: { host: string; list(item: Ref): Promise<Ref[]> };
  /**
   * Where the answers are answer comments (GitHub with writes on): the answer is written through and read back into
   * the store, and nothing is kept in `person.answers`. Throws `AlreadyAnswered` for a second answer to a question.
   */
  questions?: {
    host: string;
    answer(item: Ref, to: string | null, answer: AnswerWrite): Promise<{ open: number } | null>;
    /** Several answers in one write (one comment); without it each is posted on its own. */
    answerMany?(item: Ref, answers: { to: string | null; answer: AnswerWrite }[]): Promise<{ open: number } | null>;
    /** Throws `BodyChanged` when the issue's body changed since the draft comment was written (Accept is then refused). */
    checkDraft?(item: Ref, draft: string): Promise<void>;
  };
  /**
   * Where a triage draft's label changes are written at Accept on a host whose items are issues (GitHub, with writes on):
   * one call per label, only the changes that still make sense, then a re-read (`hostActions`). Throws when the host refuses.
   */
  labels?: { host: string; change(item: Ref, change: LabelChange): Promise<{ added: string[]; removed: string[] } | null> };
  /** A person's chat with the Item's sessions (`src/orchestrator/chat.ts`). Absent in board-only mode. */
  chat?: Pick<Chat, "view" | "send">;
  /**
   * The hosts where a person accepts or overturns decisions an implementor took itself (`hostActions`), the picks of one Send
   * together: Overturn gives the answer to the running work while the change has not merged ("work"), or makes a new Item with
   * it; then all verdicts are one write. Throws when the host refuses.
   */
  assumptions?: AssumptionHost[];
  /**
   * Which project this board belongs to (header, tab title) and the folders `POST /api/open-folder` may open. Read on each
   * request, so a changed configuration shows at once.
   */
  project?: () => ProjectInfo | null;
  /** Opens a folder in the file manager; default `openFolder` (Explorer, Finder, xdg-open). Tests give a fake. */
  openFolder?: FolderOpener;
  /** The offboarding plan for "Stop using Scope Soup" on the Settings page. Reads only; never removes anything. */
  offboard?: () => Promise<OffboardView>;
  /** Scope Soup's version, the update check, Get latest and Go back (`src/upgrade/upgrader.ts`). */
  upgrade?: Pick<Upgrader, "view" | "check" | "getLatest" | "goBack" | "cancel" | "dismissNote">;
  /**
   * Agents' images (`src/orchestrator/media.ts`): listed on the Item page, served at `/media/<item>/<name>`, deleted from the page.
   * Absent: the page shows none.
   */
  media?: Pick<Media, "list" | "read" | "remove" | "pushing">;
  /** The board's warning about an unprotected main branch on the GitHub remote (`branchProtection.ts`). Absent: no GitHub host, so none. */
  branchProtection?: BranchProtection;
}

/**
 * One host's Accept and Overturn of the decisions implementors took themselves: the picks of one Send, written together
 * (`Actions.settleAssumptions`). Throws `AlreadyAnswered`, before anything is written, when one is settled already.
 */
export interface AssumptionHost {
  host: string;
  settle(item: Ref, picks: AssumptionPick[], by: string): Promise<AssumptionOutcome[]>;
}

/** One of the answers: its text, and the question it names (`to`: a log question; `index`: one of the parked state's several). */
interface AnswerEntry {
  text: string;
  to?: string;
  index?: number;
}

/** One entry of `POST /api/answer(s)` read, or why it cannot be. */
function answerEntry(given: { answer?: unknown; to?: unknown; question?: unknown }): AnswerEntry | string {
  const { answer, to, question } = given;
  if (typeof answer !== "string" || answer.trim() === "") return "Each answer is text that is not empty.";
  if (to !== undefined && (typeof to !== "string" || (Number.isNaN(Date.parse(to)) && !/^\d+$/.test(to)))) return "to must be the `at` (or the host's id) of an open question.";
  if (question !== undefined && !(typeof question === "number" && Number.isInteger(question) && question >= 0)) return "question must be the index of an open question (0, 1, ...).";
  return { text: answer.trim(), ...(typeof to === "string" ? { to } : {}), ...(typeof question === "number" ? { index: question } : {}) };
}

/** Thrown inside the store transaction that records answers, so a refused one rolls back the others. */
class AnswerRefused extends Error {
  refused: AnswerRefusal;
  index: number;
  constructor(refused: AnswerRefusal, index: number) {
    super(refused);
    this.refused = refused;
    this.index = index;
  }
}

/** A host a proposed restructuring makes its parts on. `verificationInBody`: it has no verification field (GitHub), so it goes into the text. */
export interface RestructureHost {
  host: string;
  write: WritePort;
  /** Reads an item from the host as it is now: an existing Item's description just before parts are added to it, and after. */
  read?: (ref: Ref) => Promise<WorkItem | null>;
  verificationInBody?: boolean;
  /** Its items are numbered issues (GitHub): a part's line names the parent `#N`, which the host links. */
  issueNumbers?: boolean;
}

/** What the Settings page says after a shared setting was saved. */
export function sharedSavedText(saved: SharedSaved, by: string): string {
  const at = `Saved for every machine${saved.commit ? ` as ${saved.commit.slice(0, 7)}` : ""} by ${by}, and in effect now; the other machines take it at their next fetch.`;
  if (saved.sharing.state === "pending") return `${at} It is not on the remote yet, and goes with the next push: ${saved.sharing.problem ?? "the remote kept moving"}`;
  if (saved.sharing.state === "local") return `${at} The repository has no remote, so it stays on this machine.`;
  return at;
}

export interface ScopeSoupServer {
  /** Starts listening. Resolves with where. */
  start(): Promise<{ host: string; port: number; url: string }>;
  /** Ends the event streams and stops listening. */
  stop(): Promise<void>;
}

export const DEFAULT_PORT = 4310;

const STATES: WorkState[] = ["todo", "doing", "waiting", "done", "abandoned"];
/** A GitHub Item: `waiting` is not mapped there. */
const HOST_STATES: WorkState[] = STATES.filter((state) => state !== "waiting");

export function isLoopback(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "::1" || /^127(\.\d{1,3}){3}$/.test(name);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(text);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

/** A page on another site must not be able to pause the tool through a person's browser. */
function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("The body is too large."));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function createServer(options: ServerOptions): ScopeSoupServer {
  const configOptions = { programFound: options.programFound, checkCommandProblem: options.checkCommandProblem, mergeQueue: options.mergeQueue, shared: options.sharedSettings };
  const { store } = options;
  const now = options.now ?? (() => new Date());
  /** For the Item page and list: the snapshot with the project's level, and the Items not triaged yet (from level 1, with a configuration). */
  const triageView = (): { snapshot: ReturnType<typeof loadSnapshot>; notTriaged?: Set<string> } => {
    const snapshot = loadSnapshot(store);
    const level = options.planning?.().level;
    if (level !== undefined) snapshot.level = level;
    return { snapshot, ...(options.configFile !== undefined && (level ?? 0) >= 1 ? { notTriaged: withoutTriageKeys(snapshot.works, loadJobs(store)) } : {}) };
  };
  /** The board, with the backlog in the orchestrator's planned order. */
  const boardNow = () => {
    const snapshot = loadSnapshot(store);
    const at = now();
    const plan = options.planning?.() ?? { bugLabels: ["bug"] };
    if (plan.plannedSessions !== undefined) snapshot.plannedSessions = plan.plannedSessions;
    if (plan.level !== undefined) snapshot.level = plan.level;
    const jobs = loadJobs(store);
    const order = planOrder(snapshot.works, snapshot.changes, jobs, at.toISOString(), plan.bugLabels);
    // From level 1 the backlog has a divider above the Items not triaged yet.
    const divided = options.configFile !== undefined && (plan.level ?? 0) >= 1;
    const board = buildBoard(snapshot, at, order.map((item) => refKey(item.ref)), self(), divided ? withoutTriageKeys(snapshot.works, jobs) : undefined);
    // The limited resources, who holds their units and what waits for one.
    const resources = plan.resources && plan.resources.length > 0 ? resourcesView(plan.resources, readResourceState(store)) : undefined;
    // Each numbered backlog card says why it is where it is.
    const backlog = board.lanes.find((lane) => lane.lane === "backlog");
    if (backlog) {
      const byKey = new Map(snapshot.works.map((item) => [refKey(item.ref), item]));
      const numbered = backlog.cards.filter((card) => card.position !== undefined);
      const why = explainOrder(numbered.flatMap((card) => byKey.get(card.key) ?? []), { all: snapshot.works, jobs, bugLabels: plan.bugLabels });
      const limits = voteLimits(numbered.flatMap((card) => byKey.get(card.key) ?? []), { all: snapshot.works, jobs, bugLabels: plan.bugLabels });
      backlog.cards = backlog.cards.map((card) => {
        if (!why.has(card.key)) return card;
        const off = limits.get(card.key);
        return { ...card, why: why.get(card.key)!, ...(off && (off.up || off.down) ? { voteOff: off } : {}) };
      });
    }
    // On a project that several machines share: which machine merges now.
    const mergeQueue = options.machine ? readMergeQueueNote((key) => store.getValue(key)) : null;
    return { ...board, ...(mergeQueue ? { queue: { ...board.queue, mergeQueue } } : {}), ...(resources ? { resources } : {}) };
  };
  /**
   * `{ ref, direction: "up" | "down" }`: sets the Item's vote so it moves exactly one place in the backlog (`voteForPlace`),
   * computed from the order now. On the meta branch host the vote is a header field written like any edit; on GitHub it is kept in
   * Scope Soup's store. The answer is the Item's new vote, in points.
   */
  async function vote(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    if (typeof body.ref !== "string" || (body.direction !== "up" && body.direction !== "down")) return sendError(response, 400, "BAD_FIELD", 'Give { "ref": "host:work:id", "direction": "up" or "down" }.');
    const current = loadSnapshot(store).works.find((work) => refKey(work.ref) === body.ref);
    if (!current || current.state === "done" || current.state === "abandoned") return sendError(response, 404, "ITEM_NOT_FOUND", `No open item ${body.ref}.`);
    const snapshot = loadSnapshot(store);
    const byKey = new Map(snapshot.works.map((work) => [refKey(work.ref), work]));
    const backlog = boardNow().lanes.find((lane) => lane.lane === "backlog")?.cards.filter((card) => card.position !== undefined).sort((a, b) => a.position! - b.position!) ?? [];
    const move = voteForPlace(backlog.flatMap((card) => byKey.get(card.key) ?? []), body.ref, body.direction, { all: snapshot.works, jobs: loadJobs(store), bugLabels: (options.planning?.() ?? { bugLabels: ["bug"] }).bugLabels });
    if (!move.ok) return sendError(response, 409, "VOTE_OFF", move.reason);
    const next = move.vote;
    if (voteInStore(current.ref)) {
      setVote(store, current.ref, next, picked() ?? "board", now().toISOString());
      return sendJson(response, 200, { ref: refKey(current.ref), vote: next });
    }
    const write = items?.write;
    if (!write?.editWork || current.ref.host !== items!.host) return sendError(response, 403, "READ_ONLY", `The vote of ${current.ref.id} cannot be kept: its host is read-only here.`);
    try {
      const done = await write.editWork(current.ref, { vote: next });
      const logged = write.appendLog ? await write.appendLog(done.work, { kind: "edited", by: by(), fields: { changed: ["vote"] } }) : done;
      await options.syncNow?.();
      return sendJson(response, 200, { ref: refKey(logged.work), vote: next, shared: logged.shared, conflict: logged.conflict });
    } catch (error) {
      return sendError(response, 400, "WRITE_REFUSED", error instanceof Error ? error.message : String(error));
    }
  }

  /** Where an item's decisions are accepted and overturned, if anywhere. */
  const assumptionHost = (subject: Ref): AssumptionHost | undefined => (options.assumptions ?? []).find((each) => each.host === subject.host);
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host) && options.allowLan !== true) {
    throw new Error(`Refusing to listen on ${host}: the board has no login yet. Use 127.0.0.1, or set allowLan to accept that anyone on the network can use it.`);
  }
  const streams = createEventStreams(store, options.heartbeatMs ?? 15_000);
  const items = options.items;
  // Who is at the board, per request: the person the board's picker names. Set around each request in `handle`.
  const requestPerson = new AsyncLocalStorage<string | undefined>();
  const picked = (): string | undefined => requestPerson.getStore();
  /** The picked person as a log writer. Only called on paths that refuse a request without one (`NEEDS_PERSON`). */
  const by = (): { who: string; agent: false } => ({ who: picked() ?? "", agent: false });
  /** The machine and the picked person, for "Your turn" and whose holds are this board's. */
  const self = (): Self | undefined => {
    const person = picked();
    return options.machine || person ? { ...(options.machine ? { machine: options.machine } : {}), ...(person ? { person } : {}) } : undefined;
  };
  let server: Server | null = null;

  /** The switches (store/control.ts); `via` names the endpoint, so the old aliases show in the events. */
  const control = (action: ControlAction, via: string) => applyControl(store, action, now().toISOString(), via, picked() ?? "board");

  /**
   * A person answers on an item: `{ ref, answer, to?, question? }`. The answer is kept and given to every later
   * session on the item. If the orchestrator had put the item down with a question, it is picked up again. When it
   * parked on several questions (`parked.questions`), `question` is the index of the one answered, and the item is picked
   * up only with the answer to the last open one.
   */
  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request, 64 * 1024));
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const { ref, answer: text, to, question: given, parkedAt } = (body ?? {}) as { ref?: unknown; answer?: unknown; to?: unknown; question?: unknown; parkedAt?: unknown };
    if (typeof ref !== "string" || typeof text !== "string" || text.trim() === "") {
      return sendError(response, 400, "ANSWER_MISSING", 'Give { "ref": "host:work:id", "answer": "...", "to"?: "the question at", "question"?: 0, "parkedAt"?: "the parked state at" }.');
    }
    const entry = answerEntry({ answer: text, to, question: given });
    if (typeof entry === "string") return sendError(response, 400, "BAD_FIELD", entry);
    if (parkedAt !== undefined && (typeof parkedAt !== "string" || Number.isNaN(Date.parse(parkedAt)))) return sendError(response, 400, "BAD_FIELD", "parkedAt must be the `at` of the parked state the answer was given on.");
    if (given !== undefined && parkedAt === undefined) return sendError(response, 400, "PARKED_MISSING", 'An answer to one of several questions names the parked state it was read from: give "parkedAt".');
    return answerAll(response, ref, [entry], typeof parkedAt === "string" ? parkedAt : undefined);
  }

  /**
   * The answers to several of an item's open questions, sent together from the board: `{ ref, parkedAt?, answers:
   * [{ answer, to?, question? }] }`, each entry as one `POST /api/answer`. They are recorded together or not at all: one write on
   * the host (GitHub: one comment with `A1:` and `A2:` lines; the meta branch: one commit), and the item is picked up once, after
   * all of them, when no question it waits on is left open. Questions not in the list stay open.
   */
  async function answers(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const { ref, parkedAt } = body;
    const given = Array.isArray(body.answers) ? (body.answers as unknown[]) : null;
    const usable = (each: unknown): each is Record<string, unknown> => typeof each === "object" && each !== null && typeof (each as { answer?: unknown }).answer === "string" && (each as { answer: string }).answer.trim() !== "";
    if (typeof ref !== "string" || given === null || given.length === 0 || !given.every(usable)) {
      return sendError(response, 400, "ANSWER_MISSING", 'Give { "ref": "host:work:id", "parkedAt"?: "the parked state at", "answers": [{ "answer": "...", "to"?: "the question at", "question"?: 0 }] }.');
    }
    const entries: AnswerEntry[] = [];
    for (const each of given as Record<string, unknown>[]) {
      const entry = answerEntry(each);
      if (typeof entry === "string") return sendError(response, 400, "BAD_FIELD", entry);
      entries.push(entry);
    }
    if (parkedAt !== undefined && (typeof parkedAt !== "string" || Number.isNaN(Date.parse(parkedAt)))) return sendError(response, 400, "BAD_FIELD", "parkedAt must be the `at` of the parked state the answer were given on.");
    if (entries.some((each) => each.index !== undefined) && parkedAt === undefined) return sendError(response, 400, "PARKED_MISSING", 'An answer to one of several questions names the parked state it was read from: give "parkedAt".');
    return answerAll(response, ref, entries, typeof parkedAt === "string" ? parkedAt : undefined);
  }

  /**
   * The answers, recorded together. Each names its question as `POST /api/answer` does: `index` into the parked state's several
   * questions, `to` a question in the item's log (its `at`, or the host's id), or neither: the question the parked state waits on, else the
   * newest open one. Two answers to one question are refused.
   */
  async function answerAll(response: ServerResponse, ref: string, entries: AnswerEntry[], parkedAt: string | undefined): Promise<void> {
    const snapshot = loadSnapshot(store);
    const item = snapshot.works.find((work) => refKey(work.ref) === ref);
    if (!item) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${ref}.`);
    const subject: Ref = item.ref;
    const parked = (snapshot.parked ?? []).find((each) => refKey(each.subject) === ref);
    if (options.questions && subject.host === options.questions.host) return answerOnHost(response, item, parked, entries, parkedAt);
    const several = parked?.questions ?? [];
    const open = item.openQuestions ?? [];
    const resolved: { text: string; index: number; target?: ParkedQuestion; asked?: OpenQuestion; question?: string }[] = [];
    for (const { text, to, index: given } of entries) {
      // `question` only means something while the item parked on several questions; a stale page or a re-triage is refused below.
      if (given !== undefined && several.length === 0) return sendError(response, 409, "NO_OPEN_QUESTIONS", `${ref} does not wait on several questions (any more): reload the item.`);
      if (several.length > 0 && given === undefined && to === undefined) return sendError(response, 400, "QUESTION_MISSING", `${ref} waits for answers to ${several.length} questions: give "question", the index of the one answered.`);
      // The question in the item's log: the one named by `to`, else the newest open one.
      const named = to !== undefined ? open.find((question) => Date.parse(question.at) === Date.parse(to)) : undefined;
      if (to !== undefined && !named) return sendError(response, 404, "QUESTION_NOT_FOUND", `No open question at ${to} on ${ref}.`);
      // A `to` naming the log line park wrote for one of the several questions answers that question; any other log question is answered only in the log.
      const index = given !== undefined ? given : named && !named.proposal ? several.findIndex((each) => each.question === named.question) : -1;
      if (index >= several.length) return sendError(response, 404, "QUESTION_NOT_FOUND", `No open question ${index} on ${ref}.`);
      const target = index >= 0 ? several[index] : undefined;
      // For one of several, the log's question line written for it, so the answer closes it there too.
      const asked = named ?? (target ? open.find((question) => !question.proposal && question.question === target.question) : open[open.length - 1]);
      const question = target?.question ?? asked?.question ?? parked?.decision?.question;
      resolved.push({ text, index, ...(target ? { target } : {}), ...(asked ? { asked } : {}), ...(question ? { question } : {}) });
    }
    const keys = resolved.map((each) => (each.index >= 0 ? `#${each.index}` : each.asked ? each.asked.at : "parked"));
    if (new Set(keys).size !== keys.length) return sendError(response, 400, "DUPLICATE_ANSWER", "Give one answer to each question.");
    const at = now().toISOString();
    type Outcome = { released: boolean; open?: number } | { refused: AnswerRefusal; index: number };
    let outcome: Outcome;
    try {
      outcome = store.tx((): Outcome => {
        const job = loadJobs(store)[ref];
        if (!resolved.some((each) => each.target) && parkedAt !== undefined && !(job?.parked && Date.parse(job.parked.at) === Date.parse(parkedAt))) return { refused: "parked-changed", index: -1 };
        let released = false;
        let left: number | undefined;
        for (const each of resolved) {
          const asking = each.target?.options ?? each.asked?.options ?? parked?.decision?.options;
          addAnswer(store, { subject, answer: each.text, by: by().who, at, textHash: itemTextHash(item), ...(each.question ? { question: each.question } : {}), ...(asking && asking.length > 0 ? { options: optionTexts(asking) } : {}) });
          if (several.length > 0) {
            if (!each.target) {
              left ??= several.filter((one) => one.answer === undefined).length;
              continue;
            }
            // Kept in the job, and released with the last open answer; checked again here, so two answers cannot race.
            const done = answerQuestion(store, subject, each.index, each.text, by().who, at, parkedAt);
            // Thrown, so the answers recorded before it in this transaction are rolled back too.
            if ("refused" in done) throw new AnswerRefused(done.refused, each.index);
            released ||= done.released;
            left = done.open;
            continue;
          }
          const picksUp = !released && parked && (parked.as === "needs-decision" || parked.as === "not-ready" || parked.as === "escalated");
          if (picksUp) released = releaseJob(store, subject, by().who, at, `${by().who} answered: ${each.text}`);
        }
        return { released, ...(left !== undefined ? { open: left } : {}) };
      });
    } catch (error) {
      if (!(error instanceof AnswerRefused)) throw error;
      outcome = { refused: error.refused, index: error.index };
    }
    if ("refused" in outcome) {
      const refusals: Record<AnswerRefusal, [string, string]> = {
        "no-questions": ["NO_OPEN_QUESTIONS", `${ref} does not wait on that question (any more): reload the item.`],
        "parked-changed": ["PARKED_CHANGED", `${ref} parked on other questions now: reload the item.`],
        answered: ["ALREADY_ANSWERED", `Question ${outcome.index + 1} on ${ref} has an answer already.`],
      };
      const [code, message] = refusals[outcome.refused];
      return sendError(response, 409, code, message);
    }
    const released = outcome.released;
    const left = outcome.open !== undefined ? { open: outcome.open } : {};
    // In the item's log too (meta branch), naming the question, so the answer outlives the local store. One write for all of them.
    const write = items?.write;
    if (write?.appendLog && subject.host === items!.host) {
      const lines = resolved.map((each) => ({ kind: "answer", by: by(), fields: { answer: each.text, ...(each.asked ? { to: each.asked.at, toBy: each.asked.by } : {}) } }));
      let logged: WriteOutcome | undefined;
      try {
        if (lines.length > 1 && write.appendLogs) logged = await write.appendLogs(subject, lines);
        else for (const line of lines) logged = await write.appendLog(subject, line);
      } catch (error) {
        options.onRefresh?.();
        return sendJson(response, 200, { recorded: true, released, ...left, logged: false, problem: error instanceof Error ? error.message : String(error) });
      }
      await options.syncNow?.();
      return sendJson(response, 200, { recorded: true, released, ...left, logged: true, shared: logged?.shared });
    }
    options.onRefresh?.();
    return sendJson(response, 200, { recorded: true, released, ...left });
  }

  /**
   * A person answers on a GitHub Item. The question is a comment: the one `to` names (its `at` or id), question `index` of
   * the parked state's several, the one the parked state waits on, or else the newest open one; with none (an escalation) the answer names no
   * question. The answer comment is written through first; only then is the Item picked up, once every question it waits on has
   * its answer. A failed write leaves the store as it was. Several answers go in one comment, and the Item is picked up once.
   */
  async function answerOnHost(response: ServerResponse, item: WorkItem, parked: Parked | undefined, entries: AnswerEntry[], parkedAt: string | undefined): Promise<void> {
    const ref = refKey(item.ref);
    const job = loadJobs(store)[ref];
    const waits = job?.parked?.questions ?? [];
    const open = item.openQuestions ?? [];
    if (parkedAt !== undefined && !(job?.parked && Date.parse(job.parked.at) === Date.parse(parkedAt))) return sendError(response, 409, "PARKED_CHANGED", `${ref} parked on other questions now: reload the item.`);
    const posts: { to: string | null; answer: AnswerWrite; text: string }[] = [];
    for (const { text, to, index } of entries) {
      let target: string | undefined;
      if (index !== undefined) {
        if (index >= waits.length) return sendError(response, 409, "NO_OPEN_QUESTIONS", `${ref} does not wait on question ${index + 1} (any more): reload the item.`);
        target = waits[index];
      } else if (to !== undefined) {
        target = (open.find((question) => question.id === to) ?? open.find((question) => !Number.isNaN(Date.parse(to)) && Date.parse(question.at) === Date.parse(to)))?.id;
        if (!target) return sendError(response, 404, "QUESTION_NOT_FOUND", `No open question ${to} on ${ref}.`);
      } else if (waits.length > 1) {
        return sendError(response, 400, "QUESTION_MISSING", `${ref} waits for answers to ${waits.length} questions: give "question", the index of the one answered.`);
      } else target = waits[0] ?? open[open.length - 1]?.id;
      if (target !== undefined && (item.answers ?? []).some((answer) => answer.to === target)) return sendError(response, 409, "ALREADY_ANSWERED", `That question on ${ref} has an answer already.`);
      if (posts.some((each) => each.to === (target ?? null))) return sendError(response, 400, "DUPLICATE_ANSWER", "Give one answer to each question.");
      const question = target !== undefined ? open.find((each) => each.id === target) : undefined;
      const asked = question ?? (target === undefined ? parked?.decision : undefined);
      posts.push({
        to: target ?? null, text,
        answer: {
          answer: text, textHash: itemTextHash(item),
          ...(target === undefined && (asked?.question ?? parked?.reason) ? { question: asked?.question ?? parked!.reason } : {}),
          ...(asked && asked.options.length > 0 ? { options: optionTexts(asked.options) } : {}),
        },
      });
    }
    const at = now().toISOString();
    const host = options.questions!;
    try {
      if (posts.length > 1 && host.answerMany) await host.answerMany(item.ref, posts.map(({ to, answer }) => ({ to, answer: { ...answer, by: by().who } })));
      else for (const post of posts) await host.answer(item.ref, post.to, { ...post.answer, by: by().who });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof AlreadyAnswered) return sendError(response, 409, "ALREADY_ANSWERED", reason);
      store.appendEvent({ kind: "orchestrator.host_write_failed", subject: ref, actor: by().who, data: { reason: `Could not post the answer${posts.length > 1 ? "s" : ""} on ${item.ref.id} on ${item.ref.host}: ${reason}` } }, at);
      return sendError(response, 400, "WRITE_REFUSED", reason);
    }
    // The answers are on GitHub and read back into the store: the Item is picked up once every question it waits on has an answer.
    const after = store.get<WorkItem>(item.ref) ?? item;
    store.tx(() => {
      for (const post of posts) store.appendEvent({ kind: "person.answered", subject: ref, actor: by().who, data: { reason: `${by().who} answered on ${item.ref.host}: ${post.text}`, answer: post.text, ...(post.to ? { to: post.to } : {}) } }, at);
    });
    let released = false;
    const left = waits.filter((id) => (after.openQuestions ?? []).some((each) => each.id === id)).length;
    if (job?.parked) {
      const settled = questionsSettled(job, after);
      if (settled && !settled.withdrawn) released = releaseJob(store, item.ref, by().who, at, settled.reason);
      else if (waits.length === 0 && (job.parked.as === "needs-decision" || job.parked.as === "not-ready" || job.parked.as === "escalated")) {
        released = releaseJob(store, item.ref, by().who, at, `${by().who} answered: ${posts.map((post) => post.text).join(" | ")}`);
      }
    }
    options.onRefresh?.();
    return sendJson(response, 200, { recorded: true, released, ...(waits.length > 1 ? { open: left } : {}) });
  }

  /**
   * A person starts an item over that is parked on a question or escalation of its implement step: `{ ref }`. The job is
   * dropped (branch, review round and findings with it) and the item starts at triage. An answer would go on with the step instead.
   */
  /** One message of a person to a session of the Item; 202 once the turn is started, the reply follows on `GET /api/chat`. */
  async function chatSend(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const { ref, session, message } = body;
    if (typeof ref !== "string" || typeof session !== "string" || typeof message !== "string") {
      return sendError(response, 400, "BAD_FIELD", 'Give { "ref": "host:work:id", "session": "the agent session id", "message": "text" }.');
    }
    if (!options.chat) return sendError(response, 409, "CHAT_REFUSED", "This server has no project configuration, so it runs no sessions.");
    if (!loadSnapshot(store).works.some((work) => refKey(work.ref) === ref)) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${ref}.`);
    const sent = await options.chat.send(ref, session, message, by().who);
    if (!sent.ok) return sendError(response, sent.status, sent.code, sent.message);
    return sendJson(response, 202, { turn: sent.turn.id });
  }

  async function startOver(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const { ref } = body;
    if (typeof ref !== "string") return sendError(response, 400, "BAD_FIELD", 'Give { "ref": "host:work:id" }.');
    const item = loadSnapshot(store).works.find((work) => refKey(work.ref) === ref);
    if (!item) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${ref}.`);
    const at = now().toISOString();
    const started = store.tx(() => {
      const job = loadJobs(store)[refKey(item.ref)];
      return !!job && resumesStep(job) && releaseJob(store, item.ref, by().who, at, `${by().who} started the item over from triage.`, true);
    });
    if (!started) return sendError(response, 409, "NOT_PARKED", `${ref} is not parked on a question or escalation of an implement step.`);
    options.onRefresh?.();
    return sendJson(response, 200, { started: true });
  }

  /**
   * A person decides on a proposed restructuring: `{ ref, action, parts?, original?, to? }` with `action` "accept", "edit" (a
   * person's own `parts` and `original`), "reject", or "stop" (end it with the parts made so far). See `restructureDecision`. (A proposed rewrite of the item's text was removed.)
   */
  async function proposal(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const { ref, action, to } = body;
    if (typeof ref !== "string" || (action !== "accept" && action !== "edit" && action !== "reject" && action !== "stop")) {
      return sendError(response, 400, "BAD_FIELD", 'Give { "ref": "host:work:id", "action": "accept" | "edit" | "reject" | "stop", "parts"?, "original"?, "to"? }.');
    }
    if (to !== undefined && (typeof to !== "string" || Number.isNaN(Date.parse(to)))) return sendError(response, 400, "BAD_FIELD", "to must be the `at` of the open proposal.");
    const snapshot = loadSnapshot(store);
    const item = snapshot.works.find((work) => refKey(work.ref) === ref);
    if (!item) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${ref}.`);
    const parked = (snapshot.parked ?? []).find((each) => refKey(each.subject) === ref);
    const open = (item.openQuestions ?? []).filter((question) => question.proposal);
    const asked = typeof to === "string" ? open.find((question) => Date.parse(question.at) === Date.parse(to)) : open[open.length - 1];
    // The job's copy knows which children exist already. A stored proposal without parts (an old rewrite) is not one.
    const proposed = parked?.proposal?.parts?.length ? parked.proposal : asked?.proposal;
    if (!proposed?.parts?.length) return sendError(response, 404, "NO_PROPOSAL", `No proposed restructuring is waiting on ${ref}.`);
    // On GitHub the restructuring is a question comment, and a person's decision an answer comment to it.
    const onHost = options.questions && item.ref.host === options.questions.host ? asked?.id : undefined;
    return restructureDecision(response, body, item, parked, asked, proposed, action, onHost);
  }

  /**
   * A person settles the triage's rewrite: `{ ref, parkedAt, answers, action, text? }`. `answers` has one answer per
   * question of the rewrite, in order. Keeping every recommendation, `action` settles the draft in one step: "accept" writes the
   * draft as the item's description, "edit" writes a person's `text`, "reject" keeps the description; the original stays in the
   * item's history (the `edited` line on the meta branch names it; GitHub keeps its own). On GitHub only the issue's body is replaced
   *; when that fails, or the item cannot be written here at all, the text is recorded as the answer and given to
   * the agents in place of the host's, with the failure in it so the Item page shows it. Any other answer is recorded and the first
   * look runs again with it (no round cap). The answers are recorded either way, and every later session gets them.
   */
  async function draft(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const { ref, parkedAt, action, text } = body;
    const answers = Array.isArray(body.answers) && body.answers.every((each) => typeof each === "string") ? (body.answers as string[]).map((each) => each.trim()) : null;
    if (typeof ref !== "string" || typeof parkedAt !== "string" || Number.isNaN(Date.parse(parkedAt)) || answers === null || (action !== "accept" && action !== "edit" && action !== "reject")) {
      return sendError(response, 400, "BAD_FIELD", 'Give { "ref": "host:work:id", "parkedAt": "the parked state at", "answers": ["one per question"], "action": "accept" | "edit" | "reject", "text"?: "with edit" }.');
    }
    if (action === "edit" && (typeof text !== "string" || text.trim() === "")) return sendError(response, 400, "BAD_FIELD", "Edit gives the description as text that is not empty.");
    // Edit may change the proposed labels too: `labels: { add: [...], remove: [...] }`.
    if (body.labels !== undefined && (action !== "edit" || typeof body.labels !== "object" || body.labels === null || Array.isArray(body.labels))) {
      return sendError(response, 400, "BAD_FIELD", 'Only Edit gives "labels", as { "add": ["name"], "remove": ["name"] }.');
    }
    const snapshot = loadSnapshot(store);
    const item = snapshot.works.find((work) => refKey(work.ref) === ref);
    if (!item) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${ref}.`);
    const subject = item.ref;
    const refusals: Record<DraftRefusal, [number, string, string]> = {
      "no-draft": [409, "NO_DRAFT", `No rewrite of the triage waits on ${ref} (any more): reload the item.`],
      "parked-changed": [409, "PARKED_CHANGED", `${ref} parked on another rewrite now: reload the item.`],
      answers: [400, "ANSWERS_MISSING", "Give one answer, not empty, to each question of the rewrite, in order."],
    };
    const job = loadJobs(store)[ref];
    const before = draftRefusal(job, parkedAt, answers);
    if (before) {
      const [status, code, message] = refusals[before];
      return sendError(response, status, code, message);
    }
    const refine = parkedDraft(job)!;
    const parkedReason = job!.parked!.reason;
    const keeps = keepsRecommendations(refine, answers);
    const newText = keeps && action === "accept" ? refine.draft : keeps && action === "edit" ? (text as string).trim() : undefined;
    // The label changes go with the description: Accept takes the proposal, Edit a person's (or the proposal), Reject none.
    const proposedLabels: LabelChange | undefined = !keeps || action === "reject" ? undefined : action === "edit" && body.labels !== undefined ? asLabelChange(body.labels) : refine.labels;
    // An accepted rewrite makes the Item AI-written: it gets the project's AI label (if any), never removed again.
    const aiLabel = newText !== undefined ? options.aiLabel?.() : undefined;
    const labelChange: LabelChange | undefined = aiLabel && !(item.labels ?? []).some((name) => name.toLowerCase() === aiLabel.toLowerCase())
      ? { add: [...new Set([...(proposedLabels?.add ?? []), aiLabel])], remove: (proposedLabels?.remove ?? []).filter((name) => name.toLowerCase() !== aiLabel.toLowerCase()) }
      : proposedLabels;
    // A draft posted on GitHub is answered there.
    const posted = options.questions && subject.host === options.questions.host ? job!.parked!.draft : undefined;
    if (posted) return draftOnHost(response, item, refine, posted, answers, action, newText, parkedAt, labelChange);
    const write = items?.write;
    const writable = !!write?.editWork && subject.host === items!.host;
    // The description is written first: when the host refuses, nothing is recorded and the draft still waits.
    // On the meta branch the labels are written in the same edit: the proposed changes that still make sense on the Item now.
    let written = false;
    let labelsDone: { added: string[]; removed: string[] } | undefined;
    if (writable && (newText !== undefined || !isEmptyChange(labelChange))) {
      const patch: WorkPatch = {};
      if (newText !== undefined && newText !== (item.body ?? "").trim()) patch.body = newText;
      if (!isEmptyChange(labelChange)) {
        const current = (await items!.work?.getWork(subject).catch(() => null)) ?? item;
        const next = applyChange(current.labels, labelChange!);
        if (next.add.length > 0 || next.remove.length > 0) {
          patch.labels = next.labels;
          labelsDone = { added: next.add, removed: next.remove };
        }
      }
      if (Object.keys(patch).length > 0) {
        try {
          const done = await write!.editWork!(subject, patch);
          const changed = [...(patch.body !== undefined ? ["description"] : []), ...(patch.labels !== undefined ? ["labels"] : [])];
          if (write!.appendLog) await write!.appendLog(done.work, { kind: "edited", by: by(), fields: { changed, via: `triage, round ${refine.round}`, ...(patch.body !== undefined ? { was: refine.original } : {}), ...(labelsDone ? { labels: changeText({ add: labelsDone.added, remove: labelsDone.removed }) } : {}) } });
          written = true;
        } catch (error) {
          return sendError(response, 400, "WRITE_REFUSED", error instanceof Error ? error.message : String(error));
        }
      }
    }
    // On GitHub only the issue's body is replaced. A refusal does not stop the answer: the text is kept as the answer.
    const describe = options.description;
    const describable = newText !== undefined && !writable && describe !== undefined && subject.host === describe.host;
    // The issue already reads so: nothing is sent, and the description above is the text.
    const unchanged = describable && newText === (item.body ?? "").trim();
    let replaced = false;
    let replaceProblem: string | undefined;
    if (describable && !unchanged) {
      try {
        replaced = await describe!.replace(subject, newText!);
      } catch (error) {
        replaceProblem = error instanceof Error ? error.message : String(error);
      }
    }
    // And the label changes, one call per label; a refusal is noted like the description's.
    let labelProblem: string | undefined;
    if (!writable && !isEmptyChange(labelChange) && options.labels && subject.host === options.labels.host) {
      try {
        labelsDone = (await options.labels.change(subject, labelChange!)) ?? undefined;
      } catch (error) {
        labelProblem = error instanceof Error ? error.message : String(error);
      }
    }
    const labelsSaid = labelsDone && (labelsDone.added.length > 0 || labelsDone.removed.length > 0) ? ` Labels: ${changeText({ add: labelsDone.added, remove: labelsDone.removed })}.` : "";
    const labelsFailed = labelProblem !== undefined ? ` Scope Soup could not change the labels (${labelProblem}): ${changeText(labelChange)}.` : "";
    const at = now().toISOString();
    const outcome = store.tx(() => {
      const refused = draftRefusal(loadJobs(store)[ref], parkedAt, answers);
      if (refused) return { refused };
      refine.questions.forEach((question, index) => {
        addAnswer(store, { subject, answer: answers[index]!, by: by().who, at, textHash: itemTextHash(item), question: question.question, ...(question.options.length > 0 ? { options: optionTexts(question.options) } : {}) });
      });
      if (keeps) {
        const said = newText === undefined
          ? "Rejected the triage's rewrite: work from the description as it stands."
          : writable || replaced || unchanged
            ? `${action === "edit" ? "Edited and accepted" : "Accepted"} the triage's rewrite: the description above is the new text.`
            : replaceProblem !== undefined
              ? `${action === "edit" ? "Edited and accepted" : "Accepted"} the triage's rewrite, but Scope Soup could not write it to the issue (${replaceProblem}). Use this description instead of the one written above:\n${newText}`
              : `${action === "edit" ? "Edited and accepted" : "Accepted"} the triage's rewrite. Use this description instead of the one written above (the item is edited on its host, not here):\n${newText}`;
        addAnswer(store, { subject, answer: `${said}${labelsSaid}${labelsFailed}`, by: by().who, at, question: `Triage rewrite, round ${refine.round}` });
      }
      if (labelProblem !== undefined) {
        store.appendEvent({ kind: "orchestrator.host_write_failed", subject: ref, actor: by().who, data: { reason: `Could not change the labels of ${subject.id} on ${subject.host}: ${labelProblem}.` } }, at);
      }
      if (replaceProblem !== undefined) {
        store.appendEvent({ kind: "orchestrator.host_write_failed", subject: ref, actor: by().who, data: { reason: `Could not replace the description of ${subject.id} on ${subject.host}: ${replaceProblem}. The accepted text is kept as the answer.` } }, at);
      }
      return settleDraft(store, subject, answers, action, by().who, at, parkedAt, newText === undefined ? [] : [newText, inertText(newText)]);
    });
    if ("refused" in outcome) {
      options.onRefresh?.();
      const [status, code, message] = refusals[outcome.refused];
      return sendError(response, status, code, `${message}${written || replaced ? " The description was written already." : ""}`);
    }
    const result = {
      recorded: true,
      ...("rerun" in outcome ? { rerun: true } : { settled: outcome.settled }),
      ...(written || replaced ? { written: true } : {}),
      ...(replaceProblem !== undefined ? { written: false, problem: `Could not write the description to the issue: ${replaceProblem}. It is kept as your answer.` } : {}),
      ...(labelsDone ? { labels: labelsDone } : {}),
      ...(labelProblem !== undefined ? { labelProblem: `Could not change the labels: ${labelProblem}.` } : {}),
    };
    // The line park wrote for the draft is answered in the item's log (meta branch), so it is no longer an open question there.
    const asked = (item.openQuestions ?? []).filter((question) => !question.proposal && question.question === parkedReason).pop();
    if (write?.appendLog && subject.host === items!.host) {
      const said = "rerun" in outcome ? `Answered the triage's questions: ${answers.join(" | ")}` : `${outcome.settled === "rejected" ? "Rejected" : outcome.settled === "edited" ? "Edited and accepted" : "Accepted"} the triage's rewrite${answers.length > 0 ? `, keeping the recommendations: ${answers.join(" | ")}` : ""}.`;
      try {
        await write.appendLog(subject, { kind: "answer", by: by(), fields: { answer: said, ...(asked ? { to: asked.at, toBy: asked.by } : {}) } });
      } catch (error) {
        options.onRefresh?.();
        return sendJson(response, 200, { ...result, logged: false, problem: error instanceof Error ? error.message : String(error) });
      }
      await options.syncNow?.();
      return sendJson(response, 200, { ...result, logged: true });
    }
    if (written || replaced) await options.syncNow?.();
    options.onRefresh?.();
    return sendJson(response, 200, result);
  }

  /**
   * A person settles a triage draft posted on GitHub. Accept first checks that the issue's body is still the one the
   * draft read (else 409 BODY_CHANGED, and the board shows the new body next to the draft). Accept and Edit replace the description
   *. Then an answer comment goes to each of the draft's questions and, keeping every recommendation, one to the draft with
   * `proposal`. Nothing is kept in `person.answers`. A failed write leaves the draft waiting; pressing again skips what GitHub has.
   */
  async function draftOnHost(response: ServerResponse, item: WorkItem, refine: Refinement, posted: { id: string; questions: string[] }, answers: string[], action: "accept" | "edit" | "reject", newText: string | undefined, parkedAt: string, labelChange: LabelChange | undefined): Promise<void> {
    const subject = item.ref;
    const ref = refKey(subject);
    const host = options.questions!;
    const keeps = keepsRecommendations(refine, answers);
    const at = now().toISOString();
    let written = false;
    let labelsDone: { added: string[]; removed: string[] } | undefined;
    try {
      // The issue reads so already (an earlier press wrote it): nothing to check or send.
      if (newText !== undefined && newText !== (item.body ?? "").trim() && inertText(newText) !== (item.body ?? "").trim()) {
        // Only Accept: an Edit is a person's own text, written with the new description in view.
        if (action === "accept") await host.checkDraft?.(subject, posted.id);
        if (!options.description || !(await options.description.replace(subject, newText))) throw new Error(`Scope Soup cannot write the description of ${subject.id} on ${subject.host}.`);
        written = true;
      }
      // The label changes, after the description and before the decision: one call per label that still makes sense, then a re-read.
      if (!isEmptyChange(labelChange)) {
        if (!options.labels || subject.host !== options.labels.host) throw new Error(`Scope Soup cannot change the labels of ${subject.id} on ${subject.host}.`);
        labelsDone = (await options.labels.change(subject, labelChange!)) ?? undefined;
      }
      const given = new Set((store.get<WorkItem>(subject)?.answers ?? []).map((each) => each.to));
      const posts: { to: string; answer: AnswerWrite }[] = [];
      for (const [index, id] of posted.questions.entries()) {
        const question = refine.questions[index];
        if (given.has(id) || !question) continue;
        posts.push({ to: id, answer: { answer: answers[index]!, textHash: itemTextHash(item), ...(question.options.length > 0 ? { options: optionTexts(question.options) } : {}) } });
      }
      if (keeps) {
        const settled = action === "accept" ? "accepted" : action === "edit" ? "edited" : "rejected";
        const said = newText === undefined
          ? "Rejected the triage's rewrite: work from the description as it stands."
          : `${action === "edit" ? "Edited and accepted" : "Accepted"} the triage's rewrite: the description above is the new text.`;
        const labelsSaid = labelsDone && (labelsDone.added.length > 0 || labelsDone.removed.length > 0) ? ` Labels: ${changeText({ add: labelsDone.added, remove: labelsDone.removed })}.` : "";
        posts.push({ to: posted.id, answer: { answer: `${said}${labelsSaid}`, proposal: settled } });
      }
      // The answers to the draft's questions and the decision on the draft go in one comment.
      if (posts.length > 1 && host.answerMany) await host.answerMany(subject, posts.map(({ to, answer }) => ({ to, answer: { ...answer, by: by().who } })));
      else for (const post of posts) await host.answer(subject, post.to, { ...post.answer, by: by().who });
    } catch (error) {
      // The board shows the issue as GitHub has it now: the new body next to the draft, or the description written already.
      if (written || labelsDone || error instanceof BodyChanged) await options.syncNow?.();
      options.onRefresh?.();
      const reason = error instanceof Error ? error.message : String(error);
      const already = `${written ? " The description was written already." : ""}${labelsDone ? " The labels were changed already." : ""}`;
      if (error instanceof BodyChanged) return sendError(response, 409, "BODY_CHANGED", `${reason} Read the new description next to the rewrite, then accept, edit or reject it again.`);
      if (error instanceof AlreadyAnswered) return sendError(response, 409, "ALREADY_ANSWERED", `${reason}${already}`);
      store.appendEvent({ kind: "orchestrator.host_write_failed", subject: ref, actor: by().who, data: { reason: `Could not settle the triage's rewrite of ${subject.id} on ${subject.host}: ${reason}` } }, at);
      return sendError(response, 400, "WRITE_REFUSED", `${reason}${already}`);
    }
    const outcome = store.tx(() => settleDraft(store, subject, answers, action, by().who, at, parkedAt, newText === undefined ? [] : [newText, inertText(newText)]));
    options.onRefresh?.();
    if ("refused" in outcome) return sendError(response, 409, outcome.refused === "parked-changed" ? "PARKED_CHANGED" : "NO_DRAFT", `${ref} parked on another rewrite now, or none: reload the item. Your answers are on ${subject.host}.`);
    if (written || labelsDone) await options.syncNow?.();
    return sendJson(response, 200, { recorded: true, ...("rerun" in outcome ? { rerun: true } : { settled: outcome.settled }), ...(written ? { written: true } : {}), ...(labelsDone ? { labels: labelsDone } : {}) });
  }

  /** Items whose split is being created now: a second press is refused instead of making the children twice. */
  const restructuring = new Set<string>();

  /** Writes a person's decision on a proposal to the item's log (meta branch), naming the question, and answers the request. */
  async function logDecision(response: ServerResponse, subject: Ref, text: string, decision: "accepted" | "edited" | "rejected", asked: { at: string; by: LogWriter } | undefined, result: Record<string, unknown>): Promise<void> {
    const write = items?.write;
    if (write?.appendLog && subject.host === items!.host) {
      let logged: WriteOutcome;
      try {
        logged = await write.appendLog(subject, { kind: "answer", by: by(), fields: { answer: text, proposal: decision, ...(asked ? { to: asked.at, toBy: asked.by } : {}) } });
      } catch (error) {
        options.onRefresh?.();
        return sendJson(response, 200, { ...result, logged: false, problem: error instanceof Error ? error.message : String(error) });
      }
      await options.syncNow?.();
      return sendJson(response, 200, { ...result, logged: true, shared: logged.shared });
    }
    options.onRefresh?.();
    return sendJson(response, 200, result);
  }

  /**
   * A person decides on a proposed restructuring (decision 94). Edit gives a person's own `parts` (each with where it goes) and
   * `original` (what becomes of the Item), only while nothing is made. Accept and edit make the parts on the host, in order: a new
   * child, related or unlinked Item, or the parts' text added to an existing Item (once per Item, to its description as read just
   * before); then the Item keeps its part (its text narrowed, and triaged again), is parked as an umbrella, or is closed as replaced.
   * Each part is recorded as it is made, and its text ends with a marker line carrying the restructuring's id, so a retry after a
   * failure (even on a store rebuilt from nothing) links what is not linked yet and makes only the rest. Stop here ends it with the
   * parts made so far and records the rest as text on the Item. On a host Scope Soup cannot write, nothing is made: the decision is
   * recorded with the restructuring as text, for a person to carry out. Reject starts the item over at triage, with the rejection
   * passed on; once a part exists it is refused, since it would leave the parts without the decision.
   */
  async function restructureDecision(response: ServerResponse, body: Record<string, unknown>, item: WorkItem, parked: Parked | undefined, asked: { at: string; by: LogWriter } | undefined, proposed: Restructuring, action: "accept" | "edit" | "reject" | "stop", onHost?: string): Promise<void> {
    const subject = item.ref;
    const ref = refKey(subject);
    const question = `Proposed restructuring: ${proposed.reason}`;
    const isParked = parked?.as === "needs-decision";
    /** The decision as an answer comment to the restructuring's question comment. False, with the error sent, when it could not be posted. */
    const decideOnHost = async (text: string, decision: "accepted" | "edited" | "rejected", already = ""): Promise<boolean> => {
      try {
        await options.questions!.answer(subject, onHost!, { answer: text, proposal: decision, by: by().who });
        return true;
      } catch (error) {
        options.onRefresh?.();
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof AlreadyAnswered) sendError(response, 409, "ALREADY_ANSWERED", `${reason}${already}`);
        else {
          store.appendEvent({ kind: "orchestrator.host_write_failed", subject: ref, actor: by().who, data: { reason: `Could not post the decision on the restructuring of ${subject.id} on ${subject.host}: ${reason}` } }, now().toISOString());
          sendError(response, 400, "WRITE_REFUSED", `${reason}${already}`);
        }
        return false;
      }
    };
    const stored = currentRestructuring(store, subject);
    const fixed = stored ?? proposed;
    // The parts that exist: recorded in the store, or found on the host by their marker lines.
    const existing = new Map([...(stored?.created ?? []).map((each) => [each.part, each.ref] as const), ...[...markedParts(loadSnapshot(store).works, subject, fixed)].map(([part, work]) => [part, work.ref] as const)]);
    if (action === "reject") {
      if (existing.size > 0) return sendError(response, 409, "PARTS_CREATED", `Some parts of ${ref} exist already: accept the restructuring to finish it, Stop here to end it with what exists, or close those parts first.`);
      const text = `Rejected the proposed restructuring of the item (${restructuringWords(proposed.original, proposed.parts)}; it was proposed because: ${proposed.reason}). Do not propose it again.`;
      if (onHost) {
        if (!(await decideOnHost(text, "rejected"))) return;
        const released = isParked ? releaseJob(store, subject, by().who, now().toISOString(), `${by().who} rejected the proposed restructuring.`) : false;
        options.onRefresh?.();
        return sendJson(response, 200, { recorded: true, released });
      }
      const at = now().toISOString();
      const released = store.tx(() => {
        addAnswer(store, { subject, answer: text, by: by().who, at, question });
        return isParked ? releaseJob(store, subject, by().who, at, `${by().who} rejected the proposed restructuring.`) : false;
      });
      return logDecision(response, subject, text, "rejected", asked, { recorded: true, released });
    }
    if (!isParked && !onHost) return sendError(response, 409, "NOT_PARKED", `${ref} is not parked on the proposed restructuring (any more): reload the item.`);
    if (restructuring.has(ref)) return sendError(response, 409, "RESTRUCTURE_RUNNING", `The parts of ${ref} are being made now.`);
    if (action === "stop") {
      // Ends it with what exists: the rest, and the Item's own change, are for a person, as text on the Item.
      if (existing.size === 0) return sendError(response, 409, "NOTHING_MADE", `No part of ${ref} exists yet: reject the restructuring instead.`);
      const names = [...existing].sort((a, b) => a[0] - b[0]).map(([, made]) => made.id).join(", ");
      const toMake = fixed.parts.filter((part) => part.goes !== "original").length;
      const rest = restructuringText(subject, { ...fixed, ...(fixed.carried ?? proposed.carried ? { carried: fixed.carried ?? proposed.carried } : {}) }, new Set(existing.keys()));
      const reason = `${by().who} stopped the restructuring with ${existing.size} of ${toMake} parts made (${names}): carry out the rest by hand.`;
      const text = `Stopped the proposed restructuring with ${existing.size} of ${toMake} parts made (${names}). Scope Soup makes nothing more: carry out the rest by hand.\n\n${rest}`;
      const at = now().toISOString();
      if (onHost) {
        if (!(await decideOnHost(text, "accepted"))) return;
        stopRestructuring(store, subject, by().who, at, reason);
        options.onRefresh?.();
        return sendJson(response, 200, { recorded: true, stopped: true, text: rest });
      }
      store.tx(() => {
        addAnswer(store, { subject, answer: text, by: by().who, at, question });
        stopRestructuring(store, subject, by().who, at, reason);
      });
      return logDecision(response, subject, text, "accepted", asked, { recorded: true, stopped: true, text: rest });
    }
    let edited: { original: OriginalFate; parts: ProposedPart[] } | undefined;
    if (action === "edit") {
      // Once a part exists the restructuring is fixed: an edit would be silently set aside, so it is refused.
      if (existing.size > 0) return sendError(response, 409, "PARTS_CREATED", `Some parts of ${ref} exist already, so it can no longer be edited: Accept finishes the same restructuring, or Stop here ends it with what exists.`);
      const original = body.original ?? proposed.original;
      edited = asRestructuring({ original, parts: body.parts });
      if (!edited) {
        const parts = asParts(body.parts);
        const whole = Array.isArray(body.parts) && parts.length === body.parts.length && ORIGINAL_FATES.includes(original as OriginalFate);
        return sendError(response, 400, "BAD_FIELD", (whole && restructuringProblem(original as OriginalFate, parts)) || 'parts must be a list of { title, description, verification, goes, into? } (goes: "original", "child", "related", "unlinked" or "into", into naming an Item), each with a title; original "keeps", "umbrella" or "replaced".');
      }
    }
    const decision = action === "edit" ? "edited" : "accepted";
    const writer = restructureHost(subject);
    if (!writer) {
      const chosen = { ...fixed, ...(edited ?? {}) };
      const listed = restructuringText(subject, { ...chosen, ...(proposed.carried ? { carried: proposed.carried } : {}) });
      const reason = `${by().who} accepted the restructuring (${restructuringWords(chosen.original, chosen.parts)}). Scope Soup cannot write to this host: carry it out by hand.`;
      const text = `Accepted the proposed restructuring${action === "edit" ? " with changes" : ""}. Scope Soup made nothing (the host is read-only here): carry it out by hand.\n\n${listed}`;
      const at = now().toISOString();
      store.tx(() => {
        addAnswer(store, { subject, answer: text, by: by().who, at, question });
        finishRestructuring(store, subject, by().who, at, reason);
      });
      return logDecision(response, subject, text, decision, asked, { recorded: true, created: [], byHand: true, text: listed });
    }
    // What is made follows a person's edit only while nothing exists; that version is checked before anything is written.
    const planned = edited ?? fixed;
    const snapshot = loadSnapshot(store);
    const index = buildIndex(snapshot);
    const target = (part: ProposedPart): WorkItem | undefined => snapshot.works.find((work) => work.ref.host === subject.host && work.ref.id === part.into && work.ref.id !== subject.id);
    const unknown = planned.parts.findIndex((part) => part.goes === "into" && !target(part));
    if (unknown >= 0) return sendError(response, 400, "BAD_TARGET", `Part ${unknown + 1} goes into ${planned.parts[unknown]!.into}, which is not another Item on ${subject.host}: edit where it goes.`);
    const closed = planned.parts.findIndex((part, at) => part.goes === "into" && !existing.has(at) && (target(part)!.state === "done" || target(part)!.state === "abandoned"));
    if (closed >= 0) return sendError(response, 400, "TARGET_CLOSED", `Part ${closed + 1} goes into ${planned.parts[closed]!.into}, which is ${target(planned.parts[closed]!)!.state}: edit where it goes.`);
    if (planned.original === "replaced") {
      // Closing an Item that is being worked on would leave that work without its Item.
      const job = loadJobs(store)[ref];
      const busy = busyWords(index, ref) ?? (job && !job.parked ? "a job of Scope Soup's runs on it" : undefined);
      if (busy) return sendError(response, 409, "ITEM_BUSY", `${ref} is not closed as replaced while ${busy}: wait for it, or edit the restructuring so the Item keeps a part or becomes an umbrella.`);
    }
    const edits = planned.original !== "umbrella" || planned.parts.some((part) => part.goes === "into");
    if (edits && !writer.write.editWork) return sendError(response, 400, "WRITE_REFUSED", `Scope Soup cannot change Items on ${subject.host}: edit the restructuring to make only new Items under an umbrella, or reject it.`);
    restructuring.add(ref);
    try {
      // What exists already, from the host too: parts made before the store was rebuilt, or whose record was lost.
      await options.syncNow?.();
      let plan: Restructuring | undefined;
      if (onHost) {
        // The parts are the items that carry the part lines, found on GitHub each time; they are not stored. The person's
        // edit counts while none exists; a job keeps it for a retry.
        const kept = currentRestructuring(store, subject);
        const base = kept ?? proposed;
        const found = hostParts(store, subject, base);
        const chosen = found.length === 0 && edited ? edited : { original: base.original, parts: base.parts };
        if (kept) acceptRestructuring(store, subject, found.length === 0 ? edited : undefined, by().who, now().toISOString());
        const carried = kept?.carried ?? proposed.carried;
        plan = { id: base.id, reason: proposed.reason, ...chosen, ...(carried ? { carried } : {}), created: found };
      } else {
        adoptFound(store, subject, loadSnapshot(store).works, by().who, now().toISOString());
        plan = acceptRestructuring(store, subject, edited, by().who, now().toISOString());
      }
      if (!plan) return sendError(response, 409, "NOT_PARKED", `${ref} is not parked on the proposed restructuring (any more): reload the item.`);
      const parts = plan.parts;
      const marks = { parent: subject, id: plan.id, ...(writer.issueNumbers ? { issueNumbers: true } : {}) };
      const toMake = parts.filter((part) => part.goes !== "original").length;
      const made = new Map((plan.created ?? []).map((each) => [each.part, each]));
      const record = (part: CreatedPart): void => {
        if (!onHost) recordPart(store, subject, part, by().who, now().toISOString());
      };
      const incomplete = (at: number, problem: string): void => {
        options.onRefresh?.();
        sendError(response, 502, "RESTRUCTURE_INCOMPLETE", `${made.size} of ${toMake} parts exist; part ${at + 1} failed: ${problem} Accept again to finish (a part already made is linked if it needs to be, and not made again), or Stop here to end it with what exists.`);
      };
      /** Links a related part where the host keeps links; true when it is linked (or the host has none to make). */
      const relate = async (at: number, work: Ref): Promise<boolean> => {
        if (writer.write.linkRelated) {
          try {
            await writer.write.linkRelated(subject, work);
          } catch (error) {
            const unlinked = { part: at, ref: work, linked: false };
            made.set(at, unlinked);
            record(unlinked);
            incomplete(at, `linking ${work.id} as related: ${error instanceof Error ? error.message : String(error)}`);
            return false;
          }
        }
        const linked = { part: at, ref: work, linked: true };
        made.set(at, linked);
        record(linked);
        return true;
      };
      const fresh = loadSnapshot(store).works;
      for (let at = 0; at < parts.length; at++) {
        const part = parts[at]!;
        if (part.goes === "original") continue;
        const before = made.get(at);
        if (before?.linked) continue;
        if (before && part.goes === "related") {
          if (!(await relate(at, before.ref))) return;
          continue;
        }
        if (before) {
          // Made, but not under the item yet: link it instead of making another.
          if (!writer.write.linkChild) return incomplete(at, `${before.ref.id} is not linked under ${subject.id} and this host cannot link it: link it by hand.`);
          try {
            await writer.write.linkChild(subject, before.ref);
          } catch (error) {
            return incomplete(at, `linking ${before.ref.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
          made.set(at, { ...before, linked: true });
          record({ ...before, linked: true });
          continue;
        }
        if (part.goes === "into") {
          // Every part into this Item at once, added to its description as read just before the write, so none overwrites another.
          const group = parts.flatMap((each, other) => (each.goes === "into" && each.into === part.into && !made.has(other) ? [{ part: each, index: other }] : []));
          const known = fresh.find((work) => work.ref.host === subject.host && work.ref.id === part.into) ?? target(part);
          if (!known) return incomplete(at, `${part.into} is not an Item on ${subject.host} any more.`);
          const into = known.ref;
          try {
            const current = writer.read ? await writer.read(into) : known;
            if (!current) return incomplete(at, `${into.id} is not an Item on ${subject.host} any more.`);
            const text = intoBody(current.body ?? "", group, marks);
            if (text !== (current.body ?? "").trim()) await writer.write.editWork!(into, { body: text });
            // The re-read must show every section: a description changed at the same moment loses none silently.
            const after = writer.read ? await writer.read(into) : null;
            if (after && !intoWritten(`${after.body ?? ""}\n${after.verification ?? ""}`, group.map((each) => each.index), marks)) {
              return incomplete(at, `the description of ${into.id} does not show the added text; it may have been changed at the same moment.`);
            }
          } catch (error) {
            if (error instanceof BodyChanged) return incomplete(at, `the description of ${into.id} changed, or holds what Scope Soup cannot write back: ${error.message}`);
            return incomplete(at, `adding it to ${into.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
          for (const each of group) {
            const added = { part: each.index, ref: into, linked: true };
            made.set(each.index, added);
            record(added);
          }
          continue;
        }
        let done: WriteOutcome;
        try {
          done = await writer.write.createWork!(partWork(part, at, { ...marks, ...(plan.carried ? { carried: plan.carried } : {}), ...(writer.verificationInBody ? { verificationInBody: true } : {}), ...(options.aiLabel?.() ? { label: options.aiLabel() } : {}), by: by() }));
        } catch (error) {
          return incomplete(at, error instanceof Error ? error.message : String(error));
        }
        if (part.goes === "related") {
          // Recorded unlinked first, so a failed link is made again on a retry, not the Item.
          made.set(at, { part: at, ref: done.work, linked: false });
          record({ part: at, ref: done.work, linked: false });
          if (!(await relate(at, done.work))) return;
          continue;
        }
        // Recorded before anything else, linked or not, so it is never made twice.
        const child = { part: at, ref: done.work, linked: done.linked !== false };
        made.set(at, child);
        record(child);
        if (!child.linked) return incomplete(at, done.problem ?? `${done.work.id} was made but not linked under ${subject.id}.`);
      }
      // Then the Item itself, last, so a retry finds every part and only does this again (the same text, the same close).
      const where = parts.flatMap((part, at) => (made.has(at) ? [`${made.get(at)!.ref.id} (${goesWords(part, subject)})`] : [])).join(", ");
      const replacements = [...new Map([...made.values()].sort((a, b) => a.part - b.part).map((each) => [refKey(each.ref), each.ref])).values()];
      const kept = parts.find((part) => part.goes === "original");
      try {
        if (plan.original === "keeps") await writer.write.editWork!(subject, keptPatch(kept!));
        if (plan.original === "replaced") {
          // Replaced by one existing Item and nothing new: a duplicate of it.
          const duplicateOf = replacements.length === 1 && parts.every((part) => part.goes === "into") ? replacements[0] : undefined;
          await writer.write.editWork!(subject, { state: "abandoned", ...(duplicateOf ? { duplicateOf } : {}) });
        }
      } catch (error) {
        options.onRefresh?.();
        return sendError(response, 502, "RESTRUCTURE_INCOMPLETE", `All ${toMake} parts exist; changing ${subject.id} failed: ${error instanceof Error ? error.message : String(error)} Accept again to finish, or Stop here to leave ${subject.id} as it is.`);
      }
      const names = replacements.map((each) => each.id).join(", ");
      const reason = plan.original === "keeps"
        ? `Restructured: ${subject.id} keeps "${kept!.title}"; the rest went to ${where}. Triage looks at it again.`
        : plan.original === "umbrella"
          ? `Restructured into ${where}; the work happens there.`
          : `Replaced by ${names}: ${where}.`;
      const fate = plan.original === "keeps" ? `${subject.id} keeps "${kept!.title}", its text narrowed to that part.` : plan.original === "umbrella" ? `${subject.id} is an umbrella; the work happens in its sub-items.` : `${subject.id} is closed, replaced by ${names}.`;
      const text = `Accepted the proposed restructuring${action === "edit" ? " with changes" : ""}: ${where}. ${fate}`;
      const at = now().toISOString();
      store.tx(() => {
        if (!onHost) addAnswer(store, { subject, answer: text, by: by().who, at, question });
        finishRestructuring(store, subject, by().who, at, reason, plan.original === "keeps");
      });
      // The parts exist; the decision goes last, so pressing again after a failure only posts it.
      if (onHost && !(await decideOnHost(text, decision, " The parts exist: accept again to post the decision."))) return;
      await options.syncNow?.();
      return logDecision(response, subject, text, decision, asked, { recorded: true, created: [...made.values()].sort((a, b) => a.part - b.part).map((each) => refKey(each.ref)) });
    } finally {
      restructuring.delete(ref);
    }
  }

  /** The host this item's restructuring is made on: the one the item lives on, when Scope Soup may create items there. */
  function restructureHost(subject: Ref): RestructureHost | undefined {
    return (options.restructure ?? []).find((each) => each.host === subject.host && each.write.createWork !== undefined);
  }

  /** A list given as a list or as one comma-separated text. Null when it is neither. */
  function list(value: unknown): string[] | null {
    const parts = typeof value === "string" ? value.split(",") : Array.isArray(value) && value.every((each) => typeof each === "string") ? (value as string[]) : null;
    return parts === null ? null : parts.map((each) => each.trim()).filter(Boolean);
  }

  /** An item named by its id (`A-1`) or its ref key (`metaBranch:work:A-1`), on the items host. */
  const itemRef = (name: string): Ref => ({ host: items!.host, kind: "work", id: name.startsWith(`${items!.host}:work:`) ? name.slice(items!.host.length + 6) : name });

  async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const body: unknown = JSON.parse(await readBody(request, 256 * 1024));
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("The body is not a JSON object.");
    return body as Record<string, unknown>;
  }

  /** Writes, then brings the store up to date so the answer and the board show the write. */
  async function written(response: ServerResponse, done: WriteOutcome, message?: string): Promise<void> {
    await options.syncNow?.();
    return sendJson(response, 200, { ref: refKey(done.work), shared: done.shared, conflict: done.conflict, ...(done.problem ? { problem: done.problem } : {}), ...(message ? { message } : {}) });
  }

  /**
   * The item commands of a person (`src/items`): `{ as, ... }` names who (else the board's picked person). The same rules as the command
   * line on the meta ref; the server adds what only it knows: a session running on the item.
   */
  async function person(request: IncomingMessage, response: ServerResponse, verb: "claim" | "handback" | "release"): Promise<void> {
    const write = items?.write;
    if ((!items || !write || !items.work) && !options.jiraItems) return sendError(response, 403, "READ_ONLY", "Items cannot be written here: the project's host is read-only.");
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    if (typeof body.id === "string" && holdHost(body.id) === "jira") return jiraHold(response, verb, options.jiraItems!, body);
    if (!items || !write || !items.work) return sendError(response, 403, "READ_ONLY", "Items cannot be written here: the project's host is read-only.");
    // The item commands say who with `as`; the board's buttons with its picked person.
    const who = (typeof body.as === "string" ? body.as.trim() : "") || picked() || "";
    const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
    if (who === "" || who.length > 100 || typeof body.id !== "string") return sendError(response, 400, "BAD_FIELD", 'Give { "id": "A-1", "as": "the person" }.');
    const backend: Backend = {
      kind: "metaBranch", host: items.host, ...(options.machine ? { machine: options.machine } : {}), who, work: items.work, write, now,
      mainBranch: remoteNames().mainBranch, ...(options.branches ? { branches: options.branches } : {}),
    };
    try {
      const ref = { host: items.host, kind: "work" as const, id: itemRef(body.id).id };
      if (verb === "claim") {
        const running = sessionRunning(ref);
        if (running) throw new Refused(running);
        const from = text(body.from);
        const done = await claimItem(backend, ref.id, from ? { from } : {});
        return written(response, { work: done.ref, shared: done.shared, conflict: false }, done.message);
      }
      if (verb === "handback") {
        // No branch or commit is given: Scope Soup reads the Item's branch from the remote.
        const note = text(body.note);
        const done = await handBackItem(backend, ref.id, note ? { note } : {});
        return written(response, { work: done.ref, shared: done.shared, conflict: false }, done.message);
      }
      const note = text(body.note);
      const done = await releaseItem(backend, ref.id, note);
      return written(response, { work: done.ref, shared: done.shared, conflict: false }, done.message);
    } catch (error) {
      if (error instanceof Refused) return sendError(response, 409, "REFUSED", error.message);
      return sendError(response, 400, "WRITE_REFUSED", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The board's buttons on a Jira Item, for the picked person (or `as`), through the server's token: the same rules as the item
   * commands on Jira. The person is the Jira account the picked name is (`JiraBoard.person`). Jira says only that the server's
   * account wrote, so the hand-back's comment and property and a release's comment name the person, and so does an event here.
   */
  async function jiraHold(response: ServerResponse, verb: "claim" | "handback" | "release", board: JiraBoard, body: Record<string, unknown>): Promise<void> {
    const who = (typeof body.as === "string" ? body.as.trim() : "") || picked() || "";
    if (who === "" || who.length > 100 || typeof body.id !== "string") return sendError(response, 400, "BAD_FIELD", 'Give { "id": "DEMO-1" } and pick who you are at the top of the board.');
    const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note : undefined;
    try {
      const ref = itemRefOn({ kind: "jira", host: board.host }, body.id);
      if (verb === "claim") {
        const running = sessionRunning(ref);
        if (running) throw new Refused(running);
      }
      // To claim the name must be a Jira account. A name Jira does not know may release another's hold, and is refused a hand-back
      // by the rules (it holds nothing); unless it is the holder's display name, which then cannot be told apart.
      const item = (await board.work.getWork(ref)) ?? undefined;
      const resolved = await board.resolve(who, item);
      const holderName = item?.holder && item.holder.actor.name.trim().toLowerCase() === who.toLowerCase();
      if ("why" in resolved && (resolved.hard || verb === "claim" || (verb === "handback" && holderName))) throw new Refused(resolved.why);
      const known = "person" in resolved ? resolved.person : undefined;
      const person = known ?? { id: who, name: who };
      const { mainBranch } = remoteNames();
      const backend: Backend = { ...board.backend(person), mainBranch, ...(options.branches ? { branches: options.branches } : {}) };
      const done = verb === "claim" ? await claimItem(backend, ref.id) : verb === "handback" ? await handBackItem(backend, ref.id, note ? { note } : {}) : await releaseItem(backend, ref.id, note);
      const kind = verb === "claim" ? "person.claimed" : verb === "handback" ? "person.handed_back" : "person.released";
      store.appendEvent({ kind, subject: refKey(ref), actor: who, data: { reason: done.message, via: "board", ...(known ? { account: known.id } : {}), ...(note ? { note } : {}) } }, now().toISOString());
      return written(response, { work: done.ref, shared: done.shared, conflict: false }, done.message);
    } catch (error) {
      if (error instanceof Refused) return sendError(response, 409, "REFUSED", error.message);
      return sendError(response, 400, "WRITE_REFUSED", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Which host an item the hold calls name is on: by its ref key (`jira:work:DEMO-1`, `metaBranch:work:A-1`); a bare id is on the
   * items host when there is one, else on Jira.
   */
  function holdHost(id: string): "jira" | "items" | undefined {
    const jira = options.jiraItems;
    if (jira && id.startsWith(`${jira.host}:work:`)) return "jira";
    if (items && id.startsWith(`${items.host}:work:`)) return "items";
    return items ? "items" : jira ? "jira" : undefined;
  }

  /** The project's remote and main branch, for the words and commands; the usual names when the configuration cannot be read. */
  function remoteNames(): { remote: string; mainBranch: string } {
    try {
      return options.branches?.names() ?? { remote: "origin", mainBranch: "main" };
    } catch {
      return { remote: "origin", mainBranch: "main" };
    }
  }

  /** Why a person cannot claim the item: a session of Scope Soup's runs on it (only the server knows). */
  function sessionRunning(ref: Ref): string | undefined {
    const job = loadJobs(store)[refKey(ref)];
    return job?.sessionId ? `${ref.id} has its ${job.step} session running now. Scope Soup stops nothing that runs: pause Scope Soup on the board, or wait for the session to end.` : undefined;
  }

  /**
   * The hold buttons on an Item page, for the board's person, with the same rules as the item commands (`src/items`). None on
   * an Item that is over, or where items cannot be written.
   */
  async function holdButtons(work: WorkItem | undefined): Promise<ItemPage["hold"]> {
    if (!work || work.state === "done" || work.state === "abandoned") return undefined;
    const jira = options.jiraItems && work.ref.host === options.jiraItems.host ? options.jiraItems : undefined;
    if (!jira && (!items?.work || !items.write.appendLog || work.ref.host !== items.host)) return undefined;
    const at = now();
    const who = picked();
    const pick = "Pick who you are at the top of the board first.";
    const action = (why: string | undefined) => (why === undefined ? {} : { why });
    // Jira: who the picked name is there (`JiraBoard.resolve`); a name that may not act at all gets only a Claim that says why.
    const resolved = jira && who ? await jira.resolve(who, work) : undefined;
    if (resolved && "why" in resolved && resolved.hard) return { claim: { why: resolved.why } };
    const person = resolved && "person" in resolved ? resolved.person : undefined;
    const me = jira ? { kind: "jira" as const, who: person?.id ?? who ?? "", name: person?.name ?? who ?? "" } : { kind: "metaBranch" as const, who: who ?? "" };
    const mine = who !== undefined && holdsIt(me, work, at);
    const hold: NonNullable<ItemPage["hold"]> = {};
    if (!mine) hold.claim = action(!who ? pick : sessionRunning(work.ref) ?? whyNotClaim(me, work, at, true) ?? (resolved && "why" in resolved ? resolved.why : undefined));
    else {
      hold.handBack = action(whyNotHandBack(me, work, at, true) ?? (options.branches ? undefined : "Scope Soup cannot read the project's remote here (it runs without a project), so it cannot read the branch to hand it back."));
      const name = workBranch(work.ref);
      const { remote, mainBranch } = remoteNames();
      hold.branch = { name, remote, mainBranch, ...branchCommands(name, remote, mainBranch) };
    }
    if (work.holder && !work.holder.actor.bot && whyNotRelease(work, at) === undefined) hold.release = action(who ? undefined : pick);
    return hold;
  }

  /** `{ title, body?, verification?, labels?, blockedBy? }`: a new item, and a `created` line in its log. */
  async function createItem(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const write = items?.write;
    if (!write?.createWork) return sendError(response, 403, "READ_ONLY", "Items cannot be written here: the project's host is read-only.");
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const { title, body: text, verification } = body;
    const labels = body.labels === undefined ? [] : list(body.labels);
    const blockedBy = body.blockedBy === undefined ? [] : list(body.blockedBy);
    if (typeof title !== "string" || title.trim() === "") return sendError(response, 400, "TITLE_MISSING", "Give the item a title.");
    if ((text !== undefined && typeof text !== "string") || (verification !== undefined && typeof verification !== "string") || labels === null || blockedBy === null) {
      return sendError(response, 400, "BAD_FIELD", "body and verification are text; labels and blockedBy are lists of text.");
    }
    const priority = body.priority;
    if (priority !== undefined && priority !== "" && !isPriority(priority)) return sendError(response, 400, "BAD_FIELD", `priority must be one of ${PRIORITIES.join(", ")}.`);
    const named = typeof body.as === "string" && body.as.trim() ? body.as.trim() : picked();
    if (!named) return sendError(response, 400, "PERSON_MISSING", 'Say who files it: { "as": "the person" }, or pick who you are at the top of the board.');
    const creator = { who: named, agent: false };
    const from = typeof body.from === "string" && body.from.trim() ? body.from.trim() : undefined;
    try {
      const done = await write.createWork({
        log: [{ kind: "created", by: creator }, ...(body.claim === true ? [{ kind: "claimed", by: creator, fields: { until: farUntil(now()), ...(from ? { from } : {}) } }] : [])],
        title: title.trim(),
        ...(text?.trim() ? { body: text } : {}),
        ...(verification?.trim() ? { verification: verification.trim() } : {}),
        labels,
        blockedBy: blockedBy.map(itemRef),
        ...(priority ? { priority: priority as Priority } : {}),
      });
      return written(response, done, `Filed ${done.work.id}: ${title.trim()}${body.claim === true ? `. ${creator.who} holds it; Scope Soup will not start it` : ""}`);
    } catch (error) {
      return sendError(response, 400, "WRITE_REFUSED", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * A person's picks on an Item's decisions that its implementor took itself, held in the browser and sent together:
   * `{ ref, decisions: [{ id, action: "accept" | "overturn", answer? }] }`. Accept closes a decision; Overturn (with the answer)
   * puts it into the running work while the change has not merged, else makes a new Item that carries it. All are refused when one
   * is gone (404) or settled already (409): nothing is written. Decisions not in the list stay open. On the host the verdicts are one
   * write (GitHub: one edit of the decisions' comment; the meta branch: one commit); then one store transaction records them, an
   * event per decision, with the overturns kept for the running work.
   */
  async function settleDecisions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const { ref } = body;
    const given = Array.isArray(body.decisions) ? (body.decisions as unknown[]) : null;
    const usage = 'Give { "ref": "host:work:id", "decisions": [{ "id": "the decision", "action": "accept" | "overturn", "answer"?: "..." }] }.';
    if (typeof ref !== "string" || given === null || given.length === 0) return sendError(response, 400, "BAD_FIELD", usage);
    const picks: AssumptionPick[] = [];
    for (const each of given) {
      const { id, action, answer } = (typeof each === "object" && each !== null ? each : {}) as Record<string, unknown>;
      if (typeof id !== "string" || (action !== "accept" && action !== "overturn")) return sendError(response, 400, "BAD_FIELD", usage);
      if (action === "overturn" && (typeof answer !== "string" || answer.trim() === "")) return sendError(response, 400, "ANSWER_MISSING", "Overturn needs your answer: the decision that replaces the implementor's.");
      if (picks.some((pick) => pick.id === id)) return sendError(response, 400, "DUPLICATE_DECISION", "Give one pick for each decision.");
      picks.push({ id, action, ...(action === "overturn" ? { answer: (answer as string).trim() } : {}) });
    }
    const item = loadSnapshot(store).works.find((work) => refKey(work.ref) === ref);
    if (!item) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${ref}.`);
    const decisions: Assumption[] = [];
    for (const pick of picks) {
      const decision = item.assumptions?.find((each) => each.id === pick.id);
      if (!decision) return sendError(response, 404, "DECISION_NOT_FOUND", `No decision ${pick.id} on ${ref}.`);
      if (decision.settled) return sendError(response, 409, "ALREADY_SETTLED", `"${decision.question}" is ${decision.settled.verdict} already: reload the item. Nothing was sent.`);
      decisions.push(decision);
    }
    const target = assumptionHost(item.ref);
    if (!target) return sendError(response, 403, "READ_ONLY", `Decisions on ${item.ref.host} cannot be settled here: writes to it are off.`);
    const who = by().who;
    let outcomes: AssumptionOutcome[];
    try {
      outcomes = await target.settle(item.ref, picks, who);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AlreadyAnswered) return sendError(response, 409, "ALREADY_SETTLED", `${message} Nothing was sent: reload the item.`);
      store.appendEvent({ kind: "orchestrator.host_write_failed", subject: ref, actor: who, data: { reason: `Could not settle ${picks.length === 1 ? `decision ${picks[0]!.id}` : `${picks.length} decisions`} on ${item.ref.id} on ${item.ref.host}: ${message}` } }, now().toISOString());
      return sendError(response, 400, "WRITE_REFUSED", message);
    }
    const at = now().toISOString();
    // One transaction: an event per decision, and the overturns that go into the running work kept for the cycle.
    store.tx(() => {
      outcomes.forEach((outcome, index) => {
        const decision = decisions[index]!;
        const pick = picks[index]!;
        if (outcome.verdict === "accepted") {
          store.appendEvent({ kind: "person.assumption_accepted", subject: ref, actor: who, data: { reason: `${who} accepted the implementor's decision: ${decision.question} ${decision.chosen}.`, id: decision.id } }, at);
          return;
        }
        const answer = pick.answer ?? "";
        if (outcome.work) keepOverturn(store, item, decision, answer, who, at);
        if (outcome.reused && outcome.item) {
          store.appendEvent({ kind: "orchestrator.overturn_reused", subject: ref, actor: "orchestrator", data: { reason: `${outcome.item.id} was filed for decision ${decision.id} on ${item.ref.id} before; it is reused, and only the verdict is written now.` } }, at);
        }
        const tail = outcome.work ? ` It went into the running work of ${item.ref.id}.` : outcome.item ? ` ${outcome.item.id} reworks it.` : "";
        store.appendEvent({ kind: "person.assumption_overturned", subject: ref, actor: who, data: { reason: `${who} overturned the implementor's decision (${decision.question} ${decision.chosen}) with: ${answer}${tail}`, id: decision.id, ...(outcome.item ? { item: refKey(outcome.item) } : {}), ...(outcome.work ? { work: true } : {}) } }, at);
      });
    });
    await options.syncNow?.();
    options.onRefresh?.();
    return sendJson(response, 200, { settled: outcomes.map((outcome) => ({ id: outcome.id, verdict: outcome.verdict, ...(outcome.item ? { item: refKey(outcome.item) } : {}), ...(outcome.work ? { work: true } : {}) })) });
  }

  /** `{ ref, title?, body?, state?, verification?, labels?, blockedBy? }`: changes what is given, and logs what changed. */
  async function editItem(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const write = items?.write;
    const hostEdit = options.hostEdit;
    if (!write?.editWork && !hostEdit) return sendError(response, 403, "READ_ONLY", "Items cannot be written here: the project's host is read-only.");
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    if (typeof body.ref !== "string") return sendError(response, 400, "REF_MISSING", 'Give { "ref": "host:work:id", ... }.');
    const current: WorkItem | undefined = loadSnapshot(store).works.find((work) => refKey(work.ref) === body.ref);
    const onItems = !!write?.editWork && current?.ref.host === items!.host;
    const onHost = !onItems && hostEdit !== undefined && current?.ref.host === hostEdit.host;
    if (!current || (!onItems && !onHost)) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${body.ref} that can be edited here.`);

    const patch: WorkPatch = {};
    const changed: string[] = [];
    const bad = (field: string, what: string) => sendError(response, 400, "BAD_FIELD", `${field} must be ${what}.`);
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || body.title.trim() === "") return bad("title", "text that is not empty");
      if (body.title.trim() !== current.title) (patch.title = body.title.trim()), changed.push("title");
    }
    if (body.body !== undefined) {
      if (typeof body.body !== "string") return bad("body", "text");
      if (body.body.trim() !== (current.body ?? "").trim()) (patch.body = body.body), changed.push("description");
    }
    if (body.state !== undefined) {
      const allowed = onHost ? HOST_STATES : STATES;
      if (!allowed.includes(body.state as WorkState)) return bad("state", allowed.join(", "));
      if (body.state !== (onHost ? current.state : current.hostState.split(";")[0])) (patch.state = body.state as WorkState), changed.push("state");
    }
    if (body.verification !== undefined) {
      if (typeof body.verification !== "string") return bad("verification", "text");
      const next = body.verification.trim();
      if (next !== (current.verification ?? "")) (patch.verification = next === "" ? null : next), changed.push("verification");
    }
    if (body.labels !== undefined) {
      const labels = list(body.labels);
      if (labels === null) return bad("labels", "a list of text");
      if (labels.join("\n") !== current.labels.join("\n")) (patch.labels = labels), changed.push("labels");
    }
    if (body.blockedBy !== undefined) {
      const names = list(body.blockedBy);
      if (names === null) return bad("blockedBy", "a list of item ids");
      // On the item's own host: a GitHub Item names its blockers as `#12` or `12`.
      const host = current.ref.host;
      const refs = names.map((name): Ref => ({ host, kind: "work", id: name.startsWith(`${host}:work:`) ? name.slice(host.length + 6) : name.replace(/^#/, "") }));
      if (refs.map((each) => each.id).join("\n") !== current.blockedBy.map((each) => each.id).join("\n")) (patch.blockedBy = refs), changed.push("blocked by");
    }
    if (body.priority !== undefined) {
      if (body.priority !== "" && !isPriority(body.priority)) return bad("priority", PRIORITIES.join(", "));
      const next = body.priority === "" ? undefined : (body.priority as Priority);
      if (next !== current.priority) (patch.priority = next ?? null), changed.push("priority");
    }
    if (changed.length === 0) return sendJson(response, 200, { ref: refKey(current.ref), unchanged: true });
    if (onHost) {
      // Blockers are written through as issue dependencies; labels are changed on the host.
      if (patch.labels !== undefined) return sendError(response, 400, "BAD_FIELD", `The labels of ${current.ref.id} are changed on ${current.ref.host}, not here.`);
      try {
        await hostEdit!.edit(current.ref, patch);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // The store is not touched: the next poll shows what the host has.
        store.appendEvent({ kind: "orchestrator.host_write_failed", subject: refKey(current.ref), actor: by().who, data: { reason: `Could not change the ${changed.join(", ")} of ${current.ref.id} on ${current.ref.host}: ${reason}` } }, now().toISOString());
        return sendError(response, 400, "WRITE_REFUSED", reason);
      }
      // The re-read into the store.
      return written(response, { work: current.ref, shared: "shared", conflict: false });
    }
    try {
      const done = await write!.editWork!(current.ref, patch);
      const logged = write!.appendLog ? await write!.appendLog(done.work, { kind: "edited", by: by(), fields: { changed } }) : done;
      return written(response, logged);
    } catch (error) {
      return sendError(response, 400, "WRITE_REFUSED", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * `{ ref, text, supersedes }`: settles an item in conflict. `text` is the item's whole text as the
   * person chose or wrote it; `supersedes` names the versions put aside that a person saw, so a
   * version that came in since stays.
   */
  async function resolve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const write = items?.write;
    if (!write?.resolveConflict) return sendError(response, 403, "READ_ONLY", "Conflicts cannot be settled here: the project's host is read-only.");
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const supersedes = list(body.supersedes);
    if (typeof body.ref !== "string" || typeof body.text !== "string" || body.text.trim() === "" || supersedes === null || supersedes.length === 0) {
      return sendError(response, 400, "BAD_FIELD", 'Give { "ref": "host:work:id", "text": "the item\'s text", "supersedes": ["version ids"] }.');
    }
    const current = loadSnapshot(store).works.find((work) => refKey(work.ref) === body.ref);
    if (!current || current.ref.host !== items!.host) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${body.ref} that can be edited here.`);
    try {
      const done = await write.resolveConflict(current.ref, body.text, supersedes);
      const logged = write.appendLog ? await write.appendLog(done.work, { kind: "edited", by: by(), fields: { changed: ["the text, settling a conflict"] } }) : done;
      return written(response, { ...logged, conflict: done.conflict });
    } catch (error) {
      return sendError(response, 400, "WRITE_REFUSED", error instanceof Error ? error.message : String(error));
    }
  }

  /** A change to the safe fields of the configuration file. 400 with the errors, and the file left as it was, when refused. */
  async function changeConfig(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (options.configFile === undefined) return sendError(response, 404, "NO_CONFIG", "There is no project configuration: Scope Soup runs as a board only.");
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const person = picked();
    // A switch to multiplayer whose remote names another project or host: the person's choice, "join" or "mine" (decision 98).
    const { players, ...change } = body;
    // Join theirs replaces this clone's Items: not while an agent works on them, here or (by its claims) elsewhere.
    if (players === "join") {
      const snapshot = loadSnapshot(store);
      const busy = busyMachines(snapshot.works, snapshot.sessions, options.machine, now());
      if (busy.length > 0) return sendJson(response, 400, { error: { code: "CONFIG_REFUSED", message: busyText(busy, "Join theirs") }, errors: [busyText(busy, "Join theirs")] });
    }
    const result = await editConfig(options.configFile, change, { ...configOptions, ...(person ? { by: person } : {}), ...(players === "join" || players === "mine" ? { players } : {}) });
    if (!result.ok) {
      return sendJson(response, result.status, { error: { code: result.status === 409 ? "PLAYERS_DIFFER" : result.status === 400 ? "CONFIG_REFUSED" : "CONFIG_WRITE_FAILED", message: result.errors.join(" ") }, errors: result.errors, ...("players" in result ? { players: result.players } : {}) });
    }
    let saved: string | undefined;
    if (result.changed) {
      const at = now().toISOString();
      const by = picked() ?? "board";
      // A level change carries the level it came from and went to. A shared change carries its meta commit and
      // what it changed; it is in effect now.
      store.appendEvent({ kind: "config.changed", actor: by, data: { via: "board", fields: Object.keys(change), ...(players === "join" || players === "mine" ? { players } : {}), ...(result.level ? { level: result.level } : {}), ...(result.shared ? { shared: { commit: result.shared.commit, changes: result.shared.changes } } : {}) } }, at);
      if (result.shared) saved = sharedSavedText(result.shared, by);
      options.onConfigChanged?.();
    }
    return sendJson(response, 200, { changed: result.changed, ...(saved ? { shared: saved } : {}), ...readConfigView(options.configFile, configOptions) });
  }

  /**
   * Settings' "Connect to GitHub Issues" / "Connect to Jira" (#127, decision 98). Without `confirm` it only says what connecting
   * would do, or why it cannot: the configuration checked as a whole, the token from the environment, one look at the host, no
   * agent session running on any machine; from the meta branch it lists the open Items to tick (`move`). With `confirm` and nothing
   * in the way it moves the ticked Items, then writes the shared `host` (one meta commit) and this machine's part. `mode: "join"`
   * sets this machine up for the host the project already has ("Set up this machine"): only this machine's part is written.
   */
  async function connect(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (options.configFile === undefined) return sendError(response, 404, "NO_CONFIG", "There is no project configuration: Scope Soup runs as a board only.");
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const view = readConfigView(options.configFile, configOptions);
    const current = view.present ? view.config?.host : undefined;
    const join = body.mode === "join";
    const given = join ? (current ? joinConnection(current, body) : { ok: false as const, error: "The project has no host in its settings to set this machine up for." }) : connectionOf(body);
    if (!given.ok) return sendError(response, 400, "BAD_FIELD", given.error);
    const { connection } = given;
    const person = picked();
    const editOptions = { ...configOptions, ...(person ? { by: person } : {}), join };
    if (given.kind === "metaBranch") return toMetaBranch(response, body, join, connection, current, person);
    const kind = given.kind;
    const deps = options.connect ?? { env: process.env };
    const host = connection.host;
    const target = kind === "github" ? `GitHub Issues (${String(host.repo)})` : `Jira (project ${String(host.project)})`;
    const snapshot = loadSnapshot(store);
    // From another host only through the meta branch: GitHub and Jira are not connected to each other (decision 98).
    const across = !join && (current?.kind === "github" || current?.kind === "jira") && current.kind !== kind;
    const busy = join ? [] : busyMachines(snapshot.works, snapshot.sessions, options.machine, now());
    // The open Items a person may tick to move: from the meta branch only.
    const fromMeta = !join && current?.kind === "metaBranch" && items ? items : undefined;
    const open = fromMeta ? snapshot.works.filter((work) => work.ref.host === fromMeta.host && work.state !== "done" && work.state !== "abandoned") : [];
    const ticked = new Set(Array.isArray(body.move) ? body.move.filter((id): id is string => typeof id === "string") : []);
    const moving = open.filter((work) => ticked.has(work.ref.id));
    const checked = across ? null : await connectHost(options.configFile, connection, { ...editOptions, dryRun: true });
    const looked = checked?.ok ? await lookAtHost(kind, connection, deps) : { problems: [], lines: [] };
    const problems = [
      ...(across ? [`The project's host is ${hostWhere(current)}. Going from there to ${HOST_NAME[kind]} goes through the meta branch: "Move back to the meta branch" first, then Connect.`] : []),
      ...(checked && !checked.ok ? checked.errors : looked.problems),
      ...(busy.length > 0 ? [busyText(busy, "Connecting")] : []),
      ...(moving.length > 0 && host.write !== true ? ['Moving Items needs writes on: tick "Let Scope Soup write", or move none.'] : []),
    ];
    const stay = open.length - moving.length;
    const lines = join
      ? [
        ...looked.lines,
        ...(connection.email !== undefined ? [`Writes jira.email (${connection.email}) to this machine's scopesoup.config.json; the project's shared settings stay as they are.`] : []),
        "Start Scope Soup again on this machine: it reads the host, and starts agents, only then.",
      ]
      : [
        ...looked.lines,
        `Sets the project's host to ${target}${host.write ? ", with writes on" : ", read-only"}: one commit to the shared settings on refs/scopesoup/meta${person ? `, named after ${person}` : ""}, for every machine.`,
        ...(connection.email !== undefined ? [`Writes jira.email (${connection.email}) to this machine's scopesoup.config.json, next to its other hosts' parts.`] : []),
        ...(moving.length > 0 ? [`Moves ${moving.length} Item(s) to ${target}: ${moving.map((work) => work.ref.id).join(", ")}. Each becomes a new issue with its title, description and verification, ending with a line naming its old id; references between them get the new ids; its history goes there as one comment; the old Item is closed on the meta branch, saying where it went.`] : []),
        ...(fromMeta ? [stay > 0 ? `The other ${stay} open Item(s) stay on the meta branch, readable there; the board shows ${target} only.` : moving.length > 0 ? "No open Item stays behind." : "There are no open Items to move."] : []),
        `Each other machine keeps its own settings: its board asks "Set up this machine for ${HOST_NAME[kind]}" until it has ${kind === "jira" ? `SCOPESOUP_JIRA_TOKEN${host.deployment === "datacenter" ? "" : " and its person's Jira email"}` : "SCOPESOUP_GITHUB_TOKEN"}, and starts no agent until then.`,
        "The new host is read when Scope Soup starts again: restart it after connecting.",
      ];
    const listed = fromMeta ? { items: open.map((work) => ({ id: work.ref.id, title: work.title })) } : {};
    if (body.confirm !== true) return sendJson(response, 200, { problems, lines, ...listed });
    if (problems.length > 0) return sendJson(response, 400, { error: { code: "CONNECT_REFUSED", message: problems.join(" ") }, problems, lines, ...listed });
    let moved: MoveReport | undefined;
    if (moving.length > 0 && fromMeta) {
      const token = deps.env[TOKEN_VARIABLE[kind]] ?? "";
      const outside = new Map<string, string>();
      const to = hostFor(kind, connection, token, deps, options.machine, { onOutside: (key, reason) => outside.set(key, reason) });
      // Issues an earlier run made are found by their marker in the whole project, whatever the filter says.
      const find = kind === "jira" && typeof host.filter === "string" ? hostFor(kind, connection, token, deps, options.machine, { unfiltered: true }).work : undefined;
      // No new session starts on this machine while the Items move; the switches are put back as they were after.
      const actor = person ?? "board";
      const paused = pauseRemembering(store, now().toISOString(), "connect", actor);
      try {
        moved = await moveItems({
          kind, items: moving, all: snapshot.works.filter((work) => work.ref.host === fromMeta.host), from: fromMeta.write, to, ...(find ? { find } : {}), by: actor,
          // Made now: the host said so while making it. Found again: read through the filter, as the board would.
          outside: async (made) => outside.get(made.id) ?? (find && (await to.work!.getWork(made)) === null ? `falls outside host.filter (${String(host.filter)}): Scope Soup would not read, show or touch it.` : undefined),
          beforeClose: () => {
            const fresh = loadSnapshot(store);
            const still = busyMachines(fresh.works, fresh.sessions, options.machine, now());
            return still.length > 0 ? busyText(still, "Closing the old Items") : undefined;
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return sendJson(response, 400, { error: { code: "MOVE_REFUSED", message }, problems: [message], lines, ...listed });
      } finally {
        startAgain(store, paused, now().toISOString(), "connect", actor);
      }
      store.appendEvent({ kind: "items.moved", actor: person ?? "board", data: { to: kind, rows: moved.rows, ...(moved.failed ? { failed: moved.failed } : {}) } }, now().toISOString());
      // Not connected while a ticked Item is not moved: running it again finishes the move, making nothing twice.
      if (moved.failed) return sendJson(response, 500, { error: { code: "MOVE_FAILED", message: moveLines(moved).join(" ") }, problems: moveLines(moved), lines, ...listed });
    }
    return connected(response, connection, editOptions, { kind, join, person, lines, ...(moved ? { moved: moveLines(moved) } : {}) });
  }

  /** The last step of a connect, a move back or a set-up: the host and this machine's part written, once everything moved. */
  async function connected(response: ServerResponse, connection: HostConnection, editOptions: EditOptions & { join: boolean }, done: { kind: HostKind; join: boolean; person: string | undefined; lines: string[]; moved?: string[] }): Promise<void> {
    const { kind, join, person, lines, moved } = done;
    const result = await connectHost(options.configFile!, connection, editOptions);
    if (!result.ok) return sendJson(response, result.status, { error: { code: "CONNECT_REFUSED", message: result.errors.join(" ") }, problems: result.errors, lines, ...(moved ? { moved } : {}) });
    let saved: string | undefined;
    if (result.changed) {
      const by = person ?? "board";
      const fields = join ? [kind === "jira" ? "jira" : "meta"] : ["host", ...(connection.meta ? ["meta"] : [])];
      store.appendEvent({ kind: "config.changed", actor: by, data: { via: "board", fields, connect: kind, ...(join ? { join: true } : {}), ...(result.shared ? { shared: { commit: result.shared.commit, changes: result.shared.changes } } : {}) } }, now().toISOString());
      if (result.shared) saved = sharedSavedText(result.shared, by);
      options.onConfigChanged?.();
    }
    return sendJson(response, 200, { done: true, problems: [], lines, ...(moved ? { moved } : {}), ...(saved ? { shared: saved } : {}), ...readConfigView(options.configFile!, configOptions) });
  }

  /**
   * Settings' "Move back to the meta branch" (#134, decision 99), and "Set up this machine" for a project on the meta branch. Without
   * `confirm` it says what it would do: this machine's meta part checked, the old host's open issues listed to tick (`move`), no agent
   * session on any machine. With `confirm` the ticked issues move (`src/items/moveToMeta.ts`), and only once every one moved the shared
   * `host` becomes the meta branch (one meta commit) and this machine's `meta` part is written; the old host's part stays beside it.
   */
  async function toMetaBranch(response: ServerResponse, body: Record<string, unknown>, join: boolean, connection: HostConnection, current: HostConfig | undefined, person: string | undefined): Promise<void> {
    const editOptions = { ...configOptions, ...(person ? { by: person } : {}), join };
    const meta = connection.meta;
    const prefix = meta?.prefix || "?";
    const part = `this machine's meta part (commits as ${meta?.authorName || "?"} <${meta?.authorEmail || "?"}>, Item ids ${prefix}-1, ${prefix}-2, ...)`;
    const checked = await connectHost(options.configFile!, connection, { ...editOptions, dryRun: true });
    const problems = [...metaPartProblems(meta), ...(checked.ok ? [] : checked.errors)];
    if (join) {
      const lines = [`Writes ${part} to this machine's scopesoup.config.json; the project's shared settings stay as they are.`, "Start Scope Soup again on this machine: it reads the meta branch, and starts agents, only then."];
      if (body.confirm !== true) return sendJson(response, 200, { problems, lines });
      if (problems.length > 0) return sendJson(response, 400, { error: { code: "CONNECT_REFUSED", message: problems.join(" ") }, problems, lines });
      return connected(response, connection, editOptions, { kind: "metaBranch", join, person, lines });
    }
    const from = current?.kind === "github" || current?.kind === "jira" ? current : undefined;
    if (!from) problems.push(current?.kind === "metaBranch" ? "The project's Items are on the meta branch already." : "The project's host is set by the environment: there is nothing to move back from.");
    const deps = options.connect ?? { env: process.env };
    const variable = from ? TOKEN_VARIABLE[from.kind] : undefined;
    const token = variable ? deps.env[variable] : undefined;
    const snapshot = loadSnapshot(store);
    const busy = busyMachines(snapshot.works, snapshot.sessions, options.machine, now());
    if (busy.length > 0) problems.push(busyText(busy, "Moving back"));
    const where = from ? hostWhere(from) : "";
    const lines: string[] = [];
    let source: MoveSource | undefined;
    let open: { id: string; title: string }[] = [];
    let unread = false;
    if (from && token) {
      try {
        source = sourceOf(from, token, deps, options.machine);
        open = await source.list();
        lines.push(`${variable} is set and reads ${open.length} open issue(s) of ${where}.`);
      } catch (error) {
        unread = true;
        source = undefined;
        problems.push(`${where} could not be read with the token in ${variable}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (from) lines.push(`${variable} is not set in the environment Scope Soup was started in, so the open issues of ${where} cannot be listed and none can move. Set it and start Scope Soup again to move some.`);
    const ticked = new Set(Array.isArray(body.move) ? body.move.filter((id): id is string => typeof id === "string") : []);
    const moving = open.filter((issue) => ticked.has(issue.id));
    const close = body.close === true;
    if (moving.length > 0 && from && !from.write) problems.push(`${where} is read-only here (host.write is false), so its issues cannot be told where they went: move none, or connect it with writes on first.`);
    if (moving.length > 0 && !options.metaBranch) problems.push("This Scope Soup cannot write the meta branch here, so nothing can move.");
    const hostName = from?.kind === "jira" ? "Jira" : "GitHub";
    const marked = close ? (from?.kind === "jira" ? "closed there" : "closed there as not planned") : from?.kind === "github" ? "left open, labelled moved-to-scopesoup" : "left open";
    const stay = open.length - moving.length;
    lines.push(
      `Sets the project's host to the meta branch (refs/scopesoup/meta), with writes on: one commit to the shared settings${person ? `, named after ${person}` : ""}, for every machine.`,
      `Writes ${part} to this machine's scopesoup.config.json, next to its other hosts' parts.`,
      ...(moving.length > 0
        ? [
          `Moves ${moving.length} issue(s) to the meta branch: ${moving.map((issue) => issue.id).join(", ")}. All become Items in one meta commit, with their title, description and verification; references between them get the new ids (not in code or addresses); each issue's comments go to its Item's log as one line.`,
          `Then each gets a comment on ${hostName} naming its new Item and is ${marked}.`,
        ]
        : []),
      ...(source && !unread ? [stay > 0 ? `The other ${stay} open issue(s) stay on ${where}, readable there; the board shows the meta branch only.` : moving.length > 0 ? "No open issue stays behind." : "There are no open issues to move."] : []),
      `Each other machine keeps its own settings: its board asks "Set up this machine for the meta branch" until it has its own meta part (name, email, id prefix), and starts no agent until then.`,
      "The new host is read when Scope Soup starts again: restart it after moving back.",
    );
    const listed = source ? { items: open } : {};
    if (body.confirm !== true) return sendJson(response, 200, { problems, lines, ...listed });
    if (problems.length > 0) return sendJson(response, 400, { error: { code: "CONNECT_REFUSED", message: problems.join(" ") }, problems, lines, ...listed });
    let moved: MoveBackReport | undefined;
    if (moving.length > 0 && source && from && meta && options.metaBranch) {
      const target = options.metaBranch(meta);
      const actor = person ?? "board";
      // No new session starts on this machine while the Items move; the switches are put back as they were after.
      const paused = pauseRemembering(store, now().toISOString(), "connect", actor);
      try {
        const items = await source.read(moving.map((issue) => issue.id));
        moved = await moveBack({
          kind: from.kind, items, to: target, from: source.old, close, by: actor,
          beforeClose: () => {
            const fresh = loadSnapshot(store);
            const still = busyMachines(fresh.works, fresh.sessions, options.machine, now());
            return still.length > 0 ? busyText(still, "Marking the old issues") : undefined;
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return sendJson(response, 400, { error: { code: "MOVE_REFUSED", message }, problems: [message], lines, ...listed });
      } finally {
        startAgain(store, paused, now().toISOString(), "connect", actor);
        await target.stop?.().catch(() => undefined);
      }
      store.appendEvent({ kind: "items.moved", actor, data: { from: from.kind, to: "metaBranch", rows: moved.rows, ...(moved.failed ? { failed: moved.failed } : {}) } }, now().toISOString());
      // Not switched while a ticked issue is not moved: running it again finishes the move, making nothing twice.
      if (moved.failed) return sendJson(response, 500, { error: { code: "MOVE_FAILED", message: moveBackLines(moved).join(" ") }, problems: moveBackLines(moved), lines, ...listed });
    }
    return connected(response, connection, editOptions, { kind: "metaBranch", join, person, lines, ...(moved ? { moved: moveBackLines(moved) } : {}) });
  }

  /** What this machine lacks for the project's host (decision 98), for the board's "Set up this machine" note; null when nothing. */
  function setupNow(): { setup: MachineSetup; host: Record<string, unknown> } | null {
    if (!options.machineSetup) return null;
    const host = options.configFile === undefined ? undefined : readConfigView(options.configFile, configOptions);
    const shared = host?.present ? host.config?.host : undefined;
    if (!shared) return null;
    const { email: _own, authorName: _name, authorEmail: _email, prefix: _prefix, repoPath: _path, ...shown } = shared as Record<string, unknown>;
    return { setup: options.machineSetup, host: shown };
  }

  /** The project now, or null when there is none or it cannot be read. */
  const projectNow = (): ProjectInfo | null => {
    try {
      return options.project?.() ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Opens one of the project's folders in the file manager. The body names the folder (`{ folder: "checkout" | "clone" |
   * "config" }`) and nothing else: the path is the configuration's, never one the page sends.
   */
  async function openProjectFolder(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const extra = Object.keys(body).filter((key) => key !== "folder");
    if (extra.length > 0) return sendError(response, 400, "BAD_FOLDER", `Only folder is read (a name: checkout, clone or config); a path is never taken from the page. Not read: ${extra.join(", ")}.`);
    const name = body.folder;
    if (!isFolderName(name)) return sendError(response, 400, "BAD_FOLDER", "folder must be checkout, clone or config.");
    const project = projectNow();
    if (!project) return sendError(response, 404, "NO_CONFIG", "There is no project configuration, so there is no folder to open.");
    const path = project.folders[name];
    if (path === undefined) return sendError(response, 404, "NO_FOLDER", name === "checkout" ? "The configuration names no checkout of your own: set ownClone (or realPaths) in scopesoup.config.json." : `The configuration names no ${name} folder.`);
    if (!isFolder(path)) return sendError(response, 404, "FOLDER_MISSING", `${path} is not a folder on this machine.`);
    try {
      await (options.openFolder ?? openFolder)(path);
    } catch (error) {
      return sendError(response, 500, "OPEN_FAILED", `Could not start the file manager on ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return sendJson(response, 200, { opened: name, path });
  }

  /**
   * Opens an Item's change, or one file of it, in the person's diff tool on this machine. The body is `{ ref, file? }` and nothing
   * else: no command, no path, no tool. Only from this machine (the socket and the Host header are loopback, also when the server
   * listens on the LAN), because it starts a program with a window.
   */
  async function openDiff(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const hostName = (request.headers.host ?? "").replace(/:\d+$/, "");
    if (!isLoopback(request.socket.remoteAddress?.replace(/^::ffff:/i, "") ?? "") || !isLoopback(hostName)) {
      return sendError(response, 403, "NOT_LOCAL", "A diff tool opens only from the machine Scope Soup runs on.");
    }
    const extra = Object.keys(body).filter((key) => key !== "ref" && key !== "file");
    if (extra.length > 0) return sendError(response, 400, "BAD_BODY", `Only ref and file are read. Not read: ${extra.join(", ")}.`);
    if (typeof body.ref !== "string" || body.ref === "") return sendError(response, 400, "REF_MISSING", "Give the item as ref: host:work:id.");
    if (body.file !== undefined && (typeof body.file !== "string" || body.file === "")) return sendError(response, 400, "BAD_FILE", "file must be a path from the change's file list.");
    const page = buildItemPage(loadSnapshot(store), body.ref, now(), undefined, self());
    if (!page) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${body.ref}.`);
    if (!options.openDiff) return sendError(response, 404, "NO_CONFIG", "This server has no project configuration, so it has no clones to open a diff in.");
    const file = body.file;
    const opened = await options.openDiff(page.item.ref, file);
    if (!opened.ok) return sendError(response, opened.status, opened.code, opened.message);
    store.appendEvent({ kind: "person.opened_diff", subject: refKey(page.item.ref), actor: picked() ?? "board", data: { reason: `${picked() ?? "Someone"} opened ${file ?? "the change"} of ${page.item.ref.id} in the diff tool (${opened.tool}).`, tool: opened.tool, ...(file !== undefined ? { file } : {}) } }, now().toISOString());
    return sendJson(response, 200, { opened: true, tool: opened.tool, ...(file !== undefined ? { file } : {}) });
  }

  /**
   * The overview's one line at level 0: how many ready Items have no triage. With a project configuration only
   * (board-only mode runs no sessions), and only at level 0.
   */
  const withoutTriageNow = (snapshot: ReturnType<typeof loadSnapshot>): number => {
    if (options.configFile === undefined || (options.planning?.().level ?? 0) !== 0) return 0;
    return countWithoutTriage(snapshot.works, snapshot.changes, loadJobs(store), now().toISOString());
  };

  /** The POST endpoints that record who did it; the board names its picked person, or the request is refused. */
  const NEEDS_PERSON = new Set(["/api/answer", "/api/answers", "/api/proposal", "/api/draft", "/api/start-over", "/api/chat", "/api/decisions", "/api/item/edit", "/api/item/vote", "/api/item/resolve", "/api/item/media/delete", "/api/item-draft"]);

  /** The Item a request names by its key, as the store has it. */
  const workByKey = (key: string): WorkItem | undefined => loadSnapshot(store).works.find((work) => refKey(work.ref) === key);

  /** `GET /media/<item key>/<name>`: one image, as the image it is and nothing else (no sniffing, no script, no frame). */
  async function serveMedia(path: string, response: ServerResponse, headOnly: boolean): Promise<void> {
    const parts = path.slice("/media/".length).split("/");
    let key = "";
    try {
      key = decodeURIComponent(parts[0] ?? "");
    } catch {
      key = "";
    }
    const work = parts.length === 2 ? workByKey(key) : undefined;
    const found = work && options.media ? await options.media.read(work.ref, parts[1]!).catch(() => null) : null;
    if (!found) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      response.end("No such image.\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": found.type,
      "Content-Length": String(found.bytes.length),
      "X-Content-Type-Options": "nosniff",
      // Opened on its own (an SVG above all): nothing it holds may run, load or be framed.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      "Content-Disposition": "inline",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "private, no-cache",
    });
    response.end(headOnly ? undefined : found.bytes);
  }

  /** Drafts being approved now: a second click waits for the first instead of making a second Item. */
  const approving = new Set<string>();

  /**
   * A person approves or denies an Item draft (decision 95): `{ id, action, title?, description?, verification? }` (`src/server/drafts.ts`).
   * Approve makes the Item on the source Item's host and brings the store up to date; a host that refuses leaves the draft open.
   */
  async function itemDraft(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, 400, "BAD_BODY", error instanceof Error ? error.message : "The body is not JSON.");
    }
    const given = draftRequest(body);
    if (typeof given === "string") return sendError(response, 400, "BAD_FIELD", given);
    if (approving.has(given.id)) return sendError(response, 409, "APPROVING", "This draft is being approved now.");
    approving.add(given.id);
    try {
      const done = await decideItemDraft(store, options.restructure ?? [], given, by().who, () => now().toISOString(), options.syncNow, options.aiLabel?.());
      if (!done.ok) return sendError(response, done.status, done.code, done.message);
      if (done.outcome) return written(response, done.outcome, done.message);
      return sendJson(response, 200, { message: done.message, ...(done.item ? { ref: refKey(done.item) } : {}) });
    } catch (error) {
      store.appendEvent({ kind: "orchestrator.host_write_failed", actor: by().who, data: { reason: `Could not file the Item from draft ${given.id}: ${error instanceof Error ? error.message : String(error)}` } }, now().toISOString());
      return sendError(response, 502, "WRITE_REFUSED", error instanceof Error ? error.message : String(error));
    } finally {
      approving.delete(given.id);
    }
  }

  /** `POST /api/item/media/delete` with `{ ref, name }`: the image goes here and, when it was pushed, from the media ref. */
  async function deleteMedia(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const ref = typeof body.ref === "string" ? body.ref : "";
    const name = typeof body.name === "string" ? body.name : "";
    const work = workByKey(ref);
    if (!work) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${ref}.`);
    if (!options.media) return sendError(response, 404, "NO_MEDIA", "This server keeps no images.");
    const result = await options.media.remove(work.ref, name, picked() ?? "board");
    if (!result.removed) return sendError(response, 404, "MEDIA_NOT_FOUND", `No image ${name} on ${work.ref.id}.`);
    // Gone here, but the remote's ref still has it: the page says so; Scope Soup tries again every hour.
    if (result.ref === "failed") return sendError(response, 502, "MEDIA_STILL_ON_REMOTE", `Deleted here, but still on the remote: ${result.problem ?? "the remote could not be updated"}. Scope Soup tries again every hour.`);
    return sendJson(response, 200, result);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const person = readPersonHeader(request.headers[PERSON_HEADER]);
    if (typeof person === "object") return sendError(response, 400, "BAD_PERSON", person.problem);
    return requestPerson.run(person, () => route(request, response));
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      if (method === "POST") {
        if (!sameOrigin(request)) return sendError(response, 403, "CROSS_ORIGIN", "Requests from another origin are refused.");
        if (NEEDS_PERSON.has(path) && !picked()) {
          request.resume();
          return sendError(response, 400, "PERSON_MISSING", "Pick who you are at the top of the board first: the answer records who gave it.");
        }
        if (path === "/api/answer") return answer(request, response);
        if (path === "/api/answers") return answers(request, response);
        if (path === "/api/proposal") return proposal(request, response);
        if (path === "/api/draft") return draft(request, response);
        if (path === "/api/item-draft") return itemDraft(request, response);
        if (path === "/api/start-over") return startOver(request, response);
        if (path === "/api/chat") return chatSend(request, response);
        if (path === "/api/items") return createItem(request, response);
        if (path === "/api/decisions") return settleDecisions(request, response);
        if (path === "/api/item/edit") return editItem(request, response);
        if (path === "/api/item/vote") return vote(request, response);
        if (path === "/api/item/resolve") return resolve(request, response);
        if (path === "/api/item/media/delete") return deleteMedia(request, response);
        if (path === "/api/item/claim") return person(request, response, "claim");
        if (path === "/api/item/handback") return person(request, response, "handback");
        if (path === "/api/item/release") return person(request, response, "release");
        if (path === "/api/config") return changeConfig(request, response);
        if (path === "/api/connect") return connect(request, response);
        if (path === "/api/open-folder") return openProjectFolder(request, response);
        if (path === "/api/open-diff") return openDiff(request, response);
        request.resume();
        // Each switch on its lane: /api/{triage,implement,review,merge-queue}/{start,pause}; /api/agents/... is the three roles at once.
        const switched = /^\/api\/(triage|implement|review|merge-queue|agents)\/(start|pause)$/.exec(path);
        if (switched) return sendJson(response, 200, control(`${switched[1] === "merge-queue" ? "mergeQueue" : switched[1] as "triage" | "implement" | "review" | "agents"}.${switched[2] as "start" | "pause"}`, "board"));
        if (path === "/api/stop") return sendJson(response, 200, control("stop", "board"));
        // The old stop switch, kept for scripts: pause pauses all four switches (running sessions finish their step);
        // resume resumes all four. Stop is the one that ends sessions.
        if (path === "/api/pause") return sendJson(response, 200, control("pause", "/api/pause"));
        if (path === "/api/resume") return sendJson(response, 200, control("resume", "/api/resume"));
        if (path === "/api/queue/resume") {
          const asked = requestQueueResume(store, now().toISOString(), picked() ?? "board");
          return asked.ok ? sendJson(response, 200, { requested: true }) : sendError(response, 409, "QUEUE_NOT_PAUSED", asked.reason);
        }
        if (path === "/api/branch-protection/dismiss") {
          options.branchProtection?.dismiss();
          return sendJson(response, 200, { warning: null });
        }
        if (path.startsWith("/api/upgrade/")) {
          const upgrade = options.upgrade;
          if (!upgrade) return sendError(response, 404, "NO_UPGRADE", "This server has no upgrade.");
          if (path === "/api/upgrade/check") return sendJson(response, 200, await upgrade.check());
          if (path === "/api/upgrade/get") return sendJson(response, 202, upgrade.getLatest());
          if (path === "/api/upgrade/back") return sendJson(response, 202, upgrade.goBack());
          if (path === "/api/upgrade/cancel") return sendJson(response, 200, upgrade.cancel());
          if (path === "/api/upgrade/dismiss") return sendJson(response, 200, upgrade.dismissNote());
        }
        if (path === "/api/refresh") {
          options.onRefresh?.();
          return sendJson(response, 202, { accepted: true });
        }
        return sendError(response, 404, "NOT_FOUND", `No such endpoint: POST ${path}`);
      }
      if (method !== "GET") {
        response.setHeader("Allow", "GET, POST");
        return sendError(response, 405, "METHOD_NOT_ALLOWED", `${method} is not supported.`);
      }
      if (path === "/api/events") return streams.open(request, response, url);
      if (path === "/api/board") {
        const snapshot = loadSnapshot(store);
        const without = withoutTriageNow(snapshot);
        const project = projectNow();
        return sendJson(response, 200, { ...boardNow(), ...(project ? { project: projectView(project) } : {}), canWrite: items?.write.createWork !== undefined, ...((drafts) => (drafts.length > 0 ? { drafts } : {}))(draftViews(store, snapshot.works, options.restructure ?? [])), people: knownPeople(snapshot.works, loadAnswers(store), options.jiraItems?.host), ...(Object.keys(peopleNames(snapshot.works, options.jiraItems?.host)).length > 0 ? { peopleNames: peopleNames(snapshot.works, options.jiraItems?.host) } : {}), ...(without > 0 ? { withoutTriage: without } : {}) });
      }
      if (path === "/api/items") return sendJson(response, 200, (({ snapshot, notTriaged }) => buildItemList(snapshot, parseListQuery(url.searchParams), now(), picked(), notTriaged))(triageView()));
      // The item commands' list: who holds what, as one person sees it (`?as=name`).
      if (path === "/api/item/rows") {
        const who = url.searchParams.get("as")?.trim();
        if (!items?.work || !who) return sendError(response, 400, "BAD_FIELD", "Give ?as=<the person>; the items need a host that can be read here.");
        const backend: Backend = { kind: "metaBranch", host: items.host, ...(options.machine ? { machine: options.machine } : {}), who, work: items.work, write: items.write, now, mainBranch: "main" };
        const search = url.searchParams.get("search")?.trim();
        const rows = await listItems(backend, { mine: url.searchParams.has("mine"), free: url.searchParams.has("free"), all: url.searchParams.has("all"), ...(search ? { search } : {}) });
        return sendJson(response, 200, { rows });
      }
      // Whether the Item's branch is on the remote now, so the Item page shows the right command to start working.
      if (path === "/api/item/branch") {
        const id = url.searchParams.get("id")?.trim();
        if ((!items && !options.jiraItems) || !id) return sendError(response, 400, "BAD_FIELD", "Give ?id=<the item>; the items need a host that can be written here.");
        let branch: string;
        try {
          branch = workBranch(holdHost(id) === "jira" ? itemRefOn({ kind: "jira", host: options.jiraItems!.host }, id) : itemRef(id));
        } catch (error) {
          return sendError(response, 400, "BAD_FIELD", error instanceof Error ? error.message : String(error));
        }
        if (!options.branches) return sendJson(response, 200, { branch, problem: "Scope Soup cannot read the project's remote here." } satisfies ItemBranchState);
        try {
          return sendJson(response, 200, { branch, onRemote: await options.branches.exists(branch) } satisfies ItemBranchState);
        } catch (error) {
          return sendJson(response, 200, { branch, problem: error instanceof Error ? error.message : String(error) } satisfies ItemBranchState);
        }
      }
      // The item commands' show: one item in full.
      if (path === "/api/item/show") {
        const id = url.searchParams.get("id")?.trim();
        if (!items?.work || !id) return sendError(response, 400, "BAD_FIELD", "Give ?id=<the item>; the items need a host that can be read here.");
        const backend: Backend = { kind: "metaBranch", host: items.host, who: url.searchParams.get("as")?.trim() || "someone", work: items.work, write: items.write, now, mainBranch: "main" };
        try {
          return sendJson(response, 200, { item: await itemDetails(backend, id) });
        } catch (error) {
          if (error instanceof Refused) return sendError(response, 404, "REFUSED", error.message);
          throw error;
        }
      }
      if (path === "/api/chat") {
        const ref = url.searchParams.get("ref");
        if (!ref) return sendError(response, 400, "REF_MISSING", "Give the item as ?ref=host:work:id.");
        if (!loadSnapshot(store).works.some((work) => refKey(work.ref) === ref)) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${ref}.`);
        if (!options.chat) return sendJson(response, 200, { now: now().toISOString(), sessions: [], blocked: "This server has no project configuration, so it runs no sessions." });
        return sendJson(response, 200, options.chat.view(ref));
      }
      // One session's details behind its row in the Rounds table.
      if (path === "/api/session") {
        const id = url.searchParams.get("id")?.trim();
        if (!id) return sendError(response, 400, "BAD_FIELD", "Give the session as ?id=<Scope Soup's session id>.");
        const details = sessionDetails(store, id);
        if (!details) return sendError(response, 404, "SESSION_NOT_FOUND", `No session ${id} is kept here.`);
        return sendJson(response, 200, details);
      }
      if (path === "/api/status") return sendJson(response, 200, toStatusView(boardNow()));
      // For a service monitor: reads only the store's last event number, not the board.
      if (path === "/api/health") {
        // Which project this server serves: the item commands use a server only for their own project.
        const project = projectNow();
        return sendJson(response, 200, { ok: true, seq: store.lastSeq(), now: now().toISOString(), ...(project ? { project: { name: project.name, repository: project.repository } } : {}) });
      }
      if (path === "/api/config") return sendJson(response, 200, readConfigView(options.configFile, configOptions));
      // This machine's meta part too, which the meta branch's dialogs fill in (names and a prefix, nothing secret).
      if (path === "/api/machine-setup") return sendJson(response, 200, { ...(setupNow() ?? { setup: null }), ...(options.configFile ? { meta: metaPartOf(options.configFile) } : {}) });
      if (path === "/api/offboard") {
        if (!options.offboard) return sendJson(response, 200, { now: now().toISOString(), available: false, reason: "This server has no project configuration, so Scope Soup has left nothing for this project." });
        try {
          return sendJson(response, 200, await options.offboard());
        } catch (error) {
          return sendJson(response, 200, { now: now().toISOString(), available: false, reason: `The list could not be made: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      if (path === "/api/branch-protection") return sendJson(response, 200, { warning: (await options.branchProtection?.read()) ?? null });
      if (path === "/api/upgrade") {
        if (!options.upgrade) return sendError(response, 404, "NO_UPGRADE", "This server has no upgrade.");
        return sendJson(response, 200, options.upgrade.view());
      }
      if (path === "/api/activity") {
        let settings: SettingsLogEntry[] = [];
        try {
          settings = options.settingsLog?.() ?? [];
        } catch {
          // A settings' log that cannot be read leaves only its rows out.
        }
        return sendJson(response, 200, activityView(store, settings, now()));
      }
      if (path === "/api/settings/log") return sendJson(response, 200, { now: now().toISOString(), entries: options.settingsLog?.() ?? [] });
      if (path === "/api/diff") {
        const ref = url.searchParams.get("ref");
        if (!ref) return sendError(response, 400, "REF_MISSING", "Give the item as ?ref=host:work:id.");
        const page = buildItemPage(loadSnapshot(store), ref, now(), undefined, self());
        if (!page) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${ref}.`);
        if (!options.diff) return sendJson(response, 200, { now: now().toISOString(), available: false, reason: "This server has no project configuration, so it has no branches to show." });
        return sendJson(response, 200, await options.diff(page.item.ref));
      }
      if (path === "/api/usage") {
        const span = parseSpan(url.searchParams.get("span"));
        if (!span) return sendError(response, 400, "SPAN_INVALID", "Give the span as ?span=5h, 7d or <N>d with N from 1 to 30.");
        const snapshot = loadSnapshot(store);
        const plan = options.planning?.();
        if (plan?.plannedSessions !== undefined) snapshot.plannedSessions = plan.plannedSessions;
        return sendJson(response, 200, buildUsageView(store, snapshot, span, now(), plan?.reserve, plan?.allowances));
      }
      if (path === "/api/history") {
        if (!options.history) return sendJson(response, 200, { now: now().toISOString(), available: false, reason: "Commits show when Scope Soup runs with a project configuration; this board reads no repository." });
        const asked = url.searchParams.get("limit");
        return sendJson(response, 200, await options.history(asked === null ? Number.NaN : Number(asked)));
      }
      if (path === "/api/commit") {
        const sha = url.searchParams.get("sha") ?? "";
        if (!isSha(sha)) return sendError(response, 400, "SHA_INVALID", "Give the commit as ?sha=<hex id>.");
        if (!options.commit) return sendJson(response, 200, { now: now().toISOString(), available: false, reason: "Commits show when Scope Soup runs with a project configuration; this board reads no repository." });
        return sendJson(response, 200, await options.commit(sha));
      }
      if (path === "/api/item") {
        const ref = url.searchParams.get("ref");
        if (!ref) return sendError(response, 400, "REF_MISSING", "Give the item as ?ref=host:work:id.");
        const { snapshot, notTriaged } = triageView();
        let page = buildItemPage(snapshot, ref, now(), undefined, self(), notTriaged);
        if (!page) return sendError(response, 404, "ITEM_NOT_FOUND", `No item ${ref}.`);
        if (options.blocking && page.item.ref.host === options.blocking.host) {
          // One request; when it fails, the page shows what the store's items say.
          const blocking = await options.blocking.list(page.item.ref).catch(() => undefined);
          if (blocking) page = buildItemPage(snapshot, ref, now(), blocking, self(), notTriaged) ?? page;
        }
        const ours = items !== undefined && page.item.ref.host === items.host;
        if (ours && items.write.conflictVersions && page.item.hostState.includes("conflict:")) {
          const conflict = await items.write.conflictVersions(page.item.ref);
          if (conflict) page.conflict = conflict;
        }
        const backlogCard = boardNow().lanes.find((lane) => lane.lane === "backlog")?.cards.find((card) => card.key === ref);
        if (backlogCard?.why) page.why = backlogCard.why;
        if (backlogCard?.why && page.item.state !== "done" && page.item.state !== "abandoned" && (voteInStore(page.item.ref) || (ours && !!items.write.editWork))) {
          page.canVote = true;
          if (backlogCard.voteOff) page.voteOff = backlogCard.voteOff;
        }
        if (page.proposal?.parts) page.proposal.canCreate = restructureHost(page.item.ref) !== undefined;
        const onHost = options.hostEdit !== undefined && page.item.ref.host === options.hostEdit.host;
        if (assumptionHost(page.item.ref)) page.canSettle = true;
        const hold = ours || page.item.ref.host === options.jiraItems?.host ? await holdButtons(snapshot.works.find((each) => refKey(each.ref) === refKey(page.item.ref))) : undefined;
        // The Item's images, and whether everyone with the repository sees them (the page reminds the viewer).
        const images = options.media ? await options.media.list(page.item.ref).catch(() => []) : [];
        if (images.length > 0) page.media = { names: images, shared: options.media!.pushing() };
        return sendJson(response, 200, { ...page, canEdit: (ours && items.write.editWork !== undefined) || onHost, ...(hold ? { hold } : {}), states: onHost ? HOST_STATES : STATES });
      }
      return sendError(response, 404, "NOT_FOUND", `No such endpoint: GET ${path}`);
    }

    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return sendError(response, 405, "METHOD_NOT_ALLOWED", `${method} is not supported.`);
    }
    if (path.startsWith("/media/")) return serveMedia(path, response, method === "HEAD");
    if (options.staticDir && (await serveStatic(options.staticDir, path, response, method === "HEAD"))) return;
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(options.staticDir ? "Not found. Is the web app built? Run: pnpm web:build\n" : "Not found.\n");
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        const created = createHttpServer((request, response) => {
          handle(request, response).catch((error: unknown) => {
            if (response.headersSent) response.destroy();
            else sendError(response, 500, "INTERNAL", error instanceof Error ? error.message : String(error));
          });
        });
        created.once("error", reject);
        created.listen(options.port ?? DEFAULT_PORT, host, () => {
          server = created;
          const { port } = created.address() as AddressInfo;
          resolve({ host, port, url: `http://${host.includes(":") ? `[${host}]` : host}:${port}` });
        });
      });
    },

    stop() {
      streams.closeAll();
      const running = server;
      server = null;
      if (!running) return Promise.resolve();
      return new Promise((resolve) => {
        running.close(() => resolve());
        running.closeAllConnections();
      });
    },
  };
}
