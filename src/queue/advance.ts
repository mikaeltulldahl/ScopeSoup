// Decides what to do next from the state alone, and keeps going until it has to wait for the
// caller: for a chain, a run, or a fast-forward. Calling it again without a new fact does nothing.

import { refKey } from "../model/types.ts";
import { applyResult, nextProbe } from "./bisect.ts";
import { mapCulprit } from "./mapping.ts";
import { usableFiles } from "./report.ts";
import { batchSize } from "./sizing.ts";
import { type Ctx, current, emptyMeasured, endBatch, entryOf, expectedMain, markMerged, names, note, pause, removeEntry, short } from "./state.ts";
import type { FailureReport, QueueBatch, QueueProbe } from "./types.ts";

export function advance(ctx: Ctx): void {
  for (let guard = 0; guard < 500; guard++) {
    const b = current(ctx.s);
    if (!b) {
      build(ctx);
      return;
    }
    if (b.status === "building" || b.merge) return;
    if (ctx.s.paused) return; // a step may pause the queue itself
    if (!mainInPlace(ctx, b)) continue;
    if (b.good >= b.members.length) {
      endBatch(ctx, b, `all ${b.members.length} merged`, []);
      continue;
    }
    if (!membersInPlace(ctx, b)) continue;
    if (b.probes.some((p) => p.status === "queued" || p.status === "running")) return;
    if (b.toMerge) {
      fastForward(ctx, b, b.toMerge.prefix);
      return;
    }
    const fresh = b.probes.find((p) => !p.handled);
    if (fresh) {
      handle(ctx, b, fresh);
      continue;
    }
    const next = nextProbe(b.members.length, b.good, b.bad, b.suspect);
    if (next.kind === "merged") endBatch(ctx, b, `all ${b.members.length} merged`, []);
    else if (next.kind === "culprit") blame(ctx, b, next.k);
    else startProbe(ctx, b, next.k, "full");
  }
  throw new Error("queue: no progress after 500 moves");
}

// ---------------------------------------------------------------- build

/** Leaders first, in their order, then the rest in the order they became ready. */
function build(ctx: Ctx): void {
  const { s, config } = ctx;
  if (s.main === undefined || s.entries.length === 0) return;
  const byKey = new Map(s.entries.map((e) => [refKey(e.change), e]));
  const lead = s.leaders.filter((k) => byKey.has(k));
  const order = [...lead, ...s.entries.map((e) => refKey(e.change)).filter((k) => !lead.includes(k))];
  const size = batchSize(s.outcomes, config.batch, config.mapping.enabled, s.counters, s.measured);
  const planned = order.slice(0, size).flatMap((k) => byKey.get(k) ?? []);
  const b: QueueBatch = {
    id: s.nextBatch++,
    status: "building",
    base: s.main,
    members: planned.map((e) => ({ change: e.change, head: e.sha, sha: "", paths: [...e.paths], state: "waiting" })),
    good: 0,
    bad: null,
    suspect: null,
    mapped: false,
    culprit: null,
    probes: [],
    passedOnRerun: [],
    note: "",
    history: [],
    startedAt: ctx.now,
  };
  s.batches.push(b);
  s.leaders = lead.filter((k) => !planned.some((e) => refKey(e.change) === k));
  ctx.effects.push({ kind: "build-chain", batch: b.id, base: b.base, changes: planned.map((e) => ({ change: e.change, sha: e.sha })) });
  note(ctx, b, `asked for a chain of ${planned.length} (size ${size}) on ${short(b.base)}: ${names(planned.map((e) => e.change))}`);
}

// ---------------------------------------------------------------- checks

/** The main branch must be at the base or at the last member this batch merged. False when the batch ended. */
function mainInPlace(ctx: Ctx, b: QueueBatch): boolean {
  const { s } = ctx;
  const main = s.main ?? "";
  if (main === expectedMain(b)) return true;
  if (ctx.config.onlyWriter) ctx.effects.push({ kind: "report-outside-write", sha: main, batch: b.id });
  const at = b.members.findIndex((m) => m.sha === main) + 1;
  // Someone else moved the main branch to a commit of the chain: those members are in, untested by this queue.
  if (at > b.good) markMerged(ctx, b, at, true);
  endBatch(ctx, b, `the main branch moved outside the queue (${short(main)})`, stillReady(ctx, b));
  return false;
}

/** refKeys of the unmerged members that are still ready at the revision the chain was built from. */
function stillReady(ctx: Ctx, b: QueueBatch): string[] {
  return b.members
    .slice(b.good)
    .filter((m) => entryOf(ctx.s, m.change)?.sha === m.head)
    .map((m) => refKey(m.change));
}

