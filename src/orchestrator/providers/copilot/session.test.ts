// Every role on the Copilot provider, through the runner, its driver and the fake `copilot` (fake-copilot.ts), in a real
// throwaway git repository. Nothing here starts the real CLI.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { validateConfig } from "../../../config/validate.ts";
import type { Ref, Session, SessionRole } from "../../../model/types.ts";
import { openStore } from "../../../store/store.ts";
import { execFileSyncRetrying } from "../../../hosts/spawnRetry.ts";
import { workBranch, workspaceKey } from "../../paths.ts";
import type { SessionRequest } from "../../ports.ts";
import { createRunner, readSessionResult } from "../../runner.ts";
import { streamTokens } from "../../../server/usage.ts";
import { usageFile } from "./command.ts";

const FAKE = join(import.meta.dirname, "fake-copilot.ts");
const T0 = Date.parse("2026-11-20T10:00:00Z");
const dirs: string[] = [];
const cleanups: (() => void)[] = [];
after(async () => {
  for (const cleanup of cleanups) cleanup();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 12 });
});

const COPILOT_ROLES = { triage: { provider: "copilot" }, implement: { provider: "copilot" }, review: { provider: "copilot" } };

function world(mode: string, env: NodeJS.ProcessEnv = {}, roles: Record<string, unknown> = COPILOT_ROLES) {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-copilot-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSyncRetrying("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "README.md"), "synthetic\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  const result = validateConfig({
    project: "synthetic", machineName: "laptop-a", repoPath: "repo", level: 3, roles,
    copilot: { path: process.execPath, prefixArgs: ["--disable-warning=ExperimentalWarning", FAKE] },
  }, dir);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const config = result.config;
  const store = openStore(":memory:");
  const runner = createRunner({
    store, config: () => config, now: () => T0,
    env: { ...process.env, COPILOT_GITHUB_TOKEN: "synthetic-token", FAKE_COPILOT_MODE: mode, ...env },
  });
  cleanups.push(() => runner.stopAll("test over"));
  return { config, store, runner };
}

const ITEM: Ref = { host: "fake", kind: "work", id: "7" };

function request(role: SessionRole, over: Partial<SessionRequest> = {}): SessionRequest {
  return {
    role, subject: ITEM, attempt: 1, workspace: workspaceKey(ITEM), branch: workBranch(ITEM),
    vars: {
      project: "synthetic", mainBranch: "main", branch: workBranch(ITEM), itemId: "7", itemTitle: "A title", itemBody: "A body.",
      verification: "none", allowedCommands: "(the commands)", finish: "Commit and stop.", labels: "", decisions: "",
    },
    ...over,
  };
}

function events(session: Session): Record<string, unknown>[] {
  return readFileSync(session.streamPath ?? "", "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function fakeArgs(session: Session): { args: string[]; prompt: string; hasToken: boolean }[] {
  return events(session).filter((event) => event.type === "fake.args").map((event) => event.data as { args: string[]; prompt: string; hasToken: boolean });
}

const TRIAGE = { ready: true, size: "small", questions: [], draft: "d", links: [], blockers: [], paths: [] };
const REVIEW = { verdict: "approve", findings: [] };

describe("Copilot sessions", { concurrency: 4 }, () => {
  test("a triage runs on Copilot: Fusion, its rules, the answer checked, usage recorded", async () => {
    const w = world("ok", { FAKE_COPILOT_OUTPUT: JSON.stringify(TRIAGE) });
    const session = await w.runner.finished((await w.runner.start(request("triage"))).ref.id);
    assert.equal(session.status, "succeeded", session.endReason);
    assert.equal(session.provider, "copilot");
    assert.equal(session.model, "fusion");
    assert.equal(session.agentSessionId, "00000000-0000-4000-8000-00000000f001");
    assert.equal(session.lastAction, JSON.stringify(TRIAGE));
    assert.deepEqual(readSessionResult(w.store, session.ref.id), { malformedLines: 0, turns: 2, subtype: "success", premiumRequests: 1, aiCredits: 0.05, output: TRIAGE });
    const [run] = fakeArgs(session);
    assert.ok(run);
    const value = (name: string) => run.args[run.args.indexOf(name) + 1];
    assert.equal(value("--model"), "fusion");
    assert.equal(value("--auto-tier"), "balance");
    assert.ok(run.args.includes("--allow-tool=shell(git log:*)"));
    assert.ok(run.args.includes("--deny-tool=shell(git push)"));
    assert.equal(run.args.some((arg) => arg.startsWith("--allow-tool=write")), false);
    assert.match(run.prompt, /your last message is your answer/);
    assert.equal(existsSync(usageFile(session.streamPath ?? "")), true);
    assert.equal(streamTokens(session.streamPath, session.provider), 1050);
  });

  test("a review runs on Copilot; a resumed one is sent only the message, with --resume", async () => {
    const w = world("ok", { FAKE_COPILOT_OUTPUT: JSON.stringify(REVIEW) });
    const first = await w.runner.finished((await w.runner.start(request("review"))).ref.id);
    assert.equal(first.status, "succeeded", first.endReason);
    assert.deepEqual(readSessionResult(w.store, first.ref.id).output, REVIEW);
    const again = await w.runner.finished((await w.runner.start(request("review", { resume: "00000000-0000-4000-8000-00000000f001", message: "Look again." }))).ref.id);
    assert.equal(again.status, "succeeded", again.endReason);
    const [run] = fakeArgs(again);
    assert.ok(run?.args.includes("--resume=00000000-0000-4000-8000-00000000f001"));
    assert.equal(run?.args.includes("--trust-folder"), false);
    assert.match(run?.prompt ?? "", /^Look again\.\n\nWhen you are done/);
    assert.equal(readSessionResult(w.store, again.ref.id).premiumRequests, 2);
  });

  test("an answer that does not fit is asked for again once, in the same session", async () => {
    const w = world("prose-then-answer", { FAKE_COPILOT_OUTPUT: JSON.stringify(REVIEW) });
    const session = await w.runner.finished((await w.runner.start(request("review"))).ref.id);
    assert.equal(session.status, "succeeded", session.endReason);
    assert.deepEqual(readSessionResult(w.store, session.ref.id).output, REVIEW);
    const runs = fakeArgs(session);
    assert.equal(runs.length, 2);
    assert.match(runs[1]?.prompt ?? "", /^Your last message was not an answer that fits the schema \(the answer was not JSON\)/);
    assert.ok(runs[1]?.args.includes("--resume=00000000-0000-4000-8000-00000000f001"));
    assert.ok(events(session).some((event) => event.type === "scopesoup.ask_again"));
  });

  test("an answer that still does not fit after asking again fails the session", async () => {
    const w = world("prose");
    const session = await w.runner.finished((await w.runner.start(request("review"))).ref.id);
    assert.equal(session.status, "failed");
    assert.equal(session.endReason, "The agent ended without an answer that fits the schema.");
    assert.equal(fakeArgs(session).length, 2);
  });

  test("an implement role that may commit is refused on Copilot before anything starts", async () => {
    const w = world("ok");
    const session = await w.runner.start(request("implement"));
    assert.equal(session.status, "failed");
    assert.match(session.endReason ?? "", /^Refused: Copilot CLI cannot refuse `git commit --no-verify`/);
    assert.equal(session.pid, undefined);
  });

  test("an implement role without git commit runs on Copilot with file writes allowed", async () => {
    const roles = { implement: { provider: "copilot", allowedTools: ["Read", "Edit", "Write", "Bash(git add *)"] } };
    const w = world("ok", { FAKE_COPILOT_OUTPUT: '{"done":true,"summary":"edited"}' }, roles);
    const session = await w.runner.finished((await w.runner.start(request("implement"))).ref.id);
    assert.equal(session.status, "succeeded", session.endReason);
    const [run] = fakeArgs(session);
    assert.ok(run?.args.includes("--allow-tool=write"));
    assert.ok(run?.args.includes("--allow-tool=shell(git add:*)"));
  });

  test("a refused command is recorded; a rate limit ends the session as 'limit'; a crash fails it", async () => {
    const denied = world("denied", { FAKE_COPILOT_OUTPUT: JSON.stringify(REVIEW) });
    const d = await denied.runner.finished((await denied.runner.start(request("review"))).ref.id);
    assert.deepEqual(readSessionResult(denied.store, d.ref.id).denied, ["git tag demo-tag"]);

    const limited = world("limit");
    const l = await limited.runner.finished((await limited.runner.start(request("review"))).ref.id);
    assert.equal(l.status, "limit");
    assert.match(l.endReason ?? "", /the reset time is unknown/);

    const crash = world("fail");
    const c = await crash.runner.finished((await crash.runner.start(request("review"))).ref.id);
    assert.equal(c.status, "failed");
    assert.match(c.endReason ?? "", /no result\. Last error output: fake copilot: something broke/);
  });

  test("a chat turn on Copilot replies in free text", async () => {
    const w = world("chat");
    const session = await w.runner.finished((await w.runner.start(request("review", { chat: true, resume: "earlier", message: "Hello?" }))).ref.id);
    assert.equal(session.status, "succeeded", session.endReason);
    assert.equal(readSessionResult(w.store, session.ref.id).output, undefined);
    assert.equal(fakeArgs(session)[0]?.prompt, "Hello?");
  });
});
