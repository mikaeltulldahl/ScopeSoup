// Random sequences of inputs, honest and not: whatever arrives, the engine never asks for a merge
// of a commit that has no passing run recorded on exactly that commit.

import assert from "node:assert/strict";
import { it } from "node:test";
import { configWith } from "./config.ts";
import { World, ref } from "./testWorld.ts";
import type { QueueEffect, QueueInput } from "./types.ts";

/** A small seeded generator (mulberry32), so a failure can be replayed from its seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Watches every input and effect and checks the merge rule from the outside. */
class Watch {
  /** "run|sha" of every run the engine asked for, with the files of a rerun. */
  asked = new Map<string, string[] | null>();
  passed = new Set<string>();
  requested = new Set<string>();
  confirmed = new Set<string>();
  merges = 0;

  input(input: QueueInput): void {
    if ((input.kind === "run-finished" || input.kind === "rerun-finished") && input.outcome === "pass") {
      const files = this.asked.get(`${input.run}|${input.sha}`);
      if (files === undefined) return;
      const isRerun = files !== null;
      if (isRerun !== (input.kind === "rerun-finished")) return;
      if (input.kind === "rerun-finished" && !(files ?? []).every((f) => (input.ran ?? []).includes(f))) return;
      this.passed.add(input.sha);
    }
    if (input.kind === "merge-result" && input.ok) this.confirmed.add(input.to);
    if (input.kind === "main-moved") this.confirmed.add(input.sha);
  }

  effects(effects: QueueEffect[], seed: number): void {
    for (const e of effects) {
      if (e.kind === "start-run") this.asked.set(`${e.run}|${e.sha}`, null);
      if (e.kind === "rerun-files") this.asked.set(`${e.run}|${e.sha}`, e.files);
      if (e.kind === "fast-forward") {
        assert.ok(this.passed.has(e.to), `seed ${seed}: fast-forward to ${e.to} without a passing run on it`);
        this.requested.add(e.to);
        this.merges++;
      }
      if (e.kind === "mark-merged" && !e.outside) {
        assert.ok(e.tested && this.passed.has(e.tested), `seed ${seed}: marked merged on ${e.tested}, which has no passing run`);
        assert.ok(this.requested.has(e.tested) && this.confirmed.has(e.tested), `seed ${seed}: marked merged before the fast-forward to ${e.tested} was confirmed`);
      }
    }
  }
}

