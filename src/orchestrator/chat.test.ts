// A person's chat with an Item's sessions, against the real runner, a fake `claude` (providers/claude/fake-claude.ts) and a
// throwaway git repository. No real `claude` is ever started.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ProjectConfig } from "../config/types.ts";
import { DEFAULT_MODELS } from "../config/defaults.ts";
import { validateConfig } from "../config/validate.ts";
import type { Ref, Session, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { setRolesForTest } from "../store/control.ts";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";
import { sessionView } from "../core/board.ts";
import { createChat, knownSessions, readTurns, replyFromStream } from "./chat.ts";
import type { Chat } from "./chat.ts";
import { loadJobs, saveJobs } from "./jobs.ts";
import type { Job } from "./jobs.ts";
import { workBranch, workspaceKey, workspacePath } from "./paths.ts";
import { heldSlot, slotName } from "./slots.ts";
import { createRunner } from "./runner.ts";
import type { Runner } from "./runner.ts";
import type { SessionRequest } from "./ports.ts";
import { HOLDINGS_KEY, readHoldings } from "./workspaces.ts";

const FAKE = join(import.meta.dirname, "providers", "claude", "fake-claude.ts");
const T0 = Date.parse("2026-11-18T10:00:00Z");
const ITEM: Ref = { host: "fake", kind: "work", id: "42" };
const KEY = refKey(ITEM);

const dirs: string[] = [];
const stops: (() => void)[] = [];
after(async () => {
  for (const stop of stops) stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 12 });
});

interface World {
  dir: string;
  config: ProjectConfig;
  store: Store;
  runner: Runner;
  chat: Chat;
  clock: { ms: number };
  hold: string;
  /** The job as the test stored it. */
  job: Job;
}

function step(store: Store, id: string, role: Session["role"], agentSessionId: string, startedAt: string, over: Partial<Session> = {}): Session {
  const session: Session = {
    ref: { host: "scopesoup", kind: "session", id }, role, subject: ITEM, status: "succeeded", attempt: 1, startedAt, finishedAt: startedAt,
    agentSessionId, model: DEFAULT_MODELS[role], ...over,
  };
  store.put(session, "orchestrator", startedAt);
  return session;
}

function world(jobOver: Partial<Job> | null = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-chat-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSyncRetrying("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "README.md"), "synthetic\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  const result = validateConfig(
    { project: "synthetic", machineName: "laptop-a", repoPath: "repo", level: 3, claude: { path: process.execPath, prefixArgs: ["--disable-warning=ExperimentalWarning", FAKE] } },
    dir,
  );
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const config = result.config;
  const store = openStore(":memory:");
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms).toISOString();
  setRolesForTest(store, "started");
  const work: WorkItem = { ref: ITEM, title: "A synthetic item", state: "doing", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-01T00:00:00Z" };
  store.put(work, "sync", now());
  // The item's triage, then its implementor, then its reviewer: each a session Scope Soup knows, newest last.
  step(store, "s1", "triage", "agent-look", "2026-11-18T08:00:00.000Z");
  step(store, "s2", "implement", "agent-impl", "2026-11-18T08:30:00.000Z");
  step(store, "s3", "review", "agent-review", "2026-11-18T09:00:00.000Z");
  const hold = join(dir, "hold");
  const runner = createRunner({
    store, config: () => config, now: () => clock.ms,
    env: { ...process.env, ANTHROPIC_API_KEY: "must-not-reach-the-child", FAKE_CLAUDE_MODE: "chat", FAKE_CLAUDE_HOLD: hold },
  });
  stops.push(() => runner.stopAll("test over"));
  const job: Job = {
    item: ITEM, workspace: workspaceKey(ITEM), branch: workBranch(ITEM), step: "implement", failures: 0, fixRounds: 1, agentSession: "agent-impl",
    resumeWith: "The reviewer asked for these changes: none.", parked: { as: "escalated", reason: "The implementer asked something.", at: "2026-11-18T09:30:00.000Z", byStep: true },
    startedAt: "2026-11-18T08:00:00.000Z", ...jobOver,
  };
  if (jobOver !== null) store.tx(() => saveJobs(store, { [KEY]: job }));
  const chat = createChat({ store, runner, config: () => config, now });
  return { dir, config, store, runner, chat, clock, hold, job };
}

function fakeArgs(store: Store, session: Session): { args: string[]; cwd: string; prompt: string } {
  const events = readFileSync(store.get<Session>(session.ref)?.streamPath ?? "", "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const fake = events.find((event) => event.subtype === "fake")!;
  return { args: fake.args as string[], cwd: fake.cwd as string, prompt: fake.prompt as string };
}

function chatSessions(store: Store): Session[] {
  return store.list<Session>("session").filter((session) => session.chat);
}

async function until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the reply is read from the stream: whole messages, then the one being written", () => {
  const lines = [
    { type: "stream_event", event: { type: "message_start" } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Looking" } } },
    { type: "assistant", message: { content: [{ type: "text", text: "Looking at it." }, { type: "tool_use", name: "Read", input: {} }] } },
    { type: "stream_event", event: { type: "message_start" } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "It is " } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "fine" } } },
  ].map((line) => JSON.stringify(line));
  assert.equal(replyFromStream(lines.join("\n")), "Looking at it.\n\nIt is fine");
  assert.equal(replyFromStream("not json\n"), "");
});

