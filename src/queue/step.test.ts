import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { refKey } from "../model/types.ts";
import { configWith } from "./config.ts";
import { initialState } from "./state.ts";
import { step } from "./step.ts";
import { World, ref } from "./testWorld.ts";
import { toBatch } from "./toBatch.ts";
import type { Outcome } from "./types.ts";

const kinds = (effects: { kind: string }[]) => effects.map((e) => e.kind);

describe("a green batch", () => {
  it("does nothing without ready changes", () => {
    const w = new World();
    assert.deepEqual(w.start(), [{ kind: "idle", reason: "no change is ready" }]);
    assert.deepEqual(w.state.batches, []);
  });

  it("waits until the main branch head is known", () => {
    const w = new World();
    w.add(1);
    assert.deepEqual(w.effects, [{ kind: "idle", reason: "the main branch head is not known" }]);
  });

  it("merges all: one chain, one run, one fast-forward to the chain's tip", () => {
    const w = new World();
    for (const n of [1, 2, 3]) w.add(n);
    assert.deepEqual(kinds(w.start()), ["build-chain"]);
    assert.deepEqual(kinds(w.deliver()), ["start-run"]);
    assert.deepEqual(kinds(w.deliver()), ["fast-forward"]);
    const tip = w.batch(1).members[2]!.sha;
    assert.deepEqual(w.of("fast-forward"), [{ kind: "fast-forward", batch: 1, prefix: 3, to: tip, expect: "m0" }]);
    assert.deepEqual(kinds(w.deliver()), ["mark-merged"]);
    const marked = w.of("mark-merged")[0]!;
    assert.equal(marked.tested, tip);
    assert.deepEqual(marked.run, { host: "test", kind: "run", id: "1.1" });
    assert.deepEqual(w.merged, ["1", "2", "3"]);
    assert.equal(w.main, tip);
    assert.deepEqual(w.commits.get(w.main), ["1", "2", "3"]);
    assert.equal(w.batch(1).note, "all 3 merged");
    assert.deepEqual(w.state.entries, []);
    assert.deepEqual(w.send({ kind: "tick" }), [{ kind: "idle", reason: "no change is ready" }]);
    assert.deepEqual(w.state.counters, { batches: 1, merged: 3, culprits: 0, bisections: 0, runs: 1, reruns: 0, runsReused: 0, flakes: 0, conflicts: 0 });
  });

  it("starts the next batch from what became ready meanwhile", () => {
    const w = new World();
    w.run([1]);
    w.add(2);
    w.drive();
    assert.deepEqual(w.merged, ["1", "2"]);
    assert.equal(w.batch(2).base, w.batch(1).members[0]!.sha);
  });
});

