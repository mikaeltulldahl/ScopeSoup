// Estimates and progress, after Zuul (mean of the last 10 passed runs of the same job) and
// Jenkins (bar capped at 99 %, "likely stuck" beyond 10 x the estimate).

import type { Batch, BisectProbe, Ref, Run } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { durationWords, ms } from "./snapshot.ts";

export const HISTORY_SIZE = 10;
export const PROGRESS_CAP = 0.99;
export const STUCK_FACTOR = 10;
/** With no estimate, a run is likely stuck after a day (Jenkins). */
export const STUCK_WITHOUT_ESTIMATE_MS = 24 * 60 * 60 * 1000;

export type ProgressState =
  /** Queued: no runner has picked it up. Not a slow run. */
  | "waiting-for-runner"
  /** Running with an estimate: `fraction` is set. */
  | "running"
  /** Running with no history: draw an indeterminate bar, not a guess. */
  | "indeterminate"
  | "finished";

export interface Progress {
  state: ProgressState;
  /** What the clock counts from: the start of the run, or of the wait for a runner. */
  startedAt?: string;
  elapsedMs: number;
  estimateMs?: number;
  /** elapsed / estimate, capped at 0.99. */
  fraction?: number;
  /** Never negative; absent once the run is over its estimate. */
  remainingMs?: number;
  overByMs?: number;
  likelyStuck: boolean;
  /** When it should be done. For a batch: only once every run has started. */
  etaAt?: string;
  /** The state in words: "4 min of ~7 min", "waiting for a runner (2 min)". */
  words: string;
}

function durationOf(run: Run): number | null {
  const start = ms(run.startedAt);
  const end = ms(run.finishedAt);
  if (start === null || end === null || end <= start) return null;
  return end - start;
}

/** Mean duration of the last up-to-10 passed runs of the pipeline. Null with no history. */
export function estimateFor(pipeline: string, runs: readonly Run[]): number | null {
  const durations = runs
    .filter((run) => run.pipeline === pipeline && run.status === "passed" && durationOf(run) !== null)
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
    .slice(0, HISTORY_SIZE)
    .map((run) => durationOf(run) as number);
  if (durations.length === 0) return null;
  return Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
}

function probeDuration(probe: BisectProbe): number | null {
  if (probe.ms !== undefined) return probe.ms > 0 ? probe.ms : null;
  const start = ms(probe.startedAt);
  const end = ms(probe.finishedAt);
  if (start === null || end === null || end <= start) return null;
  return end - start;
}

/** A check the merge queue ran on this machine (no host run), of the whole chain: what a local batch waits for. */
function isLocalCheck(probe: BisectProbe): boolean {
  return probe.run === undefined && !probe.reused && !probe.rerun;
}

/**
 * Mean duration of the last up-to-10 passed checks the merge queue ran on this machine, over all batches. Null with no
 * history. A batch checked locally has no runs, so its estimate comes from here.
 */
export function localCheckEstimate(batches: readonly Batch[]): number | null {
  const durations = batches
    .flatMap((batch) => batch.probes)
    .filter((probe) => probe.status === "passed" && isLocalCheck(probe) && probeDuration(probe) !== null)
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
    .slice(0, HISTORY_SIZE)
    .map((probe) => probeDuration(probe) as number);
  if (durations.length === 0) return null;
  return Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
}

/** History first, then the host's own estimate (Jenkins has one), else none. */
export function estimateForRun(run: Run, runs: readonly Run[]): number | null {
  const fromHistory = estimateFor(run.pipeline, runs);
  if (fromHistory !== null) return fromHistory;
  return run.estimateMs !== undefined && run.estimateMs > 0 ? run.estimateMs : null;
}

export function progressFraction(elapsedMs: number, estimateMs: number): number {
  if (estimateMs <= 0) return 0;
  return Math.min(PROGRESS_CAP, Math.max(0, elapsedMs / estimateMs));
}

export function isLikelyStuck(elapsedMs: number, estimateMs: number | null): boolean {
  if (estimateMs === null) return elapsedMs > STUCK_WITHOUT_ESTIMATE_MS;
  return elapsedMs > STUCK_FACTOR * estimateMs;
}

