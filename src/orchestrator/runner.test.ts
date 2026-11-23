// The runner against a fake `claude` (providers/claude/fake-claude.ts) and a real, throwaway git repository.
// The Windows tree kill (src/hosts/processTree.ts) is covered here too, and in process.test.ts.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import type { ProjectConfig } from "../config/types.ts";
import { validateConfig } from "../config/validate.ts";
import type { Ref, Session } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { workBranch, workspaceKey, workspacePath } from "./paths.ts";
import { heldSlot, slotName } from "./slots.ts";
import type { SessionRequest } from "./ports.ts";
import type { RunCheck } from "./checkRunner.ts";
import { realProcesses } from "./process.ts";
import type { ProcessControl } from "./process.ts";
import { createRunner, readSessionResult } from "./runner.ts";
import type { Runner } from "./runner.ts";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";
import type { AgentProvider } from "./agent.ts";
import { providerFor } from "./providers/index.ts";
import { createResources, readResourceState } from "./resources.ts";
import type { Resources } from "./resources.ts";
import { refKey } from "../model/types.ts";

const FAKE = join(import.meta.dirname, "providers", "claude", "fake-claude.ts");
const T0 = Date.parse("2026-11-18T10:00:00Z");

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
after(async () => {
  for (const cleanup of cleanups) cleanup();
  // A tree kill takes a process listing first (about a second), so the sessions may still hold their folders for a
  // moment; the removal waits without blocking, so that the kills can go on meanwhile.
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 12 });
});

interface World {
  dir: string;
  config: ProjectConfig;
  store: Store;
  runner: Runner;
  clock: { ms: number };
  killed: number[];
  resources?: Resources;
}

function world(mode: string, options: { raw?: Record<string, unknown>; env?: NodeJS.ProcessEnv; processes?: Partial<ProcessControl>; runSetup?: RunCheck; provider?: AgentProvider; resources?: true } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-runner-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSyncRetrying("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  // The machine's own git configuration (autocrlf on Windows) must not shape what the tests compare.
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "README.md"), "synthetic\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");

  const result = validateConfig(
    {
      project: "synthetic", machineName: "laptop-a", repoPath: "repo", level: 2,
      claude: { path: process.execPath, prefixArgs: ["--disable-warning=ExperimentalWarning", FAKE] },
      ...options.raw,
    },
    dir,
  );
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const config = result.config;
  const store = openStore(":memory:");
  const clock = { ms: T0 };
  const killed: number[] = [];
  const processes: ProcessControl = {
    ...realProcesses,
    killTree(pid, createdMs) {
      killed.push(pid);
      realProcesses.killTree(pid, createdMs);
    },
    ...options.processes,
  };
  // The limited resources the configuration declares, when the test asks for them.
  const resources = options.resources ? createResources({ store, config: () => config, now: () => new Date(clock.ms).toISOString() }) : undefined;
  const runner = createRunner({
    store, config: () => config, now: () => clock.ms, processes, ...(options.runSetup ? { runSetup: options.runSetup } : {}),
    ...(options.provider ? { provider: () => options.provider! } : {}),
    ...(resources ? { resources } : {}),
    env: { ...process.env, ANTHROPIC_API_KEY: "must-not-reach-the-child", FAKE_CLAUDE_MODE: mode, ...options.env },
  });
  cleanups.push(() => runner.stopAll("test over"));
  return { dir, config, store, runner, clock, killed, ...(resources ? { resources } : {}) };
}

const ITEM: Ref = { host: "fake", kind: "work", id: "42" };

function request(over: Partial<SessionRequest> = {}): SessionRequest {
  return {
    role: "implement", subject: ITEM, attempt: 1, workspace: workspaceKey(ITEM), branch: workBranch(ITEM),
    vars: {
      project: "synthetic", mainBranch: "main", branch: workBranch(ITEM), itemId: "42", itemTitle: "A title",
      itemBody: "A body with {{notAVariable}}", verification: "none", allowedCommands: "Shell commands you may run: `git ...`.", finish: "Commit and stop.",
    },
    ...over,
  };
}

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid: number): boolean {
  return realProcesses.isAlive(pid);
}

