import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { at, change, ref, session, T0, verdict, work } from "../core/testing.ts";
import type { BoardView, ItemPage, StatusView, UsageView } from "../core/views.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer, isLoopback } from "./server.ts";
import { refKey } from "../model/types.ts";
import { loadJobs, saveJobs } from "../orchestrator/jobs.ts";
import { loadSnapshot } from "./snapshot.ts";
import { loadAnswers } from "../store/answers.ts";
import { itemTextHash } from "../core/answerReuse.ts";
import { QUEUE_KEY, recordQueueNote, resumeRequested } from "../orchestrator/queueHealth.ts";
import { defaultConfig, initialState, step as queueStep } from "../queue/index.ts";

let store: Store;
let server: ScopeSoupServer;
let base: string;
let dir: string;
let refreshes = 0;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "scopesoup-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>board</title>");
  writeFileSync(join(dir, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "app-abc.css"), "body{}");
  store = openStore(":memory:");
  store.put(work(1, { title: "Decide the colour", needsDecision: true }), "sync", T0);
  store.put(work(2, { title: "Paint it", blockedBy: [ref("work", 1)] }), "sync", T0);
  store.put(change(20, [2], { verdicts: [verdict("review", "pass")] }), "sync", T0);
  store.setValue("runners", JSON.stringify([{ id: "r", name: "laptop", online: true, busy: false, labels: [], since: at(-5) }]));
  store.setValue("sync", JSON.stringify({ lastAt: at(-1) }));
  store.addUsageSample({ at: T0, windows: [{ kind: "five_hour", utilization: 0.4, resetsAt: at(60) }] });
  server = createServer({ store, staticDir: dir, now: () => new Date(T0), port: 0, heartbeatMs: 20, onRefresh: () => refreshes++ });
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** Opens the event stream and collects text until `until` matches or the time runs out. */
function stream(path: string, headers: Record<string, string>, until: RegExp): Promise<{ text: string; response: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const request = get(base + path, { headers }, (response) => {
      let text = "";
      const timer = setTimeout(() => finish(), 2000);
      const finish = () => {
        clearTimeout(timer);
        request.destroy();
        resolve({ text, response });
      };
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (until.test(text)) finish();
      });
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
  });
}

test("loadSnapshot reads objects, runners, usage, pause and sync", () => {
  const snapshot = loadSnapshot(store);
  assert.deepEqual([snapshot.works.length, snapshot.changes.length, snapshot.runners[0]?.name, snapshot.paused, snapshot.agents, snapshot.mergeQueue, snapshot.sync.lastAt], [2, 1, "laptop", true, "paused", "paused", at(-1)]);
  assert.equal(snapshot.usage?.windows[0]?.utilization, 0.4);
  const empty = openStore(":memory:");
  empty.setValue("runners", "not json");
  assert.deepEqual([loadSnapshot(empty).runners, loadSnapshot(empty).sync, loadSnapshot(empty).usage], [[], {}, null]);
  empty.close();
});

test("loadSnapshot lists the items whose job says the change merged", () => {
  const own = openStore(":memory:");
  const merged = work(5);
  const open = work(6);
  const job = (item: typeof merged, extra: object) => ({ item: item.ref, workspace: "w", branch: `scopesoup/${item.ref.id}`, step: "triage" as const, failures: 0, fixRounds: 0, startedAt: T0, ...extra });
  saveJobs(own, {
    [refKey(merged.ref)]: job(merged, { merged: "abc1234" }),
    [refKey(open.ref)]: job(open, {}),
  });
  assert.deepEqual(loadSnapshot(own).merged, [merged.ref]);
  own.close();
});

test("GET /api/board returns the view-model", async () => {
  const response = await fetch(`${base}/api/board`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const board = (await response.json()) as BoardView;
  assert.equal(board.now, T0);
  assert.deepEqual(board.lanes.map((lane) => lane.total), [0, 1, 0, 0, 1, 0, 0]);
  assert.deepEqual(board.yourTurn.map((card) => [card.label, card.unblocks]), [["#1", 1]]);
  assert.equal(board.status.runners.list[0]?.words, "online, idle for 5 min");
});

test("GET /api/item returns the item page, 400 without a ref, 404 for an unknown one", async () => {
  const page = (await (await fetch(`${base}/api/item?ref=${encodeURIComponent("demo:work:2")}`)).json()) as ItemPage;
  assert.deepEqual([page.item.title, page.lane, page.changes[0]?.label], ["Paint it", "queued", "#20"]);
  assert.equal((await fetch(`${base}/api/item`)).status, 400);
  const missing = await fetch(`${base}/api/item?ref=demo:work:404`);
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "ITEM_NOT_FOUND");
});

