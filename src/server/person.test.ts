// No owner. The board's person comes from its picker (a header on every request); answers, claims and releases record
// that person, a question is in every person's Your turn, and anyone releases anyone's hold. All names are synthetic.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { T0, work } from "../core/testing.ts";
import type { BoardView } from "../core/views.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import { loadAnswers } from "../store/answers.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import { createSync } from "../sync/index.ts";
import { knownPeople, peopleNames, readPersonHeader } from "./person.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

const as = (person?: string): Record<string, string> => (person ? { "X-ScopeSoup-Person": encodeURIComponent(person) } : {});

async function call(base: string, path: string, person?: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(base + path, body === undefined ? { headers: as(person) } : { method: "POST", headers: { "Content-Type": "application/json", ...as(person) }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("the person header: URI-encoded, trimmed, at most 100 characters, no control characters", () => {
  assert.equal(readPersonHeader(undefined), undefined);
  assert.equal(readPersonHeader("  "), undefined);
  assert.equal(readPersonHeader(encodeURIComponent(" Åsa Öberg ")), "Åsa Öberg");
  assert.equal(readPersonHeader(["Ada", "Bo"]), "Ada");
  assert.ok(typeof readPersonHeader("%E0%A4%A") === "object");
  assert.ok(typeof readPersonHeader(encodeURIComponent("Ada\nBo")) === "object");
  assert.ok(typeof readPersonHeader("x".repeat(101)) === "object");
});

test("the picker's people: holders, log writers and answerers, each once and sorted; agents left out", () => {
  const works = [
    work(1, { holder: { actor: { id: "ada@laptop-a", name: "ada on laptop-a" } } }),
    work(2, { holder: { actor: { id: "scopesoup@laptop-a", name: "scopesoup", bot: true } }, log: [{ at: T0, by: { who: "bo", machine: "laptop-b", agent: false }, kind: "created", fields: {} }, { at: T0, by: { who: "scopesoup", machine: "laptop-a", agent: true }, kind: "session", fields: {} }] }),
  ];
  assert.deepEqual(knownPeople(works, [{ subject: works[0]!.ref, answer: "Yes", by: "cy", at: T0 }, { subject: works[0]!.ref, answer: "No", by: "ada", at: T0 }]), ["ada", "bo", "cy"]);
});

test("Jira holders are offered by account id (whole) with their display name; others as before", () => {
  const onJira = (n: number, id: string, name: string, bot?: boolean) => {
    const item = work(n, { holder: { actor: { id, name, ...(bot ? { bot } : {}) } } });
    item.ref = { ...item.ref, host: "jira" };
    return item;
  };
  const jira = onJira(7, "5b10a2844c20165700ede21g", "Robin Example");
  const mail = onJira(8, "kim@example.invalid", "Kim Example");
  const bot = onJira(9, "app1", "An App", true);
  const other = work(10, { holder: { actor: { id: "ada@laptop-a", name: "ada on laptop-a" } } });
  assert.deepEqual(knownPeople([jira, mail, bot, other], [], "jira"), ["5b10a2844c20165700ede21g", "ada", "kim@example.invalid"]);
  assert.deepEqual(peopleNames([jira, mail, bot, other], "jira"), { "5b10a2844c20165700ede21g": "Robin Example", "kim@example.invalid": "Kim Example" });
  assert.deepEqual(peopleNames([jira], undefined), {});
});

describe("the board's person over HTTP", { concurrency: 1 }, () => {
  let repo: TestRepo;
  let host: MetaBranchHost;
  let store: Store;
  let server: ScopeSoupServer;
  let base: string;
  let tick = 0;
  const clock = (): string => new Date(Date.parse("2026-11-18T09:00:00Z") + 60_000 * tick++).toISOString();

  before(async () => {
    repo = createTestRepo();
    repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
    host = createMetaBranchHost({ repoDir: repo.dir, allowWrites: true, remote: null, person: { name: "Test Person", email: "test.person@example.invalid" }, machine: "laptop-a", idPrefix: "A", now: clock });
    store = openStore(":memory:");
    const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false });
    server = createServer({ store, port: 0, now: () => new Date(clock()), machine: "laptop-a", items: { host: "metaBranch", write: host.write!, work: host.work }, syncNow: () => sync.refreshNow() });
    base = (await server.start()).url;
  });

  after(async () => {
    await server.stop();
    await host.stop();
    store.close();
    repo.cleanup();
  });

  test("filing, taking and releasing record the picked person; anyone releases another's hold and the log names both", async () => {
    assert.equal((await call(base, "/api/items", undefined, { title: "Paint the fence" })).body.error !== undefined, true);
    const filed = await call(base, "/api/items", "Ada", { title: "Paint the fence" });
    assert.equal(filed.status, 200, JSON.stringify(filed.body));
    const taken = await call(base, "/api/item/claim", "Ada", { id: "A-1" });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));

    const board = async (person?: string) => (await call(base, "/api/board", person)).body as unknown as BoardView;
    const ada = await board("Ada");
    assert.deepEqual(ada.people, ["Ada"]);
    assert.deepEqual(ada.yourTurn.map((card) => card.label), ["A-1"]);
    const bo = await board("Bo");
    assert.deepEqual(bo.yourTurn, []);
    assert.deepEqual(bo.lanes.flatMap((lane) => lane.cards).find((card) => card.label === "A-1")?.person, { name: "Ada", mine: false });

    const page = (await call(base, "/api/item?ref=metaBranch:work:A-1", "Bo")).body as { hold?: { release?: { why?: string } } };
    assert.deepEqual(page.hold?.release, {});
    const released = await call(base, "/api/item/release", "Bo", { id: "A-1" });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.match(String(released.body.message), /Bo released Ada on laptop-a's hold on A-1/);
    const item = (await host.work.getWork({ host: "metaBranch", kind: "work", id: "A-1" }))!;
    assert.equal(item.holder, undefined);
    const line = item.log!.at(-1)!;
    assert.deepEqual([line.kind, line.by.who, line.fields.of], ["released", "Bo", "Ada@laptop-a"]);
    assert.deepEqual((await board("Bo")).people, ["Ada", "Bo"]);
  });

  test("a bad person header is refused", async () => {
    const response = await fetch(`${base}/api/board`, { headers: { "X-ScopeSoup-Person": "%E0%A4%A" } });
    assert.equal(response.status, 400);
    await response.body?.cancel();
  });
});

