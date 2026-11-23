// The queue engine's state, inputs, effects and settings. Everything here is plain data: the state
// is stored as JSON between steps, and the caller performs the effects and feeds the results back.

import type { BatchMemberState, Ref, RunStatus } from "../model/types.ts";

// ---------------------------------------------------------------- settings

/** How a failing test file is tied to a touched path. All patterns are regular expression sources. */
export interface MappingRule {
  /** Matches the end of a test file's name; what is left is the test's key. */
  testSuffix: string;
  /** Matches the end of a source file's name. */
  sourceSuffix: string;
  /** Removed from the start of a test's key, for numbered test files. Empty for none. */
  stripPrefix: string;
  /** Folder names whose child folders name a feature: a test whose key starts with the child's name belongs to it. */
  featureFolders: string[];
  /** Pairs the name rules miss: a test whose key starts with `test` points at any touched path under `path`. */
  aliases: { test: string; path: string }[];
}

export interface QueueConfig {
  /** Batch size n = clamp(round(c / p), min, max), p being the measured failure rate. */
  batch: {
    min: number;
    max: number;
    /** c when the culprit is found by plain bisect. */
    cBisect: number;
    /** c when failing tests are mapped to a member first. */
    cMapping: number;
    /** p never goes below this. */
    pFloor: number;
    /** p is taken over this many latest outcomes. */
    window: number;
    /** Pick n by the throughput model once this many outcomes are known; before that, c / p. */
    minOutcomes: number;
    /** Off: always c / p. */
    model: boolean;
    /** f: the extra cost of a red run, as a share of a full run. The starting value: the queue's own measured reruns pull it away (see `measuredRates`). */
    rerunCost: number;
  };
  /** How many times the failed files of a red run are run again on the same commit before the run counts as red. */
  rerunCount: number;
  /** A report naming more failing files than this gets no rerun and no mapping. */
  reportFileCap: number;
  /** A cancelled run is started again until it has been started this many times. */
  maxRunAttempts: number;
  /** Map failing test files to the likely member before bisecting. */
  mapping: { enabled: boolean; rule: MappingRule };
  /** Stage 3. The queue is the only writer of the main branch: a move it did not make is reported. */
  onlyWriter: boolean;
  /**
   * What to do when the same files fail and then pass on rerun in two batches in a row.
   * "off": file a flake as usual. "report": report the pattern instead of a flake and merge.
   * "hold": report it and pause the queue before the merge, for a person to decide.
   */
  orderDependence: "off" | "report" | "hold";
  /** Reuse the result of a commit (or, for a failure, of a tree) that was already tested. */
  reuseResults: boolean;
  /** Finished batches kept in the state. */
  keepBatches: number;
  /** Step records kept per batch and for the queue. */
  historyLimit: number;
  /** Tested commits remembered for reuse. */
  knownLimit: number;
}

// ---------------------------------------------------------------- state

/** A change that is ready to merge: waiting, or a member of the current batch. */
export interface QueueEntry {
  change: Ref;
  /** The head the change had when it became ready: the revision that was approved. */
  sha: string;
  /** The paths the change touches, for the mapping. */
  paths: string[];
  readyAt: string;
  /** The commit the queue last built for this change. A head report naming it is the queue's own doing. */
  chainSha?: string;
}

export interface FailureReport {
  /** Failing test files, at most `reportFileCap`. */
  files: string[];
  excerpt: string;
  /** How many failing files were left out beyond the cap. */
  more?: number;
}

/** One run the queue asked for: the full suite on a prefix of the chain, or a rerun of failed files. */
export interface QueueProbe {
  /** Names the run in effects and inputs. Changes when a cancelled run is started again. */
  id: string;
  /** How many members from the start of the chain the commit covers. */
  prefix: number;
  sha: string;
  kind: "full" | "rerun";
  status: RunStatus;
  /** The files a rerun runs. */
  files?: string[];
  attempts: number;
  report?: FailureReport;
  /** How long the run took, in milliseconds, when the caller measured it. */
  ms?: number;
  /** The host's run, when the caller named it. */
  run?: Ref;
  /** The result was taken from an earlier run of the same commit or tree; no run was started. */
  reused?: boolean;
  /** The engine has acted on the result. */
  handled: boolean;
  startedAt: string;
  finishedAt?: string;
}

