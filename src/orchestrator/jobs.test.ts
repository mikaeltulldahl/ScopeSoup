import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRecord, OpenQuestion } from "../model/types.ts";
import type { Job, JobAt, JobParked } from "./jobs.ts";
import { asImplement, askedInLog, asReview, asTriage, changedRewrite, hasMarkup, recoverFields, sameText, withoutVerification, dropUnreadable, loadJobs, saveJobs, parkedOf, writingOf, atStep, awaitText, endSession, handOverTaken, markMerged, nextStep, owesHandOver, parkJob, release, startSession, toReview, wait, editParked, toTriage, oweHandOver, oweClose } from "./jobs.ts";
import { openStore } from "../store/store.ts";

/** The sha of the job's change on main, once it merged. */
const shaOf = (job: Job | null | undefined): string | undefined => (job?.at.kind === "merged" ? job.at.sha : undefined);

test("a stored answer that carries the removed tests or untested fields is still read", () => {
  const implement = asImplement({ done: true, summary: "s", risk: "low", riskReason: "r", tests: "Added a test for parsing." });
  assert.ok(implement);
  assert.equal(implement.summary, "s");
  assert.equal("tests" in implement, false);
  const triage = asTriage({ ready: true, size: "small", paths: [], hidesDecision: false, risk: "low", riskReason: "r", untested: "src/export" });
  assert.ok(triage);
  assert.equal("untested" in triage, false);
});

test("a triage answer with tool-call markup inside a string is malformed", () => {
  const base = { ready: false, size: "large", paths: [], hidesDecision: false, risk: "high" };
  const broken = { ...base, riskReason: 'still merges on host writes.</riskReason>\n<parameter name="notReadyReason">Size is large: it bundles four pieces</notReadyReason>' };
  assert.equal(asTriage(broken), null);
  assert.equal(asTriage({ ...base, riskReason: "r", notReadyReason: 'x</notReadyReason>' }), null);
  assert.equal(asTriage({ ...base, riskReason: "r", notReadyReason: "Size is large: it bundles four pieces" })?.notReadyReason, "Size is large: it bundles four pieces");
});

test("a triage answer that quotes an HTML closing tag is not malformed", () => {
  const base = { ready: true, size: "small", hidesDecision: false, risk: "low" };
  assert.deepEqual(asTriage({ ...base, paths: [], blockers: ["The web change wraps text in <summary>x</summary>."] })?.blockers, ["The web change wraps text in <summary>x</summary>."]);
  assert.ok(asTriage({ ...base, paths: ["web/a</div>.html"], riskReason: "r" }));
  assert.equal(asTriage({ ...base, ready: false, paths: [], riskReason: "r", notReadyReason: "closes </div> early" })?.notReadyReason, "closes </div> early");
});

test("a not-ready or needs-decision triage answer without its reason is malformed", () => {
  const base = { size: "small", paths: [], risk: "low", riskReason: "r" };
  assert.equal(asTriage({ ...base, ready: false, hidesDecision: false }), null);
  assert.equal(asTriage({ ...base, ready: false, hidesDecision: false, notReadyReason: "  " }), null);
  assert.equal(asTriage({ ...base, ready: false, hidesDecision: true, decision: { question: "Which?" } }), null);
  assert.equal(asTriage({ ...base, ready: true, hidesDecision: true }), null);
  assert.ok(asTriage({ ...base, ready: true, hidesDecision: false }));
});

test("a decision in an answer keeps options as { label, description }, plain text options, and the context", () => {
  const triage = asTriage({
    ready: true, size: "small", paths: [], hidesDecision: true, risk: "high", riskReason: "r",
    decision: { question: "Which?", options: [{ label: "A", description: "why a" }, "B: plain", 7], recommendation: "A", context: " Note. " },
  });
  assert.deepEqual(triage?.decision, { question: "Which?", options: [{ label: "A", description: "why a" }, "B: plain"], recommendation: "A", context: "Note." });
  const implement = asImplement({ done: false, summary: "s", risk: "low", needs: "decision", decision: { question: "Q?", options: ["x"], recommendation: "" } });
  assert.deepEqual(implement?.decision, { question: "Q?", options: ["x"], recommendation: "" });
});

