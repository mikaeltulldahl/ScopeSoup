# Prior designs and tech stack for the orchestrator + live board

Researched 2026-11-18. Claims are tagged:
- **[V]** verified against a primary source read in this session (spec, source code, official docs).
- **[S]** from a secondary source (vendor page, blog, search summary); plausible, not checked against the primary.
- **[U]** unverified: single weak source, or from memory.

---

## Part A. Prior designs

### A1. OpenAI Symphony (SPEC.md)

Source: https://github.com/openai/symphony/blob/main/SPEC.md (read in full via raw file). Repo: Apache-2.0, ~28k stars, 47 commits, reference implementation in Elixir labelled "experimental"; README calls Symphony "a low-key engineering preview for testing in trusted environments". [V]

**Components** [V]
1. Workflow Loader: reads `WORKFLOW.md`, splits YAML front matter from the prompt body.
2. Config Layer: typed getters, defaults, `$VAR` resolution, validation.
3. Issue Tracker Adapter: two read operations only, `fetch_issues_by_states(states)` and `fetch_issues_by_ids(ids)`. No writes.
4. Orchestrator: the *sole owner* of runtime state (polling, dispatch, retries, reconciliation).
5. Workspace Manager: issue -> directory, hooks, cleanup.
6. Agent Runner: prepares workspace, renders prompt, launches the agent process, streams events.
7. Optional Status Surface and Logging.

**State machine** [V]
- Claim states per issue: `Unclaimed`, `Claimed`, `Running`, `RetryQueued`, `Released`.
- Run attempt phases: `PreparingWorkspace` -> `BuildingPrompt` -> `LaunchingAgentProcess` -> `InitializingSession` -> `StreamingTurn` -> `Finishing`, ending in exactly one of `Succeeded`, `Failed`, `TimedOut`, `Stalled`, `CanceledByReconciliation`.
- A worker may run several turns on one thread, re-checking tracker state after each turn, up to `agent.max_turns` (default 20).

**Tick (default every 30 s)** [V]
1. Reconcile running issues: (a) stall check, (b) refresh tracker state for running issues.
2. Dispatch preflight validation; on failure skip dispatch this tick but keep reconciling.
3. Fetch candidates in active states; on failure log and skip dispatch.
4. Sort: priority 1..4 ascending, then oldest `created_at`, then identifier.
5. Dispatch while `available_slots = max(max_concurrent_agents - running, 0)` > 0 (plus optional per-state caps).
6. Notify observers, schedule the next tick.

Reconciliation outcomes: issue became terminal -> stop worker and clean workspace; still active -> update snapshot; neither active nor terminal (e.g. a human moved it) -> stop worker, keep workspace; refresh failed -> leave workers alone and retry next tick.

**Retry / backoff** [V]
- Clean exit: "continuation retry" after a fixed 1000 ms (re-check whether the issue still needs work).
- Abnormal exit: `delay = min(10000 * 2^(attempt-1), agent.max_retry_backoff_ms)` (cap default 300000 ms).
- A new retry cancels the existing timer for that issue. When the timer fires: refresh the issue; gone -> release; terminal -> clean and release; active -> dispatch if a slot is free, else requeue with error `no available orchestrator slots`.

**Stall detection** [V]: if time since the last agent event (or since start) exceeds `stall_timeout_ms` (default 300000; `<= 0` disables), kill the worker and queue a retry. Separate `turn_timeout_ms` (3600000) and `read_timeout_ms` (5000).

**Workspace lifecycle** [V]
- Path `<workspace.root>/<sanitized issue key>`; key keeps `[A-Za-z0-9._-]`, other characters become `_`, with a hash suffix if sanitizing changed it.
- Workspaces are reused across attempts and *not* deleted on success; removed when the issue goes terminal.
- Hooks (shell, cwd = workspace, 60 s timeout): `after_create` (fatal to creation), `before_run` (fatal to the attempt), `after_run` (logged, ignored), `before_remove` (logged, ignored).
- Safety invariants checked before launch: agent cwd == workspace path, and workspace path is under the root.

**WORKFLOW.md** [V]: YAML front matter with top-level keys `tracker`, `polling`, `workspace`, `hooks`, `agent`, `codex` (+ `server` extension), unknown keys ignored; the Markdown body is the prompt template, rendered strictly (unknown variables fail) with `issue` and `attempt`. The file is hot-reloaded; an invalid reload keeps the last good config and raises an operator-visible error; in-flight sessions are not restarted.

