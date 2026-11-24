// The existing sync loop and the board on top of the meta branch adapter, against a real temporary
// repository whose meta branch holds several items with logs. All names and texts are synthetic.
// (Here and not next to the adapter: a host's tests may not import the core or the store.)

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildBoard } from "../core/board.ts";
import type { CardView } from "../core/views.ts";
import { createMetaBranchHost, DEFAULT_META_REF } from "../hosts/metaBranch/index.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createTestRepo, itemMd, jsonl } from "../hosts/metaBranch/testRepo.ts";
import type { WorkItem } from "../model/types.ts";
import { loadSnapshot } from "../server/snapshot.ts";
import { setRolesForTest } from "../store/control.ts";
import { openStore } from "../store/store.ts";
import { createSync } from "./sync.ts";

/** A store with agents started, as after a person pressed Start agents: the turns then read as Scope Soup's. */
function startedStore(): ReturnType<typeof openStore> {
  const store = openStore(":memory:");
  setRolesForTest(store, "started");
  return store;
}

const NOW = new Date("2026-11-18T12:00:00Z");
const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";
const robin = { who: "robin", machine: "laptop-a" };
const sam = { who: "sam", machine: "laptop-b" };
const implementer = { who: "implement", machine: "laptop-a", agent: true };
const reviewer = { who: "review", machine: "laptop-a", agent: true };

/** Several items, each in a different place in its life. */
const FILES: Record<string, string> = {
  // In the backlog: nobody holds it, no log.
  "items/A-1/item.md": itemMd("A-1", "Write the parser", "todo", ["labels: parser, core"]),
  // Claimed by a person on a laptop, no change yet.
  "items/A-2/item.md": itemMd("A-2", "Draw the lanes", "doing", ["parent: A-7"]),
  "items/A-2/log.jsonl": jsonl({ at: "2026-11-18T09:00:00Z", by: robin, kind: "claimed", until: "2026-11-18T18:00:00Z" }),
  // A reviewed change, approved; its log also holds an unknown kind and a malformed line.
  "items/A-3/item.md": itemMd("A-3", "Fold the log", "doing", ["verification: the fold test passes"]),
  "items/A-3/log.jsonl":
    jsonl(
      { at: "2026-11-18T09:00:00Z", by: implementer, kind: "claimed", until: "2026-11-18T17:00:00Z" },
      { at: "2026-11-18T09:30:00Z", by: implementer, kind: "session", role: "implement", model: "small", outcome: "succeeded", summary: "added the fold", durationMs: 1_200_000 },
      { at: "2026-11-18T09:31:00Z", by: implementer, kind: "revision", sha: SHA1, branch: "scopesoup/A-3" },
      { at: "2026-11-18T09:32:00Z", by: implementer, kind: "celebrated", with: "cake" },
    ) +
    "{this line is broken\n" +
    jsonl(
      { at: "2026-11-18T09:40:00Z", by: reviewer, kind: "review", sha: SHA1, verdict: "pass", findings: [] },
      { at: "2026-11-18T09:41:00Z", by: implementer, kind: "released", reason: "reviewed" },
    ),
  // Waits for a person: one question answered, one open.
  "items/A-4/item.md": itemMd("A-4", "Choose the id prefix", "todo"),
  "items/A-4/log.jsonl": jsonl(
    { at: "2026-11-18T08:00:00Z", by: implementer, kind: "question", question: "One prefix per laptop?", options: ["yes", "no"], recommendation: "yes" },
    { at: "2026-11-18T08:10:00Z", by: robin, kind: "answer", answer: "yes" },
    { at: "2026-11-18T08:20:00Z", by: implementer, kind: "question", question: "Letters or digits?", options: ["letters", "digits"], recommendation: "letters" },
  ),
  // Merged.
  "items/A-5/item.md": itemMd("A-5", "Read the tree", "done"),
  "items/A-5/log.jsonl": jsonl(
    { at: "2026-11-17T10:00:00Z", by: implementer, kind: "revision", sha: SHA1, branch: "scopesoup/A-5" },
    { at: "2026-11-17T10:30:00Z", by: reviewer, kind: "review", sha: SHA1, verdict: "pass" },
    { at: "2026-11-17T10:40:00Z", by: implementer, kind: "check", sha: SHA1, verdict: "pass", command: "pnpm check" },
    { at: "2026-11-17T10:45:00Z", by: implementer, kind: "merged", sha: SHA1, target: "main" },
  ),
  // A new revision after the review: the review is stale.
  "items/A-6/item.md": itemMd("A-6", "Show the log", "doing"),
  "items/A-6/log.jsonl": jsonl(
    { at: "2026-11-18T07:00:00Z", by: implementer, kind: "revision", sha: SHA1, branch: "scopesoup/A-6" },
    { at: "2026-11-18T07:30:00Z", by: reviewer, kind: "review", sha: SHA1, verdict: "fail", findings: ["no test"] },
    { at: "2026-11-18T08:00:00Z", by: implementer, kind: "revision", sha: SHA2, branch: "scopesoup/A-6" },
  ),
  // The parent of A-2.
  "items/A-7/item.md": itemMd("A-7", "The board", "todo"),
  // A malformed item.md: shown as waiting, and nothing else is affected.
  "items/B-1/item.md": "title: someone forgot the header\n",
  "items/B-1/log.jsonl": jsonl({ at: "2026-11-18T06:00:00Z", by: sam, kind: "claimed", until: "2026-11-18T14:00:00Z" }),
  // Not items: skipped and named.
  "items/-rf/item.md": itemMd("-rf", "Looks like an option", "todo"),
  "items/a.b/item.md": itemMd("a.b", "Has a dot", "todo"),
  "items/README.md": "Not an item.\n",
  "items/A-8/notes.txt": "Not an item file.\n",
  "README.md": "Outside items/: not looked at.\n",
};

