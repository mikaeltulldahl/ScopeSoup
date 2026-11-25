// The server's HTTP API, and the live signal: any event on /api/events means "refetch".

import { useEffect, useRef, useState } from "preact/hooks";
import type { MergeQueueSetup, LevelChoice } from "../../src/config/levels.ts";
import type { Sliders } from "../../src/config/sliders.ts";
import type { ProjectConfig } from "../../src/config/types.ts";
import type { ActivityView, BoardView, ChatView, FolderName, CommitView, DiffView, HistoryView, ItemBranchState, ItemListView, ItemPage, SessionDetailsView, UsageView } from "../../src/core/views.ts";
import type { OriginalFate, ProposedPart } from "../../src/model/types.ts";
import { currentPerson, onPersonChange, personHeaders } from "./person.ts";
import type { PickEntry } from "./heldDecisions.ts";

export type { ProjectConfig };
export type { BoardView, DiffView, ItemPage };
export type * from "../../src/core/views.ts";
import type { SwitchPath } from "./switches.ts";

/** Every request names the board's picked person, so the server shows that person's "Your turn" and records who acted. */
function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, { ...init, headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), ...personHeaders() } });
}

/** The picked person, kept up to date when someone picks another at the top of the board. */
export function usePerson(): string {
  const [person, setState] = useState(currentPerson());
  useEffect(() => onPersonChange(setState), []);
  return person;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await call(path, { headers: { Accept: "application/json" } });
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  return body as T;
}

export const fetchBoard = () => getJson<BoardView>("/api/board");
/** The item list; `query` is the filters as a URL query string. */
export const fetchItems = (query: string) => getJson<ItemListView>(`/api/items${query ? `?${query}` : ""}`);
export const fetchItem = (key: string) => getJson<ItemPage>(`/api/item?ref=${encodeURIComponent(key)}`);
/** The files an item's branch changes, with their diffs as plain text. */
export const fetchDiff = (key: string) => getJson<DiffView>(`/api/diff?ref=${encodeURIComponent(key)}`);
/** The newest `limit` commits of the project, laid out as lanes. */
export const fetchHistory = (limit: number) => getJson<HistoryView>(`/api/history?limit=${limit}`);
/** What happened in the project, newest first: the History page's timeline. */
export const fetchActivity = () => getJson<ActivityView>("/api/activity");

/** One save of the shared settings, from their log on the meta ref: who changed what. */
export interface SettingsLogEntry {
  at: string;
  who: string;
  machine?: string;
  changes: { key: string; from?: unknown; to?: unknown }[];
}
export const fetchSettingsLog = () => getJson<{ now: string; entries: SettingsLogEntry[] }>("/api/settings/log");
/** Who used the usage windows over a span ("5h", "7d", "<N>d"). */
export const fetchUsage = (span: string) => getJson<UsageView>(`/api/usage?span=${encodeURIComponent(span)}`);
export const fetchCommit = (sha: string) => getJson<CommitView>(`/api/commit?sha=${encodeURIComponent(sha)}`);
/** The item's sessions a person can talk to, with the chat so far. */
export const fetchChat = (key: string) => getJson<ChatView>(`/api/chat?ref=${encodeURIComponent(key)}`);
/** One session's details: its record, the tools it called and what it did. */
export const fetchSession = (id: string) => getJson<SessionDetailsView>(`/api/session?id=${encodeURIComponent(id)}`);