describe("a red batch", () => {
  it("with a mapped culprit k tests prefix k-1, merges it, sends k back and rebuilds the rest", () => {
    const w = new World();
    for (const n of [1, 2, 3, 4, 5]) w.add(n, n === 3 ? ["ui/src/features/orders/List.tsx"] : undefined);
    w.bad.set("3", ["ui/e2e/orders.e2e.mjs"]);
    w.start();
    w.drive();
    // The whole chain red, its rerun red, then prefix 2 (k-1) green, prefix 3 red and its rerun red.
    assert.deepEqual(w.runs.slice(0, 5), ["5", "5r", "2", "3", "3r"]);
    const b1 = w.batch(1);
    assert.deepEqual([b1.status, b1.good, b1.culprit, b1.mapped], ["done", 2, 3, true]);
    assert.deepEqual(b1.members.map((m) => m.state), ["merged", "merged", "culprit", "requeued", "requeued"]);
    const back = w.of("send-back");
    assert.equal(back.length, 1);
    assert.deepEqual(back[0]!.change, ref(3));
    assert.equal(back[0]!.sha, w.changes.get("3")!.head);
    assert.equal(back[0]!.reason.kind, "culprit");
    if (back[0]!.reason.kind === "culprit") {
      assert.deepEqual(back[0]!.reason.files, ["ui/e2e/orders.e2e.mjs"]);
      assert.match(back[0]!.reason.excerpt, /FAIL ui\/e2e\/orders\.e2e\.mjs/);
      assert.equal(back[0]!.reason.prefix, 3);
    }
    // Batch 2: changes 4 and 5 rebuilt on the new main branch without change 3, green, merged.
    assert.deepEqual(w.ids(2), ["4", "5"]);
    assert.deepEqual([w.batch(2).status, w.batch(2).good], ["done", 2]);
    assert.deepEqual(w.commits.get(w.main), ["1", "2", "4", "5"]);
    assert.deepEqual(w.merged, ["1", "2", "4", "5"]);
    assert.deepEqual(
      w.state.outcomes.map((o) => `${o.change}:${o.ok}`),
      [1, 2, 3, 4, 5].map((n) => `${refKey(ref(n))}:${n !== 3}`),
    );
  });

  it("bisect rounds up, merges every green prefix and finds the first bad change", () => {
    const w = new World();
    for (let n = 1; n <= 10; n++) w.add(n); // nothing maps
    w.bad.set("7", ["svc/test/api.test.ts"]);
    w.start();
    w.drive();
    assert.deepEqual(w.runs.slice(0, 8), ["10", "10r", "5", "8", "8r", "7", "7r", "6"]);
    assert.equal(w.of("fast-forward").length, 3); // prefix 5, prefix 6, then batch 2 (8, 9, 10)
    const b1 = w.batch(1);
    assert.deepEqual([b1.culprit, b1.good, b1.suspect, b1.mapped], [7, 6, null, true]);
    assert.ok(!w.state.entries.some((e) => e.change.id === "7"));
    assert.deepEqual(w.ids(2), ["8", "9", "10"]);
    assert.deepEqual(w.commits.get(w.main), ["1", "2", "3", "4", "5", "6", "8", "9", "10"]);
    assert.equal(w.state.counters.bisections, 1);
  });

  it("changes after the culprit lead the next batch, which is filled up with newer ones", () => {
    const w = new World();
    for (const n of [1, 2, 3]) w.add(n);
    w.bad.set("2", []); // fails with no failure report: no rerun, no mapping
    w.start();
    w.add(4);
    w.add(5);
    w.drive();
    // Red without files: no rerun; bisect tests prefix 2 (of 1..3, rounded up), then prefix 1.
    assert.deepEqual(w.runs.slice(0, 3), ["3", "2", "1"]);
    assert.deepEqual([w.batch(1).culprit, w.batch(1).good], [2, 1]);
    // 1 of the 2 outcomes so far failed: p = 0.5, so the batch shrinks to 2 (the leader plus change 4).
    assert.deepEqual(w.ids(2), ["3", "4"]);
    assert.deepEqual(w.commits.get(w.batch(2).members[1]!.sha), ["1", "3", "4"]);
    const reason = w.of("send-back")[0]!.reason;
    assert.ok(reason.kind === "culprit" && reason.files.length === 0);
  });

  it("a report naming more files than the cap gets no rerun and no mapping", () => {
    const w = new World();
    for (const n of [1, 2, 3]) w.add(n, n === 2 ? ["svc/src/t0.ts"] : undefined);
    w.bad.set("2", Array.from({ length: 400 }, (_, i) => `svc/test/t${i}.test.ts`));
    w.start();
    w.drive();
    assert.deepEqual(w.runs.slice(0, 3), ["3", "2", "1"]);
    const b1 = w.batch(1);
    assert.deepEqual([b1.culprit, b1.mapped, b1.suspect], [2, false, null]);
    assert.equal(b1.probes[0]!.report!.files.length, 50);
    assert.equal(b1.probes[0]!.report!.more, 350);
  });

  it("with the mapping switched off bisects without naming a suspect", () => {
    const w = new World(configWith({ mapping: { enabled: false } }));
    for (const n of [1, 2, 3, 4, 5]) w.add(n, n === 3 ? ["ui/src/features/orders/List.tsx"] : undefined);
    w.bad.set("3", ["ui/e2e/orders.e2e.mjs"]);
    w.start();
    w.drive();
    assert.deepEqual(w.runs.slice(0, 5), ["5", "5r", "3", "3r", "2"]);
    assert.deepEqual([w.batch(1).culprit, w.batch(1).mapped, w.batch(1).suspect], [3, false, null]);
  });

  it("a batch of one that fails sends its only member back", () => {
    const w = new World(configWith({ rerunCount: 0 }));
    w.bad.set("1", ["svc/test/a.test.ts"]);
    w.run([1]);
    assert.deepEqual(w.runs, ["1"]);
    assert.equal(w.batch(1).culprit, 1);
    assert.deepEqual(w.merged, []);
    assert.equal(w.main, "m0");
  });
});

