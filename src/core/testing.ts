// Small builders for synthetic objects, used by the tests and the demo. Not real project data.

import type { Batch, BatchMember, Change, Ref, RefKind, Run, Session, Verdict, WorkItem } from "../model/types.ts";
import type { Snapshot } from "./snapshot.ts";
import { emptySnapshot } from "./snapshot.ts";

export const T0 = "2026-03-02T10:00:00.000Z";

/** T0 plus a number of minutes, as ISO. */
export function at(minutes: number, base: string = T0): string {
  return new Date(Date.parse(base) + minutes * 60_000).toISOString();
}

export function ref(kind: RefKind, id: string | number, host = "demo"): Ref {
  return { host, kind, id: String(id) };
}

export function work(id: string | number, over: Partial<WorkItem> = {}): WorkItem {
  return { ref: ref("work", id), title: `Item ${id}`, state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: T0, ...over };
}

export function verdict(dimension: string, value: Verdict["value"], over: Partial<Verdict> = {}): Verdict {
  return { dimension, value, stale: false, by: { id: "reviewer", name: "reviewer", bot: true }, ...over };
}

export function change(id: string | number, works: (string | number)[], over: Partial<Change> = {}): Change {
  return {
    ref: ref("change", id),
    title: `Change ${id}`,
    author: { id: "agent", name: "agent", bot: true },
    state: "open",
    draft: false,
    target: "main",
    revisions: [{ id: "r1", sha: `sha-${id}`, createdAt: T0 }],
    verdicts: [],
    labels: [],
    works: works.map((workId) => ref("work", workId)),
    updatedAt: T0,
    ...over,
  };
}

export function run(id: string | number, over: Partial<Run> = {}): Run {
  return { ref: ref("run", id), pipeline: "full suite", sha: `sha-run-${id}`, status: "passed", ...over };
}

/** A passed run that took `minutes`, finished at `finishedAt`. */
export function passed(id: string | number, minutes: number, finishedAt: string = T0, pipeline = "full suite"): Run {
  return run(id, { pipeline, status: "passed", startedAt: at(-minutes, finishedAt), finishedAt });
}

export function member(changeId: string | number, state: BatchMember["state"] = "testing"): BatchMember {
  return { change: ref("change", changeId), sha: `sha-${changeId}`, state };
}

export function batch(id: string | number, members: BatchMember[], over: Partial<Batch> = {}): Batch {
  return { ref: ref("batch", id, "scopesoup"), status: "testing", base: "base000", members, runs: [], probes: [], startedAt: T0, ...over };
}

export function session(id: string | number, subject: Ref, over: Partial<Session> = {}): Session {
  return { ref: ref("session", id, "scopesoup"), role: "implement", subject, status: "running", attempt: 1, startedAt: T0, ...over };
}

export function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return { ...emptySnapshot(), ...over };
}
