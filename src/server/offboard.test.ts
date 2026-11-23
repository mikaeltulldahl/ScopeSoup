// `GET /api/offboard` gives the Settings page's "Stop using Scope Soup" the offboarding plan, read only. Synthetic data.

import assert from "node:assert/strict";
import { test } from "node:test";
import { offboardPlan } from "../offboard/plan.ts";
import { openStore } from "../store/store.ts";
import { demoFound } from "./demo.ts";
import { createServer } from "./server.ts";

async function get(options: Parameters<typeof createServer>[0]): Promise<Record<string, unknown>> {
  const server = createServer({ ...options, port: 0 });
  const { url } = await server.start();
  try {
    const response = await fetch(`${url}/api/offboard`);
    assert.equal(response.status, 200);
    return (await response.json()) as Record<string, unknown>;
  } finally {
    await server.stop();
  }
}

test("the offboarding plan is served as the server's option makes it; without a project there is none", async () => {
  const store = openStore(":memory:");
  try {
    const plan = offboardPlan(demoFound("/x/tidepool-scopesoup"));
    const view = await get({ store, offboard: async () => ({ now: "2026-11-23T10:00:00.000Z", available: true, plan, configFolder: "/x/tidepool-scopesoup", outFolder: "/x/tidepool-scopesoup-offboard" }) });
    assert.equal(view.available, true);
    assert.deepEqual((view.plan as typeof plan).groups.map((group) => group.group), ["work", "items", "github", "project", "machine"]);
    const none = await get({ store });
    assert.equal(none.available, false);
    const broken = await get({ store, offboard: async () => { throw new Error("git is not there"); } });
    assert.match(String(broken.reason), /git is not there/);
  } finally {
    store.close();
  }
});
