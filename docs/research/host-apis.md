# Host APIs for the board tool: GitHub, Bitbucket, Gerrit, Jira, Jenkins

Research date 2026-11-18. Model under test: Work item, Change with revisions, Verdict per dimension
(review / risk / CI), Batch of changes under test, Turn (who acts next).

Marking: **[V]** = checked against the vendor's documentation in this session (source in section 10).
**[U]** = unverified here: from memory of the API, a secondary source, or not checked against the current docs.
Anything without a mark in the host sections should be read as [U].

---

## 1. GitHub

**Auth for a server process**
- Fine-grained PAT: simplest for one personal account; per-repo permissions (Issues, Pull requests, Contents,
  Actions, Metadata; Administration read for runners [U]). Acts as the owner, so comments and labels appear as the
  owner, and the "only trust the queue's own comments" rule needs care. Cannot create check runs (Apps only) [U].
  Shares the user's 5,000/h bucket with every other token of that user [V].
- GitHub App (can be private, owned by and installed on a personal account [U]): own bot identity, own rate bucket
  (min 5,000/h per installation, scaling to 12,500 outside Enterprise Cloud) [V], 1-hour installation tokens minted
  from a private key (JWT), fine permissions, can write check runs. Its webhook needs a reachable URL but is
  optional. Best choice once the tool performs writes.
- `GITHUB_TOKEN` (inside Actions only): 1,000/h per repo [V].
- Classic PAT (`repo` scope) works everywhere, coarse.

**Reading**
- Items: `GET /repos/{r}/issues` with `since`, `labels`, `state`; `sub_issues_summary` and
  `issue_dependencies_summary` in the object; lists at `/issues/{n}/sub_issues`,
  `/issues/{n}/dependencies/blocked_by` and `/blocking` [V]. Issue types and Projects fields exist too.
- Changes: `GET /pulls`, `/pulls/{n}`. A revision is the head SHA; there is no first-class revision list (force
  pushes appear in the timeline as `head_ref_force_pushed` events [U]). Reviews: `GET /pulls/{n}/reviews`, each with
  `state` (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED) and **`commit_id`**, so an approval can be tied to a
  revision by the adapter. GitHub itself keeps an approval across pushes unless branch protection dismisses stale
  reviews [U]. `mergeable_state`, `draft`, requested reviewers.
- CI per revision: `GET /commits/{sha}/check-runs` (Checks) and `/commits/{sha}/status` (legacy statuses); runs
  `GET /actions/runs?head_sha=`, `/actions/workflows/{wf}/runs`; jobs and steps with `started_at`/`completed_at`.
  Run history gives durations for estimates; `/actions/runs/{id}/timing` exists for billable time [U]. There is no
  progress or estimate field: compute from past runs and the current step.
- Runners: `GET /repos/{r}/actions/runners` returns `status` (online/offline), `busy`, `labels`; needs admin
  access to the repo [V] (org-level endpoint for org runners). Which job a runner is on: `runner_name` in the job
  object [U].

**Change notification without a public URL**
- Webhooks need GitHub to reach an HTTPS URL. `gh webhook forward` (extension `cli/gh-webhook`) forwards
  repo/org webhooks over an outbound connection to localhost, but is "only designed for use during testing and
  development", one user per repo [V]. smee.io: same, "should not use ... in production" [V].
- Options that work on a tailnet: (a) polling with ETags; (b) Tailscale Funnel or a Cloudflare tunnel exposing only
  the webhook path [U]; (c) the pattern the repo already uses: a workflow on the self-hosted runner reacts to the
  event and calls the board on the LAN (the runner is inside the network). (c) is the cheapest push path here.
- Polling: a conditional request that returns 304 does not count against the primary limit when sent with
  authorization [V]. An installation token changes hourly; whether ETags survive that is disputed (github/docs issue
  34689) [U]. The repo events feed (`GET /repos/{r}/events`, `X-Poll-Interval`) is delayed and no longer complete
  enough to drive a board [U].
- GraphQL: one query can return all open PRs with reviews, labels and `statusCheckRollup`; separate budget of
  5,000 points/h and 2,000 points/min secondary [V]. Fine from a LAN server; not from the cloud-session proxy.

**Rate limits and cost at ~40 PRs/day**
- Primary 5,000/h; secondary 900 points/min for REST (GET = 1, writes = 5), 100 concurrent, 80 content-creating
  requests/min and 500/h; wait 1 s between writes [V].