**State API (optional extension)** [V]: loopback by default; `GET /` dashboard; `GET /api/v1/state` (running rows, retry rows, token totals, rate limits); `GET /api/v1/<issue_identifier>`; `POST /api/v1/refresh` returns 202 with `queued`/`coalesced`; errors as `{"error":{"code","message"}}`.

**Deliberately left out** [V]
- No database: scheduler state is in memory and not restored on restart (it re-derives from the tracker; retry persistence is a TODO).
- No rich web UI, no prescribed dashboard.
- No ticket/PR/comment writes by the orchestrator: the agent does those through tools.
- No review step, no merge queue, no CI awareness, no budget pacing (it only *records* tokens and rate limits).
- No sandbox policy.

**Takeaways for us.** Symphony is the best template for the *dispatch* half (single state owner, tick order, reconcile-before-dispatch, stall kill, hooks, hot-reloaded workflow file). It covers nothing of review, merge queue, bisect, budget or board. Its "no database" choice does not fit us: we have a merge queue, a budget ledger and a board with history, none of which can be re-derived from the tracker.

### A2. CI and merge-queue status displays

**Zuul**
- Estimate: mean duration of up to the last 10 *successful, final* builds for the same (tenant, project, branch, job); zero/missing durations dropped; no data -> `None`. Cached 1 h (TTL cache, 8192 entries), zero values never cached "so that new jobs get an estimated time ASAP". Source: `zuul/lib/times.py`. [V]
- Per job in the status JSON: `elapsed = now - start`; `remaining = max(estimated - elapsed, 0)`; finished -> remaining 0. Per queue item: `remaining_time = max(remaining over jobs)`, but **only if all jobs have started, otherwise `None`**. Source: `QueueItem.formatJSON` in `zuul/model.py`. [V]
- Status Page 2.0 spec (https://zuul-ci.org/docs/zuul/11.3.0/developer/specs/status-page-2.0.html) [V]: the old single page showed pipelines, queues, items and jobs all at once and became unusable on busy tenants. The redesign splits into three scopes, each its own page: overview (per-pipeline item counts by state: waiting / running-succeeding / failing), pipeline detail, single change (where is *my* change, why is a job not running yet). Adds: hide empty pipelines, bookmarkable filters, spot failing items quickly. The spec does not specify drawing of dependency chains or progress bars. The spec page is marked non-authoritative; a commit "Implement new status page" exists in the Zuul repo, so it appears to have shipped at least in part [S].

**Jenkins** (source: `core/.../hudson/model/Job.java`, `Executor.java`) [V]
- Estimate = average of up to 3 candidate builds, looking at most 6 builds back; prefers builds with result UNSTABLE or better, starting with the last successful one; fills from failed-but-complete builds only if fewer than 3; returns -1 when there are no candidates.
- Progress = `elapsed * 100 / estimate`, **capped at 99** (never shows 100 while running); -1 when there is no estimate (UI then shows an indeterminate bar).
- `isLikelyStuck`: elapsed > 10 x estimate, or > 24 h when there is no estimate.
- Remaining = estimate - elapsed; when <= 0 it reports "N/A" rather than a negative number.

**Mergify** (https://docs.mergify.com/merge-queue/monitoring/) [V for CLI text, S for dashboard visuals]
- `mergify queue status` prints, in order and only when non-empty: pause indicator (reason, duration); **Batches** as a tree, each batch with a status icon and its PRs (one section per scope when scopes are used); **Forming** (batches still collecting PRs, not yet in merge order); **Waiting** (each PR with author, priority, time queued, *estimated merge time*). Empty -> `Queue is empty`. `--json` for machines. `mergify queue show <pr>` gives position, priority, rule, checks summary and blocking conditions for one PR.
- Dashboard statistics worth copying as counters: CI failure rate, batch bisection count, average batch size, "batches saved", time breakdown (waiting for CI capacity vs CI runtime), wasted-run share, PR exit reasons.
- January 2026 changelog: redesigned status view with distinct sections for batched and queued PRs and a "bisecting batch visualization". [S]

**Trunk Merge Queue** [S: Trunk's docs/changelog via search; the docs pages themselves now redirect to a login]
- Dashboard has three tabs: Queue (list, 24 h merge count, success rate, average merge time, failed PRs), **Graph** (nodes = PRs under test, edges = "tested on top of", legend, click-through, priority badges), Health (time-in-queue trend, p50).
- Failed batches move to a separate bisection lane with its own concurrency (Jan 2026); bisection reuses earlier test results and skips combinations already known to fail.
- "Pending failure depth" + "optimistic merging": a failed item stays in place for N successors; if a later item that contains it passes, the earlier failure is treated as a flake and both merge.

### A3. Gas Town, Gas City, Beads

Architecture (sources: Yegge's posts via secondary write-ups; https://tenzinwangdhen.com/posts/gastown-good-bad-ugly/; https://maggieappleton.com/gastown) [S]
- Gas Town: every role is itself an LLM session in tmux. Mayor (coordinator), Polecats (ephemeral workers, one worktree each), Witness (unsticks polecats), Refinery (merge queue *agent*, one MR at a time, resolves conflicts itself), Deacon (daemon pinged every few minutes), Dogs/Boot (watchdogs for the watchdog). Work state lives in Beads; a "hook" pins a bead to a worker so a fresh session resumes it.
- Beads (`bd`): issue tracker for agents with dependency graph and `ready` query. Storage moved from SQLite + JSONL-in-git to Dolt; sync is now `bd dolt push/pull`, JSONL is only an export that omits history and non-issue tables; the migration command was reworked several times and release notes include JSONL data-loss fixes. [S: project docs and release notes]
- Gas City (April 2026, MIT): Gas Town rewritten as an SDK of composable "packs" with a declarative `city.toml`, on Beads + Dolt; ships a "Gas Town pack". [S]
- One blog claims Yegge said in Aug/Sept 2026 that his own Gas Town workflow had failed / was shut down. **[U]** single source, not corroborated.

What users report going wrong [S]
- **Supervision built from LLM sessions is itself flaky**: the mail path between agents broke, Deacon and Dogs were silently not running, agents still needed manual nudging. Yegge: "sometimes you will need to go hustle the polecats ... and then hustle the Refinery".
- **Orphaned processes**: one user found 141 orphaned Claude Code processes after polecats were not terminated.
- **Observability**: six PRs merged without the user knowing; stalls with no visible cause; the web dashboard did not help, people fell back to tmux panes.
- **Correctness traded for throughput**: "most work gets done; some work gets lost"; reports of merges despite failing integration tests; Refinery "re-imagines" changes when conflicts get hard, drifting from intent.
- **Cost**: "cash guzzler", multiple USD 200/month accounts, coordination roles burn tokens while idle.
- **Concept overload**: too many overlapping notions; too heavy for small tasks; poor fit for iterative UI work.
- **Unsafe defaults**: everything runs with `--dangerously-skip-permissions`.

Patterns worth keeping (Appleton) [S]: persistent task state with disposable sessions; narrow fixed roles; a merge queue between workers and main; a continuous per-worker queue.

### A4. Vibe Kanban and Cline Kanban

- Vibe Kanban: board where each card starts an agent in its own worktree, with diff review and PR creation. Rust backend + React frontend + SQLite, shipped via `npx` **[U: stack from memory]**. Bloop (the company) shut down 10 April 2026; hosted cloud wound down; repo remains Apache-2.0 and "community maintained"; a community release 0.1.45 in September 2026 is reported by one secondary source. [S] I found no primary evidence of specific user-reported failure modes in this session; stale-worktree conflicts needing manual cleanup are mentioned by third parties. [U]
- Cline Kanban (https://github.com/cline/kanban, Apache-2.0, ~1.4k stars, "research preview") [V from README]: TypeScript, `npx kanban` starts a local web server; one terminal + worktree per card; uses agent *hooks* to show the latest message/tool call on the card; dependency links between cards (finishing one auto-starts linked cards); line comments on diffs sent back to the agent; gitignored dirs such as `node_modules` are symlinked into worktrees; merge = prompt the agent to commit or open a PR. No queue, no orchestrator loop, 209 open issues.
- Both are *human-driven*: a person creates/drags cards and reviews diffs. Neither has an unattended loop, merge queue or budget.

### A5. Newer orchestrators (2026) and overlap with our combination

Indexes used: https://github.com/varun1505/awesome-software-factories, https://github.com/andyrewlee/awesome-agent-orchestrators.

| Project | Loop (unattended) | Review step | Merge queue | Batch + bisect | Budget pacing | Web board, phone | Stack |
|---|---|---|---|---|---|---|---|
| Symphony (OpenAI) [V] | yes | no | no | no | records only | minimal page | spec; Elixir ref |
| Fusion (Runfusion) [V README] | yes (plan/review/execute/review) | yes | squash-merge after gates, merger agent | no | spend display only | yes, PWA + Capacitor apps | TS pnpm monorepo, Express + SSE, embedded Postgres; MIT, ~1.3k stars, 14k commits |
| Agent Orchestrator (orchestrator.inc) [V README] | routes CI failures/review comments back to the owning agent | reviewer agent | no | no | no | desktop app + phone apps, kanban lanes incl. "Needs you" | Go backend + TS frontend (inferred); Apache-2.0, ~15k stars; telemetry on by default |
| clodfarm [V README] | yes | verify command gates merge | no | no | **yes**: reads `rate_limit_event` from `claude -p`, stops at 80% weekly / 85% five-hour, pace line across the week | web farm view with phone layout | Python, SQLite/DynamoDB; MIT, ~220 stars |
| YYLO [V README] | loop runner | external | one at a time, expected-old-ref protection | no | iteration caps | no web board | TS CLI + Python ledger; MIT, 69 stars |
| claude-code-merge-queue [S] | no | no | local FIFO | no | no | no | add-on |
| Gas Town / Gas City [S] | yes (LLM roles) | partly | Refinery agent, one at a time | no | cost tracking | weak dashboard | Go + Dolt |
| Cline Kanban, Vibe Kanban, KanDev, Kanbots, Pullboard, Agetor etc. [S] | no (human starts cards) | human diff review / verifier | no | no | no | local web board | mostly TS or Rust |

**Does anything already cover our combination?** Not that I found. The distinctive parts of our tool are (a) a *deterministic*, non-LLM orchestrator, (b) a **batching merge queue with bisect** feeding CI, (c) a board that *draws* batches, progress and bisect, (d) pacing inside a subscription budget. Nobody in the lists combines (b)+(c) with agents at all: batching/bisect exists only in hosted merge-queue products (Mergify, Trunk, Aviator) and Zuul. Closest neighbours: **Fusion** (loop + review + phone board, but no queue/bisect/budget, and it brings embedded Postgres and a 14k-commit codebase) and **clodfarm** (budget governor worth reading, nothing else). So this is not re-invention, but the *board + session runner* half is commodity: borrow ideas freely, and consider reading Fusion's dashboard and clodfarm's `governor.py` before writing ours. Caveat: the field moves weekly and I read READMEs, not code; "no merge queue" means "not described". [S]

### A6. Ideas to adopt

Orchestrator
1. One process owns all runtime state; everything else (HTTP handlers, child-process callbacks) sends it messages. (Symphony)
2. Tick order: reconcile first (stall check, then refresh external state), then validate config, then fetch candidates, sort, dispatch while slots and budget remain. A failed fetch skips dispatch but never skips reconciliation. (Symphony)
3. Explicit run phases and exactly one terminal reason per attempt; show both on the session card. (Symphony)
4. Two retry kinds: 1 s continuation after a clean exit, exponential `min(10s * 2^(n-1), cap)` after a failure; one timer per item. (Symphony)
5. Stall = no stream event for N minutes -> kill and retry; separate hard turn timeout. Add Jenkins' second signal: elapsed > 10 x the typical duration for that kind of item -> flag "likely stuck" on the board before killing.
6. Workspace hooks `after_create` / `before_run` / `after_run` / `before_remove` with a timeout, and the two path invariants checked before every launch. (Symphony)
7. A hot-reloaded workflow file in the target repo (front matter = limits, prompt body = template); a bad reload keeps the last good config and shows an error banner. (Symphony)
8. `POST /refresh` that coalesces into the next tick, returning 202. (Symphony)
9. Budget governor as a pure function over (five-hour window, weekly window, reset times, pace line) fed by `rate_limit_event` from the agent's own stream. (clodfarm) Note: reports say `utilization` is often missing when status is "allowed" and only `resetsAt` is reliable; verify against the installed CLI. [S]
10. Persist what Symphony does not: claims, attempts, retry timers, queue and batch state, so a restart resumes instead of forgetting.

Merge queue and estimates
11. Estimate = mean of the last N successful runs of the same job (Zuul: 10; Jenkins: 3 within the last 6). Never include failed runs unless there is nothing else. No history -> indeterminate bar, not a guess.
12. Bar = elapsed / estimate capped at 99%; remaining never negative: show "over by 2 min" or "N/A". (Jenkins)
13. Batch ETA = max of remaining over its jobs, shown only once all jobs have started. (Zuul)
14. Per-item "estimated merge time" in the waiting list. (Mergify)
15. Bisect runs in its own lane with its own concurrency, reuses results already obtained, and skips combinations known to fail. (Trunk)
16. Keep the counters: bisection count, average batch size, CI runs saved by batching, wasted-run share, time waiting vs time testing. (Mergify)

Board
17. Three scopes instead of one dense page: overview (counts per lane and state), queue detail (batches, bisect tree), single item (where is it, why is it not moving). Each a bookmarkable URL. (Zuul 2.0)
18. Sections in fixed order, hidden when empty: paused banner, Batches, Forming, Waiting. (Mergify CLI)
19. Bisect as a tree under the failed batch: each split is a child box with its own bar and verdict; the culprit is highlighted and ejected, survivors re-queue. (Mergify/Trunk)
20. A "Needs you" lane as a first-class column. (Agent Orchestrator)
21. Every blocked item states its reason in words ("waiting for slot", "budget pause until 14:05", "waiting on #123"). (Zuul user story; Symphony's `no available orchestrator slots`)
22. Card shows the latest tool call/message from the stream. (Cline Kanban)
23. A text/JSON `status` endpoint mirroring the board, for agents and scripts. (`mergify queue status --json`)

### A7. Pitfalls to avoid

1. LLM sessions as supervisors (Mayor/Witness/Deacon). Supervision must be plain code; an LLM is only ever a worker or reviewer. (Gas Town)
2. An LLM as the merge queue. Conflict resolution by "re-imagining" loses intent; send conflicts back to the authoring session or to the human. (Gas Town)
3. Merging without a recorded green CI result for exactly the merged commit. (Gas Town reports)
4. Orphaned agent processes. Track every PID in the store, kill whole trees on stop, and sweep at startup for processes from a previous run. (Gas Town: 141 orphans)
5. Silent activity. Every state change is an event visible on the board; nothing merges without a visible row. (Gas Town)
6. In-memory-only state. (Symphony's own TODO)
7. A storage layer that is a project in itself (Beads' SQLite -> JSONL -> Dolt migrations). One SQLite file.
8. Estimates polluted by failed or still-running builds (Jenkins bugs JENKINS-21099, JENKINS-36023).
9. One page showing everything (Zuul's pre-2.0 page).
10. Shared resources across worktrees: ports, databases, caches are not isolated by a worktree. Allocate ports per session.
11. Concept sprawl. Keep the vocabulary to item, session, review, batch, bisect.
12. Depending on a vendor-backed board (Vibe Kanban's company closed in April 2026).
13. `--dangerously-skip-permissions` as an unexamined default on a machine that also holds real data.
14. NDJSON parsing that assumes clean lines: a `rate_limit_event` has been reported injected mid-line (Claude Code issue #49640). Parse defensively, keep the raw line, count malformed lines. [S]

---

## Part B. Tech stack

### B1. Facts checked today

| Fact | Status | Source |
|---|---|---|
| `node:sqlite` | **Stability 1.2, Release candidate** (since v25.7.0 / v24.15.0), still so in the v26.13.1 docs. Not stable. Has `timeout` (busy timeout), sessions/changesets, `backup()`, prepared-statement tag store, defensive mode on by default. | https://nodejs.org/api/sqlite.html [V] |
| Node TypeScript type stripping | **Stable** since v24.12.0 / v25.2.0; on by default since v22.18. No enums, parameter properties, `paths`, `.tsx`; import extensions mandatory; `import type` required. | https://nodejs.org/api/typescript.html [V] |
| Node single executable apps | **Stability 1.1, Active development**. `node --build-sea config.json` (v25.5.0+) builds in one step; ESM entry via `mainFormat: "module"`; assets and a read-only VFS (VFS is 1.0 early development); app must be bundled to one file; native addons need extracting to a temp file; Windows supported. | https://nodejs.org/api/single-executable-applications.html [V] |
| Node release line | Node 26 entered LTS late October 2026; Node 24 moved to maintenance. | search summary [S] |
| Bun on Windows | 2026 reports of segfaults in long-lived processes with many concurrent child spawns (1.3.10), `uv_spawn` failures (1.3.13), fixes landing through the year. | third-party issue mirrors [S] |
| Deno compile | Windows x64 target supported; child_process and node:sqlite fixes still landing in 2.x; no statement found on compiled-binary limits. | [S]/[U] |
| Windows + Node spawn | Spawning a `.cmd` shim without `shell: true` throws EINVAL (CVE-2024-27980 hardening). The native `claude.exe` avoids this; a report says the npm `claude.cmd` shim misbehaved where `claude.exe` worked. | issue mirrors [S] |
| Windows process trees | `child.kill()` kills only the direct child in Node; Go's stdlib has no tree kill either. Standard answer for both is `taskkill /PID n /T /F`, which misses grandchildren whose parent already exited; a Job Object closes that gap but needs Win32 calls (easy in Go/Rust, needs an addon or helper in Node). | community sources [S] |
| better-sqlite3 prebuilds for Node 26 | not checked. | [U] |

### B2. Comparison

| Criterion | 1. TS on Node + small UI + SQLite | 2. Go single binary | 3. Rust | 4. TS on Bun/Deno compiled |
|---|---|---|---|---|
| Reuse of 2,400 lines of dependency-free TS | Direct import, tests keep running | Rewrite (and re-test the bisect logic) | Rewrite | Direct import |
| Spawn/supervise children, read NDJSON, Win + Linux | Mature (`child_process`, `readline`); tree kill via `taskkill /T /F` and `detached` process groups; no Job Object without a helper | Very good; goroutine per stream; Job Objects via `x/sys/windows` | Very good (tokio, `windows` crate) | Bun: the weakest point, Windows spawn crashes reported in 2026. Deno: fine on paper, less proven |
| Live updates | SSE in ~30 lines on `node:http`; WS needs `ws` | SSE trivial | SSE trivial (axum) | Same as Node |
| Packaging as one service/container | Node runtime + a folder; Node runs as a Windows service, and `node:22/26-slim` for a container. SEA possible later but not stable | Best: one static file | One file, slow builds, cross-compiling to Windows is fiddly | One file, but runtime risk |
| Ease for LLM agents to write and maintain | Highest: same language, lint and test setup the agents already use | High: simple language, fast compile | Lowest: borrow-checker and async iterations burn budget | High |
| Long-running robustness | Good; needs discipline on unhandled rejections and timers | Excellent | Excellent | Bun: doubtful on Windows; Deno: good |
| Test tooling | `node:test` built in or Vitest; Playwright for the board | `go test` excellent; UI still needs a JS toolchain | `cargo test`; UI still JS | `bun test` / `deno test` |
| Second toolchain needed for the UI? | No | Yes (UI is JS anyway) | Yes | No |

**SQLite binding.** `node:sqlite`: zero dependencies, nothing to compile on Windows, synchronous API that suits a single-writer orchestrator, but release candidate, so the API may still shift. `better-sqlite3`: stable and long proven, but a native addon (prebuild must match the Node version; a build toolchain is needed when it does not), and it breaks the code base's dependency-free property. Recommendation: use `node:sqlite` behind a 50-line `Store` interface on a pinned Node LTS; the interface makes a swap to `better-sqlite3` a one-file change if the RC bites. An RC-stage module from Node core, for a one-user tool whose data can be rebuilt or restored, is an acceptable risk.

**Front end.** The board is one screen of live state with a few buttons. Options: React (familiar; heaviest), Preact (same JSX, ~4 kB, signals fit SSE-driven state well), Svelte (smallest code, different idiom from the rest of the owner's code), htmx (server-rendered fragments over SSE; least JS, but animated progress bars and a bisect tree that updates in place get awkward). Recommendation: **Preact + Vite**, or plain React if sharing components with the existing PWA matters more than size. Draw batches and the bisect tree with CSS grid/flex and plain SVG, no chart library.

**SSE vs WebSocket.** SSE. The data flow is server -> browser; commands are ordinary POSTs. SSE needs no library, reconnects by itself, replays from `Last-Event-ID` (which maps directly onto an event-log sequence number), and passes through Tailscale serve and reverse proxies. The old six-connections-per-origin limit only applies on HTTP/1.1 and one stream per tab is enough. Use WebSocket only if an interactive terminal into a session is added later.

### B3. Event-sourced store vs plain tables

Full event sourcing (state exists only as a fold over events) costs projections, upcasting of old event shapes and rebuild tooling, for one user and one writer. Plain tables alone lose the two things this tool needs: a replayable feed for the board and an audit of why the orchestrator did something.

Recommend the hybrid:
- **Plain tables are the source of truth**: `items`, `sessions`, `attempts`, `batches`, `batch_members`, `ci_runs`, `budget_windows`, `retry_timers`.
- **One append-only `events` table** (`seq INTEGER PRIMARY KEY`, `ts`, `kind`, `subject`, `json`) written **in the same transaction** as each state change. It feeds SSE (`id:` = `seq`, resume from `Last-Event-ID`), the activity view, and debugging. It is never read to compute state.
- Raw agent NDJSON goes to **per-session files** on disk, with only an index row (path, byte offsets of notable events, token totals) in SQLite. Streams are large and would bloat the database.
- Budget: a ledger table of usage samples (append-only) plus a derived current-window row; the governor is a pure function over them.
- WAL mode, `synchronous=NORMAL`, busy timeout set, single writer (the orchestrator), prune `events` by age.
- The existing merge-queue and backlog code stays pure: `(state, input) -> (state', effects)`. The shell loads state, calls it, persists state + events in one transaction, then performs effects. That keeps the deterministic core testable without a database.

### B4. Recommendation

**TypeScript on Node LTS (24 now, 26 once settled), run directly with type stripping; `node:http` + SSE; `node:sqlite` behind a small store interface; Preact + Vite for the board; shipped as a folder run by a service (NSSM/Windows service now, systemd or a `node:slim` container later). No single-executable packaging for now.**

Reasons:
1. The 2,400 lines of merge-queue, bisect and backlog rules are the risky logic and already exist with tests. Any other language means rewriting exactly the part that is most expensive to get right.
2. One language across core, server, UI and tests is the cheapest thing for coding agents to maintain, and it matches the toolchain the agents already know.
3. Everything needed is in Node core today: process spawning, line streams, HTTP, SQLite, test runner, TypeScript execution. The server can stay dependency-free; only the UI build has dev dependencies.
4. "One binary" is the main thing given up, and it matters least here: one user, a machine that can run Node as a service, and a server later where a container is natural. Node SEA can be added when it leaves active development.
5. The known weak spots are bounded and have standard answers: process-tree kill on Windows (`taskkill /T /F`, PID table in the store, startup sweep; a tiny Job Object helper only if orphans actually appear), `.cmd` shims (spawn `claude.exe` by absolute path), `node:sqlite` RC status (store interface).

Constraints this choice imposes: write "erasable" TypeScript only (no enums or parameter properties, explicit `.ts` import extensions, `import type`); pin the Node version; keep `tsc --noEmit` as the type check.

**Runner-up: Go single binary + SQLite (`modernc.org/sqlite`, no cgo) + embedded UI.** Better on packaging, process supervision (Job Objects, goroutines) and long-run robustness, and agents write Go well. It loses on reuse (full rewrite and re-verification of the queue/bisect logic) and it still needs a JS toolchain for the board, so it is two languages instead of one. Choose it if the tool is later meant for distribution to other people, where a single file with no runtime matters.

Not recommended: **Rust** (highest cost per change for agent-written code, no benefit at this scale); **Bun compiled** (reuses the TS and gives one file, but the reported 2026 Windows crashes are in exactly the pattern we need: long-lived process, many child spawns); **Deno compiled** (plausible, less proven for this pattern, no advantage over Node that outweighs leaving the mainstream runtime).

---

## Sources

Symphony
- https://github.com/openai/symphony/blob/main/SPEC.md
- https://github.com/openai/symphony

Zuul
- https://zuul-ci.org/docs/zuul/11.3.0/developer/specs/status-page-2.0.html
- https://opendev.org/zuul/zuul/raw/branch/master/zuul/lib/times.py
- https://opendev.org/zuul/zuul/raw/branch/master/zuul/model.py (`formatJSON`)
- https://opendev.org/zuul/zuul/commit/ce8a213fcde091077be644ce424816bb444d329f
- https://opendev.org/zuul/zuul/commit/719ba5078711c1f4c20731170bc7d03c1c7db3cc

Jenkins
- https://raw.githubusercontent.com/jenkinsci/jenkins/master/core/src/main/java/hudson/model/Job.java
- https://raw.githubusercontent.com/jenkinsci/jenkins/master/core/src/main/java/hudson/model/Executor.java
- https://issues.jenkins.io/browse/JENKINS-21099 , https://issues.jenkins.io/browse/JENKINS-36023

Mergify, Trunk
- https://docs.mergify.com/merge-queue/monitoring/
- https://docs.mergify.com/changelog/2026-01-13-new-merge-queue-status-dashboard/
- https://docs.mergify.com/merge-queue/batches.md
- https://docs.trunk.io/merge-queue/using-the-queue/monitor-queue-status
- https://docs.trunk.io/changelog/2026-03-09-merge-queue-impacted-targets-visible-on-the-merge-graph
- https://docs.trunk.io/changelog/2026-01-07-merge-queue-independent-concurrency-for-batch-bisection
- https://docs.trunk.io/changelog/2026-01-02-merge-queue-test-caching-for-batch-failure-isolation
- https://docs.trunk.io/merge-queue/optimizations

Gas Town, Gas City, Beads
- https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04
- https://steve-yegge.medium.com/gas-town-from-clown-show-to-v1-0-c239d9a407ec
- https://tenzinwangdhen.com/posts/gastown-good-bad-ugly/
- https://maggieappleton.com/gastown
- https://rywalker.com/research/gas-city , https://www.dsebastien.net/gas-city/
- https://beads.gascity.com/architecture/dolt , https://beads.gascity.com/reference/troubleshooting

Boards and orchestrators
- https://vibekanban.com/blog/shutdown , https://github.com/BloopAI/vibe-kanban
- https://github.com/cline/kanban
- https://github.com/Runfusion/Fusion
- https://github.com/ComposioHQ/agent-orchestrator (now OrchestratorInc/agent-orchestrator)
- https://github.com/matank001/clodfarm
- https://github.com/yylo-dev/yylo
- https://github.com/funador/claude-code-merge-queue
- https://github.com/varun1505/awesome-software-factories
- https://github.com/andyrewlee/awesome-agent-orchestrators

Stack
- https://nodejs.org/api/sqlite.html
- https://nodejs.org/api/single-executable-applications.html
- https://nodejs.org/api/typescript.html
- https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule
- https://docs.deno.com/runtime/reference/cli/compile/
- Bun on Windows reports: https://claudeissues.com/issue/27003-bun-1-3-10-segfault-on-windows-x64-jsc-gc-use-after-free-persists-from-21875 , https://claudeissues.com/issue/52753-bug-cowork-fails-with-uv-spawn-eunknown-errno-134-vm-boots-successfully-but-bun
- Claude Code stream: https://claudeissues.com/issue/49640-bug-rate-limit-event-injected-mid-ndjson-line-in-stream-json-output-corrupting-a , https://claudeissues.com/issue/50518-claude-agent-sdk-expose-per-bucket-rate-limit-utilization-to-headless-sdk-consum , https://littlebearapps.com/help/untether/claude-stream-json-cheatsheet/
- Windows `.cmd` spawn: https://claudeissues.com/issue/68221-bug-windows-npx-based-mcp-plugin-servers-fail-to-connect-spawn-einval-from-cmd-s
- Process trees: https://www.npmjs.com/package/tree-kill , https://pkg.go.dev/github.com/tg123/jobobject

## Not checked / gaps
- Trunk's docs pages redirect to a login; Trunk details come from search summaries of its docs and changelog.
- No primary evidence gathered of Vibe Kanban user complaints; its stack is from memory.
- The claim that Yegge abandoned Gas Town in autumn 2026 is single-source.
- Whether Zuul's Status Page 2.0 shipped in full.
- better-sqlite3 prebuilds for Node 26; Deno-compiled binary behaviour for child processes on Windows.
- Orchestrator comparisons are from READMEs, not code; "no merge queue" means "none described".
- Exact shape of `rate_limit_event` in the installed Claude Code version.
