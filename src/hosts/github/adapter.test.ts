import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubHost } from "./adapter.ts";
import type { FakeRoute } from "./fakeFetch.ts";
import { FAKE_API, fakeGitHub } from "./fakeFetch.ts";
import { R, REPO, check, issue, job, pull, review, workflowRun } from "./fixtures.ts";
import type { HostEvent } from "../../ports/host.ts";

const OPEN_ISSUES = `${R}/issues?state=open&sort=updated&direction=asc&per_page=100`;
const OPEN_PULLS = `${R}/pulls?state=open&sort=created&direction=asc&per_page=100`;
const since = (iso: string) => `${R}/issues?state=all&since=${encodeURIComponent(iso)}&sort=updated&direction=asc&per_page=100`;

function setup(routes: Record<string, FakeRoute | unknown[]>, over: Partial<Parameters<typeof createGitHubHost>[0]> = {}) {
  const fake = fakeGitHub(routes);
  const host = createGitHubHost({
    token: "t-synthetic",
    repo: REPO,
    fetchImpl: fake.fetch,
    apiUrl: FAKE_API,
    now: () => Date.parse("2026-11-10T12:00:00Z"),
    ...over,
  });
  return { fake, host };
}

test("issues become work items; pull requests in the issues list are left out", async () => {
  const { host } = setup({
    [OPEN_ISSUES]: [
      issue(11, { labels: [{ name: "bug" }, "effort:S"], sub_issues_summary: { total: 3, completed: 1 }, updated_at: "2026-11-10T08:00:00Z" }),
      issue(12, { pull_request: { url: "x" }, updated_at: "2026-11-10T09:00:00Z" }),
      issue(13, {
        assignees: [{ login: "robin", type: "User" }],
        parent_issue_url: `https://api.github.test${R}/issues/11`,
        issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 2 },
        updated_at: "2026-11-10T08:30:00Z",
      }),
    ],
    [`${R}/issues/13/dependencies/blocked_by?per_page=100`]: [issue(14), issue(15, { state: "closed" })],
  });
  const page = await host.work.listWork();
  assert.deepEqual(page.items.map((item) => item.ref.id), ["11", "13"]);
  const [first, second] = page.items;
  assert.deepEqual(first, {
    ref: { host: "github", kind: "work", id: "11", url: "https://github.test/acme/widgets/issues/11" },
    title: "Item 11",
    state: "todo",
    hostState: "open",
    labels: ["bug", "effort:S"],
    blockedBy: [],
    openChildren: 2,
    children: 3,
    updatedAt: "2026-11-10T08:00:00Z",
    body: "Body of item 11.",
    // No `scopesoup:todo` label: in Backlog (decision 120).
    backlog: true,
  });
  assert.equal(second?.state, "doing");
  assert.equal(second?.backlog, undefined);
  assert.deepEqual(second?.holder, { actor: { id: "robin", name: "robin" } });
  assert.deepEqual(second?.parent, { host: "github", kind: "work", id: "11" });
  assert.deepEqual(second?.blockedBy, [{ host: "github", kind: "work", id: "14", url: "https://github.test/acme/widgets/issues/14" }]);
  // The cursor is the newest update seen, the pull request's included.
  assert.equal(page.cursor, "2026-11-10T09:00:00Z");
});

test("listWork with a cursor asks with since, maps closed issues, and a 304 is free and unchanged", async () => {
  const cursor = "2026-11-10T09:00:00Z";
  const { fake, host } = setup({
    [since(cursor)]: [
      issue(11, { state: "closed", state_reason: "completed", updated_at: "2026-11-10T10:00:00Z" }),
      issue(16, { state: "closed", state_reason: "not_planned", updated_at: "2026-11-10T10:05:00Z" }),
    ],
  });
  const page = await host.work.listWork(cursor);
  assert.deepEqual(page.items.map((item) => [item.ref.id, item.state, item.hostState]), [
    ["11", "done", "closed:completed"],
    ["16", "abandoned", "closed:not_planned"],
  ]);
  assert.equal(page.cursor, "2026-11-10T10:05:00Z");

  const budget = fake.remaining;
  const again = await host.work.listWork(cursor);
  assert.deepEqual(again, { items: [], cursor, unchanged: true });
  assert.equal(fake.remaining, budget);
});