/** Every unmerged member must still be ready at the revision in the chain. False when the batch ended. */
function membersInPlace(ctx: Ctx, b: QueueBatch): boolean {
  const waiting = b.members.slice(b.good);
  const gone = waiting.filter((m) => entryOf(ctx.s, m.change)?.sha !== m.head);
  if (gone.length === 0) return true;
  endBatch(ctx, b, `${names(gone.map((m) => m.change))} changed or left the queue`, stillReady(ctx, b));
  return false;
}

// ---------------------------------------------------------------- runs

function startProbe(ctx: Ctx, b: QueueBatch, k: number, kind: QueueProbe["kind"], files?: string[]): void {
  const { s } = ctx;
  const m = b.members[k - 1];
  if (!m) throw new Error(`queue: batch ${b.id} has no prefix ${k}`);
  const p: QueueProbe = { id: `${b.id}.${b.probes.length + 1}`, prefix: k, sha: m.sha, kind, status: "queued", attempts: 1, handled: false, startedAt: ctx.now };
  if (files) p.files = [...files];
  b.probes.push(p);
  b.members.forEach((x, i) => {
    if (i >= b.good) x.state = i < k ? "testing" : "waiting";
  });
  const known =
    kind === "full" && ctx.config.reuseResults ? s.known.find((x) => x.sha === m.sha || (x.result === "failed" && m.tree !== undefined && x.tree === m.tree)) : undefined;
  if (known) {
    // Already tested: a pass only counts for the very same commit, a failure also for the same tree.
    p.status = known.result;
    p.reused = true;
    p.finishedAt = ctx.now;
    if (known.report) p.report = known.report;
    if (known.run) p.run = known.run;
    s.counters.runsReused++;
    return note(ctx, b, `prefix ${k} (${short(m.sha)}) was tested before in batch ${known.batch}: ${known.result}, no new run`);
  }
  emitRun(ctx, b, p);
  note(ctx, b, kind === "rerun" ? `rerun ${p.id}: ${files?.length ?? 0} failed files of prefix ${k} on ${short(m.sha)}` : `run ${p.id}: prefix ${k} of ${b.members.length} on ${short(m.sha)}`);
}

function emitRun(ctx: Ctx, b: QueueBatch, p: QueueProbe): void {
  if (p.kind === "rerun") {
    ctx.s.counters.reruns++;
    ctx.effects.push({ kind: "rerun-files", batch: b.id, run: p.id, prefix: p.prefix, sha: p.sha, files: [...(p.files ?? [])] });
  } else {
    ctx.s.counters.runs++;
    ctx.effects.push({ kind: "start-run", batch: b.id, run: p.id, prefix: p.prefix, sha: p.sha });
  }
}

/** The red full run of a prefix, which its reruns run again. */
function redFull(b: QueueBatch, k: number): QueueProbe | undefined {
  return [...b.probes].reverse().find((x) => x.kind === "full" && x.prefix === k && x.status === "failed");
}

/** Acts on a finished run. */
function handle(ctx: Ctx, b: QueueBatch, p: QueueProbe): void {
  const { s, config } = ctx;
  if (p.status === "cancelled") {
    if (p.attempts < config.maxRunAttempts) {
      // Nothing was learned: run it again.
      p.attempts++;
      p.id = `${b.id}.${b.probes.indexOf(p) + 1}.${p.attempts}`;
      p.status = "queued";
      delete p.finishedAt;
      delete p.run;
      emitRun(ctx, b, p);
      return note(ctx, b, `run of prefix ${p.prefix} was cancelled: started again as ${p.id}`);
    }
    p.status = "failed";
    p.report = { files: [], excerpt: `The run was cancelled ${config.maxRunAttempts} times.` };
  }
  p.handled = true;
  const orig = p.kind === "full" ? p : redFull(b, p.prefix);
  if (p.status === "failed" && !p.reused && usableFiles(orig?.report)) {
    const reruns = b.probes.filter((x) => x.kind === "rerun" && x.prefix === p.prefix).length;
    // Before blaming anyone: run only the failed files again on the same commit.
    if (reruns < config.rerunCount) return startProbe(ctx, b, p.prefix, "rerun", orig.report.files);
  }
  const members = b.members.slice(0, p.prefix).map((m) => refKey(m.change));
  const tree = b.members[p.prefix - 1]?.tree;
  const remember = (result: "passed" | "failed", report?: FailureReport) => {
    if (p.reused) return;
    s.known = [...s.known.filter((x) => x.sha !== p.sha), { sha: p.sha, result, batch: b.id, members, ...(tree ? { tree } : {}), ...(report ? { report } : {}), ...(p.run ? { run: p.run } : {}) }].slice(
      -config.knownLimit,
    );
  };

  if (p.status === "passed") {
    remember("passed");
    b.toMerge = { prefix: p.prefix, probe: p.id };
    if (p.kind === "rerun" && orig?.report) passedOnRerun(ctx, b, p, orig.report.files, orig.report.excerpt);
    return;
  }

  const report = orig?.report ?? p.report;
  remember("failed", report);
  const before = b.good;
  if (b.bad === null && b.members.length > 1) s.counters.bisections++;
  Object.assign(b, applyResult(b, p.prefix, false));
  if (config.mapping.enabled && !b.mapped && usableFiles(report)) {
    b.mapped = true;
    const window = b.members.slice(before, b.bad ?? b.members.length);
    const hit = mapCulprit(
      report.files,
      window.map((m) => m.paths),
      config.mapping.rule,
    );
    b.suspect = hit === null ? null : before + hit;
    const suspect = b.suspect === null ? undefined : b.members[b.suspect - 1];
    if (suspect) note(ctx, b, `the failing files point at ${suspect.change.id} (position ${b.suspect})`);
  }
}