test("a trailing (recommended) the model wrote in an option label is dropped, and the recommendation still matches its label", () => {
  const triage = asTriage({
    ready: true, size: "small", paths: [], hidesDecision: true,
    decision: { question: "Which?", options: [{ label: "Whole numbers (Recommended)", description: "d" }, "Other (RECOMMENDED) "], recommendation: "Whole numbers (recommended)" },
  });
  assert.deepEqual(triage?.decision?.options, [{ label: "Whole numbers", description: "d" }, "Other"]);
  assert.equal(triage?.decision?.recommendation, "Whole numbers");
});

// Shortened from what real sessions answered: the fields after the summary ran into its string as tool-call markup.
const RUN_INTO_SUMMARY = {
  done: true,
  summary: 'Added src/area.js and its test.</summary>\n<parameter name="decisions">[{"question":"Which value should the test assert?","chosen":"0.06","others":["6"],"why":"The Item defines square metres."}]',
  aboutOthers: [],
};
const QUESTION_INTO_SUMMARY = {
  done: false,
  summary: 'Fixed the docstring. The Item still says 6.</summary>\n<parameter name="question">{"question":"Which value should the Item use?","options":[{"label":"Keep 0.06","description":"Square metres."},{"label":"Return 6","description":"Not square metres."}],"recommendation":"Keep 0.06"}</parameter>\n<parameter name="decisions">[]',
};
const MERGED_AS_INTO_SUMMARY = {
  done: true,
  summary: 'Done on the branch.</summary>\n<parameter name="mergedAs"></parameter>\n<parameter name="decisions">[{"question":"How to update the branch?","chosen":"merge","others":["rebase"],"why":"Keeps the commits."}]',
};

test("an implement answer with fields run into its summary is malformed as it is, and its fields are recovered", () => {
  for (const raw of [RUN_INTO_SUMMARY, QUESTION_INTO_SUMMARY, MERGED_AS_INTO_SUMMARY]) {
    assert.equal(asImplement(raw), null);
    const { value, recovered } = recoverFields(raw);
    assert.ok(recovered.includes("decisions"));
    assert.equal(hasMarkup(value), false);
    const answer = asImplement(value);
    assert.ok(answer);
    assert.doesNotMatch(answer.summary, /parameter|<\/summary>/);
  }
  assert.deepEqual(asImplement(recoverFields(RUN_INTO_SUMMARY).value)?.decisions, [{ question: "Which value should the test assert?", chosen: "0.06", others: ["6"], why: "The Item defines square metres." }]);
  assert.equal(asImplement(recoverFields(RUN_INTO_SUMMARY).value)?.summary, "Added src/area.js and its test.");
  const asked = asImplement(recoverFields(QUESTION_INTO_SUMMARY).value);
  assert.deepEqual(asked?.decision?.options, [{ label: "Keep 0.06", description: "Square metres." }, { label: "Return 6", description: "Not square metres." }]);
  assert.equal(asked?.decision?.recommendation, "Keep 0.06");
  assert.deepEqual(recoverFields(QUESTION_INTO_SUMMARY).recovered, ["question", "decisions"]);
});

test("fields run into a string are left there, and the answer stays malformed, when they cannot all be read", () => {
  // A field the answer already gives is never overwritten.
  const given = { ...RUN_INTO_SUMMARY, decisions: [{ question: "q", chosen: "c" }] };
  assert.deepEqual(recoverFields(given), { value: given, recovered: [] });
  // Broken JSON, text between the blocks, markup before them, or the field itself again.
  for (const summary of [
    'Done.</summary>\n<parameter name="decisions">[{"question":',
    'Done.</summary>\n<parameter name="mergedAs">x</parameter> and more\n<parameter name="decisions">[]',
    'Done.</decisions> then <parameter name="decisions">[]',
    'Done.</summary>\n<parameter name="summary">again',
  ]) {
    const raw = { done: true, summary };
    assert.deepEqual(recoverFields(raw).recovered, [], summary);
    assert.equal(asImplement(recoverFields(raw).value), null, summary);
  }
  // Markup nested in a recovered field is still caught.
  const nested = { done: false, summary: 'S.</summary>\n<parameter name="question">{"question":"Q?</question>","options":[]}' };
  assert.deepEqual(recoverFields(nested).recovered, ["question"]);
  assert.equal(asImplement(recoverFields(nested).value), null);
});

