import assert from "node:assert/strict";
import { test } from "node:test";
import { foldLog, parseLog } from "./log.ts";

const robin = { who: "robin", machine: "laptop-a" };
const sam = { who: "sam", machine: "laptop-b" };
const agent = { who: "implement", machine: "laptop-a", agent: true };
const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";

const jsonl = (...lines: object[]): string => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
const fold = (text: string) => foldLog(parseLog(text));

test("log: every line shape that cannot be read is kept with its problem and counted", () => {
  const text = [
    JSON.stringify({ at: "2026-11-18T09:00:00Z", by: robin, kind: "claimed" }),
    "{not json",
    "[1, 2]",
    JSON.stringify({ at: "yesterday", by: robin, kind: "claimed" }),
    JSON.stringify({ at: "2026-11-18T09:00:00", by: robin, kind: "claimed" }),
    JSON.stringify({ at: "2026-11-18T09:00:00Z", by: { machine: "laptop-a" }, kind: "claimed" }),
    JSON.stringify({ at: "2026-11-18T09:00:00Z", by: "robin\u0007", kind: "claimed" }),
    JSON.stringify({ at: "2026-11-18T09:00:00Z", by: robin }),
    "",
    "   ",
    JSON.stringify({ at: "2026-11-18T09:05:00+01:00", by: "sam", kind: "session" }) + "\r",
  ].join("\n");
  const parsed = parseLog(text);
  assert.deepEqual(parsed.entries.map((entry) => [entry.line, entry.kind, entry.by]), [
    [1, "claimed", { who: "robin", machine: "laptop-a", agent: false }],
    [11, "session", { who: "sam", agent: false }],
  ]);
  assert.deepEqual(parsed.malformed.map((bad) => bad.line), [2, 3, 4, 5, 6, 7, 8]);
  assert.equal(parsed.malformed[0]?.raw, "{not json");
  assert.match(parsed.malformed[5]?.problem ?? "", /`by`/);
});

test("fold: unknown kinds and known kinds with misfit fields are kept and counted, never fatal", () => {
  const picture = fold(
    jsonl(
      { at: "2026-11-18T09:00:00Z", by: agent, kind: "revision", sha: SHA1, branch: "scopesoup/A-1" },
      { at: "2026-11-18T09:01:00Z", by: robin, kind: "celebrated", mood: "good" },
      { at: "2026-11-18T09:02:00Z", by: robin, kind: "review", sha: SHA1, verdict: "maybe" },
      { at: "2026-11-18T09:03:00Z", by: robin, kind: "review", verdict: "pass" },
      { at: "2026-11-18T09:04:00Z", by: robin, kind: "revision", sha: "--all" },
      { at: "2026-11-18T09:05:00Z", by: robin, kind: "revision", sha: SHA2, branch: "../main" },
      { at: "2026-11-18T09:06:00Z", by: robin, kind: "claimed", until: "soon" },
      { at: "2026-11-18T09:07:00Z", by: robin, kind: "question" },
    ),
  );
  assert.equal(picture.entries, 8);
  assert.deepEqual(picture.unknown.map((entry) => entry.kind), ["celebrated"]);
  assert.equal(picture.malformed.length, 6);
  assert.deepEqual(picture.revisions.map((line) => line.sha), [SHA1]);
  assert.equal(picture.branch, "scopesoup/A-1");
  assert.equal(picture.reviews.length, 0);
  assert.equal(picture.holder, undefined);
  assert.equal(picture.lastAt, "2026-11-18T09:07:00.000Z");
});

