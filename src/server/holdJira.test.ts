// The Item page's Claim, Hand back and Release on a Jira host, Cloud and Data Center, against the fake Jira: the server's token
// writes for the board's picked person, by the item commands' rules (`src/items/service.ts`, `src/items/jiraBackend.ts`). And the
// meta branch and GitHub are as they were. Synthetic names only.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ItemPage } from "../core/views.ts";
import { personOf } from "../core/turns.ts";
import { CLAIM_PROPERTY, COMMENT_PROPERTY } from "../hosts/jira/conventions.ts";
import type { Writable } from "../hosts/jira/testHost.ts";
import { writable } from "../hosts/jira/testHost.ts";
import { jiraBoard } from "../items/jiraBackend.ts";
import { fixedBranches } from "../items/remoteBranch.ts";
import { findHandbacks } from "../orchestrator/handback.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import { createSync } from "../sync/index.ts";
import { demoBranches, demoItemsHost, seedDemo } from "./demo.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

const SHA = "b".repeat(40);
const UNTIL = "2026-11-21T11:00:00.000Z";
const PICK = "Pick who you are at the top of the board first.";
const PERSON_KINDS = ["person.claimed", "person.handed_back", "person.released"];

const as = (person?: string): Record<string, string> => (person ? { "X-ScopeSoup-Person": encodeURIComponent(person) } : {});

