import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyResult, nextProbe } from "./bisect.ts";
import { configWith, defaultConfig, defaultMappingRule } from "./config.ts";
import { mapCulprit, relates, testKey } from "./mapping.ts";
import { capReport, rerunRan, usableFiles } from "./report.ts";
import { batchSize, bestSize, failureRate, measuredRates, remember, ruleSize, throughput } from "./sizing.ts";
import type { MappingRule, Outcome } from "./types.ts";

const outcomes = (fails: number, total: number): Outcome[] => Array.from({ length: total }, (_, i) => ({ change: `c${i + 1}`, ok: i >= fails }));
const bounds = defaultConfig.batch;

describe("batch size", () => {
  it("is clamp(round(c / p), min, max) with p floored", () => {
    assert.equal(ruleSize([], bounds, true), 12); // 1 / 0.03 = 33
    assert.equal(ruleSize([], bounds, false), 12); // 0.7 / 0.03 = 23
    assert.equal(ruleSize(outcomes(3, 30), bounds, true), 10); // 1 / 0.1
    assert.equal(ruleSize(outcomes(3, 30), bounds, false), 7); // 0.7 / 0.1
    assert.equal(ruleSize(outcomes(6, 30), bounds, true), 5); // 1 / 0.2
    assert.equal(ruleSize(outcomes(6, 30), bounds, false), 4); // 3.5 rounds to 4
    assert.equal(ruleSize(outcomes(15, 30), bounds, true), 2);
    assert.equal(ruleSize(outcomes(30, 30), bounds, false), 2); // 0.7 rounds to 1, clamped
    assert.equal(ruleSize(outcomes(1, 98).slice(-30), bounds, true), 12);
  });

  it("takes its bounds from the settings", () => {
    const wide = configWith({ batch: { min: 1, max: 40 } }).batch;
    assert.equal(ruleSize([], wide, true), 33);
    assert.equal(ruleSize(outcomes(30, 30), wide, false), 1);
    assert.equal(ruleSize(outcomes(3, 30), { ...wide, cMapping: 2 }, true), 20);
  });

  it("takes p over the latest outcomes only", () => {
    const old = outcomes(20, 20); // all failed, but older than the window
    assert.equal(failureRate([...old, ...outcomes(0, 30)], bounds), 0.03);
    assert.ok(Math.abs(failureRate(outcomes(1, 10), bounds) - 0.1) < 1e-9);
    const kept = remember(outcomes(0, 30), [{ change: "c99", ok: false }], bounds);
    assert.equal(kept.length, 30);
    assert.deepEqual(kept.at(-1), { change: "c99", ok: false });
  });
});

