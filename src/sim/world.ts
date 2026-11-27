// The simulated world: the real tick, store, host actions, sync and server (its request handlers, called in the process), with a
// fake clock, the meta branch in memory, the fake runner and git, and a fake person who acts only on what the Item page offers.
// A run is a list of plain actions (`Action`); `apply` carries one out. What the world records for the rules is in `Ledger`.

import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigSource } from "../config/loader.ts";
import type { ProjectConfig } from "../config/types.ts";
import { validateConfig } from "../config/validate.ts";
import type { DecisionOption, Ref, SessionStatus, WorkItem } from "../model/types.ts";
import { optionText, refKey } from "../model/types.ts";
import { createHostActions } from "../orchestrator/hostActions.ts";
import { loadJobs } from "../orchestrator/jobs.ts";
import type { QueueDriver, Notice, QueueSink } from "../orchestrator/queueDriver.ts";
import type { TickReport } from "../orchestrator/tick.ts";
import { tick } from "../orchestrator/tick.ts";
import { initialState } from "../queue/state.ts";
import type { ScopeSoupServer } from "../server/server.ts";
import { createServer } from "../server/server.ts";
import { applyControl, pauseAtStartup, setRolesForTest } from "../store/control.ts";
import { KEYS } from "../store/keys.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import { syncHost } from "../sync/syncHost.ts";
import type { Host } from "../ports/host.ts";
import { FakeGit, PATHS } from "./git.ts";
import type { StashEntry } from "./git.ts";
import { MetaRemote, metaHost } from "./metaHost.ts";
import type { Rng } from "./random.ts";
import { random } from "./random.ts";
import type { SimRunner } from "./runner.ts";
import { simRunner } from "./runner.ts";

export const T0 = Date.parse("2026-11-18T10:00:00.000Z");
export const PERSON = "Ada";

/** One step of a run, as plain data: a run is replayed, shrunk and pasted as a list of these. `v` seeds the step's own choices. */
export type Action =
  | { kind: "tick" }
  | { kind: "end"; item: string; v: number }
  | { kind: "answer"; item: string; v: number }
  | { kind: "edit"; item: string; v: number }
  | { kind: "close"; item: string; state: "done" | "abandoned" }
  | { kind: "reopen"; item: string }
  | { kind: "claim"; item: string }
  | { kind: "release"; item: string }
  | { kind: "move"; item: string; v: number }
  | { kind: "lane"; item: string; to: "todo" | "backlog" }
  | { kind: "start-over"; item: string }
  | { kind: "new-item"; v: number }
  | { kind: "switch"; to: "pause" | "resume" | "stop" }
  | { kind: "level"; to: number }
  | { kind: "slots"; to: number }
  | { kind: "sync" }
  | { kind: "clock"; ms: number }
  | { kind: "main-commit"; v: number }
  | { kind: "host-down"; steps: number }
  | { kind: "foreign-claim"; item: string }
  | { kind: "usage"; reserve: boolean }
  | { kind: "restart" }
  | { kind: "lose-store" }
  | { kind: "inside-tick"; inner: Action }
  | { kind: "queue"; item: string; merge: boolean }
  | { kind: "person-merge"; item: string }
  | { kind: "fair" };

/** What the fake person sent and the server answered. */
export interface Request {
  step: number;
  path: string;
  body: Record<string, unknown>;
  status: number;
  response: unknown;
  item?: string;
  /** The page the request was made from: the W the checker saw then, for B3. */
  shownParkedAt?: string;
}

export interface Ledger {
  requests: Request[];
  /** Items a person asked to close (done or abandoned), by key, with the step. */
  closesAsked: Map<string, number>;
  /** The last text a person wrote or accepted, by key. */
  texts: Map<string, { title: string; body: string }>;
  /** Each session the simulator ended: what it returned. */
  ended: { step: number; item: string; role: string; session: string; status: SessionStatus; merged?: "told" | "untold"; /** A well-formed result that settles the step (not a failure, a refusal or "not done"). */ settled: boolean }[];
  /** Answers the server accepted: item key and the text. */
  answers: { step: number; item: string; text: string }[];
  /** How many times each item was asked something (an answer step found something offered), in the fair tail. */
  asksInFair: Map<string, number>;
  /** Steps that were tried but had nothing to act on (skipped). */
  skipped: number;
  /** Things the world saw happen, counted for the coverage guard. */
  seen: Map<string, number>;
}

