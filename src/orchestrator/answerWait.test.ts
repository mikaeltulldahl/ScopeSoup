import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "../store/store.ts";
import { snapshot, T0, work } from "../core/testing.ts";
import type { TickReport } from "./tick.ts";
import { desktopNotify, noteAnswerWait, onTickAnswerWait, answerWaitInput, answerWaitText, answerWaitTickHook } from "./answerWait.ts";
import type { WaitingEntry } from "./answerWait.ts";

const entries: WaitingEntry[] = ["1", "2", "3", "4", "5"].map((id) => ({ id, title: `Item ${id}`, reason: "Pick an option" }));

function setup() {
  const store = openStore(":memory:");
  const sent: { title: string; body: string }[] = [];
  const notify = async (title: string, body: string): Promise<void> => {
    sent.push({ title, body });
  };
  const events = () => store.eventsAfter(0, 50).filter((event) => event.kind.startsWith("orchestrator.")).map((event) => event.kind);
  return { store, sent, notify, events };
}

test("idle with Your turn non-empty: one notification, and none on the next tick of the stretch", async () => {
  const { store, sent, notify, events } = setup();
  assert.equal(await noteAnswerWait(store, notify, { idle: true, entries, at: "2026-11-20T10:15:00.000Z" }), true);
  assert.equal(await noteAnswerWait(store, notify, { idle: true, entries, at: "2026-11-20T10:16:00.000Z" }), false);
  assert.equal(sent.length, 1);
  assert.deepEqual(events(), ["orchestrator.answers_waiting"]);
  assert.match(sent[0]!.title, /5 items wait on you/);
  assert.match(sent[0]!.body, /1 Item 1; 2 Item 2; 3 Item 3; and 2 more/);
});

test("a new stretch notifies again after the wait ended", async () => {
  const { store, sent, notify } = setup();
  await noteAnswerWait(store, notify, { idle: true, entries, at: "2026-11-20T10:15:00.000Z" });
  await noteAnswerWait(store, notify, { idle: false, entries: [], at: "2026-11-20T10:16:00.000Z" });
  await noteAnswerWait(store, notify, { idle: true, entries: entries.slice(0, 1), at: "2026-11-20T10:17:00.000Z" });
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.title, /1 item waits on you/);
});

test("not idle, or nothing waits for an answer: nothing is sent", async () => {
  const { store, sent, notify } = setup();
  assert.equal(await noteAnswerWait(store, notify, { idle: false, entries, at: "2026-11-20T10:15:00.000Z" }), false);
  assert.equal(await noteAnswerWait(store, notify, { idle: true, entries: [], at: "2026-11-20T10:16:00.000Z" }), false);
  assert.equal(sent.length, 0);
});

test("a failing command is recorded and not retried in the same stretch", async () => {
  const { store } = setup();
  let calls = 0;
  const failing = async (): Promise<void> => {
    calls++;
    throw new Error("no notify-send");
  };
  await noteAnswerWait(store, failing, { idle: true, entries, at: "2026-11-20T10:15:00.000Z" });
  await noteAnswerWait(store, failing, { idle: true, entries, at: "2026-11-20T10:16:00.000Z" });
  assert.equal(calls, 1);
});

const tickAt = (extra: Partial<Pick<TickReport, "started" | "running">> = {}): Pick<TickReport, "at" | "started" | "running"> => ({ at: T0, started: [], running: 0, ...extra });

test("a tick where nothing starts and Your turn is non-empty records one notification; the next tick of the stretch none", async () => {
  const { store, sent, notify, events } = setup();
  const snap = snapshot({ works: [work(1, { needsDecision: true })] });
  for (let i = 0; i < 2; i++) await noteAnswerWait(store, notify, answerWaitInput(tickAt(), () => snap));
  assert.equal(sent.length, 1);
  assert.deepEqual(events(), ["orchestrator.answers_waiting"]);
  assert.match(sent[0]!.title, /1 item waits on you/);
});

test("answerWaitInput: not idle when something started or runs, and then the list is not even read", () => {
  const snap = () => {
    throw new Error("must not be read");
  };
  const extras: Partial<Pick<TickReport, "started" | "running">>[] = [
    { started: [{ item: "1", role: "implement", sessionId: "s1" }] },
    { running: 1 },
  ];
  for (const extra of extras) {
    assert.deepEqual(answerWaitInput(tickAt(extra), snap), { idle: false, entries: [], at: T0 });
  }
});

test("idle with nothing waiting on a person: no entries, nothing sent", async () => {
  const { store, sent, notify } = setup();
  const input = answerWaitInput(tickAt(), () => snapshot({ works: [] }));
  assert.equal(input.idle, true);
  assert.equal(input.entries.length, 0);
  assert.equal(await noteAnswerWait(store, notify, input), false);
  assert.equal(sent.length, 0);
});