function play(seed: number): number {
  const rnd = random(seed);
  const pick = (n: number) => Math.floor(rnd() * n);
  // Was pinnedApproval (removed): the draw is kept, so each seed plays the same sequence as before.
  rnd();
  const config = configWith({
    onlyWriter: rnd() < 0.5,
    reuseResults: rnd() < 0.7,
    orderDependence: (["off", "report", "hold"] as const)[pick(3)]!,
    rerunCount: pick(3),
    maxRunAttempts: 1 + pick(3),
    keepBatches: 2 + pick(4),
    historyLimit: 5 + pick(10),
    knownLimit: 5 + pick(40),
    mapping: { enabled: rnd() < 0.5 },
    batch: { min: 1 + pick(2), max: 2 + pick(6) },
  });
  const w = new World(config);
  const watch = new Watch();
  const send = (input: QueueInput) => {
    watch.input(input);
    watch.effects(w.send(input), seed);
  };
  const someSha = () => {
    const shas = [...w.commits.keys()];
    return shas[pick(shas.length)] ?? "m0";
  };
  const someRun = () => {
    const probes = w.state.batches.flatMap((b) => b.probes);
    return probes[pick(probes.length)]?.id ?? "0.0";
  };
  const someChange = () => String(1 + pick(Math.max(1, w.changes.size)));
  let next = 1;

  send({ kind: "main-moved", sha: w.main });
  for (let i = 0; i < 250; i++) {
    const roll = rnd();
    if (roll < 0.45 && w.inbox.length > 0) {
      // Mostly in order, sometimes not, sometimes twice.
      const at = rnd() < 0.8 ? 0 : pick(w.inbox.length);
      const input = w.inbox[at]!;
      if (rnd() < 0.9) w.inbox.splice(at, 1);
      send(input);
    } else if (roll < 0.6) {
      const id = String(next++);
      if (rnd() < 0.15) w.bad.set(id, rnd() < 0.5 ? [] : [`svc/test/t${id}.test.ts`]);
      if (rnd() < 0.1) w.conflicts.set(id, rnd() < 0.5 ? null : someChange());
      if (rnd() < 0.15) w.flaky.set(w.state.nextBatch + pick(2), [`svc/test/flaky${pick(2)}.test.ts`]);
      w.changes.set(id, { head: `h${id}`, paths: [`svc/src/t${id}.ts`] });
      w.commits.set(`h${id}`, [id]);
      send({ kind: "change-ready", change: ref(id), sha: `h${id}`, paths: [`svc/src/t${id}.ts`] });
    } else if (roll < 0.66 && w.changes.size > 0) {
      const id = someChange();
      send({ kind: "change-head", change: ref(id), sha: rnd() < 0.7 ? w.push(id) : someSha() });
    } else if (roll < 0.7 && w.changes.size > 0) {
      const id = someChange();
      const c = w.changes.get(id)!;
      send(rnd() < 0.5 ? { kind: "change-left", change: ref(id) } : { kind: "change-ready", change: ref(id), sha: c.head, paths: c.paths });
    } else if (roll < 0.75) {
      send({ kind: "main-moved", sha: rnd() < 0.6 ? w.outsideCommit() : rnd() < 0.5 ? w.main : someSha() });
    } else if (roll < 0.8) {
      send(rnd() < 0.4 ? { kind: "pause", reason: "test" } : { kind: "resume" });
    } else if (roll < 0.88) {
      // Results nobody asked for, or for the wrong commit.
      const outcome = (["pass", "pass", "fail", "cancelled"] as const)[pick(4)]!;
      const run = rnd() < 0.7 ? someRun() : `${pick(9)}.${pick(9)}`;
      send(rnd() < 0.5 ? { kind: "run-finished", run, sha: someSha(), outcome } : { kind: "rerun-finished", run, sha: someSha(), outcome, ran: rnd() < 0.5 ? [] : ["svc/test/flaky0.test.ts"] });
    } else if (roll < 0.92) {
      send({ kind: "merge-result", batch: pick(w.state.nextBatch + 1), to: someSha(), ok: rnd() < 0.7 });
    } else if (roll < 0.95) {
      const batch = pick(w.state.nextBatch + 1);
      const results = [...w.changes.keys()].filter(() => rnd() < 0.5).map((id) => (rnd() < 0.8 ? { change: ref(id), sha: someSha() } : { change: ref(id), conflict: {} }));
      send(rnd() < 0.7 ? { kind: "chain-built", batch, results } : { kind: "chain-failed", batch, reason: "test" });
    } else {
      w.refuseMerge = rnd() < 0.2;
      w.cancelNext = rnd() < 0.2 ? 1 : 0;
      w.rerunReportsRan = rnd() < 0.9;
      send({ kind: "tick" });
    }
  }
  return watch.merges;
}

/** Seeds 1 to this many are played: 20 by default, 100 with SCOPESOUP_LONG=1 (`pnpm test:long`). The same seeds each time, so a failure replays. */
const SEQUENCES = process.env.SCOPESOUP_LONG === "1" ? 100 : 20;

it("random inputs never lead to a merge of a commit without a passing run on exactly that commit", () => {
  let merges = 0;
  for (let seed = 1; seed <= SEQUENCES; seed++) merges += play(seed);
  // The sequences do reach merges; otherwise the rule above would hold for nothing.
  assert.ok(merges > SEQUENCES, `only ${merges} merges in ${SEQUENCES} sequences`);
});