test("fold: the first claim stands, the holder renews and releases, an agent's expired claim can be taken, a person's never runs out", () => {
  const at = (minute: number): string => `2026-11-18T09:${String(minute).padStart(2, "0")}:00Z`;
  const steps = [
    { at: at(0), by: robin, kind: "claimed", until: at(30) },
    { at: at(1), by: sam, kind: "claimed", until: at(40) },
    { at: at(2), by: sam, kind: "released", reason: "robin was first" },
  ];
  const utc = (iso: string): string => iso.replace(":00Z", ":00.000Z");
  assert.deepEqual(fold(jsonl(...steps)).holder, { by: { ...robin, agent: false }, at: utc(at(0)), until: utc(at(30)) });
  const renewed = [...steps, { at: at(20), by: robin, kind: "claimed", until: at(50) }];
  assert.equal(fold(jsonl(...renewed)).holder?.until, utc(at(50)));
  // People have no stall timer: robin's `until` passing does not free the item; only robin's release does.
  const expired = [...steps, { at: at(31), by: sam, kind: "claimed", until: at(59) }];
  assert.equal(fold(jsonl(...expired)).holder?.by.who, "robin");
  const agent = { who: "scopesoup", machine: "laptop-b", agent: true };
  const agentSteps = [{ at: at(0), by: agent, kind: "claimed", until: at(30) }, { at: at(31), by: sam, kind: "claimed", until: at(59) }];
  assert.equal(fold(jsonl(...agentSteps)).holder?.by.who, "sam");
  assert.equal(fold(jsonl(agentSteps[0]!, { at: at(29), by: sam, kind: "claimed", until: at(59) })).holder?.by.who, "scopesoup");
  const released = [...steps, { at: at(5), by: robin, kind: "released", reason: "done for today" }];
  assert.equal(fold(jsonl(...released)).holder, undefined);
  // A person is not tied to a machine: robin's release from another laptop is his own.
  const elsewhere = [...steps, { at: at(5), by: { who: "robin", machine: "laptop-c" }, kind: "released" }];
  assert.equal(fold(jsonl(...elsewhere)).holder, undefined);
  // An agent's claim is machine-bound: the same name on another machine is another agent.
  const agentElsewhere = [agentSteps[0]!, { at: at(5), by: { ...agent, machine: "laptop-c" }, kind: "released" }];
  assert.equal(fold(jsonl(...agentElsewhere)).holder?.by.machine, "laptop-b");
});

test("fold: the change from revision, review, check and merged; a later revision opens it again", () => {
  const lines = [
    { at: "2026-11-18T10:00:00Z", by: agent, kind: "revision", sha: SHA1, branch: "scopesoup/A-1" },
    { at: "2026-11-18T10:10:00Z", by: robin, kind: "review", sha: SHA1, verdict: "pass", findings: ["fine", 3, ""] },
    { at: "2026-11-18T10:20:00Z", by: agent, kind: "check", sha: SHA1, verdict: "fail", command: "pnpm check", findings: "one test failed" },
    { at: "2026-11-18T10:30:00Z", by: agent, kind: "merged", sha: SHA1, target: "main" },
  ];
  const merged = fold(jsonl(...lines));
  assert.deepEqual(merged.reviews.map((line) => [line.sha, line.verdict, line.findings]), [[SHA1, "pass", ["fine"]]]);
  assert.deepEqual(merged.checks.map((line) => [line.verdict, line.command, line.findings]), [["fail", "pnpm check", ["one test failed"]]]);
  assert.deepEqual(merged.merged, { at: "2026-11-18T10:30:00.000Z", by: { ...agent }, sha: SHA1, target: "main" });
  const reopened = fold(jsonl(...lines, { at: "2026-11-18T11:00:00Z", by: agent, kind: "revision", sha: SHA2 }));
  assert.equal(reopened.merged, undefined);
  assert.equal(reopened.branch, "scopesoup/A-1");
  assert.equal(reopened.revisions.length, 2);
});

test("fold: a question stays open until answered, by `to` or else the newest open one", () => {
  const q = (minute: number, question: string) => ({ at: `2026-11-18T12:0${minute}:00Z`, by: agent, kind: "question", question, options: ["a", "b"], recommendation: "a" });
  const one = fold(jsonl(q(0, "First?"), q(1, "Second?")));
  assert.deepEqual(one.openQuestions.map((line) => line.question), ["First?", "Second?"]);
  assert.deepEqual(one.openQuestions[0]?.options, ["a", "b"]);
  const newest = fold(jsonl(q(0, "First?"), q(1, "Second?"), { at: "2026-11-18T12:05:00Z", by: robin, kind: "answer", answer: "b" }));
  assert.deepEqual(newest.openQuestions.map((line) => line.question), ["First?"]);
  const named = fold(jsonl(q(0, "First?"), q(1, "Second?"), { at: "2026-11-18T12:05:00Z", by: robin, kind: "answer", answer: "a", to: "2026-11-18T12:00:00Z" }));
  assert.deepEqual(named.openQuestions.map((line) => line.question), ["Second?"]);
  const empty = fold(jsonl(q(0, "First?"), { at: "2026-11-18T12:05:00Z", by: robin, kind: "answer" }));
  assert.equal(empty.openQuestions.length, 1);
  assert.equal(empty.malformed.length, 1);
});

test("fold: a question keeps options as { label, description } and the context, and plain text options too", () => {
  const options = [{ label: "Keep", description: "less work" }, "Drop it", { label: " ", description: "x" }, 5];
  const picture = fold(jsonl({ at: at(0), by: agent, kind: "question", question: "Which?", options, recommendation: "Keep", context: "Also check the budget line." }));
  assert.deepEqual(picture.openQuestions[0]?.options, [{ label: "Keep", description: "less work" }, "Drop it"]);
  assert.equal(picture.openQuestions[0]?.context, "Also check the budget line.");
});