- Estimate: every 30 s poll open PRs, open issues (1 to 3 pages), workflow runs, runners, log-issue comments, master
  ref: about 8 requests, 960/h worst case, mostly free 304s. Per changed PR: reviews + check-runs + jobs, about 3
  requests; 40 PRs/day with about 10 updates each is roughly 1,200 requests per day. Well inside one PAT. Claims
  cost one comments call per claimed issue; cache by issue `updated_at`.

**Writes**: comment (`POST /issues/{n}/comments`), labels, issue state, review approve
(`POST /pulls/{n}/reviews` `event: APPROVE`; not on your own PR), merge (`PUT /pulls/{n}/merge` with
merge/squash/rebase), true fast-forward only by `PATCH /git/refs/heads/{branch}` with `force: false` (what the queue
does), `POST /actions/workflows/{wf}/dispatches`. With API version 2026-03-10 the dispatch returns 200 with
`workflow_run_id`, `run_url`, `html_url` [V]; the current code pins 2022-11-28 and finds the run by branch and SHA
(whether the old version still answers 204 is [U]). Re-run: `POST /actions/runs/{id}/rerun` [U].

**Mismatches**: PRs are issues (shared numbers, labels, comments). No revision object. Review state is per
reviewer, not per dimension; no numeric votes. Native merge queue (`merge_group` event, `gh-readonly-queue/*`
branches) exists but not for personal-account private repos [U]. A tool that keeps verdicts as labels and the batch as a
comment makes its GitHub adapter really a "GitHub + project conventions" adapter; keep the convention layer separate
from the host layer.

**The [known] facts of `docs/github-mapping.md` (checked 2026-11-22)**

No test repository was used: each fact is confirmed by a docs.github.com page, or marked "unconfirmed: needs a test repository".
- A 304 to a conditional request is free: **confirmed** [V]. It does not count against the primary rate limit when the request carried a correct `Authorization` header (REST best practices).
- Secondary limits on content creation, about 80 a minute and 500 an hour: **confirmed** [V], "no more than 80 content-generating requests per minute and no more than 500 ... per hour"; some endpoints have lower limits (REST rate limits).
- At most 100 sub-issues per parent and 8 levels: **confirmed** [V] (Adding sub-issues).
- The timeline event `marked_as_duplicate` names the target: **corrected** [V]. The event exists ("marked an issue as a duplicate of another issue"), but its documented properties are only the common ones (`actor`, `created_at`, ...): it does not name the other issue. The timeline's `cross-referenced` event may; unconfirmed: needs a test repository.
- REST does not give the body edit history: the docs show no edit event and no earlier body on the issue or timeline [V], which agrees; unconfirmed: needs a test repository.
- A comment bumps the issue's `updated_at`: unconfirmed: needs a test repository. The docs do not say. Scope Soup does not rely on it: an issue whose Scope Soup comments changed is fetched when the issue listing did not return it.
- Title at most 256 characters: unconfirmed: needs a test repository.
- Body at most 65,536 characters: unconfirmed: needs a test repository.
- Also read [V]: `GET /repos/{r}/issues/comments` takes `sort` (`created` default, or `updated`), `direction` (ignored without `sort`), `since` ("last updated after the given time") and `per_page` up to 100; each comment carries `author_association` and `issue_url`. The listing does not show deleted comments (from the design, not in the docs; unconfirmed: needs a test repository).
- Issue dependencies, read [V] (REST "Issue dependencies"): `POST /repos/{r}/issues/{issue_number}/dependencies/blocked_by` with body `{issue_id}` (integer, required, "the id of the issue that blocks the current issue") answers 201 with an issue; `DELETE /repos/{r}/issues/{issue_number}/dependencies/blocked_by/{issue_id}` (no body) answers 200 with an issue; `GET .../dependencies/blocked_by` and `GET .../dependencies/blocking` list issues, `per_page` up to 100. Errors: 301, 403, 404, 410, and 422 for the POST. Both writes may meet secondary rate limits. The page does not say outright that `issue_id` is the database `id` and not the number; the integer type and the sub-issue calls agree that it is (unconfirmed: needs a test repository).
- Closing as a duplicate, read [V] (REST "Update an issue", `PATCH /repos/{r}/issues/{issue_number}`): `state_reason` "Can be one of: `completed`, `not_planned`, `duplicate`, `reopened`, `null`" and is ignored unless `state` changes. `duplicate_issue_id` (integer, not required) is "The ID of the issue that this issue duplicates, used when marking this issue as a duplicate with status: Duplicate or state_reason: duplicate. The issue must exist and be accessible to the authenticated user." The `status` parameter says "Changing the status to Duplicate requires duplicate_issue_id"; what `state_reason: "duplicate"` without it does is not said (unconfirmed: needs a test repository). "ID" is read as the database `id`, as for `issue_id` above. The issue object still names no target, so Scope Soup writes it in its log comment as a `duplicate` line.
- The `reopened` event, read [V]: the issue event types page lists it ("The issue or pull request was reopened."). Scope Soup reads it from the timeline (`GET /repos/{r}/issues/{issue_number}/timeline`), as the design says: the per-issue events listing's response schema does not list a reopened type, and neither page states the order, so Scope Soup takes the newest `created_at` of the `reopened` events.