test("GET /api/status is compact", async () => {
  const status = (await (await fetch(`${base}/api/status`)).json()) as StatusView;
  assert.deepEqual(status.lanes, { blocked: 0, backlog: 1, "in-progress": 0, "in-review": 0, queued: 1, checking: 0, done: 0 });
  // Nothing was started: both read as paused.
  assert.deepEqual([status.yourTurn[0]?.ref, status.queue.waiting, status.paused, status.agents, status.mergeQueue], ["demo:work:1", 1, true, "paused", "paused"]);
});

test("GET /api/health answers ok, the store's seq and the injected time", async () => {
  const before = (await (await fetch(`${base}/api/health`)).json()) as { seq: number };
  const seq = store.appendEvent({ kind: "test.health", actor: "sync" }, T0);
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, seq, now: T0 });
  assert.equal(seq, before.seq + 1);
});

test("GET /api/usage attributes readings to sessions, reads tokens from streams, and refuses a bad span", async () => {
  const own = openStore(":memory:");
  const streams = mkdtempSync(join(tmpdir(), "scopesoup-usage-"));
  const result = (tokens: number) => JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0 } });
  writeFileSync(join(streams, "a.ndjson"), `{"type":"system"}\n${result(3000)}\n`);
  writeFileSync(join(streams, "b.ndjson"), `${result(1000)}\n`);
  const subject = ref("work", 1);
  own.put(session(1, subject, { role: "implement", startedAt: at(-60), finishedAt: at(0), streamPath: join(streams, "a.ndjson") }), "runner", T0);
  own.put(session(2, subject, { role: "review", startedAt: at(-60), finishedAt: at(0), streamPath: join(streams, "b.ndjson") }), "runner", T0);
  own.addUsageSample({ at: at(-60), windows: [{ kind: "five_hour", utilization: 0.1, resetsAt: at(120) }] });
  own.addUsageSample({ at: T0, windows: [{ kind: "five_hour", utilization: 0.5, resetsAt: at(120) }] });
  const usage = createServer({ store: own, now: () => new Date(T0), port: 0 });
  const url = (await usage.start()).url;
  try {
    const view = (await (await fetch(`${url}/api/usage?span=5h`)).json()) as UsageView;
    assert.deepEqual([view.span, view.sessions, view.withTokens], ["5h", 2, 2]);
    const five = view.windows.find((window) => window.kind === "five_hour")!;
    assert.ok(Math.abs(five.shares.implement - 0.3) < 1e-9);
    assert.ok(Math.abs(five.shares.review - 0.1) < 1e-9);
    assert.ok(five.methods.tokens > 0.39);
    assert.equal((await fetch(`${url}/api/usage`)).status, 200);
    assert.equal((await fetch(`${url}/api/usage?span=31d`)).status, 400);
    assert.equal(((await (await fetch(`${url}/api/usage?span=soon`)).json()) as { error: { code: string } }).error.code, "SPAN_INVALID");
  } finally {
    await usage.stop();
    own.close();
    rmSync(streams, { recursive: true, force: true, maxRetries: 3 });
  }
});

