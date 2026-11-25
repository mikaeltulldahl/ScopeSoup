// The shared settings on the meta ref, with real git: two machines (two clones of one bare remote), saves that race,
// a GitHub-host project, and onboarding on a second machine. All names are synthetic.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { git, isolateGitConfig } from "../orchestrator/fixtures/git-env.ts";
import { createConfigLoader } from "./loader.ts";
import { metaSettings } from "./metaSettings.ts";
import { initSettings } from "./settingsInit.ts";

/** `pnpm settings:init` as the onboarding skill runs it. */
async function settingsInitFor(sharedFile: string, privateFile: string, by: string): Promise<{ ok: boolean; lines: string[] }> {
  const settings = metaSettings();
  try {
    return await initSettings(sharedFile, privateFile, by, settings);
  } finally {
    await settings.stop();
  }
}

const restore = isolateGitConfig();
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  restore();
});

/** A bare remote and two machines' clones of it, each with its private file. */
function project(): { origin: string; a: string; b: string; fileA: string; fileB: string } {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-meta-settings-"));
  dirs.push(dir);
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const a = join(dir, "a", "repo");
  const b = join(dir, "b", "repo");
  git(dir, "clone", "-q", origin, a);
  git(dir, "clone", "-q", origin, b);
  const fileA = join(dir, "a", "scopesoup.config.json");
  const fileB = join(dir, "b", "scopesoup.config.json");
  writeFileSync(fileA, JSON.stringify({ version: 1, machineName: "laptop-a", repoPath: "repo" }, null, 2) + "\n");
  writeFileSync(fileB, JSON.stringify({ version: 1, machineName: "laptop-b", repoPath: "repo" }, null, 2) + "\n");
  return { origin, a, b, fileA, fileB };
}

const settingsAt = (repo: string): Record<string, unknown> => JSON.parse(git(repo, "show", "refs/scopesoup/meta:settings/settings.json")) as Record<string, unknown>;

