// A shared resource between two machines: real git, one bare remote, two clones, one lease per unit on the remote
// (`refs/scopesoup/resources/<name>/<unit>`, the merge queue's lease code). Synthetic data.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { ProjectConfig } from "../config/types.ts";
import { validateConfig } from "../config/validate.ts";
import { cloneTestRepo, createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { openStore } from "../store/store.ts";
import { createMergeQueue } from "./mergeQueue.ts";
import { realGit } from "./process.ts";
import { createResources, readResourceState, resourcesView, unitRef } from "./resources.ts";

const cleanups: (() => void)[] = [];
after(() => cleanups.reverse().forEach((cleanup) => cleanup()));

const T = (minutes: number): string => new Date(Date.parse("2026-11-18T09:00:00Z") + minutes * 60_000).toISOString();

function remote(): TestRepo {
  const origin = createTestRepo();
  cleanups.push(() => origin.cleanup());
  origin.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  return origin;
}

function machine(origin: TestRepo, name: string, clock: { at: string }) {
  const clone = cloneTestRepo(origin);
  cleanups.push(() => clone.cleanup());
  const result = validateConfig({ project: "synthetic", machineName: name, repoPath: clone.dir, level: 2, sharedResources: [{ name: "seat", units: 1, neededBy: ["implement"] }] }, clone.dir);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const config: ProjectConfig = result.config;
  const store = openStore(":memory:");
  const make = () => createResources({
    store, config: () => config, now: () => clock.at,
    lease: (resource, unit) => createMergeQueue({ git: realGit, repo: clone.dir, remote: "origin", machine: name, ref: unitRef(resource, unit), doing: `holds ${resource} unit ${unit}` }),
  });
  return { store, config, resources: make(), restart: make };
}

describe("shared resources", { concurrency: 2 }, () => {
  test("a unit another machine holds on the remote makes this one wait, until it is given back", async () => {
    const origin = remote();
    const clock = { at: T(0) };
    const a = machine(origin, "laptop-a", clock);
    const b = machine(origin, "laptop-b", clock);
    assert.equal((await b.resources.take("fake:work:7", "implement for 7", "implement")).ok, true);
    const waits = await a.resources.take("fake:work:1", "implement for 1", "implement");
    assert.equal(waits.ok, false);
    assert.match((waits as { why: string }).why, /all 1 unit of seat is held: laptop-b \(another machine\)/);
    // The board shows the other machine as the holder, and what waits here.
    const view = resourcesView(a.config.resources ?? [], readResourceState(a.store)).resources[0]!;
    assert.deepEqual(view.held.map((each) => `${each.unit} ${each.who} ${each.elsewhere === true}`), ["1 laptop-b true"]);
    assert.deepEqual(view.waiting.map((each) => each.who), ["implement for 1"]);

    clock.at = T(5);
    await b.resources.give("fake:work:7");
    assert.equal((await a.resources.take("fake:work:1", "implement for 1", "implement")).ok, true);
    assert.equal((await b.resources.take("fake:work:8", "implement for 8", "implement")).ok, false);
    // Every take and give is one commit on the unit's ref; none was rewritten.
    const log = origin.git(["log", "--format=%B", unitRef("seat", 1)]).split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { kind: string; holder: string });
    assert.deepEqual(log.map((line) => `${line.kind} ${line.holder}`), ["lease laptop-a", "release laptop-b", "lease laptop-b"]);
  });

  test("a machine that crashed while it held a unit gives it back when it starts again", async () => {
    const origin = remote();
    const clock = { at: T(0) };
    const a = machine(origin, "laptop-a", clock);
    const b = machine(origin, "laptop-b", clock);
    assert.equal((await b.resources.take("fake:work:7", "implement for 7", "implement")).ok, true);
    assert.equal((await a.resources.take("fake:work:1", "implement for 1", "implement")).ok, false);
    // laptop-b's Scope Soup dies without giving the unit back, and starts again.
    clock.at = T(10);
    await b.restart().recover();
    assert.equal((await a.resources.take("fake:work:1", "implement for 1", "implement")).ok, true);
  });
});