function fakeEvents(session: Session): Record<string, unknown>[] {
  return readFileSync(session.streamPath ?? "", "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runner", { concurrency: 4 }, () => {
test("a session that succeeds: worktree, arguments, stream file, store, usage", async () => {
  const w = world("ok", { env: { FAKE_CLAUDE_OUTPUT: '{"done":true,"summary":"did it"}' } });
  const started = await w.runner.start(request());
  assert.equal(started.status, "running");
  assert.equal(typeof started.pid, "number");
  assert.equal(w.runner.running(), 1);

  const session = await w.runner.finished(started.ref.id);
  assert.equal(session.status, "succeeded");
  assert.equal(session.endReason, "Completed.");
  assert.equal(session.agentSessionId, "fake-session-1");
  assert.equal(session.lastAction, "reading README.md");
  assert.equal(session.costUsd, 0.01);
  assert.equal(session.model, "sonnet");
  assert.ok(session.lastEventAt && session.finishedAt);
  assert.deepEqual(w.store.get<Session>(session.ref), session);
  assert.deepEqual(readSessionResult(w.store, session.ref.id), { malformedLines: 0, turns: 2, subtype: "success", output: { done: true, summary: "did it" } });
  assert.equal(w.runner.running(), 0);

  const fake = fakeEvents(session).find((event) => event.subtype === "fake");
  const args = fake?.args as string[];
  const cwd = workspacePath(w.config, slotName(1));
  assert.equal(fake?.cwd, cwd);
  assert.equal(fake?.hasApiKey, false);
  assert.match(String(fake?.prompt), /You are working on Item 42 of synthetic in your own clone/);
  assert.match(String(fake?.prompt), /A body with \{\{notAVariable\}\}/);
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  const flag = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(flag("--model"), "sonnet");
  assert.equal(flag("--max-turns"), "80");
  assert.equal(flag("--permission-mode"), "dontAsk");
  assert.equal(flag("--allowedTools"), "Read,Glob,Grep,Edit,Write,Bash(git *)");
  assert.equal((JSON.parse(flag("--json-schema") ?? "") as { required: string[] }).required[0], "done");
  assert.equal(args.includes("--resume"), false);
  // Every session is denied force pushes and skipped hooks, whatever its allowedTools.
  assert.equal(flag("--disallowedTools"), "Bash(git push --force*),Bash(git push -f*),Bash(*--no-verify*)");

  assert.equal(execFileSyncRetrying("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim(), "scopesoup/42");
  assert.equal(w.store.latestUsageSample()?.windows.length, 2);
  assert.deepEqual(await w.runner.changedPaths("scopesoup/42"), []);

  await w.runner.releaseWorkspace(workspaceKey(ITEM));
  // The worktree is kept for the next Item, freed and on a detached HEAD.
  assert.equal(heldSlot(w.store, workspaceKey(ITEM)), null);
  assert.equal(execFileSyncRetrying("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim(), "HEAD");
  // The branch outlives the holding, and a later session gets the worktree back on it.
  const again = await w.runner.finished((await w.runner.start(request())).ref.id);
  assert.equal(again.status, "succeeded");
});

test("an uncommitted edit survives the Item being parked: the next session finds it in its worktree and is told it is not committed", async () => {
  const w = world("ok", { env: { FAKE_CLAUDE_OUTPUT: '{"done":true,"summary":"x"}' } });
  const first = await w.runner.finished((await w.runner.start(request())).ref.id);
  assert.equal(first.status, "succeeded");
  const cwd = workspacePath(w.config, slotName(1));
  writeFileSync(join(cwd, "README.md"), "edited by the session\n");
  writeFileSync(join(cwd, "added.txt"), "added\n");

  await w.runner.releaseWorkspace(workspaceKey(ITEM));
  // The worktree is kept, clean: the edits are in the patch, not left for the next Item.
  assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "synthetic\n");
  assert.equal(existsSync(join(cwd, "added.txt")), false);

  const second = await w.runner.finished((await w.runner.start(request())).ref.id);
  assert.equal(second.status, "succeeded");
  assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited by the session\n");
  assert.equal(readFileSync(join(cwd, "added.txt"), "utf8"), "added\n");
  const fake = fakeEvents(second).find((event) => event.subtype === "fake");
  assert.match(String(fake?.prompt), /not committed/);
});

test("worktrees are reused across Items; the setup runs once per worktree, again after a watched file changes, and not for a triage", async () => {
  const runs: string[] = [];
  const runSetup: RunCheck = async (command, cwd) => {
    runs.push(cwd);
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    return { outcome: "passed", code: 0, tail: `${command.join(" ")} done`, ms: 500 };
  };
  const w = world("ok", { raw: { setupCommand: ["node", "setup.mjs"], setupWatch: ["deps.lock"] }, runSetup, env: { FAKE_CLAUDE_OUTPUT: '{"done":true,"summary":"x"}' } });
  writeFileSync(join(w.dir, "repo", ".gitignore"), "node_modules/\n");
  writeFileSync(join(w.dir, "repo", "deps.lock"), "1\n");
  gitIn(join(w.dir, "repo"), "add", ".");
  gitIn(join(w.dir, "repo"), "commit", "-q", "-m", "deps");
  const slot = workspacePath(w.config, slotName(1));

  const first = await w.runner.finished((await w.runner.start(request())).ref.id);
  assert.equal(first.status, "succeeded");
  assert.equal(first.cwd, slot);
  assert.deepEqual(runs, [slot]);
  assert.match(String(fakeEvents(first).find((event) => event.subtype === "fake")?.prompt), /Scope Soup ran the project's setup in this clone before your session \(`node setup\.mjs`\), and runs it again when deps\.lock changes/);
  assert.match(JSON.stringify(w.store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.setup_ran")), /it has not run in this folder yet/);
  await w.runner.releaseWorkspace(workspaceKey(ITEM));
  // The ignored output stays in the freed worktree.
  assert.ok(existsSync(join(slot, "node_modules")));

  // Another Item gets the same worktree, on its own branch, and the setup is not run again.
  const other: Ref = { host: "fake", kind: "work", id: "43" };
  const second = await w.runner.finished((await w.runner.start(request({ subject: other, workspace: workspaceKey(other), branch: workBranch(other) }))).ref.id);
  assert.equal(second.cwd, slot);
  assert.equal(execFileSyncRetrying("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: slot, encoding: "utf8" }).trim(), "scopesoup/43");
  assert.deepEqual(runs, [slot]);
  // A triage does not need the setup.
  await w.runner.finished((await w.runner.start(request({ subject: other, workspace: workspaceKey(other), branch: workBranch(other), role: "triage" }))).ref.id);
  assert.deepEqual(runs, [slot]);

  // A watched file changes on the branch: the next session runs the setup again.
  writeFileSync(join(slot, "deps.lock"), "2\n");
  gitIn(slot, "commit", "-q", "-am", "new deps");
  await w.runner.finished((await w.runner.start(request({ subject: other, workspace: workspaceKey(other), branch: workBranch(other) }))).ref.id);
  assert.deepEqual(runs, [slot, slot]);
  assert.match(JSON.stringify(w.store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.setup_ran").at(-1)), /watched files changed: deps\.lock/);

  // While the second Item holds slot-1, the first gets a new worktree, where the setup runs once.
  const third = await w.runner.finished((await w.runner.start(request())).ref.id);
  assert.equal(third.cwd, workspacePath(w.config, slotName(2)));
  assert.deepEqual(runs, [slot, slot, workspacePath(w.config, slotName(2))]);
});

test("a failed setup starts no agent: the session is marked as the setup's failure, with the setup's reason", async () => {
  const runSetup: RunCheck = async () => ({ outcome: "failed", code: 1, tail: "npm ERR! synthetic failure", ms: 300 });
  const w = world("ok", { raw: { setupCommand: ["node", "setup.mjs"] }, runSetup });
  const session = await w.runner.start(request());
  assert.equal(session.status, "failed");
  assert.equal(session.setupFailed, true);
  // What may leave the machine is built from the outcome alone; the output stays in the local session and event.
  assert.equal(session.setupOutcome, "exit 1");
  assert.equal(session.pid, undefined);
  assert.match(session.endReason ?? "", /^Setup failed in .*slot-1 \(it has not run in this folder yet\), so no implement session started\. The setup exited with code 1\. The end of its output:\nnpm ERR! synthetic failure$/);
  assert.equal(w.store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.setup_failed").length, 1);
  assert.equal(w.runner.running(), 0);
});

test("a session's commit is authored by the session, not by the clone's or the machine's identity", async () => {
  const w = world("ok", { env: { FAKE_CLAUDE_COMMIT: "work.txt", GIT_AUTHOR_EMAIL: "person@example.com", GIT_COMMITTER_EMAIL: "person@example.com" } });
  // The clone's own configuration names a person; the session must not use it.
  execFileSyncRetrying("git", ["config", "user.name", "A Person"], { cwd: join(w.dir, "repo") });
  execFileSyncRetrying("git", ["config", "user.email", "person@example.com"], { cwd: join(w.dir, "repo") });
  const session = await w.runner.finished((await w.runner.start(request())).ref.id);
  assert.equal(session.status, "succeeded");
  const cwd = workspacePath(w.config, slotName(1));
  const line = execFileSyncRetrying("git", ["log", "-1", "--format=%an|%ae|%cn|%ce"], { cwd, encoding: "utf8" }).trim();
  const [an, ae, cn, ce] = line.split("|");
  assert.equal(an, "Scope Soup implement 42 (sonnet)");
  assert.equal(cn, an);
  assert.match(ae ?? "", /^scopesoup@[a-z0-9._-]+\.invalid$/);
  assert.equal(ce, ae);
  assert.equal(line.includes("person@example.com"), false);
});

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSyncRetrying("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}

test("a new item starts from the remote's newest main", async () => {
  const w = world("ok");
  const repo = join(w.dir, "repo");
  const remote = join(w.dir, "remote.git");
  gitIn(w.dir, "init", "-q", "--bare", "-b", "main", remote);
  gitIn(repo, "remote", "add", "origin", remote);
  gitIn(repo, "push", "-q", "origin", "main");
  // Someone else merges a commit on the host; the local clone does not have it.
  const other = join(w.dir, "other");
  gitIn(w.dir, "clone", "-q", "-c", "core.autocrlf=false", remote, other);
  writeFileSync(join(other, "merged.txt"), "from the host\n");
  gitIn(other, "add", ".");
  gitIn(other, "commit", "-q", "-m", "merged on host");
  gitIn(other, "push", "-q", "origin", "main");

  const session = await w.runner.finished((await w.runner.start(request())).ref.id);
  assert.equal(session.status, "succeeded");
  const cwd = workspacePath(w.config, slotName(1));
  assert.equal(readFileSync(join(cwd, "merged.txt"), "utf8"), "from the host\n");
  assert.equal(existsSync(join(repo, "merged.txt")), false);
  assert.match(String(fakeEvents(session).find((event) => event.subtype === "fake")?.prompt), / from origin\/main, the newest main\./);
  assert.deepEqual(await w.runner.changedPaths("scopesoup/42"), []);
  assert.equal(w.store.eventsAfter(0, 1000).some((event) => event.kind === "orchestrator.fetch_failed"), false);
});

test("a clone with no remote still starts the session, and the failed fetch is logged once", async () => {
  const w = world("ok");
  const session = await w.runner.finished((await w.runner.start(request())).ref.id);
  assert.equal(session.status, "succeeded");
  const failed = w.store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.fetch_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.actor, "orchestrator");
  assert.match(JSON.stringify(failed[0]?.data), /starts from the local main/);
  // With no remote's main branch, the prompt names the local one as the base.
  assert.match(String(fakeEvents(session).find((event) => event.subtype === "fake")?.prompt), / from main, the newest main\./);
  assert.deepEqual(await w.runner.changedPaths("scopesoup/42"), []);
});

test("resuming passes --resume and only the message, and can send the prompt as an argument", async () => {
  const w = world("ok", { raw: { claude: { path: process.execPath, prefixArgs: ["--disable-warning=ExperimentalWarning", FAKE], promptVia: "arg", extraArgs: ["--effort", "low"] } } });
  const message = "The reviewer asked for these changes:\n- [must] Off by one.\nFix them and commit. Answer as before.";
  const session = await w.runner.finished((await w.runner.start(request({ resume: "earlier-session", message }))).ref.id);
  assert.equal(session.status, "succeeded");
  assert.equal(session.agentSessionId, "earlier-session");
  const fake = fakeEvents(session).find((event) => event.subtype === "fake");
  const args = fake?.args as string[];
  assert.equal(args[0], "-p");
  assert.equal(args[1], message);
  assert.equal(fake?.prompt, "");
  assert.equal(args[args.indexOf("--resume") + 1], "earlier-session");
  assert.deepEqual(args.slice(-2), ["--effort", "low"]);

  // Without a session to resume, a fresh implementor gets its prompt with the message after it.
  const fresh = await w.runner.finished((await w.runner.start(request({ message: "Earlier work is on the branch.\nFix it." }))).ref.id);
  const freshArgs = fakeEvents(fresh).find((event) => event.subtype === "fake")?.args as string[];
  assert.match(freshArgs[1] ?? "", /^You are working on Item 42[\s\S]*\n\nEarlier work is on the branch\.\nFix it\.$/);
  assert.equal(freshArgs.includes("--resume"), false);
});

test("a stalled session is killed with everything it started", async () => {
  const w = world("hang");
  const started = await w.runner.start(request());
  await until(() => existsSync(started.streamPath ?? "") && fakeEvents(started).some((event) => event.subtype === "fake_child"), "the fake to hang");
  const grandchild = fakeEvents(started).find((event) => event.subtype === "fake_child")?.pid as number;
  assert.equal(alive(grandchild), true);

  w.clock.ms += 4 * 60_000;
  await w.runner.reconcile();
  assert.deepEqual(w.killed, []);

  w.clock.ms += 2 * 60_000;
  await w.runner.reconcile();
  assert.deepEqual(w.killed, [started.pid]);
  assert.equal(w.store.get<Session>(started.ref)?.status, "stalled");

  const session = await w.runner.finished(started.ref.id);
  assert.equal(session.status, "stalled");
  assert.match(session.endReason ?? "", /Stalled: no event for 5 minutes/);
  await until(() => !alive(grandchild), "the grandchild to die");
  assert.equal(alive(started.pid ?? 0), false);
});

test("a session that keeps talking still meets the hard timeout", async () => {
  const w = world("chatty");
  const started = await w.runner.start(request());
  await until(() => existsSync(started.streamPath ?? "") && fakeEvents(started).some((event) => event.type === "assistant"), "the fake to talk");
  w.clock.ms += 61 * 60_000;
  // An event after the clock moved: the session is not stalled, only overdue.
  const before = fakeEvents(started).length;
  await until(() => fakeEvents(started).length > before, "another event");
  await w.runner.reconcile();
  const session = await w.runner.finished(started.ref.id);
  assert.equal(session.lastAction, "still going");
  assert.equal(session.status, "failed");
  assert.match(session.endReason ?? "", /Timed out: still running after 60 minutes/);
});

test("a limit hit ends the session as 'limit' with the reset time", async () => {
  const reset = T0 / 1000 + 2 * 3600;
  const w = world("limit", { env: { FAKE_CLAUDE_RESET: String(reset) } });
  const session = await w.runner.finished((await w.runner.start(request())).ref.id);
  assert.equal(session.status, "limit");
  assert.match(session.endReason ?? "", /Usage limit hit; it resets at 2026-11-18T12:00:00.000Z/);
  assert.equal(readSessionResult(w.store, session.ref.id).resumeAt, "2026-11-18T12:00:00.000Z");
  assert.equal(session.agentSessionId, "fake-session-1");
  assert.equal(w.store.latestUsageSample()?.status, "rejected");
});

// A provider is anything that implements the interface. These fakes wrap the default one and change only the
// part checking, the way a second provider differs: where usage is read, and what kind of command limit it has.
test("a provider whose stream has no usage is asked once the session is over, and its reading tells a limit hit apart", async () => {
  const reset = T0 / 1000 + 3 * 3600;
  let asked = 0;
  const base = providerFor({} as ProjectConfig, "implement");
  const provider: AgentProvider = {
    ...base,
    name: "separate-usage",
    async readUsage() {
      asked++;
      return { at: new Date(T0).toISOString(), status: "rejected", windows: [{ kind: "five_hour", utilization: 1, resetsAt: new Date(reset * 1000).toISOString() }] };
    },
  };
  const w = world("error-result", { provider });
  const session = await w.runner.finished((await w.runner.start(request())).ref.id);
  assert.equal(asked, 1);
  assert.equal(session.provider, "separate-usage");
  assert.equal(session.status, "limit");
  assert.equal(readSessionResult(w.store, session.ref.id).resumeAt, "2026-11-18T13:00:00.000Z");
  assert.equal(w.store.latestUsageSample()?.status, "rejected");
});

test("a provider that cannot hold a session to its role's command list starts no session (a core rule)", async () => {
  const provider: AgentProvider = { ...providerFor({} as ProjectConfig, "implement"), name: "sandboxed", commandLimit: "sandbox" };
  const w = world("ok", { provider });
  const session = await w.runner.start(request());
  assert.equal(session.status, "failed");
  assert.match(session.endReason ?? "", /^Refused: the agent provider sandboxed cannot hold a session to the role's allowedTools/);
  assert.equal(session.pid, undefined);
  assert.equal(w.runner.running(), 0);
});

test("failures each end with one reason", async () => {
  const crash = world("fail");
  const crashed = await crash.runner.finished((await crash.runner.start(request())).ref.id);
  assert.equal(crashed.status, "failed");
  assert.match(crashed.endReason ?? "", /exited with code 3 and no result[\s\S]*something broke/);

  const turns = world("error-result");
  const outOfTurns = await turns.runner.finished((await turns.runner.start(request())).ref.id);
  assert.equal(outOfTurns.status, "failed");
  assert.match(outOfTurns.endReason ?? "", /error_max_turns/);

  const mute = world("no-answer");
  const noAnswer = await mute.runner.finished((await mute.runner.start(request())).ref.id);
  assert.equal(noAnswer.status, "failed");
  assert.match(noAnswer.endReason ?? "", /without an answer that fits the schema/);

  const missing = world("ok", { raw: { claude: { path: join(tmpdir(), "no-such-claude-binary") } } });
  const notStarted = await missing.runner.finished((await missing.runner.start(request())).ref.id);
  assert.equal(notStarted.status, "failed");
  assert.match(notStarted.endReason ?? "", /Could not start the agent/);
  assert.equal(missing.runner.running(), 0);
});

test("stopAll cancels running sessions", async () => {
  const w = world("hang");
  const started = await w.runner.start(request());
  assert.equal(w.runner.stopAll("Paused by a person."), 1);
  assert.equal(w.runner.stopAll("again"), 0);
  const session = await w.runner.finished(started.ref.id);
  assert.equal(session.status, "cancelled");
  assert.equal(session.endReason, "Paused by a person.");
  await assert.rejects(w.runner.finished("nope"));
});

test("a resource unit a session holds goes back when it fails, crashes or is stopped, and its variables reach the session", async () => {
  const raw = { resources: [{ name: "rig", units: 1, neededBy: ["implement"], env: { FAKE_CLAUDE_UNIT: "rig-{{unit}}" } }] };
  const holders = (w: World): string[] => readResourceState(w.store).held.map((each) => each.holder);
  const make = (mode: string, extra: Record<string, unknown> = {}, runSetup?: RunCheck) => {
    const w = world(mode, { raw: { ...raw, ...extra }, resources: true, ...(runSetup ? { runSetup } : {}) });
    return { w, resources: w.resources! };
  };

  // A session that crashes (exits without a result).
  const crash = make("fail");
  const taken = await crash.resources.take(refKey(ITEM), "implement for 42", "implement");
  assert.deepEqual(taken, { ok: true, env: { FAKE_CLAUDE_UNIT: "rig-1" } });
  const crashed = await crash.w.runner.finished((await crash.w.runner.start(request({ env: taken.ok ? taken.env : {} }))).ref.id);
  assert.equal(crashed.status, "failed");
  await until(() => holders(crash.w).length === 0, "the unit to go back after the crash");

  // A session that hangs and is stopped; while it runs, the unit is held and its variable reached the agent.
  const stop = make("hang");
  const held = await stop.resources.take(refKey(ITEM), "implement for 42", "implement");
  const started = await stop.w.runner.start(request({ env: held.ok ? held.env : {} }));
  await until(() => existsSync(started.streamPath ?? "") && fakeEvents(started).some((event) => event.subtype === "fake"), "the fake to start");
  assert.equal(fakeEvents(started).find((event) => event.subtype === "fake")?.unit, "rig-1");
  assert.deepEqual(holders(stop.w), [refKey(ITEM)]);
  assert.equal((await stop.resources.take(refKey({ ...ITEM, id: "43" }), "implement for 43", "implement")).ok, false);
  stop.w.runner.stopAll("Stopped by a person.");
  assert.equal((await stop.w.runner.finished(started.ref.id)).status, "cancelled");
  await until(() => holders(stop.w).length === 0, "the unit to go back after the stop");
  assert.equal((await stop.resources.take(refKey({ ...ITEM, id: "43" }), "implement for 43", "implement")).ok, true);

  // A session that never started (its setup failed) gives the unit back too.
  const failing: RunCheck = async () => ({ outcome: "failed", code: 1, tail: "setup broke", ms: 5 });
  const { w: setup, resources: late } = make("ok", { setupCommand: ["setup"] }, failing);
  assert.equal((await late.take(refKey(ITEM), "implement for 42", "implement")).ok, true);
  const unset = await setup.runner.start(request());
  assert.equal(unset.status, "failed");
  await until(() => holders(setup).length === 0, "the unit to go back after the failed setup");
});

test("a worktree is refused when it would merge in a path marked as real", async () => {
  const w = world("ok");
  // The configuration is valid; then the workspaces directory becomes a link into the real path.
  const real = join(w.dir, "production");
  mkdirSync(real);
  w.config.realPaths = [real];
  mkdirSync(dirname(w.config.workspacesDir), { recursive: true });
  // Windows: a directory junction needs no privilege (a symlink needs Developer Mode or admin) and is
  // resolved by realpath the same way, so it tests the same protection.
  symlinkSync(real, w.config.workspacesDir, process.platform === "win32" ? "junction" : "dir");
  const session = await w.runner.start(request());
  assert.equal(session.status, "failed");
  assert.match(session.endReason ?? "", /^Refused: .*marked as real\. Sessions never run there\./);
  assert.equal(session.pid, undefined);
  assert.equal(w.runner.running(), 0);
  assert.deepEqual(w.store.get<Session>(session.ref), session);
  assert.equal(existsSync(join(real, workspaceKey(ITEM))), false);
  assert.equal(existsSync(join(real, slotName(1))), false);

  const direct = world("ok");
  direct.config.realPaths = [direct.config.workspacesDir];
  assert.match((await direct.runner.start(request())).endReason ?? "", /^Refused: /);
  const escape = await direct.runner.start(request({ workspace: "../outside" }));
  assert.match(escape.endReason ?? "", /^Refused: .*not a workspace name/);
  const repoIsReal = world("ok");
  repoIsReal.config.realPaths = [repoIsReal.dir];
  assert.match((await repoIsReal.runner.start(request())).endReason ?? "", /^Refused: /);
});

test("the startup sweep settles sessions left by an earlier run", async () => {
  const stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, windowsHide: true });
  stray.unref();
  // Its real creation time: on Windows the kill checks the process against it.
  const strayCreated = await realProcesses.startTimeMs(stray.pid ?? 0);
  assert.notEqual(strayCreated, null);
  cleanups.push(() => realProcesses.killTree(stray.pid ?? 0, strayCreated ?? undefined));
  const w = world("ok", { processes: { bootTimeMs: () => T0 - 3600_000, startTimeMs: async (pid) => (pid === stray.pid ? strayCreated : null) } });
  const at = new Date(T0 - 60_000).toISOString();
  const base = { role: "implement" as const, subject: ITEM, attempt: 1, startedAt: at };
  const leftover: Session = { ...base, ref: { host: "scopesoup", kind: "session", id: "leftover" }, status: "running", pid: stray.pid, startedAt: new Date((strayCreated ?? 0) + 1000).toISOString() };
  const gone: Session = { ...base, ref: { host: "scopesoup", kind: "session", id: "gone" }, status: "running", pid: 2 ** 22 + 12345 };
  const neverStarted: Session = { ...base, ref: { host: "scopesoup", kind: "session", id: "never" }, status: "starting" };
  // Recorded before the machine last started: the pid now belongs to something else (here: this test).
  const reused: Session = { ...base, ref: { host: "scopesoup", kind: "session", id: "reused" }, status: "running", pid: process.pid, startedAt: new Date(T0 - 2 * 3600_000).toISOString() };
  const done: Session = { ...base, ref: { host: "scopesoup", kind: "session", id: "done" }, status: "succeeded", finishedAt: at, endReason: "Completed." };
  for (const session of [leftover, gone, neverStarted, reused, done]) w.store.put(session, "orchestrator", at);

  await w.runner.reconcile();

  assert.deepEqual(w.killed, [stray.pid]);
  await until(() => !alive(stray.pid ?? 0), "the leftover process to die");
  const read = (id: string) => w.store.get<Session>({ host: "scopesoup", kind: "session", id });
  assert.match(read("leftover")?.endReason ?? "", /Orphaned: .*was still there and was killed/);
  assert.match(read("gone")?.endReason ?? "", /Orphaned: .*its process is gone/);
  assert.match(read("never")?.endReason ?? "", /Orphaned/);
  assert.match(read("reused")?.endReason ?? "", /machine restarted since.*left alone/);
  for (const id of ["leftover", "gone", "never", "reused"]) assert.equal(read(id)?.status, "failed");
  assert.deepEqual(read("done"), done);

  const events = w.store.lastSeq();
  await w.runner.reconcile();
  assert.equal(w.store.lastSeq(), events);
});

test("the startup sweep kills only a process created when the session started, and leaves one alone when its start time differs or cannot be read", async () => {
  const at = new Date(T0 - 60_000).toISOString();
  const session = (id: string, pid: number): Session => ({ role: "implement", subject: ITEM, attempt: 1, startedAt: at, ref: { host: "scopesoup", kind: "session", id }, status: "running", pid });
  // Nothing is really killed here: killTree only records, so a wrong decision cannot hurt this test process.
  const times: Record<string, number | null> = { match: T0 - 62_000, later: T0 + 3600_000, earlier: T0 - 3 * 3600_000, unreadable: null };
  const byPid = new Map<number, string>();
  const killed: number[] = [];
  const w = world("ok", {
    processes: { bootTimeMs: () => T0 - 24 * 3600_000, killTree: (pid) => void killed.push(pid), startTimeMs: async (pid) => times[byPid.get(pid) ?? ""] ?? null },
  });
  const pids = new Map<string, number>();
  for (const name of Object.keys(times)) {
    // Through realProcesses, so that the cleanup's tree kill knows it is still the child it started.
    const child = realProcesses.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: tmpdir(), env: process.env, stdin: false });
    cleanups.push(() => realProcesses.killTree(child.pid ?? 0));
    pids.set(name, child.pid ?? 0);
    byPid.set(child.pid ?? 0, name);
    w.store.put(session(name, child.pid ?? 0), "orchestrator", at);
  }

  await w.runner.reconcile();

  assert.deepEqual(killed, [pids.get("match")]);
  const read = (id: string) => w.store.get<Session>({ host: "scopesoup", kind: "session", id });
  assert.match(read("match")?.endReason ?? "", /was still there and was killed/);
  assert.match(read("later")?.endReason ?? "", /another program and was left alone/);
  assert.match(read("earlier")?.endReason ?? "", /another program and was left alone/);
  assert.match(read("unreadable")?.endReason ?? "", /start time could not be read, so it was left alone/);
});

test("deleteBranch removes an item branch and its worktree, tolerates a missing one, refuses main", async () => {
  const w = world("ok");
  const repo = w.config.repoPath;
  const branches = () => execFileSyncRetrying("git", ["branch", "--format=%(refname:short)"], { cwd: repo, encoding: "utf8" }).split("\n").filter((line) => line !== "");
  const worktree = join(w.dir, "wt");
  execFileSyncRetrying("git", ["worktree", "add", "-b", "scopesoup/42", worktree], { cwd: repo, stdio: "pipe" });
  execFileSyncRetrying("git", ["branch", "scopesoup/43"], { cwd: repo, stdio: "pipe" });
  assert.deepEqual(branches().sort(), ["main", "scopesoup/42", "scopesoup/43"]);

  await w.runner.deleteBranch("scopesoup/42");
  await w.runner.deleteBranch("scopesoup/43");
  await w.runner.deleteBranch("scopesoup/42");
  assert.deepEqual(branches(), ["main"]);
  assert.equal(existsSync(worktree), false);

  await assert.rejects(() => w.runner.deleteBranch("main"), /Refusing to delete main/);
  await assert.rejects(() => w.runner.deleteBranch("feature/x"), /Refusing to delete feature\/x/);
  assert.deepEqual(branches(), ["main"]);
});
});
