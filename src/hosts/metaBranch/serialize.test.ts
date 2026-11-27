import assert from "node:assert/strict";
import { test } from "node:test";
import { parseItem } from "./item.ts";
import type { ItemFields } from "./item.ts";
import { parseLog } from "./log.ts";
import type { ItemInput, LineInput } from "./serialize.ts";
import { RefusedWrite, canonicalItem, serializeItem, serializeLogLine } from "./serialize.ts";

/** A small seeded generator, so a failure can be run again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pieces that have broken header formats before: line ends, separators, markers, invisible and wide characters. */
const PIECES = ["a", "Title", " ", "  ", "\t", "\n", "\r\n", "\r", ":", ": ", "-", "---", "#", ",", "[", "]", "\u0000", "\u0007", "\u007f", "\u2028", " ", "﻿", "é", "😀", "\ud800", "id: X-1", "\"", "\\", "../", "/"];

function text(next: () => number, most = 6): string {
  let out = "";
  const count = Math.floor(next() * most);
  for (let index = 0; index < count; index++) out += PIECES[Math.floor(next() * PIECES.length)];
  return out;
}

const pick = <T>(next: () => number, from: readonly T[]): T => from[Math.floor(next() * from.length)] as T;

function input(next: () => number): ItemInput {
  const value: ItemInput = { title: text(next), body: text(next, 12) };
  if (next() < 0.5) value.labels = [text(next, 3), text(next, 3)];
  if (next() < 0.3) value.parent = pick(next, ["A-1", "../A-1", "A/1", "", " B-2 "]);
  if (next() < 0.3) value.blockedBy = [pick(next, ["A-2", "a..b", "C_3"])];
  if (next() < 0.5) value.verification = text(next, 4);
  if (next() < 0.3) value.state = pick(next, ["todo", "doing", "done"] as const);
  if (next() < 0.2) value.lane = "backlog";
  if (next() < 0.3) value.extra = [[pick(next, ["team", "sprint", "title", "x y", "estimate"]), text(next, 3)]];
  return value;
}

test("item.md: whatever people type is written so that the reader gives back the same fields, or refused", () => {
  const next = random(28);
  let written = 0;
  let refused = 0;
  for (let round = 0; round < 3000; round++) {
    let fields: ItemFields;
    try {
      fields = canonicalItem(input(next));
    } catch (error) {
      assert.ok(error instanceof RefusedWrite, String(error));
      refused++;
      continue;
    }
    const id = pick(next, ["A-1", "Z_9", "b-12"]);
    let file = "";
    assert.doesNotThrow(() => (file = serializeItem(id, fields)), JSON.stringify(fields).replace(/[^ -~]/g, (c) => "U+" + c.charCodeAt(0).toString(16).padStart(4, "0")) + " " + id);
    const back = parseItem(file, id);
    assert.ok(back.ok, `${JSON.stringify(fields)} -> ${JSON.stringify(back)}`);
    assert.deepEqual(back.fields, fields);
    written++;
  }
  // Both sides are exercised.
  assert.ok(written > 300 && refused > 300, `${written} written, ${refused} refused`);
});

test("item.md: fields not in canonical form are refused, not changed on the way", () => {
  const base: ItemFields = { title: "Fine", state: "todo", labels: [], blockedBy: [], body: "", extra: [] };
  const refusedWith = (fields: Partial<ItemFields>, pattern: RegExp): void => {
    assert.throws(() => serializeItem("A-1", { ...base, ...fields }), pattern);
  };
  refusedWith({ title: "Two\nlines" }, /line break/);
  refusedWith({ title: "ends the header\n---" }, /line break/);
  refusedWith({ title: " padded" }, /white space/);
  refusedWith({ title: "" }, /empty/);
  refusedWith({ title: "bell\u0007" }, /control character/);
  refusedWith({ labels: ["a,b"] }, /comma or a bracket/);
  refusedWith({ parent: "../A-1" }, /not an item id/);
  refusedWith({ blockedBy: ["A/1"] }, /not an item id/);
  refusedWith({ extra: [["title", "again"]] }, /appear twice/);
  refusedWith({ extra: [["x-y", "z"]] }, /not a letter followed/);
  refusedWith({ body: "\n\nleading blank lines" }, /blank lines/);
  refusedWith({ body: "crlf\r\nline" }, /control character|\\r/);
  refusedWith({ state: "started" as ItemFields["state"] }, /not one of/);
  assert.throws(() => serializeItem("../A-1", base), /not an item id/);
  // Another header key is kept, in its place, as written.
  assert.equal(serializeItem("A-1", { ...base, extra: [["sprint", "7"], ["empty", ""]] }), "---\nid: A-1\ntitle: Fine\nstate: todo\nsprint: 7\nempty:\n---\n");
});

