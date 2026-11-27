// Merging by the session at levels 2 and 3, against a synthetic remote: the fake `claude` (providers/claude/fake-claude.ts)
// commits on the item's branch and, when its prompt tells it to merge, pushes it to the remote's main. Scope Soup sees the merge
// by fetching and checking ancestry, writes `merged`, and pauses agents when main moved other than fast-forward.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fixedConfig } from "../config/loader.ts";
import type { ProjectConfig } from "../config/types.ts";
import { validateConfig } from "../config/validate.ts";
import type { Ref, SessionRole, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { agentsState, setRolesForTest } from "../store/control.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import type { Job } from "./jobs.ts";
import { releaseJob, mergedOf, parkedOf, sessionIdOf, stepAt } from "./jobs.ts";
import type { Actions } from "./ports.ts";
import { dryActions } from "./ports.ts";
import { createRunner } from "./runner.ts";
import { tick } from "./tick.ts";
import { isolateGitConfig } from "./fixtures/git-env.ts";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";

const FAKE = join(import.meta.dirname, "providers", "claude", "fake-claude.ts");
const T0 = Date.parse("2026-11-21T10:00:00Z");

const restoreGitConfig = isolateGitConfig();
const dirs: string[] = [];
const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restoreGitConfig();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSyncRetrying("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...args], {
    cwd, stdio: "pipe", encoding: "utf8",
  }).trim();
}

/** One answer every role's reading accepts: a ready triage, a finished implementor, an approving review. */
const ANSWER = { ready: true, size: "small", paths: ["work.txt"], hidesDecision: false, done: true, summary: "Did it.", verdict: "approve", findings: [] };

interface World {
  dir: string;
  remote: string;
  store: Store;
  config: ProjectConfig;
  lines: { kind: string; fields: Record<string, unknown> }[];
  /** Ticks until the item's job parked (or `until` holds) or `rounds` run out; returns the roles started, with the remote's main after each session. */
  run(rounds?: number, until?: (job: Job | undefined) => boolean): Promise<{ role: SessionRole; mainAfter: string }[]>;
  /** A person answers the Item's parked question. */
  answer(): void;
  job(): Job | undefined;
  events(kind: string): string[];
}

const ITEM: Ref = { host: "fake", kind: "work", id: "1" };

function world(level: 2 | 3, env: Record<string, string>): World {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-merge-"));
  dirs.push(dir);
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "synthetic project\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  const remote = join(dir, "remote.git");
  git(dir, "clone", "-q", "--bare", seed, remote);
  git(dir, "clone", "-q", remote, join(dir, "repo"));
  const result = validateConfig({
    project: "synthetic", machineName: "laptop-a", repoPath: "repo", level,
    claude: { path: process.execPath, prefixArgs: ["--disable-warning=ExperimentalWarning", FAKE] },
  }, dir);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const config = result.config;
  const store = openStore(":memory:");
  setRolesForTest(store, "started");
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms).toISOString();
  const item: WorkItem = { ref: ITEM, title: "Item 1", state: "todo", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-01T00:00:00Z" };
  store.put(item, "sync", now());
  const resetsAt = new Date(T0 + 3600_000).toISOString();
  store.addUsageSample({ at: now(), status: "allowed", windows: [{ kind: "five_hour", utilization: 0.1, resetsAt }, { kind: "seven_day", utilization: 0.1, resetsAt }] });
  const runner = createRunner({
    store, config: () => config, now: () => clock.ms,
    env: { ...process.env, FAKE_CLAUDE_MODE: "ok", FAKE_CLAUDE_OUTPUT: JSON.stringify(ANSWER), FAKE_CLAUDE_COMMIT: "work.txt", ...env },
  });
  cleanups.push(() => runner.stopAll("test over"));
  const lines: World["lines"] = [];
  const actions: Actions = { ...dryActions, async appendLog(_item, kind, fields) { lines.push({ kind, fields }); } };
  const job = (): Job | undefined => (JSON.parse(store.getValue("orchestrator.jobs") ?? "{}") as Record<string, Job>)[refKey(ITEM)];
  return {
    dir, remote, store, config, lines, job,
    events: (kind) => store.eventsAfter(0, 10_000).filter((event) => event.kind === kind).map((event) => String((event.data as { reason?: string } | null)?.reason ?? "")),
    answer() {
      assert.equal(releaseJob(store, ITEM, "Pat", now(), "Pat answered: run the check, and merge if it passes."), true);
    },
    async run(rounds = 10, until) {
      const roles: { role: SessionRole; mainAfter: string }[] = [];
      for (let round = 0; round < rounds && !parkedOf(job()) && !until?.(job()); round++) {
        const report = await tick({ store, runner, config: fixedConfig(config), actions, now });
        for (const started of report.started) {
          assert.equal((await runner.finished(started.sessionId)).status, "succeeded");
          roles.push({ role: started.role, mainAfter: git(remote, "rev-parse", "main") });
        }
        clock.ms += 2000;
      }
      return roles;
    },
  };
}

