import assert from "node:assert/strict";
import test from "node:test";
import { identityEnv, sessionIdentity } from "./identity.ts";

test("the identity names role, item and model, with a no-reply address", () => {
  const id = sessionIdentity("implement", "12", "sonnet", "Box");
  assert.deepEqual(id, { name: "Scope Soup implement 12 (sonnet)", email: "scopesoup@box.invalid" });
});

test("a missing item id, role, model or machine still gives a stable label", () => {
  const id = sessionIdentity("", "", "", "");
  assert.equal(id.name, "Scope Soup session unknown (unknown)");
  assert.equal(id.email, "scopesoup@machine.invalid");
});

test("the environment sets author and committer to the session", () => {
  const env = identityEnv(sessionIdentity("implement", "12", "sonnet", "box"));
  assert.equal(env.GIT_AUTHOR_NAME, env.GIT_COMMITTER_NAME);
  assert.equal(env.GIT_AUTHOR_EMAIL, "scopesoup@box.invalid");
});
