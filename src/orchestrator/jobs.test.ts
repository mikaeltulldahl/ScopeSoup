import assert from "node:assert/strict";
import { test } from "node:test";
import { asImplement, asTriage } from "./jobs.ts";

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