---

## 2. Bitbucket Cloud (and Data Center)

**Auth**
- App passwords are gone: no new ones since 2025-09-09, brownouts from 2026-06-09, disabled 2026-07-28 (secondary
  sources) [U].
- API token (Atlassian account email + token, Basic; scoped, with expiry): the personal-account option [U].
- Access tokens (Bearer [U]): repository tokens on any plan; project and workspace tokens Premium only; not tied to
  a user; 25 per repo [V]. They act as a bot user; whether they can approve is not documented [U].
- OAuth 2.0 consumer (client credentials or auth code) [U]. Forge for apps.

**Reading**
- Issues: the built-in tracker is per repo, off by default, and little used; Atlassian points to Jira. No
  dependencies, no labels (it has kind, priority, component, milestone) [U]. In practice work items come from Jira.
- PRs: `GET /2.0/repositories/{ws}/{repo}/pullrequests?state=OPEN`, with `q=updated_on > ...` and `fields=` partial
  responses [U]. `participants[] {role, approved, state: approved|changes_requested, participated_on}`. **No labels
  on PRs.** A revision is `source.commit.hash`; history only via `/pullrequests/{id}/activity`. An approval is on
  the PR, not on a commit; "reset approvals when the source branch changes" is a branch restriction [U].
- CI: commit statuses `GET /commit/{sha}/statuses` (`key`, `state: INPROGRESS|SUCCESSFUL|FAILED|STOPPED`, `url`),
  also `/pullrequests/{id}/statuses`. Pipelines: `GET /pipelines/?sort=-created_on` with `state`, `created_on`,
  `completed_on`, `duration_in_seconds`, `build_seconds_used`, and `/pipelines/{uuid}/steps/` [U].
- Runners: `/workspaces/{ws}/pipelines-config/runners` and the repo-level equivalent, state ONLINE/OFFLINE [U].
- Merge queues: GA on Standard and Premium, needs Pipelines, not for forks [V]; there is a REST group
  "merge-queues" (page exists, content not readable in this session) [U].

**Notification**: repo webhooks (`pullrequest:created|updated|approved|unapproved|fulfilled|rejected`,
`repo:push`, `repo:commit_status_created|updated`), HTTPS target reachable from Atlassian, few retries [U]. No
forwarding tool, no documented ETag support [U]. On a tailnet: poll, or a tunnel.

**Rate limits**: `/2.0/repositories/*` 1,000 requests per rolling hour per user; scaled up to 10,000 only for
access tokens in paid workspaces with 100+ users; webhooks API 1,000/h [V]. Polling 4 calls every 30 s is 480/h:
workable but half the budget, so use `updated_on` filters and `fields`, and poll every 60 s.

**Writes**: PR comment (`POST /pullrequests/{id}/comments`), approve / unapprove
(`POST|DELETE /pullrequests/{id}/approve`), request changes, merge (`POST /pullrequests/{id}/merge` with
`merge_strategy: merge_commit|squash|fast_forward|...`), build status (`POST /commit/{sha}/statuses/build`),
trigger a pipeline (`POST /pipelines/` with a target and a custom selector and variables) [U]. No label write.

**Data Center differences** [U unless marked]: REST 1.0 under `/rest/api/latest/projects/{key}/repos/{slug}/...`,
different shapes throughout. HTTP access tokens (personal, project, repository) as Bearer. Reviewers have
`status: APPROVED|NEEDS_WORK|UNAPPROVED` and `lastReviewedCommit`, so an approval is tied to a revision. Build
status per commit comes from external CI (Jenkins, Bamboo); no Pipelines, no runners. No issues at all. Webhooks
can target a LAN URL because the server is inside the network. Rate limiting is an admin-set token bucket per user.
Recent versions have merge queues (documentation page exists) [V, version not checked].

