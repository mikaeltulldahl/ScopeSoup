import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRecord, RecordedAnswer } from "../model/types.ts";
import { EARLIER_SESSIONS, EARLIER_SUMMARY_CHARS, EARLIER_TEXT_CHARS, earlierText } from "./earlier.ts";
import { at, ref } from "./testing.ts";

const SCOPESOUP = { who: "scopesoup", agent: true };
const line = (minute: number, kind: string, fields: Record<string, unknown>): LogRecord => ({ at: at(minute), by: SCOPESOUP, kind, fields });
const item = ref("work", 7);

test("no session ended yet: no block", () => {
  assert.deepEqual(earlierText([line(0, "created", {})], [], { role: "triage" }), { text: "", shown: [] });
  // A session that was cut off or failed left nothing to go on.
  assert.equal(earlierText([line(1, "session", { role: "implement", outcome: "limit", summary: "Cut off." })], [], { role: "implement" }).text, "");
});

test("the newest sessions only, long texts clipped, and older answers left to the decided list", () => {
  const log: LogRecord[] = [];
  for (let n = 1; n <= EARLIER_SESSIONS + 2; n++) log.push(line(n * 2, "session", { role: "implement", outcome: "succeeded", summary: `Round ${n}. ${"x".repeat(EARLIER_SUMMARY_CHARS)}` }));
  log.push(line(40, "review", { verdict: "fail", findings: [`[must] a.ts: ${"y".repeat(EARLIER_TEXT_CHARS)}`] }));
  log.push(line(40, "session", { role: "review", outcome: "succeeded" }));
  const old: RecordedAnswer = { subject: item, question: "Old?", answer: "Yes.", by: "Ada", at: at(3) };
  const recent: RecordedAnswer = { subject: item, question: "New?", answer: "No.", by: "Ada", at: at(39) };
  const earlier = earlierText(log, [old, recent], { role: "implement" });
  const body = earlier.text.split("\n");
  assert.equal(body[0], "");
  assert.match(body[2]!, /^Earlier on this Item/);
  assert.equal(body[3], "<earlier>");
  assert.equal(body[4], "(3 earlier sessions left out)");
  assert.doesNotMatch(earlier.text, /Round [123]\./);
  assert.match(earlier.text, /Implement 4: Round 4\./);
  assert.equal(body.filter((each) => /^(Implement|Review) \d/.test(each)).length, EARLIER_SESSIONS);
  for (const each of body) assert.ok(each.length <= EARLIER_SUMMARY_CHARS + "Implement 10: ".length, each);
  const finding = body.find((each) => each.startsWith("  [must]"))!;
  assert.equal(finding.length, 2 + EARLIER_TEXT_CHARS);
  assert.ok(finding.endsWith("..."));
  // The answer given after the kept sessions began is shown in order; the older one stays with the item.
  assert.deepEqual(earlier.shown, [recent]);
  assert.match(earlier.text, /Implement 8: [^\n]*\nA person answered "New\?": No\.\nReview 1: asked for changes\./);
  assert.equal(body[body.length - 1], "</earlier>");
});