export interface QueueMember {
  change: Ref;
  /** The approved head the chain commit was built from. */
  head: string;
  /** The member's commit in the chain. Empty while the chain is being built. */
  sha: string;
  /** The tree of the chain commit, when the caller reported it. */
  tree?: string;
  paths: string[];
  state: BatchMemberState;
}

/** What one step did to a batch, and what set it off. */
export interface StepRecord {
  at: string;
  /** The input's kind, and who sent it when the input says. */
  trigger: string;
  did: string[];
}

export interface QueueBatch {
  id: number;
  status: "building" | "testing" | "done";
  /** The main branch commit the chain is built on. */
  base: string;
  members: QueueMember[];
  /** The longest prefix that is merged. */
  good: number;
  /** The shortest prefix known red; null until a run of this batch is red. */
  bad: number | null;
  /** The 1-based position the mapping points at. */
  suspect: number | null;
  /** The mapping ran on this batch's first red result. */
  mapped: boolean;
  /** The 1-based position of the member that was sent back as the culprit. */
  culprit: number | null;
  probes: QueueProbe[];
  /** A green prefix waiting to be merged. */
  toMerge?: { prefix: number; probe: string };
  /** A fast-forward the caller was asked for and has not answered. */
  merge?: { prefix: number; to: string; expect: string };
  /** Test files that failed and then passed on a rerun in this batch. */
  passedOnRerun: string[];
  /** The end of the log of the failed run those files came from, kept after the batch merges. */
  flakeExcerpt?: string;
  /** Why the batch ended, in words. */
  note: string;
  history: StepRecord[];
  startedAt: string;
  finishedAt?: string;
}

/** One change's result in the queue: merged, or the culprit of a red batch. Flakes are not failures. */
export interface Outcome {
  change: string;
  ok: boolean;
}

/** The final result of a tested commit. */
export interface KnownResult {
  sha: string;
  tree?: string;
  result: "passed" | "failed";
  report?: FailureReport;
  run?: Ref;
  batch: number;
  /** refKeys of the members the commit covers. */
  members: string[];
}

export interface QueueCounters {
  batches: number;
  merged: number;
  culprits: number;
  bisections: number;
  runs: number;
  reruns: number;
  runsReused: number;
  flakes: number;
  conflicts: number;
}

/**
 * What the queue measured about its own runs, as sums so the state stays small (docs/BATCH_SIZE.md).
 * Absent in a state stored before the measuring existed: it counts as nothing measured.
 */
export interface Measured {
  /** Full runs that ended green or red, by prefix length x (members covered) and duration y (ms): the sums of a least squares line. */
  d: { n: number; sx: number; sy: number; sxx: number; sxy: number };
  /** Reruns paired with the red full run of the same commit: the rerun's total ms and that run's total ms. f is their ratio. */
  f: { n: number; rerunMs: number; fullMs: number };
  /** Batches ended by a culprit while the mapping was on: how many, and in how many the failure report pointed at the member that was the culprit. s is their ratio. */
  s: { n: number; named: number };
}

export interface QueueState {
  v: 1;
  /** The main branch head as last reported. Nothing is built until it is known. */
  main?: string;
  paused?: { reason: string; by: string; at: string };
  /** Ready changes, in the order they became ready. Members of the current batch stay here until they merge or leave. */
  entries: QueueEntry[];
  /** refKeys of the changes that lead the next batch, in order. */
  leaders: string[];
  /** Oldest first. The last one is the current batch unless it is done. */
  batches: QueueBatch[];
  nextBatch: number;
  outcomes: Outcome[];
  known: KnownResult[];
  /** The files that passed only on rerun in the latest batch that ran tests. */
  flaky?: { batch: number; files: string[] };
  /** What the latest steps did, including those that found nothing to do. */
  steps: StepRecord[];
  counters: QueueCounters;
  measured?: Measured;
}

