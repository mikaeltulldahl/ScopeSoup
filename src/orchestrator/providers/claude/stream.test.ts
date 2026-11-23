import assert from "node:assert/strict";
import { test } from "node:test";
import { createStreamParser, describeTool, isLimitHit, objectsOnLine, shortPath, usageFromEvent } from "./stream.ts";
import type { StreamEvent } from "./stream.ts";

const NOW = "2026-11-18T10:00:00.000Z";
const FIVE = Date.parse("2026-11-18T13:00:00Z") / 1000;
const WEEK = Date.parse("2026-11-23T00:00:00Z") / 1000;

const init = { type: "system", subtype: "init", session_id: "abc-123", model: "claude-test", tools: [] };
const text = { type: "assistant", message: { content: [{ type: "text", text: "Reading the item.\nThen the code." }] } };
const tool = { type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Bash", input: { command: "git diff main...HEAD" } }] } };
const unified = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed", resetsAt: FIVE, rateLimitType: "five_hour", isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.09, resetsAt: FIVE, status: "allowed" },
      seven_day: { utilization: 0.32, resetsAt: WEEK, status: "allowed" },
    },
  },
};
const result = {
  type: "result", subtype: "success", is_error: false, result: "done", structured_output: { ready: true },
  session_id: "abc-123", num_turns: 3, total_cost_usd: 0.0123, terminal_reason: "completed",
};

function ndjson(...objects: unknown[]): string {
  return objects.map((object) => JSON.stringify(object)).join("\n") + "\n";
}

function run(input: string, chunk = input.length) {
  const parser = createStreamParser(() => NOW);
  const events: StreamEvent[] = [];
  for (let i = 0; i < input.length; i += chunk) events.push(...parser.push(input.slice(i, i + chunk)));
  events.push(...parser.end());
  return { events, summary: parser.summary() };
}

test("a clean stream gives the session id, the last action, usage and the result", () => {
  const { events, summary } = run(ndjson({ type: "active_goal" }, init, text, unified, tool, { type: "user", message: {} }, result));
  assert.deepEqual(events.map((event) => event.kind), ["other", "init", "action", "usage", "action", "other", "result"]);
  assert.equal(summary.sessionId, "abc-123");
  assert.equal(summary.lastAction, "running git diff main...HEAD");
  assert.equal(summary.malformed, 0);
  assert.equal(summary.lines, 7);
  assert.deepEqual(summary.result, {
    isError: false, hasStructuredOutput: true, structuredOutput: { ready: true }, subtype: "success", text: "done",
    costUsd: 0.0123, turns: 3, sessionId: "abc-123", terminalReason: "completed",
  });
  assert.deepEqual(summary.lastUsage, {
    at: NOW, status: "allowed", usingOverage: false,
    windows: [
      { kind: "five_hour", utilization: 0.09, resetsAt: "2026-11-18T13:00:00.000Z" },
      { kind: "seven_day", utilization: 0.32, resetsAt: "2026-11-23T00:00:00.000Z" },
    ],
  });
});

test("the commands the permission check refused are read from the result", () => {
  const denials = [
    { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "git push --force origin main" } },
    { tool_name: "WebFetch", tool_use_id: "t2", tool_input: { url: "https://example.invalid" } },
    "not an entry",
  ];
  const { summary } = run(ndjson(init, { ...result, permission_denials: denials }));
  assert.deepEqual(summary.result?.denied, ["git push --force origin main", "WebFetch"]);
  assert.equal(run(ndjson(init, { ...result, permission_denials: [] })).summary.result?.denied, undefined);
});

const CLONE = "C:\\proj\\data\\workspaces\\github_acme_7-a1b2c3d4";

