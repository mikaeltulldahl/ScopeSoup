// The multiplayer profile of the lifecycle simulator (#211, plan step 4): two or three machines, each a whole `SimWorld` (its own
// store, server, runner, tick, clone and clock skew), sharing the in-memory meta remote (compare-and-swap writes, `metaHost.ts`),
// the picks' requests on it, and the git remote's main and commits (`GitOrigin`). Steps are drawn for one machine at a time: the
// single-machine steps (`draw` in `play.ts`), a fetch (the meta remote into the store, then the picks asked of this machine), a
// machine going offline for a while, another machine's push landing between this machine's read and its swap (a rejected push), and
// a person's pick on this machine's board for an Item whose work runs on another. Each machine is checked after its own steps with
// the single-machine rules that apply to one machine of several; the rules across machines (`multiRules.ts`) after every step and,
// after all machines sync and stop, at the end.

import { readRequests } from "../hosts/metaBranch/requests.ts";
import { serializeLogLine } from "../hosts/metaBranch/serialize.ts";
import { refKey } from "../model/types.ts";
import type { RecordedAnswer, ScopeSoupEvent, WorkItem } from "../model/types.ts";
import type { PickRequestPort } from "../server/server.ts";
import { knownAnswers } from "../store/answers.ts";
import { FakeGit, GitOrigin } from "./git.ts";
import { MetaRemote } from "./metaHost.ts";
import type { MetaFiles } from "./metaHost.ts";
import type { MultiObs, MultiRule } from "./multiRules.ts";
import { MULTI_RULES, noteTexts } from "./multiRules.ts";
import type { Observation } from "./observe.ts";
import { observe } from "./observe.ts";
import type { Profile, RunOptions } from "./play.ts";
import { actionText, draw, fairRound } from "./play.ts";
import type { Rng } from "./random.ts";
import { random } from "./random.ts";
import type { Rule } from "./rules.ts";
import { RULES } from "./rules.ts";
import type { SessionRequest } from "../orchestrator/ports.ts";
import { wText } from "./waits.ts";
import type { Action } from "./world.ts";
import { PERSON, SimWorld, T0 } from "./world.ts";

/**
 * One machine's way to the shared meta remote: the same remote, but offline on its own (`down`), and with other machines' pushes
 * that land between its read and its swap (`races`), so its swap is refused and it reads and decides again.
 */
export class RemoteLink {
  shared: MetaRemote;
  down = 0;
  /** How many of this machine's next swaps another machine's push gets ahead of. */
  races = 0;
  /** Another machine's push, made when a race is due. */
  racer: (() => void) | null = null;

  constructor(shared: MetaRemote) {
    this.shared = shared;
  }

  get version(): number {
    return this.shared.version;
  }

  get files(): ReadonlyMap<string, MetaFiles> {
    return this.shared.files;
  }

  get next(): Map<string, number> {
    return this.shared.next;
  }

  get refusedRewrites(): string[] {
    return this.shared.refusedRewrites;
  }

  get retries(): number {
    return this.shared.retries;
  }

  set retries(n: number) {
    this.shared.retries = n;
  }

  swap(expected: number, next: ReadonlyMap<string, MetaFiles>): boolean {
    if (this.down > 0) throw new Error("the remote did not answer");
    if (this.races > 0 && this.racer) {
      this.races--;
      this.racer();
    }
    return this.shared.swap(expected, next);
  }

  read(): { version: number; files: ReadonlyMap<string, MetaFiles> } {
    if (this.down > 0) throw new Error("the remote did not answer");
    return this.shared.read();
  }
}

/** A map whose entries stay: `delete` keeps them. */
class KeptMap<K, V> extends Map<K, V> {
  override delete(_key: K): boolean {
    return false;
  }
}

export const MACHINES = ["laptop-a", "laptop-b", "laptop-c"];

