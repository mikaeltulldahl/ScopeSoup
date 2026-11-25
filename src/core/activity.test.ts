import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRecord, ScopeSoupEvent } from "../model/types.ts";
import { ACTIVITY_EVENTS, buildActivity, duration, foldSessions, type ActivityInput } from "./activity.ts";
import { at, batch, change, member, ref, session, T0, work } from "./testing.ts";

const SOUP = { who: "scopesoup", machine: "laptop-a", agent: true };
const MIRA = { who: "mira", machine: "laptop-a", agent: false };
const line = (minutes: number, by: LogRecord["by"], kind: string, fields: Record<string, unknown> = {}): LogRecord => ({ at: at(minutes), by, kind, fields });
let seq = 0;
const event = (minutes: number, kind: string, actor: string, data: unknown = {}, subject?: string): ScopeSoupEvent => ({ seq: ++seq, at: at(minutes), kind, actor, data, ...(subject ? { subject } : {}) });
const input = (over: Partial<ActivityInput>): ActivityInput => ({ works: [], changes: [], sessions: [], batches: [], events: [], settings: [], ...over });

test("an Item's log gives created, the accepted draft, questions and answers, holds and the merge, linked to the Item", () => {
  const item = work(12, {
    title: "Tide table",
    log: [
      line(-100, MIRA, "created"),
      line(-90, SOUP, "question", { question: "Which datum?", refine: 1 }),
      line(-80, MIRA, "answer", { answer: "Lowest astronomical tide" }),
      line(-79, MIRA, "edited", { changed: "description", via: "triage, round 1", was: "old" }),
      line(-70, MIRA, "claimed", { until: at(600) }),
      line(-60, MIRA, "released", { reason: "Back to the agents." }),
      line(-10, SOUP, "merged", { sha: "abcdef1234567", target: "main" }),
      line(-9, SOUP, "review", { sha: "abcdef1", verdict: "pass" }),
    ],
  });
  const view = buildActivity(input({ works: [item] }), T0);
  assert.deepEqual(view.rows.map((row) => [row.kind, row.who, row.text]), [
    ["merge", "Scope Soup", "Merged abcdef1 to main, by the implementor"],
    ["item", "mira", "Let the Item go"],
    ["item", "mira", "Took the Item"],
    ["triage", "mira", "Accepted the triage's draft (round 1)"],
    ["question", "mira", "Answered: Lowest astronomical tide"],
    ["question", "Scope Soup", "The triage's draft (round 1) asks: Which datum?"],
    ["item", "mira", "Created the Item"],
  ]);
  assert.deepEqual(view.rows[0]!.items, [{ key: "demo:work:12", id: "12", title: "Tide table" }]);
  assert.equal(view.rows[1]!.detail, "Back to the agents.");
  assert.equal(view.more, false);
});

