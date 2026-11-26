import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogRecord } from "../model/types.ts";
import { buildRounds, parseFinding } from "./rounds.ts";
import { at, ref, session } from "./testing.ts";

const SCOPESOUP = { who: "scopesoup", agent: true };
const line = (minute: number, kind: string, fields: Record<string, unknown>): LogRecord => ({ at: at(minute), by: SCOPESOUP, kind, fields });
const sha = (digit: string): string => digit.repeat(40);
const item = ref("work", 7);

/** A recorded cycle at level 3: triage, then three rounds of implement and review, and the review limit. As `cycle.ts` writes it. */
function escalatedCycle(): LogRecord[] {
  return [
    line(0, "created", {}),
    line(3, "session", { role: "triage", model: "haiku", outcome: "succeeded", summary: "Ready, small.", ready: true, size: "small", next: "implement", durationMs: 180_000, costUsd: 0.04, sessionId: "s1" }),
    line(20, "revision", { sha: sha("a"), branch: "scopesoup/7" }),
    line(20, "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Added the sunrise row.", durationMs: 900_000, costUsd: 0.62, sessionId: "s2", next: "review" }),
    line(26, "review", { sha: sha("a"), verdict: "fail", findings: ["[must] src/day/SunRow.tsx: The sunset time is in UTC."], model: "opus" }),
    line(26, "session", { role: "review", model: "opus", outcome: "succeeded", summary: "changes, 1 finding(s)", durationMs: 300_000, costUsd: 0.9, sessionId: "s3", next: "implement" }),
    line(34, "revision", { sha: sha("b"), branch: "scopesoup/7" }),
    line(34, "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Shows the sunset in the harbour's time zone.", durationMs: 420_000, costUsd: 0.21, sessionId: "s4", next: "review" }),
    line(40, "review", { sha: sha("b"), verdict: "fail", findings: ["[must] The day with no sunset shows 00:00.", "[should] Name the helper after what it returns."], model: "opus" }),
    line(40, "session", { role: "review", model: "opus", outcome: "succeeded", summary: "changes, 2 finding(s)", durationMs: 240_000, costUsd: 0.7, sessionId: "s5", next: "implement" }),
    line(47, "revision", { sha: sha("c"), branch: "scopesoup/7" }),
    line(47, "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Hides the sunset on polar days.", durationMs: 300_000, costUsd: 0.18, sessionId: "s6", next: "review" }),
    line(52, "review", { sha: sha("c"), verdict: "fail", findings: ["[must] The polar-day test asserts nothing."], model: "opus" }),
    line(52, "question", { question: "The review still asks for changes after 2 round(s) back to the implementor; the limit is 2. Open findings: The polar-day test asserts nothing.", options: [], parked: "escalated" }),
    line(52, "session", { role: "review", model: "opus", outcome: "succeeded", summary: "changes, 1 finding(s)", durationMs: 200_000, costUsd: 0.5, sessionId: "s7" }),
  ];
}