test("item.md: `lane: backlog` puts an Item in Backlog (decision 121); `todo` or no line is To do; another value is malformed", () => {
  const text = serializeItem("A-1", canonicalItem({ title: "Tide graph", lane: "backlog" }));
  assert.equal(text, "---\nid: A-1\ntitle: Tide graph\nstate: todo\nlane: backlog\n---\n");
  assert.deepEqual(parseItem(text, "A-1"), { ok: true, fields: { title: "Tide graph", state: "todo", lane: "backlog", labels: [], blockedBy: [], body: "", extra: [] } });
  const todo = parseItem("---\ntitle: Tide graph\nstate: todo\nlane: todo\n---\n", "A-1");
  assert.ok(todo.ok && todo.fields.lane === undefined);
  assert.deepEqual(parseItem("---\ntitle: Tide graph\nstate: todo\nlane: later\n---\n", "A-1"), { ok: false, problems: ['the lane "later" is not backlog or todo'] });
  assert.throws(() => serializeItem("A-1", { title: "Tide graph", state: "todo", lane: "later" as never, labels: [], blockedBy: [], body: "", extra: [] }), RefusedWrite);
});

test("log lines: what agents write reads back as the same object, or is refused", () => {
  const next = random(30);
  let written = 0;
  let refused = 0;
  for (let round = 0; round < 2000; round++) {
    const fields: Record<string, unknown> = {};
    const count = Math.floor(next() * 4);
    for (let index = 0; index < count; index++) {
      const key = pick(next, ["summary", "question", "options", "nested", "n", "until", "outcome", "role", "model", "at"]);
      fields[key] = pick(next, [() => text(next), () => [text(next), text(next)], () => ({ deep: text(next) }), () => next() * 1e6, () => null, () => undefined, () => "2026-11-18T10:00:00+02:00", () => text(next), () => (next() < 0.2 ? Number.NaN : 7)])();
    }
    const line: LineInput = {
      at: pick(next, ["2026-11-18T09:00:00Z", "2026-11-18T10:00:00.250+01:00", "2026-11-18T09:00:00Z", "yesterday"]),
      by: { who: pick(next, ["robin", "implement", "säm 😀", "", "a\nb"]), machine: pick(next, ["laptop-a", "laptop-b", "laptop-c", "x".repeat(101)]), agent: next() < 0.5 },
      kind: pick(next, ["session", "session", "assumption", "made-up_kind", "question", "claimed", "Session", "two words", "x".repeat(41)]),
      fields,
    };
    let written_: string;
    try {
      written_ = serializeLogLine(line);
    } catch (error) {
      assert.ok(error instanceof RefusedWrite, String(error));
      refused++;
      continue;
    }
    assert.ok(!written_.includes("\n"), "one line");
    const parsed = parseLog(`${written_}\n`);
    assert.equal(parsed.malformed.length, 0, written_);
    const entry = parsed.entries[0];
    assert.equal(entry?.kind, line.kind);
    assert.deepEqual(entry?.by, line.by);
    assert.equal(entry?.at, new Date(line.at).toISOString());
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || key === "until" || key === "to") continue;
      assert.deepEqual(entry?.data[key], value, key);
    }
    written++;
  }
  assert.ok(written > 150 && refused > 150, `${written} written, ${refused} refused`);
});

test("log lines: times are written in UTC with Z, and a line a reader would count as malformed is refused", () => {
  const by = { who: "robin", machine: "laptop-a", agent: false };
  assert.equal(
    serializeLogLine({ at: "2026-11-18T10:00:00+01:00", by, kind: "claimed", fields: { until: "2026-11-18T18:00:00+01:00" } }),
    '{"at":"2026-11-18T09:00:00Z","by":{"who":"robin","machine":"laptop-a","agent":false},"kind":"claimed","until":"2026-11-18T17:00:00Z"}',
  );
  assert.throws(() => serializeLogLine({ at: "2026-11-18T09:00:00Z", by, kind: "claimed" }), /claimed line would be malformed/);
  assert.throws(() => serializeLogLine({ at: "2026-11-18T09:00:00Z", by, kind: "review", fields: { sha: "abc", verdict: "pass" } }), /full commit id/);
  assert.throws(() => serializeLogLine({ at: "2026-11-18T09:00:00Z", by, kind: "session", fields: { by: "someone else" } }), /may not set `by`/);
  assert.throws(() => serializeLogLine({ at: "2026-11-18T09:00:00Z", by, kind: "session", fields: { summary: "x".repeat(20_000) } }), /over 16384 bytes/);
});

test("a lone surrogate is refused: stored as UTF-8 it would come back as U+FFFD", () => {
  const lone = String.fromCharCode(0xd800);
  assert.throws(() => canonicalItem({ title: `Broken ${lone} title` }), /not valid Unicode/);
  assert.throws(() => canonicalItem({ title: "Fine", body: `x${lone}y` }), /not valid Unicode/);
  assert.throws(() => serializeItem("A-1", { title: "Fine", state: "todo", labels: [lone], blockedBy: [], body: "", extra: [] }), /not valid Unicode/);
  // In a log line JSON writes it as an escape, which reads back exactly.
  const line = serializeLogLine({ at: "2026-11-18T09:00:00Z", by: { who: "robin", machine: "laptop-a", agent: false }, kind: "session", fields: { summary: lone } });
  assert.equal(parseLog(Buffer.from(line, "utf8").toString("utf8")).entries[0]?.data.summary, lone);
});
