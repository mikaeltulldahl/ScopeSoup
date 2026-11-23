// The snapshot: everything the pure rules look at, read from the store in one go.

import type { AgentsState, MergeQueueState } from "../model/types.ts";
import type { Batch, Change, ItemLinkAnswer, RecordedAnswer, Ref, Parked, Run, Runner, Session, UsageSample, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";

/** A runner plus when it entered its current online/busy state, when the sync knows. */
export interface RunnerState extends Runner {
  since?: string;
}

export interface SyncState {
  /** When the hosts were last read successfully. */
  lastAt?: string;
  /** The last sync error, in words. Cleared by a good sync. */
  error?: string;
}

/** A flake or a problem the merge queue reported. */
export interface QueueNoteView {
  at: string;
  kind: "flake" | "problem";
  text: string;
}

/** What the merge queue reports about itself, beyond its batches. */
export interface QueueHealth {
  /** Set while the engine has paused the queue. */
  paused?: { reason: string; at: string };
  /** Recent flakes and problems, oldest first. */
  notes: QueueNoteView[];
  /** Tests that failed and passed on a rerun, most recent first, with how often. */
  flaky?: { test: string; count: number; at: string }[];
  /** What the queue measured about its own runs, which batch sizing uses. */
  measured?: { timedRuns: number; reruns: number; rerunCost?: number; culpritBatches: number; culpritNamed: number };
}

export type { AgentsState, MergeQueueState };

export interface Snapshot {
  works: WorkItem[];
  changes: Change[];
  runs: Run[];
  batches: Batch[];
  sessions: Session[];
  runners: RunnerState[];
  usage: UsageSample | null;
  /** Recent readings, for the forecast. Absent when only the latest is known. */
  usageHistory?: UsageSample[];
  /** Agents are not started (paused or stopped): no new session starts. */
  paused: boolean;
  agents: AgentsState;
  mergeQueue: MergeQueueState;
  /** The project's level; absent with no project configuration (board only). */
  level?: number;
  /** Sessions planned at once (maxParallelSessions), for the forecast. Absent: raw rate. */
  plannedSessions?: number;
  sync: SyncState;
  /** Why the orchestrator started nothing in its last tick, in words. Absent while it starts work. */
  idle?: string;
  /** Items the orchestrator has put down. Absent when no orchestrator runs. */
  parked?: Parked[];
  /** Items whose change merged on the main branch (through the queue, or merged by the session), whatever the host still says. */
  merged?: Ref[];
  /** The triage's typed links per Item (from Scope Soup's store). */
  links?: { subject: Ref; links: ItemLinkAnswer[] }[];
  answers?: RecordedAnswer[];
  /** The merge queue's health. Absent when no queue has run. */
  queue?: QueueHealth;
}

export function emptySnapshot(): Snapshot {
  return { works: [], changes: [], runs: [], batches: [], sessions: [], runners: [], usage: null, paused: false, agents: "started", mergeQueue: "started", sync: {} };
}

/** Lookups over a snapshot, built once per view. */
export interface Index {
  snapshot: Snapshot;
  work: Map<string, WorkItem>;
  change: Map<string, Change>;
  run: Map<string, Run>;
  /** Changes per work item key. */
  changesByWork: Map<string, Change[]>;
  /** Batches per change key. */
  batchesByChange: Map<string, Batch[]>;
  /** Sessions per subject key, newest first. */
  sessionsBySubject: Map<string, Session[]>;
  /** The parked state of each work item that has one, by item key. */
  parkedByWork: Map<string, Parked>;
  /** Keys of the items whose change has merged. */
  mergedWork: Set<string>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The jobs' merges, and each Item's `merged` marker (GitHub): it counts while no `reopened` event is newer; a newer
 * one undoes the merge, so a reopened merged Item is work again.
 */
function mergedKeys(snapshot: Snapshot): Set<string> {
  const keys = new Set((snapshot.merged ?? []).map(refKey));
  for (const work of snapshot.works) {
    if (!work.merged) continue;
    if (work.merged.reopened) keys.delete(refKey(work.ref));
    else keys.add(refKey(work.ref));
  }
  return keys;
}

export function buildIndex(snapshot: Snapshot): Index {
  const index: Index = {
    snapshot,
    work: new Map(snapshot.works.map((item) => [refKey(item.ref), item])),
    change: new Map(snapshot.changes.map((change) => [refKey(change.ref), change])),
    run: new Map(snapshot.runs.map((run) => [refKey(run.ref), run])),
    parkedByWork: new Map((snapshot.parked ?? []).map((parked) => [refKey(parked.subject), parked])),
    mergedWork: mergedKeys(snapshot),
    changesByWork: new Map(),
    batchesByChange: new Map(),
    sessionsBySubject: new Map(),
  };
  for (const change of snapshot.changes) for (const work of change.works) push(index.changesByWork, refKey(work), change);
  for (const batch of snapshot.batches) for (const member of batch.members) push(index.batchesByChange, refKey(member.change), batch);
  const sessions = [...snapshot.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const session of sessions) push(index.sessionsBySubject, refKey(session.subject), session);
  return index;
}

/** "#342" for numeric ids, the id itself otherwise. */
export function refLabel(ref: Ref): string {
  return /^\d+$/.test(ref.id) ? `#${ref.id}` : ref.id;
}

export function ms(iso: string | undefined): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/** "42 s", "14 min", "3 h 05 min", "2 d". For reasons and the status line. */
export function durationWords(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  return `${Math.round(hours / 24)} d`;
}