test("getWork returns null for a missing issue and for a pull request", async () => {
  const { host } = setup({ [`${R}/issues/12`]: { body: issue(12, { pull_request: {} }) } });
  assert.equal(await host.work.getWork({ host: "github", kind: "work", id: "12" }), null);
  assert.equal(await host.work.getWork({ host: "github", kind: "work", id: "99" }), null);
});

function pullRoutes(): Record<string, FakeRoute | unknown[]> {
  return {
    [OPEN_PULLS]: [
      pull(21, { body: "Adds the thing.\n\nRefs #11, #13\nFixes #14", requested_reviewers: [{ login: "kim" }], labels: [{ name: "tidy" }] }),
      pull(22, { draft: true, user: { login: "helper[bot]", type: "Bot" } }),
    ],
    [`${R}/pulls/21/reviews?per_page=100`]: [
      review(1, "sam", "APPROVED", "sha21-old", "2026-11-10T09:10:00Z"),
      review(2, "alex", "CHANGES_REQUESTED", "sha21a", "2026-11-10T09:20:00Z"),
      review(3, "alex", "COMMENTED", "sha21a", "2026-11-10T09:25:00Z"),
      review(4, "lee", "APPROVED", "sha21a", "2026-11-10T09:26:00Z"),
      review(5, "lee", "DISMISSED", "sha21a", "2026-11-10T09:27:00Z"),
    ],
    [`${R}/commits/sha21a/check-runs?per_page=100`]: {
      body: { total_count: 3, check_runs: [check(1, "test", "completed", "failure"), check(2, "test", "completed", "success"), check(3, "lint", "completed", "skipped")] },
    },
    [`${R}/pulls/22/reviews?per_page=100`]: [],
    [`${R}/commits/sha22a/check-runs?per_page=100`]: { body: { total_count: 1, check_runs: [check(4, "test", "in_progress")] } },
  };
}

test("pull requests become changes with review and CI verdicts and linked work", async () => {
  const { host } = setup(pullRoutes());
  const page = await host.changes.listChanges();
  const [first, second] = page.items;
  assert.equal(first?.title, "Change 21");
  assert.equal(first?.state, "open");
  assert.equal(first?.target, "main");
  assert.equal(first?.branch, "feature/21");
  assert.deepEqual(first?.labels, ["tidy"]);
  assert.deepEqual(first?.revisions.map((revision) => revision.sha), ["sha21a"]);
  assert.deepEqual(first?.works.map((ref) => ref.id), ["11", "13", "14"]);
  assert.deepEqual(
    first?.verdicts.map((verdict) => [verdict.dimension, verdict.by?.id, verdict.value, verdict.stale]),
    [
      ["review", "sam", "pass", true],
      ["review", "alex", "fail", false],
      ["review", "kim", "pending", false],
      ["ci", undefined, "pass", false],
    ],
  );
  assert.equal(first?.verdicts[0]?.revision, "sha21-old");
  assert.equal(second?.draft, true);
  assert.deepEqual(second?.author, { id: "helper[bot]", name: "helper[bot]", bot: true });
  assert.deepEqual(second?.verdicts.map((verdict) => [verdict.dimension, verdict.value]), [["ci", "pending"]]);
});

test("listChanges with a cursor costs nothing when nothing changed, and returns only what did", async () => {
  const { fake, host } = setup(pullRoutes());
  const first = await host.changes.listChanges();
  const budget = fake.remaining;
  fake.take();

  const quiet = await host.changes.listChanges(first.cursor);
  assert.deepEqual(quiet, { items: [], cursor: first.cursor, unchanged: true });
  assert.equal(fake.remaining, budget);
  assert.ok(fake.take().every((call) => call.startsWith("304 ")));

  // A check finishing does not touch the pull's updated_at, but still shows up.
  fake.set(`${R}/commits/sha22a/check-runs?per_page=100`, { body: { total_count: 1, check_runs: [check(4, "test", "completed", "failure")] } });
  const changed = await host.changes.listChanges(first.cursor);
  assert.deepEqual(changed.items.map((change) => change.ref.id), ["22"]);
  assert.deepEqual(changed.items[0]?.verdicts.at(-1)?.value, "fail");
  assert.equal(changed.unchanged, undefined);
});

