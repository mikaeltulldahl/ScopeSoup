import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { streamTokens } from "./usage.ts";

const result = (input: number) => `{"type":"system"}\n{"type":"result","usage":{"input_tokens":${input},"output_tokens":5}}\n`;

test("a stream's tokens are read again once the stream changes, and a missing stream has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-usage-"));
  try {
    const path = join(dir, "stream.jsonl");
    writeFileSync(path, result(10));
    assert.equal(streamTokens(path, "claude"), 15);
    assert.equal(streamTokens(path, "claude"), 15);
    writeFileSync(path, result(1000));
    assert.equal(streamTokens(path, "claude"), 1005);
    assert.equal(streamTokens(join(dir, "absent.jsonl"), "claude"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