describe("batch size from the throughput model", () => {
  const wide = { ...bounds, min: 1, max: 300 };
  // The table in docs/BATCH_SIZE.md: q = 0.03, f = 0.15. Optimal n and throughput per p, plain bisect and mapping.
  const table: [number, number, number, number, number][] = [
    // p, n (s=0), throughput, n (s=0.5), throughput
    [0.02, 31, 6.4, 61, 9.31],
    [0.05, 13, 3.05, 21, 4.21],
    [0.1, 7, 1.77, 11, 2.31],
    [0.15, 4, 1.28, 7, 1.61],
    [0.2, 3, 1.02, 5, 1.24],
    [0.3, 2, 0.73, 3, 0.84],
  ];
  for (const [p, n0, t0, n5, t5] of table) {
    it(`reproduces the report at p = ${p}`, () => {
      const a = bestSize(p, 0.03, 0.15, 0, 1, 300);
      const b = bestSize(p, 0.03, 0.15, 0.5, 1, 300);
      assert.ok(Math.abs(a - n0) <= 1, `s=0: ${a} vs ${n0}`);
      assert.ok(Math.abs(b - n5) <= 1, `s=0.5: ${b} vs ${n5}`);
      assert.ok(Math.abs(throughput(n0, p, 0.03, 0.15, 0) - t0) < 0.02);
      assert.ok(Math.abs(throughput(n5, p, 0.03, 0.15, 0.5) - t5) < 0.02);
    });
  }

  it("matches no batching at n = 1", () => {
    assert.ok(Math.abs(throughput(1, 0.05, 0.03, 0.15, 0) - 0.94) < 0.01);
    assert.ok(Math.abs(throughput(1, 0.3, 0.03, 0.15, 0) - 0.67) < 0.01);
  });

  it("never gives a larger n for a higher p", () => {
    let last = Infinity;
    for (const p of [0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3]) {
      const n = bestSize(p, 0.03, 0.15, 0, 1, 300);
      assert.ok(n <= last);
      last = n;
    }
  });

  it("stays in [min, max]", () => {
    assert.equal(bestSize(0.02, 0.03, 0.15, 0, 2, 12), 12);
    assert.equal(bestSize(0.3, 0.03, 0.15, 0, 5, 12), 5);
  });

  it("falls back to c / p with too few outcomes, and uses the model after", () => {
    assert.equal(batchSize(outcomes(1, 9), wide, false), ruleSize(outcomes(1, 9), wide, false));
    const o = outcomes(3, 30); // p = 0.1
    assert.equal(batchSize(o, wide, false), bestSize(0.1, 0.03, 0.15, 0, 1, 300));
    assert.equal(batchSize(o, { ...wide, model: false }, false), 7);
  });

  it("batches less when runs flake more", () => {
    const o = outcomes(3, 30);
    const calm = batchSize(o, wide, false, { runs: 100, flakes: 0 });
    const flaky = batchSize(o, wide, false, { runs: 100, flakes: 40 });
    assert.ok(flaky <= calm);
  });
});

describe("which prefix to test", () => {
  it("tests the whole chain first, merges when it is green", () => {
    assert.deepEqual(nextProbe(5, 0, null), { kind: "test", k: 5 });
    assert.deepEqual(nextProbe(5, 5, null), { kind: "merged" });
  });

  it("bisects rounding up", () => {
    assert.deepEqual(nextProbe(10, 0, 10), { kind: "test", k: 5 });
    assert.deepEqual(nextProbe(10, 5, 10), { kind: "test", k: 8 });
    assert.deepEqual(nextProbe(10, 5, 8), { kind: "test", k: 7 });
    assert.deepEqual(nextProbe(10, 7, 8), { kind: "culprit", k: 8 });
    assert.deepEqual(nextProbe(3, 0, 3), { kind: "test", k: 2 }); // odd: the larger part is the prefix
    assert.deepEqual(nextProbe(1, 0, 1), { kind: "culprit", k: 1 });
    assert.deepEqual(nextProbe(4, 3, 4), { kind: "culprit", k: 4 });
  });

  it("with a mapped culprit k tests prefix k-1 first, then k", () => {
    assert.deepEqual(nextProbe(6, 0, 6, 4), { kind: "test", k: 3 });
    assert.deepEqual(nextProbe(6, 3, 6, 4), { kind: "test", k: 4 });
    assert.deepEqual(nextProbe(6, 3, 4, 4), { kind: "culprit", k: 4 });
    assert.deepEqual(nextProbe(6, 0, 6, 1), { kind: "test", k: 1 }); // prefix 0 is the base, known green
    assert.deepEqual(nextProbe(6, 5, 6, 6), { kind: "culprit", k: 6 });
  });

  it("drops a suspect the results contradict", () => {
    let s = applyResult({ good: 0, bad: 6, suspect: 4 }, 3, false);
    assert.deepEqual(s, { good: 0, bad: 3, suspect: null });
    assert.deepEqual(nextProbe(6, s.good, s.bad, s.suspect), { kind: "test", k: 2 });
    s = applyResult({ good: 3, bad: 6, suspect: 4 }, 4, true);
    assert.deepEqual(s, { good: 4, bad: 6, suspect: null });
    assert.deepEqual(nextProbe(6, s.good, s.bad, s.suspect), { kind: "test", k: 5 });
  });

  it("finds the first bad member for every culprit position and batch size, never testing a prefix twice", () => {
    for (let n = 1; n <= 12; n++) {
      for (let culprit = 1; culprit <= n; culprit++) {
        let s = { good: 0, bad: null as number | null, suspect: null as number | null };
        const tested: number[] = [];
        for (;;) {
          const next = nextProbe(n, s.good, s.bad, s.suspect);
          if (next.kind === "culprit") {
            assert.equal(next.k, culprit);
            break;
          }
          assert.equal(next.kind, "test");
          if (next.kind !== "test") break;
          assert.ok(!tested.includes(next.k));
          tested.push(next.k);
          s = applyResult(s, next.k, next.k < culprit);
        }
        assert.ok(tested.length <= 1 + Math.ceil(Math.log2(n)));
      }
    }
  });
});