describe("merging by the session", { concurrency: 7 }, () => {
  test("level 2: the session merges its change itself, Scope Soup sees main contains the head and writes `merged`", async () => {
    const w = world(2, { FAKE_CLAUDE_PUSH: "when-told" });
    const before = git(w.remote, "rev-parse", "main");
    const roles = await w.run();
    assert.deepEqual(roles.map((each) => each.role), ["triage", "implement"]);
    const main = git(w.remote, "rev-parse", "main");
    assert.notEqual(main, before);
    const job = w.job();
    assert.equal(parkedOf(job)?.as, "queued", parkedOf(job)?.reason);
    assert.equal(job?.base, before);
    const merged = w.lines.find((line) => line.kind === "merged");
    assert.deepEqual(merged?.fields, { sha: main, target: "main" });
    assert.match(w.events("orchestrator.merged")[0] ?? "", /merged: origin\/main at \w{7} contains its head/);
    assert.equal(agentsState(w.store), "started");
    assert.deepEqual(w.events("orchestrator.main_rewritten"), []);
  });

  test("level 2: a session that squash-merges gets `merged` with the squash commit, which main has and the branch does not", async () => {
    const w = world(2, { FAKE_CLAUDE_PUSH: "squash" });
    const before = git(w.remote, "rev-parse", "main");
    await w.run();
    const main = git(w.remote, "rev-parse", "main");
    assert.equal(git(w.remote, "rev-parse", "main^"), before, "one squash commit on main");
    const job = w.job();
    assert.equal(parkedOf(job)?.as, "queued", parkedOf(job)?.reason);
    assert.equal(mergedOf(job), main);
    assert.deepEqual(w.lines.find((line) => line.kind === "merged")?.fields, { sha: main, target: "main" });
    assert.match(w.events("orchestrator.merged")[0] ?? "", /contains \w{7}, a squash of its head \w{7} \(the same files, new since \w{7}\)/);
  });

  test("a named commit on main that does not carry the branch's files is no squash: the Item parked for a person", async () => {
    const w = world(2, { FAKE_CLAUDE_PUSH: "squash-empty" });
    await w.run();
    assert.equal(parkedOf(w.job())?.as, "escalated");
    assert.match(parkedOf(w.job())?.reason ?? "", /does not contain scopesoup\/1/);
    assert.equal(w.lines.some((line) => line.kind === "merged"), false);
  });

  test("a main forced to other history pauses agents with the reason, and the Item parked for a person", async () => {
    const w = world(2, { FAKE_CLAUDE_PUSH: "force" });
    const before = git(w.remote, "rev-parse", "main");
    await w.run();
    assert.equal(agentsState(w.store), "paused");
    const said = w.events("orchestrator.main_rewritten");
    assert.equal(said.length, 1, said.join("\n"));
    assert.match(said[0]!, new RegExp(`it was at ${before.slice(0, 7)} and is now at ${git(w.remote, "rev-parse", "main").slice(0, 7)}.*Agents are paused`));
    assert.equal(w.store.eventsAfter(0, 10_000).filter((event) => event.kind === "control.implement_paused").length, 1);
    // The session forced main and did not merge the branch: no `merged`, and a person gets the reason.
    assert.equal(parkedOf(w.job())?.as, "escalated");
    assert.match(parkedOf(w.job())?.reason ?? "", /does not contain scopesoup\/1/);
    assert.equal(w.lines.some((line) => line.kind === "merged"), false);
  });

  test("level 3: the implementor commits and stops, and merges only after the reviewer approves, in its own resumed session", async () => {
    const w = world(3, { FAKE_CLAUDE_PUSH: "when-told" });
    const before = git(w.remote, "rev-parse", "main");
    const roles = await w.run();
    assert.deepEqual(roles.map((each) => each.role), ["triage", "implement", "review", "implement"]);
    // Main did not move until the implement session after the approval.
    assert.deepEqual(roles.slice(0, 3).map((each) => each.mainAfter), [before, before, before]);
    assert.notEqual(roles[3]!.mainAfter, before);
    assert.equal(parkedOf(w.job())?.as, "queued", parkedOf(w.job())?.reason);
    assert.deepEqual(w.lines.find((line) => line.kind === "merged")?.fields, { sha: roles[3]!.mainAfter, target: "main" });
    const started = w.events("orchestrator.started");
    assert.match(started[3] ?? "", /resuming the implementor's session/);
  });

  test("a pull request named in the answer hands the Item over with that link", async () => {
    const url = "https://example.invalid/synthetic/pull/7";
    const w = world(2, { FAKE_CLAUDE_OUTPUT: JSON.stringify({ ...ANSWER, mergedAs: url }) });
    await w.run();
    assert.equal(parkedOf(w.job())?.as, "handed-over");
    assert.match(parkedOf(w.job())?.reason ?? "", new RegExp(`opened a pull request instead of merging: ${url.replaceAll(".", "\\.")}`));
    assert.equal(w.lines.some((line) => line.kind === "merged"), false);
  });

  test("done, but main does not contain the head and no pull request is named: the Item parked for a person, and an answer looks again", async () => {
    const w = world(2, {});
    await w.run();
    const job = w.job();
    assert.equal(parkedOf(job)?.as, "escalated");
    assert.equal(parkedOf(job)?.retry, "hand-over");
    assert.match(parkedOf(job)?.reason ?? "", /does not contain scopesoup\/1 \(at \w{7}\), and its answer names no pull request/);
    assert.equal(w.lines.some((line) => line.kind === "merged"), false);
  });

  // The implementor stopped before merging (it could not run the check), the Item escalated, and a person answered. The merge
  // queue's switch is paused, as after every start-up, and is not shown below level 4.
  test("level 2: the answer to a done-but-not-merged escalation resumes the implementor's own session, which merges", async () => {
    const w = world(2, { FAKE_CLAUDE_PUSH: "when-resumed" });
    const before = git(w.remote, "rev-parse", "main");
    assert.deepEqual((await w.run()).map((each) => each.role), ["triage", "implement"]);
    assert.equal(parkedOf(w.job())?.retry, "hand-over");
    assert.equal(git(w.remote, "rev-parse", "main"), before);
    w.answer();
    const roles = await w.run();
    assert.deepEqual(roles.map((each) => each.role), ["implement"], "no reviewer at level 2");
    assert.equal(parkedOf(w.job())?.as, "queued", parkedOf(w.job())?.reason);
    assert.notEqual(roles[0]!.mainAfter, before);
    assert.deepEqual(w.lines.find((line) => line.kind === "merged")?.fields, { sha: roles[0]!.mainAfter, target: "main" });
    assert.match(w.events("orchestrator.step").at(-1) ?? "", /Pat answered\. At level 2 the implementor merges it/);
    assert.match(w.events("orchestrator.started").at(-1) ?? "", /resuming the implementor's session/);
    assert.equal(w.events("orchestrator.escalated").length, 1, "escalated once, before the answer");
  });

  test("level 3: the same answer for a change built at level 2 sends it to review first, then the implementor merges", async () => {
    const w = world(2, { FAKE_CLAUDE_PUSH: "when-resumed" });
    await w.run();
    assert.equal(parkedOf(w.job())?.retry, "hand-over");
    (w.config as { level: number }).level = 3;
    w.answer();
    const roles = await w.run();
    assert.deepEqual(roles.map((each) => each.role), ["review", "implement"]);
    assert.equal(parkedOf(w.job())?.as, "queued", parkedOf(w.job())?.reason);
    assert.match(w.events("orchestrator.step").find((reason) => /Pat answered/.test(reason)) ?? "", /Next: review/);
  });

  test("a job at the review step when the level is lowered to 2 goes back to its implementor's own session, which merges", async () => {
    const w = world(3, { FAKE_CLAUDE_PUSH: "when-resumed" });
    const before = git(w.remote, "rev-parse", "main");
    const first = await w.run(10, (job) => !!job && stepAt(job) === "review" && !sessionIdOf(job));
    assert.deepEqual(first.map((each) => each.role), ["triage", "implement"]);
    (w.config as { level: number }).level = 2;
    const roles = await w.run();
    assert.deepEqual(roles.map((each) => each.role), ["implement"]);
    assert.match(w.events("orchestrator.step").find((reason) => /waited at the review step/.test(reason)) ?? "", /project is at level 2, where nobody reviews.*Next: the implementor's own session merges it/);
    assert.equal(parkedOf(w.job())?.as, "queued", parkedOf(w.job())?.reason);
    assert.notEqual(git(w.remote, "rev-parse", "main"), before);
  });
});
