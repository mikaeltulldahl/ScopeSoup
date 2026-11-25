// The board's Item drafts: in every person's Your turn, Approve makes the Item on the source Item's host (once), Deny drops it,
// History has both, and a host Scope Soup cannot write offers no Approve. All names are synthetic; the host is a fake.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { buildActivity } from "../core/activity.ts";
import { work } from "../core/testing.ts";
import type { BoardView } from "../core/views.ts";
import type { ItemDraft, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { NewWork, WritePort } from "../ports/host.ts";
import { draftRef, fileDrafts, openDrafts } from "../orchestrator/drafts.ts";
import { decide } from "./drafts.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

const AT = "2026-11-25T10:00:00.000Z";

describe("Item drafts over HTTP", { concurrency: 1 }, () => {
  let store: Store;
  let server: ScopeSoupServer;
  let base: string;
  const made: NewWork[] = [];
  let refuse = false;

  const write: WritePort = {
    async createWork(input) {
      if (refuse) throw new Error("The host refused: 403");
      made.push(input);
      const ref = { host: "github", kind: "work" as const, id: String(40 + made.length) };
      store.put({ ...work(40 + made.length), ref, title: input.title, body: input.body }, "test", AT);
      return { work: ref, shared: "shared", conflict: false };
    },
  };
  const call = async (path: string, person?: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const headers: Record<string, string> = person ? { "X-ScopeSoup-Person": person } : {};
    const response = await fetch(base + path, body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const board = async (person = "mira") => (await call("/api/board", person)).body as unknown as BoardView;
  /** The board's drafts by title (drafts filed at the same time come in no set order). */
  const draftsOf = async (person = "mira") => new Map(((await board(person)).drafts ?? []).map((each) => [each.title, each]));

  before(async () => {
    store = openStore(":memory:");
    store.put({ ...work(7), ref: { host: "github", kind: "work", id: "7" }, title: "Parse tide tables" }, "test", AT);
    store.put({ ...work(8), ref: { host: "jira", kind: "work", id: "DEMO-8" }, title: "On a host read here only" }, "test", AT);
    fileDrafts(store, { host: "github", kind: "work", id: "7" }, "reviewer", [
      { title: "Tidy the parser", description: "Ask @bob first.", verification: "The parser has one entry point." },
      { title: "Document the cache", description: "", verification: "" },
    ], "orchestrator", AT);
    fileDrafts(store, { host: "jira", kind: "work", id: "DEMO-8" }, "triage", [{ title: "Split the importer", description: "", verification: "" }], "orchestrator", AT);
    server = createServer({ store, port: 0, restructure: [{ host: "github", write, verificationInBody: true, issueNumbers: true }] });
    base = (await server.start()).url;
  });
  after(() => server.stop());

  test("drafts are in every person's Your turn with their source Item; one from a host Scope Soup cannot write says Approve is not offered", async () => {
    for (const person of ["mira", "ola"]) {
      const drafts = [...(await draftsOf(person)).values()];
      assert.deepEqual(drafts.map((each) => [each.title, each.from.id, each.role]).sort(), [["Document the cache", "7", "reviewer"], ["Split the importer", "DEMO-8", "triage"], ["Tidy the parser", "7", "reviewer"]]);
    }
    const drafts = await draftsOf();
    const tidy = drafts.get("Tidy the parser")!;
    assert.equal(tidy.from.title, "Parse tide tables");
    assert.equal(tidy.description.includes("@bob"), false);
    assert.equal(tidy.readOnly, undefined);
    assert.match(drafts.get("Split the importer")!.readOnly ?? "", /^Scope Soup cannot create Items on jira from here \(it is read-only\), so Approve is not offered/);
  });

  test("Approve needs a person, makes the Item on the host once with the person's edit and the source named, and records who", async () => {
    const id = (await draftsOf()).get("Tidy the parser")!.id;
    assert.equal((await call("/api/item-draft", undefined, { id, action: "approve" })).status, 400);
    refuse = true;
    const refused = await call("/api/item-draft", "mira", { id, action: "approve" });
    assert.deepEqual([refused.status, (refused.body.error as { code: string }).code], [502, "WRITE_REFUSED"]);
    assert.equal(openDrafts(store).length, 3, "a refused write leaves the draft open");
    refuse = false;
    const done = await call("/api/item-draft", "mira", { id, action: "approve", title: "Tidy the tide parser" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.ref, "github:work:41");
    assert.equal(made.length, 1);
    assert.equal(made[0]!.title, "Tidy the tide parser");
    assert.match(made[0]!.body ?? "", /^Ask @​bob first\.\n\n## Verification\n\nThe parser has one entry point\.\n\nFound while working on #7 \(draft [0-9a-f]{12}\)\.$/);
    assert.deepEqual(made[0]!.log?.[0]?.by, { who: "mira", agent: false });
    const again = await call("/api/item-draft", "ola", { id, action: "deny" });
    assert.deepEqual([again.status, (again.body.error as { message: string }).message], [409, "mira approved this draft already."]);
    assert.equal((await board()).drafts!.length, 2);
  });

  test("Deny drops it without touching the host; Approve is refused for a host Scope Soup cannot write; History has both decisions", async () => {
    const drafts = await draftsOf();
    const denied = await call("/api/item-draft", "ola", { id: drafts.get("Document the cache")!.id, action: "deny" });
    assert.equal(denied.status, 200);
    assert.equal(made.length, 1);
    const readOnly = await call("/api/item-draft", "ola", { id: drafts.get("Split the importer")!.id, action: "approve" });
    assert.deepEqual([readOnly.status, (readOnly.body.error as { code: string }).code], [403, "READ_ONLY"]);
    assert.deepEqual((await board()).drafts!.map((each) => each.title), ["Split the importer"]);
    assert.equal((await call("/api/item-draft", "ola", { id: "nope", action: "deny" })).status, 404);
    const rows = buildActivity({ works: store.list<WorkItem>("work"), changes: [], sessions: [], batches: [], events: store.eventsAfter(0, 1000), settings: [] }, AT).rows;
    const texts = rows.map((row) => `${row.who}: ${row.text}`);
    assert.ok(texts.includes("mira: Approved the draft: Tidy the parser"), texts.join("\n"));
    assert.ok(texts.includes("ola: Denied the draft: Document the cache"), texts.join("\n"));
    assert.ok(texts.includes("reviewer: Proposed a new Item as a draft: Tidy the parser"), texts.join("\n"));
    const approved = rows.find((row) => row.text === "Approved the draft: Tidy the parser");
    assert.deepEqual(approved?.items.map((each) => each.key), ["github:work:7", refKey({ host: "github", kind: "work", id: "41" })]);
  });
});

describe("Approve finds the Item it made, and only that one", () => {
  const from = { host: "github", kind: "work" as const, id: "7" };
  const setup = () => {
    const store = openStore(":memory:");
    const remote: WorkItem[] = [];
    let calls = 0;
    let timeout = false;
    const write: WritePort = {
      async createWork(input) {
        calls++;
        const ref = { host: "github", kind: "work" as const, id: String(50 + calls) };
        // The host made it; the answer never came back, so the store does not know it yet.
        remote.push({ ...work(50 + calls), ref, title: input.title, body: input.body });
        if (timeout) throw new Error("The request timed out.");
        store.put(remote.at(-1)!, "test", AT);
        return { work: ref, shared: "shared", conflict: false };
      },
    };
    const hosts = [{ host: "github", write, issueNumbers: true, verificationInBody: true }];
    const refresh = async () => {
      for (const each of remote) store.put(each, "sync", AT);
    };
    return { store, hosts, refresh, calls: () => calls, setTimeout: (on: boolean) => void (timeout = on) };
  };

  test("an Item that only quotes a draft's marker, or one another draft's approval took, is not taken: a new Item is made", async () => {
    const { store, hosts, calls } = setup();
    const [one, two] = fileDrafts(store, from, "reviewer", [{ title: "One", description: "", verification: "" }, { title: "Two", description: "", verification: "" }], "orchestrator", AT).filed;
    const marker = `Found while working on #7 (draft ${one!.ref.id}).`;
    store.put({ ...work(30), ref: { host: "github", kind: "work", id: "30" }, title: "Quotes it", body: `Someone pasted: ${marker} here.` }, "test", AT);
    const first = await decide(store, hosts, { id: one!.ref.id, action: "approve" }, "mira", () => AT);
    assert.deepEqual([first.ok && first.item?.id, calls()], ["51", 1]);
    // Item 51 is draft one's, whatever its text says now: draft two does not take it, only an Item no other draft took.
    store.put({ ...work(31), ref: { host: "github", kind: "work", id: "31" }, title: "Forged", body: `Two's text.\n\nFound while working on #7 (draft ${two!.ref.id}).` }, "test", AT);
    store.put({ ...store.get<WorkItem>({ host: "github", kind: "work", id: "31" })!, ref: { host: "github", kind: "work", id: "51" }, body: `Found while working on #7 (draft ${two!.ref.id}).` }, "test", AT);
    const second = await decide(store, hosts, { id: two!.ref.id, action: "approve" }, "mira", () => AT);
    assert.equal(second.ok && second.item?.id, "31", "an Item whose last line is the marker and no other draft took is adopted");
    assert.equal(calls(), 1);
  });

  test("an Approve cut off after the host made the Item: the retry brings the store up to date and takes it, making no second", async () => {
    const { store, hosts, refresh, calls, setTimeout } = setup();
    const [draft] = fileDrafts(store, from, "implementor", [{ title: "Tidy", description: "Why.", verification: "" }], "orchestrator", AT).filed;
    setTimeout(true);
    await assert.rejects(decide(store, hosts, { id: draft!.ref.id, action: "approve" }, "mira", () => AT, refresh), /timed out/);
    assert.deepEqual(store.get<ItemDraft>(draftRef(draft!.ref.id))?.approving, { by: "mira", at: AT });
    setTimeout(false);
    const retry = await decide(store, hosts, { id: draft!.ref.id, action: "approve" }, "ola", () => AT, refresh);
    assert.deepEqual([retry.ok && retry.item?.id, calls()], ["51", 1]);
    const decided = store.get<ItemDraft>(draftRef(draft!.ref.id));
    assert.deepEqual([decided?.decided?.verdict, decided?.decided?.by, decided?.approving], ["approved", "ola", undefined]);
  });
});
