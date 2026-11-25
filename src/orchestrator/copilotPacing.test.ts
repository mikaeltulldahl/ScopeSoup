import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import type { ProjectConfig } from "../config/types.ts";
import { ref, session } from "../core/testing.ts";
import type { UsageSample } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import { sessionResultKey } from "./runner.ts";
import { copilotPlan, usageDecision } from "./tick.ts";

const NOW = "2026-11-25T12:00:00.000Z";

function config(raw: Record<string, unknown> = {}): ProjectConfig {
  const result = validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", level: 2, ...raw }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

/** A Claude reading that has the 5-hour window full: it stops Claude roles and must not touch Copilot ones. */
const FULL: UsageSample = { at: "2026-11-25T11:59:00.000Z", status: "allowed", windows: [{ kind: "five_hour", utilization: 0.99, resetsAt: "2026-11-25T15:00:00.000Z" }] };

function used(store: ReturnType<typeof openStore>, id: number, role: "triage" | "implement", requests: number, startedAt: string, provider = "copilot") {
  store.put(session(id, ref("work", id), { role, provider, status: "succeeded", startedAt, finishedAt: startedAt }), "test", startedAt);
  store.setValue(sessionResultKey(String(id)), JSON.stringify({ premiumRequests: requests }));
}

test("a Copilot role is paced by the month's premium requests, a Claude role by Claude's windows", () => {
  const store = openStore(":memory:");
  const c = config({ roles: { triage: { provider: "copilot" } }, copilot: { monthlyRequests: 100, resetDay: 1 } });
  store.addUsageSample(FULL);
  used(store, 1, "triage", 50, "2026-11-10T10:00:00.000Z");
  used(store, 2, "triage", 500, "2026-10-30T10:00:00.000Z");
  // Claude's window is full, so the implement role waits; the Copilot triage is within its budget (50 of 100, reserve 20 %).
  assert.equal(usageDecision(store, c, "implement", NOW, 0).allow, false);
  assert.equal(usageDecision(store, c, "triage", NOW, 0).allow, true);
  // The month's use reaches the limit: Copilot waits for the reset, Claude's reading is not involved.
  used(store, 3, "triage", 30, "2026-11-20T10:00:00.000Z");
  const stop = usageDecision(store, c, "triage", NOW, 0);
  assert.equal(stop.allow, false);
  assert.equal(stop.resumeAt, "2026-12-01T00:00:00.000Z");
  store.close();
});

test("Copilot use does not pace a Claude role, and without an allowance Copilot is not paced", () => {
  const store = openStore(":memory:");
  used(store, 1, "implement", 900, "2026-11-10T10:00:00.000Z");
  const set = config({ roles: { triage: { provider: "copilot" } }, copilot: { monthlyRequests: 100 } });
  assert.equal(usageDecision(store, set, "implement", NOW, 1).allow, false, "Claude has no reading: one probe at a time, whatever Copilot used");
  const open = config({ roles: { triage: { provider: "copilot" } } });
  assert.equal(usageDecision(store, open, "triage", NOW, 0).allow, true);
  store.close();
});

test("the Copilot plan is there only when a role runs on Copilot, and the settings are checked", () => {
  assert.equal(copilotPlan(config()), undefined);
  assert.deepEqual(copilotPlan(config({ roles: { review: { provider: "copilot" } }, copilot: { monthlyRequests: 300, resetDay: 9 } })), { allowance: 300, resetDay: 9, reserve: 0.2 });
  assert.deepEqual(copilotPlan(config({ roles: { review: { provider: "copilot" } } })), { resetDay: 1, reserve: 0.2 });
  for (const bad of [{ monthlyRequests: 0 }, { monthlyRequests: 1.5 }, { resetDay: 29 }, { resetDay: 0 }, { other: 1 }]) {
    assert.equal(validateConfig({ project: "synthetic", machineName: "laptop-a", repoPath: "/srv/clone", level: 2, copilot: bad }, "/srv/scopesoup").ok, false, JSON.stringify(bad));
  }
});
