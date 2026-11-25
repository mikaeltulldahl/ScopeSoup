import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeJira, FAKE_SITE } from "./hosts/jira/fakeJira.ts";
import { CLOUD_EMAIL, CLOUD_ROBIN, cloudIssues, TOKEN } from "./hosts/jira/fixtures.ts";
import { jiraHostPart } from "./hostPart.ts";

const answers = { site: `${FAKE_SITE}/`, project: "demo", deployment: "cloud", email: CLOUD_EMAIL, components: ["Board"] };
const jira = () => fakeJira({ deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, user: CLOUD_ROBIN, issues: cloudIssues() });

test("config:host: the same host as Connect writes, the email in the private part, no token anywhere", async () => {
  const result = await jiraHostPart(answers, { env: {} }, false);
  assert.equal(result.code, 0);
  const json = JSON.parse(result.lines[1] ?? "");
  assert.deepEqual(json, { host: { kind: "jira", site: FAKE_SITE, project: "DEMO", deployment: "cloud", write: true, components: ["Board"] }, private: { jira: { email: CLOUD_EMAIL } } });
  assert.doesNotMatch(result.lines.join("\n"), new RegExp(TOKEN));
});

test("config:host: refuses http, a bad key and says a missing Cloud email is needed", async () => {
  const http = await jiraHostPart({ ...answers, site: "http://example.atlassian.net" }, { env: {} }, false);
  assert.equal(http.code, 1);
  assert.match(http.lines.join("\n"), /must be an https address/);
  const key = await jiraHostPart({ ...answers, project: "demo-1" }, { env: {} }, false);
  assert.match(key.lines.join("\n"), /must be a Jira project key/);
  const noEmail = await jiraHostPart({ site: FAKE_SITE, project: "DEMO" }, { env: {} }, false);
  assert.equal(noEmail.code, 0);
  assert.match(noEmail.lines.join("\n"), /needs the email/);
});

test("config:host --look: counts the open issues with the token from the environment; without it names the variable", async () => {
  const fake = jira();
  const seen = await jiraHostPart({ ...answers, readOnly: true }, { env: { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: fake.fetch }, true);
  assert.equal(seen.code, 0);
  assert.match(seen.lines.join("\n"), new RegExp(`signs in to ${FAKE_SITE} as ${CLOUD_ROBIN.displayName}`));
  assert.match(seen.lines.join("\n"), /"write": false/);
  const none = jira();
  const missing = await jiraHostPart(answers, { env: {}, fetchImpl: none.fetch }, true);
  assert.equal(missing.code, 3);
  assert.match(missing.lines.join("\n"), /SCOPESOUP_JIRA_TOKEN is not set/);
  assert.equal(none.calls.length, 0);
});
