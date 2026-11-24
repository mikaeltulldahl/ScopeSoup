import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createHosts, describeHosts, hostSettings } from "../hostSetup.ts";
import { checkConfigFile } from "./check.ts";
import { levelChoices } from "./levels.ts";
import { fileSettings, validateFiles } from "./shared.ts";
import { validateConfig } from "./validate.ts";

const BASE = resolve("/srv/scopesoup");
const base = { project: "p", machineName: "laptop-a", repoPath: "/srv/clone" };
/** This machine's own file: the project is a shared setting. */
const own = { machineName: "laptop-a", repoPath: "/srv/clone" };
const cloud = { kind: "jira", site: "https://example.atlassian.net/", project: "DEMO", deployment: "cloud", email: "robin@example.test" };
const dc = { kind: "jira", site: "https://jira.example.test/jira", project: "DEMO", deployment: "datacenter" };

function good(raw: unknown) {
  const result = validateConfig(raw, BASE);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.config;
}

function bad(raw: unknown): string {
  const result = validateConfig(raw, BASE);
  if (result.ok) assert.fail("expected the configuration to be rejected");
  return result.errors.join("\n");
}

test("a Jira host, Cloud or Data Center, is read with write false and the site without a trailing slash", () => {
  assert.deepEqual(good({ ...base, host: cloud }).host, { kind: "jira", site: "https://example.atlassian.net", project: "DEMO", deployment: "cloud", write: false, email: "robin@example.test" });
  assert.deepEqual(good({ ...base, host: dc }).host, { kind: "jira", site: "https://jira.example.test/jira", project: "DEMO", deployment: "datacenter", write: false });
  const mapped = good({ ...base, host: { ...dc, write: false, priorities: { P1: "blocker", P2: "minor" }, abandonedResolutions: ["Nope"], blocksLink: "Dependency" } }).host;
  assert.deepEqual(mapped, { kind: "jira", site: "https://jira.example.test/jira", project: "DEMO", deployment: "datacenter", write: false, priorities: { P1: "blocker", P2: "minor" }, abandonedResolutions: ["Nope"], blocksLink: "Dependency" });
});

test("a Jira host is refused with writes on, above level 0, or with a bad site, key, deployment, email or map", () => {
  assert.match(bad({ ...base, host: { ...dc, write: true } }), /read-only in this version/);
  assert.match(bad({ ...base, level: 1, host: dc }), /level is 1, but the Jira host is read-only.*Set level to 0/);
  assert.match(bad({ ...base, host: { ...dc, site: "jira.example.test" } }), /host.site .* must be an http or https address/);
  assert.match(bad({ ...base, host: { ...dc, site: undefined } }), /host.site must be the Jira site's address/);
  assert.match(bad({ ...base, host: { ...dc, project: "demo" } }), /must be a Jira project key/);
  assert.match(bad({ ...base, host: { ...dc, deployment: "server" } }), /host.deployment must be "cloud" .* or "datacenter"/);
  assert.match(bad({ ...base, host: { ...cloud, email: undefined } }), /account's email is required/);
  assert.match(bad({ ...base, host: { ...dc, email: "robin@example.test" } }), /needs no email/);
  assert.match(bad({ ...base, host: { ...dc, priorities: { P1: "urgent" } } }), /host.priorities.P1 must be one of blocker, critical, major, minor/);
  assert.match(bad({ ...base, host: { ...dc, abandonedResolutions: "Nope" } }), /host.abandonedResolutions must be a list/);
  assert.match(bad({ ...base, host: { ...dc, token: "x" } }), /host.token: a token is never kept/);
  assert.match(bad({ ...base, host: { ...dc, repo: "x" } }), /unknown key "repo" for kind "jira"/);
});

test("the Cloud email is this machine's own: jira.email in the private file, never in the shared host", () => {
  const { email, ...shared } = cloud;
  const ok = validateFiles({ ...own, jira: { email } }, { project: "p", host: shared }, BASE);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.config.host?.kind === "jira" && ok.config.host.email, email);
  const inShared = validateFiles(own, { project: "p", host: cloud }, BASE);
  assert.match(inShared.ok ? "" : inShared.errors.join("\n"), /host.email belongs to one person: it goes in that machine's scopesoup.config.json as jira.email/);
  const token = validateFiles({ ...own, jira: { email, token: "x" } }, { project: "p", host: shared }, BASE);
  assert.match(token.ok ? "" : token.errors.join("\n"), /jira.token: a token is never kept/);
  const wrongHost = validateFiles({ ...own, jira: { email } }, { project: "p", host: { kind: "metaBranch" } }, BASE);
  assert.match(wrongHost.ok ? "" : wrongHost.errors.join("\n"), /the host in .* is not "jira"\. Remove jira\./);
});

test("config:check accepts a Jira host and says it is read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-jira-check-"));
  try {
    const file = join(dir, "scopesoup.config.json");
    writeFileSync(file, JSON.stringify({ ...own, repoPath: "./clone" }));
    writeFileSync(join(dir, "project.json"), JSON.stringify({ project: "p", host: dc }));
    const result = checkConfigFile(file, undefined, fileSettings(join(dir, "project.json")));
    assert.equal(result.ok, true, result.lines.join("\n"));
    const text = result.lines.join("\n");
    assert.match(text, /host jira/);
    assert.match(text, /Jira Data Center https:\/\/jira.example.test\/jira, project DEMO: read-only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the level picker offers only level 0 for a Jira host", () => {
  const config = good({ ...base, host: dc });
  const choices = levelChoices(config, () => true);
  assert.equal(choices[0]?.pickable, true);
  assert.equal(choices[1]?.pickable, false);
  assert.match(choices[1]?.blocked ?? "", /the Jira host is read-only/);
});

test("the Jira host is created from the file with SCOPESOUP_JIRA_TOKEN, and refused without it", () => {
  const config = good({ ...base, host: cloud });
  const settings = hostSettings(config, {}, (path) => path);
  assert.equal(settings.jira?.project, "DEMO");
  assert.match(describeHosts(settings), /Jira project DEMO on https:\/\/example.atlassian.net \(read-only\)/);
  assert.throws(() => createHosts(settings, {}), /SCOPESOUP_JIRA_TOKEN is not set/);
  const [host] = createHosts(settings, { SCOPESOUP_JIRA_TOKEN: "jira-token-synthetic" });
  assert.equal(host?.info.id, "jira");
  assert.equal(host?.write, undefined);
  assert.ok(host?.work);
});