test("a question's or a decision's markup makes an implement answer malformed; an aboutOthers entry with markup is dropped alone", () => {
  assert.equal(asImplement({ done: false, summary: "s", question: { question: 'Which?</question>\n<parameter name="options">["a","b"]', options: [] } }), null);
  assert.equal(asImplement({ done: true, summary: "s", decisions: [{ question: "q", chosen: 'c</chosen><parameter name="why">w' }] }), null);
  const kept = asImplement({ done: true, summary: "s", aboutOthers: [{ item: "A-2", questions: [{ question: 'Q?</question><parameter name="options">[]' }] }] });
  assert.ok(kept);
  assert.equal(kept.aboutOthers, undefined);
});

test("a review answer with markup in a finding is malformed; an HTML closing tag in one is not", () => {
  assert.equal(asReview({ verdict: "approve", findings: [{ severity: "should", text: 'Rename it.</text>\n<parameter name="file">src/a.js' }] }), null);
  assert.equal(asReview({ verdict: "approve", findings: [{ severity: "should", text: "t</severity>" }] }), null);
  assert.equal(asReview({ verdict: "approve", findings: [{ severity: "should", text: "The page closes </summary> early." }] })?.findings.length, 1);
});

test("a triage answer with a field run into another string is recovered", () => {
  const raw = { ready: false, size: "large", paths: [], hidesDecision: false, riskReason: 'r</riskReason>\n<parameter name="notReadyReason">Size is large</notReadyReason>' };
  const { value, recovered } = recoverFields(raw);
  assert.deepEqual(recovered, ["notReadyReason"]);
  assert.equal(asTriage(value)?.notReadyReason, "Size is large");
});

test("a triage's rewrite that changes only whitespace, or only appends the Verification field again, is no change (decision 110)", () => {
  assert.equal(sameText("One.\n\nTwo. ", "One. Two."), true);
  assert.equal(sameText("One.", "One!"), false);
  assert.equal(changedRewrite("One.\n\nTwo.\n", "One.\nTwo.", undefined), "");
  assert.equal(changedRewrite("", "One.", undefined), "");
  assert.equal(changedRewrite(" One, two. ", "One.", undefined), "One, two.");
  const verification = "The table shows metres.";
  for (const appended of ["Verification: The table shows metres.", "## Verification\nThe table shows  metres.", "**Verification:** The table shows metres."]) {
    assert.equal(changedRewrite(`Show tides.\n\n${appended}`, "Show tides.", verification), "", appended);
  }
  // Cut from a rewrite that changes something else too, so the field is not shown twice.
  assert.equal(changedRewrite("Show tides in metres.\n\nVerification: The table shows metres.", "Show tides.", verification), "Show tides in metres.");
  // A different Verification text is the rewrite's own; a description that already holds it keeps it.
  assert.equal(withoutVerification("Show tides.\nVerification: something else.", verification), "Show tides.\nVerification: something else.");
  assert.equal(changedRewrite("Show tides.\nVerification: The table shows metres.", "Show tides.\nVerification: The table shows metres.", verification), "");
  assert.equal(changedRewrite("Show tides.", "Show tides.\nVerification: The table shows metres.", verification), "Show tides.");
});

// #248: a parked job reads the answers its questions got in the Item's log, from any machine's board.
const ASKED_AT = "2026-11-18T10:00:00.000Z";
const B = { who: "scopesoup", machine: "laptop-b", agent: true };
const decisions = ["Should it do part 1?", "Should it do part 2?"].map((question) => ({ question, options: ["yes", "no"], recommendation: "yes" }));
const parkedJob = (several: boolean): Job => ({
  item: { host: "metaBranch", kind: "work", id: "A-1" }, workspace: "w", branch: "scopesoup/A-1", failures: 0, fixRounds: 0, startedAt: ASKED_AT, parks: 2,
    triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision: decisions[0]!, ...(several ? { decisions } : {}) },
  at: { kind: "parked", step: "triage", parked: { as: "needs-decision", reason: several ? "Triage found 2 decisions" : decisions[0]!.question, at: ASKED_AT } },
});
const question = (text: string, set: string, at = ASKED_AT): LogRecord => ({ at, by: B, kind: "question", fields: { question: text, parked: "needs-decision", set } });
const answer = (text: string, fields: Record<string, unknown>): LogRecord => ({ at: "2026-11-18T10:00:30.000Z", by: { who: "Ada", machine: "laptop-a", agent: false }, kind: "answer", fields: { answer: text, ...fields } });
const open = (line: LogRecord): OpenQuestion => ({ at: line.at, by: line.by, question: line.fields.question as string, options: [] });

