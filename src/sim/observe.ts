// What the checker reads after each step: only what a person or another program could read (the store, the fake host, the
// board and the Item pages, the events since the step before, the fake runner and git), plus the simulator's own ledger.

import { buildBoard } from "../core/board.ts";
import type { CardView } from "../core/views.ts";
import type { RecordedAnswer, ScopeSoupEvent, Session, UsageSample, UsageWindowKind, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { Job } from "../orchestrator/jobs.ts";
import type { SessionRequest } from "../orchestrator/ports.ts";
import type { TickReport } from "../orchestrator/tick.ts";
import { loadSnapshot } from "../server/snapshot.ts";
import { knownAnswers } from "../store/answers.ts";
import { loadOwnBlockers } from "../store/blockers.ts";
import { switchState } from "../store/control.ts";
import type { Commit, FakeGit, StashEntry, Worktree } from "./git.ts";
import type { Role, W } from "./waits.ts";
import { isBusy, waitsFor } from "./waits.ts";
import type { Action, Ledger, PageJson, SimWorld } from "./world.ts";

export interface ItemObs {
  key: string;
  id: string;
  item: WorkItem;
  /** The Item as the fake host has it; null while the host does not answer. */
  host: WorkItem | null;
  job?: Job;
  w: W;
  card?: CardView;
  /** The served page with the server's additions (moves), for Items that wait for a person. */
  served?: PageJson | null;
  /** The paths its triage named. */
  paths: string[];
  /** The live sessions on it. */
  live: { id: string; role: Role }[];
}

export interface GitObs {
  main: string;
  branches: Map<string, string>;
  tags: Map<string, string>;
  stash: StashEntry[];
  worktrees: Worktree[];
  /** Scope Soup's tags, branches (full names) and stash entries (`stash:<sha>`) that hold work on neither main nor their Item's pushed branch. */
  unique: Set<string>;
  owners: Map<string, { item?: string; scopesoup: boolean }>;
  deleted: { ref: string; madeBy?: { item?: string; scopesoup: boolean }; unmerged: boolean }[];
  mainMoves: { sha: string; how: string; item?: string }[];
  contains(ancestor: string, descendant: string): boolean | null;
  commit(sha: string): Commit | undefined;
}

export interface StartObs {
  session: string;
  item: string;
  role: Role;
  limitAtStart: number;
  request: SessionRequest;
}

export interface Observation {
  seed: number;
  /** The machine observed (one of several in the multiplayer profile). */
  machine?: string;
  step: number;
  action: Action;
  at: string;
  level: number;
  slots: number;
  switches: Record<Role | "mergeQueue", string>;
  usageReserve: boolean;
  /**
   * Some window's use is over its pace line even at the end of the longest session (the session timeout from now): no session may
   * start then but by the kick, one while nothing runs (decision 133).
   */
  overPace: boolean;
  /** What waits for a person, counted by the checker: Items parked for one (not in the queue's hands) or with decisions to look at, and drafts. */
  waiting: number;
  /** The waiting caps the configuration holds. */
  caps: { triage: number; work: number };
  fair: boolean;
  items: ItemObs[];
  sessions: Session[];
  /** Sessions started in this step. */
  started: StartObs[];
  liveCount: number;
  events: ScopeSoupEvent[];
  lastSeq: number;
  /** The first event and the last one seen before this step, as they read now (E2). */
  firstEvent?: string;
  answers: RecordedAnswer[];
  tick: TickReport | null;
  tickError: string | null;
  git: GitObs;
  ledger: Ledger;
  /** Requests made in this step (a slice of the ledger). */
  requests: Ledger["requests"];
  /** The multiplayer profile: the answers people gave on the other machines' boards, which this machine reads from the logs (B1). */
  answersElsewhere?: Ledger["answers"];
  remote: { refusedRewrites: number; down: boolean; items: number };
  /** The host's Items as read at a version of the remote, so an unchanged remote is not read again; the last read while it is down. */
  hostRead?: { version: number; items: Map<string, WorkItem> };
  /** The board's lanes, in order (the Backlog and To do rules of #221 turn on when a To do lane is there). */
  lanes: string[];
  /** Items in the queue's hands. */
  queued: string[];
  /** The run's end, after the fair tail: the liveness rules read it. */
  final?: true;
  /** The run has been in the fair tail for this many ticks. */
  fairTicks: number;
}

const closedState = (item: WorkItem): boolean => item.state === "done" || item.state === "abandoned";

export async function observe(world: SimWorld, seed: number, action: Action, previous: Observation | undefined, startedBefore: number): Promise<Observation> {
  const store = world.store;
  const at = world.now();
  // As the server's board: the project's level with the snapshot.
  const snapshot = { ...loadSnapshot(store), level: world.configNow.level };
  const board = buildBoard(snapshot, new Date(world.ms));
  const cards = new Map<string, CardView>();
  for (const lane of board.lanes) for (const card of lane.cards) cards.set(card.key, card);
  const jobs = world.jobs();
  const items = world.items();
  const open = new Map(items.filter((item) => !closedState(item)).map((item) => [refKey(item.ref), item]));
  // The host is read again only when the remote moved.
  let hostItems: Map<string, WorkItem> | null = null;
  if (world.remote.down === 0) {
    if (previous?.hostRead && previous.hostRead.version === world.remote.version) hostItems = previous.hostRead.items;
    else hostItems = new Map(((await world.host.work!.listWork()).items).map((item) => [refKey(item.ref), item]));
  }
  const own = loadOwnBlockers(store);
  const switches = {
    triage: switchState(store, "triage"), implement: switchState(store, "implement"), review: switchState(store, "review"), mergeQueue: switchState(store, "mergeQueue"),
  };
  const sample = store.latestUsageSample();
  const usageReserve = (sample?.windows ?? []).some((window) => (window.utilization ?? 0) >= 0.9);
  const settings = world.configNow.settings;
  const overPace = overThePace(sample, Date.parse(at), { five_hour: settings.budgetFiveHour.value, seven_day: settings.budgetSevenDay.value }, settings.sessionTimeoutMinutes.value * 60_000);
  const caps = { triage: settings.waitingCapTriage.value, work: settings.waitingCapWork.value };
  const waiting = items.filter((item) => !closedState(item)).filter((item) => {
    const job = jobs[refKey(item.ref)];
    const asks = job ? !!job.parked && job.parked.as !== "queued" : item.needsDecision === true;
    return asks || (item.assumptions ?? []).some((each) => !each.settled);
  }).length + store.list<{ decided?: unknown }>("draft").filter((draft) => !draft.decided).length;
  const live = [...world.runner.live.values()];
  const onMain = (head: string | undefined): boolean => !!head && world.git.contains(head, world.git.main) === true;
  // The paths an Item's work is known by: what its triage named (#187 compares these; what the branch changes is not looked at).
  const pathsOf = (job: Job): string[] => [...new Set(job.triage?.paths ?? [])];
  // A change the merge queue pushed is on main before the tick reads the queue's notice: until then it is busy, as the tick sees it.
  const busy = Object.values(jobs).filter((job) => isBusy(job, job.parked?.as !== "queued" && onMain(job.head)) && open.has(refKey(job.item))).map((job) => ({ key: refKey(job.item), paths: pathsOf(job), conflicts: (job.triage?.links ?? []).filter((l) => l.type === "conflictsWith").map((l) => l.item.replace(/^#/, "")) }));
  const claimant = `scopesoup@${world.machine}`;
  const itemObs: ItemObs[] = [];
  for (const item of items) {
    const key = refKey(item.ref);
    const job = jobs[key];
    const mine = live.filter((each) => refKey(each.session.subject) === key).map((each) => ({ id: each.session.ref.id, role: each.session.role as Role }));
    const w = waitsFor({
      item, job, live: mine.map((each) => each.role), settling: !!job?.sessionId && mine.length === 0, open, ownBlockers: (own[key] ?? []).map(refKey), switches, level: world.configNow.level, usageReserve, now: at,
      workCapped: waiting >= caps.work, liveCount: live.length, slots: world.configNow.settings.maxParallelSessions.value, busy: busy.filter((each) => each.key !== key), claimant,
    });
    // The served page is read for an Item that waits for a person, at ticks only (it is the costly part of a step).
    // It is read again only when W changed since the step before.
    const tickStep = action.kind === "tick" || action.kind === "inside-tick";
    const was = previous?.items.find((each) => each.key === key);
    const same = was?.served !== undefined && was.w.kind === w.kind && JSON.stringify(was.w) === JSON.stringify(w);
    const served = w.kind === "person" && tickStep ? (same ? was!.served : await world.page(item.ref.id)) : undefined;
    itemObs.push({ key, id: item.ref.id, item, paths: job ? pathsOf(job) : [], host: hostItems ? (hostItems.get(key) ?? null) : null, ...(job ? { job } : {}), w, ...(cards.get(key) ? { card: cards.get(key)! } : {}), ...(served !== undefined ? { served } : {}), live: mine });
  }
  const lastSeq = store.lastSeq();
  const fromSeq = previous?.lastSeq ?? 0;
  const events = store.eventsAfter(fromSeq, 100_000);
  const first = store.eventsAfter(0, 1)[0];
  const git = world.git;
  const started: StartObs[] = world.runner.requests.slice(startedBefore).map((request) => {
    const each = [...world.runner.live.values()].find((l) => l.request === request);
    const session = each?.session.ref.id ?? store.list<Session>("session").filter((s) => refKey(s.subject) === refKey(request.subject)).at(-1)?.ref.id ?? "";
    return { session, item: refKey(request.subject), role: request.role as Role, limitAtStart: each?.limitAtStart ?? world.configNow.settings.maxParallelSessions.value, request };
  });
  const requestsBefore = previous ? previous.ledger.requests.filter((r) => r.step < world.step).length : 0;
  return {
    seed, machine: world.machine, step: world.step, action, at, level: world.configNow.level, slots: world.configNow.settings.maxParallelSessions.value, switches, usageReserve, overPace, waiting, caps, fair: world.fair,
    items: itemObs, sessions: store.list<Session>("session"), started, liveCount: live.length, events, lastSeq,
    ...(first ? { firstEvent: JSON.stringify(first) } : {}),
    answers: knownAnswers(store), tick: action.kind === "tick" || action.kind === "inside-tick" ? world.lastTick : null, tickError: world.tickError,
    git: {
      main: git.main, branches: new Map(git.branches), tags: new Map(git.tags), stash: git.stash.map((entry) => ({ ...entry })), unique: uniqueLeftovers(git), worktrees: [...git.worktrees.values()].map((t) => ({ ...t, dirty: [...t.dirty], untracked: [...t.untracked] })),
      owners: new Map(git.owners), deleted: [...git.deleted], mainMoves: [...git.mainMoves],
      contains: (a, d) => git.contains(a, d), commit: (sha) => git.commits.get(sha),
    },
    ledger: world.ledger,
    requests: world.ledger.requests.slice(requestsBefore).filter((r) => r.step === world.step),
    remote: { refusedRewrites: world.remote.refusedRewrites.length, down: world.remote.down > 0 || world.wasDown, items: world.remote.files.size },
    // While the host does not answer, the last read stands: Items are never removed from it, so what it had still exists (I1).
    ...(hostItems ? { hostRead: { version: world.remote.version, items: hostItems } } : previous?.hostRead ? { hostRead: previous.hostRead } : {}),
    lanes: board.lanes.map((lane) => lane.lane),
    queued: [...world.queue.waiting.keys(), ...world.queue.notices.flatMap((n) => (n.kind === "mark-merged" ? n.members.map((m) => refKey(m.change)) : n.kind === "send-back" ? [refKey(n.change)] : []))],
    fairTicks: world.fair && previous ? previous.fairTicks + (action.kind === "tick" ? 1 : 0) : 0,
  };
}

export function uniqueLeftovers(git: FakeGit): Set<string> {
  const out = new Set<string>();
  const branchOf = (item: string | undefined): string => `scopesoup/${item?.split(":").pop() ?? ""}`;
  for (const [ref, madeBy] of git.owners) {
    if (!madeBy.scopesoup) continue;
    const sha = ref.startsWith("refs/tags/") ? git.tags.get(ref.slice(10)) : ref.startsWith("refs/heads/") ? git.branches.get(ref.slice(11)) : undefined;
    if (sha !== undefined && !git.safe(sha, branchOf(madeBy.item))) out.add(ref);
  }
  for (const entry of git.stash) if (entry.scopesoup && !git.stashSafe(entry, entry.branch)) out.add(`stash:${entry.sha}`);
  return out;
}

/**
 * The checker's own pace (decision 133): a live window whose use is over the line from 0 at its start to its budget at its reset, at
 * the latest moment a session started now could end (the session timeout from now, at most the reset).
 */
export function overThePace(sample: UsageSample | null, now: number, budget: Record<UsageWindowKind, number>, longestMs: number): boolean {
  const length: Record<UsageWindowKind, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 24 * 3600_000 };
  return (sample?.windows ?? []).some((window) => {
    const reset = Date.parse(window.resetsAt);
    if (window.utilization === undefined || !(reset > now)) return false;
    const end = Math.min(reset, now + longestMs);
    return window.utilization > (budget[window.kind] * (end - (reset - length[window.kind]))) / length[window.kind];
  });
}