// ---------------------------------------------------------------- inputs

/** One member's place in a built chain, or why it has none. `with` is absent when it conflicts with the base. */
export type ChainResult = { change: Ref; sha: string; tree?: string } | { change: Ref; conflict: { with?: Ref } };

export type RunOutcome = "pass" | "fail" | "cancelled";

interface InputBase {
  /** Who or what caused the input ("poll", or the person who asked), for the history. */
  by?: string;
}

export type QueueInput = InputBase &
  (
    | { kind: "change-ready"; change: Ref; sha: string; paths: string[] }
    /** Closed, merged elsewhere, or no longer approved. */
    | { kind: "change-left"; change: Ref }
    /** The change's head as the host shows it now. */
    | { kind: "change-head"; change: Ref; sha: string; paths?: string[] }
    | { kind: "chain-built"; batch: number; results: ChainResult[] }
    | { kind: "chain-failed"; batch: number; reason: string }
    | { kind: "run-started"; run: string; ref?: Ref }
    /** `ms`: how long the run took, for the measuring; leave it out for a run that was cut short. */
    | { kind: "run-finished"; run: string; sha: string; outcome: RunOutcome; report?: { files: string[]; excerpt?: string }; ref?: Ref; ms?: number }
    /** `ran` lists the test files the rerun really ran. */
    | { kind: "rerun-finished"; run: string; sha: string; outcome: RunOutcome; ran?: string[]; report?: { files: string[]; excerpt?: string }; ref?: Ref; ms?: number }
    /** The answer to a fast-forward effect. `main` is the main branch head afterwards, when known. */
    | { kind: "merge-result"; batch: number; to: string; ok: boolean; main?: string }
    /** The main branch head as the host shows it now. Send these in the order they were seen. */
    | { kind: "main-moved"; sha: string }
    | { kind: "pause"; reason: string }
    | { kind: "resume" }
    /** Nothing happened; lets the queue go on with what it has. */
    | { kind: "tick" }
  );

// ---------------------------------------------------------------- effects

export type SendBackReason =
  /** Does not apply on the base plus the members ahead of it. `with` is the change it conflicts with, when known. */
  | { kind: "conflict"; with?: Ref; ahead: Ref[]; base: string }
  | { kind: "culprit"; prefix: number; chainSha: string; files: string[]; excerpt: string; run?: Ref };

export type QueueEffect =
  /** Replay each change, in order, on the previous one that applied, starting at the base. Answer with chain-built. */
  | { kind: "build-chain"; batch: number; base: string; changes: { change: Ref; sha: string }[] }
  /** Run the full suite on the commit. Answer with run-finished. */
  | { kind: "start-run"; batch: number; run: string; prefix: number; sha: string }
  /** Run only these test files on the same commit. Answer with rerun-finished. */
  | { kind: "rerun-files"; batch: number; run: string; prefix: number; sha: string; files: string[] }
  /** Fast-forward the main branch to `to`, only if it is at `expect`. Answer with merge-result. */
  | { kind: "fast-forward"; batch: number; prefix: number; to: string; expect: string }
  /** These changes are in the main branch. `tested` is the commit whose run passed with them in it. */
  | { kind: "mark-merged"; batch: number; members: { change: Ref; sha: string; head: string }[]; tested?: string; run?: Ref; outside?: true }
  | { kind: "send-back"; change: Ref; sha: string; batch?: number; reason: SendBackReason }
  | { kind: "file-flake"; batch: number; files: string[]; sha: string; run?: Ref; excerpt?: string }
  /** The same files failed and then passed on rerun in two batches in a row: not a flake. */
  | { kind: "suspect-order-dependence"; files: string[]; batches: number[]; sha: string; excerpt?: string }
  /** The run's result is no longer needed. */
  | { kind: "cancel-run"; batch: number; run: string; sha: string }
  | { kind: "report-outside-write"; sha: string; batch?: number }
  | { kind: "report-problem"; message: string }
  /** Nothing to do, and why. */
  | { kind: "idle"; reason: string };

export interface StepResult {
  state: QueueState;
  effects: QueueEffect[];
}