describe("mapping failing tests to a member", () => {
  const rule: MappingRule = { ...defaultMappingRule, stripPrefix: "step\\d+-", aliases: [{ test: "parcel", path: "lib/shipping/" }] };

  it("ties test files to touched paths by the rule", () => {
    assert.equal(testKey("ui/e2e/step02-orders.e2e.mjs", rule), "orders");
    assert.equal(testKey("svc/test/stockCount.test.ts", rule), "stockcount");
    assert.equal(testKey("ui/e2e/step02-orders.e2e.mjs", defaultMappingRule), "step02-orders");
    assert.ok(relates("svc/test/stockCount.test.ts", "svc/test/stockCount.test.ts", rule));
    assert.ok(relates("svc/test/pricing.test.ts", "svc/src/pricing.ts", rule));
    assert.ok(relates("ui/e2e/ordersListSort.e2e.mjs", "ui/src/features/orders/List.tsx", rule));
    assert.ok(relates("ui/e2e/step03-returns.e2e.mjs", "ui/src/features/returns/Page.tsx", rule));
    assert.ok(relates("svc/test/parcelLabel.test.ts", "lib/shipping/label.ts", rule));
    assert.ok(!relates("svc/test/parcelLabel.test.ts", "lib/shipping/label.ts", defaultMappingRule));
    assert.ok(!relates("ui/e2e/pricing.e2e.mjs", "ui/src/features/orders/List.tsx", rule));
    assert.ok(!relates("svc/test/pricing.test.ts", "notes/plan.md", rule));
  });

  it("takes the feature folders from the rule", () => {
    const modules: MappingRule = { ...defaultMappingRule, featureFolders: ["modules"] };
    assert.ok(relates("e2e/ordersExport.e2e.mjs", "src/modules/orders/export.ts", modules));
    assert.ok(!relates("e2e/ordersExport.e2e.mjs", "src/features/orders/export.ts", modules));
  });

  it("names a suspect only when exactly one member matches", () => {
    const touched = [["notes/a.md"], ["ui/src/features/orders/List.tsx"], ["svc/src/stock.ts"]];
    assert.equal(mapCulprit(["ui/e2e/orders.e2e.mjs"], touched, rule), 2);
    assert.equal(mapCulprit(["ui/e2e/orders.e2e.mjs", "svc/test/stock.test.ts"], touched, rule), null);
    assert.equal(mapCulprit(["ui/e2e/returns.e2e.mjs"], touched, rule), null);
    assert.equal(mapCulprit([], touched, rule), null);
  });
});

describe("failure reports", () => {
  it("caps the failing files and checks that a rerun ran them", () => {
    const many = Array.from({ length: 70 }, (_, i) => `svc/test/t${i}.test.ts`);
    const capped = capReport({ files: many, excerpt: "x".repeat(5000) }, 50);
    assert.equal(capped.files.length, 50);
    assert.equal(capped.more, 20);
    assert.ok(capped.excerpt.length < 1600);
    assert.ok(!usableFiles(capped));
    assert.ok(usableFiles(capReport({ files: ["a.test.ts"] }, 50)));
    assert.ok(!usableFiles(capReport({ files: [] }, 50)));
    assert.ok(!usableFiles(undefined));
    assert.ok(rerunRan(["a.test.ts"], ["b.test.ts", "a.test.ts"]));
    assert.ok(!rerunRan(["a.test.ts", "c.test.ts"], ["a.test.ts"]));
    assert.ok(!rerunRan(["a.test.ts"], undefined));
    assert.ok(!rerunRan([], ["a.test.ts"]));
  });
});

