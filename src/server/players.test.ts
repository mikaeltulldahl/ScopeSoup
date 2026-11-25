// Settings' Players switch from singleplayer to multiplayer (decision 95): the remote's shared settings are read first. When they
// name another project or host the switch waits for the person: "Join theirs" backs this clone's meta ref up under
// refs/scopesoup-backup/ and uses the remote's; "Make mine the project's" goes on as before. The same project and host need no
// question. Real repositories: a bare remote with the project's settings, and a clone that played alone.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { T0 } from "../core/testing.ts";
import { type MetaSettings, metaSettings } from "../config/metaSettings.ts";
import { git, isolateGitConfig } from "../orchestrator/fixtures/git-env.ts";
import { openStore, type Store } from "../store/store.ts";
import { createServer, type ScopeSoupServer } from "./server.ts";

const restore = isolateGitConfig();
let dir: string;
let origin: string;
let settings: MetaSettings;
const stores: Store[] = [];
const servers: ScopeSoupServer[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "scopesoup-players-"));
  origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  settings = metaSettings({ now: () => new Date(T0).toISOString() });
  // The project's settings on the remote: written by a machine that plays multiplayer.
  const team = join(dir, "team");
  git(dir, "clone", "-q", origin, team);
  const first = await settings.save({ repoPath: team, remote: "origin", machine: "laptop-b", by: "Bo", multiplayer: true, update: () => ({ project: "harbour", host: { kind: "metaBranch", write: true } }) });
  assert.ok(first.ok);
});

after(async () => {
  for (const server of servers) await server.stop();
  for (const store of stores) store.close();
  await settings.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  restore();
});

/** A clone that played alone, with its own settings, and its server. */
async function solo(name: string, project: string) {
  const repo = join(dir, name);
  git(dir, "clone", "-q", origin, repo);
  const file = join(dir, `${name}.config.json`);
  writeFileSync(file, JSON.stringify({ version: 1, machineName: name, repoPath: name, multiplayer: false, meta: { authorName: "Test Person", authorEmail: "test.person@example.invalid", prefix: "A" } }, null, 2) + "\n");
  const saved = await settings.save({ repoPath: repo, remote: "origin", machine: name, by: "Ada", multiplayer: false, update: () => ({ project, host: { kind: "metaBranch", write: true } }) });
  assert.ok(saved.ok);
  const store = openStore(":memory:");
  stores.push(store);
  const server = createServer({ store, now: () => new Date(T0), port: 0, configFile: file, programFound: () => true, sharedSettings: settings });
  servers.push(server);
  const base = (await server.start()).url;
  const post = async (body: unknown) => {
    const response = await fetch(`${base}/api/config`, { method: "POST", headers: { "Content-Type": "application/json", "X-ScopeSoup-Person": "Ada" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as { errors?: string[]; players?: { mine: { project: string }; theirs: { project: string } } } };
  };
  return { repo, file, post };
}

test("another project on the remote: the switch asks; Join theirs backs mine up and uses theirs", async () => {
  const s = await solo("laptop-a", "tidepool");
  const mine = git(s.repo, "rev-parse", "refs/scopesoup/meta");
  const asked = await s.post({ multiplayer: true });
  assert.equal(asked.status, 409);
  assert.deepEqual([asked.body.players?.mine.project, asked.body.players?.theirs.project], ["tidepool", "harbour"]);
  assert.equal(JSON.parse(readFileSync(s.file, "utf8")).multiplayer, false, "nothing switched yet");
  assert.equal(git(s.repo, "rev-parse", "refs/scopesoup/meta"), mine);

  const joined = await s.post({ multiplayer: true, players: "join" });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(JSON.parse(readFileSync(s.file, "utf8")).multiplayer, true);
  assert.equal(git(s.repo, "rev-parse", "refs/scopesoup/meta"), git(origin, "rev-parse", "refs/scopesoup/meta"));
  const backup = git(s.repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/scopesoup-backup/");
  assert.match(backup, new RegExp(`^refs/scopesoup-backup/meta-\\S+ ${mine}$`));
});

test("Make mine the project's switches without replacing anything; the same project needs no question", async () => {
  const s = await solo("laptop-c", "tidepool");
  const mine = git(s.repo, "rev-parse", "refs/scopesoup/meta");
  const done = await s.post({ multiplayer: true, players: "mine" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(git(s.repo, "rev-parse", "refs/scopesoup/meta"), mine);
  assert.equal(git(s.repo, "for-each-ref", "refs/scopesoup-backup/"), "");

  const same = await solo("laptop-d", "harbour");
  assert.equal((await same.post({ multiplayer: true })).status, 200);
});
