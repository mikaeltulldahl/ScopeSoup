// The picks' requests on the meta ref (decision 104): one file a month, only a person's picks, answers only from the machine asked.

import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonl } from "./testRepo.ts";
import { isRequestsLog, readRequests, requestsFile, requestsFiles, requestState } from "./requests.ts";

const mira = { who: "mira", machine: "laptop-a", agent: false };
const soup = (machine: string) => ({ who: "scopesoup", machine, agent: true });
const pick = (id: string, extra: Record<string, unknown> = {}) => ({ at: "2026-11-25T10:00:00Z", by: mira, kind: "pick", id, item: "meta:work:A-2", for: "laptop-b", seen: "2026-11-25T09:00:00Z", steps: [{ kind: "move", to: "todo" }], ...extra });

test("one file a month, named by the line's time; this month's and last month's are read, across a year's end", () => {
  assert.equal(requestsFile("2026-11-25T10:00:00Z"), "requests/2026-11.jsonl");
  assert.deepEqual(requestsFiles("2027-01-03T00:00:00Z"), ["requests/2026-12.jsonl", "requests/2027-01.jsonl"]);
  assert.equal(isRequestsLog("requests/2026-11.jsonl"), true);
  assert.equal(isRequestsLog("requests/log.jsonl"), false);
});

test("only a person's pick of one move or Abandoned is a request; only Scope Soup on the machine asked answers it", () => {
  const read = readRequests(jsonl(
    pick("r1"),
    pick("forged", { by: soup("laptop-a") }),
    pick("claim", { steps: [{ kind: "claim" }] }),
    pick("two", { steps: [{ kind: "move", to: "todo" }, { kind: "state", state: "abandoned" }] }),
    pick("gone", { steps: [{ kind: "state", state: "abandoned" }] }),
    { at: "2026-11-25T10:01:00Z", by: mira, kind: "pick-done", request: "r1", done: ["moved"] },
    { at: "2026-11-25T10:01:00Z", by: soup("laptop-c"), kind: "pick-done", request: "r1", done: ["moved"] },
    { at: "2026-11-25T10:02:00Z", by: soup("laptop-b"), kind: "pick-refused", request: "gone", why: "no" },
  ));
  assert.deepEqual(read.map((request) => request.id), ["r1", "gone"]);
  assert.equal(read[0]!.answer, undefined);
  assert.equal(requestState(read[1]!, Date.parse("2026-11-25T10:03:00Z")), "refused");
});

test("Backlog for work on another machine is one request of two steps, the work dropped then the lane (decision 121)", () => {
  const [request] = readRequests(jsonl(pick("b1", { steps: [{ kind: "move", to: "todo" }, { kind: "lane", lane: "backlog" }] })));
  assert.deepEqual(request?.steps, [{ kind: "move", to: "todo" }, { kind: "lane", lane: "backlog" }]);
  assert.deepEqual(readRequests(jsonl(pick("b2", { steps: [{ kind: "lane", lane: "backlog" }, { kind: "move", to: "todo" }] }))), []);
  assert.deepEqual(readRequests(jsonl(pick("b3", { steps: [{ kind: "lane", lane: "todo" }] }))), []);
});

test("a request lapses 15 minutes after this machine first read it, or an hour after its own time", () => {
  const [request] = readRequests(jsonl(pick("r1")));
  const at = Date.parse("2026-11-25T10:00:00Z");
  assert.equal(requestState(request!, at + 20 * 60_000, at + 10 * 60_000), "pending");
  assert.equal(requestState(request!, at + 26 * 60_000, at + 10 * 60_000), "lapsed");
  assert.equal(requestState(request!, at + 61 * 60_000, at + 60 * 60_000), "lapsed");
});
