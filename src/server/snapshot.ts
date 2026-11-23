// Reads everything the board needs from the store in one go.

import type { Snapshot, RunnerState, SyncState } from "../core/snapshot.ts";
import type { Batch, Change, CreatedPart, ProposedPart, Ref, Parked, ParkedQuestion, Run, Session, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { loadJobs, jobQuestions, resumesStep } from "../orchestrator/jobs.ts";
import { markedParts } from "../orchestrator/split.ts";
import { readQueueHealth } from "../orchestrator/queueHealth.ts";
import { knownAnswers } from "../store/answers.ts";
import { loadOwnBlockers, withOwnBlockers } from "../store/blockers.ts";
import { loadVotes, withVotes } from "../store/votes.ts";
import { readControl } from "../store/control.ts";
import { KEYS } from "../store/keys.ts";
import type { Store } from "../store/store.ts";

export { KEYS } from "../store/keys.ts";

function parse<T>(text: string | null, fallback: T, ok: (value: unknown) => boolean): T {
  if (text === null) return fallback;
  try {
    const value: unknown = JSON.parse(text);
    return ok(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadSnapshot(store: Store): Snapshot {
  const queue = readQueueHealth(store);
  const idle = store.getValue(KEYS.idle);
  return {
    ...(idle ? { idle } : {}),
    ...(queue ? { queue } : {}),
    // Scope Soup's own blockers show as the host's do.
    works: withVotes(withOwnBlockers(store.list<WorkItem>("work"), loadOwnBlockers(store)), loadVotes(store)),
    changes: store.list<Change>("change"),
    runs: store.list<Run>("run"),
    batches: store.list<Batch>("batch"),
    sessions: store.list<Session>("session"),
    runners: parse<RunnerState[]>(store.getValue(KEYS.runners), [], Array.isArray),
    usage: store.latestUsageSample(),
    usageHistory: store.usageSamplesSince(new Date(Date.now() - 25 * 3600_000).toISOString()),
    ...(() => {
      const control = readControl(store);
      return { paused: control.agents !== "started", agents: control.agents, mergeQueue: control.mergeQueue };
    })(),
    parked: Object.values(loadJobs(store)).flatMap((job): Parked[] => {
      if (!job.parked) return [];
      const asked = job.parked.as === "needs-decision";
      // A draft's questions are shown with the draft, not as the parked state's one decision.
      const refine = asked && job.refine && !job.refine.settled ? job.refine : undefined;
      const decision = asked && !refine ? job.decision ?? (job.step === "triage" ? job.triage?.decision : undefined) : undefined;
      // A job stored with a proposed rewrite (removed) has no parts; the tick releases it.
      const stored = asked && job.proposal?.parts?.length ? job.proposal : undefined;
      // On GitHub each question is a comment, and its answer is read from there.
      const onHost = job.parked.questions;
      // There a split's children are the sub-issues that carry its part lines; they are not stored.
      const proposal = stored && onHost ? { ...stored, created: hostParts(store, job.item, stored.parts) } : stored;
      const hostAnswers = onHost ? store.get<WorkItem>(job.item)?.answers ?? [] : [];
      const questions = jobQuestions(job).map((each, index): ParkedQuestion => {
        const answer = onHost ? hostAnswers.find((given) => given.to !== undefined && given.to === onHost[index])?.answer : job.answered?.find((given) => given.index === index)?.answer;
        return { ...each, ...(answer !== undefined ? { answer } : {}) };
      });
      return [{ subject: job.item, as: job.parked.as, reason: job.parked.reason, at: job.parked.at, ...(resumesStep(job) ? { canStartOver: true } : {}), ...(decision && !proposal ? { decision } : {}), ...(proposal ? { proposal } : {}), ...(questions.length > 0 ? { questions } : {}), ...(refine ? { refine: { original: refine.original, draft: refine.draft, round: refine.round, questions: refine.questions.map(({ question, options, recommendation, context, multiSelect }) => ({ question, options, recommendation, ...(context ? { context } : {}), ...(multiSelect ? { multiSelect } : {}) })), ...(refine.labels ? { labels: refine.labels } : {}), ...(refine.droppedLabels ? { droppedLabels: refine.droppedLabels } : {}) } } : {}) }];
    }),
    // The triage's typed links, for the Item page.
    links: Object.values(loadJobs(store)).flatMap((job) => (job.triage?.links?.length ? [{ subject: job.item, links: job.triage.links }] : [])),
    merged: Object.values(loadJobs(store)).filter((job) => job.merged !== undefined).map((job) => job.item),
    answers: knownAnswers(store),
    sync: parse<SyncState>(store.getValue(KEYS.sync), {}, (value) => typeof value === "object" && value !== null && !Array.isArray(value)),
  };
}

/** The parts of an item's split that exist on its host, found by their part lines; `linked` when it is a sub-issue of the item. */
export function hostParts(store: Store, item: Ref, parts: readonly ProposedPart[]): CreatedPart[] {
  return [...markedParts(store.list<WorkItem>("work", item.host), item, parts)]
    .map(([part, work]) => ({ part, ref: work.ref, linked: work.parent !== undefined && refKey(work.parent) === refKey(item) }))
    .sort((a, b) => a.part - b.part);
}