test("sessions: this machine's with model, outcome, time and cost; the log's from other machines; none twice", () => {
  const subject = ref("work", 5);
  const item = work(5, {
    log: [
      // Run on another machine: only the log has it.
      line(-300, { who: "scopesoup", machine: "laptop-b", agent: true }, "session", { role: "triage", model: "opus", outcome: "succeeded", summary: "Ready, small.", durationMs: 240_000, costUsd: 0.31 }),
      // The stored session s-1 below, found by its id.
      line(-100, SOUP, "session", { role: "implement", model: "sonnet", outcome: "succeeded", summary: "Added the row.", durationMs: 35 * 60_000, costUsd: 1.42, sessionId: "s-1" }),
      // The stored session s-2, found by role and end time.
      line(-50, SOUP, "session", { role: "review", model: "opus", outcome: "failed", durationMs: 60_000 }),
    ],
  });
  const sessions = [
    session("s-1", subject, { model: "sonnet", status: "succeeded", startedAt: at(-135), finishedAt: at(-100), costUsd: 1.42 }),
    session("s-2", subject, { role: "review", model: "opus", status: "failed", startedAt: at(-51), finishedAt: at(-50.5) }),
    session("s-3", subject, { model: "haiku", status: "failed", endReason: "turn limit reached", startedAt: at(-30), finishedAt: at(-10), costUsd: 0.5 }),
    session("s-4", subject, { model: "opus", status: "running", startedAt: at(-5), costUsd: 0.2 }),
    session("s-5", ref("work", 404), { role: "triage", model: "haiku", status: "cancelled", startedAt: at(-400), finishedAt: at(-400) }),
  ];
  const rows = buildActivity(input({ works: [item], sessions }), T0).rows.filter((row) => row.kind === "session");
  assert.deepEqual(rows.map((row) => [row.who, row.text, row.tone ?? ""]), [
    ["implementor", "Session (Opus) started, $0.20 so far", ""],
    ["implementor", "Session (Haiku) failed: turn limit reached in 20 min, $0.50", "bad"],
    ["reviewer", "Session (Opus) failed in 1 min", "bad"],
    ["implementor", "Session (Sonnet) done in 35 min, $1.42", ""],
    ["triage", "Session (Opus) done in 4 min, $0.31", ""],
    ["triage", "Session (Haiku) cancelled", ""],
  ]);
  // An Item this machine does not know is named, not linked.
  assert.deepEqual(rows.at(-1)!.items, [{ key: "demo:work:404", id: "404", gone: true }]);
  assert.equal(rows[3]!.detail, "Added the row.");
});

test("batches: merged with their Items, failed naming the Item that broke it", () => {
  const changes = [change(130, [30]), change(161, [61]), change(168, [68])];
  const works = [work(30), work(61, { title: "Metres" }), work(68)];
  const batches = [
    batch(4, [member(130, "merged")], { status: "merged", finishedAt: at(-60) }),
    batch(3, [member(130, "merged"), member(161, "culprit"), member(168, "requeued")], { status: "failed", finishedAt: at(-30), note: "The browser suite failed." }),
  ];
  const rows = buildActivity(input({ works, changes, batches }), T0).rows;
  assert.deepEqual(rows.map((row) => [row.text, row.items.map((each) => each.id)]), [
    ["Batch 3 of 3 changes failed: #61 broke it; 1 merged, 1 back in the queue", ["61", "30", "68"]],
    ["Batch 4 merged 1 change", ["30"]],
  ]);
  assert.equal(rows[0]!.tone, "bad");
  assert.equal(rows[0]!.who, "merge queue");
});

test("switches pressed together are one row; upgrades, drafts rejected and settings read as words", () => {
  const events = [
    event(-200, "control.triage_started", "mira", { via: "board" }),
    event(-200, "control.implement_started", "mira", { via: "board" }),
    event(-200, "control.review_started", "mira", { via: "board" }),
    event(-100, "control.implement_paused", "main-guard", { via: "main-guard" }),
    event(-90, "control.stopped", "jonas", { via: "board" }),
    event(-80, "scopesoup.upgraded", "scopesoup", { from: "0.7.0", to: "0.8.0" }),
    event(-70, "orchestrator.draft_rejected", "ines", { round: 2 }, "demo:work:9"),
    event(-60, "config.changed", "mira", { via: "board", fields: ["settings"] }),
    // A shared save is in the settings' log: not shown twice.
    event(-50, "config.changed", "mira", { via: "board", fields: ["level"], shared: { commit: "x", changes: [] } }),
  ];
  const settings = [{ at: at(-50), who: "mira", machine: "laptop-a", changes: [{ key: "level", from: 3, to: 4 }, { key: "roles.triage.model", from: "sonnet", to: "haiku" }] }];
  const rows = buildActivity(input({ works: [work(9)], events, settings }), T0).rows;
  assert.deepEqual(rows.map((row) => [row.kind, row.who, row.text]), [
    ["settings", "mira", "Level 3 → 4; Models: triage Sonnet → Haiku"],
    ["settings", "mira", "Changed this machine's own settings: settings"],
    ["triage", "ines", "Rejected the triage's draft (round 2)"],
    ["upgrade", "scopesoup", "Upgraded Scope Soup from 0.7.0 to 0.8.0"],
    ["switch", "jonas", "Pressed Stop: every switch stopped and running sessions ended"],
    ["switch", "main-guard", "Paused the implementors"],
    ["switch", "mira", "Resumed triage, the implementors and review"],
  ]);
  assert.equal(rows.find((row) => row.who === "main-guard")!.agent, true);
  assert.equal(rows.find((row) => row.who === "main-guard")!.detail, "via main-guard");
  assert.deepEqual(rows[2]!.items.map((each) => each.id), ["9"]);
  for (const each of events) assert.ok(ACTIVITY_EVENTS.includes(each.kind), each.kind);
});