describe("the flake rerun", () => {
  it("a red run whose failed files pass on rerun is a flake: merged, and the flake is filed", () => {
    const w = new World();
    w.flaky.set(1, ["svc/test/slow.test.ts"]);
    w.run([1, 2]);
    assert.deepEqual(w.runs, ["2", "2r"]);
    const tip = w.batch(1).members[1]!.sha;
    assert.deepEqual(w.of("rerun-files"), [{ kind: "rerun-files", batch: 1, run: "1.2", prefix: 2, sha: tip, files: ["svc/test/slow.test.ts"] }]);
    assert.deepEqual(w.of("file-flake").map((f) => f.files), [["svc/test/slow.test.ts"]]);
    assert.equal(w.main, tip);
    assert.ok(w.state.outcomes.every((o) => o.ok));
    assert.deepEqual(w.batch(1).passedOnRerun, ["svc/test/slow.test.ts"]);
    assert.deepEqual(w.state.flaky, { batch: 1, files: ["svc/test/slow.test.ts"] });
    // The merged batch still says what failed.
    assert.match(w.batch(1).flakeExcerpt ?? "", /FAIL svc\/test\/slow\.test\.ts/);
    assert.match(w.of("file-flake")[0]?.excerpt ?? "", /FAIL svc\/test\/slow\.test\.ts/);
  });

  it("a green rerun that does not show the failed files ran is not a flake", () => {
    const w = new World();
    w.flaky.set(1, ["svc/test/slow.test.ts"]);
    w.rerunReportsRan = false;
    w.run([1, 2]);
    assert.deepEqual(w.of("file-flake"), []);
    const b1 = w.batch(1);
    assert.deepEqual([b1.probes[1]!.kind, b1.probes[1]!.status], ["rerun", "failed"]);
    // Treated as red: bisect finds prefix 1 green, so change 2 is sent back.
    assert.deepEqual([b1.culprit, b1.good], [2, 1]);
  });

  it("the number of reruns is a setting", () => {
    const none = new World(configWith({ rerunCount: 0 }));
    none.flaky.set(1, ["svc/test/slow.test.ts"]);
    none.run([1, 2]);
    assert.deepEqual(none.runs.slice(0, 2), ["2", "1"]);
    const two = new World(configWith({ rerunCount: 2 }));
    two.bad.set("2", ["svc/test/real.test.ts"]);
    two.run([1, 2]);
    assert.deepEqual(two.runs, ["2", "2r", "2r", "1"]);
  });

  it("the same files failing and passing on rerun in two batches in a row is a pattern, not a flake", () => {
    const w = new World();
    w.flaky.set(1, ["svc/test/shared.test.ts", "svc/test/slow.test.ts"]);
    w.flaky.set(2, ["svc/test/shared.test.ts", "svc/test/other.test.ts"]);
    w.flaky.set(4, ["svc/test/shared.test.ts"]);
    w.run([1, 2]);
    w.add(3);
    w.drive();
    const tip = w.batch(2).members[0]!.sha;
    assert.deepEqual(w.of("suspect-order-dependence"), [{ kind: "suspect-order-dependence", files: ["svc/test/shared.test.ts"], batches: [1, 2], sha: tip, excerpt: "FAIL svc/test/shared.test.ts\nFAIL svc/test/other.test.ts" }]);
    // The file seen once is still a flake; the repeated one is not filed as one again.
    assert.deepEqual(w.of("file-flake").map((f) => f.files), [["svc/test/shared.test.ts", "svc/test/slow.test.ts"], ["svc/test/other.test.ts"]]);
    assert.deepEqual(w.merged, ["1", "2", "3"]);
    // A clean batch in between breaks the row: batch 4 is a plain flake again.
    w.add(4);
    w.drive();
    w.add(5);
    w.drive();
    assert.equal(w.of("suspect-order-dependence").length, 1);
    assert.deepEqual(w.of("file-flake").at(-1)!.files, ["svc/test/shared.test.ts"]);
  });

  it("the pattern check is a setting: off files a flake, hold pauses before the merge", () => {
    const off = new World(configWith({ orderDependence: "off" }));
    off.flaky.set(1, ["svc/test/shared.test.ts"]);
    off.flaky.set(2, ["svc/test/shared.test.ts"]);
    off.run([1]);
    off.add(2);
    off.drive();
    assert.deepEqual(off.of("suspect-order-dependence"), []);
    assert.equal(off.of("file-flake").length, 2);

    const hold = new World(configWith({ orderDependence: "hold" }));
    hold.flaky.set(1, ["svc/test/shared.test.ts"]);
    hold.flaky.set(2, ["svc/test/shared.test.ts"]);
    hold.run([1]);
    hold.add(2);
    hold.drive();
    assert.equal(hold.of("suspect-order-dependence").length, 1);
    assert.equal(hold.state.paused?.by, "queue");
    assert.deepEqual(hold.merged, ["1"]);
    assert.deepEqual(kinds(hold.send({ kind: "resume", by: "Ada" })), ["fast-forward"]);
    hold.drive();
    assert.deepEqual(hold.merged, ["1", "2"]);
  });
});