/** The failed files passed when run alone: a flake, unless the same happened in the batch before. */
function passedOnRerun(ctx: Ctx, b: QueueBatch, p: QueueProbe, files: readonly string[], excerpt: string): void {
  const { s, config } = ctx;
  b.passedOnRerun = [...new Set([...b.passedOnRerun, ...files])];
  if (excerpt !== "") b.flakeExcerpt = excerpt;
  const prev = s.flaky && s.flaky.batch < b.id ? s.flaky : undefined;
  const repeated = config.orderDependence !== "off" && prev ? files.filter((f) => prev.files.includes(f)) : [];
  const once = files.filter((f) => !repeated.includes(f));
  if (repeated.length > 0 && prev) {
    // Passing alone and failing in the suite, twice in a row, looks like test order or shared state.
    ctx.effects.push({ kind: "suspect-order-dependence", files: repeated, batches: [prev.batch, b.id], sha: p.sha, ...(excerpt !== "" ? { excerpt } : {}) });
    note(ctx, b, `failed and passed on rerun in batches ${prev.batch} and ${b.id}: ${repeated.join(", ")} (a pattern, not a flake)`);
    if (config.orderDependence === "hold") {
      pause(ctx, `Batch ${b.id} is green only on rerun, and ${repeated.join(", ")} did the same in batch ${prev.batch}. Resume to merge it.`, "queue");
      note(ctx, b, "paused before the merge");
    }
  }
  if (once.length > 0) {
    s.counters.flakes++;
    ctx.effects.push({ kind: "file-flake", batch: b.id, files: once, sha: p.sha, ...(p.run ? { run: p.run } : {}), ...(excerpt !== "" ? { excerpt } : {}) });
    note(ctx, b, `passed on rerun, a flake: ${once.join(", ")}`);
  }
}

// ---------------------------------------------------------------- merge and blame

function fastForward(ctx: Ctx, b: QueueBatch, k: number): void {
  const to = b.members[k - 1]?.sha;
  // The one rule that must never break: only a commit with a passing run of its own is merged.
  if (!to || !b.probes.some((p) => p.sha === to && p.status === "passed")) throw new Error(`queue: refusing to merge prefix ${k} of batch ${b.id}: no passing run on its commit`);
  b.merge = { prefix: k, to, expect: expectedMain(b) };
  ctx.effects.push({ kind: "fast-forward", batch: b.id, prefix: k, to, expect: b.merge.expect });
  note(ctx, b, `prefix ${k} is green: asked to fast-forward the main branch to ${short(to)}`);
}

function blame(ctx: Ctx, b: QueueBatch, k: number): void {
  const { s } = ctx;
  const m = b.members[k - 1];
  if (!m) throw new Error(`queue: batch ${b.id} has no member ${k}`);
  const red = redFull(b, k) ?? [...b.probes].reverse().find((p) => p.prefix === k && p.status === "failed");
  m.state = "culprit";
  b.culprit = k;
  removeEntry(s, m.change);
  s.outcomes = [...s.outcomes, { change: refKey(m.change), ok: false }].slice(-ctx.config.batch.window);
  s.counters.culprits++;
  if (ctx.config.mapping.enabled) {
    // Did the failure report name the culprit? Measured for the batch size (docs/BATCH_SIZE.md).
    const measured = (s.measured ??= emptyMeasured());
    measured.s.n++;
    if (b.suspect === k) measured.s.named++;
  }
  ctx.effects.push({
    kind: "send-back",
    change: m.change,
    sha: m.head,
    batch: b.id,
    reason: { kind: "culprit", prefix: k, chainSha: m.sha, files: red?.report?.files ?? [], excerpt: red?.report?.excerpt ?? "", ...(red?.run ? { run: red.run } : {}) },
  });
  note(ctx, b, `${m.change.id} broke the batch: prefix ${k - 1} is green and prefix ${k} is red; sent back`);
  endBatch(
    ctx,
    b,
    `${m.change.id} failed`,
    b.members.slice(k).map((x) => refKey(x.change)),
  );
}
