// The GitHub adapter: one repository as a host of work items, changes and CI. It writes only with `allowWrites`.
// No project-specific conventions here.

import { createHash } from "node:crypto";
import { changeText } from "../../model/labels.ts";
import type { Actor, Change, Ref, RepoLabel, Run, Runner, WorkItem } from "../../model/types.ts";
import { refKey } from "../../model/types.ts";
import type { AnswerWrite, Capability, ChangePort, CiPort, Cursor, ExternalCheck, Host, HostEvent, HostInfo, Page, QueueCiPort, RepositoryPort, WatchPort, WorkPort, WritePort } from "../../ports/host.ts";
import { AlreadyAnswered, BodyChanged, COMMENT_LIMIT, NotScopeSoups, TooLarge, WorkGone, WriteLater } from "../../ports/host.ts";
import type { Client, FetchLike } from "./client.ts";
import { GitHubError, createClient, transient } from "./client.ts";
import type { LogKeep, LogLine, Thread } from "./conventions.ts";
import { answersBody, assumptionBody, batchBody, claimBody, clipLogFields, draftBody, mergedBody, liveClaims, logBody, nextQuestionNumber, questionBody, questionNumber, readMarker, readThread, readVerdicts, waitsForAnswer, withConventions, withdrawnBody } from "./conventions.ts";
import type { Scope } from "./map.ts";
import { actorOf, ASSUMPTION_LABEL, changeRef, CHECK_GREEN, CLAIMED_LABEL, hasLabel, issueRefFromUrl, issueToWork, labelNames, NEEDS_DECISION_LABEL, pullToChange, runToRun, runnerToRunner, spliceBody, workRef } from "./map.ts";
import type { RestCheckRun, RestCombinedStatus, RestComment, RestIssue, RestJob, RestLabel, RestPull, RestReview, RestRunner, RestUser, RestWorkflow, RestWorkflowRun } from "./rest.ts";
import type { SetTimer } from "./watch.ts";
import { pollingWatch } from "./watch.ts";

