// The board shows each limited resource, who holds its units and what waits for one; nothing without resources.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResourceConfig } from "../config/types.ts";
import type { BoardView } from "../core/views.ts";
import { T0 } from "../core/testing.ts";
import { createResources } from "../orchestrator/resources.ts";
import { openStore } from "../store/store.ts";
import { createServer } from "./server.ts";

test("the board shows who holds the unit and what waits for it", async () => {
  const store = openStore(":memory:");
  let resources: ResourceConfig[] = [{ name: "rig", units: 1, shared: false, neededBy: ["implement"], env: {} }];
  const units = createResources({ store, config: () => ({ resources }) as never, now: () => new Date(T0).toISOString() });
  await units.take("fake:work:1", "implement for 1", "implement");
  await units.take("fake:work:2", "implement for 2", "implement");
  const server = createServer({ store, now: () => new Date(T0), port: 0, planning: () => ({ bugLabels: ["bug"], resources }) });
  const base = (await server.start()).url;
  try {
    const board = async () => (await (await fetch(`${base}/api/board`)).json()) as BoardView;
    assert.deepEqual((await board()).resources, {
      resources: [{ name: "rig", units: 1, shared: false, neededBy: ["implement"], held: [{ unit: 1, who: "implement for 1", since: new Date(T0).toISOString() }], waiting: [{ who: "implement for 2", since: new Date(T0).toISOString() }] }],
    });
    resources = [];
    assert.equal((await board()).resources, undefined);
  } finally {
    await server.stop();
    store.close();
  }
});