describe("building the chain", () => {
  it("sizes the batch from the measured failure rate", () => {
    const w = new World(configWith({ mapping: { enabled: false } }));
    const outcomes: Outcome[] = Array.from({ length: 30 }, (_, i) => ({ change: `old${i}`, ok: i >= 3 }));
    w.state = { ...initialState(), outcomes, nextBatch: 8 };
    for (let n = 1; n <= 9; n++) w.add(n);
    w.start();
    assert.equal(w.batch(8).members.length, 7); // 0.7 / 0.1
    assert.deepEqual(w.of("build-chain")[0]!.changes.map((c) => c.change.id), ["1", "2", "3", "4", "5", "6", "7"]);
    assert.deepEqual(w.of("build-chain")[0]!.changes[0], { change: ref(1), sha: w.changes.get("1")!.head });
  });

  it("a change that does not apply is sent back naming what it conflicts with, and is left out", () => {
    const w = new World();
    w.conflicts.set("2", "1");
    w.conflicts.set("4", null);
    w.run([1, 2, 3, 4]);
    const back = w.of("send-back");
    assert.deepEqual(back.map((b) => [b.change.id, b.reason]), [
      ["2", { kind: "conflict", with: ref(1), ahead: [ref(1)], base: "m0" }],
      ["4", { kind: "conflict", ahead: [ref(1), ref(3)], base: "m0" }],
    ]);
    assert.deepEqual(w.ids(1), ["1", "3"]);
    assert.deepEqual(w.merged, ["1", "3"]);
    assert.equal(w.state.batches.length, 1); // the conflicting changes do not come back by themselves
    assert.equal(w.state.counters.conflicts, 2);
  });

  it("a batch in which nothing applies ends, and the queue goes on", () => {
    const w = new World();
    w.conflicts.set("1", null);
    w.run([1]);
    assert.equal(w.batch(1).note, "no change applied");
    assert.deepEqual(w.runs, []);
    w.add(2);
    w.drive();
    assert.deepEqual(w.merged, ["2"]);
  });

  it("a build that failed is ended and rebuilt", () => {
    const w = new World();
    for (const n of [1, 2]) w.add(n);
    w.start();
    w.inbox = [];
    assert.deepEqual(kinds(w.send({ kind: "chain-failed", batch: 1, reason: "the worktree was lost" })), ["build-chain"]);
    assert.match(w.batch(1).note, /building failed/);
    w.drive();
    assert.deepEqual(w.ids(2), ["1", "2"]);
    assert.deepEqual(w.merged, ["1", "2"]);
  });
});

describe("runs that do not finish", () => {
  it("a cancelled run is started again, under a new name, until the setting says stop", () => {
    const w = new World(configWith({ maxRunAttempts: 2 }));
    w.cancelNext = 1;
    w.run([1]);
    assert.deepEqual(w.of("start-run").map((r) => r.run), ["1.1", "1.1.2"]);
    assert.deepEqual(w.merged, ["1"]);

    const stuck = new World(configWith({ maxRunAttempts: 2 }));
    stuck.cancelNext = 2;
    stuck.run([1]);
    assert.equal(stuck.batch(1).culprit, 1);
    const reason = stuck.of("send-back")[0]!.reason;
    assert.ok(reason.kind === "culprit" && /cancelled 2 times/.test(reason.excerpt));
  });

  it("ignores a result for a run it does not await, or for another commit", () => {
    const w = new World();
    for (const n of [1, 2]) w.add(n);
    w.start();
    w.deliver();
    const run = w.of("start-run")[0]!;
    assert.deepEqual(kinds(w.send({ kind: "run-finished", run: "9.9", sha: run.sha, outcome: "pass" })), ["idle"]);
    assert.deepEqual(kinds(w.send({ kind: "run-finished", run: run.run, sha: "elsewhere", outcome: "pass" })), ["idle"]);
    assert.deepEqual(kinds(w.send({ kind: "rerun-finished", run: run.run, sha: run.sha, outcome: "pass", ran: [] })), ["idle"]);
    assert.equal(w.batch(1).probes[0]!.status, "queued");
    assert.match(w.state.steps.at(-1)!.did[0]!, /^ignored/);
  });
});

