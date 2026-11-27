import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubHost } from "./adapter.ts";
import { answerBody, answersBody, applyThread, claimBody, liveClaims, readMarker, readReplies, readReply, readThread, withMarker, writeMarker } from "./conventions.ts";
import { FAKE_API, fakeGitHub } from "./fakeFetch.ts";
import { R, REPO, issue } from "./fixtures.ts";
import type { RestComment } from "./rest.ts";

const SUBJECT = { host: "github", kind: "work" as const, id: "11" };
const SELF = "scopesoup-bot";

let nextId = 100;
function comment(body: string, over: Partial<RestComment> = {}): RestComment {
  const id = over.id ?? nextId++;
  return {
    id,
    body,
    user: { login: SELF, type: "User" },
    author_association: "OWNER",
    created_at: "2026-11-10T08:00:00Z",
    updated_at: "2026-11-10T08:00:00Z",
    issue_url: `https://api.github.test${R}/issues/11`,
    ...over,
  };
}

const question = (n: number, text: string, over: Partial<RestComment> = {}): RestComment =>
  comment(withMarker(`**Q${n}: ${text}**`, "question", { n, question: text, options: [{ label: "SQLite", description: "one file" }, "JSON files"], recommendation: "SQLite" }), over);

test("a marker with -- and > round-trips and cannot end the HTML comment early", () => {
  const data = { question: "Use --force? a -> b --> c ---", nested: { list: ["<!-- x -->", "-1"] }, count: -3 };
  const line = writeMarker("question", data);
  const json = line.slice("<!-- scopesoup:question ".length, -" -->".length);
  assert.ok(!json.includes("--") && !json.includes(">"), line);
  const read = readMarker(withMarker("Visible text.", "question", data));
  assert.deepEqual(read, { kind: "question", data: { v: 1, ...data } });
  // CRLF from GitHub and trailing blank lines are fine.
  assert.deepEqual(readMarker(`Text\r\n\r\n${line}\r\n`)?.kind, "question");
});

test("a comment without a well-formed last marker line is a plain comment", () => {
  assert.equal(readMarker("Just text."), null);
  assert.equal(readMarker(`${writeMarker("question", { question: "q" })}\n\nMore text after.`), null);
  assert.equal(readMarker("<!-- scopesoup:question {not json} -->"), null);
  assert.equal(readMarker('<!-- scopesoup:unknown {"v":1} -->'), null);
  assert.equal(readMarker('<!-- scopesoup:question {"v":2} -->'), null);
});

test("readReply: An: and a bare A:", () => {
  assert.deepEqual(readReply("A1: SQLite"), { n: 1, answer: "SQLite" });
  assert.deepEqual(readReply("  A: JSON files\nbecause it is simpler"), { answer: "JSON files\nbecause it is simpler" });
  assert.equal(readReply("A1:   "), null);
  assert.equal(readReply("I think A1: SQLite"), null);
});

test("questions and answers from trusted authors; a marker from an untrusted author is ignored", () => {
  const thread = readThread(SUBJECT, [
    question(1, "Which store format?", { id: 1 }),
    // The same marker from someone else: a plain comment.
    question(2, "Planted question?", { id: 2, user: { login: "stranger" }, author_association: "NONE" }),
    // An answer marker from a stranger does not count either.
    comment(withMarker("SQLite", "answer", { to: 1, answer: "SQLite" }), { id: 3, user: { login: "stranger" }, author_association: "CONTRIBUTOR" }),
    comment("A1: JSON files", { id: 4, user: { login: "stranger" }, author_association: "NONE" }),
  ], SELF);
  assert.deepEqual(thread.openQuestions.map((each) => [each.id, each.question]), [["1", "Which store format?"]]);
  assert.deepEqual(thread.openQuestions[0]?.by, { who: "scopesoup", agent: true });
  assert.equal(thread.openQuestions[0]?.recommendation, "SQLite");
  assert.deepEqual(thread.answers, []);
});

