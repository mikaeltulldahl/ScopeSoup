// The host from the configuration file, and issue with a meta branch host Scope Soup makes no network
// request of its own, only git. All names are synthetic.

import assert from "node:assert/strict";
import { request } from "node:http";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import type { ProjectConfig } from "./config/types.ts";
import { MACHINE_NAME_MISSING, validateConfig } from "./config/validate.ts";
import { readMarker } from "./hosts/github/conventions.ts";
import { fakeIssues, ISSUES_API } from "./hosts/github/fakeIssues.ts";
import { createTestRepo, itemMd } from "./hosts/metaBranch/testRepo.ts";
import { createHosts, describeHosts, hostSettings, ignoredVariables } from "./hostSetup.ts";
import { createServer } from "./server/server.ts";
import { openStore } from "./store/store.ts";
import { createSync } from "./sync/index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces the global fetch with one that records each call and fails it. */
function watchFetch(): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in this test");
  }) as typeof fetch;
  return calls;
}

function config(raw: Record<string, unknown>, dir: string): ProjectConfig {
  const result = validateConfig({ project: "p", machineName: "laptop-a", ...raw }, dir);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

/** A plain HTTP call that does not go through fetch. */
function call(url: string, method = "GET", body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const target = new URL(url);
    const req = request(target, { method, headers: { "Content-Type": "application/json", Origin: target.origin } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => done({ status: response.statusCode ?? 0, text }));
    });
    req.on("error", fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const ENV = {
  SCOPESOUP_GITHUB_REPO: "owner/name",
  SCOPESOUP_GITHUB_TOKEN: "test-token",
  SCOPESOUP_META_REPO: "/elsewhere",
  SCOPESOUP_META_WRITE: "1",
};

test("a host in the file wins over the environment, and the ignored variables are named", () => {
  const settings = hostSettings(config({ repoPath: "/srv/clone", host: { kind: "metaBranch" } }, "/srv"), ENV, resolve);
  assert.equal(settings.from, "file");
  assert.equal(settings.github, undefined);
  assert.equal(settings.meta?.repoPath, resolve("/srv/clone"));
  assert.deepEqual(ignoredVariables(settings, ENV), ["SCOPESOUP_GITHUB_REPO", "SCOPESOUP_META_REPO", "SCOPESOUP_META_WRITE"]);
  assert.match(describeHosts(settings), /host from the configuration file/);
});

test("without a host in the file the environment still decides", () => {
  const env = { SCOPESOUP_META_REPO: "meta", SCOPESOUP_META_REMOTE: "none", SCOPESOUP_GITHUB_REPO: "owner/name", SCOPESOUP_WRITE: "1" };
  const settings = hostSettings(config({ repoPath: "/srv/clone" }, "/srv"), env, (path) => resolve("/work", path));
  assert.equal(settings.from, "environment");
  assert.deepEqual(settings.meta, { kind: "metaBranch", repoPath: resolve("/work", "meta"), write: false, remote: null, fetchSeconds: 60 });
  assert.deepEqual(settings.github, { kind: "github", repo: "owner/name", write: true });
  assert.deepEqual(ignoredVariables(settings, env), []);
  assert.equal(settings.machine, "laptop-a");
  assert.deepEqual(hostSettings(null, {}, resolve), { from: "environment" });
  assert.throws(() => hostSettings(null, { SCOPESOUP_META_REPO: "meta", SCOPESOUP_META_WRITE: "1" }, resolve), /needs SCOPESOUP_META_AUTHOR_NAME/);
});

test("a github host from the file still takes its token from the environment only", () => {
  const settings = hostSettings(config({ repoPath: "/srv/clone", host: { kind: "github", repo: "owner/name" } }, "/srv"), {}, resolve);
  assert.throws(() => createHosts(settings, {}), /SCOPESOUP_GITHUB_TOKEN is not set/);
});

test("the fetch watch sees a github host's requests (so the meta branch test below can fail)", async () => {
  const calls = watchFetch();
  const settings = hostSettings(config({ repoPath: "/srv/clone", host: { kind: "github", repo: "owner/name" } }, "/srv"), { SCOPESOUP_GITHUB_TOKEN: "test-token" }, resolve);
  const store = openStore(":memory:");
  const sync = createSync({ store, hosts: createHosts(settings, { SCOPESOUP_GITHUB_TOKEN: "test-token" }), intervalMs: 60_000 });
  await sync.refreshNow().catch(() => undefined);
  sync.stop();
  store.close();
  assert.ok(calls.length > 0, "the github host should have called fetch");
});

test("with a meta branch host the server side never calls fetch: sync, board and item writes use git only", async () => {
  const repo = createTestRepo();
  const store = openStore(":memory:");
  const calls = watchFetch();
  try {
    repo.commit("refs/scopesoup/meta", { "items/T-1/item.md": itemMd("T-1", "Sweep the yard", "todo") }, "2026-11-18T09:00:00Z");
    const project = config({
      repoPath: repo.dir,
      host: { kind: "metaBranch", write: true, authorName: "Test Person", authorEmail: "test.person@example.invalid", prefix: "T", machine: "laptop-a" },
    }, repo.dir);
    // The environment names a GitHub repository and a token too; the file wins, so neither is used.
    const settings = hostSettings(project, ENV, resolve);
    const hosts = createHosts(settings, ENV, () => undefined);
    assert.equal(hosts.length, 1);
    const sync = createSync({ store, hosts, intervalMs: 60_000 });
    await sync.refreshNow();
    const host = hosts[0];
    assert.ok(host?.write);
    const server = createServer({ store, port: 0, items: { host: host.info.id, write: host.write } });
    const { url } = await server.start();
    try {
      const board = await call(`${url}/api/board`);
      assert.equal(board.status, 200);
      assert.match(board.text, /Sweep the yard/);
      const made = await call(`${url}/api/items`, "POST", { title: "Rake the leaves", as: "Ada" });
      assert.equal(made.status, 200, made.text);
      await sync.refreshNow();
      assert.match((await call(`${url}/api/board`)).text, /Rake the leaves/);
    } finally {
      sync.stop();
      await server.stop();
      await Promise.all(hosts.map((one) => one.stop?.()));
    }
    assert.deepEqual(calls, [], "a meta branch project must make no network request of its own");
  } finally {
    store.close();
    repo.cleanup();
  }
});

// The machine is named by the required `machineName` setting; the computer's host name never reaches a host.
for (const name of ["laptop-a", "desk"]) {
  test(`a GitHub claim comment names the machine ${name}`, async () => {
    const fake = fakeIssues("harbour/tides", [1]);
    globalThis.fetch = (async (input: string, init?: Parameters<typeof fake.fetch>[1]) => {
      const url = String(input);
      if (url === "https://api.github.com/user") return { status: 200, headers: { get: () => null }, json: async () => ({ login: "scopesoup-bot", id: 1, type: "User" }), text: async () => "" };
      return fake.fetch(url.replace("https://api.github.com", ISSUES_API), init);
    }) as unknown as typeof fetch;
    const project = config({ repoPath: "/srv/clone", host: { kind: "github", repo: "harbour/tides", write: true }, machineName: name }, "/srv");
    const settings = hostSettings(project, { SCOPESOUP_MACHINE: "no-longer-read" }, resolve);
    assert.equal(settings.machine, name);
    const [host] = createHosts(settings, { SCOPESOUP_GITHUB_TOKEN: "test-token" }, () => undefined);
    assert.equal(host?.info.claimMachine, name);
    const until = new Date(Date.now() + 2 * 3600_000).toISOString();
    assert.deepEqual(await host!.write!.claim!({ host: host!.info.id, kind: "work", id: "1" }, { until, shown: name }), { won: true });
    const claims = (fake.comments.get("1") ?? []).filter((comment) => readMarker(comment.body)?.kind === "claim");
    assert.equal(claims.length, 1);
    assert.match(claims[0]!.body ?? "", new RegExp(`"machine":"${name}"`));
  });

  test(`meta-branch claim lines and commits name the machine ${name}`, async () => {
    const repo = createTestRepo();
    try {
      repo.commit("refs/scopesoup/meta", { "items/T-1/item.md": itemMd("T-1", "Sweep the yard", "todo") }, "2026-11-18T09:00:00Z");
      const project = config({
        repoPath: repo.dir,
        host: { kind: "metaBranch", write: true, authorName: "Test Person", authorEmail: "test.person@example.invalid", prefix: "T" },
        machineName: name,
      }, repo.dir);
      const hosts = createHosts(hostSettings(project, { SCOPESOUP_MACHINE: "no-longer-read" }, resolve), {}, () => undefined);
      const host = hosts[0]!;
      try {
        assert.equal(host.info.machine, name);
        await host.write!.appendLog!({ host: host.info.id, kind: "work", id: "T-1" }, { kind: "claimed", by: { who: "scopesoup", agent: true }, fields: { until: "2026-11-18T17:00:00Z" } });
        const line = JSON.parse(repo.git(["show", "refs/scopesoup/meta:items/T-1/log.jsonl"]).trim().split("\n").at(-1)!) as { by: { machine: string } };
        assert.equal(line.by.machine, name);
        assert.match(repo.git(["log", "-1", "--format=%B", "refs/scopesoup/meta"]), new RegExp(`^ScopeSoup-Machine: ${name}$`, "m"));
      } finally {
        await Promise.all(hosts.map((one) => one.stop?.()));
      }
    } finally {
      repo.cleanup();
    }
  });
}

test("machineName is a short plain name", () => {
  for (const name of ["desk", "laptop-a", "build_2.local", "x".repeat(40)]) assert.equal(config({ repoPath: "/srv/clone", machineName: name }, "/srv").machineName, name);
  for (const name of ["", "x".repeat(41), "my desk", "desk/1", "skrivbord-å", 7]) {
    const result = validateConfig({ project: "p", repoPath: "/srv/clone", machineName: name }, "/srv");
    assert.equal(result.ok, false, String(name));
    if (!result.ok) assert.match(result.errors.join("\n"), /machineName must be 1 to 40 letters, digits, "-", "_" or "\."/);
  }
});

test("machineName is required, and says why", () => {
  const result = validateConfig({ project: "p", repoPath: "/srv/clone" }, "/srv");
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors, [MACHINE_NAME_MISSING]);
  assert.match(MACHINE_NAME_MISSING, /^machineName is required: .*"machineName": "desk".* two machines with the same name treat each other's claims as their own\.$/);
});

test("the older host.machine loads with a notice and names nothing; SCOPESOUP_MACHINE is not read", () => {
  const result = validateConfig({ project: "p", machineName: "desk", repoPath: "/srv/clone", host: { kind: "metaBranch", machine: "laptop-a" } }, "/srv");
  assert.ok(result.ok);
  assert.deepEqual(result.notices, ["host.machine was dropped: the top-level machineName names the machine now."]);
  assert.equal(result.config.host?.kind === "metaBranch" && "machine" in result.config.host, false);
  assert.equal(hostSettings(result.config, { SCOPESOUP_MACHINE: "laptop-b" }, resolve).machine, "desk");
  assert.equal(hostSettings(config({ repoPath: "/srv/clone", machineName: "desk" }, "/srv"), { SCOPESOUP_MACHINE: "laptop-b" }, resolve).machine, "desk");
});

test("without a configuration file nothing names the machine, so a host may be read but not written", () => {
  assert.equal(hostSettings(null, { SCOPESOUP_META_REPO: "meta", SCOPESOUP_MACHINE: "laptop-b" }, resolve).machine, undefined);
  const meta = { SCOPESOUP_META_REPO: "meta", SCOPESOUP_META_WRITE: "1", SCOPESOUP_META_AUTHOR_NAME: "Test Person", SCOPESOUP_META_AUTHOR_EMAIL: "test.person@example.invalid", SCOPESOUP_MACHINE: "laptop-b" };
  assert.throws(() => hostSettings(null, meta, resolve), /SCOPESOUP_META_WRITE=1 needs a configuration file with machineName/);
  assert.throws(() => hostSettings(null, { SCOPESOUP_GITHUB_REPO: "owner/name", SCOPESOUP_WRITE: "1" }, resolve), /SCOPESOUP_WRITE=1 needs a configuration file with machineName/);
});