describe("the main branch", () => {
  it("a move outside the queue ends the batch, and its changes are rebuilt on the new head", () => {
    const w = new World();
    for (const n of [1, 2]) w.add(n);
    w.start();
    w.deliver();
    const moved = w.outsideCommit();
    const effects = w.send({ kind: "main-moved", sha: moved, by: "poll" });
    assert.deepEqual(kinds(effects), ["cancel-run", "build-chain"]);
    assert.match(w.batch(1).note, /main branch moved outside the queue/);
    assert.deepEqual(w.batch(1).members.map((m) => m.state), ["requeued", "requeued"]);
    w.drive(); // the old run's result is ignored
    assert.equal(w.batch(2).base, moved);
    assert.deepEqual(w.ids(2), ["1", "2"]);
    assert.deepEqual(w.commits.get(w.main), ["outside", "1", "2"]);
    assert.deepEqual(w.of("report-outside-write"), []);
  });

  it("when the queue is the only writer, a move outside it is reported", () => {
    const w = new World(configWith({ onlyWriter: true }));
    w.add(1);
    w.start();
    const moved = w.outsideCommit();
    w.inbox = [];
    w.send({ kind: "chain-built", batch: 1, results: [{ change: ref(1), sha: "c-one" }] });
    w.send({ kind: "main-moved", sha: moved });
    assert.deepEqual(w.of("report-outside-write"), [{ kind: "report-outside-write", sha: moved, batch: 1 }]);
  });

  it("a fast-forward refused because the main branch moved ends the batch without a merge", () => {
    const w = new World();
    w.add(1);
    w.start();
    w.deliver();
    const moved = w.outsideCommit();
    w.drive();
    assert.match(w.batch(1).note, /moved outside/);
    assert.equal(w.batch(2).base, moved);
    assert.deepEqual(w.merged, ["1"]);
    assert.equal(w.of("mark-merged").length, 1);
  });

  it("a fast-forward refused while the main branch stands still pauses the queue; resuming tries again with no new run", () => {
    const w = new World();
    w.add(1);
    w.refuseMerge = true;
    w.start();
    w.drive();
    assert.equal(w.state.paused?.by, "queue");
    assert.equal(w.of("report-problem").length, 1);
    assert.deepEqual(w.merged, []);
    assert.deepEqual(kinds(w.send({ kind: "tick" })), ["idle"]);
    w.refuseMerge = false;
    assert.deepEqual(kinds(w.send({ kind: "resume" })), ["fast-forward"]);
    w.drive();
    assert.deepEqual(w.merged, ["1"]);
    assert.deepEqual(w.runs, ["1"]);
  });

  it("seeing the main branch at the awaited commit counts as the fast-forward's answer", () => {
    const w = new World();
    w.add(1);
    w.start();
    w.deliver();
    w.deliver();
    const to = w.of("fast-forward")[0]!.to;
    assert.deepEqual(kinds(w.send({ kind: "main-moved", sha: to })), ["mark-merged"]);
    assert.deepEqual(kinds(w.deliver()), ["idle"]); // the answer itself, now late
    assert.deepEqual(w.merged, ["1"]);
  });
});

