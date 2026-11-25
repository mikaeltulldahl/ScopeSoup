// The board's warning about an unprotected main branch, from fake answers only: it shows for a plain "no", and for nothing else.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { RepositoryPort } from "../ports/host.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { KEYS } from "../store/keys.ts";
import { createBranchProtection } from "./branchProtection.ts";
import type { BranchProtection } from "./branchProtection.ts";
import { createServer } from "./server.ts";
import type { ScopeSoupServer } from "./server.ts";

function setup(answer: () => boolean | null | Error, start = 0) {
  let time = start;
  let saved = "";
  const asked: string[] = [];
  const port: RepositoryPort = {
    async branchProtected(branch) {
      asked.push(branch);
      const result = answer();
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const protection = createBranchProtection({ port, repo: "harbour/tides", branch: () => "main", loadDismissed: () => saved, saveDismissed: (value) => (saved = value), now: () => time });
  return { protection, asked, tick: (ms: number) => (time += ms), saved: () => saved };
}

test("no protection on the remote gives the warning, naming the repository and the branch", async () => {
  const { protection } = setup(() => false);
  const warning = await protection.read();
  assert.equal(warning?.repo, "harbour/tides");
  assert.equal(warning?.branch, "main");
  assert.match(warning?.text ?? "", /The main branch of harbour\/tides has no protection on GitHub/);
});

test("protected, or not known (no token, 403 or 404, no network, a throw): no warning", async () => {
  assert.equal(await setup(() => true).protection.read(), null);
  assert.equal(await setup(() => null).protection.read(), null);
  assert.equal(await setup(() => new Error("offline")).protection.read(), null);
});

test("it asks GitHub once an hour, and again when it has changed", async () => {
  let answer = false;
  const { protection, asked, tick } = setup(() => answer);
  assert.ok(await protection.read());
  assert.ok(await protection.read());
  assert.equal(asked.length, 1);
  answer = true;
  tick(59 * 60_000);
  assert.ok(await protection.read(), "still the earlier answer");
  tick(2 * 60_000);
  assert.equal(await protection.read(), null);
  assert.equal(asked.length, 2);
});

test("a dismissed warning stays gone for that repository and branch, whoever looks", async () => {
  const { protection, saved } = setup(() => false);
  assert.ok(await protection.read());
  protection.dismiss();
  assert.equal(saved(), "harbour/tides#main");
  assert.equal(await protection.read(), null);
});

let store: Store;
let server: ScopeSoupServer;
let base: string;
let current: BranchProtection | undefined;
before(async () => {
  store = openStore(":memory:");
  current = createBranchProtection({
    port: { branchProtected: async () => false }, repo: "harbour/tides", branch: () => "main", now: () => 0,
    loadDismissed: () => store.getValue(KEYS.branchProtectionDismissed), saveDismissed: (value) => store.setValue(KEYS.branchProtectionDismissed, value),
  });
  server = createServer({ store, port: 0, now: () => new Date(0), branchProtection: current });
  base = (await server.start()).url;
});
after(async () => {
  await server.stop();
  store.close();
});

test("GET /api/branch-protection gives the warning once, and Dismiss takes it off for good", async () => {
  const shown = (await (await fetch(`${base}/api/branch-protection`)).json()) as { warning: { branch: string } | null };
  assert.equal(shown.warning?.branch, "main");
  const done = await fetch(`${base}/api/branch-protection/dismiss`, { method: "POST" });
  assert.equal(done.status, 200);
  const after = (await (await fetch(`${base}/api/branch-protection`)).json()) as { warning: unknown };
  assert.equal(after.warning, null);
});

test("a server with no GitHub host has no warning", async () => {
  const plain = createServer({ store, port: 0, now: () => new Date(0) });
  const url = (await plain.start()).url;
  try {
    assert.deepEqual(await (await fetch(`${url}/api/branch-protection`)).json(), { warning: null });
  } finally {
    await plain.stop();
  }
});