function running(startedAt: string | undefined, estimateMs: number | null, now: Date): Progress {
  const elapsedMs = Math.max(0, now.getTime() - (ms(startedAt) ?? now.getTime()));
  const likelyStuck = isLikelyStuck(elapsedMs, estimateMs);
  const stuck = likelyStuck ? ", likely stuck" : "";
  if (estimateMs === null) {
    return { state: "indeterminate", startedAt, elapsedMs, likelyStuck, words: `running for ${durationWords(elapsedMs)}, no history to estimate from${stuck}` };
  }
  const left = estimateMs - elapsedMs;
  const progress: Progress = {
    state: "running",
    startedAt,
    elapsedMs,
    estimateMs,
    fraction: progressFraction(elapsedMs, estimateMs),
    likelyStuck,
    words: `${durationWords(elapsedMs)} of ~${durationWords(estimateMs)}${stuck}`,
  };
  if (left >= 0) {
    progress.remainingMs = left;
    progress.etaAt = new Date(now.getTime() + left).toISOString();
  } else {
    progress.overByMs = -left;
    if (!likelyStuck) progress.words += `, over by ${durationWords(-left)}`;
  }
  return progress;
}

function waiting(since: string | undefined, now: Date): Progress {
  const elapsedMs = Math.max(0, now.getTime() - (ms(since) ?? now.getTime()));
  return { state: "waiting-for-runner", startedAt: since, elapsedMs, likelyStuck: false, words: `waiting for a runner (${durationWords(elapsedMs)})` };
}

function finished(words: string): Progress {
  return { state: "finished", elapsedMs: 0, likelyStuck: false, words };
}

/** Progress of one run. `runs` is the history the estimate comes from. */
export function runProgress(run: Run, runs: readonly Run[], now: Date): Progress {
  if (run.status === "queued") return waiting(run.createdAt, now);
  if (run.status === "running") return running(run.startedAt, estimateForRun(run, runs), now);
  const duration = durationOf(run);
  const progress = finished(duration === null ? run.status : `${run.status} in ${durationWords(duration)}`);
  if (duration !== null) progress.elapsedMs = duration;
  return progress;
}

/** The runs a batch is waiting for right now: its own and those of its bisect probes. */
export function activeRuns(batch: Batch, runByKey: ReadonlyMap<string, Run>): Run[] {
  const refs: Ref[] = [...batch.runs];
  for (const probe of batch.probes) if (probe.run) refs.push(probe.run);
  const seen = new Set<string>();
  const active: Run[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    const run = runByKey.get(key);
    if (!run || seen.has(key)) continue;
    seen.add(key);
    if (run.status === "queued" || run.status === "running") active.push(run);
  }
  return active;
}

/**
 * One bar for a batch. With no host runs (checked on this machine) it follows the local check, against the mean of the
 * earlier ones (`batches` is that history). Otherwise it follows the run that will finish last. The ETA is the largest
 * remaining time over the batch's runs, and is given only once all of them have started
 * and all have an estimate (Zuul's rule).
 */
export function batchProgress(batch: Batch, runByKey: ReadonlyMap<string, Run>, runs: readonly Run[], batches: readonly Batch[], now: Date): Progress {
  if (batch.status === "merged" || batch.status === "failed") return finished(batch.status);
  if (batch.status === "forming") return finished("forming");
  const active = activeRuns(batch, runByKey);
  if (active.length === 0) {
    // Checked on this machine: the clock is the check that runs now, the estimate the earlier local checks.
    const check = batch.probes.find((probe) => (probe.status === "queued" || probe.status === "running") && probe.run === undefined);
    return running(check?.startedAt ?? batch.startedAt, localCheckEstimate(batches), now);
  }
  const started = active.filter((run) => run.status === "running");
  if (started.length === 0) {
    const oldest = active.map((run) => run.createdAt).filter((at): at is string => !!at).sort()[0];
    return waiting(oldest, now);
  }
  const each = started.map((run) => runProgress(run, runs, now));
  const unknown = each.find((progress) => progress.state === "indeterminate");
  let chosen = unknown ?? each[0]!;
  if (!unknown) for (const progress of each) if ((progress.remainingMs ?? 0) > (chosen.remainingMs ?? 0)) chosen = progress;
  const result: Progress = { ...chosen, likelyStuck: each.some((progress) => progress.likelyStuck) };
  if (started.length < active.length || unknown) delete result.etaAt;
  return result;
}
