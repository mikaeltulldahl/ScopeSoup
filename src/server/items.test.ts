// Creating and editing items from the board, against a real temporary repository whose meta
// branch is written by the meta branch host. All names and texts are synthetic.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { BoardView, ItemPage } from "../core/views.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import { createSync } from "../sync/index.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";
import { loadJobs, saveJobs } from "../orchestrator/jobs.ts";

let repo: TestRepo;
let host: MetaBranchHost;
let store: Store;
let server: ScopeSoupServer;
let readOnly: ScopeSoupServer;
let base: string;
let readOnlyBase: string;
let tick = 0;
const clock = (): string => new Date(Date.parse("2026-11-18T09:00:00Z") + 60_000 * tick++).toISOString();

before(async () => {
  repo = createTestRepo();
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  host = createMetaBranchHost({ repoDir: repo.dir, allowWrites: true, remote: null, person: { name: "Test Person", email: "test.person@example.invalid" }, machine: "laptop-a", idPrefix: "A", now: clock });
  store = openStore(":memory:");
  const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false });
  server = createServer({ store, port: 0, items: { host: "metaBranch", write: host.write! }, syncNow: () => sync.refreshNow() });
  readOnly = createServer({ store, port: 0 });
  base = (await server.start()).url;
  readOnlyBase = (await readOnly.start()).url;
});

after(async () => {
  await server.stop();
  await readOnly.stop();
  await host.stop();
  store.close();
  repo.cleanup();
});

async function post(path: string, body: unknown, origin?: string, at = base): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(at + path, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const getJson = async <T>(path: string, at = base): Promise<T> => (await (await fetch(at + path)).json()) as T;

test("an item made on the board is on the meta branch, on the board and on its page with its log", async () => {
  const made = await post("/api/items", { title: "Paint the fence", body: "# Plan\n\n- sand it\n- paint it", verification: "No bare wood is left.", labels: "garden, paint", blockedBy: [] }, base);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.ref, "metaBranch:work:A-1");
  assert.match(repo.git(["cat-file", "-p", "refs/scopesoup/meta:items/A-1/item.md"]), /title: Paint the fence/);

  const board = await getJson<BoardView>("/api/board");
  assert.equal(board.canWrite, true);
  assert.ok(board.lanes.some((lane) => lane.cards.some((card) => card.key === "metaBranch:work:A-1" && card.title === "Paint the fence")));

  const page = await getJson<ItemPage>("/api/item?ref=metaBranch:work:A-1");
  assert.equal(page.canEdit, true);
  assert.equal(page.item.verification, "No bare wood is left.");
  assert.deepEqual(page.item.labels, ["garden", "paint"]);
  assert.deepEqual(page.history.map((line) => [line.kind, line.by.name, line.text]), [["created", "Ada on laptop-a", "Created the item."]]);
});

