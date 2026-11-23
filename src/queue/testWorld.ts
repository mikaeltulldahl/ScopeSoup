// A made-up host for the engine's tests: changes, a main branch, chains and runs, all in memory.
// It performs the engine's effects and feeds the results back, as the orchestrator will.

import type { Ref } from "../model/types.ts";
import { defaultConfig } from "./config.ts";
import { initialState } from "./state.ts";
import { step } from "./step.ts";
import type { ChainResult, QueueConfig, QueueEffect, QueueInput, QueueState } from "./types.ts";

export const ref = (id: number | string): Ref => ({ host: "test", kind: "change", id: String(id) });

interface FakeChange {
  head: string;
  paths: string[];
}

export class World {
  config: QueueConfig;
  state: QueueState;
  main = "m0";
  minute = 0;
  changes = new Map<string, FakeChange>();
  /** Change ids each commit contains, in order. */
  commits = new Map<string, string[]>([["m0", []]]);
  /** Test files that fail whenever the change is in the tested commit. */
  bad = new Map<string, string[]>();
  /** Test files that fail in the full run of a batch and pass on rerun, by batch number. */
  flaky = new Map<number, string[]>();
  /** Changes that do not apply, and the change each conflicts with (null: the base). */
  conflicts = new Map<string, string | null>();
  rerunReportsRan = true;
  refuseMerge = false;
  /** Outcomes to give the next runs instead of the real one. */
  cancelNext = 0;
  /** Inputs the world owes the engine, oldest first. */
  inbox: QueueInput[] = [];
  effects: QueueEffect[] = [];
  /** "5" for a full run of prefix 5, "5r" for a rerun. */
  runs: string[] = [];
  merged: string[] = [];
  private memo = new Map<string, string>();

  constructor(config: QueueConfig = defaultConfig) {
    this.config = config;
    this.state = initialState();
  }

  /** Tells the engine where the main branch is, which lets it begin. Changes added before this share the first batch. */
  start(): QueueEffect[] {
    return this.send({ kind: "main-moved", sha: this.main });
  }

  /** Adds the changes, starts, and delivers until the world owes nothing. */
  run(ids: (number | string)[]): void {
    for (const id of ids) this.add(id);
    this.start();
    this.drive();
  }

  batch(n: number) {
    const b = this.state.batches.find((x) => x.id === n);
    if (!b) throw new Error(`no batch ${n}`);
    return b;
  }

  ids(n: number): string[] {
    return this.batch(n).members.map((m) => m.change.id);
  }

  now(): string {
    return new Date(Date.UTC(2030, 0, 1, 0, this.minute++)).toISOString();
  }

  private commit(key: string, content: string[]): string {
    let sha = this.memo.get(key);
    if (!sha) {
      sha = `c${this.memo.size + 1}`.padEnd(7, "0");
      this.memo.set(key, sha);
      this.commits.set(sha, content);
    }
    return sha;
  }

  /** Adds a change and reports it ready. */
  add(id: number | string, paths: string[] = [`notes/n${id}.md`]): void {
    const name = String(id);
    const head = this.commit(`head|${name}|0`, [name]);
    this.changes.set(name, { head, paths });
    this.send({ kind: "change-ready", change: ref(name), sha: head, paths });
  }

  /** A new commit on the change's branch. Returns the new head. */
  push(id: number | string): string {
    const name = String(id);
    const c = this.changes.get(name);
    if (!c) throw new Error(`no change ${name}`);
    c.head = this.commit(`head|${name}|${c.head}`, [name]);
    return c.head;
  }

  /** A commit on the main branch that the queue did not make. */
  outsideCommit(): string {
    this.main = this.commit(`outside|${this.main}`, [...(this.commits.get(this.main) ?? []), "outside"]);
    return this.main;
  }

