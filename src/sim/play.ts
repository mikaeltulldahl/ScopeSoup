// A seeded run: the world, a list of actions drawn by weight (or given, to replay), the rules checked after every step, a fair
// tail at the end, and, on a failure, a report of one screen and the steps shrunk to a pasteable test.

import type { Rule } from "./rules.ts";
import { RULES } from "./rules.ts";
import type { Observation } from "./observe.ts";
import { observe } from "./observe.ts";
import type { Rng } from "./random.ts";
import { random } from "./random.ts";
import { wText } from "./waits.ts";
import type { Action, WorldOptions } from "./world.ts";
import { SimWorld } from "./world.ts";
import { where } from "../orchestrator/jobs.ts";
import { readProposedRewrites } from "../orchestrator/aboutOthers.ts";
import { mergeQueueOn, switchState } from "../store/control.ts";

export type Profile = "calm" | "normal" | "rough";

export interface RunOptions extends WorldOptions {
  /** Random steps before the fair tail. */
  steps: number;
  profile: Profile;
  /** The long run: losing the store is a step too. */
  long?: boolean;
  /** Print every step (SCOPESOUP_SIM_TRACE=1). */
  trace?: boolean;
}

export interface Failure {
  rule: string;
  step: number;
  message: string;
}

export interface RunResult {
  seed: number;
  options: RunOptions;
  actions: Action[];
  failures: Failure[];
  /** The first failure in full words, one screen, per rule. */
  reports: Map<string, string>;
  seen: Map<string, number>;
  /** Every W kind seen, as `kind` or `person(why)`. */
  waits: Set<string>;
  events: string[];
  steps: number;
  /** Changes merged to main (by a session, the queue or a person's merge of an Item's branch). */
  merges: number;
}

/** The options a seed plays with: 3 to 6 Items (up to 12 in the long run), a level from 2 to 4, 1 to 3 slots, and a profile. */
export function optionsFor(seed: number, long: boolean, steps: number): RunOptions {
  const rnd = random(seed * 7919);
  return {
    items: long ? 3 + rnd.int(10) : 3 + rnd.int(4),
    level: 2 + rnd.int(3),
    slots: 1 + rnd.int(3),
    steps,
    profile: (["calm", "normal", "normal", "rough"] as const)[rnd.int(4)]!,
    long,
    // Every seed of the long run plays a world where triages age and days pass (#217, #264).
    ...(long ? { ageing: true as const } : {}),
  };
}

/**
 * A person acts on an Item whose work is busy (#268): a session runs on it, it is parked, or it owes a hand-over. They pick a move on
 * its page or decide a proposed rewrite of its description. The long run of the single-machine profile only; the normal run and the
 * multiplayer runs draw as they did.
 */
const BUSY: Record<Profile, number> = { calm: 3, normal: 6, rough: 8 };
const HOT = 25;

const WEIGHTS: Record<Profile, Record<string, number>> = {
  calm: { tick: 30, end: 22, answer: 22, other: 5, sync: 8, clock: 6, world: 2, restart: 0.5, inside: 0.5 },
  normal: { tick: 30, end: 20, answer: 20, other: 10, sync: 8, clock: 6, world: 4, restart: 1, inside: 1 },
  rough: { tick: 28, end: 18, answer: 16, other: 16, sync: 6, clock: 6, world: 8, restart: 2, inside: 2 },
};

