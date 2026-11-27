// A proposed restructuring from triage, decided on the item page (`POST /api/proposal`): accepting makes each part where it goes
// (a child, a related or an unlinked Item, or text added to an existing Item), then the item keeps a part, becomes an umbrella, or
// is closed as replaced. On a read-only host nothing is made and it is given as text. A failure halfway, or a second press, makes
// no part twice. Names are synthetic.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ItemPage } from "../core/views.ts";
import type { Change, CreatedPart, OriginalFate, ProposedPart, Ref, WorkItem } from "../model/types.ts";
import type { Job } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs, parkedOf } from "../orchestrator/jobs.ts";
import type { NewWork, WorkPatch, WriteOutcome, WritePort } from "../ports/host.ts";
import { loadAnswers } from "../store/answers.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import { createServer } from "./server.ts";
import type { ServerOptions } from "./server.ts";

const AT = "2026-11-18T09:00:00.000Z";
const PARENT: Ref = { host: "fake", kind: "work", id: "7" };
const KEY = "fake:work:7";
const OTHER: Ref = { host: "fake", kind: "work", id: "9" };
const PARTS: ProposedPart[] = [
  { title: "Read the old format", description: "Parse the old files.", verification: "A test reads a sample.", goes: "child" },
  { title: "Write the new format", description: "Write the new files.", verification: "A test writes a sample.", goes: "child" },
  { title: "Switch over", description: "Use the new format everywhere.", verification: "The suite passes.", goes: "child" },
];
const CARRIED = "- Asked: Which format?\n  Answered: Keep the old one readable.";
const ID = "abc12345";

function parent(over: Partial<WorkItem> = {}): WorkItem {
  return { ref: PARENT, title: "Change the file format", body: "Everything about the format.", state: "todo", hostState: "open", labels: ["scopesoup"], blockedBy: [], openChildren: 0, updatedAt: AT, ...over };
}

function proposalJob(created?: CreatedPart[], parts: ProposedPart[] = PARTS, original: OriginalFate = "umbrella"): Job {
  return {
    item: PARENT, workspace: "w", branch: "scopesoup/7", failures: 0, fixRounds: 0, startedAt: AT,
    proposal: { id: ID, reason: "Triage proposes to restructure the Item.", original, parts, carried: CARRIED, ...(created ? { created } : {}) }, at: { kind: "parked", step: "triage", parked: { as: "needs-decision", reason: "Triage proposes to restructure the Item.", at: AT } }
  };
}

interface FakeHost {
  write: WritePort;
  made: NewWork[];
  /** editWork calls, in order. */
  edits: { work: Ref; patch: WorkPatch }[];
  /** Calls of createWork (0-based) that fail outright. */
  failOn: Set<number>;
  /** Calls of createWork whose issue is made but whose link under the parent fails, as GitHub's sub-issue call can. */
  linkFailsOn: Set<number>;
  /** linkChild calls: child ids. */
  linked: string[];
  /** linkRelated calls: related ids. */
  related: string[];
  /** The descriptions written, by item id: what `read` returns over the store's. */
  bodies: Map<string, string>;
  /** Called on each read, before it answers: a person editing the same Item at that moment. */
  onRead?: (id: string) => void;
  hold?: Promise<void>;
}

/**
 * A host that creates items the way GitHub does: numbered, with a parent link made by a call of its own, and a related link made
 * by one too; it can be made to fail. Descriptions written are kept, so a read shows them.
 */