**Mismatches**: no work items in practice; no labels on PRs (state must live in comments, title prefixes, build
statuses or the tool's own store); approval not tied to a revision on Cloud; native merge queue with its own API,
so "Batch" would be read from the host instead of from comments; tasks on PRs have no counterpart.

---

## 3. Gerrit

**Auth**: HTTP Basic with the account's HTTP token on `/a/...` URLs; no XSRF token needed then [V]. SSH key for
`gerrit stream-events` and `gerrit query`. One personal account is enough for reading and voting; stream-events
needs the "Stream Events" global capability or admin [V], which public hosts usually give only to service users.
Google-hosted instances (`*.googlesource.com`) use git cookies and have no SSH [U]. Anonymous read works on public
servers. Every JSON response starts with `)]}'`, to be stripped [V].

**Reading**
- Work items: none. Links to an external tracker through commit footers (`Bug:`, `Issue:`) and `commentlink`
  config; hashtags and topics are the only labels.
- Changes: `GET /changes/?q=project:X+status:open&o=CURRENT_REVISION&o=ALL_REVISIONS&o=DETAILED_LABELS&o=SUBMIT_REQUIREMENTS&o=MESSAGES&o=DETAILED_ACCOUNTS` [U for the exact option names].
  A change is one commit; each upload is a numbered patch set (`revisions{sha: {_number, created, uploader, kind}}`).
  Stacks: `GET /changes/{id}/revisions/{rev}/related`; `submitted_together`; topics.
- Review state: labels with numeric votes per account (`Code-Review -2..+2`, `Verified -1..+1`, custom ones).
  Votes belong to a patch set and are copied forward only by the label's copy condition [U]. Submittability is
  `submit_requirements[] {name, status: SATISFIED|UNSATISFIED|OVERRIDDEN|NOT_APPLICABLE|FORCED|ERROR}` [V] plus
  `submittable`, `mergeable`, `work_in_progress`, `unresolved_comment_count`.
- Turn: the **attention set** is exactly "who acts next", maintained by the server with documented rules [V].
  In REST: `attention_set` on ChangeInfo, `/changes/{id}/attention`, search `attention:self` [U].
- CI: not in core. CI systems vote `Verified` and post a tagged message per patch set; the Checks tab is filled by
  a browser plugin calling the CI directly [V], so there is no server-side REST for checks (the old `checks` plugin
  that had one is deprecated [U]). Durations, history and agents come from the CI (Jenkins, Zuul).

**Notification**: `ssh -p 29418 host gerrit stream-events` is an **outbound** connection carrying
`patchset-created`, `comment-added` (with approvals), `change-merged`, `change-abandoned`, `reviewer-added`,
`hashtags-changed`, `wip-state-changed`, `vote-deleted`, `ref-updated` and more [V]. Ideal for a LAN tool. No
replay after a disconnect in core (the events-log plugin adds it) [U], so reconcile with a query on reconnect.
Also: the webhooks plugin (per-project config, needs a reachable URL) [U]; polling with a query sorted by update
time. No ETags [U].

**Rate limits**: none by default; a quota plugin can answer 429 [V]. Public hosts set their own. One query returns
all open changes with votes and requirements, so polling is cheap.

**Writes**: `POST /changes/{id}/revisions/{rev}/review` (message, labels, inline comments, `tag`, attention-set
changes); `POST /changes/{id}/hashtags`; `POST /changes/{id}/submit`; rebase, abandon, restore, set WIP / ready,
add reviewer, set topic [U]. Trigger CI: by convention only (a `recheck` comment for Zuul or the Jenkins Gerrit
Trigger plugin) or through the CI's own API.

**Mismatches**: change = one commit, so a multi-commit PR is a chain of changes (Change vs "stack"). Revisions are
first-class and numbered. Verdicts are numeric votes per label per patch set, aggregated by submit requirements:
richer than approve/reject, and the dimensions are configurable (maps well to "verdict per dimension"). No work
items. Merge strategy is the project's submit type, not the caller's choice; submit can take a whole topic or
chain at once. No merge queue (Zuul's gate pipeline is the batch, outside Gerrit). The attention set can hold
several users at once.

---

## 4. Jira Cloud

**Auth**: email + API token as Basic [V]: fine for one personal account; acts with that user's permissions;
tokens now have an expiry of at most one year and a scoped variant exists [U]. OAuth 2.0 (3LO) needs an app
registration and a callback, with rotating refresh tokens [U]. Forge and Connect for marketplace-style apps.
Atlassian says apps for others should not collect API tokens [V]; irrelevant for a single-owner tool.

**Reading**: JQL search `POST /rest/api/3/search/jql` (token pagination; the old `/search` is removed [U]).
Fields: `status` with `statusCategory` (To Do / In Progress / Done), `labels`, `issuelinks` (type "Blocks",
inward / outward), `parent`, `subtasks`, `assignee`, `fixVersions`; `expand=changelog` for history [U]. Board
columns to statuses: `GET /rest/agile/1.0/board/{id}/configuration` [U]. Development panel: only the internal
`/rest/dev-status/latest/issue/summary|detail?issueId=&applicationType=&dataType=`: undocumented, needs the numeric
issue ID, reported to fail with OAuth and scoped tokens; a public API is an open feature request (JRACLOUD-86769)
[V via search of Atlassian's tracker and community]. Safer: link by issue key in branch names and PR titles and
read the PRs from the code host.

**Notification**: admin webhooks (UI or `POST /rest/webhooks/1.0/webhook`, needs Jira admin) with issue, comment,
issue link, sprint, board, version events; dynamic webhooks (`/rest/api/3/webhook`) only for OAuth and Connect apps,
expire after 30 days unless extended, 5 per app per user for OAuth, no issue-link events. Target must be HTTPS
with a publicly trusted certificate; up to five retries [V]. On a tailnet: poll JQL `updated >= -2m ORDER BY
updated`, one request per poll.

**Rate limits**: points-based quotas since 2026-03-02 apply to Forge, Connect and OAuth apps; API-token traffic
stays under the older burst limits, with no published numbers, signalled by 429 and `Retry-After` [V]. One JQL poll
per 30 to 60 s is negligible.

**Writes**: comment (`POST /issue/{key}/comment`, Atlassian Document Format in v3), labels and fields
(`PUT /issue/{key}`), state through `GET` then `POST /issue/{key}/transitions` (only the transitions the workflow
allows from the current status; screens and validators can demand fields), issue links (`POST /issueLink`) [U].
No approve, merge or CI.

**Mismatches**: statuses and workflows are per project and issue type, so lanes map through `statusCategory` or
board columns and "set state" is "perform a transition" that can be refused. The work item and the change live on
different hosts, so the link is a convention. No review or CI verdicts. Rich text is ADF, not Markdown.

---

## 5. Jenkins

**Auth**: user + API token as Basic [V]; with a token no CSRF crumb is needed (the docs say tokens are preferred
over crumbs [V]; exemption since 2.96 [U]). Anonymous read if the instance allows it.

**Reading** (all JSON through `.../api/json?tree=...` [U]):
- Builds: `/job/{name}/api/json?tree=builds[number,result,building,timestamp,duration,estimatedDuration,actions[parameters[name,value],lastBuiltRevision[SHA1]]]{0,30}`.
  `estimatedDuration` is Jenkins' own estimate from recent successful builds of the job (about the last three);
  `duration` is 0 while building, so progress = (now - timestamp) / estimatedDuration.
- Agents: `/computer/api/json?tree=computer[displayName,offline,temporarilyOffline,idle,numExecutors,executors[idle,progress,likelyStuck,currentExecutable[url]]]`:
  online and busy state and a ready-made `progress` percentage per executor.
- Queue: `/queue/api/json` (`why`, `inQueueSince`, `task`).
- Pipeline stages: `/job/{name}/{n}/wfapi/describe` (pipeline-rest-api plugin) with per-stage status and duration.
- Tests: `/job/{name}/{n}/testReport/api/json`.
- Revision mapping is not native: git plugin BuildData (`lastBuiltRevision.SHA1`), build parameters
  (`GERRIT_CHANGE_NUMBER`, `GERRIT_PATCHSET_NUMBER`), or multibranch job names (`PR-123`).

**Notification**: no core outbound webhooks; plugins (Notification, Generic Webhook for inbound, SSE Gateway) or a
`curl` step in the pipeline [U]. Jenkins usually sits on the same LAN, so it can call the board directly. Else
poll: three requests cover builds, agents and queue. No ETags [U]. No rate limits.

**Writes**: `POST /job/{name}/build` or `/buildWithParameters` [V]; the 201 response carries
`Location: /queue/item/{id}/`, polled until `executable.number` appears [U]; stop with `/job/{name}/{n}/stop` [U].
Reporting back to the code host is done by plugins, not by the board.

**Mismatches**: Jenkins knows jobs and builds, not changes: every link to a change or batch is a parameter
convention. It is the only host here with a native estimate and progress figure. It would be a CI-only adapter.

---

## 6. Summary table

| | GitHub | Bitbucket Cloud | Bitbucket DC | Gerrit | Jira Cloud | Jenkins |
|---|---|---|---|---|---|---|
| Personal-account auth | fine-grained PAT | API token | HTTP access token | HTTP token, SSH key | email + API token | user + API token |
| Bot identity | GitHub App | access token | project/repo token | service user | (OAuth app) | service user |
| Work items | yes, sub-issues, blocked-by, labels | legacy tracker | no | no | yes, links, labels, workflows | no |
| Revisions | head SHA only | head hash only | head hash | numbered patch sets | - | build per SHA by convention |
| Approval tied to revision | review `commit_id` (not enforced) | no | `lastReviewedCommit` | yes, per patch set | - | - |
| CI per revision | check runs, statuses, Actions | statuses, Pipelines | statuses from external CI | label vote only | - | builds |
| Duration / estimate | history only | `duration_in_seconds`, history | - | - | - | `estimatedDuration`, executor `progress` |
| Runner state | runners API (admin) | runners API [U] | - | - | - | computer API |
| Push without public URL | no (forwarders are dev-only); runner relay | no | yes (LAN) | **stream-events over SSH** | no | yes (LAN) |
| Conditional polling | ETag, 304 free | no [U] | no [U] | no [U] | no | no |
| Limit | 5,000/h, 900 points/min | 1,000/h | admin-set | none by default | burst, unpublished | none |
| Labels on changes | yes | **no** | no | hashtags | (issue labels) | - |
| Turn | computed | computed | computed | **attention set** | assignee | - |
| Native batch | merge queue | merge queue | merge queue (recent) | no (Zuul gate) | - | - |

---

## 7. Proposed adapter port (kept small)

Split by capability, so that one deployment can combine hosts (Jira for work, Bitbucket for changes, Jenkins for
CI) and a host that lacks a capability simply does not implement that port.

```ts
type Ref = { host: string; kind: "work" | "change" | "run" | "batch"; id: string; url?: string };
type Actor = { id: string; name: string; bot?: boolean };

interface WorkItem {
  ref: Ref; title: string;
  lane: "todo" | "doing" | "waiting" | "done";   // normalised
  hostState: string;                              // raw status or label set
  labels: string[];
  blockedBy: Ref[]; parent?: Ref; openChildren: number;
  holder?: { actor: Actor; until?: string };      // claim or assignee
  updatedAt: string;
}

interface Revision { id: string; sha: string; number?: number; createdAt: string; author: Actor }

interface Verdict {
  dimension: string;                 // "review" | "risk" | "ci" | host label name
  value: "pass" | "fail" | "pending" | "none";
  score?: number;                    // Gerrit votes
  by?: Actor; revision?: string;     // revision the verdict was given on
  stale: boolean;                    // given on an older revision and not carried forward
  url?: string;
}

interface Change {
  ref: Ref; title: string; author: Actor;
  state: "open" | "merged" | "closed"; draft: boolean;
  target: string;
  revisions: Revision[];             // at least the current one
  verdicts: Verdict[];
  labels: string[];
  works: Ref[];                      // linked work items
  stack?: { parent?: Ref; position?: number };   // Gerrit chains, stacked PRs
  mergeable?: boolean; blockers?: string[];      // submit requirements, conflicts
  updatedAt: string;
}

interface Run {
  ref: Ref; pipeline: string; sha: string; branch?: string;
  status: "queued" | "running" | "passed" | "failed" | "cancelled";
  startedAt?: string; finishedAt?: string;
  estimateMs?: number;               // host estimate when it has one (Jenkins)
  runner?: string;
  steps?: { name: string; status: Run["status"]; startedAt?: string; finishedAt?: string }[];
}

interface Runner { id: string; name: string; online: boolean; busy: boolean; labels: string[]; current?: Ref }

interface Batch {
  ref: Ref; status: "building" | "testing" | "done";
  base: string;
  members: { change: Ref; sha: string; state: "waiting" | "merged" | "culprit" | "requeued" }[];
  runs: Ref[]; note?: string;
}

interface Turn { subject: Ref; actors: Actor[]; reason: string; since?: string }

type Cursor = string;
interface Page<T> { items: T[]; cursor: Cursor; removed?: Ref[] }
type HostEvent = { subject: Ref; at: string; hint?: string };   // "something changed", the core refetches

interface HostInfo {
  id: string;
  capabilities: Set<"work" | "changes" | "ci" | "runners" | "batches" | "turn" | "push">;
  whoami(): Promise<Actor>;
  budget?(): Promise<{ remaining: number; resetAt: string } | null>;
}

interface WorkPort    { listWork(since?: Cursor): Promise<Page<WorkItem>>; getWork(r: Ref): Promise<WorkItem> }
interface ChangePort  { listChanges(since?: Cursor): Promise<Page<Change>>; getChange(r: Ref): Promise<Change> }
interface CiPort {
  runsFor(sha: string): Promise<Run[]>;
  recentRuns(pipeline: string, limit: number): Promise<Run[]>;    // history for estimates
  runners?(): Promise<Runner[]>;
}
interface BatchPort   { listBatches(limit: number): Promise<Batch[]> }
interface TurnPort    { turns(): Promise<Turn[]> }                 // only when the host knows (Gerrit)
interface WatchPort   { watch(onEvent: (e: HostEvent) => void): Promise<() => void> }   // webhook, SSH stream or poll

interface WritePort {                                              // later; each method optional
  comment?(subject: Ref, markdown: string): Promise<void>;
  setLabels?(subject: Ref, add: string[], remove: string[]): Promise<void>;
  setLane?(work: Ref, lane: WorkItem["lane"]): Promise<void>;      // may be refused (Jira transitions)
  vote?(change: Ref, revision: string, dimension: string, value: Verdict["value"], score?: number): Promise<void>;
  merge?(change: Ref, expectSha: string, mode: "fast-forward" | "host-default"): Promise<{ sha: string }>;
  triggerCi?(pipeline: string, ref: string, inputs?: Record<string, string>): Promise<Ref | null>;
}
```

Design notes:
- Events are hints, not data: the core always refetches through `get*`. Then a webhook, an SSH stream and a poll
  are interchangeable and a missed event costs only delay.
- `since` cursors hide ETag, `updated_on` and `since=` differences.
- Turn is derived in the core by default (rules over lane, verdicts, holder); `TurnPort` overrides it when the
  host has its own answer.
- `Verdict.revision` and `stale` are in the model because hosts disagree on whether an approval survives a new
  revision.
- `merge` takes `expectSha` so that a host merge cannot land a revision other than the one that was tested.
- A project's conventions (claim comments, `## Verification`, `merge-ready`, the log-issue batch comments) belong in
  a separate "convention" layer on top of the GitHub host port (`BatchPort` is implemented there), not in the
  GitHub adapter itself. Otherwise the second adapter will look like a failure of the model when it is only a
  missing convention.

---

## 8. Model mismatches per host

**GitHub**
- PR and issue share one number space, labels and comments; a PR is also a work item to the API.
- No revision object; only the head SHA and timeline events.
- Review verdict is per reviewer with no dimension; risk has no native home (label or check run).
- Approval records a commit but stays valid after a push unless a rule dismisses it.
- Batch and verdicts kept as conventions (labels, comment JSON) are not host concepts; the native merge queue is
  a different thing.
- Runner state needs admin rights.

**Bitbucket Cloud**
- No usable work items; they come from Jira.
- No labels on PRs: nowhere to keep `merge-ready`-style state except comments, build statuses or the tool's store.
- Approval is on the PR, not on a revision.
- Native merge queue: Batch is read from the host and cannot be driven by the tool in the same way.
- PR tasks have no counterpart. 1,000/h limit shapes polling.

**Bitbucket Data Center**
- As Cloud, but approvals carry the reviewed commit, there is a "needs work" state, CI is always external and
  there are no runners.

**Gerrit**
- A change is one commit; a feature is a chain or topic (needs `stack`).
- Revisions are first-class; votes are per patch set and may or may not carry forward.
- Verdicts are numeric votes on configurable labels, summarised by submit requirements with six statuses
  (including OVERRIDDEN and FORCED).
- The attention set is a host-maintained Turn and may name several people.
- No work items, no labels except hashtags, no CI data beyond a vote.
- Submit strategy is fixed per project; submitting may merge a whole topic.
- Batching (Zuul gate) is outside Gerrit.

**Jira Cloud**
- State is a status in a per-project workflow; lanes need a mapping; changing state is a transition that can be
  refused or demand fields.
- No changes, reviews or CI; the development panel has no supported API.
- Dependencies are typed links with direction; hierarchy is parent / epic, not sub-issue counts.
- Comments are ADF.

**Jenkins**
- Only runs and agents. No change, revision or batch concept; all links are parameter conventions.
- Has the estimate and progress the other hosts lack, so `Run.estimateMs` is optional and host-supplied.
- Builds belong to jobs (folders, multibranch), not to a repository.

---

## 9. Recommendation for the second host

**Gerrit**, read-only, with CI taken from the `Verified` label (and optionally Jenkins or Zuul as a separate CI
port).

Why:
1. It differs most on the axes the model is really about: Change (one commit, stacks), revisions (numbered patch
   sets), Verdict (votes per label per patch set, submit requirements) and Turn (the attention set, the only native
   "your turn" among these hosts). If the model holds here, it holds for Bitbucket almost for free, since Bitbucket
   is a PR host shaped like GitHub with fewer features.
2. It can be built without an account or a server: public instances allow anonymous REST reads
   (gerrit-review.googlesource.com, review.opendev.org with Zuul) [U for current anonymous access], and a local
   Gerrit in Docker gives stream-events for the push path.
3. Its notification path (outbound SSH stream) is the one that fits a LAN or tailnet tool, so it tests `WatchPort`
   with something other than polling.
4. It has no work items, which forces the port split (`WorkPort` optional) that Jira + Bitbucket would also need.

What Gerrit does not test: combining two hosts (work items on Jira, changes on Bitbucket, joined by issue keys)
and workflow-driven lanes. That is a real risk for the model too, but it is a composition and mapping problem more
than a shape problem, and Jira's weakest part (the development panel) has no supported API. A cheap follow-up is a
Jira `WorkPort` alone, about one JQL call and a status mapping, paired with the GitHub `ChangePort`.

Things to decide before the experiment (not assumed here):
- Whether the board writes as the owner (PAT) or as a bot (GitHub App); it affects the "trusted author" rule for
  batch comments and whether its pushes trigger workflows.
- Whether the push path on GitHub is polling only, a runner relay workflow, or a tunnel.

---

## 10. Sources

Checked in this session:
- GitHub REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- GitHub REST best practices (polling, 304, write pacing): https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- GitHub webhook deliveries, smee: https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries
- `gh webhook forward`: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing
- GitHub self-hosted runners API: https://docs.github.com/en/rest/actions/self-hosted-runners
- GitHub issue dependencies API: https://docs.github.com/en/rest/issues/issue-dependencies
- GitHub workflow dispatch: https://docs.github.com/en/rest/actions/workflows
- GitHub issue comments API (2026-11-22): https://docs.github.com/en/rest/issues/comments
- GitHub sub-issue limits (2026-11-22): https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- GitHub timeline and issue event types (2026-11-22): https://docs.github.com/en/rest/issues/timeline and https://docs.github.com/en/rest/using-the-rest-api/issue-event-types
- GitHub "Update an issue" (`state_reason`, `duplicate_issue_id`; 2026-11-22): https://docs.github.com/en/rest/issues/issues
- Bitbucket Cloud request limits: https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/
- Bitbucket Cloud access tokens: https://support.atlassian.com/bitbucket-cloud/docs/access-tokens/
- Bitbucket merge queues GA (search result): https://www.atlassian.com/blog/bitbucket/unlocking-efficiency-with-merge-queues-in-bitbucket-cloud-now-ga and https://support.atlassian.com/bitbucket-cloud/docs/manage-pull-requests-with-merge-queues/
- Bitbucket app password removal (search result): https://www.atlassian.com/blog/bitbucket/bitbucket-cloud-transitions-to-api-tokens-enhancing-security-with-app-password-deprecation
- Gerrit REST API: https://gerrit-review.googlesource.com/Documentation/rest-api.html
- Gerrit stream-events: https://gerrit-review.googlesource.com/Documentation/cmd-stream-events.html
- Gerrit attention set: https://gerrit-review.googlesource.com/Documentation/user-attention-set.html
- Gerrit submit requirements: https://gerrit-review.googlesource.com/Documentation/config-submit-requirements.html
- Gerrit checks UI API: https://gerrit-review.googlesource.com/Documentation/pg-plugin-checks-api.html
- Jira Cloud webhooks: https://developer.atlassian.com/cloud/jira/platform/webhooks/
- Jira Cloud basic auth: https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
- Jira Cloud rate limiting (search result): https://developer.atlassian.com/cloud/jira/platform/rate-limiting
- Jira development information API request: https://jira.atlassian.com/browse/JRACLOUD-86769
- Jenkins remote access API: https://www.jenkins.io/doc/book/using/remote-access-api/

Not readable in this session (page truncated), so the Bitbucket Cloud endpoint details are from memory:
https://developer.atlassian.com/cloud/bitbucket/rest/intro/ and
https://developer.atlassian.com/cloud/bitbucket/rest/api-group-merge-queues/