const post = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${base}${path}`, { method: "POST" });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const controlEvents = (after: number): [string, string, unknown][] =>
  store.eventsAfter(after, 50).filter((event) => event.kind.startsWith("control.")).map((event) => [event.kind, event.actor, (event.data as { via?: string } | undefined)?.via]);

test("Start agents and Pause agents set the agents switch and write one control event each; a repeat changes nothing", async () => {
  const before = store.lastSeq();
  assert.deepEqual(await post("/api/agents/start"), { status: 200, body: { agents: "started", mergeQueue: "paused", changed: true, paused: false } });
  assert.deepEqual((await post("/api/agents/start")).body.changed, false);
  assert.equal((await (await fetch(`${base}/api/status`)).json() as StatusView).agents, "started");
  assert.deepEqual(await post("/api/agents/pause"), { status: 200, body: { agents: "paused", mergeQueue: "paused", changed: true, paused: true } });
  assert.deepEqual((await post("/api/agents/pause")).body.changed, false);
  assert.deepEqual(controlEvents(before), [["control.agents_started", "board", "board"], ["control.agents_paused", "board", "board"]]);
});

test("Start merge queue and Pause merge queue set the merge switch and write one control event each", async () => {
  const before = store.lastSeq();
  assert.deepEqual(await post("/api/merge-queue/start"), { status: 200, body: { agents: "paused", mergeQueue: "started", changed: true, paused: true } });
  const board = (await (await fetch(`${base}/api/board`)).json()) as BoardView;
  assert.deepEqual([board.status.agents, board.status.mergeQueue], ["paused", "started"]);
  assert.deepEqual((await post("/api/merge-queue/pause")).body, { agents: "paused", mergeQueue: "paused", changed: true, paused: true });
  assert.deepEqual((await post("/api/merge-queue/pause")).body.changed, false);
  assert.deepEqual(controlEvents(before), [["control.merge_queue_started", "board", "board"], ["control.merge_queue_paused", "board", "board"]]);
});

test("Stop sets agents and the merge queue to 'stopped' at once, in one event; Pause agents and Pause merge queue keep it stopped; Start agents and Start merge queue are both needed again", async () => {
  await post("/api/agents/start");
  await post("/api/merge-queue/start");
  const before = store.lastSeq();
  assert.deepEqual(await post("/api/stop"), { status: 200, body: { agents: "stopped", mergeQueue: "stopped", changed: true, paused: true } });
  const stopped = store.eventsAfter(before, 10);
  assert.deepEqual(stopped.map((event) => [event.kind, event.actor, event.data]), [["control.stopped", "board", { via: "board", agents: "started", mergeQueue: "started" }]]);
  assert.deepEqual((await post("/api/stop")).body.changed, false);
  assert.deepEqual((await post("/api/agents/pause")).body, { agents: "stopped", mergeQueue: "stopped", changed: false, paused: true });
  assert.deepEqual((await post("/api/merge-queue/pause")).body, { agents: "stopped", mergeQueue: "stopped", changed: false, paused: true }, "Pause merge queue does not undo Stop");
  assert.equal(((await (await fetch(`${base}/api/status`)).json()) as StatusView).mergeQueue, "stopped");
  assert.equal(((await (await fetch(`${base}/api/status`)).json()) as StatusView).agents, "stopped");
  assert.deepEqual((await post("/api/merge-queue/start")).body, { agents: "stopped", mergeQueue: "started", changed: true, paused: true });
  assert.deepEqual((await post("/api/agents/start")).body, { agents: "started", mergeQueue: "started", changed: true, paused: false });
  await post("/api/merge-queue/pause");
  await post("/api/agents/pause");
});

test("the old /api/pause and /api/resume still work: pause is Pause agents and Pause merge queue, resume is Start agents and Start merge queue", async () => {
  const before = store.lastSeq();
  const resumed = await post("/api/resume");
  assert.deepEqual(resumed, { status: 200, body: { agents: "started", mergeQueue: "started", changed: true, paused: false } });
  const paused = await post("/api/pause");
  assert.deepEqual(paused, { status: 200, body: { agents: "paused", mergeQueue: "paused", changed: true, paused: true } });
  assert.deepEqual((await post("/api/pause")).body, { agents: "paused", mergeQueue: "paused", changed: false, paused: true });
  assert.equal(((await (await fetch(`${base}/api/board`)).json()) as BoardView).status.paused, true);
  assert.deepEqual(controlEvents(before), [
    ["control.agents_started", "board", "/api/resume"], ["control.merge_queue_started", "board", "/api/resume"],
    ["control.agents_paused", "board", "/api/pause"], ["control.merge_queue_paused", "board", "/api/pause"],
  ]);
});

test("POST /api/refresh answers 202 and calls the callback; other origins and methods are refused", async () => {
  const response = await fetch(`${base}/api/refresh`, { method: "POST" });
  assert.deepEqual([response.status, refreshes], [202, 1]);
  const before = store.lastSeq();
  for (const path of ["/api/agents/start", "/api/merge-queue/start", "/api/stop", "/api/pause", "/api/resume"]) {
    assert.equal((await fetch(`${base}${path}`, { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status, 403, path);
  }
  assert.deepEqual(controlEvents(before), []);
  assert.equal((await fetch(`${base}/api/board`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
});

test("the event stream sends live events with the store's seq as id, and heartbeats", async () => {
  const waiting = stream("/api/events", {}, /control\.paused[\s\S]*: ping/);
  await new Promise((done) => setTimeout(done, 50));
  const seq = store.appendEvent({ kind: "control.paused", actor: "board" }, T0);
  const { text, response } = await waiting;
  assert.match(response.headers["content-type"] ?? "", /text\/event-stream/);
  assert.ok(text.includes(`id: ${seq}\ndata: {"seq":${seq},"at":"${T0}","kind":"control.paused","actor":"board"}\n\n`), text);
  assert.match(text, /: ping\n\n/);
  // Nothing is replayed without Last-Event-ID.
  assert.equal(text.match(/^id: /gm)?.length, 1);
});

test("the event stream replays from Last-Event-ID, then goes live, without repeats", async () => {
  const first = store.appendEvent({ kind: "test.one", actor: "sync" }, T0);
  const second = store.appendEvent({ kind: "test.two", actor: "sync" }, T0);
  const waiting = stream("/api/events", { "Last-Event-ID": String(first - 1) }, /test\.three/);
  await new Promise((done) => setTimeout(done, 50));
  const third = store.appendEvent({ kind: "test.three", actor: "sync" }, T0);
  const { text } = await waiting;
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(ids, [first, second, third]);
});

test("a closed event stream is cleaned up", async () => {
  await stream("/api/events", {}, /connected/);
  await new Promise((done) => setTimeout(done, 100));
  let delivered = 0;
  const stop = store.onEvent(() => delivered++);
  store.appendEvent({ kind: "test.after", actor: "sync" }, T0);
  stop();
  assert.equal(delivered, 1);
  // No stream is left open: stopping a second server instance ends at once.
  const other = createServer({ store, port: 0, heartbeatMs: 10 });
  const { url } = await other.start();
  const open = get(`${url}/api/events`);
  open.on("error", () => {});
  await new Promise((done) => setTimeout(done, 50));
  await other.stop();
});

test("static files get their content types, pages fall back to index.html, traversal is refused", async () => {
  const index = await fetch(`${base}/`);
  assert.deepEqual([index.status, index.headers.get("content-type")], [200, "text/html; charset=utf-8"]);
  const script = await fetch(`${base}/assets/app-abc.js`);
  assert.deepEqual([script.headers.get("content-type"), script.headers.get("cache-control")], ["text/javascript; charset=utf-8", "public, max-age=31536000, immutable"]);
  assert.equal((await fetch(`${base}/assets/app-abc.css`)).headers.get("content-type"), "text/css; charset=utf-8");
  const page = await fetch(`${base}/queue`);
  assert.deepEqual([page.status, await page.text()], [200, "<!doctype html><title>board</title>"]);
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  const escape = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
  assert.doesNotMatch(await escape.text(), /root:/);
  assert.equal((await fetch(`${base}/`, { method: "HEAD" })).status, 200);
});

test("only loopback unless allowLan is set", () => {
  assert.deepEqual(["127.0.0.1", "localhost", "::1", "[::1]", "127.8.9.1"].map(isLoopback), [true, true, true, true, true]);
  assert.deepEqual(["0.0.0.0", "192.168.1.5", "::", "example.org"].map(isLoopback), [false, false, false, false]);
  assert.throws(() => createServer({ store, host: "0.0.0.0" }), /no login/);
  assert.doesNotThrow(() => createServer({ store, host: "0.0.0.0", allowLan: true }));
});

test("POST /api/answer records the answer, picks a put-down item up again, and shows both on the item page", async () => {
  const item = work(3, { title: "Name the harbour" });
  store.put(item, "sync", T0);
  const key = refKey(item.ref);
  const decision = { question: "Old name or new name?", options: ["Old", "New"], recommendation: "Old" };
  saveJobs(store, {
    [key]: {
      item: item.ref, workspace: "w3", branch: "scopesoup/3", step: "triage", failures: 0, fixRounds: 0, startedAt: T0,
      parked: { as: "needs-decision", reason: decision.question, at: T0 },
      triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision },
    },
  });
  const page = (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;
  assert.deepEqual([page.actor, page.parked?.as, page.parked?.canAnswer, page.parked?.decision?.options], ["anyone", "needs-decision", true, ["Old", "New"]]);
  assert.match(page.reason, /^Pick an option: Old name or new name\?/);
  const board = (await (await fetch(`${base}/api/board`)).json()) as BoardView;
  assert.ok(board.yourTurn.some((card) => card.key === key));

  const post = (body: unknown) => fetch(`${base}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
  assert.equal((await post({ ref: key, answer: "  " })).status, 400);
  assert.equal((await post({ ref: "fake:work:999", answer: "x" })).status, 404);
  const before = store.lastSeq();
  const answered = await post({ ref: key, answer: "Keep the old name." });
  assert.deepEqual([answered.status, await answered.json()], [200, { recorded: true, released: true }]);
  assert.deepEqual(store.eventsAfter(before, 10).map((event) => [event.kind, event.actor]), [["person.answered", "Ada"], ["orchestrator.job_released", "Ada"]]);
  assert.equal(loadJobs(store)[key], undefined);
  const stored = loadAnswers(store).filter((answer) => refKey(answer.subject) === key);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.textHash, itemTextHash(item));
  assert.deepEqual(stored[0]!.options, ["Old", "New"]);

  const after = (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;
  assert.equal(after.parked, undefined);
  assert.deepEqual(after.answers.map((answer) => [answer.question, answer.answer]), [["Old name or new name?", "Keep the old name."]]);
  // An answer on an item that is not put down is still kept, and releases nothing.
  assert.deepEqual(await (await post({ ref: key, answer: "And spell it with an å." })).json(), { recorded: true, released: false });
});