test("onTickAnswerWait: idle ticks notify once, a busy tick ends the stretch, a throwing snapshot is swallowed", async () => {
  const { store, sent, notify } = setup();
  const snap = snapshot({ works: [work(1, { needsDecision: true })] });
  assert.equal(await onTickAnswerWait(store, notify, tickAt(), () => snap), true);
  assert.equal(await onTickAnswerWait(store, notify, tickAt(), () => snap), false);
  assert.equal(await onTickAnswerWait(store, notify, tickAt({ running: 1 }), () => snap), false);
  assert.equal(await onTickAnswerWait(store, notify, tickAt(), () => snap), true);
  assert.equal(sent.length, 2);
  const broken = () => {
    throw new Error("no snapshot");
  };
  assert.equal(await onTickAnswerWait(store, notify, tickAt(), broken), false);
});

test("answerWaitTickHook (as main.ts installs it): a tick report notifies once per stretch", async () => {
  const { store, sent, notify } = setup();
  const snap = snapshot({ works: [work(1, { needsDecision: true })] });
  const hook = answerWaitTickHook(store, notify, () => snap);
  assert.equal(await hook(tickAt()), true);
  assert.equal(await hook(tickAt()), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.body, /1 /);
});

test("desktopNotify picks the platform's tool and passes the text in the environment only", async () => {
  const cases: { platform: NodeJS.Platform; file: string; first: string }[] = [
    { platform: "win32", file: "powershell.exe", first: "-NoProfile" },
    { platform: "darwin", file: "osascript", first: "-e" },
    { platform: "linux", file: "notify-send", first: "T <&> \"x\"" },
  ];
  for (const c of cases) {
    const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const notify = desktopNotify(c.platform, async (file, args, env) => {
      calls.push({ file, args, env });
    });
    await notify("T <&> \"x\"", "B; $(rm)");
    assert.equal(calls.length, 1, c.platform);
    assert.equal(calls[0]!.file, c.file);
    assert.equal(calls[0]!.args[0], c.first);
    assert.equal(calls[0]!.env.SCOPESOUP_NOTE_TITLE, "T <&> \"x\"");
    assert.equal(calls[0]!.env.SCOPESOUP_NOTE_BODY, "B; $(rm)");
    if (c.platform !== "linux") assert.ok(!calls[0]!.args.some((a) => a.includes("$(rm)")), "text is not on the command line");
  }
});

test("desktopNotify rejects when the program fails, so the caller records it", async () => {
  const notify = desktopNotify("linux", async () => {
    throw new Error("spawn notify-send ENOENT");
  });
  await assert.rejects(() => notify("t", "b"), /ENOENT/);
});

test("the text names the count and at most three entries", () => {
  assert.equal(answerWaitText(entries.slice(0, 2)).body, "1 Item 1; 2 Item 2");
});

test("the idle note lists everyone's questions and the parked Items on hand-backs, not the items people hold", () => {
  const alice = { id: "alice@a", name: "alice on a" };
  const bob = { id: "bob@b", name: "bob on b" };
  const handback = (who: string, machine: string) => [{ at: T0, by: { who, machine, agent: false }, kind: "revision", fields: { sha: "a".repeat(40), branch: "scopesoup/x", handback: true } }];
  const parked = (id: number) => ({ subject: { host: "demo", kind: "work" as const, id: String(id) }, as: "handed-over" as const, reason: "merge it", at: T0 });
  const snap = snapshot({
    works: [work(1, { needsDecision: true }), work(2, { holder: { actor: alice } }), work(3, { log: handback("alice", "a") }), work(4, { log: handback("bob", "b") }), work(5, { holder: { actor: bob } })],
    parked: [parked(3), parked(4)],
  });
  const ids = answerWaitInput(tickAt(), () => snap).entries.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ["1", "3", "4"]);
});

test("holdStands: a person's hold never runs out; an agent's runs out at its until", async () => {
  const { holdStands } = await import("../model/people.ts");
  const at = Date.parse(T0);
  assert.equal(holdStands(undefined, at), false);
  assert.equal(holdStands({ actor: { bot: false }, until: "2000-01-01T00:00:00Z" }, at), true);
  assert.equal(holdStands({ actor: {} }, at), true);
  assert.equal(holdStands({ actor: { bot: true }, until: "2000-01-01T00:00:00Z" }, at), false);
  assert.equal(holdStands({ actor: { bot: true }, until: "2999-01-01T00:00:00Z" }, at), true);
  assert.equal(holdStands({ actor: { bot: true } }, at), true);
});