export interface Machine {
  index: number;
  name: string;
  world: SimWorld;
  link: RemoteLink;
  /** This machine's clock minus the shared one, in milliseconds. */
  skew: number;
  /** The picks' request lines as this machine last fetched them, with its own writes since. */
  requests: string[];
  /** The last observation of this machine, for its rules. */
  prev?: Observation;
  memo: Map<string, Record<string, unknown>>;
  rules: Rule[];
  /** Sessions started so far on this machine (each runner's requests, across restarts). */
  started: { step: number; request: SessionRequest }[];
  /** The step of this machine's last sync (a fetch or the world's sync step). */
  syncedAt: number;
  /** The step this machine was last checked at, and the step another machine last acted at (a push it reads at its next tick). */
  checkedAt: number;
  othersActedAt: number;
}

/** A step of a multiplayer run, as plain data. */
export type MultiAction =
  | { m: number; kind: "act"; a: Action }
  | { m: number; kind: "fetch" }
  | { m: number; kind: "offline"; steps: number }
  | { m: number; kind: "race"; n: number }
  | { m: number; kind: "pick"; item: string; v: number };

export interface MultiOptions extends RunOptions {
  machines: number;
  /** Called after every step, for looking into a run while it plays (a script, not the test). */
  inspect?: (world: MultiWorld, step: MultiAction) => void;
}

export interface MultiFailure {
  rule: string;
  step: number;
  machine?: string;
  message: string;
}

export interface MultiResult {
  seed: number;
  options: MultiOptions;
  steps: number;
  failures: MultiFailure[];
  /** The first failure in full words, per rule. */
  reports: Map<string, string>;
  seen: Map<string, number>;
}

/**
 * The single-machine rules that hold for one machine of several. Left out: the ones that compare the shared host with this
 * machine's own ledger (B2, E1, E3: another machine's person writes there too; `multiRules.ts` has them across machines), and,
 * on the machines other than the first, the ones that name the first machine's claimant (C3, H3).
 */
const NOT_PER_MACHINE = new Set(["B2", "E1", "E3"]);
const FIRST_MACHINE_ONLY = new Set(["C3", "H3"]);
/**
 * Rules about what takes the remote (letting go of a claim; closing a merged Item, C2, #238): not checked while the machine is
 * offline (longer than a single run's "host down").
 */
const OFFLINE_EXCUSED = new Set(["C2", "C3", "H3"]);
/** Rules that a person's request excuses: one on another machine's board counts too. */
const EXCUSED_BY_ANY_BOARD = new Set(["C1", "J2", "J3"]);
/** Rules about "run again at once": with another machine's step in between, the second tick may read what it pushed (F3). */
const ALONE_ONLY = new Set(["F3"]);

export function rulesFor(index: number): Rule[] {
  return RULES.filter((rule) => !NOT_PER_MACHINE.has(rule.id) && (index === 0 || !FIRST_MACHINE_ONLY.has(rule.id)));
}

/** The options a seed plays with: 2 or 3 machines, 3 to 5 Items (up to 8 in the long run), a level from 2 to 4, 1 to 2 slots. */
export function multiOptionsFor(seed: number, long: boolean, steps: number): MultiOptions {
  const rnd = random(seed * 104_729);
  return {
    machines: 2 + rnd.int(2),
    items: long ? 3 + rnd.int(6) : 3 + rnd.int(3),
    level: 2 + rnd.int(3),
    slots: 1 + rnd.int(2),
    steps,
    profile: (["calm", "normal", "normal", "rough"] as const)[rnd.int(4)] as Profile,
    long,
  };
}

export class MultiWorld {
  /** The shared clock; each machine's is this plus its skew. */
  ms = T0;
  step = 0;
  remote = new MetaRemote();
  origin = new GitOrigin();
  /** The picks' request lines on the meta remote. */
  requestLines: string[] = [];
  machines: Machine[] = [];
  /** Items a person filed from another machine while this one wrote (the racer), with their text: key, step. */
  filed: { key: string; step: number; title: string; body: string }[] = [];
  /** Picks a board wrote as requests for another machine: the request id, the machine asked, the step. */
  picks: { id: string; for: string; from: string; step: number; item: string }[] = [];
  seen = new Map<string, number>();
  /**
   * Items a person asked to close, on any machine's board. A reopen does not take one off: another machine may not have fetched the
   * reopen yet, and still rightly shows the Item closed.
   */
  closesAsked: Map<string, number> = new KeptMap();
  private sharedJ3: Record<string, unknown> = {};
  private rnd: Rng;
  private options: MultiOptions;
  /** A race's push is being made: it does not race again. */
  private racing = false;