describe("answers record who answered", { concurrency: 1 }, () => {
  let store: Store;
  let server: ScopeSoupServer;
  let base: string;

  before(async () => {
    store = openStore(":memory:");
    store.put(work(1, { title: "Decide the colour", needsDecision: true }), "sync", T0);
    server = createServer({ store, port: 0, now: () => new Date(T0) });
    base = (await server.start()).url;
  });

  after(async () => {
    await server.stop();
    store.close();
  });

  test("an answer without a picked person is refused; with one it names them; the question is in everyone's list until then", async () => {
    for (const person of [undefined, "Ada", "Bo"]) {
      const board = (await call(base, "/api/board", person)).body as unknown as BoardView;
      assert.deepEqual(board.yourTurn.map((card) => [card.label, card.actor]), [["#1", "anyone"]], person);
    }
    const refused = await call(base, "/api/answer", undefined, { ref: "demo:work:1", answer: "Blue" });
    assert.deepEqual([refused.status, (refused.body.error as { code: string }).code], [400, "PERSON_MISSING"]);
    const done = await call(base, "/api/answer", "Åsa", { ref: "demo:work:1", answer: "Blue" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(loadAnswers(store).map((each) => [each.answer, each.by]), [["Blue", "Åsa"]]);
    const event = store.eventsAfter(0, 100).find((each) => each.kind === "person.answered")!;
    assert.equal(event.actor, "Åsa");
    // The switches never need a person: Stop must always work. Without one the event names the board.
    const stopped = await fetch(`${base}/api/stop`, { method: "POST" });
    assert.equal(stopped.status, 200);
    await stopped.body?.cancel();
    assert.equal(store.eventsAfter(0, 100).filter((each) => each.kind.startsWith("control.")).at(-1)?.actor, "board");
  });
});