describe("meta settings", { concurrency: 3 }, () => {
  test("a save writes one meta commit, read back at once; a second machine reads it after a fetch", async () => {
    const { origin, a, b, fileA, fileB } = project();
    const one = metaSettings();
    const two = metaSettings();
    try {
      const first = await one.save({ repoPath: a, remote: "origin", machine: "laptop-a", by: "Ada", update: () => ({ project: "tides", level: 1 }) });
      assert.ok(first.ok && first.changed && first.sharing.state === "shared");
      const before = git(a, "rev-parse", "refs/scopesoup/meta");
      const saved = await one.save({ repoPath: a, remote: "origin", machine: "laptop-a", by: "Ada", update: (current) => ({ ...current, level: 2 }) });
      assert.ok(saved.ok && saved.changed);
      assert.deepEqual(saved.changes, [{ key: "level", from: 1, to: 2 }]);
      // One commit, by the person, read back at once by the loader.
      assert.equal(git(a, "rev-parse", "refs/scopesoup/meta^"), before);
      assert.equal(git(a, "rev-list", "--count", `${before}..refs/scopesoup/meta`), "1");
      assert.equal(git(a, "log", "-1", "--format=%an", "refs/scopesoup/meta"), "Ada");
      assert.equal(createConfigLoader(fileA, undefined, { shared: one, sharedTtlMs: 0 }).load().config?.level, 2);
      assert.equal(git(origin, "rev-parse", "refs/scopesoup/meta"), git(a, "rev-parse", "refs/scopesoup/meta"));

      // The second machine has no meta ref until it fetches; then it reads the same level.
      const loaderB = createConfigLoader(fileB, undefined, { shared: two, sharedTtlMs: 0 });
      assert.match(loaderB.load().error ?? "", /has no refs\/scopesoup\/meta/);
      const fetched = await two.fetch(b, "origin", "laptop-b");
      assert.equal(fetched.problem, undefined);
      assert.equal(loaderB.load().config?.level, 2);
      assert.deepEqual(two.log(b).map((entry) => [entry.who, entry.machine, entry.changes.map((change) => change.key)]), [["Ada", "laptop-a", ["level"]], ["Ada", "laptop-a", ["project", "level"]]]);
    } finally {
      await Promise.all([one.stop(), two.stop()]);
    }
  });

  test("two saves at once both merge by compare-and-swap: on one machine, and on two machines with one remote", async () => {
    const { origin, a, b } = project();
    const one = metaSettings();
    const other = metaSettings();
    const two = metaSettings();
    try {
      assert.ok((await one.save({ repoPath: a, remote: "origin", machine: "laptop-a", by: "Ada", update: () => ({ project: "tides" }) })).ok);
      // Two writers in one repository at once (as two Scope Soup processes): the ref is moved only from the value each read.
      const [x, y] = await Promise.all([
        one.save({ repoPath: a, remote: "origin", machine: "laptop-a", by: "Ada", update: (current) => ({ ...current, level: 1 }) }),
        other.save({ repoPath: a, remote: "origin", machine: "laptop-a", by: "Bo", update: (current) => ({ ...current, bugLabels: ["defect"] }) }),
      ]);
      assert.ok(x.ok && x.changed && y.ok && y.changed);
      assert.deepEqual(settingsAt(a), { project: "tides", level: 1, bugLabels: ["defect"] });

      // Two machines save different settings at once; the one that pushes second puts its save on top of the other's.
      await two.fetch(b, "origin", "laptop-b");
      const [p, q] = await Promise.all([
        one.save({ repoPath: a, remote: "origin", machine: "laptop-a", by: "Ada", update: (current) => ({ ...current, level: 3 }) }),
        two.save({ repoPath: b, remote: "origin", machine: "laptop-b", by: "Cy", update: (current) => ({ ...current, mainBranch: "trunk" }) }),
      ]);
      assert.ok(p.ok && q.ok);
      for (const report of [await one.fetch(a, "origin", "laptop-a"), await two.fetch(b, "origin", "laptop-b")]) assert.equal(report.problem, undefined);
      const expected = { project: "tides", level: 3, bugLabels: ["defect"], mainBranch: "trunk" };
      assert.deepEqual(settingsAt(origin), expected);
      assert.deepEqual(settingsAt(a), expected);
      assert.deepEqual(settingsAt(b), expected);
      // Every save is in the log, once.
      assert.deepEqual(one.log(a).map((entry) => entry.who).sort(), ["Ada", "Ada", "Ada", "Bo", "Cy"]);
    } finally {
      await Promise.all([one.stop(), other.stop(), two.stop()]);
    }
  });

  test("a pick requested of another machine goes through the meta ref; that machine's answer comes back (decision 104)", async () => {
    const { origin, a, b } = project();
    const one = metaSettings();
    const two = metaSettings();
    try {
      assert.ok((await one.save({ repoPath: a, remote: "origin", machine: "laptop-a", by: "Ada", update: () => ({ project: "tides" }) })).ok);
      await two.fetch(b, "origin", "laptop-b");
      const steps = [{ kind: "move", to: "backlog" }];
      const asked = await one.writeRequest({ repoPath: a, remote: "origin", machine: "laptop-a" }, { kind: "pick", by: { who: "mira", agent: false }, fields: { id: "r-1", item: "meta:work:A-2", for: "laptop-b", seen: "2026-11-25T10:00:00.000Z", steps } });
      assert.ok(asked.ok && asked.sharing.state === "shared");
      assert.deepEqual(two.requests(b), []);
      await two.fetch(b, "origin", "laptop-b");
      const seen = two.requests(b);
      assert.deepEqual(seen.map((request) => [request.id, request.who, request.from, request.for, request.item, request.steps, request.answer]), [["r-1", "mira", "laptop-a", "laptop-b", "meta:work:A-2", steps, undefined]]);
      // laptop-b answers; laptop-a reads the answer after its fetch, while laptop-b saved settings meanwhile (the logs merge).
      assert.ok((await two.writeRequest({ repoPath: b, remote: "origin", machine: "laptop-b" }, { kind: "pick-done", by: { who: "scopesoup", agent: true }, fields: { request: "r-1", done: ["moved"] } })).ok);
      assert.ok((await one.save({ repoPath: a, remote: "origin", machine: "laptop-a", by: "Ada", update: (current) => ({ ...current, level: 2 }) })).ok);
      await one.fetch(a, "origin", "laptop-a");
      assert.deepEqual(one.requests(a)[0]?.answer?.done, ["moved"]);
      assert.equal(git(origin, "show", `refs/scopesoup/meta:requests/${new Date().toISOString().slice(0, 7)}.jsonl`).trim().split(/\r?\n/).length, 2);
      // An answer written by another machine than the one asked is not taken.
      assert.ok((await one.writeRequest({ repoPath: a, remote: "origin", machine: "laptop-a" }, { kind: "pick", by: { who: "mira", agent: false }, fields: { id: "r-2", item: "meta:work:A-2", for: "laptop-b", seen: "x", steps } })).ok);
      assert.ok((await one.writeRequest({ repoPath: a, remote: "origin", machine: "laptop-a" }, { kind: "pick-refused", by: { who: "scopesoup", agent: true }, fields: { request: "r-2", why: "no" } })).ok);
      assert.equal(one.requests(a)[1]?.answer, undefined);
    } finally {
      await Promise.all([one.stop(), two.stop()]);
    }
  });

  test("a GitHub-host project keeps its shared settings on the meta ref, which holds nothing else", async () => {
    const { origin, a, fileA } = project();
    const settings = metaSettings();
    try {
      const saved = await settings.save({ repoPath: a, remote: "origin", machine: "laptop-a", by: "Ada", update: () => ({ project: "tides", host: { kind: "github", repo: "harbour/tides" }, level: 0 }) });
      assert.ok(saved.ok);
      const config = createConfigLoader(fileA, undefined, { shared: settings, sharedTtlMs: 0 }).load().config;
      assert.deepEqual(config?.host, { kind: "github", repo: "harbour/tides", write: false });
      assert.deepEqual(git(origin, "ls-tree", "-r", "--name-only", "refs/scopesoup/meta").split("\n"), ["format", "settings/log.jsonl", "settings/settings.json"]);
      // The main branch is not touched: the remote has no branch at all.
      assert.equal(git(origin, "for-each-ref", "--format=%(refname)", "refs/heads"), "");
    } finally {
      await settings.stop();
    }
  });

  test("a shared key in the private file is refused with where it belongs; onboarding on a second machine writes only its private file", async () => {
    const { origin, a, b, fileA, fileB } = project();
    const shared = join(a, "..", "settings.json");
    writeFileSync(shared, JSON.stringify({ project: "tides", level: 0 }, null, 2) + "\n");
    const first = await settingsInitFor(shared, fileA, "Ada");
    assert.equal(first.ok, true, first.lines.join("\n"));
    assert.match(first.lines[0] ?? "", /^Wrote the project's shared settings .* by Ada\.$/);
    const tip = git(origin, "rev-parse", "refs/scopesoup/meta");

    // The second person runs onboarding on their machine: it finds the settings and writes nothing to the repository.
    const second = await settingsInitFor(shared, fileB, "Bo");
    assert.equal(second.ok, false);
    assert.match(second.lines[0] ?? "", /has the project's shared settings .* already: you are joining a project Scope Soup runs\. Nothing was written\. Write only this machine's private file/);
    assert.equal(git(origin, "rev-parse", "refs/scopesoup/meta"), tip);
    assert.equal(git(b, "rev-parse", "refs/scopesoup/meta"), tip);

    // A shared key in the private file is refused, saying where it belongs.
    writeFileSync(fileB, JSON.stringify({ version: 1, machineName: "laptop-b", repoPath: "repo", level: 3 }, null, 2) + "\n");
    const settings = metaSettings();
    try {
      const state = createConfigLoader(fileB, undefined, { shared: settings, sharedTtlMs: 0 }).load();
      assert.equal(state.config, null);
      assert.match(state.error ?? "", /level is a project setting, the same on every machine: it belongs in the project's shared settings \(settings\/settings\.json on refs\/scopesoup\/meta\), saved on the Settings page, not in this machine's scopesoup\.config\.json\./);
    } finally {
      await settings.stop();
    }
  });
});