test("a pull that left the open list comes back once with its final state, or as removed", async () => {
  const { fake, host } = setup(pullRoutes());
  const first = await host.changes.listChanges();
  fake.set(OPEN_PULLS, []);
  fake.set(`${R}/pulls/21`, { body: pull(21, { state: "closed", merged: true, mergeable: null, updated_at: "2026-11-10T11:00:00Z" }) });
  const page = await host.changes.listChanges(first.cursor);
  assert.deepEqual(page.items.map((change) => [change.ref.id, change.state]), [["21", "merged"]]);
  assert.deepEqual(page.removed, [{ host: "github", kind: "change", id: "22" }]);
  assert.equal(page.cursor, JSON.stringify({ open: {} }));
  const after = await host.changes.listChanges(page.cursor);
  assert.equal(after.unchanged, true);
});

test("getChange reads mergeability from the single pull", async () => {
  const routes = pullRoutes();
  routes[`${R}/pulls/21`] = { body: pull(21, { mergeable: false, mergeable_state: "dirty" }) };
  const { host } = setup(routes);
  const change = await host.changes.getChange({ host: "github", kind: "change", id: "21" });
  assert.equal(change?.mergeable, false);
  assert.deepEqual(change?.blockers, ["conflicts with the target branch"]);
  assert.equal(await host.changes.getChange({ host: "github", kind: "change", id: "404" }), null);
});

const ciRoutes = (): Record<string, FakeRoute | unknown[]> => ({
  [`${R}/actions/runs?status=queued&per_page=100`]: {
    body: { workflow_runs: [workflowRun(31, { status: "queued", conclusion: null, head_branch: "batch/7" })] },
  },
  [`${R}/actions/runs?status=in_progress&per_page=100`]: {
    body: { workflow_runs: [workflowRun(32, { status: "in_progress", conclusion: null, name: "Light check" })] },
  },
  [`${R}/actions/runs/31/jobs?filter=latest&per_page=100`]: { body: { jobs: [job(1, { status: "queued", started_at: null, runner_name: null })] } },
  [`${R}/actions/runs/32/jobs?filter=latest&per_page=100`]: {
    body: {
      jobs: [
        job(2, {
          steps: [
            { name: "Set up job", status: "completed", conclusion: "success", started_at: "2026-11-10T10:01:00Z", completed_at: "2026-11-10T10:01:05Z" },
            { name: "Run tests", status: "in_progress", conclusion: null, started_at: "2026-11-10T10:01:05Z" },
            { name: "Upload report", status: "queued", conclusion: null },
          ],
        }),
      ],
    },
  },
  [`${R}/actions/workflows?per_page=100`]: { body: { workflows: [{ id: 501, name: "Full suite" }, { id: 502, name: "Light check" }] } },
  [`${R}/actions/workflows/501/runs?status=completed&per_page=2`]: {
    body: {
      workflow_runs: [workflowRun(30, { conclusion: "failure" }), workflowRun(29), workflowRun(28, { conclusion: "cancelled" })],
    },
  },
  [`${R}/actions/runs?head_sha=sha29&per_page=100`]: { body: { workflow_runs: [workflowRun(29)] } },
  [`${R}/actions/runners?per_page=100`]: {
    body: { runners: [{ id: 1, name: "box-1", status: "online", busy: true, labels: [{ name: "self-hosted" }] }, { id: 2, name: "box-2", status: "offline", busy: false }] },
  },
});

