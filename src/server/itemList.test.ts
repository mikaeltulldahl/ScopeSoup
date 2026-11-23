// The item list endpoint filters and searches a snapshot with open and closed items. Synthetic data.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { at, change, ref, T0, work } from "../core/testing.ts";
import type { ItemListView } from "../core/views.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

let store: Store;
let server: ScopeSoupServer;
let base: string;

const mine = { id: "me@laptop", name: "me on laptop" };
const created = (by: { id: string; name: string }) => [{ at: T0, by, kind: "created", text: "created" }];

before(async () => {
  store = openStore(":memory:");
  const put = (item: ReturnType<typeof work>) => store.put(item, "sync", T0);
  put(work(1, { title: "Paint the fence", body: "Use the green paint.", labels: ["garden"], updatedAt: at(-10), history: created(mine) }));
  put(work(2, { title: "Sharpen the saw", state: "done", labels: ["tools"], updatedAt: at(-60 * 24 * 2) }));
  put(work(3, { title: "Old shed plan", state: "done", updatedAt: at(-60 * 24 * 40), priority: "minor" }));
  put(work(4, { title: "Fix the gate", state: "doing", priority: "blocker", holder: { actor: { id: "bot", name: "worker", bot: true } }, updatedAt: at(-5) }));
  put(work(5, { title: "Dropped idea", state: "abandoned", updatedAt: at(-100) }));
  put(work(6, { title: "Choose the colour", needsDecision: true, updatedAt: at(-30), history: created({ id: "other", name: "other" }) }));
  store.put(change(40, [1]), "sync", T0);
  server = createServer({ store, now: () => new Date(T0), port: 0, items: { host: "demo", write: {} } });
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  store.close();
});

const list = async (query = ""): Promise<ItemListView> => (await (await fetch(`${base}/api/items${query}`, { headers: { "X-ScopeSoup-Person": "me" } })).json()) as ItemListView;
const ids = (view: ItemListView): string[] => view.items.map((row) => row.label);

test("with no filter every item, open and closed, comes newest change first", async () => {
  const view = await list();
  assert.deepEqual(ids(view), ["#4", "#1", "#6", "#5", "#2", "#3"]);
  assert.equal(view.total, 6);
  assert.deepEqual(view.labels, ["garden", "tools"]);
  assert.equal(view.me, "me");
});

test("search finds a word in the title or the description, and an id", async () => {
  assert.deepEqual(ids(await list("?q=fence")), ["#1"]);
  assert.deepEqual(ids(await list("?q=GREEN")), ["#1"]);
  assert.deepEqual(ids(await list("?q=%234")), ["#4"]);
  assert.deepEqual(ids(await list("?q=nothing-like-this")), []);
});

test("state, priority, label, holder and change filters combine", async () => {
  assert.deepEqual(ids(await list("?state=open")), ["#4", "#1", "#6"]);
  assert.deepEqual(ids(await list("?state=done,abandoned")), ["#5", "#2", "#3"]);
  assert.deepEqual(ids(await list("?priority=blocker")), ["#4"]);
  assert.deepEqual(ids(await list("?priority=major&state=open")), ["#1", "#6"]);
  assert.deepEqual(ids(await list("?label=Garden")), ["#1"]);
  assert.deepEqual(ids(await list("?holder=worker")), ["#4"]);
  assert.deepEqual(ids(await list("?holder=none&state=open")), ["#1", "#6"]);
  assert.deepEqual(ids(await list("?change=yes")), ["#1"]);
  assert.deepEqual(ids(await list("?change=no&state=open")), ["#4", "#6"]);
});

test("turn, done in the last N days, created by me, and keys", async () => {
  assert.deepEqual(ids(await list("?turn=anyone")), ["#6"]);
  assert.deepEqual(ids(await list("?doneDays=7")), ["#2"]);
  assert.deepEqual(ids(await list("?doneDays=60")), ["#2", "#3"]);
  assert.deepEqual(ids(await list("?createdBy=me")), ["#1"]);
  assert.deepEqual(ids(await list("?createdBy=other")), ["#6"]);
  assert.deepEqual(ids(await list("?keys=demo:work:3,demo:work:1")), ["#3", "#1"]);
});

test("an unknown value is ignored, not an error", async () => {
  assert.equal((await list("?state=nonsense&turn=x&priority=huge&doneDays=abc&change=maybe")).total, 6);
});