  /** One step of the engine; its effects are performed and their answers put in the inbox. */
  send(input: QueueInput): QueueEffect[] {
    const before = JSON.stringify(this.state);
    const result = step(this.state, input, this.config, this.now());
    if (JSON.stringify(this.state) !== before) throw new Error("step changed the state it was given");
    this.state = JSON.parse(JSON.stringify(result.state)) as QueueState;
    for (const effect of result.effects) this.perform(effect);
    this.effects.push(...result.effects);
    return result.effects;
  }

  /** Delivers the oldest owed input. */
  deliver(): QueueEffect[] {
    const input = this.inbox.shift();
    if (!input) throw new Error("nothing to deliver");
    return this.send(input);
  }

  /** Delivers until the world owes nothing. */
  drive(max = 200): void {
    for (let i = 0; i < max; i++) {
      if (this.inbox.length === 0) return;
      this.deliver();
    }
    throw new Error("the queue did not settle");
  }

  of<K extends QueueEffect["kind"]>(kind: K): Extract<QueueEffect, { kind: K }>[] {
    return this.effects.filter((e): e is Extract<QueueEffect, { kind: K }> => e.kind === kind);
  }

  private failing(sha: string): string[] {
    const content = this.commits.get(sha) ?? [];
    return [...new Set(content.flatMap((id) => this.bad.get(id) ?? []))];
  }

  private perform(effect: QueueEffect): void {
    switch (effect.kind) {
      case "build-chain": {
        let tip = effect.base;
        const results: ChainResult[] = [];
        for (const { change, sha } of effect.changes) {
          const conflict = this.conflicts.get(change.id);
          if (conflict !== undefined) {
            results.push({ change, conflict: conflict === null ? {} : { with: ref(conflict) } });
            continue;
          }
          const content = [...(this.commits.get(tip) ?? []), change.id];
          tip = this.commit(`chain|${tip}|${sha}`, content);
          results.push({ change, sha: tip, tree: `tree:${content.join("+")}` });
        }
        this.inbox.push({ kind: "chain-built", batch: effect.batch, results });
        return;
      }
      case "start-run": {
        this.runs.push(`${effect.prefix}`);
        if (this.cancelNext > 0) {
          this.cancelNext--;
          this.inbox.push({ kind: "run-finished", run: effect.run, sha: effect.sha, outcome: "cancelled" });
          return;
        }
        const broken = (this.commits.get(effect.sha) ?? []).some((id) => this.bad.has(id));
        const flaky = effect.prefix === this.state.batches.at(-1)?.members.length ? (this.flaky.get(effect.batch) ?? []) : [];
        const files = [...new Set([...this.failing(effect.sha), ...flaky])];
        const outcome = broken || files.length > 0 ? "fail" : "pass";
        this.inbox.push({
          kind: "run-finished",
          run: effect.run,
          sha: effect.sha,
          outcome,
          ...(outcome === "fail" ? { report: { files, excerpt: files.map((f) => `FAIL ${f}`).join("\n") } } : {}),
          ref: { host: "test", kind: "run", id: effect.run },
        });
        return;
      }
      case "rerun-files": {
        this.runs.push(`${effect.prefix}r`);
        const files = this.failing(effect.sha).filter((f) => effect.files.includes(f));
        this.inbox.push({
          kind: "rerun-finished",
          run: effect.run,
          sha: effect.sha,
          outcome: files.length > 0 ? "fail" : "pass",
          ...(this.rerunReportsRan ? { ran: effect.files } : {}),
          ...(files.length > 0 ? { report: { files } } : {}),
        });
        return;
      }
      case "fast-forward": {
        const ok = !this.refuseMerge && this.main === effect.expect;
        if (ok) this.main = effect.to;
        this.inbox.push({ kind: "merge-result", batch: effect.batch, to: effect.to, ok, main: this.main });
        return;
      }
      case "mark-merged":
        this.merged.push(...effect.members.map((m) => m.change.id));
        return;
      default:
        return;
    }
  }
}