  constructor(seed: number, options: MultiOptions) {
    this.options = options;
    this.rnd = random(seed * 31 + 7);
    const skews = random(seed * 613);
    for (let index = 0; index < options.machines; index++) {
      const name = MACHINES[index]!;
      const link = new RemoteLink(this.remote);
      const git = new FakeGit(this.origin);
      const machine: Machine = {
        index, name, link, skew: index === 0 ? 0 : (skews.int(181) - 90) * 1000, requests: [], memo: new Map(), rules: rulesFor(index), started: [], syncedAt: 0, checkedAt: 0, othersActedAt: 0,
        world: undefined as unknown as SimWorld,
      };
      machine.world = new SimWorld(options, { machine: name, idPrefix: name.slice(-1).toUpperCase(), remote: link as unknown as MetaRemote, git, requests: this.requestPort(machine) });
      machine.world.ms = this.ms + machine.skew;
      // A person's close is the project's, whichever board it was made on (C1, A5, I4 read it).
      machine.world.ledger.closesAsked = this.closesAsked;
      // J3's "new" is new to the run, not to this machine: an Item filed and moved to To do on one board is not new where it is fetched.
      machine.memo = new Map(machine.rules.map((rule) => [rule.id, rule.id === "J3" ? this.sharedJ3 : {}]));
      link.racer = () => this.race(machine);
      this.machines.push(machine);
    }
  }

  count(what: string): void {
    this.seen.set(what, (this.seen.get(what) ?? 0) + 1);
  }

  async init(items: number): Promise<void> {
    await this.machines[0]!.world.init(items);
    for (const m of this.machines) await this.fetch(m);
  }

