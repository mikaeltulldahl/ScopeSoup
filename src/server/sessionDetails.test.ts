import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ref, session } from "../core/testing.ts";
import { openStore } from "../store/store.ts";
import { sessionDetails, toolsFromStream } from "./sessionDetails.ts";

const tool = (name: string, input: Record<string, unknown>) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

test("the tools a stream called, most used first, and each call in words", () => {
  const stream = [
    tool("Read", { file_path: "/work/src/a.ts" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking." }] } }),
    tool("Bash", { command: "pnpm test" }),
    "not json",
    tool("Read", { file_path: "/work/src/b.ts" }),
  ].join("\n");
  const seen = toolsFromStream(stream, "/work");
  assert.deepEqual(seen.tools, [{ name: "Read", count: 2 }, { name: "Bash", count: 1 }]);
  assert.deepEqual(seen.actions, ["reading src/a.ts", "running pnpm test", "reading src/b.ts"]);
  assert.equal(seen.actionsOmitted, 0);
});

test("a session's details from the store and its stream file; a missing stream or session says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-details-"));
  const store = openStore(":memory:");
  try {
    const streamPath = join(dir, "s1.ndjson");
    writeFileSync(streamPath, tool("Grep", { pattern: "sunset" }) + "\n");
    const at = "2026-11-22T10:00:00.000Z";
    store.put(session("s1", ref("work", 1), { status: "succeeded", agentSessionId: "agent-1", streamPath, finishedAt: at }), "test", at);
    store.put(session("s2", ref("work", 1), { status: "succeeded", streamPath: join(dir, "gone.ndjson"), finishedAt: at }), "test", at);
    const found = sessionDetails(store, "s1");
    assert.equal(found?.session.agentSession, "agent-1");
    assert.equal(found?.session.streamName, "s1.ndjson");
    assert.deepEqual(found?.tools, [{ name: "Grep", count: 1 }]);
    assert.equal(found?.missing, undefined);
    assert.match(sessionDetails(store, "s2")?.missing ?? "", /gone/);
    assert.equal(sessionDetails(store, "nope"), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