function fakeHost(): FakeHost {
  let calls = 0;
  const state: FakeHost = {
    made: [],
    edits: [],
    failOn: new Set(),
    linkFailsOn: new Set(),
    linked: [],
    related: [],
    bodies: new Map(),
    write: {
      async createWork(input: NewWork): Promise<WriteOutcome> {
        if (state.hold) await state.hold;
        const call = calls++;
        if (state.failOn.has(call)) throw new Error("The host is down.");
        state.made.push(input);
        const work: Ref = { host: "fake", kind: "work", id: String(100 + state.made.length) };
        if (input.parent && state.linkFailsOn.has(call)) return { work, shared: "shared", conflict: false, linked: false, problem: "The link call failed." };
        return { work, shared: "shared", conflict: false };
      },
      async editWork(work: Ref, patch: WorkPatch): Promise<WriteOutcome> {
        state.edits.push({ work, patch });
        if (patch.body !== undefined) state.bodies.set(work.id, patch.body);
        return { work, shared: "shared", conflict: false };
      },
      async linkRelated(_item: Ref, related: Ref): Promise<void> {
        state.related.push(related.id);
      },
      async linkChild(_parent: Ref, child: Ref): Promise<void> {
        state.linked.push(child.id);
      },
    },
  };
  return state;
}