test("POST /api/answer with two open questions: the page lists both, the first answer does not release the item and the second does", async () => {
  const item = work(5, { title: "Price the ferry" });
  store.put(item, "sync", T0);
  const key = refKey(item.ref);
  const decisions = [
    { question: "Round up or down?", options: [{ label: "Up", description: "Never undercharge." }, { label: "Down", description: "Never overcharge." }], recommendation: "Down" },
    { question: "Which currency?", options: [{ label: "SEK", description: "Local." }, { label: "EUR", description: "Shared." }], recommendation: "SEK", context: "Tickets are sold in both." },
  ];
  saveJobs(store, {
    [key]: {
      item: item.ref, workspace: "w5", branch: "scopesoup/5", step: "triage", failures: 0, fixRounds: 0, startedAt: T0,
      parked: { as: "needs-decision", reason: "Triage found 2 decisions for a person before the work can start.", at: T0 },
      triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision: decisions[0], decisions },
    },
  });
  const pageOf = async () => (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;
  const page = await pageOf();
  assert.deepEqual(page.parked?.questions?.map((each) => [each.question, each.options.map((option) => (typeof option === "string" ? option : option.label)), each.recommendation, each.answer]), [
    ["Round up or down?", ["Up", "Down"], "Down", undefined],
    ["Which currency?", ["SEK", "EUR"], "SEK", undefined],
  ]);
  assert.equal(page.parked?.questions?.[1]?.context, "Tickets are sold in both.");
  assert.equal(page.parked?.canAnswer, true);

  const post = (body: unknown) => fetch(`${base}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
  // Which question is answered must be said, by index, and must exist.
  assert.equal((await post({ ref: key, answer: "Down" })).status, 400);
  assert.equal((await post({ ref: key, answer: "Down", question: -1 })).status, 400);
  assert.equal((await post({ ref: key, answer: "Down", question: "0" })).status, 400);
  assert.equal((await post({ ref: key, answer: "Down", question: 2, parkedAt: T0 })).status, 404);
  // The index is tied to the parked state the page read: without it, refused; from another parked, a 409.
  assert.equal((await post({ ref: key, answer: "Down", question: 0 })).status, 400);
  const otherParked = await post({ ref: key, answer: "Down", question: 0, parkedAt: at(-30) });
  assert.deepEqual([otherParked.status, ((await otherParked.json()) as { error: { code: string } }).error.code], [409, "PARKED_CHANGED"]);
  assert.equal(loadAnswers(store).filter((answer) => refKey(answer.subject) === key).length, 0, "a refused answer is not kept");

  const first = await post({ ref: key, answer: "EUR", question: 1, parkedAt: page.parked?.at });
  assert.deepEqual([first.status, await first.json()], [200, { recorded: true, released: false, open: 1 }]);
  assert.ok(loadJobs(store)[key]?.parked, "the item still parked");
  const between = await pageOf();
  assert.deepEqual(between.parked?.questions?.map((each) => each.answer), [undefined, "EUR"]);
  // A second answer to the same question is refused; the first stays.
  const again = await post({ ref: key, answer: "SEK", question: 1, parkedAt: T0 });
  assert.deepEqual([again.status, ((await again.json()) as { error: { code: string } }).error.code], [409, "ALREADY_ANSWERED"]);
  assert.deepEqual((await pageOf()).parked?.questions?.map((each) => each.answer), [undefined, "EUR"]);

  const before = store.lastSeq();
  const second = await post({ ref: key, answer: "Down", question: 0, parkedAt: T0 });
  assert.deepEqual([second.status, await second.json()], [200, { recorded: true, released: true, open: 0 }]);
  assert.deepEqual(store.eventsAfter(before, 10).map((event) => event.kind), ["person.answered", "orchestrator.job_released"]);
  assert.equal(loadJobs(store)[key], undefined);
  // Both answers are kept, each naming its question, for the next session.
  assert.deepEqual(loadAnswers(store).filter((answer) => refKey(answer.subject) === key).map((answer) => [answer.question, answer.answer, answer.options]), [
    ["Which currency?", "EUR", ["SEK: Local.", "EUR: Shared."]],
    ["Round up or down?", "Down", ["Up: Never undercharge.", "Down: Never overcharge."]],
  ]);
  assert.equal((await pageOf()).parked, undefined);
  // A stale page sends an index after the release: refused, and nothing is kept.
  const stale = await post({ ref: key, answer: "Up", question: 0, parkedAt: T0 });
  assert.deepEqual([stale.status, ((await stale.json()) as { error: { code: string } }).error.code], [409, "NO_OPEN_QUESTIONS"]);
  assert.equal(loadAnswers(store).filter((answer) => refKey(answer.subject) === key).length, 2);
});

test("POST /api/answer: an old index after a re-triage, and an index on a single question, are refused", async () => {
  const item = work(6, { title: "Pick the ferry route" });
  store.put(item, "sync", T0);
  const key = refKey(item.ref);
  const option = (label: string) => ({ label, description: "" });
  const decisions = ["North or south?", "Stop at the island?", "Night crossings?"].map((question) => ({ question, options: [option("Yes"), option("No")], recommendation: "Yes" }));
  const parkAt = (when: string, list: typeof decisions) => saveJobs(store, {
    [key]: {
      item: item.ref, workspace: "w6", branch: "scopesoup/6", step: "triage", failures: 0, fixRounds: 0, startedAt: T0,
      parked: { as: "needs-decision", reason: "asks", at: when },
      triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision: list[0], decisions: list },
    },
  });
  const post = (body: unknown) => fetch(`${base}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
  const codeOf = async (response: Response) => [response.status, ((await response.json()) as { error?: { code: string } }).error?.code];
  const kept = () => loadAnswers(store).filter((answer) => refKey(answer.subject) === key).length;

  // Read on the first parked state; triage ran again and was parked on a new list at a later time.
  parkAt(at(-60), decisions.slice(0, 2));
  parkAt(T0, [decisions[2]!, decisions[0]!]);
  assert.deepEqual(await codeOf(await post({ ref: key, answer: "Yes", question: 1, parkedAt: at(-60) })), [409, "PARKED_CHANGED"]);
  assert.equal(loadJobs(store)[key]?.answered, undefined);

  // A single question: `question` is refused, and the answer without it is the old path.
  parkAt(T0, [decisions[0]!]);
  assert.deepEqual(await codeOf(await post({ ref: key, answer: "Yes", question: 0, parkedAt: T0 })), [409, "NO_OPEN_QUESTIONS"]);
  assert.equal(kept(), 0);
  // The page sends the parked state's time with a single answer too: an answer read on an earlier parked is refused.
  assert.deepEqual(await codeOf(await post({ ref: key, answer: "Yes", parkedAt: at(-60) })), [409, "PARKED_CHANGED"]);
  assert.equal(kept(), 0);
  const single = await post({ ref: key, answer: "Yes", parkedAt: T0 });
  assert.deepEqual([single.status, await single.json()], [200, { recorded: true, released: true }]);
});

test("POST /api/answer: a to naming the log line of one of several questions answers that question; another log question releases nothing", async () => {
  const option = (label: string) => ({ label, description: "" });
  const decisions = ["Paint or stain?", "Which colour?"].map((question) => ({ question, options: [option("A"), option("B")], recommendation: "A" }));
  const by = { who: "orchestrator", agent: true };
  const openQuestions = [
    { at: at(-3), by, question: "Paint or stain?", options: decisions[0]!.options },
    { at: at(-2), by, question: "Which colour?", options: decisions[1]!.options },
    { at: at(-1), by: { who: "Ada", agent: false }, question: "Who buys the paint?", options: [] },
  ];
  const item = work(7, { title: "Paint the boathouse", needsDecision: true, openQuestions });
  store.put(item, "sync", T0);
  const key = refKey(item.ref);
  saveJobs(store, {
    [key]: {
      item: item.ref, workspace: "w7", branch: "scopesoup/7", step: "triage", failures: 0, fixRounds: 0, startedAt: T0,
      parked: { as: "needs-decision", reason: "asks", at: T0 },
      triage: { ready: true, size: "small", paths: [], hidesDecision: true, decision: decisions[0], decisions },
    },
  });
  const post = (body: unknown) => fetch(`${base}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
  // A question in the log that is not one of the several: kept, counts for none.
  const other = await post({ ref: key, answer: "The yard does.", to: at(-1) });
  assert.deepEqual([other.status, await other.json()], [200, { recorded: true, released: false, open: 2 }]);
  assert.equal(loadJobs(store)[key]?.answered, undefined);
  // The log line of question 2: it counts as question 2, on the page and in the job.
  const second = await post({ ref: key, answer: "B", to: at(-2) });
  assert.deepEqual([second.status, await second.json()], [200, { recorded: true, released: false, open: 1 }]);
  const page = (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;
  assert.deepEqual(page.parked?.questions?.map((each) => each.answer), [undefined, "B"]);
  // Answering it again, by index or by its log line, is refused.
  assert.equal((await post({ ref: key, answer: "A", question: 1, parkedAt: T0 })).status, 409);
  assert.equal((await post({ ref: key, answer: "A", to: at(-2) })).status, 409);
  const first = await post({ ref: key, answer: "A", to: at(-3) });
  assert.deepEqual([first.status, await first.json()], [200, { recorded: true, released: true, open: 0 }]);
});

test("a person-approval endpoints are gone: POST /api/approve and /api/send-back are not found", async () => {
  for (const path of ["/api/approve", "/api/send-back"]) {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify({ ref: "fake:work:4", note: "x" }) });
    assert.equal(response.status, 404, path);
  }
});

test("POST /api/start-over drops a job parked on an implement question, offers the button only there, and refuses the rest", async () => {
  const item = work(4, { title: "Rename the dock" });
  store.put(item, "sync", T0);
  const key = refKey(item.ref);
  const post = (body: unknown) => fetch(`${base}/api/start-over`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
  const pageOf = async () => (await (await fetch(`${base}/api/item?ref=${key}`)).json()) as ItemPage;
  const job = { item: item.ref, workspace: "w4", branch: "scopesoup/4", step: "implement", failures: 0, fixRounds: 3, startedAt: T0 } as const;

  assert.equal((await post({})).status, 400);
  assert.equal((await post({ ref: "fake:work:999" })).status, 404);
  // Nothing parked: refused.
  assert.equal((await post({ ref: key })).status, 409);

  // Steps and kinds where an answer does not resume a step get no button, and are refused.
  saveJobs(store, { [key]: { ...job, step: "triage", parked: { as: "needs-decision", reason: "which name?", at: T0 } } });
  assert.equal((await pageOf()).parked?.canStartOver, undefined);
  assert.equal(loadSnapshot(store).parked?.find((parked) => refKey(parked.subject) === key)?.canStartOver, undefined);
  assert.equal((await post({ ref: key })).status, 409);
  saveJobs(store, { [key]: { ...job, parked: { as: "needs-decision", reason: "split?", at: T0 }, proposal: { reason: "too large", parts: [{ title: "Part one", description: "", verification: "" }] } } });
  assert.equal((await pageOf()).parked?.canStartOver, undefined);
  assert.equal((await post({ ref: key })).status, 409);
  saveJobs(store, { [key]: { ...job, parked: { as: "handed-over", reason: "The session opened a pull request.", at: T0 } } });
  assert.equal((await pageOf()).parked?.canStartOver, undefined);
  assert.equal((await post({ ref: key })).status, 409);
  assert.ok(loadJobs(store)[key]);

  // An escalation the hand-over or a closed change raised (the step is still implement) does not resume the step.
  saveJobs(store, { [key]: { ...job, parked: { as: "escalated", reason: "The change was closed without being merged.", at: T0 } } });
  assert.equal((await pageOf()).parked?.canStartOver, undefined);
  assert.equal((await post({ ref: key })).status, 409);

  // An escalation the implement step itself raised offers it, and pressing it drops the job.
  saveJobs(store, { [key]: { ...job, parked: { as: "escalated", reason: "git commit was refused", at: T0, byStep: true } } });
  assert.equal((await pageOf()).parked?.canStartOver, true);
  assert.equal(loadSnapshot(store).parked?.find((parked) => refKey(parked.subject) === key)?.canStartOver, true);
  const started = await post({ ref: key });
  assert.deepEqual([started.status, await started.json()], [200, { started: true }]);
  assert.equal(loadJobs(store)[key], undefined);
  assert.equal((await pageOf()).parked, undefined);
  assert.equal((await post({ ref: key })).status, 409);
});

test("POST /api/queue/resume asks the next tick to resume a paused queue, is refused otherwise and from another origin, and shows on the board", async () => {
  const own = openStore(":memory:");
  const second = createServer({ store: own, now: () => new Date(T0), port: 0, heartbeatMs: 20 });
  const url = (await second.start()).url;
  try {
    const refused = await fetch(`${url}/api/queue/resume`, { method: "POST" });
    assert.equal(refused.status, 409);
    const state = queueStep(initialState("a".repeat(40)), { kind: "pause", reason: "the host refused the push", by: "queue" }, defaultConfig, T0).state;
    own.setValue(QUEUE_KEY, JSON.stringify({ v: 1, state, outbox: [], ready: [] }));
    recordQueueNote(own, T0, "flake", "test/a.test.js failed and passed on a rerun.");
    const board = (await (await fetch(`${url}/api/board`)).json()) as BoardView;
    assert.equal(board.queue.health?.paused?.reason, "the host refused the push");
    assert.equal(board.queue.health?.notes[0]?.kind, "flake");
    assert.equal((await fetch(`${url}/api/queue/resume`, { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status, 403);
    assert.equal(resumeRequested(own), false);
    const ok = await fetch(`${url}/api/queue/resume`, { method: "POST" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { requested: true });
    assert.equal(resumeRequested(own), true);
    assert.equal(own.eventsAfter(0, 10).filter((event) => event.kind === "control.queue_resume").length, 1);
  } finally {
    await second.stop();
    own.close();
  }
});

test("GET and POST /api/chat: the item's sessions and the chat, a message passed on, refusals with their reasons", async () => {
  const own = openStore(":memory:");
  const item = work(7, { title: "Talk about it" });
  own.put(item, "sync", T0);
  const key = refKey(item.ref);
  const sent: string[] = [];
  const view = { now: T0, sessions: [{ agentSession: "agent-1", role: "implement" as const, startedAt: T0, turns: [] }] };
  const chat = {
    view: (ref: string) => (ref === key ? view : assert.fail(ref)),
    async send(ref: string, session: string, message: string) {
      if (message === "busy") return { ok: false as const, status: 409, code: "CHAT_REFUSED", message: "Scope Soup is running the review session on this Item." };
      sent.push(`${ref} ${session} ${message}`);
      return { ok: true as const, turn: { id: "c1", at: T0, agentSession: session, role: "implement" as const, message } };
    },
  };
  const second = createServer({ store: own, now: () => new Date(T0), port: 0, chat });
  const bare = createServer({ store: own, now: () => new Date(T0), port: 0 });
  const url = (await second.start()).url;
  const bareUrl = (await bare.start()).url;
  const post = (base: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada", ...headers }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await fetch(`${url}/api/chat?ref=${key}`)).json(), view);
    assert.equal((await fetch(`${url}/api/chat?ref=fake:work:999`)).status, 404);
    assert.equal((await fetch(`${url}/api/chat`)).status, 400);
    const ok = await post(url, { ref: key, session: "agent-1", message: "Why?" });
    assert.equal(ok.status, 202);
    assert.deepEqual(sent, [`${key} agent-1 Why?`]);
    const refused = await post(url, { ref: key, session: "agent-1", message: "busy" });
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: { message: string } }).error.message, /review session/);
    assert.equal((await post(url, { ref: key, message: "no session" })).status, 400);
    assert.equal((await post(url, { ref: key, session: "agent-1", message: "x" }, { Origin: "https://elsewhere.example" })).status, 403);
    // Board-only mode runs no sessions: nothing to talk to.
    const none = (await (await fetch(`${bareUrl}/api/chat?ref=${key}`)).json()) as { sessions: unknown[]; blocked: string };
    assert.deepEqual(none.sessions, []);
    assert.match(none.blocked, /no project configuration/);
    assert.equal((await post(bareUrl, { ref: key, session: "agent-1", message: "Why?" })).status, 409);
    assert.equal(sent.length, 1);
  } finally {
    await second.stop();
    await bare.stop();
    own.close();
  }
});
