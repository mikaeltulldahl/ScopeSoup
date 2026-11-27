// Reads everything the board needs from the store in one go.

import type { Snapshot, RunnerState, SyncState } from "../core/snapshot.ts";
import type { Batch, Change, CreatedPart, ProposedPart, Ref, Parked, ParkedQuestion, Run, Session, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { loadJobs, jobQuestions, resumesStep } from "../orchestrator/jobs.ts";
import { busyItems, sameFilesWait } from "../orchestrator/candidates.ts";
import { markedParts, partLinked } from "../orchestrator/restructure.ts";
import { readQueueHealth } from "../orchestrator/queueHealth.ts";
import { openProposedRewrites } from "../orchestrator/aboutOthers.ts";
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
  const proposedRewrites = openProposedRewrites(store);
  return {
    ...(proposedRewrites.length > 0 ? { proposedRewrites } : {}),
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
      return { paused: control.agents !== "started", agents: control.agents, triage: control.triage, implement: control.implement, review: control.review, mergeQueue: control.mergeQueue };
    })(),
    parked: Object.values(loadJobs(store)).flatMap((job): Parked[] => {
      if (!job.parked) return [];
      const asked = job.parked.as === "needs-decision";
      // A rewrite's questions are shown with the rewrite, not as the parked state's one decision.
      const rewrite = asked && job.rewrite && !job.rewrite.settled ? job.rewrite : undefined;
      const decision = asked && !rewrite ? job.decision ?? (job.step === "triage" ? job.triage?.decision : undefined) : undefined;
      // A job stored with a proposed rewrite (removed) has no parts; the tick releases it.
      const stored = asked && job.proposal?.parts?.length ? job.proposal : undefined;
      // On GitHub each question is a comment, and its answer is read from there.
      const onHost = job.parked.questions;
      // There a restructuring's parts are the items that carry its part lines; they are not stored.
      const proposal = stored && onHost ? { ...stored, created: hostParts(store, job.item, stored) } : stored;
      const hostAnswers = onHost ? store.get<WorkItem>(job.item)?.answers ?? [] : [];
      const questions = jobQuestions(job).map((each, index): ParkedQuestion => {
        const answer = onHost ? hostAnswers.find((given) => given.to !== undefined && given.to === onHost[index])?.answer : job.answered?.find((given) => given.index === index)?.answer;
        return { ...each, ...(answer !== undefined ? { answer } : {}) };
      });
      return [{ subject: job.item, as: job.parked.as, reason: job.parked.reason, at: job.parked.at, ...(resumesStep(job) ? { canStartOver: true } : {}), ...(decision && !proposal ? { decision } : {}), ...(proposal ? { proposal } : {}), ...(questions.length > 0 ? { questions } : {}), ...(rewrite ? { rewrite: { original: rewrite.original, text: rewrite.text, round: rewrite.round, questions: rewrite.questions.map(({ question, options, recommendation, context, multiSelect, stopsOn }) => ({ question, options, recommendation, ...(context ? { context } : {}), ...(multiSelect ? { multiSelect } : {}), ...(stopsOn ? { stopsOn } : {}) })), ...(rewrite.labels ? { labels: rewrite.labels } : {}), ...(rewrite.droppedLabels ? { droppedLabels: rewrite.droppedLabels } : {}) } } : {}) }];
    }),
    // The triage's typed links, for the Item page.
    links: Object.values(loadJobs(store)).flatMap((job) => (job.triage?.links?.length ? [{ subject: job.item, links: job.triage.links }] : [])),
    merged: Object.values(loadJobs(store)).filter((job) => job.merged !== undefined).map((job) => job.item),
    // The triaged Items that wait for a busy Item that changes the same files or may conflict with it.
    ...(() => {
      const jobs = loadJobs(store);
      const busy = busyItems(jobs);
      const answers = knownAnswers(store);
      const sameFiles = Object.values(jobs).flatMap((job) => {
        const wait = sameFilesWait(job, busy, answers);
        return wait ? [{ subject: job.item, waitsFor: wait.waitsFor, ...(wait.mayConflict.length > 0 ? { mayConflict: wait.mayConflict } : {}) }] : [];
      });
      return sameFiles.length > 0 ? { sameFiles } : {};
    })(),
    answers: knownAnswers(store),
    sync: parse<SyncState>(store.getValue(KEYS.sync), {}, (value) => typeof value === "object" && value !== null && !Array.isArray(value)),
  };
}

/** The parts of an item's restructuring that exist on its host, found by their part lines; a child is `linked` when it is a sub-issue of the item. */
export function hostParts(store: Store, item: Ref, proposal: { id: string; parts: readonly ProposedPart[] }): CreatedPart[] {
  return [...markedParts(store.list<WorkItem>("work", item.host), item, proposal)]
    .map(([part, work]) => ({ part, ref: work.ref, linked: partLinked(proposal.parts[part]!, work, item) }))
    .sort((a, b) => a.part - b.part);
}