/** Draws the next action from what the world shows now. Targets are named by id, so a list replays with parts taken out. */
export function draw(world: SimWorld, rnd: Rng, options: RunOptions): Action {
  const items = world.items();
  const open = items.filter((i) => i.state !== "done" && i.state !== "abandoned");
  const ids = items.map((i) => i.ref.id);
  const v = () => rnd.int(1_000_000);
  const jobs = world.jobs();
  const live = [...world.runner.live.values()].map((l) => l.session.subject.id);
  // What a person may do while an Item's work is busy (#268): its session runs, it is parked, or it owes a hand-over.
  const busy = open.filter((i) => {
    const at = where(jobs[`metaBranch:work:${i.ref.id}`]);
    return live.includes(i.ref.id) || at?.parked !== undefined || at?.owes !== undefined;
  }).map((i) => i.ref.id);
  const proposed = world.shared ? [] : Object.keys(readProposedRewrites(world.store)).map((key) => key.split(":").pop()!).filter((id) => open.some((i) => i.ref.id === id));
  const both = busy.filter((id) => proposed.includes(id));
  // A change the reviewer approved at the head it is at, not in the merge queue and not picked for it yet: the person asks for its review
  // again, or for the merge queue, also while that review runs again (a Merge queue pick over a review on an approved head, #211 step 3).
  const approved = open.filter((i) => {
    const job = jobs[`metaBranch:work:${i.ref.id}`];
    return job?.review?.verdict === "approve" && job.head !== undefined && job.reviewedHead === job.head && where(job).parked?.as !== "queued" && where(job).merged === undefined && job.queueAskedBy === undefined;
  }).map((i) => i.ref.id);
  const reviewing = approved.filter((id) => [...world.runner.live.values()].some((l) => l.session.subject.id === id && l.session.role === "review"));
  // The person watches the board: while such a moment lasts (a proposed rewrite on a busy Item, an approved change), they act sooner.
  const hot = both.length > 0 || approved.length > 0;
  const weights: Record<string, number> = { ...WEIGHTS[options.profile], ...(options.long ? { lose: 0.3 } : {}), ...(world.shared || !options.long ? {} : { busy: reviewing.length > 0 ? 4 * HOT : hot ? HOT : BUSY[options.profile] }) };
  // A person's Merge queue pick over a session that still runs: the tick that ends that session for it mostly comes before the session
  // ends by itself, so the hand-over owed beside the running session is what the tick reads (#211 step 3, #268).
  const owedOverSession = !world.shared && options.long === true && open.some((i) => where(jobs[`metaBranch:work:${i.ref.id}`])?.owes !== undefined && live.includes(i.ref.id));
  if (owedOverSession && rnd.chance(0.8)) return { kind: "tick" };
  const kind = rnd.weighted(weights);
  const asking = open.filter((i) => where(jobs[`metaBranch:work:${i.ref.id}`])?.parked || (i.openQuestions ?? []).length > 0).map((i) => i.ref.id);
  const person = (): Action => {
    const roll = rnd.int(16);
    const id = rnd.pick(open.length > 0 ? open.map((i) => i.ref.id) : ids) ?? "A-1";
    if (roll < 3) return { kind: "edit", item: id, v: v() };
    if (roll < 5) return { kind: "close", item: id, state: rnd.chance(0.5) ? "done" : "abandoned" };
    if (roll < 6) {
      const closed = items.filter((i) => i.state === "done" || i.state === "abandoned").map((i) => i.ref.id);
      return { kind: "reopen", item: rnd.pick(closed) ?? id };
    }
    if (roll < 7) return { kind: "claim", item: id };
    if (roll < 8) return { kind: "release", item: rnd.pick(open.filter((i) => i.holder).map((i) => i.ref.id)) ?? id };
    if (roll < 10) return { kind: "move", item: id, v: v() };
    if (roll < 11) return rnd.chance(0.5) ? { kind: "start-over", item: id } : { kind: "lane", item: id, to: rnd.chance(0.7) ? "todo" : "backlog" };
    if (roll < 12) return items.length < (options.long ? 14 : 8) ? { kind: "new-item", v: v() } : { kind: "edit", item: id, v: v() };
    if (roll < 14) return { kind: "switch", to: rnd.pick(["pause", "resume", "resume", "stop"] as const)! };
    if (roll < 15) return { kind: "level", to: rnd.pick([1, 2, 3, 4, 4, 3])! };
    return rnd.chance(0.75) ? { kind: "slots", to: 1 + rnd.int(3) } : ((triage: number) => ({ kind: "caps" as const, triage, work: triage + rnd.int(3) }))(1 + rnd.int(2));
  };
  switch (kind) {
    case "end":
      return live.length > 0 ? { kind: "end", item: rnd.pick(live)!, v: v() } : { kind: "tick" };
    case "answer":
      return asking.length > 0 ? { kind: "answer", item: rnd.pick(asking)!, v: v() } : { kind: "tick" };
    case "other":
      return person();
    case "sync":
      return { kind: "sync" };
    case "clock":
      // Where triages age (#217), half the clock steps are a person's commit on main instead (which may let a day pass).
      if (world.ageing && rnd.chance(0.5)) return { kind: "main-commit", v: v() };
      return { kind: "clock", ms: rnd.pick([1000, 60_000, 31 * 60_000, 3 * 3600_000])! };
    case "world": {
      const roll = rnd.int(7);
      if (roll === 0) return { kind: "main-commit", v: v() };
      if (roll === 1) return { kind: "host-down", steps: 1 + rnd.int(3) };
      if (roll === 2) return { kind: "foreign-claim", item: rnd.pick(open.map((i) => i.ref.id)) ?? "A-1" };
      if (roll === 3) {
        const which = rnd.int(10);
        return which < 4 ? { kind: "usage", reserve: true } : which < 7 ? { kind: "usage", reserve: false, pace: true } : { kind: "usage", reserve: false };
      }
      if (roll === 4 && world.queue.waiting.size > 0) return { kind: "queue", item: rnd.pick([...world.queue.waiting.keys()])!.split(":").pop()!, merge: rnd.chance(0.7) };
      const handed = Object.values(jobs).filter((j) => where(j).parked?.as === "handed-over" || where(j).parked?.as === "escalated").map((j) => j.item.id);
      if (roll === 5 && handed.length > 0) return { kind: "person-merge", item: rnd.pick(handed)! };
      // A person works in the clone while an Item runs: their tag, branch and stash entry are never an agent's (I6).
      if (roll === 6 && live.length > 0) return { kind: "person-refs", v: v() };
      return { kind: "main-commit", v: v() };
    }
    case "busy": {
      // Below level 4 the merge queue is no person's pick (decision 104): now and then they raise the level while such a change waits,
      // mostly while its review runs again.
      if (approved.length > 0 && world.configNow.level === 3 && rnd.chance(reviewing.length > 0 ? 0.8 : 0.2)) return { kind: "level", to: 4 };
      // Such a change waits while the agents or the merge queue are paused (a restart pauses them): the person resumes them.
      if (approved.length > 0 && (switchState(world.store, "review") !== "started" || !mergeQueueOn(world.store)) && rnd.chance(0.6)) return { kind: "switch", to: "resume" };
      if (both.length > 0 && rnd.chance(0.7)) return { kind: "proposed", item: rnd.pick(both)!, v: v() };
      if (proposed.length > 0 && rnd.chance(0.2)) return { kind: "proposed", item: rnd.pick(proposed)!, v: v() };
      if (reviewing.length > 0 && rnd.chance(0.9)) return { kind: "move", item: rnd.pick(reviewing)!, v: v(), keen: true };
      if (approved.length > 0 && rnd.chance(0.5)) return { kind: "move", item: rnd.pick(approved)!, v: v(), keen: true };
      return busy.length > 0 ? { kind: "move", item: rnd.pick(busy)!, v: v(), ...(rnd.chance(0.5) ? { keen: true as const } : {}) } : { kind: "tick" };
    }
    case "restart":
      return { kind: "restart" };
    case "lose":
      return { kind: "lose-store" };
    case "inside": {
      const inner = rnd.chance(0.5) && asking.length > 0 ? { kind: "answer" as const, item: rnd.pick(asking)!, v: v() } : person();
      return { kind: "inside-tick", inner };
    }
    default:
      return { kind: "tick" };
  }
}