test("fold: an empty log is an empty picture", () => {
  const picture = fold("");
  assert.equal(picture.entries, 0);
  assert.equal(picture.lastAt, undefined);
  assert.deepEqual([picture.revisions, picture.openQuestions, picture.unknown, picture.malformed], [[], [], [], []]);
});

const at = (minute: number): string => `2026-11-18T09:${String(minute).padStart(2, "0")}:00Z`;

test("fold: the file's order does not matter; the order is `at`, then `by`, then the place in the file", () => {
  const claimed = { at: at(0), by: robin, kind: "claimed", until: at(30) };
  const released = { at: at(5), by: robin, kind: "released" };
  assert.equal(fold(jsonl(released, claimed)).holder, undefined);
  assert.equal(fold(jsonl(claimed, released)).holder, undefined);
  // Written in the wrong order, and at different offsets for the same instants.
  const early = { at: "2026-11-18T09:00:30+00:00", by: sam, kind: "claimed", until: at(50) };
  const late = { at: at(1), by: robin, kind: "claimed", until: at(50) };
  assert.equal(fold(jsonl(late, early)).holder?.by.who, "sam");
  // The same instant: `by` as text decides, not the file.
  const a = { at: at(2), by: { who: "a" }, kind: "claimed", until: at(50) };
  const b = { at: at(2), by: { who: "b" }, kind: "claimed", until: at(50) };
  assert.equal(fold(jsonl(b, a)).holder?.by.who, "a");
  assert.equal(fold(jsonl(a, b)).holder?.by.who, "a");
});

test("fold: lines with the same whole content count once", () => {
  const question = { at: at(0), by: agent, kind: "question", question: "Which?", options: ["a", "b"] };
  const answer = { at: at(5), by: robin, kind: "answer", answer: "a" };
  // The other laptop wrote the same lines too, one of them with another offset.
  const picture = fold(jsonl(question, question, { ...question, at: "2026-11-18T10:00:00+01:00" }, answer));
  assert.equal(picture.openQuestions.length, 0);
  const sameRevision = [
    { at: at(0), by: agent, kind: "revision", sha: SHA1, branch: "scopesoup/A-1" },
    { at: at(0), by: agent, kind: "revision", sha: SHA1, branch: "scopesoup/A-1" },
    { at: at(1), by: { ...agent, machine: "laptop-b" }, kind: "revision", sha: SHA1, branch: "scopesoup/A-1" },
  ];
  assert.deepEqual(fold(jsonl(...sameRevision)).revisions.map((line) => line.sha), [SHA1]);
  // A bare name and the object form of the same `who` are the same writer.
  const twice = fold(jsonl({ at: at(0), by: "robin", kind: "question", question: "Q?" }, { at: at(0), by: { who: "robin", agent: false }, kind: "question", question: "Q?" }));
  assert.equal(twice.openQuestions.length, 1);
});

test("fold: `merged` counts only for the newest revision", () => {
  const revisions = [
    { at: at(0), by: agent, kind: "revision", sha: SHA1, branch: "scopesoup/A-1" },
    { at: at(1), by: agent, kind: "revision", sha: SHA2 },
  ];
  assert.equal(fold(jsonl(...revisions, { at: at(2), by: agent, kind: "merged", sha: SHA1 })).merged, undefined);
  assert.equal(fold(jsonl(...revisions, { at: at(2), by: agent, kind: "merged", sha: SHA2 })).merged?.sha, SHA2);
  // A revision written after the merge opens the change again, in any file order.
  assert.equal(fold(jsonl(revisions[1] as object, { at: at(2), by: agent, kind: "merged", sha: SHA2 }, { at: at(3), by: agent, kind: "revision", sha: SHA1 })).merged, undefined);
  assert.equal(fold(jsonl(revisions[0] as object, { at: at(2), by: agent, kind: "merged", sha: SHA1 }, revisions[1] as object)).merged, undefined);
});

test("fold: a sha in a log line must be a full commit id", () => {
  const picture = fold(
    jsonl(
      { at: at(0), by: agent, kind: "revision", sha: "1111111" },
      { at: at(1), by: agent, kind: "revision", sha: "A".repeat(40) },
      { at: at(2), by: agent, kind: "revision", sha: SHA1 },
      { at: at(3), by: agent, kind: "merged", sha: SHA1.slice(0, 12) },
      { at: at(4), by: agent, kind: "revision", sha: "3".repeat(64) },
    ),
  );
  assert.deepEqual(picture.revisions.map((line) => line.sha), [SHA1, "3".repeat(64)]);
  assert.equal(picture.malformed.length, 3);
  assert.equal(picture.merged, undefined);
});