test("a parked job's questions in the log: open until an answer names them, by its time or its set", () => {
  const set = `2@${ASKED_AT}`;
  const one = question(decisions[0]!.question, set);
  assert.deepEqual(askedInLog(parkedJob(false), { log: [one], openQuestions: [open(one)] }), [{ question: decisions[0]!.question, open: true }]);
  const named = answer("yes", { to: ASKED_AT, toBy: B, toQuestion: decisions[0]!.question });
  assert.deepEqual(askedInLog(parkedJob(false), { log: [one, named], openQuestions: [] }), [{ question: decisions[0]!.question, open: false, answer: { text: "yes", by: "Ada" } }]);
  const bySet = answer("no", { toSet: set });
  assert.deepEqual(askedInLog(parkedJob(false), { log: [one, bySet], openQuestions: [] })?.[0]?.answer, { text: "no", by: "Ada" });
});

test("of several questions each is read on its own; another park's lines and other questions do not count", () => {
  const set = `2@${ASKED_AT}`;
  const [first, second] = decisions.map((each) => question(each.question, set));
  const asked = askedInLog(parkedJob(true), { log: [first!, second!, answer("no", { to: ASKED_AT, toQuestion: decisions[1]!.question })], openQuestions: [open(first!)] });
  assert.deepEqual(asked, [{ question: decisions[0]!.question, open: true }, { question: decisions[1]!.question, open: false, answer: { text: "no", by: "Ada" } }]);
  // An earlier park with the same set (a job made again) that asked something else is not this park's.
  assert.equal(askedInLog(parkedJob(false), { log: [question("Something else?", set), answer("yes", { toSet: set })], openQuestions: [] }), null);
  // Nothing in the log (a GitHub Item, or a post tried again): nothing to read.
  assert.equal(askedInLog(parkedJob(false), { openQuestions: [] }), null);
  assert.equal(askedInLog({ ...parkedJob(false), at: { kind: "parked", step: "triage", parked: { ...parkedOf(parkedJob(false))!, retry: "post" } } }, { log: [first!], openQuestions: [] }), null);
});

test("each move builds the case it goes to, keeping what that case carries and nothing else", () => {
  const base = { item: { host: "meta", kind: "work" as const, id: "A-1" }, workspace: "w", branch: "scopesoup/A-1", failures: 0, fixRounds: 0, startedAt: "2026-01-01T00:00:00Z" };
  const parked: JobParked = { as: "escalated", reason: "r", at: "t", byStep: true };
  const job: Job = { ...base, at: { kind: "implement", run: { is: "running", session: "s1" }, merge: true } };
  // Parking ends the session; the approval to merge stays for the answer.
  parkJob(job, parked);
  assert.deepEqual(job.at, { kind: "parked", step: "implement", parked, merge: true });
  release(job);
  assert.deepEqual(job.at, { kind: "implement", run: { is: "waiting" }, merge: true });
  // Staying at the step keeps what the step carries; another step does not.
  nextStep(job, "implement", "n");
  assert.deepEqual(job.at, { kind: "implement", run: { is: "waiting", notBefore: "n" }, merge: true });
  nextStep(job, "review", "n");
  assert.deepEqual(job.at, { kind: "review", run: { is: "waiting", notBefore: "n" } });
  // A Merge queue pick over a running review owes the hand-over once the session is over.
  startSession(job, "s2");
  toReview(job, true);
  assert.deepEqual(job.at, { kind: "review", run: { is: "running", session: "s2", owes: "hand-over" } });
  endSession(job);
  assert.deepEqual(job.at, { kind: "hand-over", step: "review" });
  assert.equal(owesHandOver(job), true);
  // A merged job keeps what it was parked as.
  handOverTaken(job);
  parkJob(job, { as: "queued", reason: "q", at: "t" });
  markMerged(job, "abc");
  assert.deepEqual(job.at, { kind: "merged", step: "review", sha: "abc", parked: { as: "queued", reason: "q", at: "t" } });
  assert.equal(shaOf(job), "abc");
});