/** One message to a session of the item. Resolves once the turn is started; the reply follows on `fetchChat`. */
export async function postChat(ref: string, session: string, message: string): Promise<void> {
  const response = await call("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, session, message }) });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  }
}

/** The offboarding plan for "Stop using Scope Soup", read only. */
export type { OffboardView } from "../../src/offboard/plan.ts";

export async function fetchOffboard(): Promise<import("../../src/offboard/plan.ts").OffboardView> {
  const response = await call("/api/offboard");
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  return (await response.json()) as import("../../src/offboard/plan.ts").OffboardView;
}

/** Scope Soup's version, the update check, Get latest and Go back. Null when the server has none (an older test server). */
export type UpgradeView = import("../../src/upgrade/view.ts").UpgradeView;

export async function fetchUpgrade(): Promise<UpgradeView | null> {
  const response = await call("/api/upgrade", { headers: { Accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  return (await response.json()) as UpgradeView;
}

/** The warning about an unprotected main branch on the GitHub remote; null when there is none (or the server has no such check). */
export type BranchProtectionWarning = import("../../src/server/branchProtection.ts").BranchProtectionWarning;

export async function fetchBranchProtection(): Promise<BranchProtectionWarning | null> {
  const response = await call("/api/branch-protection", { headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  return ((await response.json()) as { warning: BranchProtectionWarning | null }).warning;
}

export async function dismissBranchProtection(): Promise<void> {
  await call("/api/branch-protection/dismiss", { method: "POST" });
}

export async function postUpgrade(what: "check" | "get" | "back" | "cancel" | "dismiss"): Promise<UpgradeView> {
  const response = await call(`/api/upgrade/${what}`, { method: "POST" });
  const body = (await response.json().catch(() => null)) as (UpgradeView & { error?: { message?: string } }) | null;
  if (!response.ok || !body) throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  return body;
}

/** The switches (Resume/Pause on each lane, Stop) and Sync now. */
export type ControlPath = SwitchPath | "/api/stop";

export async function post(path: ControlPath | "/api/refresh"): Promise<void> {
  const response = await call(path, { method: "POST" });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
}

/** Opens one of the project's folders in the file manager on the server's machine. The page names it; the server knows the path. */
export async function postOpenFolder(folder: FolderName): Promise<void> {
  const response = await call("/api/open-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder }) });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  }
}

/** Opens an item's change, or one of its files, in the person's own diff tool on the server's machine. The page sends the item and a file of the diff, never a command. */
export async function postOpenDiff(ref: string, file?: string): Promise<void> {
  const response = await call("/api/open-diff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, ...(file === undefined ? {} : { file }) }) });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  }
}

/** Asks the next tick to let a queue that the engine paused go on. */
export async function postQueueResume(): Promise<void> {
  const response = await call("/api/queue/resume", { method: "POST" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  }
}

/**
 * The answer on an item. `to` names a question in the item's log; `question` the index of one of several open
 * questions the item parked on; `parkedAt` the time of the parked state the answer was read from (the server refuses it with 409
 * once the item parked elsewhere). Resolves with whether the item was picked up again.
 */
export async function postAnswer(ref: string, answer: string, to?: string, question?: number, parkedAt?: string): Promise<{ released: boolean }> {
  const response = await call("/api/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, answer, ...(to ? { to } : {}), ...(question !== undefined ? { question } : {}), ...(parkedAt ? { parkedAt } : {}) }) });
  const body = (await response.json().catch(() => null)) as { released?: boolean; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  return { released: body?.released === true };
}

/**
 * The answers to several of an item's questions, sent together (one write on the host). Each names its question
 * as `postAnswer` does (`to` or `question`). Questions left out stay open. Resolves with whether the item was picked up again.
 */
export async function postAnswers(ref: string, answers: { answer: string; to?: string; question?: number }[], parkedAt?: string): Promise<{ released: boolean }> {
  const response = await call("/api/answers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, answers, ...(parkedAt ? { parkedAt } : {}) }) });
  const body = (await response.json().catch(() => null)) as { released?: boolean; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  return { released: body?.released === true };
}

/** A person starts an item over at triage, dropping the work of its implement or fix step. */
export async function postStartOver(ref: string): Promise<void> {
  const response = await call("/api/start-over", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref }) });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  }
}

/** Settles the triage's draft, or sends answers that run the triage again. */
export async function postDraft(ref: string, parkedAt: string, answers: string[], action: "accept" | "edit" | "reject", text?: string, labels?: { add: string[]; remove: string[] }): Promise<{ rerun: boolean; settled?: string }> {
  const response = await call("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, parkedAt, answers, action, ...(text !== undefined ? { text } : {}), ...(labels !== undefined ? { labels } : {}) }) });
  const body = (await response.json().catch(() => null)) as { rerun?: boolean; settled?: string; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  return { rerun: body?.rerun === true, ...(body?.settled ? { settled: body.settled } : {}) };
}

/**
 * A person's decision on a proposed restructuring: accept it, accept it with a person's own `parts` and `original` (edit), or reject it.
 */
export async function postProposal(ref: string, action: "accept" | "edit" | "reject" | "stop", fields: { parts?: ProposedPart[]; original?: OriginalFate; to?: string } = {}): Promise<{ released: boolean }> {
  const response = await call("/api/proposal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, action, ...fields }) });
  const body = (await response.json().catch(() => null)) as { released?: boolean; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
  return { released: body?.released === true };
}

/** The fields of an item as the board writes them. Lists are comma-separated text. */
export interface ItemFields {
  title: string;
  body: string;
  verification: string;
  labels: string;
  blockedBy: string;
  /** blocker, critical, major or minor; empty for none. */
  priority: string;
  state?: string;
}

async function postJson(path: string, body: unknown): Promise<{ ref: string; message?: string }> {
  const response = await call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => null)) as { ref?: string; message?: string; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(answer?.error?.message ?? `The server answered ${response.status}.`);
  return { ref: answer?.ref ?? "", ...(answer?.message ? { message: answer.message } : {}) };
}

/** Deletes one of an Item's images: here and, when it was pushed, from its media ref (the server records who). */
export const postMediaDelete = (ref: string, name: string) => postJson("/api/item/media/delete", { ref, name });

/** Creates an item. Resolves with its ref key. */
export const postItem = (fields: ItemFields) => postJson("/api/items", fields);
/** Changes an item's fields. */
export const postEdit = (ref: string, fields: ItemFields) => postJson("/api/item/edit", { ref, ...fields });

/** Moves the Item one place (the server sets the vote); the views are loaded again at once, so the new position shows. */
export async function postVote(ref: string, direction: "up" | "down"): Promise<void> {
  await postJson("/api/item/vote", { ref, direction });
  listeners.forEach((listener) => listener());
}

/** Lets go of a person's hold on the Item, as the board's picked person (anyone may; the log names both). */
export const postRelease = (id: string) => postJson("/api/item/release", { id });
/** The board's person takes the Item; Scope Soup leaves it alone. */
export const postClaim = (id: string) => postJson("/api/item/claim", { id });
/** The board's person hands the Item back: Scope Soup reads its branch from the remote and records the tip; it reviews it next. */
export const postHandBack = (id: string, fields: { note?: string }) => postJson("/api/item/handback", { id, ...fields });
/** Whether the Item's branch is on the remote now, for the command to start working. */
export const fetchItemBranch = (id: string) => getJson<ItemBranchState>(`/api/item/branch?id=${encodeURIComponent(id)}`);

/** Settles a conflict: `text` becomes the item's text, and the versions shown (`supersedes`) are removed. */
export const postResolve = (ref: string, text: string, supersedes: string[]) => postJson("/api/item/resolve", { ref, text, supersedes });

// --- The server's clock ---

let clockOffset = 0;

/** Called with each view's `now`, so progress is counted on the server's clock. */
export function syncClock(serverNow: string): void {
  const at = Date.parse(serverNow);
  if (!Number.isNaN(at)) clockOffset = at - Date.now();
}

export function serverNow(): number {
  return Date.now() + clockOffset;
}

// --- Live updates ---

type Listener = () => void;
const listeners = new Set<Listener>();
const connection = { live: false, watchers: new Set<(live: boolean) => void>() };
let source: EventSource | null = null;
let timer: number | undefined;

function notify(): void {
  // Events come in bursts (a sync writes many). One refetch per burst is enough.
  window.clearTimeout(timer);
  timer = window.setTimeout(() => listeners.forEach((listener) => listener()), 250);
}

function setLive(live: boolean): void {
  if (connection.live === live) return;
  connection.live = live;
  connection.watchers.forEach((watcher) => watcher(live));
}

function connect(): void {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  source.onopen = () => {
    setLive(true);
    notify();
  };
  source.onmessage = notify;
  // The browser reconnects by itself and sends Last-Event-ID; the server replays what was missed.
  source.onerror = () => setLive(false);
}

function onChange(listener: Listener): () => void {
  listeners.add(listener);
  connect();
  return () => listeners.delete(listener);
}

/** True while the event stream is connected. */
export function useLive(): boolean {
  const [live, set] = useState(connection.live);
  useEffect(() => {
    connection.watchers.add(set);
    return () => void connection.watchers.delete(set);
  }, []);
  return live;
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

/** Loads a view, and loads it again whenever the server says something changed. */
export function useView<T extends { now: string }>(load: () => Promise<T>, key: string): Loaded<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({ key, data: null, error: null });
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const currentKey = useRef(key);
  currentKey.current = key;

  const reload = useRef(() => {
    const ticket = ++latest.current;
    const loadedKey = currentKey.current;
    loader.current().then(
      (data) => {
        if (ticket !== latest.current) return;
        syncClock(data.now);
        setState({ key: loadedKey, data, error: null });
      },
      (error: unknown) => {
        if (ticket !== latest.current) return;
        setState((previous) => ({ key: loadedKey, data: previous.key === loadedKey ? previous.data : null, error: error instanceof Error ? error.message : String(error) }));
      },
    );
  }).current;

  useEffect(() => {
    setState({ key, data: null, error: null });
    reload();
    const stop = onChange(reload);
    // Another person picked: their "Your turn" and whose turns are theirs differ.
    const stopPerson = onPersonChange(reload);
    // A safety net for a stream that died without the browser noticing.
    const poll = window.setInterval(reload, 60_000);
    return () => {
      stop();
      stopPerson();
      window.clearInterval(poll);
      latest.current++;
    };
  }, [key]);

  // On the render right after the key changed the effect has not run yet: the old page is not this one's.
  return state.key === key ? { data: state.data, error: state.error, reload } : { data: null, error: null, reload };
}

// --- The project configuration (the Settings page) ---

/**
 * `GET /api/config`: both as written (the private file and the shared settings on the meta ref, as one; no key is in
 * both) and as Scope Soup reads them; `present: false` in board-only mode. `sharedFields`: the page's fields every machine shares.
 */
export type ConfigView =
  | { present: false }
  | { present: true; file: string; raw: unknown; config: ProjectConfig | null; errors: string[]; safeFields: string[]; sharedFields?: string[]; sliders: Sliders; defaultModels: Readonly<Record<string, string>>; setupWatchDefault?: readonly string[]; levels: LevelChoice[]; mergeQueue?: MergeQueueSetup | null };

export const fetchConfig = () => getJson<ConfigView>("/api/config");

/**
 * Changes the safe fields given. Rejects with every reason the server gave when refused. `shared`: that a project setting was
 * saved for every machine, by whom, as which meta commit.
 */
export async function postConfig(change: Record<string, unknown>): Promise<ConfigView & { shared?: string }> {
  const response = await call("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
  const body = (await response.json().catch(() => null)) as (ConfigView & { errors?: string[]; error?: { message?: string }; players?: PlayersDiffer["players"] }) | null;
  if (response.status === 409 && body?.players) throw new PlayersDiffer(body.errors?.join("\n") ?? "", body.players);
  if (!response.ok) throw new Error(body?.errors?.join("\n") ?? body?.error?.message ?? `The server answered ${response.status}.`);
  return body as ConfigView & { shared?: string };
}

/** One open Item of the meta branch that the connect dialog may move. */
export interface MovableItem {
  id: string;
  title: string;
}

/** What `POST /api/connect` answered: the plan, what stands in the way, the Items to tick, and once done the configuration after. */
export interface ConnectAnswer {
  lines: string[];
  problems: string[];
  items?: MovableItem[];
  moved?: string[];
  done?: boolean;
  shared?: string;
  view?: ConfigView;
}

/**
 * Settings' connect dialogs (#127): without `confirm` what connecting would do (`lines`) and what stands in the way (`problems`);
 * with it, connects, and `view` is the configuration after. Rejects only when the server refused the request itself.
 */
export async function postConnect(body: Record<string, unknown>): Promise<ConnectAnswer> {
  const response = await call("/api/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => null)) as (Omit<ConnectAnswer, "view"> & { error?: { message?: string } } & Partial<ConfigView>) | null;
  if (!answer || (!response.ok && !answer.problems)) throw new Error(answer?.error?.message ?? `The server answered ${response.status}.`);
  const { lines = [], problems = [], items, moved, done, shared } = answer;
  return { lines, problems, ...(items ? { items } : {}), ...(moved ? { moved } : {}), ...(done ? { done, view: answer as ConfigView } : {}), ...(shared ? { shared } : {}) };
}

/** What this machine lacks for the project's host (decision 95), and the host as the shared settings name it. */
export interface MachineSetupView {
  setup: { kind: "github" | "jira"; missing: string[] } | null;
  host?: { kind: "github" | "jira"; repo?: string; site?: string; project?: string; deployment?: "cloud" | "datacenter"; write?: boolean };
}

export const fetchMachineSetup = () => getJson<MachineSetupView>("/api/machine-setup");

/** A refused switch to multiplayer whose remote names another project or host: both sides, for the person's choice. */
export class PlayersDiffer extends Error {
  players: { mine: { project: string | null; host: string }; theirs: { project: string | null; host: string } };
  constructor(message: string, players: PlayersDiffer["players"]) {
    super(message);
    this.players = players;
  }
}

/** Re-renders every second with the server's time, for bars and "4 min ago". */
export function useNow(): number {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(serverNow()), 1000);
    return () => window.clearInterval(tick);
  }, []);
  return now;
}

/**
 * The picks on an Item's decisions that its implementor took itself, sent together (Accept, or Overturn with a person's decision):
 * recorded together or not at all.
 */
export async function postDecisions(ref: string, decisions: PickEntry[]): Promise<void> {
  const response = await call("/api/decisions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, decisions }) });
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `The server answered ${response.status}.`);
}