test("fold: `claimed` needs `until`", () => {
  const picture = fold(jsonl({ at: at(0), by: robin, kind: "claimed" }));
  assert.equal(picture.holder, undefined);
  assert.equal(picture.malformed.length, 1);
  assert.match(picture.malformed[0]?.problem ?? "", /until/);
});

test("fold: times are UTC and both spellings of a writer are one actor", () => {
  const claimed = { at: "2026-11-18T10:00:00+01:00", by: "robin", kind: "claimed", until: "2026-11-18T12:00:00+01:00" };
  assert.equal(fold(jsonl(claimed, { at: "2026-11-18T09:30:00Z", by: { who: "robin" }, kind: "released" })).holder, undefined);
  const held = fold(jsonl(claimed));
  assert.deepEqual(held.holder, { by: { who: "robin", agent: false }, at: "2026-11-18T09:00:00.000Z", until: "2026-11-18T11:00:00.000Z" });
  assert.equal(held.lastAt, "2026-11-18T09:00:00.000Z");
});

test("fold: an answer names its question by `at`, and by `toBy` when two were asked at the same instant", () => {
  const q = (by: object, question: string) => ({ at: at(0), by, kind: "question", question });
  const questions = [q(robin, "Robin's?"), q(sam, "Sam's?"), { at: at(1), by: robin, kind: "question", question: "Later?" }];
  const both = fold(jsonl(...questions, { at: at(5), by: agent, kind: "answer", answer: "x", to: at(0) }));
  assert.deepEqual(both.openQuestions.map((line) => line.question), ["Later?"]);
  const one = fold(jsonl(...questions, { at: at(5), by: agent, kind: "answer", answer: "x", to: "2026-11-18T10:00:00+01:00", toBy: sam }));
  assert.deepEqual(one.openQuestions.map((line) => line.question).sort(), ["Later?", "Robin's?"]);
  // "robin" with no machine is not robin on laptop-a.
  const named = fold(jsonl(...questions, { at: at(5), by: agent, kind: "answer", answer: "x", to: at(0), toBy: "robin" }));
  assert.equal(named.openQuestions.length, 3);
  const broken = fold(jsonl(...questions, { at: at(5), by: agent, kind: "answer", answer: "x", to: at(0), toBy: 5 }, { at: at(6), by: agent, kind: "answer", answer: "x", to: "tuesday" }));
  assert.equal(broken.openQuestions.length, 3);
  assert.equal(broken.malformed.length, 2);
});

test("log: an answer closes its question whichever folds first (the same instant, a name that sorts before the asker's) (#230)", () => {
  const soup = { who: "scopesoup", machine: "laptop-a", agent: true };
  const ada = { who: "Ada", machine: "laptop-a" };
  const t = "2026-11-18T10:00:00Z";
  // Named by `to`: it folds before the question (Ada sorts before scopesoup) and still closes it.
  assert.equal(fold(jsonl({ at: t, by: soup, kind: "question", question: "Go?" }, { at: t, by: ada, kind: "answer", answer: "Yes", to: t, toBy: soup })).openQuestions.length, 0);
  // Without `to`: it takes the newest question open at the end of its instant.
  const two = fold(jsonl({ at: "2026-11-18T09:00:00Z", by: soup, kind: "question", question: "Older?" }, { at: t, by: soup, kind: "question", question: "Newer?" }, { at: t, by: ada, kind: "answer", answer: "Yes" }));
  assert.deepEqual(two.openQuestions.map((line) => line.question), ["Older?"]);
});

test("log: a new set of questions from Scope Soup replaces the set still open (decision 1 of #211, #230)", () => {
  const soup = { who: "scopesoup", machine: "laptop-a", agent: true };
  const t = "2026-11-18T10:00:00Z";
  const picture = fold(jsonl(
    { at: t, by: soup, kind: "question", question: "Too large?", parked: "not-ready", set: "1" },
    { at: t, by: soup, kind: "question", question: "First of two?", parked: "needs-decision", set: "2" },
    { at: t, by: soup, kind: "question", question: "Second of two?", parked: "needs-decision", set: "2" },
    { at: t, by: robin, kind: "question", question: "A person's own?" },
  ));
  assert.deepEqual(picture.openQuestions.map((line) => line.question), ["A person's own?", "First of two?", "Second of two?"]);
});
