// What the GitHub host says about branch protection, from fake responses only: a plain yes or no, and "cannot tell" for everything else.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubHost } from "./adapter.ts";
import { FAKE_API, fakeGitHub } from "./fakeFetch.ts";

const R = "/repos/harbour/tides";

function host(routes: Record<string, { status?: number; body?: unknown }>, token = "t") {
  const fake = fakeGitHub(routes);
  return { fake, host: createGitHubHost({ token, repo: "harbour/tides", apiUrl: FAKE_API, fetchImpl: fake.fetch }) };
}

test("the branch's `protected` flag is the answer, read with read rights only", async () => {
  const { fake, host: h } = host({
    [`${R}/branches/main`]: { body: { name: "main", protected: true } },
    [`${R}/branches/open`]: { body: { name: "open", protected: false } },
    [`${R}/branches/release/1.0`]: { body: { name: "release/1.0", protected: false } },
  });
  assert.equal(await h.repository.branchProtected("main"), true);
  assert.equal(await h.repository.branchProtected("open"), false);
  assert.equal(await h.repository.branchProtected("release/1.0"), false);
  assert.deepEqual(fake.take().map((call) => call.split(" ")[0]), ["200", "200", "200"]);
});

test("403, 404, a missing flag and a server error are 'cannot tell', never a guess", async () => {
  const { host: h } = host({
    [`${R}/branches/forbidden`]: { status: 403, body: { message: "Resource not accessible by personal access token" } },
    [`${R}/branches/flagless`]: { body: { name: "flagless" } },
    [`${R}/branches/down`]: { status: 502, body: { message: "Bad Gateway" } },
  });
  assert.equal(await h.repository.branchProtected("forbidden"), null);
  assert.equal(await h.repository.branchProtected("missing"), null);
  assert.equal(await h.repository.branchProtected("flagless"), null);
  assert.equal(await h.repository.branchProtected("down"), null);
});

test("an unreachable GitHub is 'cannot tell'", async () => {
  const h = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: FAKE_API, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(await h.repository.branchProtected("main"), null);
});