describe("a change that moves while it is in the queue", () => {
  it("without pinned approvals: the batch ends, the others lead the next one, and the change rejoins at its new head", () => {
    const w = new World();
    for (const n of [1, 2, 3]) w.add(n);
    w.start();
    w.deliver();
    const head = w.push(2);
    w.send({ kind: "change-head", change: ref(2), sha: head });
    assert.match(w.batch(1).note, /2 changed or left the queue/);
    assert.deepEqual(w.ids(2), ["1", "3", "2"]);
    assert.equal(w.batch(2).members[2]!.head, head);
    assert.deepEqual(w.of("send-back"), []);
    w.drive();
    assert.deepEqual(w.merged, ["1", "3", "2"]);
  });

  it("a new head during the fast-forward does not send back what is being merged", () => {
    const w = new World(configWith({}));
    for (const n of [1, 2]) w.add(n);
    w.start();
    while (w.of("fast-forward").length === 0) w.deliver();
    const head = w.push(2);
    w.send({ kind: "change-head", change: ref(2), sha: head });
    assert.deepEqual(w.of("send-back"), []);
    assert.equal(w.of("report-problem").length, 1);
    w.drive();
    assert.deepEqual(w.merged, ["1", "2"]);
    assert.deepEqual(w.of("send-back"), []);
  });

  it("the queue's own chain commit on a change's branch is not a change", () => {
    const w = new World(configWith({}));
    for (const n of [1, 2]) w.add(n);
    w.start();
    w.deliver();
    w.send({ kind: "change-head", change: ref(2), sha: w.batch(1).members[1]!.sha });
    w.send({ kind: "change-head", change: ref(2), sha: w.changes.get("2")!.head });
    assert.deepEqual(w.of("send-back"), []);
    w.drive();
    assert.deepEqual(w.merged, ["1", "2"]);
  });

  it("a change that leaves ends its batch; one that only waited just goes", () => {
    const w = new World(configWith({ batch: { max: 2 } }));
    for (const n of [1, 2, 3]) w.add(n);
    w.start();
    w.deliver();
    w.send({ kind: "change-left", change: ref(3) });
    assert.equal(w.batch(1).status, "testing");
    w.send({ kind: "change-left", change: ref(1) });
    assert.match(w.batch(1).note, /1 changed or left/);
    w.drive();
    assert.deepEqual(w.merged, ["2"]);
  });
});

describe("pause", () => {
  it("starts nothing while paused, keeps what it is told, and goes on when resumed", () => {
    const w = new World();
    for (const n of [1, 2]) w.add(n);
    w.send({ kind: "pause", reason: "Ada is looking", by: "Ada" });
    assert.deepEqual(w.start(), [{ kind: "idle", reason: "paused: Ada is looking" }]);
    assert.deepEqual(kinds(w.send({ kind: "resume" })), ["build-chain"]);
    w.deliver();
    w.send({ kind: "pause", reason: "again" });
    assert.deepEqual(kinds(w.deliver()), ["idle"]); // the run's green result arrives: recorded, not merged
    assert.equal(w.batch(1).probes[0]!.status, "passed");
    w.add(3);
    assert.deepEqual(w.of("fast-forward"), []);
    assert.deepEqual(kinds(w.send({ kind: "resume" })), ["fast-forward"]);
    w.drive();
    assert.deepEqual(w.merged, ["1", "2", "3"]);
  });
});

describe("results already obtained", () => {
  it("a tree that failed before is not run again when a rebuilt chain reaches it", () => {
    const w = new World();
    for (const n of [1, 2, 3, 4, 5]) w.add(n);
    w.bad.set("3", []);
    w.start();
    w.deliver(); // chain
    w.deliver(); // prefix 5 red
    w.deliver(); // prefix 3 red
    assert.deepEqual(w.runs, ["5", "3", "2"]);
    w.inbox = [];
    w.send({ kind: "change-left", change: ref(5) });
    w.drive();
    // Batch 2 is 1..4 on the same base: prefix 4 is new, prefix 2 is new, prefix 3 is known red.
    assert.deepEqual(w.ids(2), ["1", "2", "3", "4"]);
    assert.deepEqual(w.runs.slice(3, 5), ["4", "2"]);
    assert.equal(w.batch(2).culprit, 3);
    assert.deepEqual(w.batch(2).probes.map((p) => [p.prefix, p.status, p.reused ?? false]), [
      [4, "failed", false],
      [2, "passed", false],
      [3, "failed", true],
    ]);
    assert.equal(w.state.counters.runsReused, 1);
    // Ready again, change 3 is tested afresh.
    w.bad.delete("3");
    w.send({ kind: "change-ready", change: ref(3), sha: w.changes.get("3")!.head, paths: [] });
    w.drive();
    assert.deepEqual(w.merged, ["1", "2", "4", "3"]);
  });
});

