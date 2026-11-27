// Claim, hand back and release an Item from the board. The three calls run the item commands' rules (`src/items/service.ts`)
// for the board's picked person; the Item page says which buttons apply and why one cannot be pressed. The holder sees the
// Item's branch and the commands, and Hand back reads the branch from the remote. A real temporary meta ref and a real remote,
// synthetic names.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { BoardView, ItemBranch, ItemBranchState, ItemPage } from "../core/views.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import { remoteBranches } from "../items/remoteBranch.ts";
import type { Change, Ref } from "../model/types.ts";
import { saveJobs, atStep } from "../orchestrator/jobs.ts";
import { workspaceKey } from "../orchestrator/paths.ts";
import { realGit } from "../orchestrator/process.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import { createSync } from "../sync/index.ts";
import { DEMO_PUSH_MS, demoBranches, demoItemsHost, demoTip, seedDemo } from "./demo.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

/** The branch and the commands the holder of A-1 sees. */
const A1: ItemBranch = {
  name: "scopesoup/A-1", remote: "origin", mainBranch: "main",
  start: "git fetch origin && git switch -c scopesoup/A-1 origin/main", resume: "git fetch origin && git switch scopesoup/A-1", push: "git push origin scopesoup/A-1",
};
const as = (person?: string): Record<string, string> => (person ? { "X-ScopeSoup-Person": encodeURIComponent(person) } : {});

