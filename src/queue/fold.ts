// Folds one input into the state: what the outside world reported. Deciding what to do about it
// is advance.ts; the only effects from here are a change sent back for a moved head or a conflict,
// members marked merged, and a refused merge reported.

import { refKey } from "../model/types.ts";
import type { Ref } from "../model/types.ts";
import { capReport, rerunRan } from "./report.ts";
import { type Ctx, current, emptyMeasured, endBatch, entryOf, expectedMain, markMerged, names, note, pause, removeEntry, short } from "./state.ts";
import type { QueueBatch, QueueInput, QueueMember, QueueProbe } from "./types.ts";

type Of<K extends QueueInput["kind"]> = Extract<QueueInput, { kind: K }>;

export function fold(ctx: Ctx, input: QueueInput): void {
  switch (input.kind) {
    case "change-ready":
      return changeReady(ctx, input);
    case "change-left":
      if (entryOf(ctx.s, input.change)) {
        removeEntry(ctx.s, input.change);
        note(ctx, memberBatch(ctx, input.change), `${input.change.id} left the queue`);
      }
      return;
    case "change-head":
      return changeHead(ctx, input);
    case "chain-built":
      return chainBuilt(ctx, input);
    case "chain-failed": {
      const b = current(ctx.s);
      if (!b || b.id !== input.batch || b.status !== "building") return void note(ctx, null, `ignored: batch ${input.batch} is not being built`);
      return endBatch(ctx, b, `building failed: ${input.reason}`, b.members.map((m) => refKey(m.change)));
    }
    case "run-started": {
      const p = current(ctx.s)?.probes.find((x) => x.id === input.run && x.status === "queued");
      if (!p) return;
      p.status = "running";
      if (input.ref) p.run = input.ref;
      return;
    }
    case "run-finished":
    case "rerun-finished":
      return runFinished(ctx, input);
    case "merge-result":
      return mergeResult(ctx, input);
    case "main-moved":
      return mainMoved(ctx, input.sha);
    case "pause":
      pause(ctx, input.reason, input.by ?? "caller");
      return note(ctx, null, `paused: ${input.reason}`);
    case "resume":
      if (ctx.s.paused) note(ctx, null, "resumed");
      delete ctx.s.paused;
      return;
    case "tick":
      return;
  }
}

/** The current batch, if the change is one of its unmerged members. */
function memberBatch(ctx: Ctx, change: Ref): QueueBatch | null {
  const b = current(ctx.s);
  const key = refKey(change);
  return b && b.members.slice(b.good).some((m) => refKey(m.change) === key) ? b : null;
}

/** A change that is ready again gets a fresh test: earlier failures with it in the chain are forgotten. */
function forgetFailures(ctx: Ctx, change: Ref): void {
  const key = refKey(change);
  ctx.s.known = ctx.s.known.filter((k) => k.result === "passed" || !k.members.includes(key));
}

function changeReady(ctx: Ctx, input: Of<"change-ready">): void {
  const { s } = ctx;
  const e = entryOf(s, input.change);
  if (!e) {
    s.entries.push({ change: input.change, sha: input.sha, paths: [...input.paths], readyAt: ctx.now });
    forgetFailures(ctx, input.change);
    return note(ctx, null, `${input.change.id} is ready at ${short(input.sha)}`);
  }
  e.paths = [...input.paths];
  if (e.sha === input.sha) return;
  // Ready again on a new revision: that one is what merges.
  note(ctx, memberBatch(ctx, input.change), `${input.change.id} is ready at a new revision ${short(input.sha)}`);
  e.sha = input.sha;
  delete e.chainSha;
  forgetFailures(ctx, input.change);
}

function changeHead(ctx: Ctx, input: Of<"change-head">): void {
  const { s } = ctx;
  const e = entryOf(s, input.change);
  if (!e || input.sha === e.sha || input.sha === e.chainSha) return;
  const b = memberBatch(ctx, input.change);
  // A member inside an awaited fast-forward is past the point of return: the tested commit merges.
  // Sending it back as well would report one change as both merged and returned.
  const position = b ? b.members.findIndex((m) => refKey(m.change) === refKey(input.change)) : -1;
  if (b?.merge && position >= 0 && position < b.merge.prefix) {
    ctx.effects.push({
      kind: "report-problem",
      message: `${input.change.id} got a new head (${short(input.sha)}) while its tested commit was being merged (batch ${b.id}). The new commits are not part of the merge.`,
    });
    return note(ctx, b, `${input.change.id} moved to ${short(input.sha)} during its merge: the tested commit merges, the newer one does not`);
  }
  note(ctx, b, `${input.change.id} moved to ${short(input.sha)}`);
  e.sha = input.sha;
  if (input.paths) e.paths = [...input.paths];
  delete e.chainSha;
}

