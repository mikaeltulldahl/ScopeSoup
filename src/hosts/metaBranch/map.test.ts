import assert from "node:assert/strict";
import { test } from "node:test";
import { describeLine, mapItems, MAX_ECHO } from "./map.ts";
import { itemMd, jsonl } from "./testRepo.ts";

const scope = { host: "metaBranch", target: "main", fallbackTime: "2026-11-18T10:00:00.000Z" };
const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";
const robin = { who: "robin", machine: "laptop-a" };
const agent = { who: "implement", machine: "laptop-a", agent: true };

test("the history line of a question shows options as label: description, and plain text ones as they are", () => {
  const data = { kind: "question", question: "Which?", options: [{ label: "Keep", description: "less work" }, "Drop it", { label: "Wait" }], recommendation: "Keep" };
  const text = describeLine({ line: 1, at: "2026-11-18T09:00:00.000Z", by: { ...agent }, kind: "question", data, key: "k" });
  assert.equal(text, "Asked: Which? Options: Keep: less work; Drop it; Wait Recommended: Keep");
});

test("a merged newest revision makes the item done, whatever its header says", () => {
  const log = jsonl(
    { at: "2026-11-18T09:00:00Z", by: agent, kind: "revision", sha: SHA1, branch: "scopesoup/A-1" },
    { at: "2026-11-18T09:10:00Z", by: agent, kind: "merged", sha: SHA1 },
  );
  const { works, changes } = mapItems(scope, [
    { id: "A-1", itemMd: itemMd("A-1", "Merged", "todo"), log },
    { id: "A-2", itemMd: itemMd("A-2", "Child", "todo", ["parent: A-3"]), log },
    { id: "A-3", itemMd: itemMd("A-3", "Parent", "todo") },
  ]);
  assert.deepEqual(works.map((work) => [work.ref.id, work.state, work.hostState]), [["A-1", "done", "done"], ["A-2", "done", "done"], ["A-3", "todo", "todo"]]);
  assert.equal(works[2]?.openChildren, 0);
  assert.equal(changes[0]?.state, "merged");
});

test("children counts all sub-items, openChildren only the open ones", () => {
  const { works } = mapItems(scope, [
    { id: "A-1", itemMd: itemMd("A-1", "Parent", "todo") },
    { id: "A-2", itemMd: itemMd("A-2", "Open child", "todo", ["parent: A-1"]) },
    { id: "A-3", itemMd: itemMd("A-3", "Done child", "done", ["parent: A-1"]) },
    { id: "A-4", itemMd: itemMd("A-4", "Alone", "todo") },
  ]);
  assert.deepEqual([works[0]?.openChildren, works[0]?.children], [1, 2]);
  assert.equal(works[3]?.children, undefined);
});

test("a verdict on the current commit wins over a later one on an older commit", () => {
  const log = jsonl(
    { at: "2026-11-18T09:00:00Z", by: agent, kind: "revision", sha: SHA1 },
    { at: "2026-11-18T09:01:00Z", by: agent, kind: "revision", sha: SHA2 },
    { at: "2026-11-18T09:10:00Z", by: robin, kind: "review", sha: SHA2, verdict: "pass" },
    { at: "2026-11-18T09:20:00Z", by: robin, kind: "review", sha: SHA1, verdict: "fail" },
    { at: "2026-11-18T09:11:00Z", by: agent, kind: "check", sha: SHA1, verdict: "fail", command: "pnpm check" },
    { at: "2026-11-18T09:12:00Z", by: agent, kind: "check", sha: SHA2, verdict: "pass", command: "pnpm check" },
    { at: "2026-11-18T09:13:00Z", by: agent, kind: "check", sha: SHA1, verdict: "fail", command: "pnpm lint" },
  );
  const { changes } = mapItems(scope, [{ id: "A-1", itemMd: itemMd("A-1", "T", "doing"), log }]);
  assert.deepEqual(changes[0]?.verdicts.map((verdict) => [verdict.dimension, verdict.value, verdict.revision === SHA2, verdict.stale]), [
    ["review", "pass", true, false],
    ["ci", "pass", true, false],
    ["ci", "fail", false, true],
  ]);
});

test("the text echoed into hostState is capped", () => {
  const { works } = mapItems(scope, [{ id: "A-1", itemMd: `---\ntitle: T\nstate: ${"x".repeat(5000)}\n---\n` }]);
  assert.ok((works[0]?.hostState.length ?? 0) <= MAX_ECHO);
  assert.match(works[0]?.hostState ?? "", /^malformed: the state "x+/);
});

test("an unread file is malformed for its item only", () => {
  const { works, report } = mapItems(scope, [
    { id: "A-1", itemMdProblem: "item.md is 9 bytes, over the limit of 5; not read" },
    { id: "A-2", itemMd: itemMd("A-2", "Fine", "todo"), logProblem: "log.jsonl is 9 bytes, over the limit of 5; not read" },
  ]);
  assert.match(works[0]?.hostState ?? "", /over the limit/);
  assert.equal(works[1]?.state, "todo");
  assert.deepEqual([report.malformedItems, report.malformedLines], [["A-1"], 1]);
});
