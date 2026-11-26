import assert from "node:assert/strict";
import { test } from "node:test";
import { asImplement, asReview, asTriage, hasMarkup, recoverFields } from "./jobs.ts";

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