test("events an Item's log already has are not shown twice; an Item without a log takes them from the store", () => {
  const logged = work(1, { log: [line(-20, SOUP, "merged", { sha: "1111111aaaa", target: "main", batch: 4 }), line(-40, MIRA, "answer", { answer: "Yes" })] });
  const bare = work(2);
  const events = [
    event(-20, "orchestrator.merged", "orchestrator", { sha: "1111111aaaa", batch: 4 }, "demo:work:1"),
    event(-40, "person.answered", "mira", { answer: "Yes", by: "mira" }, "demo:work:1"),
    event(-30, "orchestrator.draft_accepted", "mira", { round: 1 }, "demo:work:1"),
    event(-15, "orchestrator.merged", "orchestrator", { sha: "2222222bbbb", by: "session" }, "demo:work:2"),
    event(-35, "person.answered", "ines", { answer: "No", by: "ines" }, "demo:work:2"),
    event(-36, "orchestrator.questions_asked", "orchestrator", { questions: ["1", "2"] }, "demo:work:2"),
  ];
  const rows = buildActivity(input({ works: [logged, bare], events }), T0).rows;
  assert.deepEqual(rows.map((row) => [row.items[0]?.id, row.text]), [
    ["2", "Merged 2222222, by the implementor"],
    ["1", "Merged 1111111 to main through the merge queue (batch 4)"],
    ["2", "Answered: No"],
    ["2", "Asked 2 questions"],
    ["1", "Answered: Yes"],
  ]);
});

test("a GitHub Item's merged marker and the implementor's decisions, recorded and settled", () => {
  const item = work(63, {
    merged: { sha: "9999999cccc", target: "main", batch: 7, at: at(-5) },
    assumptions: [
      { id: "a#0", at: at(-60), question: "Typos allowed?", chosen: "Two", others: ["One"], why: "x", settled: { verdict: "accepted", at: at(-30), by: "robin" } },
      { id: "a#1", at: at(-60), question: "Where do near matches go?", chosen: "After exact ones", others: [], why: "y", settled: { verdict: "overturned", at: at(-20), by: "mira", answer: "Mixed in by score", item: ref("work", 64) } },
    ],
  });
  const rows = buildActivity(input({ works: [item, work(64, { title: "Rework" })] }), T0).rows;
  assert.deepEqual(rows.map((row) => [row.kind, row.who, row.text, row.items.map((each) => each.id)]), [
    ["merge", "Scope Soup", "Merged 9999999 to main through the merge queue (batch 7)", ["63"]],
    ["decision", "mira", "Overturned a decision the implementor took itself", ["63", "64"]],
    ["decision", "robin", "Accepted a decision the implementor took itself", ["63"]],
    ["decision", "implementor", "Decided 2 questions itself, cheap to change later", ["63"]],
  ]);
  assert.equal(rows[1]!.detail, "Mixed in by score");
  assert.equal(rows[3]!.detail, "Typos allowed? Two · Where do near matches go? After exact ones");
});