  /** The picks' requests as one machine reads and writes them: its last fetch; a write pushes the line, which moves the meta ref. */
  private requestPort(m: Machine): PickRequestPort {
    return {
      machine: m.name,
      list: () => readRequests(m.requests.join("\n")),
      write: async (line) => {
        try {
          const text = serializeLogLine({ at: m.world.now(), by: { ...line.by, machine: m.name }, kind: line.kind, fields: line.fields });
          for (let attempt = 0; ; attempt++) {
            if (attempt >= 5) return { ok: false, error: "the remote kept moving" };
            const { version, files } = m.link.read();
            if (m.link.swap(version, files)) break;
            this.remote.retries++;
          }
          this.requestLines.push(text);
          m.requests = [...this.requestLines];
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  }

  /** Another machine's push gets in first: its person files an Item (in Backlog), or it pushes something else on the meta ref. */
  private race(m: Machine): void {
    if (this.racing) return;
    this.racing = true;
    try {
      this.raceOnce(m);
    } finally {
      this.racing = false;
    }
  }

  private raceOnce(m: Machine): void {
    const others = this.machines.filter((each) => each !== m && each.link.down === 0);
    const other = this.rnd.pick(others);
    if (!other) {
      this.remote.swap(this.remote.version, this.remote.files);
      return;
    }
    this.count("race");
    if (this.remote.files.size < (this.options.long ? 12 : 8) && this.rnd.chance(0.5)) {
      const n = this.rnd.int(1000);
      const title = `Filed on ${other.name} ${n}`;
      const body = `Do the thing filed on ${other.name}, ${n}.`;
      // Synchronous: the fake host writes before its first await, so this lands between the read and the swap.
      void other.world.host.write!.createWork!({ title, body, log: [{ kind: "created", by: { who: PERSON, agent: false } }] }).then((out) => {
        this.filed.push({ key: refKey(out.work!), step: this.step, title, body });
      });
      this.count("race-filed");
      return;
    }
    this.remote.swap(this.remote.version, this.remote.files);
  }

  /** Fetches the meta remote into the machine's store, then carries out the picks asked of it. */
  async fetch(m: Machine): Promise<void> {
    if (m.link.down > 0) return;
    m.requests = [...this.requestLines];
    await m.world.sync();
    const n = await m.world.server.carryOutRequests();
    if (n > 0) this.count("picks-carried-out");
    this.count("fetch");
  }

  setClock(ms: number): void {
    this.ms = ms;
    for (const m of this.machines) m.world.ms = this.ms + m.skew;
  }

  /** Draws the next step: which machine, then what. */
  draw(): MultiAction {
    const rnd = this.rnd;
    const m = this.machines[rnd.int(this.machines.length)]!;
    const roll = rnd.next();
    if (roll < 0.12) return { m: m.index, kind: "fetch" };
    if (roll < 0.14) return { m: m.index, kind: "offline", steps: 3 + rnd.int(15) };
    if (roll < 0.18) return { m: m.index, kind: "race", n: rnd.chance(0.1) ? 6 : 1 + rnd.int(3) };
    if (roll < 0.23) {
      const now = m.world.ms;
      const elsewhere = m.world.items().filter((i) => i.holder?.actor.bot && i.holder.actor.id !== `scopesoup@${m.name}` && (!i.holder.until || Date.parse(i.holder.until) > now) && i.state !== "done" && i.state !== "abandoned");
      const item = rnd.pick(elsewhere);
      if (item) return { m: m.index, kind: "pick", item: item.ref.id, v: rnd.int(1_000_000) };
    }
    let a = draw(m.world, rnd, this.options);
    // Another machine's claim is a real machine here; the store is not lost in this profile.
    if (a.kind === "foreign-claim" || a.kind === "lose-store") a = { kind: "tick" };
    if (a.kind === "inside-tick" && (a.inner.kind === "foreign-claim" || a.inner.kind === "lose-store")) a = { kind: "tick" };
    return { m: m.index, kind: "act", a };
  }

  async apply(step: MultiAction): Promise<void> {
    const m = this.machines[step.m]!;
    switch (step.kind) {
      case "fetch":
        return this.fetch(m);
      case "offline":
        m.link.down = Math.max(m.link.down, step.steps);
        this.count("offline");
        return;
      case "race":
        m.link.races = step.n;
        return;
      case "pick": {
        const item = m.world.store.get<WorkItem>(m.world.ref(step.item));
        if (!item) return;
        const r = random(step.v);
        const steps = r.pick([[{ kind: "move", to: "todo" }], [{ kind: "move", to: "triage" }], [{ kind: "state", state: "abandoned" }], [{ kind: "move", to: "todo" }, { kind: "lane", lane: "backlog" }]])!;
        const got = await m.world.request("POST", "/api/item/pick", { ref: m.world.key(step.item), seen: item.updatedAt, steps }, step.item);
        if (got.status === 202) {
          const requested = (got.json as { requested?: { id: string; for: string } }).requested;
          if (requested) this.picks.push({ id: requested.id, for: requested.for, from: m.name, step: this.step, item: m.world.key(step.item) });
          // Abandoned, asked of the machine where the work runs: a person's close, carried out there.
          if (JSON.stringify(steps).includes("abandoned")) this.closesAsked.set(m.world.key(step.item), this.step);
          this.count("pick-requested");
        }
        if (got.status === 200 && JSON.stringify(steps).includes("abandoned")) m.world.ledger.closesAsked.set(m.world.key(step.item), this.step);
        return;
      }
      case "act": {
        const a = step.a;
        if (a.kind === "clock") return this.setClock(this.ms + a.ms);
        // The world's own "host down" is this machine offline (its link), counted down by its ticks.
        return m.world.apply(a);
      }
    }
  }

  /** What the rules across machines read. */
  observe(final: boolean): MultiObs {
    return {
      step: this.step,
      final,
      machines: this.machines.map((m) => ({
        name: m.name,
        items: m.world.items(),
        answers: knownAnswers(m.world.store) as RecordedAnswer[],
        live: [...m.world.runner.live.values()].map((each) => refKey(each.session.subject)),
        events: m.world.store.eventsAfter(0, 1_000_000) as ScopeSoupEvent[],
        ledger: m.world.ledger,
        started: m.started,
        now: m.world.ms,
        down: m.link.down > 0,
      })),
      remote: this.remote.files,
      requestLines: this.requestLines,
      picks: this.picks,
      filed: this.filed,
    };
  }
}

const isClosed = (item: WorkItem): boolean => item.state === "done" || item.state === "abandoned";

export function multiActionText(world: MultiWorld, step: MultiAction): string {
  const name = world.machines[step.m]!.name;
  switch (step.kind) {
    case "act":
      return `${name}: ${actionText(step.a)}`;
    case "offline":
      return `${name}: offline for ${step.steps} steps`;
    case "race":
      return `${name}: ${step.n} push(es) of others get ahead of its next swaps`;
    case "pick":
      return `${name}: a person picks for ${step.item} (${step.v})`;
    default:
      return `${name}: ${step.kind}`;
  }
}

/** Plays a multiplayer run: random steps, the fair tail on every machine, then every machine syncs and stops, and the end is checked. */
export async function playMulti(seed: number, options: MultiOptions, multiRules: MultiRule[] = MULTI_RULES): Promise<MultiResult> {
  const world = new MultiWorld(seed, options);
  await world.init(options.items);
  const failures: MultiFailure[] = [];
  const reports = new Map<string, string>();
  const recent: string[] = [];
  const multiMemo = new Map<string, Record<string, unknown>>(multiRules.map((rule) => [rule.id, {}]));
  const fail = (rule: string, message: string, machine?: string): void => {
    failures.push({ rule, step: world.step, message, ...(machine ? { machine } : {}) });
    if (reports.has(rule)) return;
    reports.set(rule, [
      `seed ${seed}, step ${world.step}, rule ${rule}${machine ? ` on ${machine}` : ""}: ${message}`,
      `last steps: ${recent.join(" · ")}`,
      `machines: ${world.machines.map((m) => `${m.name} (skew ${m.skew / 1000} s${m.link.down > 0 ? ", offline" : ""}): ${m.prev?.items.map((i) => `${i.id} W=${wText(i.w)}`).join(" · ") ?? ""}`).join(" | ")}`,
      `replay: ${options.long ? "SCOPESOUP_LONG=1 " : ""}SCOPESOUP_SIM_SEED=${seed} node --test src/sim/multi.property.test.ts`,
    ].join("\n"));
  };
  const checkMachine = async (m: Machine, action: Action, before: number, runner: unknown, only?: string): Promise<void> => {
    const o = await observe(m.world, seed, action, m.prev, runner === m.world.runner ? before : 0);
    // For the rules a person's request excuses (C1, J2, J3), a request on any board since this machine's sync before last counts:
    // this machine sees its effect at its next sync.
    const since = m.syncedAt;
    if (action.kind === "sync" && m.link.down === 0) m.syncedAt = world.step;
    // A reopen elsewhere counts as a move into To do: this machine may not have fetched the close, and sees the Item go from Backlog
    // straight to To do.
    const elsewhere = world.machines.filter((each) => each !== m).flatMap((each) => each.world.ledger.requests.filter((r) => r.step > since && r.step <= world.step))
      .map((r) => (r.path === "/api/item/edit" && r.body.state === "todo" ? { ...r, body: { ...r.body, lane: "todo" } } : r));
    const anyBoard: Observation = elsewhere.length > 0 ? { ...o, requests: [...o.requests, ...elsewhere] } : o;
    o.answersElsewhere = world.machines.filter((each) => each !== m).flatMap((each) => each.world.ledger.answers);
    // The end's H1 check reads every request again (from 0): those sessions were counted when they started.
    if (!only) for (const s of o.started) m.started.push({ step: world.step, request: s.request });
    for (const rule of m.rules) {
      if (reports.has(rule.id) || (only && rule.id !== only)) continue;
      // A claim is released on the remote: the ticks of a machine offline "for a while" do not count against it.
      if (OFFLINE_EXCUSED.has(rule.id) && (m.link.down > 0 || m.world.wasDown)) continue;
      let message: string | null;
      try {
        const seen = EXCUSED_BY_ANY_BOARD.has(rule.id) ? anyBoard : o;
        // Without a previous step the rule only learns (F3's memory of what was said), and finds nothing.
        const before = ALONE_ONLY.has(rule.id) && m.othersActedAt > m.checkedAt ? undefined : m.prev;
        message = rule.check(only ? { ...seen, final: true } : seen, before, m.memo.get(rule.id)!);
      } catch (error) {
        message = `the check threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (message) fail(rule.id, message, m.name);
    }
    m.prev = o;
    m.checkedAt = world.step;
  };
  const checkAcross = (final: boolean): void => {
    const o = world.observe(final);
    noteTexts(o, multiMemo.get("M5") ?? {});
    for (const rule of multiRules) {
      if (reports.has(rule.id)) continue;
      if (rule.final && !final) continue;
      let message: string | null;
      try {
        message = rule.check(o, multiMemo.get(rule.id)!);
      } catch (error) {
        message = `the check threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (message) fail(rule.id, message);
    }
  };
  const run = async (step: MultiAction): Promise<void> => {
    world.step++;
    const m = world.machines[step.m]!;
    m.world.step = world.step;
    const runner = m.world.runner;
    const before = runner.requests.length;
    await world.apply(step);
    // A machine offline "for a while" comes back as the steps pass, whichever machine acts.
    for (const each of world.machines) if (each !== m && each.link.down > 0 && step.kind !== "offline") each.link.down--;
    for (const each of world.machines) if (each !== m) each.othersActedAt = world.step;
    recent.push(`${world.step} ${multiActionText(world, step)}`);
    if (recent.length > 10) recent.shift();
    if (options.trace) console.log(`seed ${seed} step ${world.step}: ${multiActionText(world, step)}`);
    options.inspect?.(world, step);
    // Each machine is checked after its own steps. Its rules read the steps of this profile as a fetch (a sync) or, for the
    // others (offline, a race, a pick), as a step that is neither a tick nor a sync.
    const action: Action = step.kind === "act" ? step.a : step.kind === "fetch" ? { kind: "sync" } : { kind: "host-down", steps: 0 };
    await checkMachine(m, action, before, runner);
    checkAcross(false);
  };

  for (let i = 0; i < options.steps; i++) await run(world.draw());

  // The fair tail: every machine online and fair; round by round each machine fetches and plays its fair round.
  for (const m of world.machines) {
    m.link.down = 0;
    m.link.races = 0;
    await run({ m: m.index, kind: "act", a: { kind: "fair" } });
  }
  const rounds = 20 + 12 * options.items;
  for (let round = 0; round < rounds; round++) {
    for (const m of world.machines) {
      await run({ m: m.index, kind: "fetch" });
      for (const a of fairRound(m.world, round)) await run({ m: m.index, kind: "act", a });
    }
    if (world.machines.every((m) => m.world.items().every(isClosed)) && world.machines.every((m) => m.world.runner.live.size === 0)) break;
  }
  // Every machine syncs and stops: two fetches each, so a pick carried out on one is read by the others.
  for (let pass = 0; pass < 2; pass++) for (const m of world.machines) await run({ m: m.index, kind: "fetch" });
  for (const m of world.machines) if (m.prev) await checkMachine(m, { kind: "sync" }, 0, null, "H1");
  checkAcross(true);
  const seen = new Map(world.seen);
  for (const m of world.machines) for (const [what, n] of m.world.ledger.seen) seen.set(what, (seen.get(what) ?? 0) + n);
  return { seed, options, steps: world.step, failures, reports, seen };
}