export interface WorldOptions {
  items: number;
  level: number;
  slots: number;
}


function makeConfig(level: number, slots: number): ProjectConfig {
  const result = validateConfig({
    project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", level,
    settings: { maxParallelSessions: { value: slots, reason: "simulator" } },
    remoteUrl: "git@git.example.invalid:team/project.git", checkCommand: ["node", "check.js"],
  }, "/srv/scopesoup");
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.config;
}

/** The queue as the simulator runs it at level 4: it takes changes and merges or sends back when the simulator says. */
export interface SimQueue extends QueueDriver {
  waiting: Map<string, { ref: Ref; sha: string }>;
  notices: Notice[];
}

function simQueue(): SimQueue {
  const q: SimQueue = {
    waiting: new Map(), notices: [],
    async enqueue(item, _branch, _repo, _paths) {
      return { ok: false, reason: "not wired" } as never;
    },
    reconcile(keep) {
      for (const key of [...q.waiting.keys()]) if (!keep.has(key)) q.waiting.delete(key);
    },
    async drain(sink: QueueSink) {
      // As the real driver: a notice is kept until it is taken; a throw keeps it for the next time.
      while (q.notices.length > 0) {
        await sink.deliver(q.notices[0]!);
        q.notices.shift();
      }
    },
    state: () => initialState(),
    pausedWhy: () => null,
    resume() {},
    checkMissing: () => null,
  };
  return q;
}

export class SimWorld {
  ms = T0;
  step = 0;
  store: Store;
  remote = new MetaRemote();
  host: Host;
  git = new FakeGit();
  runner: SimRunner;
  server: ScopeSoupServer;
  queue: SimQueue;
  configNow: ProjectConfig;
  source: ConfigSource;
  fair = false;
  /** What the last tick reported, when the step was a tick. */
  lastTick: TickReport | null = null;
  /** The tick threw: the rules read it (G2). */
  tickError: string | null = null;
  ledger: Ledger = { requests: [], closesAsked: new Map(), texts: new Map(), ended: [], answers: [], asksInFair: new Map(), skipped: 0, seen: new Map() };
  restarts = 0;
  /** The host did not answer during the last tick. */
  wasDown = false;
  /** A request to make while the tick awaits the runner (the "inside a tick" step). */
  private pendingInside: Action | null = null;
  private actions: ReturnType<typeof createHostActions>;

  constructor(options: WorldOptions) {
    this.store = openStore(":memory:");
    this.configNow = makeConfig(options.level, options.slots);
    this.source = { load: () => ({ config: this.configNow, changed: false }) };
    this.host = metaHost({ remote: this.remote, machine: "laptop-a", idPrefix: "A", now: () => this.now() });
    this.actions = createHostActions({ host: this.host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => this.configNow, store: this.store });
    this.runner = this.makeRunner(1);
    this.queue = this.makeQueue();
    this.server = this.makeServer();
    // Agents and merging started, as after a person pressed both Start buttons; usage allowed.
    setRolesForTest(this.store, "started");
    this.store.setValue(KEYS.mergeQueue, "started");
    this.usage(false);
  }

  /**
   * Files the starting Items; separate from the constructor so it can await. A person filed them in To do (#221), so the runs pasted
   * before Backlog existed keep their meaning; Items filed later land in Backlog, and the lane action moves them.
   */
  async init(items: number): Promise<void> {
    for (let i = 0; i < items; i++) {
      await this.host.write!.createWork!({ title: `Item ${i + 1}`, body: `Do thing ${i + 1}.`, lane: "todo", log: [{ kind: "created", by: { who: PERSON, agent: false } }] });
    }
    await this.sync();
  }

  now(): string {
    return new Date(this.ms).toISOString();
  }

