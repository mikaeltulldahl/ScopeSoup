// A proposed restructuring from triage, decided on the item page (`POST /api/proposal`): accepting makes each part where it goes
// (a child, a related or an unlinked Item, or text added to an existing Item), then the item keeps a part, becomes an umbrella, or
// is closed as replaced. On a read-only host nothing is made and it is given as text. A failure halfway, or a second press, makes
// no part twice. Names are synthetic.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ItemPage } from "../core/views.ts";
import type { CreatedPart, OriginalFate, ProposedPart, Ref, WorkItem } from "../model/types.ts";
import type { Job } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs } from "../orchestrator/jobs.ts";
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

function parent(over: Partial<WorkItem> = {}): WorkItem {
  return { ref: PARENT, title: "Change the file format", body: "Everything about the format.", state: "todo", hostState: "open", labels: ["scopesoup"], blockedBy: [], openChildren: 0, updatedAt: AT, ...over };
}

function proposalJob(created?: CreatedPart[], parts: ProposedPart[] = PARTS, original: OriginalFate = "umbrella"): Job {
  return {
    item: PARENT, workspace: "w", branch: "scopesoup/7", step: "triage", failures: 0, fixRounds: 0, startedAt: AT,
    proposal: { reason: "Triage proposes to restructure the Item.", original, parts, carried: CARRIED, ...(created ? { created } : {}) },
    parked: { as: "needs-decision", reason: "Triage proposes to restructure the Item.", at: AT },
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
  hold?: Promise<void>;
}

/** A host that creates items the way GitHub does: numbered, with a parent link made by a call of its own; it can be made to fail. */
function fakeHost(): FakeHost {
  let calls = 0;
  const state: FakeHost = {
    made: [],
    edits: [],
    failOn: new Set(),
    linkFailsOn: new Set(),
    linked: [],
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
        return { work, shared: "shared", conflict: false };
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

function storeWith(job: Job): Store {
  const store = openStore(":memory:");
  store.put(parent(), "sync", AT);
  store.put({ ...parent(), ref: OTHER, title: "Keep the old files readable", body: "Old files stay readable." }, "sync", AT);
  saveJobs(store, { [KEY]: job });
  return store;
}

const message = (body: Record<string, unknown>): string => (body.error as { message: string }).message;

describe("a proposed restructuring on a writable host", { concurrency: 4 }, () => {
  test("into children under an umbrella: on the item page with its parts; accepting makes them in order as children, with the decisions carried over", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write, verificationInBody: true }] });
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
        assert.match(made.body ?? "", new RegExp(`^${PARTS[index]!.description}\\n\\n## Decisions carried over from 7\\n\\n- Asked: Which format\\?\\n  Answered: Keep the old one readable\\.\\n\\n## Verification\\n\\n${PARTS[index]!.verification}\\n\\nPart ${index + 1} of the restructuring of fake:work:7\\.$`));
        assert.equal(made.verification, undefined, "GitHub keeps the verification in the text");
      }
      assert.deepEqual(host.edits, [], "an umbrella is not changed");
      // The item parked as an umbrella, with what was made; the answer is kept for the sessions.
      const job = loadJobs(store)[KEY]!;
      assert.equal(job.parked?.as, "not-ready");
      assert.equal(job.proposal, undefined);
      assert.match(job.parked?.reason ?? "", /^Restructured into 101 \(a new sub-item of 7\), 102 .*; the work happens there\.$/);
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
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write, issueNumbers: true }] });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(accepted.body.created, ["fake:work:101", "fake:work:102", "fake:work:9"]);
      const [related, unlinked] = host.made;
      assert.equal(related!.parent, undefined);
      assert.deepEqual(related!.relatedTo, PARENT, "a related Item is linked where the host keeps links");
      assert.match(related!.body ?? "", /\n\nPart 2 of the restructuring of #7\.$/, "on GitHub the marker names #7, which links it");
      assert.equal(unlinked!.parent, undefined);
      assert.equal(unlinked!.relatedTo, undefined);
      assert.match(unlinked!.body ?? "", /\n\nPart 3 of the restructuring of fake:work:7\.$/, "an unlinked part's marker makes no link");
      // The part into item 9 is added at the end of its description; then the item itself is narrowed to the part it keeps, inert.
      assert.deepEqual(host.edits.map((each) => each.work.id), ["9", "7"]);
      assert.equal(host.edits[0]!.patch.body, "Old files stay readable.\n\n## Added from #7: Old files readable\n\nOld files keep opening.\n\nVerification: A test opens one.\n\nPart 4 of the restructuring of #7.");
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
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write }] });
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
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write }] });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(host.edits, [{ work: PARENT, patch: { state: "abandoned" } }]);
      assert.match(loadJobs(store)[KEY]!.parked?.reason ?? "", /^Replaced by 101, 102/);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("a part into an Item that is not there is refused before anything is made", async () => {
    const parts: ProposedPart[] = [{ ...PARTS[0]!, goes: "child" }, { ...PARTS[1]!, goes: "into", into: "404" }];
    const store = storeWith(proposalJob(undefined, parts));
    const host = fakeHost();
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write }] });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 400);
      assert.match(message(accepted.body), /Part 2 goes into 404, which is not another Item on fake/);
      assert.equal(host.made.length, 0);
      assert.equal(loadJobs(store)[KEY]!.parked?.as, "needs-decision");
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("fails halfway: what was made is recorded, and accepting again makes only the rest", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    host.failOn.add(1);
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write }] });
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
      assert.equal(halfway.parked?.as, "needs-decision", "still waiting on the restructuring");
      assert.deepEqual(halfway.proposal?.created, [{ part: 0, ref: { host: "fake", kind: "work", id: "101" }, linked: true }]);

      // The edit after a part exists does not change it: the same parts are finished.
      const again = await board.post({ ref: KEY, action: "edit", original: "umbrella", parts: [{ title: "Something else", description: "", verification: "", goes: "child" }] });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.deepEqual(again.body.created, ["fake:work:101", "fake:work:102", "fake:work:103"]);
      assert.deepEqual(host.made.map((each) => each.title), PARTS.map((each) => each.title), "each part made once, in order");
      assert.equal(loadJobs(store)[KEY]!.parked?.as, "not-ready");
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("the link under the parent fails: the child is recorded unlinked, and accepting again links it instead of making another", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    host.linkFailsOn.add(1);
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write }] });
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
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "55" }, title: "Read the old format", body: "Parse.\n\nPart 1 of the restructuring of fake:work:7.", labels: ["scopesoup"], parent: PARENT }, "sync", AT);
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "56" }, title: "Write the new format", body: "Write.\n\nPart 2 of the restructuring of fake:work:7.", labels: ["scopesoup"] }, "sync", AT);
    // Part 4 was added to item 9 already.
    store.put({ ...parent(), ref: OTHER, title: "Keep the old files readable", body: "Old files stay readable.\n\n## Added from fake:work:7: Old files readable\n\nKeep opening.\n\nPart 4 of the restructuring of fake:work:7." }, "sync", AT);
    // Another item's restructuring, and a marker naming another parent, are not this one's parts.
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "57" }, title: "Other", body: "Part 3 of the restructuring of fake:work:8." }, "sync", AT);
    // Nor is an item on another host that quotes the marker, or one here that copies it under another title or for another target.
    store.put({ ...parent(), ref: { host: "elsewhere", kind: "work", id: "58" }, title: "Switch over", body: "Quoted: Part 3 of the restructuring of fake:work:7." }, "sync", AT);
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "59" }, title: "Notes on it", body: "Part 3 of the restructuring of fake:work:7.\n\nPart 4 of the restructuring of fake:work:7." }, "sync", AT);
    const host = fakeHost();
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write }] });
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
    store.put({ ...parent(), ref: { host: "elsewhere", kind: "work", id: "58" }, title: "Read the old format", body: "Part 1 of the restructuring of fake:work:7." }, "sync", AT);
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "59" }, title: "Copied the line", body: "Part 1 of the restructuring of fake:work:7." }, "sync", AT);
    const host = fakeHost();
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write }] });
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
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write }] });
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
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write }] });
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

  test("rejected: nothing is made, and the item starts over at triage with the rejection passed on", async () => {
    const store = storeWith(proposalJob());
    const host = fakeHost();
    const board = await serve(store, { restructure: [{ host: "fake", write: host.write }] });
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
    assert.equal(job.parked?.as, "not-ready");
    assert.match(job.parked?.reason ?? "", /carry it out by hand/);
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