describe("the Rounds rows", { concurrency: 4 }, () => {
  test("a proposed restructuring is said in words, whatever the number of parts", () => {
    const proposed = (proposal: Record<string, unknown>) => buildRounds({ log: [
      line(0, "question", { question: "Triage proposes to restructure the Item.", parked: "needs-decision", proposal }),
      line(0, "session", { role: "triage", model: "haiku", outcome: "succeeded", ready: true, sessionId: "s1" }),
    ] })[0]!.found;
    assert.equal(proposed({ original: "replaced", parts: [{ title: "T", goes: "into", into: "A-18" }] }), "Proposes a restructuring: 1 into A-18; the Item is closed as replaced.");
    assert.equal(proposed({ original: "replaced", parts: [] }), "Proposes a restructuring: no other part; the Item is closed as replaced.");
  });

  test("a cycle that escalates at the round limit: one row per step, the findings with their severity, and why it escalated", () => {
    const rows = buildRounds({ log: escalatedCycle() });
    assert.deepEqual(rows.map((row) => [row.step, row.model ?? null]), [
      ["triage", "haiku"],
      ["implement", "sonnet"],
      ["review", "opus"],
      ["implement", "sonnet"],
      ["review", "opus"],
      ["implement", "sonnet"],
      ["review", "opus"],
      ["escalated", null],
    ]);
    assert.equal(rows[0]!.found, "Ready, small.");
    assert.deepEqual(rows[1]!.commits, [sha("a")]);
    assert.equal(rows[1]!.did, "Added the sunrise row.");
    assert.equal(rows[1]!.resumed, undefined);
    assert.deepEqual(rows[2]!.findings, [{ severity: "must", text: "src/day/SunRow.tsx: The sunset time is in UTC." }]);
    assert.equal(rows[2]!.found, "Asks for changes: 1 must.");
    assert.equal(rows[3]!.resumed, "with the review's findings");
    assert.equal(rows[3]!.round, 2);
    assert.deepEqual(rows[3]!.commits, [sha("b")]);
    assert.deepEqual(rows[4]!.findings, [{ severity: "must", text: "The day with no sunset shows 00:00." }, { severity: "should", text: "Name the helper after what it returns." }]);
    assert.equal(rows[4]!.found, "Asks for changes: 1 must, 1 should.");
    assert.deepEqual(rows[5]!.commits, [sha("c")]);
    assert.equal(rows[6]!.round, 3);
    assert.deepEqual(rows.map((row) => row.durationMs ?? null), [180_000, 900_000, 300_000, 420_000, 240_000, 300_000, 200_000, null]);
    assert.deepEqual(rows.map((row) => row.costUsd ?? null), [0.04, 0.62, 0.9, 0.21, 0.7, 0.18, 0.5, null]);
    assert.deepEqual(rows.map((row) => row.session ?? null), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", null]);
    const last = rows[rows.length - 1]!;
    assert.equal(last.kind, "end");
    assert.equal(last.tone, "bad");
    assert.match(last.found ?? "", /limit is 2/);
    // The escalation is the outcome, not something the last review found.
    assert.doesNotMatch(rows[6]!.found ?? "", /limit/);
  });

  test("the store's parked state names the outcome, and the store's sessions give the cost and the chat a line from earlier lacks", () => {
    const log = escalatedCycle().map((each) => {
      if (each.kind !== "session") return each;
      const { costUsd: _cost, sessionId: _id, ...fields } = each.fields;
      return { ...each, fields };
    });
    const sessions = [session("old-2", item, { role: "implement", status: "succeeded", model: "sonnet", startedAt: at(5), finishedAt: at(20), costUsd: 0.6, agentSessionId: "agent-i" })];
    const rows = buildRounds({ log, sessions, parked: { as: "escalated", reason: "The review still asks for changes.", at: at(52) } });
    assert.equal(rows[1]!.costUsd, 0.6);
    assert.equal(rows[1]!.session, "old-2");
    assert.equal(rows[1]!.agentSession, "agent-i");
    assert.equal(rows[2]!.costUsd, undefined);
    assert.equal(rows[rows.length - 1]!.found, "The review still asks for changes.");
  });

  test("a level 4 cycle whose batch is red once: the check row, the implementor resumed with it, then green and merged", () => {
    const log = [
      line(3, "session", { role: "triage", model: "haiku", outcome: "succeeded", summary: "Ready, small.", ready: true, size: "small", next: "implement", durationMs: 120_000, sessionId: "s1" }),
      line(20, "revision", { sha: sha("a"), branch: "scopesoup/7" }),
      line(20, "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Added the row.", durationMs: 600_000, sessionId: "s2", next: "review" }),
      line(25, "review", { sha: sha("a"), verdict: "pass", findings: [], model: "opus" }),
      line(25, "session", { role: "review", model: "opus", outcome: "succeeded", summary: "approve, 0 finding(s)", durationMs: 200_000, sessionId: "s3" }),
      line(40, "check", { sha: sha("a"), verdict: "fail", command: "pnpm run check", findings: ["FAIL src/day/sun.test.ts: expected 06:12, got 05:12"], batch: 3 }),
      line(52, "revision", { sha: sha("b"), branch: "scopesoup/7" }),
      line(52, "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Fixed the summer-time offset.", durationMs: 300_000, sessionId: "s4", next: "review" }),
      line(56, "review", { sha: sha("b"), verdict: "pass", findings: [], model: "opus" }),
      line(56, "session", { role: "review", model: "opus", outcome: "succeeded", summary: "approve, 0 finding(s)", durationMs: 150_000, sessionId: "s5" }),
      line(70, "revision", { sha: sha("d"), branch: "scopesoup/7" }),
      line(70, "check", { sha: sha("d"), verdict: "pass", command: "pnpm run check", batch: 4 }),
      line(70, "merged", { sha: sha("d"), target: "main", batch: 4 }),
    ];
    const rows = buildRounds({ log, parked: { as: "queued", reason: "Merged on main as ddddddd in batch 4.", at: at(70) } });
    assert.deepEqual(rows.map((row) => row.step), ["triage", "implement", "review", "check", "implement", "review", "check", "merged"]);
    assert.equal(rows[2]!.found, "Approves.");
    assert.equal(rows[3]!.kind, "check");
    assert.equal(rows[3]!.model, "pnpm run check");
    assert.equal(rows[3]!.tone, "bad");
    assert.deepEqual(rows[3]!.findings, [{ text: "FAIL src/day/sun.test.ts: expected 06:12, got 05:12" }]);
    assert.equal(rows[4]!.resumed, "with the failing check");
    assert.deepEqual(rows[4]!.commits, [sha("b")]);
    assert.equal(rows[6]!.found, "Passed in batch 4.");
    const last = rows[rows.length - 1]!;
    assert.equal(last.kind, "end");
    assert.equal(last.found, `Merged on main as ${sha("d").slice(0, 7)} in batch 4.`);
    assert.equal(rows.filter((row) => row.kind === "end").length, 1);
  });

  test("levels 2 and 3: merged by the implementor, resumed to merge it after the review approved", () => {
    const log = [
      line(20, "revision", { sha: sha("a") }),
      line(20, "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Done.", sessionId: "s2", next: "review" }),
      line(25, "review", { sha: sha("a"), verdict: "pass", findings: ["[should] A shorter name."], model: "opus" }),
      line(25, "session", { role: "review", model: "opus", outcome: "succeeded", summary: "approve, 1 finding(s)", sessionId: "s3", next: "implement" }),
      line(30, "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Merged.", sessionId: "s4" }),
      line(30, "merged", { sha: sha("a"), target: "main" }),
    ];
    const rows = buildRounds({ log });
    assert.deepEqual(rows.map((row) => row.step), ["implement", "review", "implement", "merged"]);
    assert.equal(rows[1]!.found, "Approves, with 1 suggestion.");
    assert.equal(rows[2]!.resumed, "to merge it");
    assert.match(rows[3]!.found ?? "", /^Merged to main as aaaaaaa/);
  });

  test("a rewrite's parked line already counts its questions, so no second count is put before it", () => {
    const reason = "Triage, round 1: a rewrite of the description and 2 questions wait for an answer: 1. A? 2. B?";
    const log = [
      line(1, "question", { question: reason, options: [], parked: "needs-decision" }),
      line(1, "session", { role: "triage", model: "haiku", outcome: "succeeded", summary: "x", size: "medium", sessionId: "s1" }),
    ];
    assert.equal(buildRounds({ log })[0]!.found, `Ready, medium. ${reason}`);
  });

  test("a triage that asks questions, a failed session, a live one", () => {
    const log = [
      line(1, "question", { question: "Which datum?", options: ["A", "B"], parked: "needs-decision" }),
      line(1, "session", { role: "triage", model: "haiku", outcome: "succeeded", summary: "Ready, small. 1 question for a person.", size: "small", sessionId: "s1" }),
      line(5, "answer", { answer: "A", to: at(1) }),
      line(9, "session", { role: "implement", model: "sonnet", outcome: "failed", summary: "turn limit reached", sessionId: "s2" }),
    ];
    const live = session("s3", item, { role: "implement", model: "sonnet", startedAt: at(10), lastAction: "running the tests", agentSessionId: "agent-3" });
    const rows = buildRounds({ log, sessions: [live] });
    assert.equal(rows[0]!.found, "Ready, small. One question for you: Which datum?");
    assert.equal(rows[0]!.tone, "wait");
    assert.equal(rows[1]!.outcome, "failed");
    assert.equal(rows[1]!.found, "The session failed: turn limit reached");
    assert.equal(rows[2]!.live, true);
    assert.equal(rows[2]!.found, "Now: running the tests");
    assert.equal(rows[2]!.agentSession, "agent-3");
    assert.equal(rows.length, 3);
  });

  test("parseFinding reads the severity mark the review line writes", () => {
    assert.deepEqual(parseFinding("[should] a.ts: shorter"), { severity: "should", text: "a.ts: shorter" });
    assert.deepEqual(parseFinding("no mark"), { text: "no mark" });
  });
});