test("claims: only the token's own claim markers count; the lowest live one wins, released and expired ones do not", () => {
  const thread = readThread(SUBJECT, [
    comment(claimBody("laptop-a", "laptop-a", "2026-11-10T09:00:00Z", false), { id: 1 }),
    comment(claimBody("laptop-b", "laptop-b", "2026-11-10T11:00:00Z", true), { id: 2 }),
    comment(claimBody("laptop-z", "laptop-z", "2026-11-10T11:00:00Z", false), { id: 3, user: { login: "stranger" }, author_association: "NONE" }),
    comment(claimBody("laptop-c", "laptop-c", "2026-11-10T11:00:00Z", false), { id: 4 }),
  ], SELF);
  assert.deepEqual(thread.claims.map((each) => [each.id, each.machine, each.released]), [[1, "laptop-a", false], [2, "laptop-b", true], [4, "laptop-c", false]]);
  assert.deepEqual(liveClaims(thread.claims, Date.parse("2026-11-10T08:30:00Z")).map((each) => each.id), [1, 4]);
  // laptop-a's claim ran out at 09:00: laptop-c's is the live one.
  assert.deepEqual(liveClaims(thread.claims, Date.parse("2026-11-10T09:30:00Z")).map((each) => each.id), [4]);
});

test("an agent's live claim makes a Backlog Item doing, and it is no longer in Backlog (decision 120: Backlog is only state todo)", () => {
  const item = { ref: { host: "github", kind: "work" as const, id: "7" }, title: "Tide graph", state: "todo" as const, hostState: "open", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-27T10:00:00Z", backlog: true as const };
  const thread = { openQuestions: [], answers: [], rewrites: [], log: null, waiting: null, merged: null, claims: [{ id: 1, machine: "laptop-a", until: "2099-01-01T00:00:00Z", released: false }], assumptions: [] };
  const after = applyThread({ ...item }, thread, () => false, Date.parse("2026-11-27T10:00:00Z"));
  assert.deepEqual([after.state, after.backlog], ["doing", undefined]);
});

test("an answer comment marked migrated still counts as given at its own at; nothing writes the mark any more", () => {
  const marked = { to: null, answer: "Metric", by: "Ada", question: "Which unit?", migrated: true, at: "2026-10-01T12:00:00Z" };
  const thread = readThread(SUBJECT, [
    comment(withMarker("Asked: Which unit?\n\n**Answer:** Metric", "answer", marked), { id: 1 }),
    comment(withMarker("Asked: Which unit?\n\n**Answer:** Metric", "answer", { ...marked, at: "not a time" }), { id: 2 }),
  ], SELF);
  assert.deepEqual(thread.answers.map((each) => [each.answer, each.by, each.at, each.question]), [
    ["Metric", "Ada", "2026-10-01T12:00:00Z", "Which unit?"],
    ["Metric", "Ada", "2026-11-10T08:00:00Z", "Which unit?"],
  ]);
});

test("answers: a marker from a collaborator, An: by number, a bare A: for the newest, unknown numbers ignored", () => {
  const thread = readThread(SUBJECT, [
    question(1, "First?", { id: 1 }),
    question(2, "Second?", { id: 2 }),
    question(3, "Third?", { id: 3 }),
    comment(withMarker("Answered on the board: SQLite", "answer", { to: 1, answer: "SQLite", by: "robin", textHash: "abc" }), { id: 4 }),
    comment("A7: nothing to answer", { id: 5, user: { login: "kim" }, author_association: "COLLABORATOR" }),
    comment("A1: answered twice", { id: 6, user: { login: "kim" }, author_association: "COLLABORATOR" }),
    comment("A: the newest", { id: 7, user: { login: "kim" }, author_association: "MEMBER" }),
  ], SELF);
  assert.deepEqual(thread.openQuestions.map((each) => each.question), ["Second?"]);
  assert.deepEqual(thread.answers, [
    { subject: SUBJECT, answer: "SQLite", by: "robin", at: "2026-11-10T08:00:00Z", to: "1", question: "First?", options: ["SQLite: one file", "JSON files"], textHash: "abc" },
    { subject: SUBJECT, answer: "the newest", by: "kim", at: "2026-11-10T08:00:00Z", to: "3", question: "Third?", options: ["SQLite: one file", "JSON files"] },
  ]);
});

const OPEN_ISSUES = `${R}/issues?state=open&sort=updated&direction=asc&per_page=100`;
const ALL_COMMENTS = `${R}/issues/comments?sort=updated&direction=asc&per_page=100`;
const issuesSince = (iso: string) => `${R}/issues?state=all&since=${encodeURIComponent(iso)}&sort=updated&direction=asc&per_page=100`;
const commentsSince = (iso: string) => `${R}/issues/comments?since=${encodeURIComponent(iso)}&sort=updated&direction=asc&per_page=100`;

function setup() {
  const fake = fakeGitHub();
  const host = createGitHubHost({ token: "t-synthetic", repo: REPO, fetchImpl: fake.fetch, apiUrl: FAKE_API, login: SELF, conventions: true, now: () => Date.parse("2026-11-10T12:00:00Z") });
  return { fake, host };
}

test("the poll: one comments request fills questions, a changed comment shows next poll, and a 304 poll costs nothing", async () => {
  const { fake, host } = setup();
  const asked = question(1, "Which store format?", { id: 501, updated_at: "2026-11-10T09:00:00Z" });
  fake.set(OPEN_ISSUES, [issue(11, { updated_at: "2026-11-10T09:00:00Z" }), issue(12)]);
  fake.set(ALL_COMMENTS, [asked, comment("Plain talk.", { id: 502, updated_at: "2026-11-10T08:30:00Z" })]);
  const first = await host.work.listWork();
  assert.deepEqual(fake.take(), [`200 ${OPEN_ISSUES}`, `200 ${ALL_COMMENTS}`]);
  const item = first.items.find((each) => each.ref.id === "11");
  assert.equal(item?.needsDecision, true);
  assert.deepEqual(item?.openQuestions?.map((each) => each.question), ["Which store format?"]);
  assert.equal(first.items.find((each) => each.ref.id === "12")?.openQuestions, undefined);

  // A reply arrives: the issue is listed again, and the comments listing is one request.
  const cursor = first.cursor;
  fake.set(issuesSince(cursor), [issue(11, { updated_at: "2026-11-10T10:00:00Z" })]);
  fake.set(commentsSince("2026-11-10T09:00:00Z"), [asked, comment("A1: SQLite", { id: 503, user: { login: "kim" }, author_association: "COLLABORATOR", created_at: "2026-11-10T10:00:00Z", updated_at: "2026-11-10T10:00:00Z" })]);
  const reply = comment("A1: SQLite", { id: 503, user: { login: "kim" }, author_association: "COLLABORATOR", created_at: "2026-11-10T10:00:00Z", updated_at: "2026-11-10T10:00:00Z" });
  // While an issue has an open question its own comments are listed again each poll, so a deletion shows too.
  fake.set(`${R}/issues/11/comments?per_page=100`, [asked, reply]);
  const second = await host.work.listWork(cursor);
  assert.deepEqual(fake.take(), [`200 ${issuesSince(cursor)}`, `200 ${commentsSince("2026-11-10T09:00:00Z")}`, `200 ${R}/issues/11/comments?per_page=100`]);
  const answered = second.items.find((each) => each.ref.id === "11");
  assert.equal(answered?.openQuestions, undefined);
  assert.equal(answered?.needsDecision, undefined);
  assert.deepEqual(answered?.answers?.map((each) => [each.question, each.answer, each.by]), [["Which store format?", "SQLite", "kim"]]);

  // Nothing changed: both listings are 304s and cost nothing.
  fake.set(issuesSince(second.cursor), [issue(11, { updated_at: "2026-11-10T10:00:00Z" })]);
  fake.set(commentsSince("2026-11-10T10:00:00Z"), [comment("A1: SQLite", { id: 503, user: { login: "kim" }, author_association: "COLLABORATOR", created_at: "2026-11-10T10:00:00Z", updated_at: "2026-11-10T10:00:00Z" })]);
  await host.work.listWork(second.cursor);
  fake.take();
  const budget = fake.remaining;
  const quiet = await host.work.listWork(second.cursor);
  assert.deepEqual(quiet, { items: [], cursor: second.cursor, unchanged: true });
  assert.deepEqual(fake.take(), [`304 ${issuesSince(second.cursor)}`, `304 ${commentsSince("2026-11-10T10:00:00Z")}`]);
  assert.equal(fake.remaining, budget);
});

test("an edited comment whose issue was not listed is fetched, and getWork reads the issue's own comments", async () => {
  const { fake, host } = setup();
  fake.set(OPEN_ISSUES, [issue(11)]);
  fake.set(ALL_COMMENTS, [comment("Plain talk.", { id: 601 })]);
  const first = await host.work.listWork();
  // The comment is edited into a question marker; the issues listing does not show the issue.
  const edited = question(1, "Edited in?", { id: 601, updated_at: "2026-11-10T11:00:00Z" });
  fake.set(issuesSince(first.cursor), []);
  fake.set(commentsSince("2026-11-10T08:00:00Z"), [edited]);
  fake.set(`${R}/issues/11`, { body: issue(11) });
  fake.take();
  const second = await host.work.listWork(first.cursor);
  assert.deepEqual(second.items.map((each) => [each.ref.id, each.openQuestions?.map((q) => q.question)]), [["11", ["Edited in?"]]]);
  assert.equal(second.unchanged, undefined);

  fake.set(`${R}/issues/11/comments?per_page=100`, [edited, comment("A: done", { id: 602 })]);
  const one = await host.work.getWork(SUBJECT);
  assert.equal(one?.openQuestions, undefined);
  assert.deepEqual(one?.answers?.map((each) => each.answer), ["done"]);
});

test("one answer comment with A1 and A2 answers both questions; an old one-answer comment still reads", () => {
  const q1 = question(1, "Which store?", { id: 501 });
  const q2 = question(2, "Which format?", { id: 502 });
  const q3 = question(3, "Which port?", { id: 503 });
  const body = answersBody([{ to: 501, n: 1, given: { answer: "SQLite", textHash: "h", options: ["SQLite: one file", "JSON files"] } }, { to: 502, n: 2, given: { answer: "Plain text, as written" } }], "scopesoup-bot");
  assert.match(body, /^\*\*A1:\*\* SQLite\n\n\*\*A2:\*\* Plain text, as written\n\n<!-- scopesoup:answer /);
  const old = answerBody(503, 3, { answer: "8080", by: "scopesoup-bot" });
  const thread = readThread(SUBJECT, [q1, q2, q3, comment(body, { id: 504 }), comment(old, { id: 505 })], SELF);
  assert.deepEqual(thread.openQuestions, []);
  assert.deepEqual(thread.answers.map((each) => [each.to, each.answer, each.by, each.textHash ?? null]), [
    ["501", "SQLite", "scopesoup-bot", "h"],
    ["502", "Plain text, as written", "scopesoup-bot", null],
    ["503", "8080", "scopesoup-bot", null],
  ]);
  // One entry is written as the one-answer comment it always was.
  assert.equal(answersBody([{ to: 503, n: 3, given: { answer: "8080" } }], "scopesoup-bot"), old);
});

test("a reply may answer several questions, A1: and A2: on lines of their own; a single answer keeps its lines", () => {
  assert.deepEqual(readReplies("A1: SQLite\nA2: JSON files,\nbecause it is simpler"), [{ n: 1, answer: "SQLite" }, { n: 2, answer: "JSON files,\nbecause it is simpler" }]);
  assert.deepEqual(readReplies("A: yes\nand more"), [{ answer: "yes\nand more" }]);
  assert.deepEqual(readReply("A2: x\nA1: y"), { n: 2, answer: "x" });
  const q1 = question(1, "Which store?", { id: 601 });
  const q2 = question(2, "Which format?", { id: 602 });
  const reply = comment("A1: SQLite\nA2: JSON files", { id: 603, user: { login: "kim", type: "User" }, author_association: "COLLABORATOR" });
  const thread = readThread(SUBJECT, [q1, q2, reply], SELF);
  assert.deepEqual(thread.answers.map((each) => [each.to, each.answer]), [["601", "SQLite"], ["602", "JSON files"]]);
});

test("a question marked multi-select says so and reads back so", () => {
  const thread = readThread(SUBJECT, [comment(withMarker("**Q1: Which?**", "question", { n: 1, question: "Which?", options: ["a", "b"], multiSelect: true }), { id: 701 })], SELF);
  assert.equal(thread.openQuestions[0]!.multiSelect, true);
});