  count(what: string): void {
    this.ledger.seen.set(what, (this.ledger.seen.get(what) ?? 0) + 1);
  }

  private makeRunner(firstId: number): SimRunner {
    return simRunner({
      store: this.store, git: this.git, now: () => this.now(), limit: () => this.configNow.settings.maxParallelSessions.value, step: () => this.step,
      during: async () => {
        const inner = this.pendingInside;
        if (!inner) return;
        this.pendingInside = null;
        await this.apply(inner);
      },
    }, firstId);
  }

  private makeQueue(): SimQueue {
    const q = simQueue();
    q.enqueue = async (item, branch) => {
      const sha = this.git.branches.get(branch);
      if (!sha) return { ok: false, reason: `no branch ${branch}` };
      q.waiting.set(refKey(item), { ref: item, sha });
      return { ok: true, sha };
    };
    return q;
  }

  private makeServer(): ScopeSoupServer {
    return createServer({
      store: this.store, port: 0, now: () => new Date(this.ms), configFile: "/srv/scopesoup/scopesoup.config.json",
      items: { host: this.host.info.id, write: this.host.write!, work: this.host.work! }, machine: "laptop-a",
      planning: () => ({ bugLabels: ["bug"], plannedSessions: this.configNow.settings.maxParallelSessions.value, level: this.configNow.level }),
      syncNow: () => this.sync(),
    });
  }

  ref(id: string): Ref {
    return { host: "metaBranch", kind: "work", id };
  }

  key(id: string): string {
    return refKey(this.ref(id));
  }

  items(): WorkItem[] {
    return this.store.list<WorkItem>("work", "metaBranch").sort((a, b) => Number(a.ref.id.slice(2)) - Number(b.ref.id.slice(2)));
  }

  usage(reserve: boolean): void {
    const at = this.now();
    const u = reserve ? 0.99 : 0.1;
    this.store.addUsageSample({
      at, status: "allowed",
      windows: [
        { kind: "five_hour", utilization: u, resetsAt: new Date(this.ms + 2 * 3600_000).toISOString() },
        { kind: "seven_day", utilization: reserve ? 0.99 : 0.1, resetsAt: new Date(this.ms + 3.5 * 24 * 3600_000).toISOString() },
      ],
    });
  }

  async sync(): Promise<void> {
    if (this.remote.down > 0) return;
    await syncHost(this.store, this.host, { pipelines: [], recentLimit: 0, batchLimit: 0, full: true }, () => this.now());
  }