describe("measured rates", () => {
  const empty = () => ({ d: { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 }, f: { n: 0, rerunMs: 0, fullMs: 0 }, s: { n: 0, named: 0 } });
  const sums = (points: [number, number][]) => ({ ...empty(), d: points.reduce((a, [x, y]) => ({ n: a.n + 1, sx: a.sx + x, sy: a.sy + y, sxx: a.sxx + x * x, sxy: a.sxy + x * y }), empty().d) });

  it("are the defaults until something is measured", () => {
    for (const measured of [undefined, empty()]) {
      const rates = measuredRates(measured, bounds, true);
      assert.deepEqual([rates.f, rates.s, rates.d], [bounds.rerunCost, 0.5, undefined]);
    }
    assert.equal(measuredRates(undefined, bounds, false).s, 0);
  });

  it("move f towards the measured rerun cost, a few runs at a time", () => {
    const one = { ...empty(), f: { n: 1, rerunMs: 100, fullMs: 1000 } };
    const many = { ...empty(), f: { n: 40, rerunMs: 4000, fullMs: 40000 } };
    assert.ok(Math.abs(measuredRates(one, bounds, true).f - (0.1 + 4 * 0.15) / 5) < 1e-9);
    assert.ok(Math.abs(measuredRates(many, bounds, true).f - 0.1) < 0.01);
    const whole = { ...empty(), f: { n: 40, rerunMs: 40000, fullMs: 40000 } };
    assert.ok(measuredRates(whole, bounds, true).f > 0.9);
  });

  it("move s towards how often the report named the culprit, and stay 0 without the mapping", () => {
    const never = { ...empty(), s: { n: 36, named: 0 } };
    const always = { ...empty(), s: { n: 36, named: 36 } };
    assert.ok(measuredRates(never, bounds, true).s < 0.06);
    assert.ok(measuredRates(always, bounds, true).s > 0.94);
    assert.equal(measuredRates(always, bounds, false).s, 0);
  });

  it("fit the duration of a run as a line in the members it covers, once there are enough runs", () => {
    const line = measuredRates(sums([[1, 70], [2, 80], [3, 90], [4, 100], [5, 110], [6, 120]]), bounds, true).d;
    assert.ok(line && Math.abs(line(4) - 100) < 1e-6 && Math.abs(line(12) - 180) < 1e-6);
    assert.equal(measuredRates(sums([[1, 70], [2, 80], [3, 90]]), bounds, true).d, undefined, "too few runs");
    assert.equal(measuredRates(sums([[3, 70], [3, 80], [3, 90], [3, 100], [3, 110], [3, 120]]), bounds, true).d, undefined, "one length only");
    assert.equal(measuredRates(sums([[1, 120], [2, 110], [3, 100], [4, 90], [5, 80], [6, 70]]), bounds, true).d, undefined, "a falling line is noise");
  });

  it("change the batch size: costly reruns and steeply growing runs do not make batches larger", () => {
    const o = outcomes(2, 30);
    const base = batchSize(o, bounds, true, undefined, undefined);
    const wholeReruns = batchSize(o, bounds, true, undefined, { ...empty(), f: { n: 40, rerunMs: 40000, fullMs: 40000 } });
    assert.ok(wholeReruns <= base);
    assert.equal(batchSize(o, bounds, true, { runs: 10, flakes: 0 }), batchSize(o, bounds, true, { runs: 10, flakes: 0 }, empty()));
    const steep = sums([[1, 100], [2, 200], [3, 400], [4, 800], [5, 1600], [6, 3200], [8, 6400]]);
    assert.ok(batchSize(o, bounds, true, undefined, steep) <= base);
  });

  it("throughput with a flat duration is the throughput without one, in that duration's unit", () => {
    for (const n of [1, 4, 12]) assert.ok(Math.abs(throughput(n, 0.1, 0.03, 0.15, 0.5, () => 7) * 7 - throughput(n, 0.1, 0.03, 0.15, 0.5)) < 1e-9);
  });
});