/** The fair tail, one round: release a person's holds, end each session, answer each ask, merge what was handed over, tick. */
export function fairRound(world: SimWorld, round: number): Action[] {
  const out: Action[] = [];
  const jobs = world.jobs();
  for (const item of world.items()) {
    if (item.state === "done" || item.state === "abandoned") continue;
    const id = item.ref.id;
    const job = jobs[`metaBranch:work:${id}`];
    if (item.holder && item.holder.actor.bot !== true) out.push({ kind: "release", item: id });
    // Backlog and To do (#221): under Fair a person pulls every Item into To do.
    if (round === 0) out.push({ kind: "lane", item: id, to: "todo" });
    if (world.liveFor(id)) out.push({ kind: "end", item: id, v: round * 31 + Number(id.slice(2)) });
    if (where(job)?.parked?.as === "handed-over") out.push({ kind: "person-merge", item: id });
    else if (where(job)?.parked || (item.openQuestions ?? []).length > 0) out.push({ kind: "answer", item: id, v: round });
    if (world.queue.waiting.has(`metaBranch:work:${id}`)) out.push({ kind: "queue", item: id, merge: true });
  }
  out.push({ kind: "sync" }, { kind: "tick" }, { kind: "clock", ms: round % 3 === 2 ? 31 * 60_000 : 1000 }, { kind: "tick" });
  return out;
}

