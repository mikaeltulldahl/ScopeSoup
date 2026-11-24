// The overview's lane switches (web/src/switches.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { allPaused, laneMutedBy, laneSwitch, switchesAt, switchPath } from "../web/src/switches.ts";

test("each switch sits on its lane, and is hidden below the level that uses its role", () => {
  assert.deepEqual(switchesAt(undefined), [], "no project configuration: no switches");
  assert.deepEqual(switchesAt(0), []);
  assert.deepEqual(switchesAt(1), ["triage"]);
  assert.deepEqual(switchesAt(2), ["triage", "implement"]);
  assert.deepEqual(switchesAt(3), ["triage", "implement", "review"]);
  assert.deepEqual(switchesAt(4), ["triage", "implement", "review", "mergeQueue"]);
  assert.equal(laneSwitch("backlog", 4), "triage");
  assert.equal(laneSwitch("in-progress", 4), "implement");
  assert.equal(laneSwitch("in-review", 4), "review");
  assert.equal(laneSwitch("queued", 4), "mergeQueue");
  assert.equal(laneSwitch("checking", 4), null, "Checking has no button of its own");
  assert.equal(laneMutedBy("checking", 4), "mergeQueue", "but shows the merge queue paused");
  assert.equal(laneSwitch("in-review", 2), null, "no review switch below level 3");
  assert.equal(laneSwitch("queued", 3), null, "no merge queue switch below level 4");
  assert.equal(laneMutedBy("checking", 3), null);
  assert.equal(laneSwitch("done", 4), null);
});

test("the button pauses a running switch and resumes a paused or stopped one", () => {
  assert.equal(switchPath("triage", "started"), "/api/triage/pause");
  assert.equal(switchPath("review", "paused"), "/api/review/start");
  assert.equal(switchPath("mergeQueue", "stopped"), "/api/merge-queue/start");
});

test("the banner is shown only when every switch shown at the level is paused", () => {
  const all = { triage: "paused", implement: "paused", review: "paused", mergeQueue: "paused" } as const;
  assert.equal(allPaused(all, 4), true);
  assert.equal(allPaused({ ...all, review: "started" }, 4), false);
  // At level 2 the review and merge queue switches are not shown, so they do not keep the banner away.
  assert.equal(allPaused({ ...all, review: "started", mergeQueue: "started" }, 2), true);
  assert.equal(allPaused({ ...all, implement: "started" }, 2), false);
  assert.equal(allPaused(all, 0), false, "level 0 starts nothing anyway");
  assert.equal(allPaused(all, undefined), false);
});