describe("what the board reads", () => {
  it("each batch records what set off each step and what it did", () => {
    const w = new World();
    w.bad.set("2", []);
    for (const n of [1, 2]) w.add(n);
    w.send({ kind: "main-moved", sha: "m0", by: "poll" });
    w.drive();
    const history = w.batch(1).history;
    assert.deepEqual(history.map((h) => h.trigger), ["main-moved (poll)", "chain-built", "run-finished", "run-finished", "merge-result"]);
    assert.match(history[0]!.did[0]!, /asked for a chain of 2/);
    assert.match(history[2]!.did.join("; "), /run 1\.1 of prefix 2 failed; run 1\.2: prefix 1 of 2/);
    assert.match(history[4]!.did.join("; "), /1 merged .*2 broke the batch.*ended: 2 failed/);
    assert.deepEqual(w.send({ kind: "tick", by: "timer" }), [{ kind: "idle", reason: "no change is ready" }]);
    assert.deepEqual(w.state.steps.at(-1), { at: w.state.steps.at(-1)!.at, trigger: "tick (timer)", did: ["nothing to do: no change is ready"] });
  });

  it("the state maps onto the model's batches: status, member states, probes and suspect", () => {
    const w = new World();
    for (const n of [1, 2, 3, 4]) w.add(n, n === 3 ? ["ui/src/features/orders/List.tsx"] : undefined);
    w.bad.set("3", ["ui/e2e/orders.e2e.mjs"]);
    w.start();
    assert.deepEqual(toBatch(w.state).map((b) => [b.status, b.members.map((m) => m.state)]), [["forming", ["waiting", "waiting", "waiting", "waiting"]]]);
    assert.equal(toBatch(w.state)[0]!.members[0]!.sha, w.changes.get("1")!.head);
    w.deliver();
    assert.deepEqual(toBatch(w.state)[0]!.status, "testing");
    const started = w.state.batches[0]!.probes[0]!.startedAt;
    assert.deepEqual(toBatch(w.state)[0]!.probes, [{ prefix: 4, status: "queued", startedAt: started }]);
    w.send({ kind: "run-started", run: "1.1", ref: { host: "test", kind: "run", id: "r1" } });
    assert.deepEqual(toBatch(w.state)[0]!.probes, [{ prefix: 4, status: "running", startedAt: started, run: { host: "test", kind: "run", id: "r1" } }]);
    w.deliver(); // red: rerun
    w.deliver(); // rerun red: mapped, prefix 2 is tested
    let b = toBatch(w.state)[0]!;
    assert.equal(b.status, "bisecting");
    assert.deepEqual(b.suspect, ref(3));
    assert.deepEqual(b.members.map((m) => m.state), ["testing", "testing", "waiting", "waiting"]);
    assert.deepEqual(b.probes.map((p) => [p.prefix, p.status]), [[4, "failed"], [2, "queued"]]);
    w.drive();
    const all = toBatch(w.state);
    b = all[0]!;
    assert.deepEqual(b.ref, { host: "scopesoup", kind: "batch", id: "1" });
    assert.equal(b.status, "failed");
    assert.equal(b.base, "m0");
    assert.deepEqual(b.suspect, ref(3));
    assert.deepEqual(b.members.map((m) => m.state), ["merged", "merged", "culprit", "requeued"]);
    assert.deepEqual(b.probes.map((p) => [p.prefix, p.status]), [[4, "failed"], [2, "passed"], [3, "failed"]]);
    assert.equal(b.note, "3 failed");
    assert.ok(b.startedAt && b.finishedAt && b.startedAt < b.finishedAt);
    assert.ok(b.runs.length >= 3);
    assert.deepEqual([all[1]!.status, all[1]!.members.map((m) => m.state)], ["merged", ["merged"]]);
  });

  it("keeps only the latest batches and steps", () => {
    const w = new World(configWith({ keepBatches: 2, historyLimit: 3 }));
    for (const n of [1, 2, 3, 4]) {
      w.add(n);
      if (n === 1) w.start();
      w.drive();
    }
    assert.deepEqual(w.state.batches.map((b) => b.id), [3, 4]);
    assert.equal(w.state.steps.length, 3);
    assert.equal(w.state.counters.batches, 4);
  });

  it("the state survives JSON and step does not touch the state it is given", () => {
    const state = initialState("m0");
    const frozen = JSON.stringify(state);
    const next = step(state, { kind: "change-ready", change: ref(1), sha: "h1", paths: ["a.ts"] }, configWith({}), "2030-01-01T00:00:00.000Z");
    assert.equal(JSON.stringify(state), frozen);
    assert.deepEqual(JSON.parse(JSON.stringify(next.state)), next.state);
    assert.deepEqual(kinds(next.effects), ["build-chain"]);
  });
});