test("a path inside the work clone is shown relative to it, with forward slashes", () => {
  assert.equal(shortPath(`${CLONE}\\web\\tsconfig.json`, CLONE), "web/tsconfig.json");
  assert.equal(shortPath(`${CLONE.toLowerCase()}\\web\\tsconfig.json`, CLONE), "web/tsconfig.json");
  assert.equal(shortPath("/work/clone/src/a.ts", "/work/clone/"), "src/a.ts");
  assert.equal(shortPath("/work/clone-other/a.ts", "/work/clone"), "/work/clone-other/a.ts");
  assert.equal(shortPath("/etc/hosts", "/work/clone"), "/etc/hosts");
});

test("a long path is cut to a fixed length, keeping its end", () => {
  const long = `/work/clone/${"deep/".repeat(30)}file.ts`;
  const short = shortPath(long, "/work/clone");
  assert.equal(short.length, 60);
  assert.ok(short.startsWith("…") && short.endsWith("deep/file.ts"));
});

test("tool names become words", () => {
  const words = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"].map((name) => describeTool(name, { file_path: "a.ts", command: "x", pattern: "p" }, "/r").split(" ")[0]);
  assert.deepEqual(words, ["reading", "editing", "writing", "running", "searching", "finding"]);
  assert.equal(describeTool("Read", { file_path: `${CLONE}\\web\\tsconfig.json` }, CLONE), "reading web/tsconfig.json");
  assert.equal(describeTool("Bash", { command: "pnpm check" }), "running pnpm check");
  assert.equal(describeTool("Grep", { pattern: "lastAction", path: "/r/src" }, "/r"), "searching lastAction in src");
  assert.equal(describeTool("WebFetch", { url: "https://example.test/" }), "webfetch https://example.test/");
  assert.equal(describeTool("TodoWrite", {}), "todowrite");
});

test("the parser gives the action relative to the work clone", () => {
  const read = { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `${CLONE}\\web\\tsconfig.json` } }] } };
  const parser = createStreamParser(() => NOW, CLONE);
  parser.push(ndjson(read));
  assert.equal(parser.summary().lastAction, "reading web/tsconfig.json");
});

test("chunk boundaries do not matter, and every event keeps its raw line", () => {
  const input = ndjson(init, text, result);
  const whole = run(input);
  const bytes = run(input, 1);
  assert.deepEqual(bytes.events, whole.events);
  assert.equal(whole.events[1]?.raw, JSON.stringify(text));
  assert.equal(whole.events[1]?.kind === "action" && whole.events[1].text, "Reading the item. Then the code.");
});

test("malformed lines are counted and the stream goes on", () => {
  const input = `not json at all\n${JSON.stringify(init)}\n{"type":"assistant","message":{"content":[{"type":"te\n[1,2,3]\n\n${JSON.stringify(result)}`;
  const { events, summary } = run(input);
  assert.deepEqual(events.map((event) => event.kind), ["malformed", "init", "malformed", "malformed", "result"]);
  assert.equal(summary.malformed, 3);
  assert.equal(summary.repaired, 0);
  assert.equal(summary.lines, 5);
  assert.equal(summary.result?.subtype, "success");
});

test("an object injected in the middle of a line is lifted out and the line survives", () => {
  const outer = JSON.stringify(text);
  const cut = outer.indexOf("Reading") + 4;
  const line = outer.slice(0, cut) + JSON.stringify(unified) + outer.slice(cut);
  const { events, summary } = run(`${JSON.stringify(init)}\n${line}\n${JSON.stringify(result)}\n`);
  assert.deepEqual(events.map((event) => event.kind), ["init", "action", "usage", "result"]);
  assert.equal(summary.malformed, 1);
  assert.equal(summary.repaired, 1);
  assert.equal(summary.lastAction, "Reading the item. Then the code.");
  assert.equal(summary.lastUsage?.windows.length, 2);
});

test("an injected object is recovered even when the line around it is lost", () => {
  const line = `{"type":"assistant","message":{"content":[{"type":"text","text":"cut ${JSON.stringify(unified)}`;
  const { events, summary } = run(line + "\n");
  assert.deepEqual(events.map((event) => event.kind), ["usage"]);
  assert.equal(summary.malformed, 1);
});