function chainBuilt(ctx: Ctx, input: Of<"chain-built">): void {
  const { s } = ctx;
  const b = current(s);
  if (!b || b.id !== input.batch || b.status !== "building") return void note(ctx, null, `ignored: batch ${input.batch} is not being built`);
  const results = new Map(input.results.map((r) => [refKey(r.change), r]));
  const chain: QueueMember[] = [];
  for (const m of b.members) {
    const r = results.get(refKey(m.change));
    if (!r) {
      note(ctx, b, `${m.change.id} was not built; it waits for the next batch`);
      continue;
    }
    if ("conflict" in r) {
      const ahead = chain.map((x) => x.change);
      removeEntry(s, m.change);
      s.counters.conflicts++;
      ctx.effects.push({
        kind: "send-back",
        change: m.change,
        sha: m.head,
        batch: b.id,
        reason: { kind: "conflict", ...(r.conflict.with ? { with: r.conflict.with } : {}), ahead, base: b.base },
      });
      note(ctx, b, `${m.change.id} does not apply${r.conflict.with ? ` (conflicts with ${r.conflict.with.id})` : ""}: sent back`);
      continue;
    }
    const e = entryOf(s, m.change);
    if (e && e.sha === m.head) e.chainSha = r.sha;
    chain.push({ ...m, sha: r.sha, ...(r.tree ? { tree: r.tree } : {}) });
  }
  b.members = chain;
  if (chain.length === 0) return endBatch(ctx, b, "no change applied", []);
  b.status = "testing";
  note(ctx, b, `chain built: ${names(chain.map((m) => m.change))} on ${short(b.base)}`);
}

function runFinished(ctx: Ctx, input: Of<"run-finished"> | Of<"rerun-finished">): void {
  const b = current(ctx.s);
  const kind = input.kind === "run-finished" ? "full" : "rerun";
  const p = b?.probes.find((x) => x.id === input.run && (x.status === "queued" || x.status === "running"));
  if (!b || !p || p.sha !== input.sha || p.kind !== kind) return void note(ctx, null, `ignored: no ${kind} run ${input.run} on ${short(input.sha)} is awaited`);
  p.finishedAt = ctx.now;
  if (input.ref) p.run = input.ref;
  if (input.outcome !== "cancelled" && input.ms !== undefined && Number.isFinite(input.ms) && input.ms >= 0) {
    p.ms = input.ms;
    measure(ctx, b, p);
  }
  if (input.outcome === "cancelled") {
    p.status = "cancelled";
  } else if (input.outcome === "fail") {
    p.status = "failed";
    p.report = capReport(input.report, ctx.config.reportFileCap);
  } else if (input.kind === "rerun-finished" && !rerunRan(p.files ?? [], input.ran)) {
    // A green rerun proves a flake only if the failed files really ran.
    p.status = "failed";
    p.report = { files: [], excerpt: "The rerun passed, but it does not show that the failed test files ran." };
  } else {
    p.status = "passed";
  }
  note(ctx, b, `${kind === "rerun" ? "rerun" : "run"} ${p.id} of prefix ${p.prefix} ${p.status}`);
}

/** Takes a timed run into the measured rates: the duration by prefix for a full run, the cost against the red run it repeats for a rerun. */
function measure(ctx: Ctx, b: QueueBatch, p: QueueProbe): void {
  const m = (ctx.s.measured ??= emptyMeasured());
  const ms = p.ms ?? 0;
  if (p.kind === "full") {
    m.d.n++;
    m.d.sx += p.prefix;
    m.d.sy += ms;
    m.d.sxx += p.prefix * p.prefix;
    m.d.sxy += p.prefix * ms;
    return;
  }
  const red = [...b.probes].reverse().find((x) => x.kind === "full" && x.prefix === p.prefix && x.status === "failed" && x.ms !== undefined);
  if (!red?.ms) return;
  m.f.n++;
  m.f.rerunMs += ms;
  m.f.fullMs += red.ms;
}

function mergeResult(ctx: Ctx, input: Of<"merge-result">): void {
  const { s } = ctx;
  const b = current(s);
  if (!b?.merge || b.id !== input.batch || b.merge.to !== input.to) return void note(ctx, null, `ignored: no fast-forward to ${short(input.to)} is awaited`);
  const merge = b.merge;
  delete b.merge;
  if (input.ok) {
    delete b.toMerge;
    if (s.main === merge.expect) s.main = merge.to;
    markMerged(ctx, b, merge.prefix, false);
    if (input.main !== undefined) s.main = input.main;
    return;
  }
  if (input.main !== undefined) s.main = input.main;
  if (s.main !== merge.expect) return note(ctx, b, `the fast-forward to ${short(merge.to)} was refused: the main branch moved`);
  // The main branch is where it should be and the host still says no. Running the suite again will not help.
  const message = `The host refused to fast-forward the main branch from ${short(merge.expect)} to ${short(merge.to)} (batch ${b.id}). The queue is paused; resume it to try again.`;
  pause(ctx, message, "queue");
  ctx.effects.push({ kind: "report-problem", message });
  note(ctx, b, "the fast-forward was refused though the main branch did not move: paused");
}

function mainMoved(ctx: Ctx, sha: string): void {
  const { s } = ctx;
  if (s.main === sha) return;
  const b = current(s);
  if (b && b.status === "testing") {
    if (b.merge && sha === b.merge.to) {
      // The fast-forward went through; this is its answer arriving another way.
      const prefix = b.merge.prefix;
      delete b.merge;
      delete b.toMerge;
      s.main = sha;
      return markMerged(ctx, b, prefix, false);
    }
    const behind = sha !== expectedMain(b) && (sha === b.base || b.members.slice(0, b.good).some((m) => m.sha === sha));
    if (behind) return note(ctx, b, `ignored: ${short(sha)} is an older main branch head`);
  }
  s.main = sha;
  note(ctx, b, `the main branch is at ${short(sha)}`);
}