describe("chat", { concurrency: 4 }, () => {
  test("the panel lists the item's known sessions, newest first, with their roles", () => {
    const w = world();
    assert.deepEqual(knownSessions(w.store, KEY).map((each) => [each.agentSession, each.role]), [["agent-review", "review"], ["agent-impl", "implement"], ["agent-look", "triage"]]);
    const view = w.chat.view(KEY);
    assert.deepEqual(view.sessions.map((each) => each.agentSession), ["agent-review", "agent-impl", "agent-look"]);
    assert.equal(view.blocked, undefined);
  });

  test("a message resumes the session once in the item's worktree, shows the reply, and leaves the item where it was", async () => {
    const w = world();
    const before = JSON.stringify(loadJobs(w.store));
    // Worktrees are reused across Items; the first one is slot-1.
    const cwd = workspacePath(w.config, slotName(1));
    assert.equal(existsSync(cwd), false);
    writeFileSync(w.hold, "");
    const sent = await w.chat.send(KEY, "agent-impl", "  Why did you pick this approach?  ");
    assert.ok(sent.ok, JSON.stringify(sent));
    await w.chat.idle();

    const runs = chatSessions(w.store);
    assert.equal(runs.length, 1);
    const run = runs[0]!;
    assert.equal(run.status, "succeeded");
    assert.equal(run.role, "implement");
    assert.equal(run.agentSessionId, "agent-impl");
    // The board labels it as a chat turn, not a step.
    assert.equal(sessionView(run).chat, true);
    const { args, cwd: ran, prompt } = fakeArgs(w.store, run);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.equal(ran, cwd);
    // The folder is recorded on the session: the next turn must run there too.
    assert.equal(run.cwd, cwd);
    assert.equal(prompt, "Why did you pick this approach?");
    assert.equal(flag("--resume"), "agent-impl");
    assert.equal(flag("--model"), w.config.roles.implement.model);
    assert.equal(flag("--permission-mode"), w.config.roles.implement.permissionMode);
    assert.equal(flag("--allowedTools"), w.config.roles.implement.allowedTools.join(","));
    // Without the role's answer schema: the reply is free text.
    assert.equal(args.includes("--json-schema"), false);
    assert.ok(args.includes("--include-partial-messages"));

    const view = w.chat.view(KEY);
    const impl = view.sessions.find((each) => each.agentSession === "agent-impl")!;
    assert.equal(impl.turns.length, 1);
    assert.equal(impl.turns[0]!.message, "Why did you pick this approach?");
    assert.equal(impl.turns[0]!.reply, "Heard: Why did you pick this approach?");
    assert.equal(impl.turns[0]!.live, false);
    assert.equal(impl.turns[0]!.failed, undefined);
    assert.equal(view.sessions.find((each) => each.agentSession === "agent-review")!.turns.length, 0);
    // Kept in the store, so a reload of the page shows it.
    assert.equal(readTurns(w.store, KEY)[0]!.reply, "Heard: Why did you pick this approach?");

    // The item is where it was: the same job (parked state, step, findings), and the turn is no step's answer.
    assert.equal(JSON.stringify(loadJobs(w.store)), before);
    const kinds = w.store.eventsAfter(0, 1000).filter((event) => event.kind.startsWith("orchestrator.chat")).map((event) => event.kind);
    assert.deepEqual(kinds, ["orchestrator.chat_sent", "orchestrator.chat_answered"]);
    // Parking the Item had freed the worktree; the turn took one and it is freed again (kept on disk for reuse).
    assert.equal(heldSlot(w.store, workspaceKey(ITEM)), null);
    assert.equal(existsSync(join(cwd, ".git")), true);
  });

  test("a triage's session keeps its read-only tools and model, without its schema", async () => {
    const w = world();
    writeFileSync(w.hold, "");
    const sent = await w.chat.send(KEY, "agent-look", "What did you leave out?");
    assert.ok(sent.ok, JSON.stringify(sent));
    await w.chat.idle();
    const run = chatSessions(w.store)[0]!;
    assert.equal(run.role, "triage");
    const { args } = fakeArgs(w.store, run);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.equal(flag("--resume"), "agent-look");
    assert.equal(flag("--model"), w.config.roles.triage.model);
    assert.equal(flag("--allowedTools"), w.config.roles.triage.allowedTools.join(","));
    assert.equal(args.includes("--json-schema"), false);
    assert.equal(w.chat.view(KEY).sessions.find((each) => each.agentSession === "agent-look")!.turns[0]!.reply, "Heard: What did you leave out?");
  });

  test("while a session runs on the item, a message is refused and the box says why", async () => {
    const w = world({ parked: undefined, sessionId: "s9" });
    step(w.store, "s9", "review", "agent-review-2", "2026-11-18T09:40:00.000Z", { status: "running", finishedAt: undefined, pid: 999_999 });
    const view = w.chat.view(KEY);
    assert.match(view.blocked ?? "", /Scope Soup is running the review session on this Item/);
    const sent = await w.chat.send(KEY, "agent-impl", "Hello?");
    assert.equal(sent.ok, false);
    assert.equal(!sent.ok && sent.status, 409);
    assert.equal(chatSessions(w.store).length, 0);
  });

  test("while a chat turn runs: the reply grows on the page, a second message is refused, and the runner calls the item busy", async () => {
    const w = world();
    const sent = await w.chat.send(KEY, "agent-impl", "First question");
    assert.ok(sent.ok, JSON.stringify(sent));
    assert.equal(w.runner.busy(ITEM), true);
    await until(() => w.chat.view(KEY).sessions.find((each) => each.agentSession === "agent-impl")!.turns[0]!.reply === "Heard:", "the first words of the reply");
    const view = w.chat.view(KEY);
    assert.equal(view.sessions.find((each) => each.agentSession === "agent-impl")!.turns[0]!.live, true);
    assert.equal(view.blocked, "Your last message is still being answered.");
    const second = await w.chat.send(KEY, "agent-review", "Second question");
    assert.equal(second.ok, false);
    writeFileSync(w.hold, "");
    await w.chat.idle();
    assert.equal(w.runner.busy(ITEM), false);
    assert.equal(w.chat.view(KEY).blocked, undefined);
    assert.equal(chatSessions(w.store).length, 1);
  });

  test("at the usage stop a message is refused", async () => {
    const w = world();
    const resetsAt = new Date(T0 + 3 * 3600_000).toISOString();
    w.store.addUsageSample({ at: new Date(T0).toISOString(), windows: [{ kind: "five_hour", utilization: 0.99, resetsAt }, { kind: "seven_day", utilization: 0.2, resetsAt: new Date(T0 + 5 * 86400_000).toISOString() }] });
    assert.match(w.chat.view(KEY).blocked ?? "", /^The usage stop: /);
    const sent = await w.chat.send(KEY, "agent-impl", "Hello?");
    assert.equal(sent.ok, false);
    assert.match(!sent.ok ? sent.message : "", /usage stop/);
    assert.equal(chatSessions(w.store).length, 0);
  });

  test("Stop refuses a message; an item without work under way, or a session it does not have, too", async () => {
    const stopped = world();
    setRolesForTest(stopped.store, "stopped");
    assert.match(stopped.chat.view(KEY).blocked ?? "", /Stop was pressed/);
    const none = world(null);
    assert.match(none.chat.view(KEY).blocked ?? "", /no work under way/);
    assert.equal((await none.chat.send(KEY, "agent-impl", "Hello?")).ok, false);
    const other = world();
    const sent = await other.chat.send(KEY, "agent-of-another-item", "Hello?");
    assert.equal(!sent.ok && sent.status, 404);
  });

  test("at level 4 a message is refused while the item is queued for merging, being merged or owes its hand-over", async () => {
    for (const over of [
      { parked: { as: "queued" as const, reason: "Waits in the merge queue.", at: "2026-11-18T09:30:00.000Z" }, queued: "a".repeat(40) },
      { parked: undefined, owes: "hand-over" as const },
    ]) {
      const w = world(over);
      assert.match(w.chat.view(KEY).blocked ?? "", /queued for merging.*once it merges or comes back/);
      const sent = await w.chat.send(KEY, "agent-impl", "Hello?");
      assert.equal(!sent.ok && sent.status, 409);
      assert.equal(chatSessions(w.store).length, 0);
    }
  });
});

