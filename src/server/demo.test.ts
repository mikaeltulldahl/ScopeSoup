import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfigView } from "../config/edit.ts";
import { buildBoard } from "../core/board.ts";
import { buildItemPage } from "../core/item-page.ts";
import { LANES } from "../core/lanes.ts";
import { ref, T0 } from "../core/testing.ts";
import type { WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { overturnsFor } from "../orchestrator/overturns.ts";
import { openStore } from "../store/store.ts";
import { metaSettings } from "../config/metaSettings.ts";
import { createDemoChat, demoAssumptionHost, demoConfigOptions, seedDemo, tickDemo, writeDemoConfig } from "./demo.ts";
import { createServer } from "./server.ts";
import { buildUsageView } from "./usage.ts";
import { loadSnapshot } from "./snapshot.ts";
import { activityView } from "./activity.ts";
import { demoCommit, demoHistory, demoSettingsLog } from "./demoHistory.ts";

test("the demo data covers every lane, one batch being bisected, the triages' questions and a live session", () => {
  const store = openStore(":memory:");
  const now = new Date(T0);
  seedDemo(store, now);
  const board = buildBoard(loadSnapshot(store), now, undefined, { person: "mira", machine: "demo" });
  for (const lane of board.lanes) assert.ok(lane.cards.length > 0, lane.lane);
  assert.equal(board.lanes.length, LANES.length);
  // The queue engine works on one batch at a time, so the demo must not show two.
  assert.deepEqual(board.queue.batches.map((batch) => batch.status), ["bisecting"]);
  const bisecting = board.queue.batches.find((batch) => batch.status === "bisecting")!;
  assert.deepEqual(bisecting.members.map((each) => each.mark), ["good", "good", "in-doubt", "in-doubt"]);
  assert.equal(bisecting.members.filter((each) => each.suspect).length, 1);
  assert.deepEqual([board.queue.forming.length, board.queue.waiting.length, board.queue.recent.length], [0, 7, 2]);
  // Everyone's questions, the proposed restructuring and Mira's own hold (she is picked); Jonas's hold is on the board, named, but not in her list.
  assert.deepEqual(board.yourTurn.map((card) => card.label).sort(), ["#41", "#46", "#48", "#52", "#53"]);
  assert.deepEqual(board.lanes.flatMap((lane) => lane.cards).find((card) => card.label === "#49")?.person, { name: "jonas", mine: false });
  // A person is not tied to a machine: picked on the demo's board, Jonas has his laptop-b hold in his list.
  const jonas = buildBoard(loadSnapshot(store), now, undefined, { person: "jonas", machine: "demo" });
  assert.deepEqual(jonas.yourTurn.map((card) => card.label).sort(), ["#41", "#46", "#49", "#52", "#53"]);
  assert.deepEqual(jonas.lanes.flatMap((lane) => lane.cards).find((card) => card.label === "#49")?.person, { name: "jonas", mine: true });
  assert.ok(board.lanes.flatMap((lane) => lane.cards).some((card) => card.session?.live && card.session.model === "opus"));
  assert.deepEqual([board.status.runners.online, board.status.runners.total, board.status.usage?.windows.length], [2, 3, 2]);

  const before = store.lastSeq();
  tickDemo(store, new Date(now.getTime() + 20_000), 1);
  assert.ok(store.lastSeq() > before);
  store.close();
});

test("the demo's usage on the 30-day span has several 5-hour resets, a weekly reset and use by all four roles", () => {
  const store = openStore(":memory:");
  const now = new Date(T0);
  seedDemo(store, now);
  const view = buildUsageView(store, loadSnapshot(store), { span: "30d", ms: 30 * 24 * 3600_000 }, now);
  const five = view.windows[0]!;
  const week = view.windows[1]!;
  assert.ok(five.resets >= 10, `${five.resets} 5-hour resets`);
  assert.ok(week.resets >= 1, `${week.resets} weekly resets`);
  for (const key of ["implement", "review", "triage", "outside"] as const) assert.ok(five.shares[key] > 0.05, key);
  assert.ok(five.current && five.current.utilization > 0 && Date.parse(five.current.resetsAt) > now.getTime());
  assert.ok(five.plot.firstAt && Date.parse(five.plot.firstAt) > now.getTime() - 31 * 24 * 3600_000);
  store.close();
});

test("the demo's allowance section adds up the month's premium requests of the triage role against the allowance", () => {
  const store = openStore(":memory:");
  const now = new Date(T0);
  seedDemo(store, now);
  const span = { span: "7d", ms: 7 * 24 * 3600_000 };
  assert.equal(buildUsageView(store, loadSnapshot(store), span, now).allowances, undefined);
  const plan = { provider: "copilot", label: "Copilot", unit: "premium requests", setting: "copilot.monthlyRequests", allowance: 150, resetDay: 15, reserve: 0.1 };
  const views = buildUsageView(store, loadSnapshot(store), span, now, undefined, [plan]).allowances!;
  assert.equal(views.length, 1);
  const copilot = views[0]!;
  assert.equal(copilot.allowance, 150);
  assert.ok(copilot.used >= 20 && copilot.used < 150, `${copilot.used} requests`);
  assert.equal(copilot.used, copilot.byRole.triage.used);
  assert.equal(copilot.byRole.implement.sessions, 0);
  store.close();
});

test("the demo's item 68, put back in the queue from a failed batch, lists that batch and its runs", () => {
  const store = openStore(":memory:");
  const now = new Date(T0);
  seedDemo(store, now);
  const page = buildItemPage(loadSnapshot(store), ref("work", 68), now)!;
  assert.ok(page, "item 68 exists");
  assert.deepEqual(page.batches.map((each) => [each.batch.name, each.memberState]), [["batch 3", "requeued"]]);
  assert.deepEqual(page.runs.map((run) => run.status).sort(), ["failed", "failed", "passed"]);
  store.close();
});

test("the demo shows today's Scope Soup: triage questions and a rewrite, sessions to talk to, Settings, and none of the removed parts", async () => {
  const store = openStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-demo-test-"));
  try {
    const now = new Date(T0);
    seedDemo(store, now);
    const shared = metaSettings();
    const file = await writeDemoConfig(dir, shared);
    const chat = createDemoChat(store, file, dir, 10, shared);
    const snapshot = loadSnapshot(store);
    const board = buildBoard({ ...snapshot, level: 4 }, now);
    const items = snapshot.works.map((each: WorkItem) => each.ref);
    const pages = items.map((each) => buildItemPage(snapshot, each, now)!);
    const chats = items.map((each) => chat.view(refKey(each)));
    const settings = readConfigView(file, { ...demoConfigOptions(dir, shared), shared });
    // The Settings page shows the setup and the check question's candidates.
    assert.ok(settings.present && settings.config);
    if (settings.present && settings.config) {
      assert.deepEqual(settings.config.setupWatch, ["pnpm-lock.yaml"]);
      assert.equal(settings.config.setupCommand?.[0], "node");
      assert.ok((settings.mergeQueue?.checkCandidates ?? []).some((each) => each.from === "the Makefile"));
    }

    // Item 52 parked on two triage questions, one of them multi-select; item 41 on a triage rewrite.
    const questions = pages.find((page) => page.item.label === "#52")!.parked?.questions ?? [];
    assert.deepEqual(questions.map((each) => each.multiSelect === true), [false, true]);
    assert.ok(pages.find((page) => page.item.label === "#41")!.parked?.rewrite?.text);
    // Item 46: triage found it too large, so a person may press Implement anyway; the implementor's models per size are set.
    assert.match(pages.find((page) => page.item.label === "#46")!.parked?.reason ?? "", /^Triage: too large for one change/);
    assert.deepEqual(settings.present && settings.config?.roles.implement.modelBySize, { small: "haiku", large: "opus" });
    // Item 53 waits on a proposed restructuring: it keeps one part, and the others go elsewhere.
    const restructuring = pages.find((page) => page.item.label === "#53")!.proposal;
    assert.equal(restructuring?.original, "keeps");
    assert.deepEqual(restructuring?.parts.map((part) => part.goes), ["original", "child", "into", "related"]);
    // Item 66 has a triage, an implementor (resumed once) and two reviewers to talk to, and nothing runs on it; item 58's implementor runs.
    const of = (id: number) => chat.view(refKey(ref("work", id)));
    assert.deepEqual(of(66).sessions.map((each) => each.role), ["review", "implement", "review", "triage"]);
    // Its Rounds table: two reviews sent it back, the implementor was resumed with the findings. Item 36 merged at level 4.
    const rounds = pages.find((page) => page.item.label === "#66")!.rounds;
    assert.deepEqual(rounds.map((row) => [row.step, row.resumed ?? ""]), [
      ["triage", ""], ["implement", ""], ["review", ""], ["implement", "with the review's findings"], ["review", ""],
    ]);
    assert.deepEqual(rounds.map((row) => row.session), ["t-66", "i-66", "r-66", "i-66b", "r-66b"]);
    assert.deepEqual(rounds[2]!.findings.map((each) => each.severity), ["must", "should"]);
    assert.deepEqual(pages.find((page) => page.item.label === "#36")!.rounds.map((row) => row.step), ["triage", "implement", "review", "check", "implement", "review", "check", "merged"]);
    assert.equal(of(66).blocked, undefined);
    assert.match(of(58).blocked ?? "", /running the implement session/);
    // Settings shows the level picker on the demo's own configuration.
    assert.ok(settings.present);
    assert.deepEqual([settings.config?.level, settings.config?.machineName, settings.levels?.length], [4, "demo", 5]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 2);

    const shown = JSON.stringify({ board, pages, chats, settings });
    for (const removed of [/approv(al|e it)/i, /\brisk/i, /checklist/i, /\bfix (role|session)/i, /invite/i, /dry ?run/i]) assert.doesNotMatch(shown, removed);

    // A message to a session gets the canned reply.
    const sent = await chat.send(refKey(ref("work", 66)), "agent-i-66", "Keep the row hidden in polar night.");
    assert.ok(sent.ok, JSON.stringify(sent));
    await chat.idle();
    const turns = of(66).sessions.find((each) => each.role === "implement")!.turns;
    assert.match(turns.at(-1)?.reply ?? "", /Understood/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the demo's item 63 has two decisions its implementor took itself, open on the board and its page; Accept works, and Overturn goes into its running review", async () => {
  const store = openStore(":memory:");
  const now = new Date(T0);
  seedDemo(store, now);
  const board = buildBoard(loadSnapshot(store), now);
  assert.deepEqual(board.lanes.flatMap((lane) => lane.cards).filter((card) => card.openDecisions).map((card) => [card.label, card.openDecisions]), [["#63", 2]]);
  const page = buildItemPage(loadSnapshot(store), refKey(ref("work", 63)), now);
  // The page lists them oldest first: the one answered earlier, then the two open ones (the same time, so by id).
  assert.deepEqual(page?.assumptions.map((each) => !!each.settled), [true, false, false]);
  const host = demoAssumptionHost(store);
  const [, first, second] = page!.assumptions;
  // Both picks in one Send: nothing is settled before it.
  const server = createServer({ store, port: 0, now: () => now, assumptions: [host] });
  const base = (await server.start()).url;
  let sent: { settled: { id: string; verdict: string; work?: boolean }[] };
  try {
    const response = await fetch(`${base}/api/decisions`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "po" }, body: JSON.stringify({ ref: refKey(ref("work", 63)), decisions: [{ id: first!.id, action: "accept" }, { id: second!.id, action: "overturn", answer: "Mixed in by score" }] }) });
    assert.equal(response.status, 200);
    sent = (await response.json()) as typeof sent;
  } finally {
    await server.stop();
  }
  const after = store.get<WorkItem>(ref("work", 63))!;
  assert.deepEqual(after.assumptions?.map((each) => each.settled?.verdict), ["accepted", "accepted", "overturned"]);
  // Its change has not merged: no new Item, the answer is kept for its implementor, and the verdict says so.
  assert.deepEqual(sent.settled.map((each) => [each.verdict, each.work]), [["accepted", undefined], ["overturned", true]]);
  assert.equal(after.assumptions?.[2]?.settled?.work, true);
  assert.deepEqual(overturnsFor(store, refKey(ref("work", 63))).map((each) => each.answer), ["Mixed in by score"]);
  store.close();
});

test("the demo's History has synthetic activity of every kind and a commit history linked to its Items", () => {
  const store = openStore(":memory:");
  const now = new Date(T0);
  seedDemo(store, now);
  const view = activityView(store, demoSettingsLog([], now), now);
  const kinds = new Set(view.rows.map((row) => row.kind));
  for (const kind of ["item", "triage", "question", "decision", "session", "merge", "batch", "switch", "upgrade", "settings"] as const) assert.ok(kinds.has(kind), kind);
  assert.ok(view.rows.every((row, index) => index === 0 || Date.parse(view.rows[index - 1]!.at) >= Date.parse(row.at)), "newest first");
  // Everyone pressed the switches as a person, never as "someone".
  assert.ok(view.rows.filter((row) => row.kind === "switch").every((row) => row.who !== "someone"));

  const history = demoHistory(store, now, 30);
  assert.ok(history.available);
  if (!history.available) return;
  assert.equal(history.commits.length, 30);
  assert.equal(history.more, true);
  const tip = history.commits.find((each) => each.refs.includes("main"))!;
  // #58's branch starts at the tip of main: named as starting there, not merged, and the tip is #33's merge.
  assert.deepEqual([tip.item, tip.merged, tip.starts], ["demo:work:33", true, ["scopesoup/58"]]);
  const sunrise = history.commits.find((each) => each.refs.includes("scopesoup/66"))!;
  assert.deepEqual([sunrise.onMain, sunrise.item, sunrise.merged], [false, "demo:work:66", undefined]);
  for (const id of ["30", "31", "33", "36"]) assert.ok(history.commits.some((each) => each.item === `demo:work:${id}` && each.merged), id);
  const opened = demoCommit(tip.sha, now);
  assert.ok(opened.available && opened.files.length === 1);
  store.close();
});
