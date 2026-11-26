// Limited resources with a synthetic resource of 1 unit: counting, waiting, giving back, the tick and the board.
// In memory: no process, no git. The shared resource across machines is in resources.slow.test.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fixedConfig } from "../config/loader.ts";
import type { ProjectConfig } from "../config/types.ts";
import { validateConfig } from "../config/validate.ts";
import type { Ref, Session, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import { setRolesForTest } from "../store/control.ts";
import { dryActions } from "./ports.ts";
import type { AgentRunner, SessionRequest } from "./ports.ts";
import { CHECK_HOLDER, createResources, readResourceState, resourcesView } from "./resources.ts";
import { tick } from "./tick.ts";

const T0 = Date.parse("2026-11-18T10:00:00.000Z");

function config(raw: Record<string, unknown> = {}): ProjectConfig {
  const result = validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", level: 2, ...raw }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

const RIG = { name: "rig", units: 1, neededBy: ["triage"], env: { RIG_PORT: "55{{unit}}0" } };

function ref(id: string): Ref {
  return { host: "fake", kind: "work", id };
}

function item(id: string, labels: string[] = []): WorkItem {
  return { ref: ref(id), title: `Item ${id}`, state: "todo", hostState: "open", labels, blockedBy: [], openChildren: 0, updatedAt: `2026-11-0${id}T00:00:00Z` };
}

describe("resources", { concurrency: 4 }, () => {
  test("one unit: the second holder waits until the first gives it back; the unit's variables are filled in", async () => {
    const store = openStore(":memory:");
    const cfg = config({ resources: [{ ...RIG, neededBy: ["implement", "check"] }] });
    const resources = createResources({ store, config: () => cfg, now: () => "2026-11-18T10:00:00.000Z" });
    assert.deepEqual(await resources.take("fake:work:1", "implement for 1", "implement"), { ok: true, env: { RIG_PORT: "5510" } });
    // Work that does not need it is not held back.
    assert.deepEqual(await resources.take("fake:work:3", "review for 3", "review"), { ok: true, env: {} });
    const waits = await resources.take(CHECK_HOLDER, "the check of batch 1", "check");
    assert.deepEqual(waits, { ok: false, why: "all 1 unit of rig is held: implement for 1", resource: "rig", first: true });
    assert.equal((await resources.take(CHECK_HOLDER, "the check of batch 1", "check") as { first: boolean }).first, false);
    // A session's wait is said again by every dispatch; the check's stays.
    await resources.take("fake:work:2", "implement for 2", "implement");
    resources.clearSessionWaits();
    assert.deepEqual(readResourceState(store).waiting.map((each) => each.holder), [CHECK_HOLDER]);
    await resources.give("fake:work:1");
    assert.equal((await resources.take(CHECK_HOLDER, "the check of batch 1", "check")).ok, true);
    assert.deepEqual(readResourceState(store), { held: [{ resource: "rig", unit: 1, holder: CHECK_HOLDER, label: "the check of batch 1", since: "2026-11-18T10:00:00.000Z" }], waiting: [], elsewhere: [] });
    // At start, what an earlier run held is given back.
    await createResources({ store, config: () => cfg, now: () => "2026-11-18T11:00:00.000Z" }).recover();
    assert.deepEqual(readResourceState(store).held, []);
  });

  test("all or none: a unit taken for a start goes back when another resource it needs has none free", async () => {
    const store = openStore(":memory:");
    const cfg = config({ resources: [{ name: "seat", units: 2, neededBy: ["implement"] }, { name: "phone", units: 1, neededBy: ["implement"] }] });
    const resources = createResources({ store, config: () => cfg, now: () => "2026-11-18T10:00:00.000Z" });
    assert.equal((await resources.take("a", "implement for a", "implement")).ok, true);
    const second = await resources.take("b", "implement for b", "implement");
    assert.equal(second.ok, false);
    assert.equal((second as { resource: string }).resource, "phone");
    assert.deepEqual(readResourceState(store).held.map((each) => `${each.resource}${each.unit} ${each.holder}`), ["seat1 a", "phone1 a"]);
  });

  test("the board shows who holds each unit and what waits for one", async () => {
    const store = openStore(":memory:");
    const cfg = config({ resources: [RIG], sharedResources: [{ name: "seat", units: 2, neededBy: ["review"] }] });
    const resources = createResources({ store, config: () => cfg, now: () => "2026-11-18T10:00:00.000Z" });
    await resources.take("fake:work:1", "triage for 1", "triage");
    await resources.take("fake:work:2", "triage for 2", "triage");
    assert.deepEqual(resourcesView(cfg.resources ?? [], readResourceState(store)), {
      resources: [
        { name: "rig", units: 1, shared: false, neededBy: ["triage"], held: [{ unit: 1, who: "triage for 1", since: "2026-11-18T10:00:00.000Z" }], waiting: [{ who: "triage for 2", since: "2026-11-18T10:00:00.000Z" }] },
        { name: "seat", units: 2, shared: true, neededBy: ["review"], held: [], waiting: [] },
      ],
    });
  });

  test("the tick: two triages that need the rig run one after the other, while an implement that does not need it starts", async () => {
    const store = openStore(":memory:");
    setRolesForTest(store, "started");
    // A usage reading well within the budget, so the budget lets several sessions start.
    store.addUsageSample({
      at: new Date(T0).toISOString(), status: "allowed",
      windows: [{ kind: "five_hour", utilization: 0.1, resetsAt: new Date(T0 + 2 * 3600_000).toISOString() }, { kind: "seven_day", utilization: 0.1, resetsAt: new Date(T0 + 3.5 * 24 * 3600_000).toISOString() }],
    });
    const clock = { ms: T0 };
    const now = () => new Date(clock.ms).toISOString();
    // Items 1 and 2 have no triage yet; item 3 states its size, so it skips the triage and goes to implement.
    for (const each of [item("1"), item("2"), item("3", ["size:small"])]) store.put(each, "sync", now());
    const cfg = config({ resources: [RIG], settings: { maxParallelSessions: { value: 3 } } });
    const requests: SessionRequest[] = [];
    const sessions = new Map<string, Session>();
    let count = 0;
    const runner: AgentRunner = {
      async start(request) {
        const session: Session = { ref: { host: "scopesoup", kind: "session", id: `s${++count}` }, role: request.role, subject: request.subject, status: "running", attempt: request.attempt, startedAt: now() };
        requests.push(request);
        sessions.set(request.subject.id, session);
        store.put(session, "orchestrator", now());
        return session;
      },
      async reconcile() {},
      stopAll: () => 0,
      running: () => [...sessions.values()].filter((each) => each.status === "running").length,
      async takeWorkspace() {
        return null;
      },
      async releaseWorkspace() {},
      async deleteBranch() {},
      async changedPaths() {
        return [];
      },
      async head() {
        return "3".repeat(40);
      },
      async fetchMain() {
        return { repo: "/srv/clone", main: "1".repeat(40) };
      },
      async contains() {
        return false;
      },
    };
    const resources = createResources({ store, config: () => cfg, now });
    const run = () => tick({ store, runner, config: fixedConfig(cfg), actions: dryActions, now, resources });

    await run();
    const started = () => requests.map((request) => `${request.role} ${request.subject.id}`);
    assert.deepEqual(started(), ["triage 1", "implement 3"]);
    assert.equal(requests[0]?.env?.RIG_PORT, "5510");
    assert.equal(requests[1]?.env, undefined);
    assert.deepEqual(resourcesView(cfg.resources ?? [], readResourceState(store)).resources[0]?.waiting.map((each) => each.who), ["triage for 2"]);
    const waits = store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.resource_wait");
    assert.match((waits[0]?.data as { reason: string }).reason, /triage for 2 "Item 2" waits: all 1 unit of rig is held: triage for 1/);

    // Item 1's triage ends: the runner gives its unit back (as the real runner does, however it ended), and item 2's starts.
    const first = sessions.get("1")!;
    const over: Session = { ...first, status: "failed", finishedAt: now(), endReason: "crashed" };
    sessions.set("1", over);
    store.put(over, "orchestrator", now());
    await resources.give(refKey(ref("1")));
    clock.ms += 60_000;
    await run();
    assert.deepEqual(started().slice(2), ["triage 2"]);
    assert.deepEqual(readResourceState(store).held.map((each) => each.holder), [refKey(ref("2"))]);
    assert.deepEqual(readResourceState(store).waiting, []);
  });
});

