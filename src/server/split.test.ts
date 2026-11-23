// A proposed split from triage, decided on the item page (`POST /api/proposal`): accepting creates the parts as
// children of the item, invited and linked, and the item becomes an umbrella. On a read-only host nothing is created
// and the parts are given as text. A failure halfway, or a second press, makes no child twice. Names are synthetic.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ItemPage } from "../core/views.ts";
import type { CreatedPart, ProposedPart, Ref, WorkItem } from "../model/types.ts";
import type { Job } from "../orchestrator/jobs.ts";
import { loadJobs, saveJobs } from "../orchestrator/jobs.ts";
import type { NewWork, WriteOutcome, WritePort } from "../ports/host.ts";
import { loadAnswers } from "../store/answers.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import { createServer } from "./server.ts";
import type { ServerOptions } from "./server.ts";

const AT = "2026-11-18T09:00:00.000Z";
const PARENT: Ref = { host: "fake", kind: "work", id: "7" };
const KEY = "fake:work:7";
const PARTS: ProposedPart[] = [
  { title: "Read the old format", description: "Parse the old files.", verification: "A test reads a sample." },
  { title: "Write the new format", description: "Write the new files.", verification: "A test writes a sample." },
  { title: "Switch over", description: "Use the new format everywhere.", verification: "The suite passes." },
];
const CARRIED = "- Asked: Which format?\n  Answered: Keep the old one readable.";

function parent(over: Partial<WorkItem> = {}): WorkItem {
  return { ref: PARENT, title: "Change the file format", body: "Everything about the format.", state: "todo", hostState: "open", labels: ["scopesoup"], blockedBy: [], openChildren: 0, updatedAt: AT, ...over };
}

function splitJob(created?: CreatedPart[]): Job {
  return {
    item: PARENT, workspace: "w", branch: "scopesoup/7", step: "triage", failures: 0, fixRounds: 0, startedAt: AT,
    proposal: { reason: "Triage: too large for one change; it proposes 3 parts.", parts: PARTS, carried: CARRIED, ...(created ? { created } : {}) },
    parked: { as: "needs-decision", reason: "Triage: too large for one change; it proposes 3 parts.", at: AT },
  };
}

