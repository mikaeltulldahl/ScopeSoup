// Settings' connect dialogs (#127, decision 98): `POST /api/connect` says what connecting would do, or why it cannot, and writes
// only when confirmed; from the meta branch it moves the ticked Items; in join mode it sets up this machine only. The token comes
// from the given environment, the hosts are the fakes, the shared settings are in memory and the meta branch's writes are recorded.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ref, session, T0, work } from "../core/testing.ts";
import { memorySettings } from "../config/shared.ts";
import { FAKE_API, fakeGitHub } from "../hosts/github/fakeFetch.ts";
import { fakeJira, FAKE_SITE } from "../hosts/jira/fakeJira.ts";
import { CLOUD_EMAIL, CLOUD_ROBIN, cloudIssues, TOKEN } from "../hosts/jira/fixtures.ts";
import type { LogLineInput, WorkPatch, WritePort } from "../ports/host.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { openStore, type Store } from "../store/store.ts";
import type { ConnectDeps } from "./connect.ts";
import { createServer } from "./server.ts";
import { fakeIssues, ISSUES_API } from "../hosts/github/fakeIssues.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { type FakeMeta, fakeMeta } from "../items/fakeMeta.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const OWN = { version: 1, machineName: "laptop-a", repoPath: "repo", meta: { authorName: "Test Person", authorEmail: "test.person@example.invalid", prefix: "A" } };
const SHARED = { project: "demo", host: { kind: "metaBranch", write: true } };
const JIRA_HOST = { kind: "jira", site: FAKE_SITE, project: "DEMO", deployment: "cloud", write: true };

/** The meta branch's writes, recorded (and kept in the store once `attach`ed, as the meta host's sync would); `failOn` makes the close of that Item fail once. */
function metaWrites(failOn?: string) {
  const lines: { id: string; line: LogLineInput }[] = [];
  const closed: string[] = [];
  let failed = false;
  let store: Store | undefined;
  const keep = (item: Ref, change: (work: WorkItem) => WorkItem) => {
    const work = store?.get<WorkItem>(item);
    if (store && work) store.put(change(work), "sync", T0);
  };
  const write: WritePort = {
    async appendLog(item: Ref, line: LogLineInput) {
      lines.push({ id: item.id, line });
      keep(item, (work) => ({ ...work, log: [...(work.log ?? []), { at: T0, by: { who: line.by.who, agent: false }, kind: line.kind, fields: line.fields ?? {} }] }));
      return { work: item, shared: "local", conflict: false };
    },
    async editWork(item: Ref, patch: WorkPatch) {
      if (item.id === failOn && !failed) {
        failed = true;
        throw new Error("the meta ref moved");
      }
      if (patch.state === "abandoned") closed.push(item.id);
      keep(item, (work) => ({ ...work, ...(patch.state ? { state: patch.state } : {}) }));
      return { work: item, shared: "local", conflict: false };
    },
  };
  return { write, lines, closed, attach: (to: Store) => void (store = to) };
}

