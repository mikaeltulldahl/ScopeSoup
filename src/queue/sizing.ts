// Batch size from the measured failure rate.

import type { Measured, Outcome, QueueConfig } from "./types.ts";

type Bounds = QueueConfig["batch"];

/** The share of the latest outcomes that failed, floored. */
export function failureRate(outcomes: readonly Outcome[], bounds: Bounds): number {
  const recent = outcomes.slice(-bounds.window);
  const p = recent.length === 0 ? 0 : recent.filter((o) => !o.ok).length / recent.length;
  return Math.max(bounds.pFloor, p);
}

/** n = clamp(round(c / p), min, max). The rule used before the model has data. */
export function ruleSize(outcomes: readonly Outcome[], bounds: Bounds, mapping: boolean): number {
  const c = mapping ? bounds.cMapping : bounds.cBisect;
  // The epsilon keeps exact halves (0.7 / 0.2 = 3.4999...) rounding up, as on paper.
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(c / failureRate(outcomes, bounds) + 1e-9)));
}

/**
 * Expected merged changes per check run for a batch of n (docs/BATCH_SIZE.md, "The math").
 * The exact model: every change is bad with probability p, a full
 * run costs 1, a red run costs a further f, a run flakes red with probability q, and the culprit
 * is found by bisection. With probability s the failure report names the culprit, and then only
 * prefix k-1 is run. A batch whose first bad change is k merges the k-1 changes before it.
 */
export function throughput(n: number, p: number, q: number, f: number, s: number, d?: (prefix: number) => number): number {
  // What a run of the first m changes takes: 1 for every m unless the queue measured otherwise.
  const u = (m: number): number => (d ? d(m) : 1);
  const red = (m: number, k: number): number => u(m) * (1 + f * (m >= k ? 1 : q));
  const costWithBad = (k: number, mapped: boolean): number => {
    const cost = u(n) * (1 + f); // the full prefix, red
    if (n === 1) return cost;
    if (mapped) return k > 1 ? cost + red(k - 1, k) : cost;
    let sum = cost;
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const m = Math.floor((lo + hi) / 2);
      sum += red(m, k);
      if (m >= k) hi = m;
      else lo = m;
    }
    return sum;
  };
  const allGood = (1 - p) ** n;
  let cost = allGood * u(n) * (1 + f * q);
  let merged = allGood * n;
  for (let k = 1; k <= n; k++) {
    const pk = (1 - p) ** (k - 1) * p;
    for (const [mapped, w] of [[false, 1 - s], [true, s]] as const) {
      if (w === 0) continue;
      cost += pk * w * costWithBad(k, mapped);
      merged += pk * w * (k - 1);
    }
  }
  return merged / cost;
}

/** The n in [min, max] with the highest throughput. The smallest n wins a tie. */
export function bestSize(p: number, q: number, f: number, s: number, min: number, max: number, d?: (prefix: number) => number): number {
  let best = min;
  let top = -Infinity;
  for (let n = min; n <= max; n++) {
    const t = throughput(n, p, q, f, s, d);
    if (t > top + 1e-12) {
      top = t;
      best = n;
    }
  }
  return best;
}

/** What the queue has counted about runs; the same fields as `QueueState.counters`. */
export interface RunCounts {
  runs: number;
  flakes: number;
}

/** How many pseudo-samples of the default each measured rate starts with: a few runs move it, one does not. */
const PRIOR = 4;
/** Full runs and distinct prefix lengths needed before the duration is fitted as a line. */
const MIN_DURATION_RUNS = 6;

/** The model's inputs f, s and d(m) as the queue's own runs measured them, with the defaults as the starting point. */
export interface Rates {
  /** The extra cost of a red run, as a share of the full run. */
  f: number;
  /** The chance that the failure report names the culprit. */
  s: number;
  /** The duration of a run of the first m changes, in ms; absent until measured (every run then counts as equal). */
  d?: (prefix: number) => number;
}

/**
 * f: the measured rerun time over the red run time it repeats, mixed with `rerunCost` as if it had
 * been seen `PRIOR` times. s: the share of culprit batches whose failure report named the culprit,
 * mixed with the default 0.5 the same way; 0 with the mapping off. d: a line through the full runs'
 * duration against the members they cover, once there are enough runs of different lengths.
 */
export function measuredRates(measured: Measured | undefined, bounds: Bounds, mapping: boolean): Rates {
  let f = bounds.rerunCost;
  if (measured && measured.f.n > 0 && measured.f.fullMs > 0) {
    const seen = Math.min(2, Math.max(0.01, measured.f.rerunMs / measured.f.fullMs));
    f = (measured.f.n * seen + PRIOR * bounds.rerunCost) / (measured.f.n + PRIOR);
  }
  const s = mapping ? ((measured?.s.named ?? 0) + PRIOR * 0.5) / ((measured?.s.n ?? 0) + PRIOR) : 0;
  const rates: Rates = { f, s };
  const m = measured?.d;
  if (m && m.n >= MIN_DURATION_RUNS) {
    const mean = m.sy / m.n;
    const spread = m.sxx - (m.sx * m.sx) / m.n;
    const slope = spread > 1e-9 ? (m.sxy - (m.sx * m.sy) / m.n) / spread : 0;
    if (mean > 0 && slope > 0) {
      const at = mean - (slope * m.sx) / m.n;
      // A run is never taken as free: the line is floored at a twentieth of the mean.
      rates.d = (prefix) => Math.max(at + slope * prefix, mean / 20);
    }
  }
  return rates;
}

/**
 * The batch size: the model's best n when there are at least `bounds.minOutcomes` outcomes,
 * otherwise (or with `bounds.model` off) the c / p rule.
 *
 * Measured: p (culprit rate over the window, floored) and q (flaky batches per full run, over
 * all runs so far). With `measured` (what the queue timed): f, s and the duration d(m) come from
 * the queue's own runs (`measuredRates`); without, f is `bounds.rerunCost`, s is 0.5 with the
 * mapping on and 0 off (the values c = 1.0 and c = 0.7 were fitted for), and every run counts as equal.
 */
export function batchSize(outcomes: readonly Outcome[], bounds: Bounds, mapping: boolean, counts?: RunCounts, measured?: Measured): number {
  if (!bounds.model || outcomes.length < bounds.minOutcomes) return ruleSize(outcomes, bounds, mapping);
  const q = counts && counts.runs > 0 ? Math.min(0.5, counts.flakes / counts.runs) : 0.03;
  const { f, s, d } = measuredRates(measured, bounds, mapping);
  return bestSize(failureRate(outcomes, bounds), q, f, s, bounds.min, bounds.max, d);
}

/** Appends outcomes, keeping only the window. */
export function remember(outcomes: readonly Outcome[], add: readonly Outcome[], bounds: Bounds): Outcome[] {
  return [...outcomes, ...add].slice(-bounds.window);
}