interface FakeHost {
  write: WritePort;
  made: NewWork[];
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
    failOn: new Set(),
    linkFailsOn: new Set(),
    linked: [],
    write: {
      async createWork(input: NewWork): Promise<WriteOutcome> {
        if (state.hold) await state.hold;
        const call = calls++;
        if (state.failOn.has(call)) throw new Error("The host is down.");
        if (!input.parent) throw new Error("A split's part must have a parent.");
        state.made.push(input);
        const work: Ref = { host: "fake", kind: "work", id: String(100 + state.made.length) };
        if (state.linkFailsOn.has(call)) return { work, shared: "shared", conflict: false, linked: false, problem: "The link call failed." };
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
  saveJobs(store, { [KEY]: job });
  return store;
}

describe("a proposed split on a writable host", { concurrency: 4 }, () => {
  test("is on the item page with its parts; accepting creates them in order as children, invited, with the decisions carried over, and the item becomes an umbrella", async () => {
    const store = storeWith(splitJob());
    const host = fakeHost();
    const board = await serve(store, { split: [{ host: "fake", write: host.write, verificationInBody: true }] });
    try {
      const shown = await board.page();
      assert.deepEqual(shown.proposal?.parts, PARTS);
      assert.equal(shown.proposal?.carried, CARRIED);
      assert.equal(shown.proposal?.canCreate, true);
      assert.equal(shown.actor, "anyone");
      assert.match(shown.reason, /^Accept, edit or reject the proposed split/);

      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(accepted.body.created, ["fake:work:101", "fake:work:102", "fake:work:103"]);
      assert.deepEqual(host.made.map((each) => each.title), PARTS.map((each) => each.title));
      for (const [index, made] of host.made.entries()) {
        assert.deepEqual(made.parent, PARENT, "linked under the item");
        assert.deepEqual(made.labels, [], "no invite label");
        assert.match(made.body ?? "", new RegExp(`^${PARTS[index]!.description}\\n\\n## Decisions carried over from 7\\n\\n- Asked: Which format\\?\\n  Answered: Keep the old one readable\\.\\n\\n## Verification\\n\\n${PARTS[index]!.verification}\\n\\nPart ${index + 1} of the split of fake:work:7\\.$`));
        assert.equal(made.verification, undefined, "GitHub keeps the verification in the text");
      }
      // The item parked as an umbrella's "too large", with what was made; the answer is kept for the sessions.
      const job = loadJobs(store)[KEY]!;
      assert.equal(job.parked?.as, "not-ready");
      assert.equal(job.proposal, undefined);
      assert.match(job.parked?.reason ?? "", /^Split into 3 sub-items \(101, 102, 103\)/);
      assert.match(loadAnswers(store)[0]!.answer, /Accepted the proposed split: Scope Soup created 3 sub-items of 7/);
      const done = store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.split_done");
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

  test("fails halfway: what was made is recorded, and accepting again makes only the rest", async () => {
    const store = storeWith(splitJob());
    const host = fakeHost();
    host.failOn.add(1);
    const board = await serve(store, { split: [{ host: "fake", write: host.write }] });
    try {
      const first = await board.post({ ref: KEY, action: "accept" });
      assert.equal(first.status, 502, JSON.stringify(first.body));
      assert.match((first.body.error as { message: string }).message, /1 of 3 parts exist; part 2 failed: The host is down\./);
      // With a part made, the split can be finished but no longer rejected: that would leave the part without its umbrella.
      const shownHalf = await board.page();
      assert.deepEqual(shownHalf.proposal?.created?.map((each) => each.key), ["fake:work:101"]);
      const rejected = await board.post({ ref: KEY, action: "reject" });
      assert.equal(rejected.status, 409);
      assert.equal((rejected.body.error as { code: string }).code, "PARTS_CREATED");
      assert.equal(loadJobs(store)[KEY]!.parked?.as, "needs-decision", "the reject changed nothing");
      const halfway = loadJobs(store)[KEY]!;
      assert.equal(halfway.parked?.as, "needs-decision", "still waiting on the split");
      assert.deepEqual(halfway.proposal?.created, [{ part: 0, ref: { host: "fake", kind: "work", id: "101" }, linked: true }]);
      const shown = await board.page();
      assert.deepEqual(shown.proposal?.created?.map((each) => each.key), ["fake:work:101"]);

      // The edit after a child exists does not change the split: the same parts are finished.
      const again = await board.post({ ref: KEY, action: "edit", parts: [{ title: "Something else", description: "", verification: "" }] });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.deepEqual(again.body.created, ["fake:work:101", "fake:work:102", "fake:work:103"]);
      assert.deepEqual(host.made.map((each) => each.title), PARTS.map((each) => each.title), "each part made once, in order");
      assert.equal(made(host, "Read the old format"), 1);
      assert.equal(loadJobs(store)[KEY]!.parked?.as, "not-ready");
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("the link under the parent fails: the child is recorded unlinked, and accepting again links it instead of making another", async () => {
    const store = storeWith(splitJob());
    const host = fakeHost();
    host.linkFailsOn.add(1);
    const board = await serve(store, { split: [{ host: "fake", write: host.write }] });
    try {
      const first = await board.post({ ref: KEY, action: "accept" });
      assert.equal(first.status, 502, JSON.stringify(first.body));
      assert.match((first.body.error as { message: string }).message, /2 of 3 parts exist; part 2 failed: The link call failed\./);
      assert.deepEqual(loadJobs(store)[KEY]!.proposal?.created?.map((each) => [each.ref.id, each.linked]), [["101", true], ["102", false]]);

      const again = await board.post({ ref: KEY, action: "accept" });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.deepEqual(host.linked, ["102"], "the unlinked child is linked");
      assert.deepEqual(host.made.map((each) => each.title), PARTS.map((each) => each.title), "no part is made twice");
      assert.deepEqual(again.body.created, ["fake:work:101", "fake:work:102", "fake:work:103"]);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("on a store that lost the record, the parts already on the host are found by their marker and only the rest are made", async () => {
    const store = storeWith(splitJob());
    // Part 1 exists on the host, linked; part 2 exists but unlinked (its link failed before the store was lost).
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "55" }, title: "Read the old format", body: "Parse.\n\nPart 1 of the split of fake:work:7.", labels: ["scopesoup"], parent: PARENT }, "sync", AT);
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "56" }, title: "Write the new format", body: "Write.\n\nPart 2 of the split of fake:work:7.", labels: ["scopesoup"] }, "sync", AT);
    // Another item's split, and a marker naming another parent, are not this split's parts.
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "57" }, title: "Other", body: "Part 3 of the split of fake:work:8." }, "sync", AT);
    // Nor is an item on another host that quotes this split's marker, or one here that copies it under another title.
    store.put({ ...parent(), ref: { host: "elsewhere", kind: "work", id: "58" }, title: "Switch over", body: "Quoted: Part 3 of the split of fake:work:7." }, "sync", AT);
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "59" }, title: "Notes on the split", body: "Part 3 of the split of fake:work:7." }, "sync", AT);
    const host = fakeHost();
    const board = await serve(store, { split: [{ host: "fake", write: host.write }] });
    try {
      const accepted = await board.post({ ref: KEY, action: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(host.made.map((each) => each.title), ["Switch over"], "only part 3 is made");
      assert.deepEqual(host.linked, ["56"], "the unlinked part is linked");
      assert.deepEqual(accepted.body.created, ["fake:work:55", "fake:work:56", "fake:work:101"]);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("an item on another host, or under another title, that carries the marker is not a part: nothing is adopted, and Reject is still allowed", async () => {
    const store = storeWith(splitJob());
    store.put({ ...parent(), ref: { host: "elsewhere", kind: "work", id: "58" }, title: "Read the old format", body: "Part 1 of the split of fake:work:7." }, "sync", AT);
    store.put({ ...parent(), ref: { host: "fake", kind: "work", id: "59" }, title: "Copied the line", body: "Part 1 of the split of fake:work:7." }, "sync", AT);
    const host = fakeHost();
    const board = await serve(store, { split: [{ host: "fake", write: host.write }] });
    try {
      const rejected = await board.post({ ref: KEY, action: "reject" });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.deepEqual(host.linked, []);
      assert.equal(store.eventsAfter(0, 1000).filter((event) => event.kind === "orchestrator.split_children_found").length, 0);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("pressed twice at once: the second press is refused while the first creates the parts", async () => {
    const store = storeWith(splitJob());
    const host = fakeHost();
    let open!: () => void;
    host.hold = new Promise((resolve) => (open = resolve));
    const board = await serve(store, { split: [{ host: "fake", write: host.write }] });
    try {
      const first = board.post({ ref: KEY, action: "accept" });
      // Wait until the first request has accepted the split and waits on the host.
      while (!store.eventsAfter(0, 1000).some((event) => event.kind === "orchestrator.split_accepted")) await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await board.post({ ref: KEY, action: "accept" });
      assert.equal(second.status, 409);
      assert.equal((second.body.error as { code: string }).code, "SPLIT_RUNNING");
      open();
      assert.equal((await first).status, 200);
      assert.equal(host.made.length, 3);
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("edited before accepting: a person's parts are created", async () => {
    const store = storeWith(splitJob());
    const host = fakeHost();
    const board = await serve(store, { split: [{ host: "fake", write: host.write }] });
    try {
      assert.equal((await board.post({ ref: KEY, action: "edit", parts: [{ title: " ", description: "", verification: "" }] })).status, 400);
      const mine = [{ title: "Only part", description: "All of it, smaller.", verification: "It works." }];
      const edited = await board.post({ ref: KEY, action: "edit", parts: mine });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.deepEqual(host.made.map((each) => each.title), ["Only part"]);
      assert.equal(host.made[0]!.verification, "It works.", "a host with a verification field gets it there");
    } finally {
      await board.stop();
      store.close();
    }
  });

  test("rejected: nothing is created, and the item starts over at triage with the rejection passed on", async () => {
    const store = storeWith(splitJob());
    const host = fakeHost();
    const board = await serve(store, { split: [{ host: "fake", write: host.write }] });
    try {
      const rejected = await board.post({ ref: KEY, action: "reject" });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.equal(rejected.body.released, true);
      assert.equal(host.made.length, 0);
      assert.equal(loadJobs(store)[KEY], undefined);
      assert.match(loadAnswers(store)[0]!.answer, /Rejected the proposed split.*Do not propose that split again/);
    } finally {
      await board.stop();
      store.close();
    }
  });
});

test("on a read-only host, accepting creates nothing and gives the parts as text for a person to create by hand", async () => {
  const store = storeWith(splitJob());
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
    assert.match(text, /## Decisions carried over from 7/);
    const job = loadJobs(store)[KEY]!;
    assert.equal(job.parked?.as, "not-ready");
    assert.match(job.parked?.reason ?? "", /create them by hand as sub-items of 7/);
    assert.match(loadAnswers(store)[0]!.answer, /Scope Soup created nothing[^]*### 1\. Read the old format/);
    // It is a person's turn to make them, with the reason saying so.
    const after = await board.page();
    assert.equal(after.actor, "anyone");
    assert.match(after.reason, /create them by hand/);
  } finally {
    await board.stop();
    store.close();
  }
});

function made(host: { made: NewWork[] }, title: string): number {
  return host.made.filter((each) => each.title === title).length;
}