/** A server on a fresh private file and in-memory shared settings, connecting through `deps`. */
async function setUp(deps: ConnectDeps, given: { own?: Record<string, unknown>; shared?: Record<string, unknown>; write?: WritePort; meta?: FakeMeta } = {}) {
  const own0 = given.own ?? OWN;
  const shared0 = given.shared ?? SHARED;
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-connect-"));
  dirs.push(dir);
  const file = join(dir, "scopesoup.config.json");
  writeFileSync(file, JSON.stringify(own0, null, 2) + "\n");
  const settings = memorySettings(shared0, () => new Date(T0).toISOString());
  const store = openStore(":memory:");
  let changes = 0;
  const server = createServer({
    store, now: () => new Date(T0), port: 0, configFile: file, programFound: () => true, sharedSettings: settings, connect: deps, onConfigChanged: () => changes++, machine: "laptop-a",
    ...(given.write ? { items: { host: "demo", write: given.write } } : {}),
    ...(given.meta ? { metaBranch: () => given.meta! } : {}),
  });
  const base = (await server.start()).url;
  const post = async (body: unknown, person = "Ada") => {
    const response = await fetch(`${base}/api/connect`, { method: "POST", headers: { "Content-Type": "application/json", ...(person ? { "X-ScopeSoup-Person": person } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as { lines: string[]; problems: string[]; items?: { id: string; title: string }[]; moved?: string[]; done?: boolean } };
  };
  const own = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const stop = async () => {
    await server.stop();
    store.close();
  };
  return { post, own, settings, store, stop, changes: () => changes, base };
}

const repoRoute = (push: boolean) => ({ "/repos/acme/widgets": { body: { full_name: "acme/widgets", has_issues: true, permissions: { push } } } });
const jiraFake = () => fakeJira({ deployment: "cloud", token: TOKEN, email: CLOUD_EMAIL, user: CLOUD_ROBIN, issues: cloudIssues() });
const jiraBody = { kind: "jira", site: `${FAKE_SITE}/`, project: "demo", deployment: "cloud", email: CLOUD_EMAIL, filter: "", components: ["Board"] };

describe("POST /api/connect", { concurrency: 4 }, () => {
  test("without the token it names the variable to set, looks at no host and writes nothing", async () => {
    const github = fakeGitHub(repoRoute(true));
    const s = await setUp({ env: {}, fetchImpl: github.fetch, githubApi: FAKE_API });
    try {
      const plan = await s.post({ kind: "github", repo: "acme/widgets", confirm: true });
      assert.equal(plan.status, 400);
      assert.match(plan.body.problems.join(" "), /SCOPESOUP_GITHUB_TOKEN is not set/);
      assert.equal(github.calls.length, 0);
      assert.deepEqual(s.own(), OWN);
      assert.deepEqual(s.settings.current(), SHARED);
    } finally {
      await s.stop();
    }
  });

  test("GitHub: says what it would do; connects only when confirmed, keeping this machine's meta branch part", async () => {
    const github = fakeGitHub(repoRoute(true));
    const s = await setUp({ env: { SCOPESOUP_GITHUB_TOKEN: "ghp-synthetic" }, fetchImpl: github.fetch, githubApi: FAKE_API });
    try {
      const plan = await s.post({ kind: "github", repo: "https://github.com/acme/widgets.git" });
      assert.equal(plan.status, 200);
      assert.deepEqual(plan.body.problems, []);
      const text = plan.body.lines.join("\n");
      assert.match(text, /reads acme\/widgets, with write access/);
      assert.match(text, /Set up this machine for GitHub Issues" until it has SCOPESOUP_GITHUB_TOKEN/);
      assert.deepEqual(s.settings.current(), SHARED, "a plan writes nothing");

      const done = await s.post({ kind: "github", repo: "acme/widgets", confirm: true });
      assert.equal(done.status, 200);
      assert.equal(done.body.done, true);
      assert.deepEqual(s.settings.current(), { project: "demo", host: { kind: "github", repo: "acme/widgets", write: true } });
      assert.deepEqual(s.own(), OWN, "the meta branch part stays, side by side");
      assert.doesNotMatch(JSON.stringify(s.own()) + JSON.stringify(s.settings.current()), /ghp-synthetic/);
      assert.equal(s.changes(), 1);
      assert.equal(s.store.eventsOfKinds(["config.changed"], 10).length, 1);
    } finally {
      await s.stop();
    }
  });

  test("GitHub: a read-only token connects read-only only", async () => {
    const github = fakeGitHub(repoRoute(false));
    const s = await setUp({ env: { SCOPESOUP_GITHUB_TOKEN: "ghp-synthetic" }, fetchImpl: github.fetch, githubApi: FAKE_API });
    try {
      assert.deepEqual((await s.post({ kind: "github", repo: "acme/widgets", write: false })).body.problems, []);
      const plan = await s.post({ kind: "github", repo: "acme/widgets", confirm: true });
      assert.equal(plan.status, 400);
      assert.match(plan.body.problems.join(" "), /cannot write to acme\/widgets/);
      assert.deepEqual(s.settings.current(), SHARED);
    } finally {
      await s.stop();
    }
  });

  test("Jira Cloud: counts the open issues, keeps the email on this machine and the token nowhere", async () => {
    const jira = jiraFake();
    const s = await setUp({ env: { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: jira.fetch });
    try {
      const plan = await s.post(jiraBody);
      assert.deepEqual(plan.body.problems, []);
      const text = plan.body.lines.join("\n");
      assert.match(text, new RegExp(`signs in to ${FAKE_SITE} as ${CLOUD_ROBIN.displayName}`));
      assert.match(text, new RegExp(`${cloudIssues().filter((issue) => issue.fields.status?.statusCategory?.key !== "done").length} open issue\\(s\\) of DEMO would be the Items`));

      const done = await s.post({ ...jiraBody, confirm: true });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual(s.settings.current(), { project: "demo", host: { ...JIRA_HOST, components: ["Board"] } });
      assert.deepEqual(s.own(), { ...OWN, jira: { email: CLOUD_EMAIL } });
      assert.doesNotMatch(JSON.stringify(s.own()) + JSON.stringify(s.settings.current()), new RegExp(TOKEN));
    } finally {
      await s.stop();
    }
  });

  test("what the configuration refuses is said before any host is asked; GitHub and Jira are not connected to each other", async () => {
    const jira = jiraFake();
    const s = await setUp({ env: { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: jira.fetch });
    try {
      const plan = await s.post({ kind: "jira", site: FAKE_SITE, project: "demo-1", deployment: "cloud", email: CLOUD_EMAIL });
      assert.match(plan.body.problems.join(" "), /must be a Jira project key/);
      assert.equal(jira.calls.length, 0);
      assert.equal((await s.post({ kind: "gitlab" })).status, 400);
    } finally {
      await s.stop();
    }
    const across = await setUp({ env: { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: jira.fetch }, { shared: { project: "demo", host: { kind: "github", repo: "acme/widgets", write: true } } });
    try {
      const plan = await across.post({ ...jiraBody, confirm: true });
      assert.equal(plan.status, 400);
      assert.match(plan.body.problems.join(" "), /goes through the meta branch: "Move back to the meta branch" first, then Connect/);
    } finally {
      await across.stop();
    }
  });

  test("confirming needs a person, as every save of the shared settings does", async () => {
    const github = fakeGitHub(repoRoute(true));
    const s = await setUp({ env: { SCOPESOUP_GITHUB_TOKEN: "ghp-synthetic" }, fetchImpl: github.fetch, githubApi: FAKE_API });
    try {
      const done = await s.post({ kind: "github", repo: "acme/widgets", confirm: true }, "");
      assert.equal(done.status, 400);
      assert.match(done.body.problems.join(" "), /pick who you are/);
      assert.deepEqual(s.settings.current(), SHARED);
      assert.deepEqual(s.own(), OWN);
    } finally {
      await s.stop();
    }
  });

  test("refused while an agent session runs on any machine, naming the busy ones", async () => {
    const github = fakeGitHub(repoRoute(true));
    const s = await setUp({ env: { SCOPESOUP_GITHUB_TOKEN: "ghp-synthetic" }, fetchImpl: github.fetch, githubApi: FAKE_API });
    try {
      s.store.put(work(1, { holder: { actor: { id: "scopesoup@laptop-b", name: "scopesoup on laptop-b", bot: true } } }), "sync", T0);
      s.store.put(work(2, { holder: { actor: { id: "ada@laptop-c", name: "ada on laptop-c" } } }), "sync", T0);
      s.store.put(session(1, ref("work", 3)), "sync", T0);
      const plan = await s.post({ kind: "github", repo: "acme/widgets", confirm: true });
      assert.equal(plan.status, 400);
      assert.match(plan.body.problems.join(" "), /Busy now: laptop-a, laptop-b\. Other machines are seen only through their agents' claims on Items\./);
      assert.deepEqual(s.settings.current(), SHARED);
    } finally {
      await s.stop();
    }
  });

  test("from the meta branch: lists the open Items, moves the ticked ones once, rewrites their references, closes them there", async () => {
    const jira = jiraFake();
    const before = jira.issues.size;
    const meta = metaWrites("2");
    const s = await setUp({ env: { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: jira.fetch }, { write: meta.write });
    try {
      s.store.put(work(1, { title: "Tide table", body: "Read the tides. @robin fixes this." }), "sync", T0);
      s.store.put(work(2, { title: "Tide chart", body: "Needs 1 first: see 1.", verification: "Open the chart.", history: [{ at: T0, by: { id: "ada", name: "Ada" }, kind: "created", text: "Created the item." }] }), "sync", T0);
      s.store.put(work(3, { title: "Stays here" }), "sync", T0);
      s.store.put(work(4, { title: "Done already", state: "done" }), "sync", T0);
      const plan = await s.post({ ...jiraBody, move: ["1", "2"] });
      assert.deepEqual(plan.body.problems, []);
      assert.deepEqual(plan.body.items?.map((item) => item.id), ["1", "2", "3"]);
      assert.match(plan.body.lines.join("\n"), /Moves 2 Item\(s\) to Jira \(project DEMO\): 1, 2\./);
      assert.match(plan.body.lines.join("\n"), /The other 1 open Item\(s\) stay on the meta branch/);

      // The first run stops at closing Item 2: nothing is connected yet.
      const first = await s.post({ ...jiraBody, move: ["1", "2"], confirm: true });
      assert.equal(first.status, 500, JSON.stringify(first.body));
      assert.match(first.body.problems.join(" "), /Stopped at 2: the meta ref moved/);
      assert.deepEqual(s.settings.current(), SHARED);
      assert.equal(jira.issues.size, before + 2);

      // Run again: the two issues are found by their marker, not made again; then it connects.
      const done = await s.post({ ...jiraBody, move: ["1", "2"], confirm: true });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(jira.issues.size, before + 2, "nothing is made twice");
      assert.equal(s.settings.current()?.host && (s.settings.current()!.host as { kind: string }).kind, "jira");
      const made = [...jira.issues.values()].slice(before);
      const one = made.find((issue) => issue.fields.summary === "Tide table")!;
      const two = made.find((issue) => issue.fields.summary === "Tide chart")!;
      const text = (issue: typeof one) => JSON.stringify(issue.fields.description);
      assert.match(text(one), /Moved from Scope Soup's meta branch: Item 1\./);
      assert.doesNotMatch(text(one), /@robin/, "made inert");
      assert.match(text(two), new RegExp(`Needs ${one.key} first: see ${one.key}\\.`));
      assert.ok((jira.comments[two.key] ?? []).some((comment) => JSON.stringify(comment.body).includes("History of Item 2")));
      assert.deepEqual([...new Set(meta.closed)].sort(), ["1", "2"]);
      assert.deepEqual([...new Set(meta.lines.filter((each) => each.line.kind === "moved").map((each) => `${each.id} ${String(each.line.fields?.to)}`))].sort(), [`1 ${one.key}`, `2 ${two.key}`]);
      assert.deepEqual(s.store.eventsOfKinds(["items.moved"], 10).length, 2);
    } finally {
      await s.stop();
    }
  });

  test("join mode sets this machine up for the project's Jira host: its email only, the shared settings untouched", async () => {
    const jira = jiraFake();
    const shared = { project: "demo", host: JIRA_HOST };
    const s = await setUp({ env: { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: jira.fetch }, { own: { version: 1, machineName: "laptop-b", repoPath: "repo" }, shared });
    try {
      const setup = (await (await fetch(`${s.base}/api/machine-setup`)).json()) as { setup: unknown };
      assert.deepEqual(setup, { setup: null, meta: {} }, "the server was not told this machine lacks anything");
      const plan = await s.post({ mode: "join", email: CLOUD_EMAIL });
      assert.deepEqual(plan.body.problems, []);
      assert.match(plan.body.lines.join("\n"), /the project's shared settings stay as they are/);
      const done = await s.post({ mode: "join", email: CLOUD_EMAIL, confirm: true }, "");
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual(s.own(), { version: 1, machineName: "laptop-b", repoPath: "repo", jira: { email: CLOUD_EMAIL } });
      assert.deepEqual(s.settings.current(), shared);
      assert.equal(s.settings.saves, 0);
    } finally {
      await s.stop();
    }
  });

  test("a move that stops after closing A-1: the retry keeps A-1's new id in A-2's text, and A-1's issue names A-2's", async () => {
    const jira = jiraFake();
    const before = jira.issues.size;
    const meta = metaWrites("A-2");
    const s = await setUp({ env: { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: jira.fetch }, { write: meta.write });
    meta.attach(s.store);
    try {
      s.store.put(work("A-1", { title: "Tide table", body: "Before A-2; see `A-2` and https://example.test/A-2." }), "sync", T0);
      s.store.put(work("A-2", { title: "Tide chart", body: "After A-1." }), "sync", T0);
      const first = await s.post({ ...jiraBody, move: ["A-1", "A-2"], confirm: true });
      assert.equal(first.status, 500, JSON.stringify(first.body));
      assert.deepEqual(meta.closed, ["A-1"]);
      // The retry: A-1 is closed on the meta branch now, named by its moved line; only A-2 is left to tick.
      const plan = await s.post({ ...jiraBody, move: ["A-1", "A-2"] });
      assert.deepEqual(plan.body.items?.map((item) => item.id), ["A-2"]);
      const second = await s.post({ ...jiraBody, move: ["A-1", "A-2"], confirm: true });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(jira.issues.size, before + 2);
      const made = [...jira.issues.values()].slice(before);
      const one = made.find((issue) => issue.fields.summary === "Tide table")!;
      const two = made.find((issue) => issue.fields.summary === "Tide chart")!;
      const text = (issue: typeof one) => JSON.stringify(jira.issues.get(issue.key)!.fields.description);
      assert.match(text(two), new RegExp(`After ${one.key}\.`));
      assert.match(text(one), new RegExp(`Before ${two.key}; see `));
      assert.match(text(one), /A-2".*example\.test\/A-2/, "code and addresses are left alone");
      assert.deepEqual(meta.closed, ["A-1", "A-2"]);
    } finally {
      await s.stop();
    }
  });

  test("an issue made outside the Jira filter stops the move before any old Item closes; a retry finds it and makes no second", async () => {
    const jira = jiraFake();
    const before = jira.issues.size;
    const meta = metaWrites();
    const s = await setUp({ env: { SCOPESOUP_JIRA_TOKEN: TOKEN }, fetchImpl: jira.fetch }, { write: meta.write });
    meta.attach(s.store);
    try {
      s.store.put(work("A-1", { title: "Tide table" }), "sync", T0);
      const body = { ...jiraBody, filter: "labels = scopesoup", move: ["A-1"], confirm: true };
      for (const run of [1, 2]) {
        const done = await s.post(body);
        assert.equal(done.status, 500, `run ${run}: ${JSON.stringify(done.body)}`);
        assert.match(done.body.problems.join(" "), /not an Item \(host.filter is labels = scopesoup\)|falls outside host.filter/);
        assert.match(done.body.problems.join(" "), /No old Item was closed/);
      }
      assert.equal(jira.issues.size, before + 1, "the retry found the issue by its marker");
      assert.deepEqual(meta.closed, []);
      assert.deepEqual(s.settings.current(), SHARED);
    } finally {
      await s.stop();
    }
  });
});

describe("POST /api/connect back to the meta branch (#134)", { concurrency: 4 }, () => {
  const GITHUB = { project: "demo", host: { kind: "github", repo: "harbour/tides", write: true } };
  const PART = { authorName: "Test Person", authorEmail: "test.person@example.invalid", prefix: "B" };
  const BARE = { version: 1, machineName: "laptop-a", repoPath: "repo" };
  const tides = () => {
    const fake = fakeIssues("harbour/tides", [1, 2, 3]);
    Object.assign(fake.issues.get("1")!, { title: "Tide table", body: "Before #2." });
    Object.assign(fake.issues.get("2")!, { title: "Tide chart", body: "After #1." });
    return fake;
  };
  const deps = (fake: ReturnType<typeof fakeIssues>): ConnectDeps => ({ env: { SCOPESOUP_GITHUB_TOKEN: "ghp-synthetic" }, fetchImpl: fake.fetch, githubApi: ISSUES_API });
  const back = (extra: Record<string, unknown> = {}) => ({ kind: "metaBranch", ...PART, ...extra });

  test("from GitHub: asks for this machine's part, lists the open issues, moves the ticked ones, then switches", async () => {
    const github = tides();
    const meta = fakeMeta("B");
    const s = await setUp(deps(github), { own: BARE, shared: GITHUB, meta });
    try {
      const bare = await s.post({ kind: "metaBranch" });
      assert.match(bare.body.problems.join(" "), /Give your name.*Give your email.*id prefix/);
      const plan = await s.post(back({ move: ["#1", "#2"], close: true }));
      assert.deepEqual(plan.body.problems, []);
      assert.deepEqual(plan.body.items?.map((item) => item.id), ["#1", "#2", "#3"]);
      const text = plan.body.lines.join("\n");
      assert.match(text, /Moves 2 issue\(s\) to the meta branch: #1, #2\./);
      assert.match(text, /a comment on GitHub naming its new Item and is closed there as not planned/);
      assert.match(text, /The other 1 open issue\(s\) stay on GitHub Issues \(harbour\/tides\)/);
      assert.match(text, /Set up this machine for the meta branch/);
      assert.equal(meta.items.size, 0, "a plan writes nothing");
      assert.deepEqual(s.settings.current(), GITHUB);

      const done = await s.post(back({ move: ["#1", "#2"], close: true, confirm: true }));
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.match((done.body.moved ?? []).join("\n"), /#1 "Tide table": B-1 \(created, labelled, commented, closed\)/);
      assert.match(meta.items.get("B-2")!.input.body!, /^After B-1\./);
      assert.deepEqual(s.settings.current(), { project: "demo", host: { kind: "metaBranch", write: true } });
      assert.deepEqual(s.own(), { ...BARE, meta: PART });
      assert.equal(github.issues.get("1")!.state, "closed");
      assert.equal(github.issues.get("3")!.state, "open");
      assert.equal((github.comments.get("2") ?? []).filter((comment) => readMarker(comment.body)?.kind === "moved").length, 1);
      assert.equal(s.store.eventsOfKinds(["items.moved"], 10).length, 1);
    } finally {
      await s.stop();
    }
  });

  test("a move that stops is not switched; Move back again finishes it and makes nothing twice", async () => {
    const github = tides();
    const meta = fakeMeta("B");
    github.fail((call) => call === "POST /repos/harbour/tides/issues/2/comments", 502);
    const s = await setUp(deps(github), { own: BARE, shared: GITHUB, meta });
    try {
      const first = await s.post(back({ move: ["#1", "#2"], confirm: true }));
      assert.equal(first.status, 500, JSON.stringify(first.body));
      assert.match(first.body.problems.join(" "), /Stopped at #2/);
      assert.deepEqual(s.settings.current(), GITHUB);
      assert.deepEqual(s.own(), BARE);
      const second = await s.post(back({ move: ["#1", "#2"], confirm: true }));
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(meta.items.size, 2);
      assert.equal(meta.commits, 1);
      assert.equal(github.issues.get("2")!.state, "open", "left open, as chosen");
    } finally {
      await s.stop();
    }
  });

  test("refused while an agent session runs; read-only GitHub moves nothing; no token lists nothing", async () => {
    const github = tides();
    const s = await setUp(deps(github), { own: BARE, shared: GITHUB, meta: fakeMeta("B") });
    try {
      s.store.put(work(1, { holder: { actor: { id: "scopesoup@laptop-b", name: "scopesoup on laptop-b", bot: true } } }), "sync", T0);
      const plan = await s.post(back({ move: ["#1"], confirm: true }));
      assert.equal(plan.status, 400);
      assert.match(plan.body.problems.join(" "), /Moving back waits until no agent session runs on any machine.*Busy now: laptop-b/);
      assert.deepEqual(s.settings.current(), GITHUB);
    } finally {
      await s.stop();
    }
    const readOnly = await setUp(deps(tides()), { own: BARE, shared: { ...GITHUB, host: { ...GITHUB.host, write: false } }, meta: fakeMeta("B") });
    try {
      assert.match((await readOnly.post(back({ move: ["#1"] }))).body.problems.join(" "), /read-only here/);
      assert.deepEqual((await readOnly.post(back())).body.problems, [], "switching without moving needs no writes on GitHub");
    } finally {
      await readOnly.stop();
    }
    const noToken = await setUp({ env: {}, fetchImpl: tides().fetch, githubApi: ISSUES_API }, { own: BARE, shared: GITHUB, meta: fakeMeta("B") });
    try {
      const plan = await noToken.post(back({ move: ["#1"] }));
      assert.equal(plan.body.items, undefined);
      assert.match(plan.body.lines.join(" "), /SCOPESOUP_GITHUB_TOKEN is not set .* none can move/);
    } finally {
      await noToken.stop();
    }
  });

  test("join mode on the meta branch writes this machine's meta part only", async () => {
    const shared = { project: "demo", host: { kind: "metaBranch", write: true } };
    const s = await setUp({ env: {} }, { own: BARE, shared });
    try {
      const setup = (await (await fetch(`${s.base}/api/machine-setup`)).json()) as { meta: unknown };
      assert.deepEqual(setup.meta, {});
      assert.match((await s.post({ mode: "join", ...PART, prefix: "1x" })).body.problems.join(" "), /id prefix/);
      const done = await s.post({ mode: "join", ...PART, confirm: true }, "");
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual(s.own(), { ...BARE, meta: PART });
      assert.deepEqual(s.settings.current(), shared);
      assert.equal(s.settings.saves, 0);
    } finally {
      await s.stop();
    }
  });
});