async function call(base: string, path: string, person?: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(base + path, body === undefined ? { headers: as(person) } : { method: "POST", headers: { "Content-Type": "application/json", ...as(person) }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const refusal = (answer: { status: number; body: Record<string, unknown> }): [number, string] => {
  const error = answer.body.error as { code: string; message: string } | undefined;
  return [answer.status, error?.message ?? ""];
};

interface Board {
  w: Writable;
  store: Store;
  base: string;
  server: ScopeSoupServer;
  hold(id: string, person?: string): Promise<ItemPage["hold"]>;
  post(verb: string, person: string | undefined, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  /** The newest comment on the issue, its text as sent, and its Scope Soup property. */
  last(id: string): { author: string; text: string; property: Record<string, unknown> | undefined };
}

async function board(deployment: "cloud" | "datacenter", sleep?: (ms: number) => Promise<void>): Promise<Board> {
  const w = writable(deployment);
  const store = openStore(":memory:");
  const sync = createSync({ store, hosts: [w.host], intervalMs: 60_000, now: () => new Date(w.clock.ms), setTimer: () => () => {} });
  await sync.refreshNow();
  const now = () => new Date(w.clock.ms);
  const server = createServer({
    store, port: 0, now, jiraItems: jiraBoard(w.host, { now, sleep: sleep ?? (async () => {}) }),
    branches: fixedBranches(() => ({ state: "ready", sha: SHA, ahead: 1 })), syncNow: () => sync.refreshNow(),
  });
  const base = (await server.start()).url;
  return {
    w, store, base, server,
    hold: async (id, person) => ((await call(base, `/api/item?ref=jira:work:${id}`, person)).body as unknown as ItemPage).hold,
    post: (verb, person, body) => call(base, `/api/item/${verb}`, person, body),
    last: (id) => {
      const comment = w.fake.comments[id]!.at(-1)!;
      return { author: comment.author?.displayName ?? "", text: JSON.stringify(comment.body), property: w.fake.commentProperties[comment.id]?.[COMMENT_PROPERTY] as Record<string, unknown> | undefined };
    },
  };
}

const done = async (b: Board): Promise<void> => {
  await b.server.stop();
  b.store.close();
};

for (const deployment of ["cloud", "datacenter"] as const) {
  describe(`the hold buttons on Jira ${deployment}`, { concurrency: 4 }, () => {
    test("claim makes the picked person the assignee; hand back is the server's comment that names them, and it counts", async () => {
      const b = await board(deployment);
      const robin = deployment === "cloud" ? b.w.person.accountId! : b.w.person.name!;
      try {
        assert.deepEqual(await b.hold("DEMO-5"), { claim: { why: PICK } });
        assert.deepEqual(await b.hold("DEMO-5", "Robin Example"), { claim: {} });
        const claimed = await b.post("claim", "robin example", { id: "demo-5" });
        assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
        assert.match(String(claimed.body.message), /^Robin Example holds DEMO-5 "Colour the cards" \(assigned on Jira\)\. Scope Soup will not start it\.$/);
        assert.equal(b.w.fake.issues.get("DEMO-5")!.fields.assignee?.displayName, "Robin Example");

        // The holder sees Hand back, Release and the branch; anyone else Claim (refused, with why) and Release.
        const mine = await b.hold("DEMO-5", "Robin Example");
        assert.deepEqual([mine?.claim, mine?.handBack, mine?.release, mine?.branch?.name], [undefined, {}, {}, "scopesoup/DEMO-5"]);
        const kims = await b.hold("DEMO-5", "Kim");
        assert.match(kims?.claim?.why ?? "", /held by Robin Example\. Ask them, or release it first \(anyone may\)\.$/);
        assert.deepEqual([kims?.handBack, kims?.release], [undefined, {}]);
        assert.deepEqual((await call(b.base, "/api/item/branch?id=DEMO-5", "Robin Example")).body, { branch: "scopesoup/DEMO-5", onRemote: true });
        assert.match(refusal(await b.post("handback", "Kim", { id: "DEMO-5" }))[1], /held by Robin Example, not by Kim\. Only the holder hands an item back\./);

        // Robin hands it back by her account id (Cloud) or user name (Data Center): the server's comment, which names her.
        const handed = await b.post("handback", robin, { id: "DEMO-5", note: "Fixes the colours, ask @kim." });
        assert.equal(handed.status, 200, JSON.stringify(handed.body));
        assert.equal(b.w.fake.issues.get("DEMO-5")!.fields.assignee, null);
        const comment = b.last("DEMO-5");
        assert.equal(comment.author, "Scope Soup Bot");
        assert.match(comment.text, /Handed back.{0,60} by Robin Example on/);
        assert.deepEqual(comment.property?.person, { id: robin, name: "Robin Example" });
        assert.ok(!String(comment.property?.note).includes("@kim"));
        // Scope Soup's own account wrote it, so it counts, as hers.
        const item = (await b.w.host.work.getWork(b.w.ref("DEMO-5")))!;
        assert.equal(item.handedBack?.sha, SHA);
        assert.deepEqual(item.handedBack?.by, { id: robin, name: "Robin Example" });
        assert.deepEqual(findHandbacks([item], []).map((each) => [each.branch, each.sha, each.by]), [["scopesoup/DEMO-5", SHA, "Robin Example"]]);
        assert.equal(personOf({ item })?.name, "Robin Example");

        // Each press is an event naming who pressed it.
        const events = b.store.eventsOfKinds(PERSON_KINDS, 10).map((event) => [event.kind, event.actor, (event.data as { account?: string }).account]);
        assert.deepEqual(events.sort(), [["person.claimed", "robin example", robin], ["person.handed_back", robin, robin]].sort());
      } finally {
        await done(b);
      }
    });

    test("release always leaves a comment naming who pressed it; anyone may release a person's hold", async () => {
      const b = await board(deployment);
      try {
        assert.equal((await b.post("claim", "Robin Example", { id: "DEMO-5" })).status, 200);
        const own = await b.post("release", "Robin Example", { id: "DEMO-5" });
        assert.equal(own.status, 200, JSON.stringify(own.body));
        assert.equal(b.w.fake.issues.get("DEMO-5")!.fields.assignee, null);
        assert.match(b.last("DEMO-5").text, /Released by Robin Example\./);
        assert.equal((await b.post("claim", "Robin Example", { id: "DEMO-5" })).status, 200);
        const other = await b.post("release", "Kim", { id: "DEMO-5", note: "Robin is away." });
        assert.equal(other.status, 200, JSON.stringify(other.body));
        assert.match(String(other.body.message), /^Kim released Robin Example's hold on DEMO-5/);
        assert.match(b.last("DEMO-5").text, /Released by Kim, held by Robin Example: Robin is away\./);
        assert.equal(b.w.fake.issues.get("DEMO-5")!.fields.assignee, null);
        assert.deepEqual(b.store.eventsOfKinds(["person.released"], 10).map((event) => event.actor).sort(), ["Kim", "Robin Example"]);
      } finally {
        await done(b);
      }
    });

    test("claim refuses a name Jira cannot assign, Scope Soup's own account, and an agent's claim, which release refuses too", async () => {
      const b = await board(deployment);
      try {
        assert.match(refusal(await b.post("claim", "Nobody Known", { id: "DEMO-5" }))[1], /"Nobody Known" is not someone Jira can assign this Item to/);
        assert.match(refusal(await b.post("claim", "Scope Soup Bot", { id: "DEMO-5" }))[1], /Scope Soup's own account or an app on Jira, not a person/);
        assert.match(refusal(await b.post("claim", "Robin Example", { id: "five" }))[1], /"five" is not a Jira issue key/);
        assert.equal(b.w.fake.issues.get("DEMO-5")!.fields.assignee, null);

        assert.deepEqual(await b.w.write.claim!(b.w.ref("DEMO-5"), { until: UNTIL, shown: "laptop-a" }), { won: true });
        assert.equal((await b.post("claim", "Robin Example", { id: "DEMO-5" })).status, 409);
        assert.match(refusal(await b.post("release", "Robin Example", { id: "DEMO-5" }))[1], /held by scopesoup on laptop-a, an agent that is working on it/);
        assert.equal(b.w.fake.issues.get("DEMO-5")!.fields.assignee, null);
        assert.deepEqual(b.store.eventsOfKinds(PERSON_KINDS, 10), []);
      } finally {
        await done(b);
      }
    });

    test("an agent's claim that lands while the assignee settles stands: the picked person is unassigned again", async () => {
      let b: Board | undefined;
      const self = deployment === "cloud" ? "000000:scopesoup-0002" : "scopesoup";
      b = await board(deployment, async () => {
        b!.w.fake.issueProperties["DEMO-5"] = { [CLAIM_PROPERTY]: { v: 1, by: self, claims: [{ machine: "desk", until: UNTIL, released: false, at: "2026-11-21T09:00:00.000Z", nonce: "n1" }] } };
      });
      try {
        assert.match(refusal(await b.post("claim", "Robin Example", { id: "DEMO-5" }))[1], /was taken by scopesoup on desk first, an agent that is working on it\. It is not yours\./);
        assert.equal(b.w.fake.issues.get("DEMO-5")!.fields.assignee, null);
      } finally {
        await done(b);
      }
    });
  });
}

describe("the meta branch and GitHub are as they were", { concurrency: 1 }, () => {
  test("the demo's Items host: the board writes log lines, no Jira events; a host without a log offers no buttons", async () => {
    const store = openStore(":memory:");
    const now = new Date("2026-11-23T09:00:00Z");
    seedDemo(store, now);
    const meta = createServer({ store, port: 0, now: () => now, machine: "demo", items: demoItemsHost(store, () => now), branches: demoBranches(store, () => now) });
    const base = (await meta.start()).url;
    try {
      assert.equal((await call(base, "/api/item/claim", "ines", { id: "81" })).status, 200);
      const page = (await call(base, "/api/item?ref=demo:work:81", "ines")).body as unknown as ItemPage;
      assert.equal(page.item.holder?.actor.name, "ines on demo");
      assert.equal((await call(base, "/api/item/release", "ines", { id: "81" })).status, 200);
      assert.deepEqual(store.eventsOfKinds(PERSON_KINDS, 10), []);
    } finally {
      await meta.stop();
    }
    // A host whose Items have no log of their own (GitHub's shape: assignees and comments): no buttons, as before.
    const github = createServer({ store, port: 0, now: () => now, items: { host: "demo", write: { setAssignees: async () => {}, comment: async () => {} }, work: demoItemsHost(store, () => now).work } });
    const other = (await github.start()).url;
    try {
      assert.equal(((await call(other, "/api/item?ref=demo:work:48", "mira")).body as unknown as ItemPage).hold, undefined);
    } finally {
      await github.stop();
      store.close();
    }
  });
});