let repo: TestRepo;
before(() => {
  repo = createTestRepo();
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  repo.commit(DEFAULT_META_REF, FILES, "2026-11-18T10:00:00Z");
});
after(() => repo.cleanup());

const card = (cards: CardView[], id: string): CardView => {
  const found = cards.find((candidate) => candidate.key === `metaBranch:work:${id}`);
  assert.ok(found, `no card for ${id}`);
  return found;
};

test("the board's snapshot shows the meta branch's items with the right state, holder, change and turn", async () => {
  const host = createMetaBranchHost({ repoDir: repo.dir });
  const store = startedStore();
  const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false, now: () => NOW });
  await sync.refreshNow();

  const snapshot = loadSnapshot(store);
  assert.deepEqual(snapshot.sync.error, undefined);
  assert.deepEqual(snapshot.works.map((item) => item.ref.id).sort(), ["A-1", "A-2", "A-3", "A-4", "A-5", "A-6", "A-7", "B-1"]);
  const work = (id: string): WorkItem => snapshot.works.find((item) => item.ref.id === id) as WorkItem;

  // State and fields from item.md.
  assert.equal(work("A-1").state, "todo");
  assert.deepEqual(work("A-1").labels, ["parser", "core"]);
  assert.equal(work("A-1").body, "What write the parser means.");
  assert.equal(work("A-3").verification, "the fold test passes");
  assert.equal(work("A-5").state, "done");
  assert.deepEqual(work("A-2").parent, { host: "metaBranch", kind: "work", id: "A-7" });
  assert.equal(work("A-7").openChildren, 1);
  // An item with no log takes the meta commit's time.
  assert.equal(work("A-1").updatedAt, "2026-11-18T10:00:00.000Z");
  assert.equal(work("A-3").updatedAt, "2026-11-18T09:41:00.000Z");

  // Holders from claimed and released.
  assert.deepEqual(work("A-2").holder, { actor: { id: "robin@laptop-a", name: "robin on laptop-a" }, until: "2026-11-18T18:00:00.000Z" });
  assert.equal(work("A-3").holder, undefined);
  assert.equal(work("A-1").holder, undefined);

  // Changes: the item's branch plus its log lines, under the item's own id.
  assert.deepEqual(snapshot.changes.map((change) => [change.ref.id, change.state, change.branch]).sort(), [
    ["A-3", "open", "scopesoup/A-3"],
    ["A-5", "merged", "scopesoup/A-5"],
    ["A-6", "open", "scopesoup/A-6"],
  ]);
  const a6 = snapshot.changes.find((change) => change.ref.id === "A-6");
  assert.deepEqual(a6?.revisions.map((revision) => revision.sha), [SHA1, SHA2]);
  assert.deepEqual(a6?.verdicts.map((verdict) => [verdict.dimension, verdict.value, verdict.stale]), [["review", "fail", true]]);
  assert.deepEqual(a6?.works, [{ host: "metaBranch", kind: "work", id: "A-6" }]);
  const a5 = snapshot.changes.find((change) => change.ref.id === "A-5");
  assert.deepEqual(a5?.verdicts.map((verdict) => [verdict.dimension, verdict.value, verdict.stale]), [["review", "pass", false], ["ci", "pass", false]]);

  // The board: lanes and turns.
  const board = buildBoard(snapshot, NOW);
  const cards = board.lanes.flatMap((lane) => lane.cards);
  const where = (id: string) => {
    const found = card(cards, id);
    return [found.lane, found.actor, found.reason];
  };
  assert.deepEqual(where("A-1"), ["backlog", "agent", "ready; waiting for a free agent slot"]);
  assert.deepEqual(where("A-2"), ["in-progress", "person", "held by robin on laptop-a; Scope Soup leaves it alone until they hand it back or release it"]);
  assert.deepEqual(where("A-3"), ["queued", "queue", "approved; waiting in the queue (position 1 of 1)"]);
  assert.deepEqual(where("A-4"), ["backlog", "anyone", "Answer the question: the item needs a decision"]);
  assert.deepEqual(where("A-5"), ["done", "nobody", "done"]);
  assert.deepEqual(where("A-6"), ["in-review", "agent", "it has a new revision since the last review; waiting for a reviewer session"]);
  assert.deepEqual(where("A-7"), ["backlog", "nobody", "has 1 open sub-item; the work happens there"]);
  assert.equal(card(cards, "A-3").change?.label, "A-3");
  assert.equal(card(cards, "A-4").needsDecision, true);
  // Robin's board has a person's turn and robin's hold; a board with no person has every person's.
  assert.deepEqual(buildBoard(snapshot, NOW, undefined, { person: "robin", machine: "laptop-a" }).yourTurn.map((entry) => entry.key), ["metaBranch:work:A-4", "metaBranch:work:A-2"]);
  assert.deepEqual(board.yourTurn.map((entry) => entry.key).sort(), ["metaBranch:work:A-2", "metaBranch:work:A-4"]);

  // A malformed item.md and a malformed log line do not break the read; both are counted.
  const b1 = work("B-1");
  assert.equal(b1.state, "waiting");
  assert.match(b1.hostState, /^malformed: item.md does not start with a --- line/);
  assert.equal(b1.holder?.actor.id, "sam@laptop-b");
  assert.deepEqual(where("B-1")[0], "backlog");
  assert.match(String(where("B-1")[2]), /waiting on the host \(status "malformed: /);
  assert.deepEqual(host.lastReport(), {
    items: 8,
    malformedItems: ["B-1"],
    malformedLines: 1,
    unknownKinds: 1,
    // In git's tree order (bytes).
    skipped: ["items/-rf/item.md", "items/A-8/notes.txt", "items/README.md", "items/a.b/item.md"],
    // A meta branch without the format entry is format 0.
    format: { format: 0, note: "The meta branch is format 0; the machine that holds the merge queue lease migrates it to format 1, and writes go on meanwhile." },
  });
  store.close();
});