test("an edit shows on the item page and in its log; an edit that changes nothing writes nothing", async () => {
  const second = await post("/api/items", { title: "Buy paint" });
  assert.equal(second.body.ref, "metaBranch:work:A-2");
  const edited = await post("/api/item/edit", { ref: "metaBranch:work:A-1", title: "Paint the front fence", state: "doing", blockedBy: ["A-2"], labels: ["garden", "paint"] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  const page = await getJson<ItemPage>("/api/item?ref=metaBranch:work:A-1");
  assert.equal(page.item.title, "Paint the front fence");
  assert.equal(page.item.state, "doing");
  assert.deepEqual(page.blockedBy.map((other) => other.key), ["metaBranch:work:A-2"]);
  assert.deepEqual(page.history.map((line) => line.kind), ["created", "edited"]);
  assert.equal(page.history[1]?.text, "Changed title, state, blocked by.");

  const before = repo.git(["rev-parse", "refs/scopesoup/meta"]);
  const same = await post("/api/item/edit", { ref: "metaBranch:work:A-1", title: "Paint the front fence", state: "doing" });
  assert.deepEqual(same.body, { ref: "metaBranch:work:A-1", unchanged: true });
  assert.equal(repo.git(["rev-parse", "refs/scopesoup/meta"]), before);
});

test("the Item page's Abandon and Reopen send only the state, and the log says so", async () => {
  const ref = "metaBranch:work:A-2";
  assert.equal((await post("/api/item/edit", { ref, state: "abandoned" })).status, 200);
  const abandoned = await getJson<ItemPage>(`/api/item?ref=${ref}`);
  assert.equal(abandoned.item.state, "abandoned");
  assert.equal(abandoned.item.title, "Buy paint");
  assert.equal(abandoned.history.at(-1)?.text, "Changed state.");
  assert.equal((await post("/api/item/edit", { ref, state: "todo" })).status, 200);
  const reopened = await getJson<ItemPage>(`/api/item?ref=${ref}`);
  assert.equal(reopened.item.state, "todo");
  // The State menu sends what its page saw: an Item changed since is refused, not overwritten.
  const stale = await post("/api/item/edit", { ref, state: "done", seen: abandoned.item.updatedAt });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal((await getJson<ItemPage>(`/api/item?ref=${ref}`)).item.state, "todo");
  assert.equal((await post("/api/item/edit", { ref, state: "done", seen: reopened.item.updatedAt })).status, 200);
  assert.equal((await post("/api/item/edit", { ref, state: "todo" })).status, 200);
});

test("bad input, another origin and a read-only host are refused", async () => {
  assert.equal((await post("/api/items", { title: "  " })).status, 400);
  assert.equal((await post("/api/items", { title: "Odd", blockedBy: ["../x"] })).status, 400);
  assert.equal((await post("/api/item/edit", { ref: "metaBranch:work:A-1", state: "finished" })).status, 400);
  assert.equal((await post("/api/item/edit", { ref: "metaBranch:work:Z-9", title: "x" })).status, 404);
  assert.equal((await post("/api/items", { title: "From elsewhere" }, "http://elsewhere.invalid")).status, 403);

  assert.equal((await post("/api/items", { title: "Nope" }, undefined, readOnlyBase)).status, 403);
  assert.equal((await post("/api/item/edit", { ref: "metaBranch:work:A-1", title: "Nope" }, undefined, readOnlyBase)).status, 403);
  assert.equal((await getJson<BoardView>("/api/board", readOnlyBase)).canWrite, false);
  assert.equal((await getJson<ItemPage>("/api/item?ref=metaBranch:work:A-1", readOnlyBase)).canEdit, false);
  assert.equal(repo.git(["ls-tree", "--name-only", "refs/scopesoup/meta:items"]), "A-1\nA-2");
});

test("priority: set on creation, edited, cleared, logged and shown on the card; a bad one is refused", async () => {
  const made = await post("/api/items", { title: "Fix the gate", priority: "critical" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const ref = made.body.ref as string;
  assert.match(repo.git(["cat-file", "-p", `refs/scopesoup/meta:items/${ref.split(":")[2]}/item.md`]), /priority: critical/);
  const board = await getJson<BoardView>("/api/board");
  assert.equal(board.lanes.flatMap((lane) => lane.cards).find((card) => card.key === ref)?.priority, "critical");

  assert.equal((await post("/api/item/edit", { ref, priority: "blocker" })).status, 200);
  let page = await getJson<ItemPage>(`/api/item?ref=${ref}`);
  assert.equal(page.item.priority, "blocker");
  assert.equal(page.history.at(-1)?.text, "Changed priority.");
  assert.deepEqual((await post("/api/item/edit", { ref, priority: "blocker" })).body, { ref, unchanged: true });

  assert.equal((await post("/api/item/edit", { ref, priority: "" })).status, 200);
  page = await getJson<ItemPage>(`/api/item?ref=${ref}`);
  assert.equal(page.item.priority, undefined);

  assert.equal((await post("/api/items", { title: "X", priority: "urgent" })).status, 400);
  assert.equal((await post("/api/item/edit", { ref, priority: "urgent" })).status, 400);
});

test("Abandoned picked over a running session marks its job for the tick to end that session now (decision 104)", async () => {
  const made = await post("/api/items", { title: "Oil the hinges", body: "", verification: "", labels: "", blockedBy: [] });
  const ref = made.body.ref as string;
  const page = await getJson<ItemPage>(`/api/item?ref=${ref}`);
  saveJobs(store, { [ref]: { item: page.item.ref, workspace: "w", branch: "scopesoup/x", step: "implement", failures: 0, fixRounds: 0, startedAt: "2026-11-18T09:00:00Z", sessionId: "s9" } });
  const picked = await post("/api/item/pick", { ref, seen: page.item.updatedAt, steps: [{ kind: "state", state: "abandoned" }] });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  assert.deepEqual([loadJobs(store)[ref]?.interrupt?.by, loadJobs(store)[ref]?.interrupt?.to], ["Ada", "abandoned"]);
  assert.match(String((store.eventsOfKinds(["person.moved"], 5)[0]?.data as { reason?: string }).reason), /the implementor's session is ended now/);
});