export interface GitHubConfig {
  /** Passed in by the caller; the adapter never reads the environment. */
  token: string;
  /** "owner/name". */
  repo: string;
  /** The host id used in refs. Default "github". */
  id?: string;
  fetchImpl?: FetchLike;
  apiUrl?: string;
  apiVersion?: string;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Who the token acts as, for tokens that cannot read /user (a workflow's GITHUB_TOKEN). */
  login?: string;
  /** Which runs get their jobs fetched for steps and the runner name. Default "active". */
  jobDetail?: "none" | "active" | "all";
  /** How often `watch` probes. Default 30 s. */
  pollMs?: number;
  setTimer?: SetTimer;
  /** Parallel requests when a list needs one request per item. Default 6. */
  concurrency?: number;
  /** Must be true for the host to get a write port. Without it the adapter cannot change anything. */
  allowWrites?: boolean;
  /** Read Scope Soup's comment markers and `A1:` replies into each item (docs/github-mapping.md). One more conditional request per poll. */
  conventions?: boolean;
  /** This machine's name in Scope Soup's claim comments. Claims need it, the conventions and writes. */
  machine?: string;
  /** Told the name of each label Scope Soup created (not one that existed), for offboarding's manifest. */
  onLabelCreated?: (name: string) => void;
}

export interface GitHubHost extends Host {
  info: HostInfo;
  work: WorkPort;
  changes: ChangePort;
  ci: CiPort & { runners(): Promise<Runner[]> };
  watch: WatchPort;
  repository: RepositoryPort;
  /** The open issues this one blocks (`GET .../dependencies/blocking`), for the Item page only. */
  blocking(ref: Ref): Promise<Ref[]>;
  /** The names of the repository's labels; the triage reads them for the labels a triage may propose. */
  labels(): Promise<string[]>;
  /** Requests sent and how many were free 304s. */
  stats(): { sent: number; notModified: number };
  /** The merge queue's wait for the project's CI; only with `allowWrites`. */
  queueCi?: QueueCiPort;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** The labels Scope Soup creates on first use (docs/github-mapping.md, section 3). An existing label is never recoloured. */
const LABEL_LOOKS: Record<string, { color: string; description: string }> = {
  [NEEDS_DECISION_LABEL]: { color: "d93f0b", description: "A Scope Soup question or rewrite waits for an answer" },
  [CLAIMED_LABEL]: { color: "0e8a16", description: "Held by a Scope Soup agent (see the claim comment)" },
  [ASSUMPTION_LABEL]: { color: "fef2c0", description: "A Scope Soup agent decided something itself: accept or overturn it on the board" },
  "priority:blocker": { color: "b60205", description: "Priority, read by Scope Soup" },
  "priority:critical": { color: "d93f0b", description: "Priority, read by Scope Soup" },
  "priority:major": { color: "fbca04", description: "Priority, read by Scope Soup" },
  "priority:minor": { color: "c2e0c6", description: "Priority, read by Scope Soup" },
  // The hand-back label and the stated sizes are made by people; their looks are the ones in docs/github-mapping.md, section 3.
  "scopesoup:review": { color: "1d76db", description: "Hand-back: Scope Soup reviews this pull request" },
  "size:small": { color: "c5def5", description: "Stated size: skips the triage" },
  "size:medium": { color: "bfd4f2", description: "Stated size: skips the triage" },
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The head branch of a batch's pull request (`scopesoup/batch-<batch>-<commit>`), the only branch Scope Soup ever deletes. */
export const BATCH_BRANCH = /^scopesoup\/batch-\d+-[0-9a-f]{7,40}$/;

const notFound = (error: unknown): boolean => error instanceof GitHubError && error.status === 404;

/** A failure that can change by itself becomes `WriteLater`, so the orchestrator tries the step again instead of escalating. */
const later = (error: unknown): unknown => (transient(error) ? new WriteLater(error instanceof Error ? error.message : String(error)) : error);

/** The change cursor: the open pull requests of the last listing and when each was last updated. */
function parseChangeCursor(cursor: Cursor | undefined): Record<string, string> | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as { open?: Record<string, string> };
    return parsed.open && typeof parsed.open === "object" ? parsed.open : null;
  } catch {
    return null;
  }
}

export function createGitHubHost(config: GitHubConfig): GitHubHost {
  const client: Client = createClient(config);
  const scope: Scope = { host: config.id ?? "github", repo: config.repo };
  const now = config.now ?? Date.now;
  const concurrency = config.concurrency ?? 6;
  const jobDetail = config.jobDetail ?? "active";
  const r = client.repoPath;
  const capabilities = new Set<Capability>(["work", "changes", "ci", "runners"]);
  /** Runner name -> the run it works on, from the last look at the active runs. */
  let runnerWork = new Map<string, Ref>();
  let runnersForbidden = false;
  let me: Actor | null = null;

  const claims = config.conventions && config.allowWrites && config.machine ? config.machine : undefined;
  const info: HostInfo = {
    id: scope.host,
    ...(claims ? { claimMachine: claims } : {}),
    capabilities,
    async whoami() {
      if (me) return me;
      if (config.login) return (me = { id: config.login, name: config.login, bot: config.login.endsWith("[bot]") });
      const user = (await client.get<RestUser & { name?: string | null }>("/user")).data;
      me = { ...actorOf(user), name: user.name || user.login };
      return me;
    },
    async apiBudget() {
      // /rate_limit itself is free, and its headers carry the same numbers.
      if (!client.budget()) await client.get("/rate_limit");
      return client.budget();
    },
  };

  // --- work ---

  const issueRef = (issue: RestIssue): Ref => {
    const ref = issueRefFromUrl(scope, issue.html_url) ?? workRef(scope, issue.number);
    if (issue.html_url) ref.url = issue.html_url;
    return ref;
  };

  /** One side of an issue's dependencies, open and closed: `blocked_by` or `blocking`. */
  const dependencies = async (number: string, side: "blocked_by" | "blocking"): Promise<RestIssue[]> =>
    (await client.list<RestIssue>(r(`/issues/${number}/dependencies/${side}?per_page=100`))).data;

  async function blockers(issue: RestIssue): Promise<Ref[]> {
    if (!issue.issue_dependencies_summary?.blocked_by) return [];
    return (await dependencies(String(issue.number), "blocked_by")).filter((blocker) => blocker.state === "open").map(issueRef);
  }

  /** The sha256 of each issue body as last read, for the conventions layer (is a draft's original still the body?). */
  const bodyShas = new Map<string, string>();
  const toWork = async (issue: RestIssue): Promise<WorkItem> => {
    if (config.conventions) bodyShas.set(String(issue.number), sha256(issue.body ?? ""));
    return issueToWork(scope, issue, await blockers(issue));
  };

  const plainWork: WorkPort = {
    async listWork(since) {
      const query = since
        ? `state=all&since=${encodeURIComponent(since)}&sort=updated&direction=asc&per_page=100`
        : "state=open&sort=updated&direction=asc&per_page=100";
      const got = await client.list<RestIssue>(r(`/issues?${query}`));
      if (since && got.unchanged) return { items: [], cursor: since, unchanged: true };
      const issues = got.data.filter((issue) => !issue.pull_request);
      const items = await pool(issues, concurrency, toWork);
      // `since` is inclusive, so the newest item comes once more next time and is then a free 304.
      let cursor = since ?? "";
      for (const issue of got.data) if (issue.updated_at > cursor) cursor = issue.updated_at;
      // Nothing to take a time from: start a minute back, to allow for a clock that runs ahead of GitHub's.
      if (!cursor) cursor = new Date(now() - 60_000).toISOString();
      return { items, cursor };
    },

    async getWork(ref) {
      try {
        // A transferred issue answers 301, which is read, not followed.
        const issue = (await client.get<RestIssue>(r(`/issues/${ref.id}`), { noRedirect: true })).data;
        return issue.pull_request ? null : await toWork(issue);
      } catch (error) {
        if (notFound(error)) return null;
        if (error instanceof GitHubError && error.status === 301) throw new WorkGone(`#${ref.id} was transferred on GitHub${error.location ? ` to ${error.location}` : ""}.`, error.location);
        if (error instanceof GitHubError && error.status === 410) throw new WorkGone(`#${ref.id} was deleted on GitHub.`);
        throw error;
      }
    },
  };

  const work = config.conventions
    ? withConventions(plainWork, {
      client, scope, whoami: () => info.whoami(), now, bodySha: (id) => bodyShas.get(id),
      // The next instance that sees a stale claim label removes it (with writes on).
      ...(config.allowWrites ? { staleClaimLabel: (id: string, label: string) => removeLabels(workRef(scope, Number(id)), [label]) } : {}),
    })
    : plainWork;

  // --- changes ---

  async function toChange(pull: RestPull): Promise<{ change: Change; unchanged: boolean }> {
    const [reviews, checks] = await Promise.all([
      client.list<RestReview>(r(`/pulls/${pull.number}/reviews?per_page=100`)),
      client.list<RestCheckRun>(r(`/commits/${pull.head.sha}/check-runs?per_page=100`), { key: "check_runs" }),
    ]);
    return { change: pullToChange(scope, pull, reviews.data, checks.data), unchanged: reviews.unchanged && checks.unchanged };
  }

  async function getChange(ref: Ref): Promise<Change | null> {
    try {
      const pull = (await client.get<RestPull>(r(`/pulls/${ref.id}`))).data;
      return (await toChange(pull)).change;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  const changes: ChangePort = {
    // The pulls list has no `since`, and reviews and checks do not touch a pull's `updated_at`. So every
    // listing asks for each open pull's reviews and checks conditionally (free when nothing changed) and
    // returns the pulls where something differs from the cursor.
    async listChanges(since) {
      const before = parseChangeCursor(since);
      const got = await client.list<RestPull>(r("/pulls?state=open&sort=created&direction=asc&per_page=100"));
      const detailed = await pool(got.data, concurrency, toChange);
      const open: Record<string, string> = {};
      const items: Change[] = [];
      got.data.forEach((pull, index) => {
        open[String(pull.number)] = pull.updated_at;
        const detail = detailed[index];
        if (detail && (!before || before[String(pull.number)] !== pull.updated_at || !detail.unchanged)) items.push(detail.change);
      });
      // Pulls that left the open list were merged or closed: fetch each once for its final state.
      const removed: Ref[] = [];
      const left = Object.keys(before ?? {}).filter((number) => !(number in open));
      for (const number of left) {
        const ref = changeRef(scope, Number(number));
        const change = await getChange(ref);
        if (change) items.push(change);
        else removed.push(ref);
      }
      const page: Page<Change> = { items, cursor: JSON.stringify({ open }) };
      if (removed.length) page.removed = removed;
      if (before && items.length === 0 && removed.length === 0) page.unchanged = true;
      return page;
    },
    getChange,
  };

  // --- CI ---

  async function toRuns(runs: RestWorkflowRun[], withJobs: boolean): Promise<Run[]> {
    if (!withJobs) return runs.map((run) => runToRun(scope, run));
    return pool(runs, concurrency, async (run) => {
      const jobs = await client.list<RestJob>(r(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`), { key: "jobs" });
      return runToRun(scope, run, jobs.data);
    });
  }

  const listRuns = async (path: string, max: number): Promise<RestWorkflowRun[]> =>
    (await client.list<RestWorkflowRun>(r(path), { key: "workflow_runs", max })).data;

  const ci: GitHubHost["ci"] = {
    async runsFor(sha) {
      const runs = await listRuns(`/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`, 100);
      return toRuns(runs, jobDetail === "all");
    },

    async recentRuns(pipeline, limit) {
      const workflows = await client.list<RestWorkflow>(r("/actions/workflows?per_page=100"), { key: "workflows" });
      const workflow = workflows.data.find((candidate) => candidate.name === pipeline);
      if (!workflow || limit < 1) return [];
      const runs = await listRuns(`/actions/workflows/${workflow.id}/runs?status=completed&per_page=${Math.min(100, limit)}`, limit);
      return toRuns(runs, jobDetail === "all");
    },

    async activeRuns() {
      const lists = await Promise.all(
        ["queued", "in_progress"].map((status) => listRuns(`/actions/runs?status=${status}&per_page=100`, 300)),
      );
      // A run can move from one list to the other between the two requests.
      const byId = new Map<number, RestWorkflowRun>();
      for (const run of lists.flat()) if (run.status !== "completed") byId.set(run.id, run);
      const runs = await toRuns([...byId.values()], jobDetail !== "none");
      const working = new Map<string, Ref>();
      for (const run of runs) if (run.runner && run.status === "running") working.set(run.runner, run.ref);
      runnerWork = working;
      return runs;
    },

    // Listing runners needs admin rights on the repository. Without them: no runners, and no more asking.
    async runners() {
      if (runnersForbidden) return [];
      try {
        const list = await client.list<RestRunner>(r("/actions/runners?per_page=100"), { key: "runners" });
        return list.data.map((runner) => runnerToRunner(runner, runnerWork.get(runner.name)));
      } catch (error) {
        if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) {
          runnersForbidden = true;
          capabilities.delete("runners");
          return [];
        }
        throw error;
      }
    },
  };

  // --- watch ---

  // Three one-item lists, newest first: a changed ETag means something of that kind changed.
  const probes: { path: string; hint: string; subject(body: unknown): Ref | undefined }[] = [
    {
      path: r("/issues?state=all&sort=updated&direction=desc&per_page=1"),
      hint: "work",
      subject: (body) => {
        const issue = (body as RestIssue[])[0];
        if (!issue) return undefined;
        return issue.pull_request ? changeRef(scope, issue.number) : workRef(scope, issue.number);
      },
    },
    {
      path: r("/pulls?state=all&sort=updated&direction=desc&per_page=1"),
      hint: "changes",
      subject: (body) => {
        const pull = (body as RestPull[])[0];
        return pull ? changeRef(scope, pull.number) : undefined;
      },
    },
    {
      path: r("/actions/runs?per_page=1"),
      hint: "ci",
      subject: (body) => {
        const run = (body as { workflow_runs?: RestWorkflowRun[] }).workflow_runs?.[0];
        return run ? { host: scope.host, kind: "run", id: String(run.id) } : undefined;
      },
    },
  ];

  const seen = new Set<string>();
  async function probe(): Promise<HostEvent[]> {
    const events: HostEvent[] = [];
    for (const { path, hint, subject } of probes) {
      const got = await client.get<unknown>(path);
      // The first answer is the baseline, not a change.
      if (seen.has(path) && !got.unchanged) {
        const event: HostEvent = { at: new Date(now()).toISOString(), hint };
        const ref = subject(got.data);
        if (ref) event.subject = ref;
        events.push(event);
      }
      seen.add(path);
    }
    return events;
  }

  // --- writes: only with `allowWrites` ---

  /** The link takes the child's database id, not its number. */
  async function linkSubIssue(parent: Ref, childId: number): Promise<void> {
    await client.send("POST", r(`/issues/${parent.id}/sub_issues`), { sub_issue_id: childId });
  }
  const refLabelOf = (work: Ref): string => `#${work.id}`;

  /** Labels known to exist in the repository, so each is created at most once per run. */
  const knownLabels = new Set<string>();
  /** `anyName`: a label a project chose (the AI label): made with a plain look when it is not one of Scope Soup's own. */
  async function ensureLabel(name: string, anyName = false): Promise<void> {
    const look = LABEL_LOOKS[name] ?? (anyName ? { color: "ededed", description: "Added by Scope Soup" } : undefined);
    if (!look || knownLabels.has(name)) return;
    try {
      await client.send("POST", r("/labels"), { name, ...look });
      config.onLabelCreated?.(name);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422 && error.message.includes("already_exists"))) throw error;
    }
    knownLabels.add(name);
  }

  async function removeLabels(subject: Ref, remove: string[]): Promise<void> {
    for (const name of remove) {
      try {
        await client.send("DELETE", r(`/issues/${subject.id}/labels/${encodeURIComponent(name)}`));
      } catch (error) {
        if (!(error instanceof GitHubError && error.status === 404)) throw error;
      }
    }
  }

  const repoLabels = async (): Promise<string[]> => (await client.list<{ name: string }>(r("/labels?per_page=100"))).data.map((label) => label.name);
  /** The repository's labels with their descriptions, for the triage. */
  const labelInfo = async (): Promise<RepoLabel[]> =>
    (await client.list<RestLabel>(r("/labels?per_page=100"))).data.map((label) => ({ name: label.name, ...(label.description?.trim() ? { description: label.description.trim() } : {}) }));

  const reread = async (subject: Ref): Promise<RestIssue> => (await client.get<RestIssue>(r(`/issues/${subject.id}`))).data;

  /** An issue's database id, which the dependency calls take; an issue of another repository (`owner/name#N`) too. */
  async function databaseId(ref: Ref): Promise<number> {
    const other = /^([^/#]+\/[^/#]+)#(\d+)$/.exec(ref.id);
    if (!other && !/^\d+$/.test(ref.id)) throw new Error(`${ref.id} is not an issue on GitHub.`);
    const path = other ? `/repos/${other[1]}/issues/${other[2]}` : r(`/issues/${ref.id}`);
    return (await client.get<RestIssue>(path)).data.id;
  }

  /**
   * Makes the issue's open blockers on GitHub `wanted`, as issue dependencies: a `blocked_by` call for each one missing,
   * a DELETE for each open one not wanted. A closed blocker is left as it is. Returns what the re-read must show. `addOnly`
   * (a triage) never sends a DELETE, so a dependency someone added meanwhile cannot be lost.
   */
  async function setBlockers(subject: Ref, wanted: Ref[], addOnly = false): Promise<{ add: Map<number, string>; remove: Map<number, string> }> {
    const have = new Map((await dependencies(subject.id, "blocked_by")).map((issue) => [refKey(issueRef(issue)), issue]));
    const wantedKeys = new Set(wanted.map(refKey));
    const add = new Map<number, string>();
    const remove = new Map<number, string>();
    for (const blocker of wanted) {
      if (blocker.id === subject.id || have.has(refKey(blocker)) || [...add.values()].includes(blocker.id)) continue;
      add.set(await databaseId(blocker), blocker.id);
    }
    if (!addOnly) for (const [key, issue] of have) if (issue.state === "open" && !wantedKeys.has(key)) remove.set(issue.id, issueRef(issue).id);
    for (const id of add.keys()) await client.send("POST", r(`/issues/${subject.id}/dependencies/blocked_by`), { issue_id: id });
    for (const id of remove.keys()) await client.send("DELETE", r(`/issues/${subject.id}/dependencies/blocked_by/${id}`));
    return { add, remove };
  }

  /** What the re-read of the issue's blockers does not show of `planned`. */
  async function blockersNotApplied(subject: Ref, planned: { add: Map<number, string>; remove: Map<number, string> }): Promise<string[]> {
    if (planned.add.size === 0 && planned.remove.size === 0) return [];
    const ids = new Set((await dependencies(subject.id, "blocked_by")).map((issue) => issue.id));
    return [
      ...[...planned.add].filter(([id]) => !ids.has(id)).map(([, name]) => `blocked by #${name} not added`),
      ...[...planned.remove].filter(([id]) => ids.has(id)).map(([, name]) => `blocked by #${name} not removed`),
    ];
  }

  /** Without push access GitHub answers 200 and drops labels and assignees silently [docs]: the re-read says whether they took. */
  function notApplied(issue: RestIssue, labels: { add: string[]; remove: string[] }, assignees: { add: string[]; remove: string[] } = { add: [], remove: [] }): string[] {
    const names = labelNames(issue.labels);
    const logins = (issue.assignees ?? []).map((user) => user.login.toLowerCase());
    return [
      ...labels.add.filter((name) => !hasLabel(names, name)).map((name) => `label ${name} not added`),
      ...labels.remove.filter((name) => hasLabel(names, name)).map((name) => `label ${name} not removed`),
      ...assignees.add.filter((login) => !logins.includes(login.toLowerCase())).map((login) => `assignee ${login} not added`),
      ...assignees.remove.filter((login) => logins.includes(login.toLowerCase())).map((login) => `assignee ${login} not removed`),
    ];
  }

  const failIf = (subject: Ref, missed: string[]): void => {
    if (missed.length > 0) throw new Error(`GitHub answered but did not apply it on #${subject.id} (${missed.join("; ")}). Labels, assignees and dependencies need push access.`);
  };

  /** The issue's comments (the path the conventions layer lists too, so they share one ETag) and its questions and answers. */
  async function threadOf(subject: Ref): Promise<{ comments: RestComment[]; self: string | null; thread: ReturnType<typeof readThread> }> {
    let self: string | null;
    try {
      self = (await info.whoami()).id.toLowerCase();
    } catch {
      self = null;
    }
    const comments = (await client.list<RestComment>(r(`/issues/${subject.id}/comments?per_page=100`))).data;
    return { comments, self, thread: readThread(subject, comments, self) };
  }

  /** The needs-decision label on, before a question or draft is posted; the re-read must show it. */
  async function addNeedsDecision(subject: Ref): Promise<void> {
    await ensureLabel(NEEDS_DECISION_LABEL);
    await client.send("POST", r(`/issues/${subject.id}/labels`), { labels: [NEEDS_DECISION_LABEL] });
    failIf(subject, notApplied(await reread(subject), { add: [NEEDS_DECISION_LABEL], remove: [] }));
  }

  /**
   * Once the Item no longer waits for an answer (`waitsForAnswer`: no question open, no draft waiting for Accept, Edit
   * or Reject), the needs-decision label goes; the re-read must show it gone.
   */
  async function settleQuestions(subject: Ref, thread: ReturnType<typeof readThread>): Promise<void> {
    if (waitsForAnswer(thread)) return;
    const label = hasLabel(labelNames((await reread(subject)).labels), NEEDS_DECISION_LABEL);
    if (!label) return;
    await removeLabels(subject, [label]);
    failIf(subject, notApplied(await reread(subject), { add: [], remove: [label] }));
  }

  /**
   * The answers in one comment, after a fresh look that each question is still open (or, with `proposal`, that
   * the draft waits); the re-read must count each as its question's answer. Nothing is posted when one of them is refused.
   */
  async function answerQuestions(subject: Ref, entries: readonly { to: string | null; answer: AnswerWrite }[]): Promise<{ open: number }> {
    if (entries.length === 0) throw new Error(`No answer to post on #${subject.id}.`);
    const { comments, self, thread } = await threadOf(subject);
    const numbered = entries.map(({ to, answer: given }) => {
      if (to === null) return { to: null, given };
      if (thread.answers.some((answer) => answer.to === to)) throw new AlreadyAnswered(`Question ${to} on #${subject.id} has an answer already.`);
      // A person's decision on a triage draft answers the draft comment.
      const draft = given.proposal !== undefined && thread.drafts.some((each) => each.id === to && !each.answered);
      if (!draft && !thread.openQuestions.some((question) => question.id === to)) throw new Error(`There is no open question ${to} on #${subject.id} (it may have been deleted).`);
      const n = questionNumber(comments.find((comment) => String(comment.id) === to));
      return { to: Number(to), ...(n ? { n } : {}), given };
    });
    // The answer names the person who gave it on the board; the account that writes it is Scope Soup's.
    const by = entries.find((each) => each.answer.by)?.answer.by ?? (self !== null ? (await info.whoami()).id : "someone");
    await client.send("POST", r(`/issues/${subject.id}/comments`), { body: answersBody(numbered, by) });
    const after = (await threadOf(subject)).thread;
    for (const { to, answer: given } of entries) {
      if (to === null) continue;
      const counted = after.answers.find((answer) => answer.to === to);
      if (!counted) throw new Error(`GitHub took the answer to question ${to} on #${subject.id}, but it does not show as the answer.`);
      if (counted.answer !== given.answer.trim()) throw new AlreadyAnswered(`Question ${to} on #${subject.id} was answered by someone else meanwhile: ${counted.answer}`);
    }
    await settleQuestions(subject, after);
    return { open: after.openQuestions.length };
  }

  /**
   * Scope Soup's log comment written with `lines`: edited in place (an edit notifies nobody), or posted with the first write. The
   * answer must carry the new marker. `keep` goes with it.
   */
  async function writeLog(subject: Ref, old: Thread["log"], lines: LogLine[], keep: LogKeep): Promise<void> {
    const body = logBody(lines, old?.dropped ?? 0, keep);
    const sent = old
      ? await client.send<RestComment>("PATCH", r(`/issues/comments/${old.id}`), { body })
      : await client.send<RestComment>("POST", r(`/issues/${subject.id}/comments`), { body });
    if (!sent?.id || readMarker(sent.body)?.kind !== "log") throw new Error(`GitHub took the log line on #${subject.id} but does not show it.`);
  }

  /** The claim comments on the issue, read now. Without the token's login none can be trusted, so claims cannot be told. */
  async function claimsOf(subject: Ref): Promise<ReturnType<typeof readThread>["claims"]> {
    const { self, thread } = await threadOf(subject);
    if (self === null) throw new Error(`Scope Soup cannot claim #${subject.id}: the token does not say who it is, so no claim comment can be trusted.`);
    return thread.claims;
  }

  const write: WritePort = {
    /**
     * The claim comment (or, when this machine's claim is live already, that comment edited: a renewal), then the label;
     * then a fresh look, in which this claim must be the lowest live one. Otherwise it is edited to released and not won.
     * An assignee is a person's hold, and an earlier live claim another machine's: then nothing is written.
     */
    async claim(subject, { until, shown }) {
      const machine = claims!;
      const issue = await reread(subject);
      const person = issue.assignees?.[0]?.login;
      if (person) return { won: false, why: `held by ${person}` };
      const first = liveClaims(await claimsOf(subject), now())[0];
      if (first && first.machine !== machine) return { won: false, why: `held by scopesoup on ${first.machine}` };
      const body = claimBody(machine, shown, until, false);
      const sent = first
        ? await client.send<RestComment>("PATCH", r(`/issues/comments/${first.id}`), { body })
        : await client.send<RestComment>("POST", r(`/issues/${subject.id}/comments`), { body });
      if (!sent?.id || readMarker(sent.body)?.kind !== "claim") throw new Error(`GitHub took the claim on #${subject.id} but does not show it.`);
      const release = (): Promise<unknown> => client.send("PATCH", r(`/issues/comments/${sent.id}`), { body: claimBody(machine, shown, until, true) });
      if (!hasLabel(labelNames(issue.labels), CLAIMED_LABEL)) {
        try {
          await ensureLabel(CLAIMED_LABEL);
          await client.send("POST", r(`/issues/${subject.id}/labels`), { labels: [CLAIMED_LABEL] });
          failIf(subject, notApplied(await reread(subject), { add: [CLAIMED_LABEL], remove: [] }));
        } catch (error) {
          // A claim without its label is no claim on the board: the comment lets go too.
          await release();
          throw error;
        }
      }
      const winner = liveClaims(await claimsOf(subject), now())[0];
      if (winner?.id === sent.id) return { won: true };
      await release();
      return { won: false, why: winner ? `scopesoup on ${winner.machine} claimed it first` : "the claim comment does not show" };
    },
    /** Each of this machine's claim comments not released yet is edited to released; the label goes when no claim is left. */
    async releaseClaim(subject, { shown }) {
      const machine = claims!;
      const all = await claimsOf(subject);
      for (const claim of all.filter((each) => !each.released && each.machine === machine)) {
        await client.send("PATCH", r(`/issues/comments/${claim.id}`), { body: claimBody(machine, shown, claim.until, true) });
      }
      if (liveClaims(all, now()).some((each) => each.machine !== machine)) return;
      const label = hasLabel(labelNames((await reread(subject)).labels), CLAIMED_LABEL);
      if (!label) return;
      await removeLabels(subject, [label]);
      failIf(subject, notApplied(await reread(subject), { add: [], remove: [label] }));
    },
    /**
     * The label first (a token without push access fails here, before anything is posted), then one comment per question,
     * numbered on from the issue's earlier questions (`Qn:`, never reused; nor a deleted one's, which the log comment keeps).
     * A comment over the limit (a large split) throws `TooLarge` before anything is written. A question still open with
     * the same text and draft is the one already posted (a retry after a post GitHub took before it failed): it is not posted
     * again. A failure that can change by itself is `WriteLater`.
     */
    async askQuestions(subject, questions) {
      try {
        const { comments, self, thread } = await threadOf(subject);
        const open = new Set(thread.openQuestions.map((question) => question.id));
        const taken = new Set<number>();
        const already = questions.map((question) => {
          const found = comments.find((comment) => {
            if (taken.has(comment.id) || !open.has(String(comment.id))) return false;
            const data = readMarker(comment.body)?.data ?? {};
            return data.question === question.question.trim() && data.draft === (question.draft ? Number(question.draft) : undefined);
          });
          if (found) taken.add(found.id);
          return found;
        });
        let next = nextQuestionNumber(comments, self, thread.log?.asked ?? 0);
        const numbers = already.map((found) => (found ? questionNumber(found) ?? 0 : next++));
        const bodies = questions.map((question, index) => (already[index] ? null : questionBody(numbers[index]!, question)));
        if (bodies.some((body) => body !== null && body.length > COMMENT_LIMIT)) throw new TooLarge(`A question on #${subject.id} is over ${COMMENT_LIMIT} characters.`);
        await addNeedsDecision(subject);
        const ids: string[] = [];
        let at = "";
        for (const [index, body] of bodies.entries()) {
          const found = already[index];
          const posted = body === null ? found! : await client.send<RestComment>("POST", r(`/issues/${subject.id}/comments`), { body });
          if (!posted?.id) throw new Error(`GitHub took question ${numbers[index]} on #${subject.id} but did not describe the comment.`);
          ids.push(String(posted.id));
          if (posted.created_at > at) at = posted.created_at;
        }
        return { ids, at, numbers };
      } catch (error) {
        throw later(error);
      }
    },
    /**
     * Questions deleted on GitHub: every other open question of Scope Soup's is edited to withdrawn (its marker keeps its
     * number), then the log comment keeps the deleted ones and the highest number used, so neither is asked or used again.
     */
    async withdrawQuestions(subject, deleted) {
      const { comments, self, thread } = await threadOf(subject);
      const open = new Set(thread.openQuestions.map((question) => question.id));
      for (const comment of comments) {
        const marker = readMarker(comment.body);
        if (!open.has(String(comment.id)) || marker?.kind !== "question") continue;
        const sent = await client.send<RestComment>("PATCH", r(`/issues/comments/${comment.id}`), { body: withdrawnBody(marker.data) });
        if (readMarker(sent?.body)?.data.withdrawn !== true) throw new Error(`GitHub took the withdrawal of question comment ${comment.id} on #${subject.id} but does not show it.`);
      }
      const old = thread.log;
      const have = old?.deleted ?? [];
      const add = deleted.filter((each) => !have.some((one) => one.question === each.question && one.n === each.n));
      const asked = Math.max(nextQuestionNumber(comments, self, old?.asked ?? 0) - 1, ...deleted.map((each) => each.n ?? 0));
      if (add.length === 0 && asked === (old?.asked ?? 0)) return;
      const lines = (old?.lines ?? []).map(({ at, kind, fields }) => ({ at, kind, fields }));
      await writeLog(subject, old, lines, { asked, deleted: [...have, ...add.map((each) => ({ question: each.question, ...(each.n ? { n: each.n } : {}) }))] });
    },
    /** The answer comment, after a fresh look that the question is still open; the re-read must count it as the answer. */
    async answerQuestion(subject, to, given) {
      return answerQuestions(subject, [{ to, answer: given }]);
    },
    /** Several answers in one comment (`answersBody`); every question is checked first, and the re-read must count each. */
    answerQuestions: (subject, entries) => answerQuestions(subject, entries),
    /**
     * The draft comment, with the hash of the issue's body as read now; over the limit it throws `TooLarge` and posts nothing.
     * The same draft already there and unanswered (a retry after a post GitHub took before it failed) is not posted again. A
     * failure that can change by itself is `WriteLater`. A draft waits for an answer even with no question, so the
     * needs-decision label goes on first (a token without push access fails here, before anything is posted).
     */
    async postDraft(subject, draft) {
      try {
        const bodySha = sha256((await reread(subject)).body ?? "");
        const body = draftBody(draft.round, draft.draft, bodySha, draft.labels);
        if (body.length > COMMENT_LIMIT) throw new TooLarge(`The rewrite for #${subject.id} is over ${COMMENT_LIMIT} characters.`);
        await addNeedsDecision(subject);
        const same = (await threadOf(subject)).thread.drafts.find((each) => !each.answered && each.round === draft.round && each.bodySha === bodySha && each.text === draft.draft.trim() && changeText(each.labels) === changeText(draft.labels));
        if (same) return { id: same.id, at: same.at };
        const posted = await client.send<RestComment>("POST", r(`/issues/${subject.id}/comments`), { body });
        if (!posted?.id) throw new Error(`GitHub took the draft on #${subject.id} but did not describe the comment.`);
        return { id: String(posted.id), at: posted.created_at };
      } catch (error) {
        throw later(error);
      }
    },
    /** The draft comment is there and unanswered, and the issue's body is still the one it read. */
    async checkDraft(subject, id) {
      const { thread } = await threadOf(subject);
      const draft = thread.drafts.find((each) => each.id === id);
      if (!draft) throw new Error(`The draft comment ${id} on #${subject.id} is gone (it may have been deleted).`);
      if (draft.answered) throw new AlreadyAnswered(`The rewrite of round ${draft.round} on #${subject.id} has an answer already.`);
      if (sha256((await reread(subject)).body ?? "") !== draft.bodySha) throw new BodyChanged(`The description of #${subject.id} changed on GitHub since the rewrite of round ${draft.round} was written.`);
    },
    /**
     * One line more in Scope Soup's log comment on the issue: posted with the first line, then edited in place (an edit
     * notifies nobody). Two calls: the comments (conditional, the ETag the conventions layer shares), then POST or PATCH, whose
     * answer must carry the new marker. Over the comment limit the oldest lines are dropped and counted.
     */
    async logLine(subject, line) {
      const { thread } = await threadOf(subject);
      const old = thread.log;
      const lines = [...(old?.lines ?? []).map(({ at, kind, fields }) => ({ at, kind, fields })), { at: new Date(now()).toISOString(), kind: line.kind, fields: clipLogFields(line.kind, line.fields) }];
      await writeLog(subject, old, lines, { asked: old?.asked ?? 0, deleted: old?.deleted ?? [] });
    },
    async settleQuestions(subject) {
      await settleQuestions(subject, (await threadOf(subject)).thread);
    },
    /**
     * The label first (a token without push access fails here, before anything is posted), then one comment with the
     * decisions; the answer must carry the marker. Over the comment limit it throws `TooLarge` and posts nothing.
     */
    async postAssumptions(subject, decisions) {
      const body = assumptionBody(decisions);
      if (body.length > COMMENT_LIMIT) throw new TooLarge(`The decisions on #${subject.id} are over ${COMMENT_LIMIT} characters.`);
      await ensureLabel(ASSUMPTION_LABEL);
      await client.send("POST", r(`/issues/${subject.id}/labels`), { labels: [ASSUMPTION_LABEL] });
      failIf(subject, notApplied(await reread(subject), { add: [ASSUMPTION_LABEL], remove: [] }));
      const posted = await client.send<RestComment>("POST", r(`/issues/${subject.id}/comments`), { body });
      if (!posted?.id || readMarker(posted.body)?.kind !== "assumption") throw new Error(`GitHub took the decisions on #${subject.id} but does not show them.`);
      return { id: String(posted.id) };
    },
    /**
     * The verdicts of one Send go into their decisions' comments, each comment edited once in place (an edit notifies nobody;
     * the decisions of one implementor step share one comment), after one fresh look that every one is still open: one that is not
     * refuses them all before anything is written. The answer must carry them. Then the label goes once no decision is open.
     */
    async settleAssumptions(subject, settles) {
      const { comments, thread } = await threadOf(subject);
      const byComment = new Map<string, { comment: RestComment; marker: NonNullable<ReturnType<typeof readMarker>>; verdicts: ReturnType<typeof readVerdicts> }>();
      for (const { id, settled } of settles) {
        const found = thread.assumptions.find((each) => each.id === id);
        if (!found) throw new AlreadyAnswered(`There is no decision ${id} on #${subject.id} (its comment may have been deleted).`);
        if (found.settled) throw new AlreadyAnswered(`Decision ${id} on #${subject.id} is ${found.settled.verdict} already.`);
        const [commentId, n] = id.split("-");
        let entry = byComment.get(commentId!);
        if (!entry) {
          const comment = comments.find((each) => String(each.id) === commentId);
          const marker = readMarker(comment?.body);
          if (!comment || marker?.kind !== "assumption") throw new AlreadyAnswered(`The comment of decision ${id} on #${subject.id} is gone.`);
          entry = { comment, marker, verdicts: readVerdicts(marker.data.settled) };
          byComment.set(commentId!, entry);
        }
        if (entry.verdicts.some((each) => each.n === Number(n))) throw new AlreadyAnswered(`Decision ${id} on #${subject.id} is settled already.`);
        entry.verdicts.push({ n: Number(n), verdict: settled.verdict, at: settled.at, by: settled.by, ...(settled.answer ? { answer: settled.answer } : {}), ...(settled.item ? { item: settled.item.id } : {}), ...(settled.work ? { work: true as const } : {}) });
      }
      for (const { comment, marker, verdicts } of byComment.values()) {
        const decisions = (Array.isArray(marker.data.decisions) ? marker.data.decisions : []) as { question: string; chosen: string; others: string[]; why: string }[];
        const sent = await client.send<RestComment>("PATCH", r(`/issues/comments/${comment.id}`), { body: assumptionBody(decisions, verdicts) });
        if (readVerdicts(readMarker(sent?.body)?.data.settled).length !== verdicts.length) throw new Error(`GitHub took the verdicts on the decisions of #${subject.id} but does not show them.`);
      }
      const after = (await threadOf(subject)).thread;
      if (after.assumptions.some((each) => !each.settled)) return;
      const label = hasLabel(labelNames((await reread(subject)).labels), ASSUMPTION_LABEL);
      if (!label) return;
      await removeLabels(subject, [label]);
      failIf(subject, notApplied(await reread(subject), { add: [], remove: [label] }));
    },
    async comment(subject, markdown) {
      // Pull requests take their conversation comments through the issues endpoint too.
      await client.send("POST", r(`/issues/${subject.id}/comments`), { body: markdown });
    },
    /** With the conventions on, the comment carries the `merged` marker; then the close, which the re-read must show. */
    async closeWork(work, comment, merged) {
      await client.send("POST", r(`/issues/${work.id}/comments`), { body: merged && config.conventions ? mergedBody(comment, merged) : comment });
      await client.send("PATCH", r(`/issues/${work.id}`), { state: "closed", state_reason: "completed" });
      const after = await reread(work);
      failIf(work, after.state === "closed" ? [] : ["state not closed"]);
    },
    async closeChange(change, comment) {
      await client.send("POST", r(`/issues/${change.id}/comments`), { body: comment });
      const pull = (await client.get<RestPull>(r(`/pulls/${change.id}`))).data;
      if (pull.merged || pull.merged_at || pull.state === "closed") return;
      await client.send("PATCH", r(`/pulls/${change.id}`), { state: "closed" });
    },
    /** A draft's label changes: one POST per label to add, one DELETE per label to remove, never a full replace; then the re-read. */
    async changeLabels(subject, add, remove) {
      const have = labelNames((await reread(subject)).labels);
      const known = add.length > 0 ? await repoLabels() : [];
      const added = add.flatMap((name) => (hasLabel(have, name) ? [] : known.filter((each) => each.toLowerCase() === name.toLowerCase()).slice(0, 1)));
      const removed = remove.flatMap((name) => have.filter((each) => each.toLowerCase() === name.toLowerCase()).slice(0, 1));
      for (const name of added) await client.send("POST", r(`/issues/${subject.id}/labels`), { labels: [name] });
      await removeLabels(subject, removed);
      if (added.length > 0 || removed.length > 0) failIf(subject, notApplied(await reread(subject), { add: added, remove: removed }));
      return { added, removed };
    },
    async setLabels(subject, add, remove) {
      for (const name of add) await ensureLabel(name, true);
      if (add.length > 0) await client.send("POST", r(`/issues/${subject.id}/labels`), { labels: add });
      await removeLabels(subject, remove);
      if (add.length > 0 || remove.length > 0) failIf(subject, notApplied(await reread(subject), { add, remove }));
    },
    /** A new issue. The priority has no place on GitHub and is not kept; the caller says so. */
    async createWork(input) {
      for (const name of input.labels ?? []) await ensureLabel(name, true);
      const issue = await client.send<RestIssue>("POST", r("/issues"), {
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
        ...(input.assignees && input.assignees.length > 0 ? { assignees: input.assignees } : {}),
      });
      if (!issue) throw new Error("GitHub created the issue but did not describe it.");
      const work = workRef(scope, issue.number, issue.html_url);
      // The issue exists now: a failed link is reported, not thrown, so the caller keeps the issue and can link it again (`linkChild`).
      if (input.parent) {
        try {
          await linkSubIssue(input.parent, issue.id);
        } catch (error) {
          return { work, shared: "shared", conflict: false, linked: false, problem: `Created ${refLabelOf(work)} but could not link it under #${input.parent.id}: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      return { work, shared: "shared", conflict: false };
    },
    /**
     * Title, description, verification, state and priority, written through: the calls, then a re-read that must show
     * them. The body keeps everything but the part that changes; the caller has made new text inert. Labels outside
     * `scopesoup:*` and `priority:*` are never touched, and nobody is assigned: an assignee always means a person.
     * `blockedBy` is the open blockers wanted, written as issue dependencies (`setBlockers`).
     */
    async editWork(subject, patch) {
      const other = (["labels", "parent"] as const).filter((field) => patch[field] !== undefined);
      if (other.length > 0) throw new Error(`Scope Soup does not change the ${other.join(", ")} of a GitHub issue here.`);
      if (patch.duplicateOf && patch.state !== "abandoned") throw new Error(`#${subject.id}: a duplicate is closed as abandoned.`);
      const issue = await reread(subject);
      const labels = labelNames(issue.labels);
      const fields: Record<string, unknown> = {};
      const add: string[] = [];
      const remove: string[] = [];
      if (patch.title !== undefined && patch.title !== issue.title) fields.title = patch.title;
      if (patch.body !== undefined || patch.verification !== undefined) {
        const body = spliceBody(issue.body ?? "", { ...(patch.body !== undefined ? { description: patch.body } : {}), ...(patch.verification !== undefined ? { verification: patch.verification } : {}) });
        if (body !== (issue.body ?? "").trim()) fields.body = body;
      }
      if (patch.state !== undefined) {
        const open = issue.state === "open";
        if (patch.state === "done" || patch.state === "abandoned") {
          // A duplicate names its target by database id [docs: REST "Update an issue", `duplicate_issue_id`].
          const reason = patch.state === "done" ? "completed" : patch.duplicateOf ? "duplicate" : "not_planned";
          if (open || (issue.state_reason ?? "completed") !== reason) {
            Object.assign(fields, { state: "closed", state_reason: reason });
            if (patch.duplicateOf) fields.duplicate_issue_id = await databaseId(patch.duplicateOf);
          }
        } else if (patch.state === "waiting") {
          throw new Error(`#${subject.id}: waiting is not a state of a GitHub issue.`);
        } else {
          if (patch.state === "doing" && !issue.assignees?.length) {
            throw new Error(`#${subject.id} is doing on GitHub only while a person holds it (an assignee, from taking it) or an agent claims it; a state change assigns nobody.`);
          }
          if (!open) Object.assign(fields, { state: "open", state_reason: "reopened" });
          const claimed = hasLabel(labels, CLAIMED_LABEL);
          if (patch.state === "todo" && claimed) remove.push(claimed);
        }
      }
      if (patch.priority !== undefined) {
        const wanted = patch.priority ? `priority:${patch.priority}` : null;
        for (const label of labels) if (/^priority:/i.test(label) && label.toLowerCase() !== wanted) remove.push(label);
        if (wanted && !hasLabel(labels, wanted)) add.push(wanted);
      }
      if (Object.keys(fields).length > 0) await client.send("PATCH", r(`/issues/${subject.id}`), fields);
      for (const name of add) await ensureLabel(name);
      if (add.length > 0) await client.send("POST", r(`/issues/${subject.id}/labels`), { labels: add });
      await removeLabels(subject, remove);
      const planned = patch.blockedBy !== undefined ? await setBlockers(subject, patch.blockedBy) : null;
      const after = await reread(subject);
      const missed = notApplied(after, { add, remove });
      if (fields.state !== undefined && (after.state !== fields.state || (fields.state === "closed" && after.state_reason !== fields.state_reason))) missed.push(`state not ${String(fields.state)}`);
      if (planned) missed.push(...(await blockersNotApplied(subject, planned)));
      failIf(subject, missed);
      return { work: subject, shared: "shared", conflict: false };
    },
    /** A triage's blockers: only the missing dependencies are POSTed, never one DELETEd; then the re-read. */
    async addBlockers(subject, blockers) {
      failIf(subject, await blockersNotApplied(subject, await setBlockers(subject, blockers, true)));
      return { work: subject, shared: "shared", conflict: false };
    },
    async linkChild(parent, child) {
      const issue = (await client.get<RestIssue>(r(`/issues/${child.id}`))).data;
      if (issueRefFromUrl(scope, issue.parent_issue_url)?.id === parent.id) return;
      await linkSubIssue(parent, issue.id);
    },
    async setAssignees(work, add, remove) {
      if (add.length > 0) await client.send("POST", r(`/issues/${work.id}/assignees`), { assignees: add });
      if (remove.length > 0) await client.send("DELETE", r(`/issues/${work.id}/assignees`), { assignees: remove });
      if (add.length > 0 || remove.length > 0) failIf(work, notApplied(await reread(work), { add: [], remove: [] }, { add, remove }));
    },
    async openChange(input) {
      const owner = config.repo.split("/")[0] ?? "";
      const existing = async (): Promise<Ref | null> => {
        const open = await client.list<RestPull>(r(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}&per_page=5`));
        const pull = open.data[0];
        return pull ? changeRef(scope, pull.number, pull.html_url) : null;
      };
      const already = await existing();
      if (already) return already;
      try {
        const pull = await client.send<RestPull>("POST", r("/pulls"), { title: input.title, head: input.branch, base: input.target, body: input.body, draft: input.draft === true });
        if (!pull) throw new Error("GitHub created the pull request but did not describe it.");
        return changeRef(scope, pull.number, pull.html_url);
      } catch (error) {
        // Two writers at once: the other one won.
        const raced = error instanceof GitHubError && error.status === 422 ? await existing() : null;
        if (raced) return raced;
        throw error;
      }
    },
  };
  // The log comment is a convention: it is read back only with the conventions layer on. So are deleted questions.
  if (!config.conventions) {
    delete write.logLine;
    delete write.withdrawQuestions;
  }
  // Claims are comments with markers too, and each names this machine.
  if (!claims) {
    delete write.claim;
    delete write.releaseClaim;
  }
  if (config.allowWrites) capabilities.add("write");

  // --- the merge queue waits for the project's CI on a batch's commit ---

  const queueCi: QueueCiPort = {
    async openBatch(input) {
      const open = write.openChange;
      if (!open) throw new Error("This GitHub host cannot open pull requests.");
      try {
        return await open({ branch: input.branch, target: input.target, title: `Scope Soup mergeQueue: batch ${input.batch}`, body: batchBody(input) });
      } catch (error) {
        throw later(error);
      }
    },
    async checksOn(sha) {
      try {
        const [runs, status] = await Promise.all([
          client.list<RestCheckRun>(r(`/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`), { key: "check_runs" }),
          client.get<RestCombinedStatus>(r(`/commits/${encodeURIComponent(sha)}/status?per_page=100`)),
        ]);
        // The latest run of each name counts, as for a pull request's verdict; the combined status lists the latest of each context.
        const latest = new Map<string, RestCheckRun>();
        for (const run of runs.data) {
          const seen = latest.get(run.name);
          if (!seen || run.id > seen.id) latest.set(run.name, run);
        }
        const checks: ExternalCheck[] = [...latest.values()].map((run) => {
          const url = run.html_url ?? run.details_url ?? undefined;
          return {
            name: run.name, kind: "check-run", id: String(run.id),
            state: run.status !== "completed" ? "pending" : CHECK_GREEN.has(run.conclusion ?? "") ? "passed" : "failed",
            conclusion: run.status !== "completed" ? run.status : run.conclusion ?? "none",
            ...(url ? { url } : {}),
          };
        });
        for (const each of status.data.statuses ?? []) {
          checks.push({
            name: each.context, kind: "status", conclusion: each.state,
            state: each.state === "success" ? "passed" : each.state === "pending" ? "pending" : "failed",
            ...(each.target_url ? { url: each.target_url } : {}),
          });
        }
        return checks;
      } catch (error) {
        throw later(error);
      }
    },
    async checkLog(check, chars) {
      // A check run of GitHub Actions has its job's id; other apps' logs and statuses are not readable here.
      if (check.kind !== "check-run" || !check.id || !/^\d+$/.test(check.id)) return null;
      try {
        const text = (await client.text(r(`/actions/jobs/${check.id}/logs`))).trim();
        if (text === "") return null;
        return text.length > chars ? `...${text.slice(-chars)}` : text;
      } catch {
        return null;
      }
    },
    async cleanBatch(input) {
      // Only Scope Soup's own batch pull request: the batch branch as its head, the `batch` marker, opened by the token's login.
      if (!BATCH_BRANCH.test(input.branch)) throw new NotScopeSoups(`${input.branch} is not a batch branch of Scope Soup's mergeQueue.`);
      if (!/^\d+$/.test(input.change.id)) throw new NotScopeSoups(`${input.change.id} is not a pull request number.`);
      try {
        let pull: RestPull;
        try {
          pull = (await client.get<RestPull>(r(`/pulls/${input.change.id}`))).data;
        } catch (error) {
          if (notFound(error)) throw new NotScopeSoups(`Pull request ${input.change.id} is not on GitHub.`);
          throw error;
        }
        const self = (await info.whoami()).id.toLowerCase();
        if (pull.head.ref !== input.branch) throw new NotScopeSoups(`Pull request ${pull.number} comes from ${pull.head.ref}, not ${input.branch}.`);
        if (pull.user?.login.toLowerCase() !== self || readMarker(pull.body)?.kind !== "batch") {
          throw new NotScopeSoups(`Pull request ${pull.number} is not one Scope Soup opened: it has no batch marker from ${self}.`);
        }
        if (input.comment !== undefined) {
          if (pull.state === "open") {
            // A retry after the comment went through but the close did not: the comment is not posted twice.
            const comments = await client.list<RestComment>(r(`/issues/${pull.number}/comments?per_page=100`));
            const posted = comments.data.some((comment) => comment.user?.login.toLowerCase() === self && (comment.body ?? "").trim() === input.comment?.trim());
            if (!posted) await client.send("POST", r(`/issues/${pull.number}/comments`), { body: input.comment });
            await client.send("PATCH", r(`/pulls/${pull.number}`), { state: "closed" });
          }
        } else if (!(pull.merged ?? pull.merged_at)) {
          // Deleting the head of an open pull request would close it unmerged: wait until GitHub shows it merged.
          throw new WriteLater(`GitHub does not show pull request ${pull.number} as merged yet.`);
        }
        try {
          await client.send("DELETE", r(`/git/refs/heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`));
        } catch (error) {
          // Already gone (deleted by a person, or by an earlier try): done.
          if (!(error instanceof GitHubError && (error.status === 404 || error.status === 422))) throw error;
        }
      } catch (error) {
        throw later(error);
      }
    },
  };

  return {
    info,
    // The repository's labels, which the triage may propose.
    work: Object.assign(work, { labels: labelInfo }),
    changes,
    ci,
    ...(config.allowWrites ? { write, queueCi } : {}),
    watch: pollingWatch(probe, config.pollMs ?? 30_000, config.setTimer),
    async blocking(ref) {
      if (!/^\d+$/.test(ref.id)) return [];
      return (await dependencies(ref.id, "blocking")).filter((issue) => issue.state === "open").map(issueRef);
    },
    labels: repoLabels,
    repository: {
      // `GET /branches/<branch>` needs only read rights and says `protected`; the protection endpoint itself needs admin rights
      // and answers 404 for both "none" and "not allowed". Anything but a plain answer (403, 404, a rate limit, offline) is unknown.
      async branchProtected(branch) {
        try {
          const found = (await client.get<{ protected?: unknown }>(r(`/branches/${branch.split("/").map(encodeURIComponent).join("/")}`))).data;
          return typeof found.protected === "boolean" ? found.protected : null;
        } catch {
          return null;
        }
      },
    },
    stats: client.stats,
  };
}