test("a move asked of a case its callers are never in throws, and leaves the job as it was", () => {
  const base = { item: { host: "meta", kind: "work" as const, id: "A-1" }, workspace: "w", branch: "scopesoup/A-1", failures: 0, fixRounds: 0, startedAt: "t" };
  const parked: JobParked = { as: "escalated", reason: "r", at: "t" };
  const cases: Record<string, JobAt> = {
    running: atStep("review", { is: "running", session: "s1" }),
    parked: { kind: "parked", step: "implement", parked },
    owed: { kind: "hand-over", step: "review" },
    merged: { kind: "merged", step: "review", sha: "abc" },
  };
  const impossible: [string, keyof typeof cases, (job: Job) => void][] = [
    ["startSession", "running", (job) => startSession(job, "s2")],
    ["startSession", "parked", (job) => startSession(job, "s2")],
    ["wait", "owed", (job) => wait(job, "n")],
    ["nextStep", "parked", (job) => nextStep(job, "review", "n")],
    ["nextStep", "running", (job) => nextStep(job, "review", "n")],
    ["nextStep", "merged", (job) => nextStep(job, "review", "n")],
    ["nextStep", "owed", (job) => nextStep(job, "review", "n")],
    ["parkJob", "owed", (job) => parkJob(job, parked)],
    ["editParked", "running", (job) => editParked(job, parked)],
    ["editParked", "merged", (job) => editParked(job, parked)],
    ["release", "running", (job) => release(job)],
    ["toTriage", "owed", (job) => toTriage(job)],
    ["toReview", "merged", (job) => toReview(job, true)],
    ["oweHandOver", "parked", (job) => oweHandOver(job)],
    ["markMerged", "merged", (job) => markMerged(job, "def")],
    ["oweClose", "parked", (job) => oweClose(job, { sha: "abc" })],
  ];
  for (const [move, from, act] of impossible) {
    const job: Job = { ...base, at: cases[from]! };
    assert.throws(() => act(job), new RegExp(`^Error: ${move}: a job that is `), `${move} on ${from}`);
    assert.equal(job.at, cases[from], `${move} on ${from} leaves the job`);
  }
});

test("a stored job of an older shape is dropped with an event at the tick, and is never read", () => {
  const store = openStore(":memory:");
  const good: Job = { item: { host: "meta", kind: "work", id: "A-1" }, workspace: "w", branch: "scopesoup/A-1", failures: 0, fixRounds: 0, startedAt: "t", at: atStep("triage") };
  store.setValue("orchestrator.jobs", JSON.stringify({ "meta:work:A-1": good, "meta:work:A-2": { item: { host: "meta", kind: "work", id: "A-2" }, workspace: "w", branch: "scopesoup/A-2", step: "implement", sessionId: "s", failures: 0, fixRounds: 0, startedAt: "t" } }));
  assert.deepEqual(Object.keys(loadJobs(store)), ["meta:work:A-1"]);
  // A save before the tick keeps it, so it is not lost without its event.
  saveJobs(store, loadJobs(store));
  assert.ok("meta:work:A-2" in JSON.parse(store.getValue("orchestrator.jobs")!));
  store.tx(() => dropUnreadable(store, "2026-01-01T00:00:00.000Z"));
  assert.deepEqual(Object.keys(JSON.parse(store.getValue("orchestrator.jobs")!)), ["meta:work:A-1"]);
  assert.deepEqual(store.eventsAfter(0, 10).filter((event) => event.kind === "orchestrator.job_unreadable").map((event) => event.subject), ["meta:work:A-2"]);
  store.close();
});

test("the wait for a written description outlasts a session, a parked state and an owed hand-over, so the next step still waits for it", () => {
  const base = { item: { host: "meta", kind: "work" as const, id: "A-1" }, workspace: "w", branch: "scopesoup/A-1", failures: 0, fixRounds: 0, startedAt: "t" };
  const writing = { from: "old-hash", at: "2026-01-01T00:00:00.000Z" };
  const starts: { at: JobAt; leave: (job: Job) => void }[] = [
    { at: atStep("implement", { is: "running", session: "s1" }), leave: endSession },
    { at: { kind: "parked", step: "implement", parked: { as: "escalated", reason: "r", at: "t", byStep: true } }, leave: (job) => release(job) },
    { at: { kind: "hand-over", step: "implement" }, leave: handOverTaken },
  ];
  for (const start of starts) {
    const job: Job = { ...base, at: start.at };
    awaitText(job, writing);
    assert.deepEqual(writingOf(job), writing, start.at.kind);
    start.leave(job);
    assert.deepEqual(job.at, { kind: "implement", run: { is: "waiting", writing } }, start.at.kind);
  }
});