export interface Played {
  result: RunResult;
  observations?: Observation[];
}

/**
 * Plays a run. With `given`, the actions are replayed as they are (the fair tail included), and an action whose target is
 * gone does nothing; without, they are drawn from the seed. `stopAt` ends the run after that step (shrinking).
 */
export async function play(seed: number, options: RunOptions, given?: Action[], rules: Rule[] = RULES, stopAt = Infinity): Promise<RunResult> {
  const world = new SimWorld(options);
  await world.init(options.items);
  const rnd = random(seed);
  const actions: Action[] = [];
  const failures: Failure[] = [];
  const reports = new Map<string, string>();
  const waits = new Set<string>();
  const memo = new Map<string, Record<string, unknown>>(rules.map((rule) => [rule.id, {}]));
  let prev: Observation | undefined;
  const recent: string[] = [];
  const check = (o: Observation, only?: string): void => {
    for (const each of o.items) waits.add(each.w.kind === "person" ? `person(${each.w.why})` : each.w.kind === "start" ? `start(${each.w.cause})` : each.w.kind);
    // What decision 133 holds back, so the runs show they reach it: the pace holding a start, and new triage waiting at its cap.
    if (o.tick?.paced) waits.add("tick(paced)");
    for (const capped of o.tick?.capped ?? []) waits.add(capped.startsWith("new triage") ? "tick(triage-capped)" : "tick(work-capped)");
    for (const rule of rules) {
      if (reports.has(rule.id) || (only && rule.id !== only)) continue;
      let message: string | null;
      try {
        message = rule.check(o, prev, memo.get(rule.id)!);
      } catch (error) {
        message = `the check threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (!message) continue;
      failures.push({ rule: rule.id, step: o.step, message });
      reports.set(rule.id, report(seed, o, rule.id, message, recent, options.long === true));
    }
  };
  const run = async (action: Action): Promise<void> => {
    world.step = actions.length;
    actions.push(action);
    const before = world.runner.requests.length;
    await world.apply(action);
    const o = await observe(world, seed, action, prev, before);
    // Triages Scope Soup took again on its own (#217), counted as they happen: a lost store takes its events with it.
    for (const e of o.events) if (e.kind === "orchestrator.triage_again") world.count((e.data as Record<string, unknown> | undefined)?.background === true ? "retriage-share" : "retriage-before-start");
    recent.push(`${o.step} ${actionText(action)}`);
    if (recent.length > 8) recent.shift();
    if (options.trace) console.log(`seed ${seed} step ${o.step}: ${actionText(action)} | ${o.items.map((i) => `${i.id} ${wText(i.w)}`).join(" · ")}`);
    check(o);
    prev = o;
  };
  if (given) {
    for (const action of given) {
      if (actions.length > stopAt) break;
      await run(action);
    }
  } else {
    for (let i = 0; i < options.steps; i++) await run(draw(world, rnd, options));
    await run({ kind: "fair" });
    // The tail: N rounds, or until every Item is at an end.
    // Two ticks a round: about 40 ticks plus 25 per Item, as the issue starts N at.
    const rounds = 20 + 12 * options.items;
    for (let round = 0; round < rounds; round++) {
      for (const action of fairRound(world, round)) await run(action);
      if (world.items().every((i) => i.state === "done" || i.state === "abandoned")) break;
    }
  }
  if (prev && actions.length <= stopAt) {
    const final: Observation = { ...prev, final: true };
    check(final, "H1");
  }
  const events = world.store.eventsAfter(0, 1_000_000).map((e) => JSON.stringify([e.kind, e.subject ?? "", e.actor, e.data]).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "uuid"));
  const merges = world.git.mainMoves.filter((m) => m.item).length;
  return { seed, options, actions, failures, reports, seen: world.ledger.seen, waits, events, steps: actions.length, merges };
}

export function actionText(action: Action): string {
  switch (action.kind) {
    case "end":
      return `end the session of ${action.item} (${action.v})`;
    case "answer":
      return `person answers ${action.item} (${action.v})`;
    case "inside-tick":
      return `tick, with inside it: ${actionText(action.inner)}`;
    case "clock":
      return `clock +${action.ms / 1000} s`;
    default: {
      const { kind, ...rest } = action as Record<string, unknown>;
      const args = Object.values(rest).join(" ");
      return args ? `${kind} ${args}` : String(kind);
    }
  }
}

function report(seed: number, o: Observation, rule: string, message: string, recent: string[], long: boolean): string {
  return [
    `seed ${seed}, step ${o.step}, rule ${rule}: ${message}`,
    `step ${o.step}: ${actionText(o.action)}`,
    `last steps: ${recent.join(" · ")}`,
    `Items: ${o.items.map((i) => `${i.id} W=${wText(i.w)} lane=${i.card?.lane ?? "-"}`).join(" · ")}`,
    `replay: ${long ? "SCOPESOUP_LONG=1 " : ""}SCOPESOUP_SIM_SEED=${seed} node --test src/sim/lifecycle.property.test.ts`,
  ].join("\n");
}

/**
 * Shrinks a failing run for one rule: cut at the failing step, then take out chunks (halves, quarters, single steps), keeping a
 * removal when the rule still fails. At most 200 replays or 5 s.
 */
export async function shrink(result: RunResult, rule: string): Promise<Action[]> {
  const rules = RULES.filter((r) => r.id === rule);
  const failing = result.failures.find((f) => f.rule === rule);
  if (!failing) return result.actions;
  let list = result.actions.slice(0, failing.step + 1);
  const until = Date.now() + 5000;
  let replays = 0;
  const fails = async (candidate: Action[]): Promise<boolean> => {
    replays++;
    const again = await play(result.seed, result.options, candidate, rules);
    return again.failures.some((f) => f.rule === rule);
  };
  for (let size = Math.max(1, Math.floor(list.length / 2)); size >= 1; size = Math.floor(size / 2)) {
    for (let at = 0; at < list.length && replays < 200 && Date.now() < until;) {
      const candidate = [...list.slice(0, at), ...list.slice(at + size)];
      if (candidate.length > 0 && (await fails(candidate))) list = candidate;
      else at += size;
    }
    if (replays >= 200 || Date.now() >= until) break;
  }
  return list;
}

/** The shrunk steps as a test to paste into `src/sim/rules.test.ts`. */
export function pasteable(result: RunResult, rule: string, actions: Action[]): string {
  const { items, level, slots, steps, profile, ageing } = result.options;
  return [
    `test("${rule}: seed ${result.seed}, shrunk", async () => {`,
    `  await failsOn("${rule}", ${JSON.stringify({ items, level, slots, steps, profile, ...(ageing ? { ageing } : {}) })}, [`,
    ...actions.map((a) => `    ${JSON.stringify(a)},`),
    "  ]);",
    "});",
  ].join("\n");
}