test("workflow runs become runs: pipeline is the workflow name, active runs carry steps and the runner", async () => {
  const { host } = setup(ciRoutes());
  const active = await host.ci.activeRuns();
  assert.deepEqual(active.map((run) => [run.ref.id, run.pipeline, run.status, run.branch]), [
    ["31", "Full suite", "queued", "batch/7"],
    ["32", "Light check", "running", "main"],
  ]);
  assert.equal(active[0]?.startedAt, undefined);
  assert.deepEqual(active[0]?.steps, [{ name: "test", status: "queued" }]);
  assert.equal(active[1]?.runner, "box-1");
  assert.deepEqual(active[1]?.steps?.map((step) => [step.name, step.status]), [
    ["Set up job", "passed"],
    ["Run tests", "running"],
    ["Upload report", "queued"],
  ]);

  const recent = await host.ci.recentRuns("Full suite", 2);
  assert.deepEqual(recent.map((run) => [run.ref.id, run.status, run.finishedAt]), [
    ["30", "failed", "2026-11-10T10:20:00Z"],
    ["29", "passed", "2026-11-10T10:20:00Z"],
  ]);
  assert.deepEqual(await host.ci.recentRuns("No such workflow", 5), []);
  assert.deepEqual((await host.ci.runsFor("sha29")).map((run) => run.ref.id), ["29"]);

  const runners = await host.ci.runners();
  assert.deepEqual(runners, [
    { id: "1", name: "box-1", online: true, busy: true, labels: ["self-hosted"], current: { host: "github", kind: "run", id: "32", url: "https://github.test/acme/widgets/actions/runs/32" } },
    { id: "2", name: "box-2", online: false, busy: false, labels: [] },
  ]);
});

test("runners without admin rights: empty, remembered, and no longer a capability", async () => {
  const routes = ciRoutes();
  routes[`${R}/actions/runners?per_page=100`] = { status: 403, body: { message: "Resource not accessible by personal access token" } };
  const { fake, host } = setup(routes);
  assert.ok(host.info.capabilities.has("runners"));
  assert.deepEqual(await host.ci.runners(), []);
  assert.deepEqual(await host.ci.runners(), []);
  assert.equal(fake.calls.length, 1);
  assert.ok(!host.info.capabilities.has("runners"));
});

test("whoami and apiBudget", async () => {
  const { fake, host } = setup({
    "/user": { body: { login: "robin", name: "Robin Example", type: "User" } },
    "/rate_limit": { body: { rate: { remaining: 4999 } } },
  });
  assert.deepEqual(await host.info.apiBudget?.(), { remaining: 4999, resetAt: new Date(1795000000 * 1000).toISOString() });
  assert.deepEqual(await host.info.whoami(), { id: "robin", name: "Robin Example" });
  await host.info.whoami();
  assert.equal(fake.calls.length, 2);

  const named = setup({}, { login: "github-actions[bot]" });
  assert.deepEqual(await named.host.info.whoami(), { id: "github-actions[bot]", name: "github-actions[bot]", bot: true });
  assert.equal(named.fake.calls.length, 0);
});

test("watch polls on the injected timer and reports only what changed after the baseline", async () => {
  const probes = {
    work: `${R}/issues?state=all&sort=updated&direction=desc&per_page=1`,
    changes: `${R}/pulls?state=all&sort=updated&direction=desc&per_page=1`,
    ci: `${R}/actions/runs?per_page=1`,
  };
  const timers: (() => void)[] = [];
  let cancelled = 0;
  const { fake, host } = setup(
    { [probes.work]: [issue(11)], [probes.changes]: [pull(21)], [probes.ci]: { body: { workflow_runs: [workflowRun(30)] } } },
    {
      setTimer: (fn) => {
        timers.push(fn);
        return () => void cancelled++;
      },
    },
  );
  const events: HostEvent[] = [];
  const stop = await host.watch.watch((event) => events.push(event));
  assert.equal(events.length, 0);
  assert.equal(timers.length, 1);

  const round = async () => {
    timers.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const budget = fake.remaining;
  await round();
  assert.equal(events.length, 0);
  assert.equal(fake.remaining, budget);

  fake.set(probes.work, [issue(12, { pull_request: {} })]);
  fake.set(probes.ci, { body: { workflow_runs: [workflowRun(31)] } });
  await round();
  assert.deepEqual(events.map((event) => [event.hint, event.subject?.kind, event.subject?.id]), [
    ["work", "change", "12"],
    ["ci", "run", "31"],
  ]);

  stop();
  assert.equal(cancelled, 1);
});