test("the view is bounded to the newest rows, and durations read as words", () => {
  const log = Array.from({ length: 30 }, (_, index) => line(-index, MIRA, "claimed"));
  const view = buildActivity(input({ works: [work(1, { log })] }), T0, 10);
  assert.equal(view.rows.length, 10);
  assert.equal(view.more, true);
  assert.equal(view.rows[0]!.at, at(0));
  assert.deepEqual([duration(20_000), duration(35 * 60_000), duration(60 * 60_000), duration(80 * 60_000)], ["under a minute", "35 min", "1 h", "1 h 20 min"]);
});

test("consecutive sessions on one Item fold into one row with the total time and cost, the sessions inside", () => {
  const s = (minutes: number, role: string, ms: number, usd: number) => line(minutes, SOUP, "session", { role, outcome: "succeeded", durationMs: ms, costUsd: usd });
  const item = work(63, {
    title: "Fold",
    log: [s(-100, "triage", 600_000, 0.1), s(-90, "implement", 3_000_000, 1), s(-80, "implement", 600_000, 0.2), s(-70, "review", 600_000, 0.1), line(-60, MIRA, "claimed", { until: at(600) }), s(-50, "review", 60_000, 0.05)],
  });
  const other = work(64, { title: "Other", log: [s(-65, "implement", 60_000, 0.5)] });
  const rows = buildActivity(input({ works: [item, other] }), T0).rows;
  const folded = foldSessions(rows);
  // newest first: #63 review alone, the claim, #64's session, then #63's four
  assert.deepEqual(folded.map((row) => [row.kind, row.folded?.length]), [["session", undefined], ["item", undefined], ["session", undefined], ["session", 4]]);
  const group = folded[3]!;
  assert.equal(group.text, "4 sessions on #63: triage, implement ×2, review · 1 h 20 min · $1.40");
  assert.equal(group.at, rows.find((row) => row.id === group.folded![0]!.id)!.at);
  assert.deepEqual(group.folded!.map((row) => row.session!.role), ["review", "implement", "implement", "triage"]);
  assert.deepEqual(foldSessions([]), []);
});

test("a lone session is not folded, and a bad one makes the fold bad", () => {
  const item = work(5, { log: [line(-30, SOUP, "session", { role: "implement", outcome: "failed", durationMs: 60_000 }), line(-20, SOUP, "session", { role: "review", outcome: "succeeded" })] });
  const rows = buildActivity(input({ works: [item] }), T0).rows;
  assert.equal(foldSessions(rows.slice(0, 1))[0]!.folded, undefined);
  const group = foldSessions(rows)[0]!;
  assert.equal(group.tone, "bad");
  assert.equal(group.text, "2 sessions on #5: implement, review · 1 min");
});

test("the Jira board buttons' events are rows with the Item link; an account id is shown as the holder's display name", () => {
  const held = work(5, { title: "Jira thing", holder: { actor: { id: "5b10a2844c20165700ede21g", name: "Robin Example" } } });
  const events = [
    event(-30, "person.claimed", "5b10a2844c20165700ede21g", { reason: "x", via: "board", account: "5b10a2844c20165700ede21g" }, "demo:work:5"),
    event(-20, "person.handed_back", "Kim", { reason: "x", via: "board", note: "Branch is pushed." }, "demo:work:5"),
    event(-10, "person.released", "Robin Example", { reason: "x", via: "board", account: "5b10a2844c20165700ede21g" }, "demo:work:5"),
  ];
  const rows = buildActivity(input({ works: [held], events }), T0).rows;
  assert.deepEqual(rows.map((row) => [row.who, row.text, row.agent, row.items[0]?.id, row.detail]), [
    ["Robin Example", "Let the Item go on the board", false, "5", undefined],
    ["Kim", "Handed the Item back on the board", false, "5", "Branch is pushed."],
    ["Robin Example", "Took the Item on the board", false, "5", undefined],
  ]);
  assert.ok(ACTIVITY_EVENTS.includes("person.claimed") && ACTIVITY_EVENTS.includes("person.handed_back") && ACTIVITY_EVENTS.includes("person.released"));
});