async function call(base: string, path: string, person?: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(base + path, body === undefined ? { headers: as(person) } : { method: "POST", headers: { "Content-Type": "application/json", ...as(person) }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const refusal = (answer: { status: number; body: Record<string, unknown> }): [number, string, string] => {
  const error = answer.body.error as { code: string; message: string } | undefined;
  return [answer.status, error?.code ?? "", error?.message ?? ""];
};

describe("the hold buttons over HTTP", { concurrency: 1 }, () => {
  let repo: TestRepo;
  let origin: TestRepo;
  let originMain: string;
  let host: MetaBranchHost;
  let store: Store;
  let server: ScopeSoupServer;
  let base: string;
  let tick = 0;
  const clock = (): string => new Date(Date.parse("2026-11-23T09:00:00Z") + 60_000 * tick++).toISOString();
  const item = (id: string): Ref => ({ host: "metaBranch", kind: "work", id });
  const hold = async (id: string, person?: string) => ((await call(base, `/api/item?ref=metaBranch:work:${id}`, person)).body as unknown as ItemPage).hold;

  before(async () => {
    repo = createTestRepo();
    repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-22T08:00:00Z");
    // The project's remote, where a person pushes the Item's branch.
    origin = createTestRepo();
    originMain = origin.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-22T08:00:00Z");
    repo.git(["remote", "add", "origin", origin.dir]);
    const branches = remoteBranches(realGit, () => ({ repo: repo.dir, remote: "origin", mainBranch: "main" }));
    host = createMetaBranchHost({ repoDir: repo.dir, allowWrites: true, remote: null, person: { name: "Test Person", email: "test.person@example.invalid" }, machine: "laptop-a", idPrefix: "A", now: clock });
    store = openStore(":memory:");
    const sync = createSync({ store, hosts: [host], intervalMs: 60_000, useWatch: false });
    server = createServer({ store, port: 0, now: () => new Date(clock()), machine: "laptop-a", items: { host: "metaBranch", write: host.write!, work: host.work }, branches, syncNow: () => sync.refreshNow() });
    base = (await server.start()).url;
    for (const title of ["Paint the fence", "Oil the gate", "Sweep the yard"]) assert.equal((await call(base, "/api/items", "Ada", { title })).status, 200);
  });

  after(async () => {
    await server.stop();
    await host.stop();
    store.close();
    repo.cleanup();
    origin.cleanup();
  });

  test("claim: the page offers it to anyone but the holder, and says why it cannot be pressed", async () => {
    assert.deepEqual(await hold("A-1"), { claim: {  why: "Pick who you are at the top of the board first." } });
    assert.deepEqual(await hold("A-1", "Ada"), { claim: { } });
    const taken = await call(base, "/api/item/claim", "Ada", { id: "A-1" });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.match(String(taken.body.message), /Ada holds A-1 "Paint the fence"\. Scope Soup will not start it\. It moved from Backlog to To do\./);
    // The claim, then the move out of Backlog (decision 121).
    const lines = (await host.work.getWork(item("A-1")))!.log!.slice(-2);
    assert.deepEqual(lines.map((line) => [line.kind, line.by.who, line.by.agent]), [["claimed", "Ada", false], ["edited", "Ada", false]]);
    // The holder hands back or releases, and sees the Item's branch with the commands; another person sees why Claim is not for
    // them, and may release.
    assert.deepEqual(await hold("A-1", "Ada"), { handBack: {}, release: {}, branch: A1 });
    // Not on the remote yet, so the page shows the command that starts it.
    assert.deepEqual((await call(base, "/api/item/branch?id=A-1", "Ada")).body as unknown as ItemBranchState, { branch: "scopesoup/A-1", onRemote: false });
    assert.deepEqual(await hold("A-1", "Bo"), { claim: {  why: 'A-1 "Paint the fence" is held by Ada on laptop-a. Ask them, or release it first (anyone may).' }, release: {} });
    // Refused: another person's hold, and a session of Scope Soup's running on the item.
    assert.deepEqual(refusal(await call(base, "/api/item/claim", "Bo", { id: "A-1" })).slice(0, 2), [409, "REFUSED"]);
    saveJobs(store, { "metaBranch:work:A-2": { item: item("A-2"), workspace: workspaceKey(item("A-2")), branch: "scopesoup/A-2", failures: 0, fixRounds: 0, startedAt: clock(), at: atStep("implement", { is: "running", session: "s-1" }) } });
    const running = refusal(await call(base, "/api/item/claim", "Bo", { id: "A-2" }));
    assert.deepEqual(running.slice(0, 2), [409, "REFUSED"]);
    assert.match(running[2], /A-2 has its implement session running now/);
    assert.match((await hold("A-2", "Bo"))?.claim?.why ?? "", /session running now/);
    saveJobs(store, {});
    assert.deepEqual(refusal(await call(base, "/api/item/claim", undefined, { id: "A-2" })).slice(0, 2), [400, "BAD_FIELD"]);
  });

  test("hand back: only the holder; the branch is read from the remote, missing or empty is refused, its tip is recorded", async () => {
    const refused = refusal(await call(base, "/api/item/handback", "Bo", { id: "A-1" }));
    assert.deepEqual(refused.slice(0, 2), [409, "REFUSED"]);
    assert.match(refused[2], /held by Ada on laptop-a, not by Bo\. Only the holder hands an item back\./);
    assert.match(refusal(await call(base, "/api/item/handback", "Ada", { id: "A-3" }))[2], /A-3 "Sweep the yard" is not held by anyone\. Claim it first/);
    // Not pushed yet.
    assert.deepEqual(refusal(await call(base, "/api/item/handback", "Ada", { id: "A-1" })), [409, "REFUSED", 'scopesoup/A-1 is not on origin. Push it with "git push origin scopesoup/A-1", then hand back.']);
    // Pushed, but with nothing beyond main.
    origin.git(["update-ref", "refs/heads/scopesoup/A-1", originMain]);
    assert.deepEqual((await call(base, "/api/item/branch?id=A-1", "Ada")).body as unknown as ItemBranchState, { branch: "scopesoup/A-1", onRemote: true });
    assert.match(refusal(await call(base, "/api/item/handback", "Ada", { id: "A-1" }))[2], /^scopesoup\/A-1 on origin has no commits beyond main: there is nothing to hand back\./);
    assert.equal((await host.work.getWork(item("A-1")))!.holder?.actor.name, "Ada on laptop-a");
    // A commit pushed on it: that is what is handed back, with no branch or commit in the call.
    const tip = origin.commit("refs/heads/scopesoup/A-1", { "README.md": "The project.\n", "fence.txt": "Two coats.\n" }, "2026-11-23T10:00:00Z");
    const done = await call(base, "/api/item/handback", "Ada", { id: "A-1", note: "Two coats." });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.match(String(done.body.message), new RegExp(`Handed back A-1 "Paint the fence" on scopesoup/A-1 \\(${tip.slice(0, 9)}\\)\\. Scope Soup reviews it next`));
    const after = (await host.work.getWork(item("A-1")))!;
    assert.equal(after.holder, undefined);
    assert.deepEqual(after.log!.slice(-2).map((line) => [line.kind, line.by.who, line.fields.sha, line.fields.branch, line.fields.handback, line.fields.note]), [
      ["revision", "Ada", tip, "scopesoup/A-1", true, "Two coats."],
      ["released", "Ada", undefined, undefined, undefined, undefined],
    ]);
    // The review and the merge read the branch in the repository Scope Soup works from: it is there now, at the tip.
    assert.equal(repo.git(["rev-parse", "refs/heads/scopesoup/A-1"]), tip);
  });

  test("release: anyone releases a person's hold and the log names both; nobody an agent's, nor a hold that is not there", async () => {
    assert.deepEqual(refusal(await call(base, "/api/item/release", "Bo", { id: "A-3" })), [409, "REFUSED", 'A-3 "Sweep the yard" is not held by anyone.']);
    assert.equal((await call(base, "/api/item/claim", "Ada", { id: "A-3" })).status, 200);
    const released = await call(base, "/api/item/release", "Bo", { id: "A-3", note: "Ada is away." });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    const line = (await host.work.getWork(item("A-3")))!.log!.at(-1)!;
    assert.deepEqual([line.kind, line.by.who, line.fields.of, line.fields.reason], ["released", "Bo", "Ada@laptop-a", "Ada is away."]);
    // An agent's claim: no Release button, and Claim says why.
    await host.write!.appendLog!(item("A-3"), { kind: "claimed", by: { who: "scopesoup", agent: true }, fields: { until: "2026-11-23T12:00:00Z" } });
    assert.match(refusal(await call(base, "/api/item/release", "Bo", { id: "A-3" }))[2], /held by scopesoup on laptop-a, an agent that is working on it/);
  });
});

describe("where items cannot be written", { concurrency: 1 }, () => {
  test("no buttons, and the calls are refused", async () => {
    const store = openStore(":memory:");
    seedDemo(store, new Date("2026-11-23T09:00:00Z"));
    const server = createServer({ store, port: 0 });
    const base = (await server.start()).url;
    try {
      assert.equal(((await call(base, "/api/item?ref=demo:work:48", "mira")).body as unknown as ItemPage).hold, undefined);
      for (const verb of ["claim", "handback", "release"]) assert.deepEqual(refusal(await call(base, `/api/item/${verb}`, "mira", { id: "48" })).slice(0, 2), [403, "READ_ONLY"]);
    } finally {
      await server.stop();
      store.close();
    }
  });
});

describe("the demo's writable Items host", { concurrency: 1 }, () => {
  test("claim, hand back and release on the demo's board, with the demo's remote", async () => {
    const store = openStore(":memory:");
    let now = new Date("2026-11-23T09:00:00Z");
    seedDemo(store, now);
    const server = createServer({ store, port: 0, now: () => now, machine: "demo", items: demoItemsHost(store, () => now), branches: demoBranches(store, () => now) });
    const base = (await server.start()).url;
    const page = async (id: string, person: string) => (await call(base, `/api/item?ref=demo:work:${id}`, person)).body as unknown as ItemPage;
    try {
      // Mira holds 48, and her branch is on the demo's remote: she hands it back with one call, at the demo's tip.
      assert.equal((await page("48", "mira")).hold?.branch?.name, "scopesoup/48");
      assert.equal((await call(base, "/api/item/handback", "mira", { id: "48" })).status, 200);
      const handed = await page("48", "mira");
      assert.equal(handed.item.holder, undefined);
      assert.equal(handed.changes.length, 1);
      const made = store.list<Change>("change").find((each) => each.works.some((one) => one.id === "48"))!;
      assert.equal(made.revisions.at(-1)!.sha, demoTip("48"));
      assert.ok(handed.history.some((line) => line.kind === "revision"));
      // Ines takes the free 81: no branch on the remote yet, so Hand back is refused; a little later she has "pushed" it.
      assert.equal((await call(base, "/api/item/claim", "ines", { id: "81" })).status, 200);
      assert.equal((await page("81", "ines")).item.holder?.actor.name, "ines on demo");
      assert.deepEqual((await call(base, "/api/item/branch?id=81", "ines")).body, { branch: "scopesoup/81", onRemote: false });
      assert.match(refusal(await call(base, "/api/item/handback", "ines", { id: "81" }))[2], /scopesoup\/81 is not on origin/);
      now = new Date(now.getTime() + DEMO_PUSH_MS);
      assert.deepEqual((await call(base, "/api/item/branch?id=81", "ines")).body, { branch: "scopesoup/81", onRemote: true });
      assert.equal((await call(base, "/api/item/release", "jonas", { id: "81" })).status, 200);
      assert.equal((await page("81", "jonas")).item.holder, undefined);
      // The demo files new items too: the board offers New item, and the new one is in the Backlog.
      const board = async () => (await call(base, "/api/board", "ines")).body as unknown as BoardView;
      assert.equal((await board()).canWrite, true);
      const filed = await call(base, "/api/items", "ines", { title: "Tide colours for colour-blind users" });
      assert.equal(filed.status, 200, JSON.stringify(filed.body));
      assert.ok(Number(String(filed.body.ref).split(":").at(-1)) > 81);
      const backlog = (await board()).lanes.find((lane) => lane.lane === "backlog")!;
      assert.ok(backlog.cards.some((card) => card.key === filed.body.ref && card.title === "Tide colours for colour-blind users"));
    } finally {
      await server.stop();
      store.close();
    }
  });
});