  /** One request to the server, in the process, as the board's person. */
  async request(method: "GET" | "POST", path: string, body?: Record<string, unknown>, item?: string): Promise<{ status: number; json: unknown }> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const req = Object.assign(Readable.from(text === "" ? [] : [Buffer.from(text)]), {
      url: path, method, headers: { host: "127.0.0.1", "content-type": "application/json", "x-scopesoup-person": PERSON },
    }) as unknown as IncomingMessage;
    let status = 0;
    let out = "";
    const res: { headersSent: boolean; [name: string]: unknown } = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        res.headersSent = true;
        return res;
      },
      setHeader() {},
      end(chunk?: string) {
        if (typeof chunk === "string") out += chunk;
      },
      destroy() {},
    };
    await this.server.handle(req, res as unknown as ServerResponse);
    let json: unknown = null;
    try {
      json = out ? JSON.parse(out) : null;
    } catch {
      json = out;
    }
    if (method === "POST") {
      this.ledger.requests.push({ step: this.step, path, body: body ?? {}, status, response: json, ...(item ? { item } : {}) });
    }
    return { status, json };
  }

  /** The Item page as the server serves it to the board's person. */
  async page(id: string): Promise<PageJson | null> {
    const got = await this.request("GET", `/api/item?ref=${encodeURIComponent(this.key(id))}`);
    return got.status === 200 ? (got.json as PageJson) : null;
  }

  /** The newest live session of an item. */
  liveFor(id: string): string | undefined {
    const key = this.key(id);
    return [...this.runner.live.values()].filter((each) => refKey(each.session.subject) === key).map((each) => each.session.ref.id).at(-1);
  }

  async apply(action: Action): Promise<void> {
    switch (action.kind) {
      case "tick": {
        this.wasDown = this.remote.down > 0;
        this.lastTick = null;
        this.tickError = null;
        try {
          this.lastTick = await tick({ store: this.store, runner: this.runner, config: this.source, actions: this.actions, now: () => this.now(), queue: this.queue, queueWaitMs: 0 });
        } catch (error) {
          this.tickError = error instanceof Error ? error.message : String(error);
        }
        if (this.remote.down > 0) this.remote.down--;
        return;
      }
      case "end":
        return this.endSession(action.item, action.v);
      case "answer":
        return this.answer(action.item, action.v);
      case "edit": {
        const item = this.store.get<WorkItem>(this.ref(action.item));
        if (!item) return this.skip();
        const r = random(action.v);
        const body = r.chance(0.2) ? `${item.body ?? ""}\n` : `Do thing ${action.item}, version ${action.v}.`;
        const got = await this.request("POST", "/api/item/edit", { ref: this.key(action.item), body }, action.item);
        if (got.status === 200) {
          this.ledger.texts.set(this.key(action.item), { title: item.title, body: body.trim() });
          this.count("edit");
        }
        return;
      }
      case "close": {
        const got = await this.request("POST", "/api/item/edit", { ref: this.key(action.item), state: action.state }, action.item);
        if (got.status === 200) {
          this.ledger.closesAsked.set(this.key(action.item), this.step);
          this.count(`close-${action.state}`);
        }
        return;
      }
      case "reopen": {
        const got = await this.request("POST", "/api/item/edit", { ref: this.key(action.item), state: "todo" }, action.item);
        if (got.status === 200) {
          this.ledger.closesAsked.delete(this.key(action.item));
          this.count("reopen");
        }
        return;
      }
      case "claim": {
        const got = await this.request("POST", "/api/item/claim", { id: action.item }, action.item);
        if (got.status === 200) this.count("claim");
        return;
      }
      case "release": {
        const got = await this.request("POST", "/api/item/release", { id: action.item }, action.item);
        if (got.status === 200) this.count("release");
        return;
      }
      case "move": {
        const page = await this.page(action.item);
        const offered = Object.entries(page?.moves ?? {}).filter(([, why]) => !why?.why).map(([to]) => to);
        const to = random(action.v).pick(offered);
        if (!to) return this.skip();
        const got = await this.request("POST", "/api/item/move", { ref: this.key(action.item), to }, action.item);
        if (got.status === 200) this.count(`move-${to}`);
        return;
      }
      case "lane": {
        // Backlog and To do (#221): a person pulls an Item into To do or puts it back, the lane edit the State menu sends (Backlog
        // drops work under way first, or is refused).
        const got = await this.request("POST", "/api/item/edit", { ref: this.key(action.item), lane: action.to }, action.item);
        if (got.status === 200) this.count(`lane-${action.to}`);
        return;
      }
      case "start-over": {
        const page = await this.page(action.item);
        if (!page?.parked?.canStartOver) return this.skip();
        const got = await this.request("POST", "/api/start-over", { ref: this.key(action.item) }, action.item);
        if (got.status === 200) this.count("start-over");
        return;
      }
      case "new-item": {
        const got = await this.request("POST", "/api/items", { title: `New item ${action.v}`, body: `Do new thing ${action.v}.` });
        if (got.status === 200) {
          const ref = (got.json as { ref?: string }).ref;
          if (ref) this.ledger.texts.set(ref, { title: `New item ${action.v}`, body: `Do new thing ${action.v}.` });
          this.count("new-item");
        }
        return;
      }
      case "switch": {
        await this.request("POST", `/api/${action.to}`, {});
        this.count(`switch-${action.to}`);
        return;
      }
      case "level":
        this.configNow = makeConfig(action.to, this.configNow.settings.maxParallelSessions.value);
        this.count("level");
        return;
      case "slots":
        this.configNow = makeConfig(this.configNow.level, action.to);
        return;
      case "sync":
        return this.sync();
      case "clock":
        this.ms += action.ms;
        return;
      case "main-commit": {
        const r = random(action.v);
        this.git.outsideCommit([r.pick(PATHS)!]);
        this.count("main-commit");
        return;
      }
      case "host-down":
        this.remote.down = action.steps;
        this.count("host-down");
        return;
      case "foreign-claim": {
        if (!this.store.get(this.ref(action.item)) || this.remote.down > 0) return this.skip();
        // Another machine's Scope Soup claims it on the shared remote.
        const other = metaHost({ remote: this.remote, machine: "laptop-b", idPrefix: "B", now: () => this.now() });
        await other.write!.appendLog!(this.ref(action.item), { kind: "claimed", by: { who: "scopesoup", agent: true }, fields: { until: new Date(this.ms + 3600_000).toISOString() } }).catch(() => undefined);
        this.count("foreign-claim");
        return;
      }
      case "usage":
        this.usage(action.reserve);
        return;
      case "restart":
        return this.restart();
      case "lose-store":
        return this.loseStore();
      case "inside-tick":
        this.pendingInside = action.inner;
        await this.apply({ kind: "tick" });
        this.pendingInside = null;
        return;
      case "queue": {
        const entry = this.queue.waiting.get(this.key(action.item));
        if (!entry) return this.skip();
        this.queue.waiting.delete(this.key(action.item));
        if (action.merge) {
          const main = this.git.mergeToMain(entry.sha, "queue", this.key(action.item));
          this.queue.notices.push({ kind: "mark-merged", batch: this.step, members: [{ change: entry.ref, sha: main, head: entry.sha }], tested: main });
          this.count("queue-merged");
        } else {
          this.queue.notices.push({ kind: "send-back", change: entry.ref, sha: entry.sha, reason: { kind: "culprit", prefix: 0, chainSha: entry.sha, files: ["test/f.ts"], excerpt: "a test failed" } });
          this.count("queue-sent-back");
        }
        return;
      }
      case "person-merge": {
        const head = this.git.branches.get(`scopesoup/${action.item}`);
        if (!head || this.git.contains(head, this.git.main)) return this.skip();
        this.git.mergeToMain(head, "person", this.key(action.item));
        this.count("person-merge");
        return;
      }
      case "fair":
        this.fair = true;
        this.remote.down = 0;
        this.usage(false);
        applyControl(this.store, "resume", this.now(), "simulator", PERSON);
        for (const role of ["triage", "implement", "review", "mergeQueue"] as const) applyControl(this.store, `${role}.start`, this.now(), "simulator", PERSON);
        if (this.configNow.level < 2) this.configNow = makeConfig(2, this.configNow.settings.maxParallelSessions.value);
        return;
    }
  }

  private skip(): void {
    this.ledger.skipped++;
  }

  /** Same store; a new runner with no live process, a new server, every switch paused (G1). */
  async restart(): Promise<void> {
    this.restarts++;
    this.count("restart");
    // The old processes are gone: nothing they would have written arrives.
    this.runner.live.clear();
    const firstId = this.store.list("session").length + 1;
    this.runner = this.makeRunner(firstId);
    // The merge queue keeps its state in the store, so it survives a restart.
    this.server = this.makeServer();
    pauseAtStartup(this.store, this.now());
  }

  /** The store is lost: a new one, read back from the host; the runner's processes are gone too. */
  async loseStore(): Promise<void> {
    this.count("lose-store");
    this.store.close();
    this.store = openStore(":memory:");
    this.actions = createHostActions({ host: this.host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => this.configNow, store: this.store });
    this.runner.live.clear();
    // Which worktree an Item holds is kept in the store (`src/orchestrator/slots.ts`): with the store, every holding is gone, and the
    // worktrees are free ones the next Item takes. The fake's worktrees are holdings, so they go too.
    this.git.worktrees.clear();
    this.runner = this.makeRunner(this.runner.requests.length + 100);
    this.queue = this.makeQueue();
    this.server = this.makeServer();
    pauseAtStartup(this.store, this.now());
    this.usage(false);
    await this.sync();
  }

  /** Ends the item's live session with a result made from `v` (and, in the fair tail, one that settles). */
  async endSession(id: string, v: number): Promise<void> {
    const sessionId = this.liveFor(id);
    if (!sessionId) return this.skip();
    const live = this.runner.live.get(sessionId)!;
    const role = live.session.role;
    const r = random(v);
    const others = this.items().filter((each) => each.ref.id !== id).map((each) => each.ref.id);
    let status: SessionStatus = "succeeded";
    let output: unknown;
    let extra: { resumeAt?: string } = {};
    let merged: "told" | "untold" | undefined;
    if (!this.fair && r.chance(0.12)) {
      const roll = r.int(4);
      status = roll === 0 ? "failed" : roll === 1 ? "limit" : roll === 2 ? "cancelled" : "succeeded";
      if (status === "limit") extra = { resumeAt: new Date(this.ms + 3600_000).toISOString() };
      output = status === "succeeded" ? { nonsense: true } : undefined;
      if (status === "succeeded") this.count("malformed");
      else this.count(`session-${status}`);
    } else if (role === "triage") {
      output = this.fair ? { ready: true, size: "small", paths: [r.pick(PATHS)!], questions: [] } : this.triageResult(id, r, others);
    } else if (role === "implement") {
      const res = this.implementResult(id, live.request.vars.finish ?? "", live.request.branch, live.request.workspace, r);
      output = res.output;
      merged = res.merged;
    } else {
      const roll = this.fair ? 0 : r.int(10);
      output = roll < 6 ? { verdict: "approve", findings: [] }
        : roll < 9 ? { verdict: "changes", findings: [{ severity: "must", file: r.pick(PATHS), text: `Fix ${v % 97}.` }] }
          : { verdict: "approve", findings: [{ severity: "should", text: "Tidy the name." }] };
    }
    this.runner.end(sessionId, status, output, extra);
    const out = output as { done?: boolean; nonsense?: boolean } | undefined;
    const settled = status === "succeeded" && !!out && !out.nonsense && (role !== "implement" || out.done === true);
    this.ledger.ended.push({ step: this.step, item: this.key(id), role, session: sessionId, status, ...(merged ? { merged } : {}), settled });
    this.count(`ended-${role}`);
  }

  private question(r: Rng, n: number): { question: string; options: DecisionOption[]; recommendation: string } {
    const options = [{ label: `yes ${n}`, description: "go ahead" }, { label: `no ${n}`, description: "leave it" }];
    return { question: `Should it do part ${n}?`, options, recommendation: options[r.int(2)]!.label };
  }

  private triageResult(id: string, r: Rng, others: string[]): unknown {
    const item = this.store.get<WorkItem>(this.ref(id));
    const ready = r.chance(0.85);
    const paths = [r.pick(PATHS)!, ...(r.chance(0.3) ? [r.pick(PATHS)!] : [])];
    const n = r.chance(0.6) ? 0 : r.chance(0.75) ? 1 : 2;
    const questions = Array.from({ length: n }, (_, i) => this.question(r, r.int(5) * 10 + i));
    const roll = r.int(10);
    const body = item?.body ?? "";
    const rewrite = roll < 5 ? undefined : roll === 5 ? `${body}  ` : roll < 9 ? `Rewritten: ${item?.title ?? id}, take ${r.int(3)}.` : "Rewritten: the same as before.";
    const other = r.pick(others);
    const links = other && r.chance(0.15) ? [{ type: r.pick(["duplicateOf", "conflictsWith", "blockedBy"] as const)!, item: other, reason: "they overlap" }] : undefined;
    const aboutOthers = other && r.chance(0.05) ? [{ item: other, questions: [this.question(r, 90)] }] : undefined;
    if (questions.length > 0) this.count("asked-questions");
    if (rewrite) this.count("rewrite");
    if (links) this.count(`link-${links[0]!.type}`);
    return {
      ready, ...(ready ? {} : { notReadyReason: "It is not clear what to do." }), size: r.chance(0.9) ? "small" : "large", paths, questions,
      blockers: [], ...(rewrite !== undefined ? { rewrite } : {}), ...(links ? { links } : {}), ...(aboutOthers ? { aboutOthers } : {}),
    };
  }

  private implementResult(id: string, finish: string, branch: string, workspace: string, r: Rng): { output: unknown; merged?: "told" | "untold" } {
    const told = /merge it to/.test(finish);
    const roll = this.fair ? 0 : r.int(20);
    const commit = (): string => {
      const head = this.git.branches.get(branch) ?? this.git.main;
      // Mostly on the paths the triage named; now and then elsewhere.
      const named = this.jobs()[this.key(id)]?.triage?.paths ?? [];
      const sha = this.git.commit([head], [(r.chance(0.8) ? r.pick(named) : undefined) ?? r.pick(PATHS)!], `work on ${id}`, "agent");
      this.git.branches.set(branch, sha);
      return sha;
    };
    // An agent's leftovers now and then (rule group I). A stash entry's changes are in the commit that follows, when one does.
    let stashed: StashEntry | undefined;
    if (!this.fair && r.chance(0.1)) {
      const tree = this.git.worktrees.get(workspace);
      const kind = r.int(5);
      if (kind === 0) {
        const head = this.git.branches.get(branch) ?? this.git.main;
        stashed = { workspace, item: this.key(id), scopesoup: true, sha: this.git.commit([head], [], `WIP on ${branch}`, "agent"), branch };
        this.git.stash.push(stashed);
      }
      if (kind === 1) {
        this.git.tags.set(`wip-${id}`, this.git.branches.get(branch) ?? this.git.main);
        this.git.owners.set(`refs/tags/wip-${id}`, { item: this.key(id), scopesoup: true });
      }
      if (kind === 2) {
        this.git.branches.set(`scopesoup/${id}-extra`, this.git.branches.get(branch) ?? this.git.main);
        this.git.owners.set(`refs/heads/scopesoup/${id}-extra`, { item: this.key(id), scopesoup: true });
      }
      if (kind === 3 && tree) tree.dirty.push(r.pick(PATHS)!);
      if (kind === 4 && tree) tree.untracked.push(`notes-${id}.txt`);
      this.count("leftover");
    }
    if (roll < 12) {
      const head = commit();
      if (stashed) stashed.same = head;
      let merged: "told" | "untold" | undefined;
      if ((told && (this.fair || r.chance(0.75))) || (!told && r.chance(0.03))) {
        this.git.mergeToMain(head, told ? "session told" : "session untold", this.key(id));
        merged = told ? "told" : "untold";
      }
      return { output: { done: true, summary: "Did it." }, ...(merged ? { merged } : {}) };
    }
    if (roll < 14) return { output: { done: true, summary: "Nothing to change." } };
    if (roll < 17) {
      this.count("implement-question");
      return { output: { done: false, summary: "Need to ask.", question: this.question(r, 70) } };
    }
    return { output: { done: false, summary: "Could not finish." } };
  }

  /** The person answers what the page asks: the recommendation half the time, another option, free text, or a stale request. */
  async answer(id: string, v: number): Promise<void> {
    const page = await this.page(id);
    if (!page) return this.skip();
    const r = random(v);
    const key = this.key(id);
    const stale = !this.fair && r.chance(0.05);
    const pick = (q: { options?: DecisionOption[]; recommendation?: string }): string => {
      if (!q.options || q.options.length === 0) return `My own answer ${v % 1000}`;
      const rec = q.options.find((o) => (typeof o === "string" ? o : o.label) === q.recommendation);
      if (this.fair || r.chance(0.5)) return rec ? optionText(rec) : optionText(q.options[0]!);
      if (r.chance(0.7)) return optionText(r.pick(q.options)!);
      return `My own answer ${v % 1000}`;
    };
    const fairCount = (): void => {
      if (this.fair) this.ledger.asksInFair.set(key, (this.ledger.asksInFair.get(key) ?? 0) + 1);
    };
    const parkedAt = stale ? "2026-01-01T00:00:00.000Z" : page.parked?.at;
    const parked = page.parked;
    if (parked?.rewrite && parkedAt) {
      const answers = parked.rewrite.questions.map((q) => pick(q));
      const roll = this.fair ? 0 : r.int(10);
      const action = roll < 5 ? "accept" : roll < 7 ? "edit" : "reject";
      const text = `Edited by a person, ${v % 1000}.`;
      fairCount();
      const got = await this.request("POST", "/api/rewrite", { ref: key, parkedAt, answers, action, ...(action === "edit" ? { text } : {}) }, id);
      if (got.status === 200) {
        this.count(`rewrite-${action}`);
        const settled = (got.json as { settled?: string }).settled;
        if (settled === "accepted") this.ledger.texts.set(key, { title: page.item.title, body: parked.rewrite.text.trim() });
        if (settled === "edited") this.ledger.texts.set(key, { title: page.item.title, body: text });
        answers.forEach((text) => this.ledger.answers.push({ step: this.step, item: key, text }));
      }
      return;
    }
    if (parked?.questions && parked.questions.some((q) => q.answer === undefined) && parkedAt) {
      const open = parked.questions.map((q, i) => ({ q, i })).filter((each) => each.q.answer === undefined);
      const chosen = this.fair || r.chance(0.7) ? open : [open[0]!];
      const answers = chosen.map(({ q, i }) => ({ question: i, answer: pick(q) }));
      fairCount();
      const got = await this.request("POST", "/api/answers", { ref: key, parkedAt, answers }, id);
      if (got.status === 200) {
        this.count("answered");
        answers.forEach((each) => this.ledger.answers.push({ step: this.step, item: key, text: each.answer }));
      }
      return;
    }
    if (parked?.canAnswer) {
      const text = parked.decision ? pick(parked.decision) : "Go on with it.";
      fairCount();
      const got = await this.request("POST", "/api/answer", { ref: key, answer: text, ...(parkedAt ? { parkedAt } : {}) }, id);
      if (got.status === 200) {
        this.count("answered");
        this.ledger.answers.push({ step: this.step, item: key, text });
      }
      return;
    }
    const question = page.questions?.[0];
    if (question) {
      const text = pick(question);
      fairCount();
      const got = await this.request("POST", "/api/answer", { ref: key, answer: text, to: question.at }, id);
      if (got.status === 200) {
        this.count("answered");
        this.ledger.answers.push({ step: this.step, item: key, text });
      }
      return;
    }
    if (page.proposedRewrite) {
      const action = this.fair ? "accept" : r.pick(["accept", "reject"] as const)!;
      fairCount();
      const got = await this.request("POST", "/api/proposed-rewrite", { ref: key, at: page.proposedRewrite.at, action }, id);
      if (got.status === 200) {
        this.count(`proposed-${action}`);
        if (action === "accept") this.ledger.texts.set(key, { title: page.item.title, body: page.proposedRewrite.text.trim() });
      }
      return;
    }
    // Not ready, under Fair: a person says to implement it anyway.
    if (this.fair && page.moves?.implement && !page.moves.implement.why) {
      await this.request("POST", "/api/item/move", { ref: key, to: "implement" }, id);
      return;
    }
    this.skip();
  }

  jobs(): ReturnType<typeof loadJobs> {
    return loadJobs(this.store);
  }
}

/** The parts of the served Item page the person reads. */
export interface PageJson {
  item: { ref: Ref; title: string; state: string; body?: string };
  lane: string | null;
  parked?: {
    as: string; at: string; canAnswer: boolean; canStartOver?: boolean;
    decision?: { options: DecisionOption[]; recommendation: string };
    questions?: { options: DecisionOption[]; recommendation: string; answer?: string }[];
    rewrite?: { text: string; questions: { options: DecisionOption[]; recommendation: string }[] };
  };
  questions?: { at: string; options: DecisionOption[]; recommendation?: string }[];
  proposedRewrite?: { at: string; text: string };
  moves?: Record<string, { why?: string } | undefined>;
}