test("a repository without the meta ref syncs as an empty project, not an error", async () => {
  const host = createMetaBranchHost({ repoDir: repo.dir, ref: "refs/scopesoup/not-there" });
  const store = startedStore();
  const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false, now: () => NOW });
  await sync.refreshNow();
  const snapshot = loadSnapshot(store);
  assert.deepEqual([snapshot.works, snapshot.changes, snapshot.sync.error], [[], [], undefined]);
  store.close();
});


test("the sync loop keeps the store in step as the meta branch moves", async () => {
  const other = createTestRepo();
  try {
    other.commit(DEFAULT_META_REF, { "items/D-1/item.md": itemMd("D-1", "One", "todo"), "items/D-2/item.md": itemMd("D-2", "Two", "todo") }, "2026-11-18T10:00:00Z");
    const host = createMetaBranchHost({ repoDir: other.dir });
    const store = startedStore();
    const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false, now: () => NOW });
    await sync.refreshNow();
    assert.deepEqual(store.list<WorkItem>("work").map((item) => item.ref.id).sort(), ["D-1", "D-2"]);

    other.commit(
      DEFAULT_META_REF,
      {
        "items/D-1/item.md": itemMd("D-1", "One", "doing"),
        "items/D-1/log.jsonl": jsonl({ at: "2026-11-18T11:00:00Z", by: sam, kind: "claimed", until: "2026-11-18T19:00:00Z" }),
      },
      "2026-11-18T11:00:00Z",
    );
    await sync.refreshNow();
    const works = store.list<WorkItem>("work");
    assert.deepEqual(works.map((item) => [item.ref.id, item.state, item.holder?.actor.name]), [["D-1", "doing", "sam on laptop-b"]]);
    store.close();
  } finally {
    other.cleanup();
  }
});

test("an item whose item.md was changed on two machines is a person's turn, and only that item", async () => {
  const other = createTestRepo();
  try {
    other.commit(
      DEFAULT_META_REF,
      {
        "items/C-1/item.md": itemMd("C-1", "Kept version", "todo"),
        "items/C-1/item.conflict-0123456789ab.md": itemMd("C-1", "Other version", "todo"),
        "items/C-2/item.md": itemMd("C-2", "Untouched", "todo"),
      },
      "2026-11-18T10:00:00Z",
    );
    const host = createMetaBranchHost({ repoDir: other.dir });
    const store = startedStore();
    const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false, now: () => NOW });
    await sync.refreshNow();
    const board = buildBoard(loadSnapshot(store), NOW);
    const cards = board.lanes.flatMap((lane) => lane.cards);
    assert.deepEqual([card(cards, "C-1").actor, card(cards, "C-1").reason], ["anyone", "Answer the question: the item needs a decision"]);
    assert.equal(card(cards, "C-2").actor, "agent");
    assert.deepEqual(board.yourTurn.map((entry) => entry.key), ["metaBranch:work:C-1"]);
    assert.deepEqual(host.lastReport()?.conflicts, ["C-1"]);
    store.close();
  } finally {
    other.cleanup();
  }
});
