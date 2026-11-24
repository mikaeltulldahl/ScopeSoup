// The command line, end to end: a real temporary repository holds the project and its meta ref,
// the commands run once with the server down (straight on the meta ref) and once through a real
// Scope Soup server on a free port. All names and texts are synthetic.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { Jobs } from "../orchestrator/jobs.ts";
import { saveJobs } from "../orchestrator/jobs.ts";
import { realGit } from "../orchestrator/process.ts";
import { createServer } from "../server/server.ts";
import type { ScopeSoupServer } from "../server/server.ts";
import { openStore } from "../store/store.ts";
import type { CliDeps } from "./cli.ts";
import { runItemCli } from "./cli.ts";
import { remoteBranches } from "./remoteBranch.ts";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSyncRetrying("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();

/** A project with a main branch and an item branch with one commit (not pushed), and a bare origin to push to. */
let sharedProject: { dir: string; origin: string } | undefined;
/** One project for the tests that only read, so they do not each make a repository. */
function shared(): { dir: string; origin: string } {
  sharedProject ??= project();
  return sharedProject;
}

function project(): { dir: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), "scopesoup-items-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "project");
  const origin = join(root, "origin.git");
  execFileSyncRetrying("git", ["init", "--quiet", "--bare", "-b", "main", origin], { windowsHide: true });
  execFileSyncRetrying("git", ["init", "--quiet", "-b", "main", dir], { windowsHide: true });
  writeFileSync(join(dir, "README.md"), "The project.\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "start");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "--quiet", "origin", "main");
  // The project's shared settings, on its meta ref (refs/scopesoup/meta), as onboarding writes them.
  const put = (args: string[], input: string): string => execFileSyncRetrying("git", args, { cwd: dir, input, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8").trim();
  const settings = put(["hash-object", "-w", "--stdin"], JSON.stringify({ project: "tides" }) + "\n");
  const format = put(["hash-object", "-w", "--stdin"], "1\n");
  const folder = put(["mktree"], `100644 blob ${settings}\tsettings.json\n`);
  const tree = put(["mktree"], `100644 blob ${format}\tformat\n040000 tree ${folder}\tsettings\n`);
  git(dir, "update-ref", "refs/scopesoup/meta", put(["-c", "user.name=Ada", "-c", "user.email=ada@example.invalid", "commit-tree", tree, "-m", "Settings"], ""));
  git(dir, "checkout", "--quiet", "-b", "scopesoup/A-1");
  writeFileSync(join(dir, "tide.txt"), "Cache.\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "cache the tide table");
  git(dir, "checkout", "--quiet", "main");
  return { dir, origin };
}

/** The machine's name is only the configuration file's `machineName`; the file has no `host`, so the environment names it. */
function metaEnv(dir: string): Record<string, string> {
  const file = join(dir, "..", "scopesoup.config.json");
  writeFileSync(file, JSON.stringify({ repoPath: dir, machineName: "laptop-a" }));
  return {
    SCOPESOUP_CONFIG: file, SCOPESOUP_META_REPO: dir, SCOPESOUP_META_WRITE: "1", SCOPESOUP_META_AUTHOR_NAME: "Ada", SCOPESOUP_META_AUTHOR_EMAIL: "ada@example.invalid",
    SCOPESOUP_META_PREFIX: "A", SCOPESOUP_META_REMOTE: "none",
  };
}

function cli(dir: string, env: Record<string, string>, over: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = { env, cwd: dir, home: null, out: (line) => out.push(line), err: (line) => err.push(line), fetch: async () => Promise.reject(new Error("no server")), ...over };
  return { out, err, run: (...argv: string[]) => runItemCli(argv, deps) };
}

function reader(dir: string): MetaBranchHost {
  const host = createMetaBranchHost({ repoDir: dir, allowWrites: true, remote: null, person: { name: "Ada", email: "ada@example.invalid" }, machine: "laptop-a", idPrefix: "A" });
  cleanups.push(() => host.stop());
  return host;
}
const item = async (host: MetaBranchHost, id: string) => (await host.work.getWork({ host: "metaBranch", kind: "work", id }))!;

describe("cli", { concurrency: 4 }, () => {
test("without the server: file, claim, and hand back reads the pushed branch's tip from the remote", async () => {
  const { dir, origin } = project();
  const c = cli(dir, { ...metaEnv(dir), CLAUDECODE: "1" });
  assert.equal(await c.run("new", "--title", "Cache the tide table", "--priority", "major"), 0, c.err.join("\n"));
  assert.match(c.out.at(-1)!, /Filed A-1/);
  assert.equal(await c.run("claim", "A-1"), 0, c.err.join("\n"));
  assert.match(c.out.at(-1)!, /Ada holds A-1/);

  const host = reader(dir);
  const taken = await item(host, "A-1");
  assert.equal(taken.holder?.actor.name, "Ada on laptop-a");
  assert.equal(taken.log!.find((line) => line.kind === "claimed")!.fields.from, "claude-code");

  assert.equal(await c.run("list", "--mine"), 0);
  assert.match(c.out.at(-1)!, /A-1 .*held by Ada on laptop-a \(you\)/);

  // The person pushes the item's branch; hand back names no branch or commit.
  git(dir, "push", "--quiet", "origin", "scopesoup/A-1");
  const sha = git(origin, "rev-parse", "refs/heads/scopesoup/A-1");
  assert.equal(await c.run("handback", "A-1", "--note", "done, with a test"), 0, c.err.join("\n"));
  assert.match(c.out.at(-1)!, new RegExp(`Handed back A-1 .* on scopesoup/A-1 \\(${sha.slice(0, 9)}\\)`));
  const handed = await item(host, "A-1");
  assert.equal(handed.holder, undefined);
  const revision = handed.log!.find((line) => line.kind === "revision")!;
  assert.equal(revision.fields.sha, sha);
  assert.equal(revision.fields.branch, "scopesoup/A-1");
  assert.equal(revision.fields.handback, true);
});

test("hand back refuses a branch that is not on the remote or has no commits beyond main, with the reason; nothing is written", async () => {
  const { dir } = project();
  const c = cli(dir, metaEnv(dir));
  await c.run("new", "--title", "One");
  await c.run("new", "--title", "Two");
  await c.run("claim", "A-1");
  await c.run("claim", "A-2");
  c.err.length = 0;
  // scopesoup/A-1 is committed here but not pushed.
  assert.equal(await c.run("handback", "A-1"), 1);
  assert.equal(c.err.at(-1), 'Not done: scopesoup/A-1 is not on origin. Push it with "git push origin scopesoup/A-1", then hand back.');
  // scopesoup/A-2 is pushed, but it is main.
  git(dir, "push", "--quiet", "origin", "main:refs/heads/scopesoup/A-2");
  assert.equal(await c.run("handback", "A-2"), 1);
  assert.match(c.err.at(-1)!, /^Not done: scopesoup\/A-2 on origin has no commits beyond main: there is nothing to hand back\./);
  // The old branch arguments are gone.
  assert.equal(await c.run("handback", "A-1", "--branch", "scopesoup/A-1"), 2);
  // Still held: nothing was written.
  const host = reader(dir);
  assert.equal((await item(host, "A-1")).holder?.actor.name, "Ada on laptop-a");
  assert.equal((await item(host, "A-2")).holder?.actor.name, "Ada on laptop-a");
  assert.equal((await item(host, "A-1")).log!.some((line) => line.kind === "revision"), false);
});

test("a branch pushed from another clone is fetched into the repository; one that differs from it here is refused", async () => {
  const { dir, origin } = project();
  const c = cli(dir, metaEnv(dir));
  await c.run("new", "--title", "One");
  await c.run("new", "--title", "Two");
  await c.run("claim", "A-1");
  await c.run("claim", "A-2");
  c.err.length = 0;
  // Another clone does the work on scopesoup/A-2 and pushes it; this repository has no scopesoup/A-2.
  const other = join(dir, "..", "other");
  execFileSyncRetrying("git", ["clone", "--quiet", origin, other], { windowsHide: true });
  git(other, "switch", "--quiet", "-c", "scopesoup/A-2", "origin/main");
  writeFileSync(join(other, "wind.txt"), "Arrows.\n");
  git(other, "add", ".");
  git(other, "commit", "--quiet", "-m", "wind arrows");
  git(other, "push", "--quiet", "origin", "scopesoup/A-2");
  const tip = git(other, "rev-parse", "HEAD");
  assert.equal(await c.run("handback", "A-2"), 0, c.err.join("\n"));
  assert.equal(git(dir, "rev-parse", "refs/heads/scopesoup/A-2"), tip);
  const host = reader(dir);
  assert.equal((await item(host, "A-2")).log!.find((line) => line.kind === "revision")!.fields.sha, tip);
  // scopesoup/A-1 on origin is another commit than the one here: the commit here is not thrown away.
  git(other, "switch", "--quiet", "-c", "scopesoup/A-1", "origin/main");
  writeFileSync(join(other, "tide.txt"), "Another cache.\n");
  git(other, "add", ".");
  git(other, "commit", "--quiet", "-m", "another cache");
  git(other, "push", "--quiet", "origin", "scopesoup/A-1");
  const mine = git(dir, "rev-parse", "refs/heads/scopesoup/A-1");
  assert.equal(await c.run("handback", "A-1"), 1);
  assert.match(c.err.at(-1)!, /scopesoup\/A-1 could not be read: scopesoup\/A-1 in .* has commits that are not on origin/);
  assert.equal(git(dir, "rev-parse", "refs/heads/scopesoup/A-1"), mine);
  assert.equal((await item(host, "A-1")).holder?.actor.name, "Ada on laptop-a");
});

test("usage errors exit 2; a read-only meta ref and a missing host are said plainly", async () => {
  const { dir } = shared();
  const c = cli(dir, metaEnv(dir));
  assert.equal(await c.run(), 2);
  assert.equal(await c.run("frobnicate"), 2);
  assert.equal(await c.run("claim"), 2);
  assert.equal(await c.run("claim", "A-1", "--no-such-flag"), 2);
  const readOnly = cli(dir, { ...metaEnv(dir), SCOPESOUP_META_WRITE: "0" });
  assert.equal(await readOnly.run("new", "--title", "x"), 1);
  assert.match(readOnly.err.at(-1)!, /read-only/);
  const none = cli(dir, {});
  assert.equal(await none.run("list"), 1);
  assert.match(none.err.at(-1)!, /Which project\?.*Give --config/);
});

test("the person is --as, SCOPESOUP_PERSON, the meta author or git; never a guess", async () => {
  const { dir } = shared();
  const env = metaEnv(dir);
  delete (env as Record<string, string | undefined>).SCOPESOUP_META_AUTHOR_NAME;
  // Authors are required to write, so a read-only list can show the fallbacks.
  const base = { SCOPESOUP_META_REPO: dir, SCOPESOUP_META_REMOTE: "none" };
  git(dir, "config", "user.name", "Git Name");
  const viaGit = cli(dir, base);
  assert.equal(await viaGit.run("list", "--json"), 0, viaGit.err.join("\n"));
  const viaEnv = cli(dir, { ...base, SCOPESOUP_PERSON: "Env Name" });
  assert.equal(await viaEnv.run("list", "--as", "Flag Name"), 0);
  git(dir, "config", "--unset", "user.name");
  const nobody = cli(dir, base, { git: async () => ({ code: 1, stdout: "", stderr: "" }) });
  assert.equal(await nobody.run("list", "--mine"), 1);
  assert.match(nobody.err.at(-1)!, /Who are you\?/);
  // Reading needs no person: a triage in a clone with no git user can search and show.
  assert.equal(await nobody.run("list"), 0, nobody.err.join("\n"));
});

test("through the server: the same commands, and it refuses an item an agent session is running on", async () => {
  const { dir } = project();
  const host = createMetaBranchHost({ repoDir: dir, allowWrites: true, remote: null, person: { name: "Ada", email: "ada@example.invalid" }, machine: "laptop-a", idPrefix: "A" });
  cleanups.push(() => host.stop());
  const store = openStore(":memory:");
  cleanups.push(() => store.close());
  let synced = 0;
  const branches = remoteBranches(realGit, () => ({ repo: dir, remote: "origin", mainBranch: "main" }));
  const server: ScopeSoupServer = createServer({ store, port: 0, items: { host: "metaBranch", write: host.write!, work: host.work }, branches, machine: "laptop-a", syncNow: async () => void synced++, project: () => ({ name: "tides", repository: "origin", github: null, folders: {} }) });
  const where = await server.start();
  cleanups.push(() => server.stop());

  const env = { ...metaEnv(dir), SCOPESOUP_URL: where.url };
  // The real fetch; with the server up the commands must not touch the meta ref themselves.
  const c = cli(dir, env, { fetch });
  assert.equal(await c.run("new", "--title", "Cache the tide table"), 0, c.err.join("\n"));
  assert.match(c.out.at(-1)!, /Filed A-1/);
  assert.equal(await c.run("new", "--title", "Second"), 0, c.err.join("\n"));
  const filed = await item(host, "A-1");
  assert.equal(filed.log![0]!.by.who, "Ada");
  // new --claim through the server: held from the first state, with the session noted.
  assert.equal(await c.run("new", "--title", "Third, taken at once", "--claim", "--as", "Cy"), 0, c.err.join("\n"));
  assert.match(c.out.at(-1)!, /Filed A-3: .*Cy holds it/);
  const third = await item(host, "A-3");
  assert.deepEqual(third.log!.map((line) => line.kind), ["created", "claimed"]);
  assert.equal(third.holder?.actor.name, "Cy on laptop-a");

  // A session is running on A-2 in this store: taking it is refused with the reason.
  const jobs: Jobs = { "metaBranch:work:A-2": { item: { host: "metaBranch", kind: "work", id: "A-2" }, workspace: "w", branch: "scopesoup/A-2", step: "implement", failures: 0, fixRounds: 0, sessionId: "s1", startedAt: "2026-11-18T09:00:00Z" } };
  saveJobs(store, jobs);
  assert.equal(await c.run("claim", "A-2"), 1);
  assert.match(c.err.at(-1)!, /implement session running now/);
  assert.equal((await item(host, "A-2")).holder, undefined);

  assert.equal(await c.run("claim", "A-1"), 0, c.err.join("\n"));
  assert.equal((await item(host, "A-1")).holder?.actor.name, "Ada on laptop-a");
  assert.ok(synced > 0);
  assert.equal(await c.run("list", "--mine"), 0, c.err.join("\n"));
  assert.match(c.out.at(-1)!, /A-1 .*held by Ada on laptop-a \(you\)/);
  assert.equal(await c.run("list", "--free"), 0);
  assert.match(c.out.at(-1)!, /A-2/);

  // Refused through the server too until the branch is pushed; then its tip is handed back.
  assert.equal(await c.run("handback", "A-1"), 1);
  assert.match(c.err.at(-1)!, /scopesoup\/A-1 is not on origin\. Push it with/);
  git(dir, "push", "--quiet", "origin", "scopesoup/A-1");
  assert.equal(await c.run("handback", "A-1"), 0, c.err.join("\n"));
  const handed = await item(host, "A-1");
  assert.equal(handed.holder, undefined);
  assert.equal(handed.log!.find((line) => line.kind === "revision")!.fields.sha, git(dir, "rev-parse", "refs/heads/scopesoup/A-1"));

  // Another person's hold: taking it is refused with the reason, and anyone may release it; the log names both.
  assert.equal(await c.run("claim", "A-1", "--as", "Bo"), 0);
  assert.equal(await c.run("claim", "A-1", "--as", "Ada"), 1);
  assert.match(c.err.at(-1)!, /held by Bo on laptop-a\. Ask them, or release it first/);
  assert.equal(await c.run("release", "A-1", "--as", "Ada"), 0, c.err.join("\n"));
  assert.match(c.out.at(-1)!, /Ada released Bo on laptop-a's hold on A-1/);
  assert.equal((await item(host, "A-1")).log!.at(-1)!.fields.of, "Bo@laptop-a");

  // Search and show through the server.
  assert.equal(await c.run("list", "--search", "TIDE cache"), 0, c.err.join("\n"));
  assert.deepEqual(c.out.slice(-1).map((line) => line.split(" ")[0]), ["A-1"]);
  assert.equal(await c.run("show", "A-3"), 0, c.err.join("\n"));
  assert.match(c.out.at(-1)!, /^A-3 Third, taken at once\nState: todo/);
  assert.equal(await c.run("show", "A-99"), 1);
  assert.match(c.err.at(-1)!, /no item A-99/);
});

test("a server for another project is not used: the command falls back to the meta ref and says why", async () => {
  const { dir } = project();
  const asked: string[] = [];
  const health = (project: unknown) => async (url: string | URL | Request): Promise<Response> => {
    asked.push(String(url));
    return new Response(JSON.stringify({ ok: true, seq: 1, now: "2026-01-01T00:00:00.000Z", ...(project === undefined ? {} : { project }) }));
  };
  for (const other of [{ name: "harbour", repository: "origin" }, { name: "tides", repository: "someone/else" }, null, undefined]) {
    const c = cli(dir, { ...metaEnv(dir), SCOPESOUP_URL: "http://127.0.0.1:1" }, { fetch: health(other) as typeof fetch });
    assert.equal(await c.run("list"), 0, c.err.join("\n"));
    assert.deepEqual(asked.splice(0), ["http://127.0.0.1:1/api/health"]);
    assert.equal(c.err.length, 1, c.err.join("\n"));
    assert.match(c.err[0]!, /server at http:\/\/127\.0\.0\.1:1 serves .*, not tides \(origin\): not used; going to the meta ref/);
  }
  // The same project: the server is used, nothing is said.
  const same = cli(dir, { ...metaEnv(dir), SCOPESOUP_URL: "http://127.0.0.1:1" }, {
    fetch: (async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/health")) return new Response(JSON.stringify({ ok: true, project: { name: "tides", repository: "origin" } }));
      return new Response(JSON.stringify({ rows: [] }));
    }) as typeof fetch,
  });
  await same.run("list");
  assert.deepEqual(same.err, []);
});

test("without the server: list --search finds by title and text, show prints the item in full", async () => {
  const { dir } = project();
  const c = cli(dir, metaEnv(dir));
  const notes = join(dir, "..", "notes.md");
  writeFileSync(notes, "Read the harbour table once a day.\n");
  assert.equal(await c.run("new", "--title", "Cache the tide table", "--body-file", notes, "--label", "offline"), 0, c.err.join("\n"));
  assert.equal(await c.run("new", "--title", "Wind arrows"), 0, c.err.join("\n"));
  const before = c.out.length;
  assert.equal(await c.run("list", "--search", "harbour"), 0, c.err.join("\n"));
  assert.deepEqual(c.out.slice(before).map((line) => line.split(" ")[0]), ["A-1"]);
  assert.equal(await c.run("list", "--search", "nothing-like-this"), 0);
  assert.equal(c.out.at(-1), "No items.");
  assert.equal(await c.run("show", "A-1"), 0, c.err.join("\n"));
  assert.equal(c.out.at(-1), "A-1 Cache the tide table\nState: todo\nLabels: offline\n\nRead the harbour table once a day.");
  assert.equal(await c.run("show", "A-1", "--json"), 0);
  assert.equal(JSON.parse(c.out.at(-1)!).body.trim(), "Read the harbour table once a day.");
  assert.equal(await c.run("show"), 2);
});

test("import github: misuse, a dry run that writes nothing, then the import, and a second run that adds nothing", async () => {
  const { dir } = project();
  const fake = fakeIssues("harbour/tides", [1, 2]);
  fake.issues.get("2")!.body = "After #1.";
  const env = { ...metaEnv(dir), SCOPESOUP_GITHUB_TOKEN: "synthetic-token" };
  const c = cli(dir, env, { githubFetch: fake.fetch, githubApi: ISSUES_API });
  assert.equal(await c.run("import"), 2);
  assert.match(c.err.at(-1)!, /only "github" is supported/);
  assert.equal(await c.run("import", "github"), 2);
  assert.match(c.err.at(-1)!, /needs --repo OWNER\/NAME/);
  assert.equal(await c.run("import", "github", "--repo", "harbour/tides", "--closed", "some"), 2);
  assert.match(c.err.at(-1)!, /--closed takes a number/);
  const without = cli(dir, metaEnv(dir), { githubFetch: fake.fetch, githubApi: ISSUES_API });
  assert.equal(await without.run("import", "github", "--repo", "harbour/tides"), 1);
  assert.match(without.err.at(-1)!, /SCOPESOUP_GITHUB_TOKEN/);

  const meta = () => { try { return git(dir, "rev-parse", "--verify", "--quiet", "refs/scopesoup/meta"); } catch { return ""; } };
  // The meta ref holds the project's shared settings already; "nothing written" is that commit still.
  const settings = meta();
  assert.equal(await c.run("import", "github", "--repo", "harbour/tides", "--dry-run"), 0, c.err.join("\n"));
  assert.equal(c.out.at(-1), "Dry run: 2 of 2 issue(s) from harbour/tides would be imported. Nothing was written.");
  assert.match(c.out.at(-3)!, /^#1 +would be +A-1 +todo +Tide table 1$/);
  assert.equal(meta(), settings);

  assert.equal(await c.run("import", "github", "--repo", "harbour/tides"), 0, c.err.join("\n"));
  assert.match(c.out.at(-1)!, /^Imported 2 issue\(s\) from harbour\/tides in one meta commit \([0-9a-f]{9}\)\. GitHub was not changed\.$/);
  const tip = meta();
  assert.ok(git(dir, "show", "refs/scopesoup/meta:items/A-2/item.md").includes("importedFrom: github:harbour/tides#2\n---\n\nAfter A-1."));
  assert.equal(await c.run("import", "github", "--repo", "harbour/tides"), 0, c.err.join("\n"));
  assert.equal(c.out.at(-1), "Nothing new to import from harbour/tides: all 2 issue(s) were imported before.");
  assert.equal(meta(), tip);
  assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET ")), []);
  // The token is never printed.
  assert.ok(![...c.out, ...c.err].some((line) => line.includes("synthetic-token")));
});

test("import github --on-github: refused without a yes, asked in a terminal, done with --yes, and nothing twice", async () => {
  const { dir } = project();
  const fake = fakeIssues("harbour/tides", [1, 2, 3]);
  fake.reply(1, "bea", "MEMBER", "A comment.");
  Object.assign(fake.issues.get("3")!, { pull_request: { url: `${ISSUES_API}/repos/harbour/tides/pulls/3` } });
  const env = { ...metaEnv(dir), SCOPESOUP_GITHUB_TOKEN: "synthetic-token" };
  const meta = () => { try { return git(dir, "rev-parse", "--verify", "--quiet", "refs/scopesoup/meta"); } catch { return ""; } };
  // The meta ref holds the project's shared settings already; "nothing written" is that commit still.
  const settings = meta();
  const writes = () => fake.calls.filter((call) => !call.startsWith("GET "));
  const R = "/repos/harbour/tides/issues";

  // Misuse, and no terminal and no --yes: refused before anything is read or written.
  const c = cli(dir, env, { githubFetch: fake.fetch, githubApi: ISSUES_API });
  assert.equal(await c.run("import", "github", "--repo", "harbour/tides", "--on-github", "delete"), 2);
  assert.match(c.err.at(-1)!, /--on-github takes leave, label or close/);
  assert.equal(await c.run("import", "github", "--repo", "harbour/tides", "--comments", "few"), 2);
  assert.match(c.err.at(-1)!, /--comments takes a number/);
  assert.equal(await c.run("import", "github", "--repo", "harbour/tides", "--yes"), 2);
  assert.equal(await c.run("import", "github", "--repo", "harbour/tides", "--on-github", "close"), 2);
  assert.match(c.err.at(-1)!, /needs a yes: run it in a terminal to be asked, or add --yes\. Nothing was done\./);
  assert.equal(fake.calls.length, 0);
  assert.equal(meta(), settings);

  // A dry run says what would be done on GitHub and writes nowhere.
  assert.equal(await c.run("import", "github", "--repo", "harbour/tides", "--on-github", "close", "--dry-run"), 0, c.err.join("\n"));
  assert.match(c.out.at(-1)!, /would be labelled moved-to-scopesoup, given a comment naming its Item and closed as not planned: #1 \(A-1\), #2 \(A-2\)\. Nothing was written to GitHub\./);
  assert.deepEqual(writes(), []);
  assert.equal(meta(), settings);

  // In a terminal, the answer is not yes: imported, and GitHub left as it is.
  const questions: string[] = [];
  const no = cli(dir, env, { githubFetch: fake.fetch, githubApi: ISSUES_API, ask: async (question) => { questions.push(question); return "n"; } });
  assert.equal(await no.run("import", "github", "--repo", "harbour/tides", "--on-github", "label"), 0, no.err.join("\n"));
  assert.match(questions[0]!, /^Change 2 open issue\(s\) on GitHub harbour\/tides: label them moved-to-scopesoup and comment the Item on each\? Pull requests are not touched\. Type yes to go on: $/);
  assert.equal(no.out.at(-1), "GitHub was left as it is.");
  assert.deepEqual(writes(), []);
  assert.match(git(dir, "show", "refs/scopesoup/meta:items/A-1/item.md"), /## Comments imported from GitHub[\s\S]*> A comment\./);

  // The answer yes: labelled, with a comment naming the Item on the meta branch.
  const yes = cli(dir, env, { githubFetch: fake.fetch, githubApi: ISSUES_API, ask: async () => "yes" });
  assert.equal(await yes.run("import", "github", "--repo", "harbour/tides", "--on-github", "label"), 0, yes.err.join("\n"));
  assert.match(yes.out.at(-1)!, /^On GitHub: 2 open issue\(s\) in harbour\/tides are labelled moved-to-scopesoup/);
  assert.ok(fake.comments.get("2")!.some((comment) => /Item \*\*A-2\*\* on the meta ref `refs\/scopesoup\/meta` of this project/.test(comment.body ?? "")));
  assert.equal(fake.issues.get("1")!.state, "open");

  // --yes and close, without a terminal: closes, and does not comment again; the pull request is never touched.
  fake.clear();
  assert.equal(await c.run("import", "github", "--repo", "harbour/tides", "--on-github", "close", "--yes"), 0, c.err.join("\n"));
  assert.deepEqual(writes(), [`PATCH ${R}/1`, `PATCH ${R}/2`]);
  assert.deepEqual([fake.issues.get("1")!.state, fake.issues.get("1")!.state_reason], ["closed", "not_planned"]);
  assert.equal(fake.issues.get("3")!.state, "open");
  assert.ok(!fake.calls.some((call) => call.includes(`${R}/3`)));
  // Once more: the issues are closed, so nothing is written.
  fake.clear();
  assert.equal(await c.run("import", "github", "--repo", "harbour/tides", "--on-github", "close", "--yes"), 0, c.err.join("\n"));
  assert.deepEqual(writes(), []);
  assert.ok(![...c.out, ...c.err, ...no.out, ...yes.out].some((line) => line.includes("synthetic-token")));
});
});