async function serve(store: Store, extra: Partial<ServerOptions>): Promise<{ post: (body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>; page: () => Promise<ItemPage>; stop: () => Promise<void> }> {
  const server = createServer({ store, port: 0, planning: () => ({ bugLabels: [] }), ...extra });
  const url = (await server.start()).url;
  return {
    post: async (body) => {
      const response = await fetch(`${url}/api/proposal`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    page: async () => (await (await fetch(`${url}/api/item?ref=${KEY}`)).json()) as ItemPage,
    stop: () => server.stop(),
  };
}

/** The host as the board is given it: its writes, and reads of the store's items with the descriptions it wrote. */
function hostOf(host: FakeHost, store: Store, extra: { verificationInBody?: true; issueNumbers?: true } = {}): NonNullable<ServerOptions["restructure"]> {
  const read = async (ref: Ref): Promise<WorkItem | null> => {
    host.onRead?.(ref.id);
    const item = store.get<WorkItem>(ref);
    return item ? { ...item, body: host.bodies.get(ref.id) ?? item.body } : null;
  };
  return [{ host: "fake", write: host.write, read, ...extra }];
}

/** An open change for an item. */
function openChange(id: string, work: Ref): Change {
  return { ref: { host: "fake", kind: "change", id }, title: "A change", author: { id: "ada", name: "Ada" }, state: "open", draft: false, target: "main", revisions: [], verdicts: [], labels: [], works: [work], updatedAt: AT };
}

function storeWith(job: Job): Store {
  const store = openStore(":memory:");
  store.put(parent(), "sync", AT);
  store.put({ ...parent(), ref: OTHER, title: "Keep the old files readable", body: "Old files stay readable." }, "sync", AT);
  saveJobs(store, { [KEY]: job });
  return store;
}

const message = (body: Record<string, unknown>): string => (body.error as { message: string }).message;

describe("a proposed restructuring on a writable host", { concurrency: 4 }, () => {
  test("with the AI label on, every part made carries it", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store, { verificationInBody: true }), aiLabel: () => "ai-generated" });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(host.made.length, PARTS.length);
      for (const made of host.made) assert.deepEqual(made.labels, ["ai-generated"]);
    } finally {
      await board.stop();
    }
  });

  test("into children under an umbrella: on the item page with its parts; accepting makes them in order as children, with the decisions carried over", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store, { verificationInBody: true }) });
    try {
      const shown = await board.page();
      assert.deepEqual(shown.proposal?.parts, PARTS);
      assert.equal(shown.proposal?.original, "umbrella");
      assert.equal(shown.proposal?.carried, CARRIED);
      assert.equal(shown.proposal?.canCreate, true);
      assert.equal(shown.actor, "anyone");
      assert.match(shown.reason, /^Accept, edit or reject the proposed restructuring/);

      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(accepted.body.created, ["fake:work:101", "fake:work:102", "fake:work:103"]);
      assert.deepEqual(host.made.map((each) => each.title), PARTS.map((each) => each.title));
      for (const [index, made] of host.made.entries()) {
        assert.deepEqual(made.parent, PARENT, "linked under the item");
        assert.deepEqual(made.labels, [], "no invite label");
        assert.match(made.body ?? "", new RegExp(`^${PARTS[index]!.description}\\n\\n## Decisions carried over from 7\\n\\n- Asked: Which format\\?\\n  Answered: Keep the old one readable\\.\\n\\n## Verification\\n\\n${PARTS[index]!.verification}\\n\\nPart ${index + 1} of restructuring abc12345 of fake:work:7\\.$`));
        assert.equal(made.verification, undefined, "GitHub keeps the verification in the text");
      }
      assert.deepEqual(host.edits, [], "an umbrella is not changed");
      // The item parked as an umbrella, with what was made; the answer is kept for the sessions.
      const job = loadJobs(store)[KEY]!;
      assert.equal(parkedOf(job)?.as, "not-ready");
      assert.equal(job.proposal, undefined);
      assert.match(parkedOf(job)?.reason ?? "", /^Restructured into 101 \(a new sub-item of 7\), 102 .*; the work happens there\.$/);
      assert.match(loadAnswers(store)[0]!.answer, /Accepted the proposed restructuring: 101 .* 7 is an umbrella/);
      const done = store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.restructure_done");
      assert.deepEqual(done.map((event) => (event.data as { created: string[] }).created), [["fake:work:101", "fake:work:102", "fake:work:103"]]);
      // Once the host reports the open children, the item is an umbrella and nobody's turn.
      store.put(parent({ openChildren: 3 }), "sync", AT);
      const umbrella = await board.page();
      assert.equal(umbrella.proposal, undefined);
      assert.equal(umbrella.actor, "nobody");
      assert.match(umbrella.reason, /has 3 open sub-items; the work happens there/);
      // Pressed again: nothing is waiting, and nothing is made twice.
      assert.equal((await board.post({ ref: KEY, action: "accept" })).status, 404);
      assert.equal(host.made.length, 3);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("the item keeps a part: a related and an unlinked Item are made, a part goes into an existing Item, the item is narrowed and triaged again", async () => {
    const parts: ProposedPart[] = [
      { title: "Read the old format", description: "Parse the old files, @someone. Fixes #3.", verification: "A test reads a sample.", goes: "original" },
      { title: "Write the new format", description: "Write the new files.", verification: "A test writes a sample.", goes: "related" },
      { title: "Tidy the docs", description: "Say what changed.", verification: "", goes: "unlinked" },
      { title: "Old files readable", description: "Old files keep opening.", verification: "A test opens one.", goes: "into", into: "9" },
    ];
    const store = storeWith(proposalJob(undefined, parts, "keeps"));
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store, { issueNumbers: true }) });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(accepted.body.created, ["fake:work:101", "fake:work:102", "fake:work:9"]);
      const [related, unlinked] = host.made;
      assert.equal(related!.parent, undefined);
      assert.deepEqual(host.related, ["101"], "a related Item is linked where the host keeps links");
      assert.match(related!.body ?? "", /\n\nPart 2 of restructuring abc12345 of #7\.$/, "on GitHub the marker names #7, which links it");
      assert.equal(unlinked!.parent, undefined);
      assert.match(unlinked!.body ?? "", /\n\nPart 3 of restructuring abc12345 of fake:work:7\.$/, "an unlinked part's marker makes no link");
      // The part into item 9 is added at the end of its description; then the item itself is narrowed to the part it keeps, inert.
      assert.deepEqual(host.edits.map((each) => each.work.id), ["9", "7"]);
      assert.equal(host.edits[0]!.patch.body, "Old files stay readable.\n\n## Added from #7: Old files readable\n\nOld files keep opening.\n\nVerification: A test opens one.\n\nPart 4 of restructuring abc12345 of #7.");
      const kept = host.edits[1]!.patch;
      assert.equal(kept.title, "Read the old format");
      assert.equal(kept.verification, "A test reads a sample.");
      assert.ok(kept.body?.includes("@​someone") && kept.body.includes("F​ixes"), "the agent's text is made inert");
      // Released, so triage looks at the narrowed text again.
      assert.equal(loadJobs(store)[KEY], undefined);
      assert.match(loadAnswers(store)[0]!.answer, /7 keeps "Read the old format", its text narrowed to that part\./);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("replaced by an existing Item and nothing new: the item is closed as its duplicate, naming it", async () => {
    const parts: ProposedPart[] = [{ title: "Same as item 9", description: "The format change is item 9's.", verification: "", goes: "into", into: "9" }];
    const store = storeWith(proposalJob(undefined, parts, "replaced"));
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(host.made.length, 0, "nothing new");
      assert.deepEqual(host.edits.map((each) => each.work.id), ["9", "7"]);
      assert.deepEqual(host.edits[1]!.patch, { state: "abandoned", duplicateOf: OTHER });
      assert.match(loadAnswers(store)[0]!.answer, /7 is closed, replaced by 9\./);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("replaced by new Items: closed, not as a duplicate", async () => {
    const parts: ProposedPart[] = [{ ...PARTS[0]!, goes: "related" }, { ...PARTS[1]!, goes: "unlinked" }];
    const store = storeWith(proposalJob(undefined, parts, "replaced"));
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(host.edits, [{ work: PARENT, patch: { state: "abandoned" } }]);
      assert.match(parkedOf(loadJobs(store)[KEY])?.reason ?? "", /^Replaced by 101, 102/);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("a part into an Item that is not there is refused before anything is made", async () => {
    const parts: ProposedPart[] = [{ ...PARTS[0]!, goes: "child" }, { ...PARTS[1]!, goes: "into", into: "404" }];
    const store = storeWith(proposalJob(undefined, parts));
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 400);
      assert.match(message(accepted.body), /Part 2 goes into 404, which is not another Item on fake/);
      assert.equal(host.made.length, 0);
      assert.equal(parkedOf(loadJobs(store)[KEY])?.as, "needs-decision");
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("fails halfway: what was made is recorded, and accepting again makes only the rest", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    host.failOn.add(1);
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const first = await board.post({ ref: KEY, action: "accept" });
      assert.equal(first.status, 502, JSON.stringify(first.body));
      assert.match(message(first.body), /1 of 3 parts exist; part 2 failed: The host is down\./);
      // With a part made, it can be finished but no longer rejected.
      const shownHalf = await board.page();
      assert.deepEqual(shownHalf.proposal?.created?.map((each) => [each.key, each.part]), [["fake:work:101", 0]]);
      const rejected = await board.post({ ref: KEY, action: "reject" });
      assert.equal(rejected.status, 409);
      assert.equal((rejected.body.error as { code: string }).code, "PARTS_CREATED");
      const halfway = loadJobs(store)[KEY]!;
      assert.equal(parkedOf(halfway)?.as, "needs-decision", "still waiting on the restructuring");
      assert.deepEqual(halfway.proposal?.created, [{ part: 0, ref: { host: "fake", kind: "work", id: "101" }, linked: true }]);

      // An edit after a part exists is refused, not set aside: Accept finishes the same parts.
      const edit = await board.post({ ref: KEY, action: "edit", original: "umbrella", parts: [{ title: "Something else", description: "", verification: "", goes: "child" }] });
      assert.equal(edit.status, 409);
      assert.match(message(edit.body), /can no longer be edited: Accept finishes the same restructuring, or Stop here/);
      const again = await board.post({ ref: KEY, action: "accept" });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.deepEqual(again.body.created, ["fake:work:101", "fake:work:102", "fake:work:103"]);
      assert.deepEqual(host.made.map((each) => each.title), PARTS.map((each) => each.title), "each part made once, in order");
      assert.equal(parkedOf(loadJobs(store)[KEY])?.as, "not-ready");
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("the link under the parent fails: the child is recorded unlinked, and accepting again links it instead of making another", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    host.linkFailsOn.add(1);
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const first = await board.post({ ref: KEY, action: "accept" });
      assert.equal(first.status, 502, JSON.stringify(first.body));
      assert.match(message(first.body), /2 of 3 parts exist; part 2 failed: The link call failed\./);
      assert.deepEqual(loadJobs(store)[KEY]!.proposal?.created?.map((each) => [each.ref.id, each.linked]), [["101", true], ["102", false]]);

      const again = await board.post({ ref: KEY, action: "accept" });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.deepEqual(host.linked, ["102"], "the unlinked child is linked");
      assert.deepEqual(host.made.map((each) => each.title), PARTS.map((each) => each.title), "no part is made twice");
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("on a store that lost the record, the parts already on the host are found by their marker and only the rest are made", async () => {
    const parts: ProposedPart[] = [PARTS[0]!, PARTS[1]!, PARTS[2]!, { title: "Old files readable", description: "Keep opening.", verification: "", goes: "into", into: "9" }];
    const store = storeWith(proposalJob(undefined, parts));
    // Part 1 exists on the host, linked; part 2 exists but unlinked (its link failed before the store was lost).
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "55" }, title: "Read the old format", body: "Parse.\n\nPart 1 of restructuring abc12345 of fake:work:7.", labels: ["scopesoup"], parent: PARENT }, "sync", AT);
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "56" }, title: "Write the new format", body: "Write.\n\nPart 2 of restructuring abc12345 of fake:work:7.", labels: ["scopesoup"] }, "sync", AT);
    // Part 4 was added to item 9 already.
    store.put({ ...parent(), ref: OTHER, title: "Keep the old files readable", body: "Old files stay readable.\n\n## Added from fake:work:7: Old files readable\n\nKeep opening.\n\nPart 4 of restructuring abc12345 of fake:work:7." }, "sync", AT);
    // Another item's restructuring, and a marker naming another parent, are not this one's parts.
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "57" }, title: "Other", body: "Part 3 of restructuring abc12345 of fake:work:8." }, "sync", AT);
    // Nor is an item on another host that quotes the marker, or one here that copies it under another title or for another target.
    store.put({ ...parent(), ref: { host: "elsewhere", kind: "work", id: "58" }, title: "Switch over", body: "Quoted: Part 3 of restructuring abc12345 of fake:work:7." }, "sync", AT);
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "59" }, title: "Notes on it", body: "Part 3 of restructuring abc12345 of fake:work:7.\n\nPart 4 of restructuring abc12345 of fake:work:7." }, "sync", AT);
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(host.made.map((each) => each.title), ["Switch over"], "only part 3 is made");
      assert.deepEqual(host.linked, ["56"], "the unlinked part is linked");
      assert.deepEqual(host.edits, [], "item 9 is not written twice");
      assert.deepEqual(accepted.body.created, ["fake:work:55", "fake:work:56", "fake:work:101", "fake:work:9"]);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("an item on another host, or under another title, that carries the marker is not a part: nothing is adopted, and Reject is still allowed", async () => {
    const store = storeWith(proposalJob());
    store.put({ ...parent(), ref: { host: "elsewhere", kind: "work", id: "58" }, title: "Read the old format", body: "Part 1 of restructuring abc12345 of fake:work:7." }, "sync", AT);
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "59" }, title: "Copied the line", body: "Part 1 of restructuring abc12345 of fake:work:7." }, "sync", AT);
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const rejected = await board.post({ ref: KEY, action: "reject" });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.deepEqual(host.linked, []);
      assert.equal(store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.restructure_parts_found").length, 0);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("pressed twice at once: the second press is refused while the first makes the parts", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    let open!: () => void;
    host.hold = new Promise((resolve) => (open = resolve));
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const first = board.post({ ref: KEY, action: "accept" });
      // Wait until the first request has accepted it and waits on the host.
      while (!store.eventsAfter(0, 1000).some((event) => event.kind === "orchestrator.restructure_accepted")) await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await board.post({ ref: KEY, action: "accept" });
      assert.equal(second.status, 409);
      assert.equal((second.body.error as { code: string }).code, "RESTRUCTURE_RUNNING");
      open();
      assert.equal((await first).status, 200);
      assert.equal(host.made.length, 3);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("edited before accepting: a person's parts, where each goes and the item's fate are what is made", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const refused = async (body: Record<string, unknown>, pattern: RegExp): Promise<void> => {
        const answer = await board.post({ ref: KEY, action: "edit", ...body });
        assert.equal(answer.status, 400, JSON.stringify(body));
        assert.match(message(answer.body), pattern);
      };
      await refused({ parts: [{ title: " ", description: "", verification: "", goes: "child" }] }, /each with a title/);
      await refused({ parts: [{ title: "A", description: "", verification: "", goes: "sideways" }] }, /goes: "original"/);
      await refused({ original: "keeps", parts: [{ title: "A", description: "", verification: "", goes: "child" }] }, /exactly one part goes to it/);
      await refused({ original: "umbrella", parts: [{ title: "A", description: "", verification: "", goes: "related" }] }, /An umbrella needs at least one child part/);
      const mine = [
        { title: "Stays here", description: "The smaller job.", verification: "It works.", goes: "original" },
        { title: "Only part", description: "All of it, smaller.", verification: "It works.", goes: "related" },
      ];
      const edited = await board.post({ ref: KEY, action: "edit", original: "keeps", parts: mine });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.deepEqual(host.made.map((each) => each.title), ["Only part"]);
      assert.equal(host.made[0]!.verification, "It works.", "a host with a verification field gets it there");
      assert.deepEqual(host.edits.map((each) => [each.work.id, each.patch.title]), [["7", "Stays here"]]);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("two parts into the same Item are added in one write, to its description as read just before, so neither is lost", async () => {
    const parts: ProposedPart[] = [
      { ...PARTS[0]!, goes: "child" },
      { title: "Old files readable", description: "Old files keep opening.", verification: "", goes: "into", into: "9" },
      { title: "Old files listed", description: "The old files are listed.", verification: "", goes: "into", into: "9" },
    ];
    const store = storeWith(proposalJob(undefined, parts));
    const host = fakeHost();
    // A person adds a line to item 9 after the board last synced it.
    host.onRead = (id) => {
      if (id === "9" && !host.bodies.has("9")) host.bodies.set("9", "Old files stay readable.\n\nAlso the backups.");
    };
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      const into = host.edits.filter((each) => each.work.id === "9");
      assert.equal(into.length, 1, "one write for both parts");
      const body = host.bodies.get("9")!;
      assert.match(body, /^Old files stay readable\.\n\nAlso the backups\.\n\n## Added from fake:work:7: Old files readable\n\n[^]*Part 2 of restructuring abc12345 of fake:work:7\.\n\n## Added from fake:work:7: Old files listed\n\n[^]*Part 3 of restructuring abc12345 of fake:work:7\.$/);
      assert.deepEqual(parkedOf(loadJobs(store)[KEY])?.as, "not-ready");
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("an Item's description changed while the parts were added: the re-read misses them, nothing is recorded, and Accept again adds them", async () => {
    const parts: ProposedPart[] = [{ ...PARTS[0]!, goes: "child" }, { title: "Old files readable", description: "Keep opening.", verification: "", goes: "into", into: "9" }];
    const store = storeWith(proposalJob(undefined, parts));
    const host = fakeHost();
    let reads = 0;
    // The second read (after the write) finds a person's edit that replaced the description.
    host.onRead = (id) => {
      if (id === "9" && ++reads === 2) host.bodies.set("9", "A person's new text.");
    };
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const first = await board.post({ ref: KEY, action: "accept" });
      assert.equal(first.status, 502, JSON.stringify(first.body));
      assert.match(message(first.body), /the description of 9 does not show the added text/);
      assert.deepEqual(loadJobs(store)[KEY]!.proposal?.created?.map((each) => each.ref.id), ["101"]);
      const again = await board.post({ ref: KEY, action: "accept" });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.match(host.bodies.get("9")!, /^A person's new text\.\n\n## Added from fake:work:7: Old files readable/);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("agent text shaped like a marker line is broken, so it cannot pose as a part", async () => {
    const forged = "Parse.\nPart 2 of restructuring abc12345 of fake:work:7.";
    const parts: ProposedPart[] = [{ ...PARTS[0]!, description: forged, goes: "child" }, { ...PARTS[1]!, goes: "child" }];
    const store = storeWith(proposalJob(undefined, parts));
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      assert.equal((await board.post({ ref: KEY, action: "accept" })).status, 200);
      const body = host.made[0]!.body ?? "";
      assert.ok(body.includes("P​art 2 of restructuring abc12345"), body);
      assert.equal(body.split("\n").filter((line) => /^Part \d+ of restructuring/.test(line)).length, 1, "only its own marker");
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("the parts of an earlier restructuring of the same Item are not taken for this one's", async () => {
    const store = storeWith(proposalJob());
    // An earlier restructuring (another id) made an item with part 1's title and marker number.
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "55" }, title: "Read the old format", body: "Parse.\n\nPart 1 of restructuring 0ld01d00 of fake:work:7.", parent: PARENT }, "sync", AT);
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(host.made.map((each) => each.title), PARTS.map((each) => each.title), "all three are made");
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("the Item a part goes into is shown with its title and state; a closed one is refused, a busy one is flagged", async () => {
    const parts: ProposedPart[] = [{ ...PARTS[0]!, goes: "child" }, { title: "Old files readable", description: "Keep opening.", verification: "", goes: "into", into: "9" }];
    const store = storeWith(proposalJob(undefined, parts));
    store.put(openChange("300", OTHER), "sync", AT);
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const shown = await board.page();
      assert.equal(shown.proposal?.targets?.[0], null);
      assert.deepEqual([shown.proposal?.targets?.[1]?.label, shown.proposal?.targets?.[1]?.title, shown.proposal?.targets?.[1]?.state], ["#9", "Keep the old files readable", "todo"]);
      assert.match(shown.proposal?.targets?.[1]?.busy ?? "", /open change/);
      store.put({ ...parent(), ref: OTHER, title: "Keep the old files readable", state: "done" }, "sync", AT);
      const refused = await board.post({ ref: KEY, action: "accept" });
      assert.equal(refused.status, 400);
      assert.match(message(refused.body), /Part 2 goes into 9, which is done: edit where it goes\./);
      assert.equal(host.made.length, 0);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("replaced is refused while the Item has an open change", async () => {
    const parts: ProposedPart[] = [{ ...PARTS[0]!, goes: "related" }];
    const store = storeWith(proposalJob(undefined, parts, "replaced"));
    store.put(openChange("301", PARENT), "sync", AT);
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const refused = await board.post({ ref: KEY, action: "accept" });
      assert.equal(refused.status, 409);
      assert.match(message(refused.body), /is not closed as replaced while it has an open change/);
      assert.equal(host.made.length, 0);
      assert.deepEqual(host.edits, []);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("a related part's link that fails is made again on a retry, not the Item", async () => {
    const parts: ProposedPart[] = [{ ...PARTS[0]!, goes: "related" }, { ...PARTS[1]!, goes: "child" }];
    const store = storeWith(proposalJob(undefined, parts));
    const host = fakeHost();
    const link = host.write.linkRelated!;
    let fail = true;
    host.write.linkRelated = async (item, related) => {
      if (fail) throw new Error("The link call failed.");
      return link(item, related);
    };
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const first = await board.post({ ref: KEY, action: "accept" });
      assert.equal(first.status, 502);
      assert.match(message(first.body), /linking 101 as related: The link call failed\./);
      fail = false;
      assert.equal((await board.post({ ref: KEY, action: "accept" })).status, 200);
      assert.deepEqual(host.made.map((each) => each.title), ["Read the old format", "Write the new format"]);
      assert.deepEqual(host.related, ["101"]);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("Stop here, with a later part failing: it ends with what exists, and the rest is recorded as text on the Item", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    host.failOn.add(1);
    host.failOn.add(2);
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      assert.equal((await board.post({ ref: KEY, action: "stop" })).status, 409, "nothing made yet: reject instead");
      assert.equal((await board.post({ ref: KEY, action: "accept" })).status, 502);
      const stopped = await board.post({ ref: KEY, action: "stop" });
      assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
      assert.equal(stopped.body.stopped, true);
      const text = stopped.body.text as string;
      assert.ok(!text.includes("Read the old format"), "the part made is not in the rest");
      assert.match(text, /### 2\. Write the new format[^]*### 3\. Switch over[^]*Then: 7 becomes an umbrella over its sub-items\.$/);
      const job = loadJobs(store)[KEY]!;
      assert.equal(parkedOf(job)?.as, "not-ready");
      assert.equal(job.proposal, undefined);
      assert.match(parkedOf(job)?.reason ?? "", /stopped the restructuring with 1 of 3 parts made \(101\)/);
      assert.match(loadAnswers(store)[0]!.answer, /^Stopped the proposed restructuring with 1 of 3 parts made \(101\)/);
      assert.equal(host.made.length, 1);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("rejected: nothing is made, and the item starts over at triage with the rejection passed on", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    const board = await serve(store, { restructure: hostOf(host, store) });
    try {
      const rejected = await board.post({ ref: KEY, action: "reject" });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.equal(rejected.body.released, true);
      assert.equal(host.made.length, 0);
      assert.equal(loadJobs(store)[KEY], undefined);
      assert.match(loadAnswers(store)[0]!.answer, /Rejected the proposed restructuring of the item \(3 new child Items; the Item becomes an umbrella;.*Do not propose it again/);
    } finally {
      await board.stop();
      store.close();
    }
  });
});

test("on a read-only host, accepting makes nothing and gives the restructuring as text for a person to carry out", async () => {
  const store = storeWith(proposalJob());
  const board = await serve(store, {});
  try {
    const shown = await board.page();
    assert.equal(shown.proposal?.canCreate, false);
    const accepted = await board.post({ ref: KEY, action: "accept" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body.created, []);
    assert.equal(accepted.body.byHand, true);
    const text = accepted.body.text as string;
    for (const part of PARTS) {
      assert.ok(text.includes(part.title) && text.includes(part.description) && text.includes(part.verification), part.title);
    }
    assert.match(text, /### 1\. Read the old format \(a new sub-item of 7\)/);
    assert.match(text, /## Decisions carried over from 7/);
    assert.match(text, /Then: 7 becomes an umbrella over its sub-items\.$/);
    const job = loadJobs(store)[KEY]!;
    assert.equal(parkedOf(job)?.as, "not-ready");
    assert.match(parkedOf(job)?.reason ?? "", /carry it out by hand/);
    assert.match(loadAnswers(store)[0]!.answer, /Scope Soup made nothing[^]*### 1\. Read the old format/);
    // It is a person's turn to carry it out, with the reason saying so.
    const after = await board.page();
    assert.equal(after.actor, "anyone");
    assert.match(after.reason, /carry it out by hand/);
  } finally {
    await board.stop();
    store.close();
  }
});