test("a merged Item takes no more messages: it says so, not that it is queued", async () => {
  const w = world({ parked: { as: "queued" as const, reason: "Merged.", at: "2026-11-18T09:30:00.000Z" }, merged: "b".repeat(40) });
  assert.equal(w.chat.view(KEY).blocked, "The Item is merged, so its sessions take no more messages.");
  const sent = await w.chat.send(KEY, "agent-impl", "Hello?");
  assert.equal(!sent.ok && sent.status, 409);
});

// --- A pool of clones: the turn runs in the clone the session ran in (`claude` keeps a session per folder) ---

interface PoolWorld {
  store: Store;
  config: ProjectConfig;
  chat: Chat;
  clone: (name: "a" | "b") => string;
  started: string[];
  released: string[];
  /** Which clone the fake `takeWorkspace` hands the item. */
  takes: "a" | "b";
}

function poolWorld(holdings: Record<string, { item: string; clone: "a" | "b"; branch: string; held: boolean; at: string }>, cwd: "a" | "b" | "gone" | null): PoolWorld {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-chatpool-"));
  dirs.push(dir);
  mkdirSync(join(dir, "seed-project"));
  for (const name of ["a", "b"]) mkdirSync(join(dir, "pool", name, "modules", "project"), { recursive: true });
  const result = validateConfig({
    project: "synthetic", machineName: "laptop-a", repoPath: "seed-project", level: 3,
    workspaces: { kind: "pool", paths: ["pool/a", "pool/b"], projectSubdir: "modules/project" },
  }, dir);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const config = result.config;
  const paths = config.workspaces.kind === "pool" ? config.workspaces.paths : [];
  const clone = (name: "a" | "b") => paths[name === "a" ? 0 : 1]!;
  const store = openStore(":memory:");
  setRolesForTest(store, "started");
  const work: WorkItem = { ref: ITEM, title: "A synthetic item", state: "doing", hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-01T00:00:00Z" };
  store.put(work, "sync", "2026-11-18T08:00:00.000Z");
  const where = cwd === null ? undefined : cwd === "gone" ? join(dir, "pool", "gone", "modules", "project") : join(clone(cwd), "modules", "project");
  step(store, "s2", "implement", "agent-impl", "2026-11-18T08:30:00.000Z", where ? { cwd: where } : {});
  store.setValue(HOLDINGS_KEY, JSON.stringify(Object.fromEntries(Object.entries(holdings).map(([key, holding]) => [key, { ...holding, clone: clone(holding.clone) }]))));
  const job: Job = {
    item: ITEM, workspace: workspaceKey(ITEM), branch: workBranch(ITEM), step: "implement", failures: 0, fixRounds: 1, agentSession: "agent-impl",
    parked: { as: "escalated", reason: "Asked.", at: "2026-11-18T09:30:00.000Z", byStep: true }, startedAt: "2026-11-18T08:00:00.000Z",
  };
  store.tx(() => saveJobs(store, { [KEY]: job }));
  const out: PoolWorld = { store, config, chat: undefined as unknown as Chat, clone, started: [], released: [], takes: "a" };
  const writeHoldings = (change: (all: ReturnType<typeof readHoldings>["holdings"]) => void) => {
    const all = readHoldings(store).holdings;
    change(all);
    store.setValue(HOLDINGS_KEY, JSON.stringify(all));
  };
  let count = 0;
  const runner = {
    async start(request: SessionRequest): Promise<Session> {
      out.started.push(`${request.resume} in ${readHoldings(store).holdings[request.workspace]?.clone}`);
      const at = "2026-11-18T10:00:00.000Z";
      const session: Session = { ref: { host: "scopesoup", kind: "session", id: `c${++count}` }, role: request.role, subject: request.subject, status: "succeeded", attempt: 1, startedAt: at, finishedAt: at, chat: true };
      if (request.resume) session.agentSessionId = request.resume;
      store.put(session, "orchestrator", at);
      return session;
    },
    running: () => 0,
    busy: () => false,
    async finished(id: string) {
      return store.get<Session>({ host: "scopesoup", kind: "session", id })!;
    },
    async takeWorkspace(item: Ref, workspace: string, branch: string) {
      writeHoldings((all) => (all[workspace] = { item: refKey(item), clone: clone(out.takes), branch, held: true, at: "2026-11-18T10:00:00.000Z" }));
      return null;
    },
    async releaseWorkspace(workspace: string) {
      out.released.push(workspace);
      writeHoldings((all) => {
        if (all[workspace]) all[workspace]!.held = false;
      });
    },
  };
  out.chat = createChat({ store, runner, config: () => config, now: () => "2026-11-18T10:00:00.000Z" });
  return out;
}

const WS = workspaceKey(ITEM);
const holding = (clone: "a" | "b", held: boolean, item = KEY, branch = workBranch(ITEM)) => ({ item, clone, branch, held, at: "2026-11-18T08:00:00.000Z" });

describe("chat in a pool of clones", { concurrency: 4 }, () => {
  test("the turn resumes in the clone the session ran in: held now, or taken again after the Item was parked and freed after the turn", async () => {
    const held = poolWorld({ [WS]: holding("a", true) }, "a");
    const sent = await held.chat.send(KEY, "agent-impl", "Why?");
    assert.ok(sent.ok, JSON.stringify(sent));
    await held.chat.idle();
    assert.deepEqual(held.started, [`agent-impl in ${held.clone("a")}`]);
    assert.deepEqual(held.released, []);

    const parkedRun = poolWorld({ [WS]: holding("a", false) }, "a");
    const again = await parkedRun.chat.send(KEY, "agent-impl", "Why?");
    assert.ok(again.ok, JSON.stringify(again));
    await parkedRun.chat.idle();
    assert.deepEqual(parkedRun.started, [`agent-impl in ${parkedRun.clone("a")}`]);
    assert.deepEqual(parkedRun.released, [WS]);
  });

  test("refused with the reason, and nothing started, when the session's folder is not the item's to resume in", async () => {
    const cases: [Parameters<typeof poolWorld>[0], Parameters<typeof poolWorld>[1], RegExp][] = [
      // The item's work is in another clone now.
      [{ [WS]: holding("b", true) }, "a", /ran in the clone .*a, but the Item's work is in the clone .*b now/],
      // The clone the session ran in holds another item's work.
      [{ "fake-work-7": holding("a", true, "fake:work:7", "scopesoup/7") }, "a", /now holds another Item's work \(fake:work:7\)/],
      // The folder is gone.
      [{}, "gone", /is gone/],
      // No folder was recorded (a session from earlier).
      [{}, null, /did not record which clone/],
    ];
    for (const [holdings, cwd, reason] of cases) {
      const w = poolWorld(holdings, cwd);
      const sent = await w.chat.send(KEY, "agent-impl", "Why?");
      assert.equal(sent.ok, false);
      assert.match(!sent.ok ? sent.message : "", reason);
      assert.deepEqual(w.started, []);
    }
  });

  test("when the pool hands the item another clone than the session's, the clone goes back and the message is refused", async () => {
    const w = poolWorld({}, "a");
    w.takes = "b";
    const sent = await w.chat.send(KEY, "agent-impl", "Why?");
    assert.match(!sent.ok ? sent.message : "", /could not be taken for the turn; the Item got .*b/);
    assert.deepEqual(w.started, []);
    assert.deepEqual(w.released, [WS]);
  });
});