test("two objects glued on one line both come out, in order", () => {
  const { objects, clean } = objectsOnLine(JSON.stringify(init) + JSON.stringify(result));
  assert.equal(clean, false);
  assert.deepEqual(objects.map((object) => object.type), ["system", "result"]);
});

test("braces and quotes inside strings do not confuse the repair", () => {
  const tricky = { type: "rate_limit_event", note: 'a } "quoted" { brace \\', rate_limit_info: { status: "allowed" } };
  const outer = JSON.stringify(text);
  const line = outer.slice(0, 40) + JSON.stringify(tricky) + outer.slice(40);
  const { objects } = objectsOnLine(line);
  assert.deepEqual(objects.map((object) => object.type), ["assistant", "rate_limit_event"]);
});

test("rate_limit_event without unifiedWindows falls back to the top-level fields", () => {
  const sample = usageFromEvent({ rate_limit_info: { status: "allowed_warning", resetsAt: WEEK, rateLimitType: "seven_day", utilization: 0.86 } }, NOW);
  assert.deepEqual(sample, { at: NOW, status: "allowed_warning", windows: [{ kind: "seven_day", utilization: 0.86, resetsAt: "2026-11-23T00:00:00.000Z" }] });
});

test("utilization may be missing; the reset time alone still makes a window", () => {
  const sample = usageFromEvent({ rate_limit_info: { status: "allowed", resetsAt: FIVE, rateLimitType: "five_hour" } }, NOW);
  assert.deepEqual(sample?.windows, [{ kind: "five_hour", utilization: undefined, resetsAt: "2026-11-18T13:00:00.000Z" }]);
  const partial = usageFromEvent({ rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { resetsAt: FIVE }, seven_day: "nonsense" } } }, NOW);
  assert.deepEqual(partial?.windows, [{ kind: "five_hour", utilization: undefined, resetsAt: "2026-11-18T13:00:00.000Z" }]);
});

test("a rejection with no window type is placed by how far away the reset is", () => {
  assert.equal(usageFromEvent({ rate_limit_info: { status: "rejected", resetsAt: FIVE } }, NOW)?.windows[0]?.kind, "five_hour");
  assert.equal(usageFromEvent({ rate_limit_info: { status: "rejected", resetsAt: WEEK } }, NOW)?.windows[0]?.kind, "seven_day");
});

test("per-model windows and events without info add no shared window", () => {
  assert.deepEqual(usageFromEvent({ rate_limit_info: { status: "allowed", resetsAt: WEEK, rateLimitType: "seven_day_opus", utilization: 0.9 } }, NOW)?.windows, []);
  assert.equal(usageFromEvent({ type: "rate_limit_event" }, NOW), null);
  const { events } = run(ndjson({ type: "rate_limit_event" }));
  assert.equal(events[0]?.kind, "other");
});

test("an error result is read as an error, without structured output", () => {
  const { summary } = run(ndjson({ type: "result", subtype: "error_max_turns", is_error: false, num_turns: 20 }));
  assert.equal(summary.result?.isError, true);
  assert.equal(summary.result?.hasStructuredOutput, false);
});

test("a limit hit is told apart from other failures", () => {
  const rejected = usageFromEvent({ rate_limit_info: { status: "rejected", resetsAt: FIVE } }, NOW) ?? undefined;
  const allowed = usageFromEvent(unified, NOW) ?? undefined;
  assert.equal(isLimitHit({ isError: true, hasStructuredOutput: false, text: "You've hit your session limit · resets 3:45pm" }, allowed), true);
  assert.equal(isLimitHit({ isError: true, hasStructuredOutput: false, apiErrorStatus: 429 }, rejected), true);
  assert.equal(isLimitHit(undefined, rejected), true);
  assert.equal(isLimitHit({ isError: true, hasStructuredOutput: false, apiErrorStatus: 429, text: "Server is temporarily limiting requests" }, allowed), false);
  assert.equal(isLimitHit({ isError: false, hasStructuredOutput: true }, rejected), false);
});
