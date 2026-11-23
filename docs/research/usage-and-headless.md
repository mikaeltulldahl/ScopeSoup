# Subscription usage visibility and `claude -p` mechanics for a deterministic orchestrator

Researched 2026-11-18. Local CLI tested: Claude Code 2.1.327 (Linux, cloud container, `authMethod: oauth_token`).

Claim labels:
- **[DOC]** verified from official docs (code.claude.com/docs or support.claude.com), fetched today
- **[EXP]** observed in a local experiment in this container (one run each; not a documented contract)
- **[2ND]** secondary source only (third-party code/blogs)
- **[UNV]** unverified / inference

Downloaded doc pages are in `scratchpad/research/docs/`, raw experiment output in `scratchpad/research/exp/`.

---

## 1. Can a program read the subscription's current usage?

**Yes.** There are four channels; two are documented, one is observed, one is unofficial.

### 1a. `rate_limit_event` in stream-json / SDK messages (best channel for the orchestrator)

- [DOC] The SDK message union includes `SDKRateLimitEvent`, `type: "rate_limit_event"`, with `rate_limit_info: { status: "allowed" | "allowed_warning" | "rejected", resetsAt?: number, utilization?: number, errorCode?: "credits_required", canUserPurchaseCredits?, hasChargeableSavedPaymentMethod?, overageEnabled? }`. Documented as "Emitted when the session encounters a rate limit". (agent-sdk/typescript#sdkratelimitevent)
- [DOC] Python SDK: `RateLimitEvent` / `RateLimitInfo` with `status`, `resets_at` (Unix seconds), `rate_limit_type` (`five_hour | seven_day | seven_day_opus | seven_day_sonnet | overage`), `utilization` (**fraction 0.0 to 1.0**), `overage_status`, `overage_resets_at`, `overage_disabled_reason`, and `raw` (the full dict from the CLI). Documented as "Emitted when rate limit status changes". (agent-sdk/python#ratelimitevent)
- [EXP] In practice the event was emitted after the first (and only) API response of a trivial successful run, with `status: "allowed"`, and it carried **both windows**:

  ```json
  {"type":"rate_limit_event","rate_limit_info":{
    "status":"allowed","resetsAt":1795018200,"rateLimitType":"five_hour",
    "overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,
    "unifiedWindows":{
      "five_hour":{"utilization":0.09,"resetsAt":1795018200,"status":"allowed"},
      "seven_day":{"utilization":0.32,"resetsAt":1795507200,"status":"allowed"}}},
   "uuid":"...","session_id":"..."}
  ```

  `unifiedWindows`, `rateLimitType`, `overageStatus`, `isUsingOverage` are **not in the documented TypeScript type** (the Python type exposes them only via `raw`). Treat `unifiedWindows` as undocumented: parse defensively, fall back to the top-level `utilization`/`resetsAt`/`rateLimitType`.
- [EXP] Command that produced it (cost: 4 output tokens on Haiku, estimated $0.0006):
  `claude -p "Reply with the single word ok" --model haiku --output-format stream-json --verbose --no-session-persistence --tools "" --strict-mcp-config --setting-sources "" --max-turns 1 < /dev/null`
- [UNV] Whether the event is emitted on every API response or only on the first and on status changes during a long run. One run only. The orchestrator should keep the latest value seen per worker stream and not assume a cadence.
- [UNV] The experiment ran in a cloud container whose token is a managed session token; a home-server run with a `/login` or `setup-token` credential should show the same event (the data comes from API response headers) but this was not tested.

### 1b. `/usage` as a prompt in `-p` mode (documented, zero tokens, but needs the right credential)

- [DOC] "When you send a command such as `/context` or `/usage` as a prompt, its output arrives as an `SDKAssistantMessage`." `/cost` and `/stats` are aliases of `/usage`.
- [DOC] The assistant message carries a structured `usage_report` (`SDKUsageReport`, experimental, Agent SDK v0.3.273+): `rate_limits.limits[]` rows with `kind` (`session`, `weekly_all`, `weekly_scoped`), `group`, `percent` (0-100), `resets_at` (ISO 8601 or null), `scope` (model/surface), `severity`, `is_active`; plus `extra_usage` (usage credits: `is_enabled`, `monthly_limit`, `used_credits`, `utilization`, `currency`).
- [DOC] `usage_report` is attached only when: the session uses a claude.ai credential, **and** the credential shows a known plan type or carries the `user:profile` scope, **and** the account is not on usage-based billing. **"A `claude setup-token` token passed as `CLAUDE_CODE_OAUTH_TOKEN` doesn't qualify by default, because it carries only the `user:inference` scope."**
- [EXP] `claude -p "/usage" --output-format stream-json --verbose` exits 0 with `num_turns: 0`, zero tokens, `"local_command": "usage"` on the result. In this container it returned only the session-cost text and **no `usage_report`** (consistent with the scope rule above).
- Consequence: `/usage` gives the richest data (per-model weekly rows, credits) for free, but only if the server is logged in with a full `/login` credential, not a `setup-token` token.

### 1c. Statusline JSON (documented, but interactive only)

- [DOC] Statusline stdin JSON includes `rate_limits.five_hour.used_percentage` / `.resets_at` and `rate_limits.seven_day.used_percentage` / `.resets_at` (percent 0-100, Unix epoch seconds). Present only for Pro/Max/Ultra subscribers, only after the first API response in the session; each window may be absent and is dropped once `resets_at` passes.
- [UNV] The status line is a terminal-UI feature; nothing in the docs says the statusline command runs under `-p`. Do not build on it for headless. It is useful as a side channel: a statusline script in the human's interactive sessions can write the numbers to a file the orchestrator reads.

### 1d. Unofficial OAuth usage endpoint

- [2ND] Several third-party tools (Rust crates `claude-usage`, `cship`, `clauth`, `burnrate`) call `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <oauth access token>` and `anthropic-beta: oauth-2025-04-20`, returning `five_hour` / `seven_day` (`utilization` as 0-100, `resets_at`), `seven_day_opus`, `seven_day_sonnet`, `extra_usage`. Returns nulls without subscription or `user:profile` scope.
- Not in official docs. It requires reading the OAuth token out of Claude Code's credential store, which the legal page discourages in spirit ("developers may not collect, store, or intermediate Claude.ai credentials or session tokens"; aimed at third-party products, but still a reason not to depend on it). **Recommendation: do not use.** Not tested here.

### 1e. Other channels checked

- `/status`: [DOC] opens the Settings UI on the Status tab (version, model, account, connectivity). No usage numbers; a TUI panel. Not useful headless. `claude auth status` prints JSON (`loggedIn`, `authMethod`, ...) and exits 0/1: use it as a preflight. [DOC][EXP]
- Response headers: [UNV] Claude Code does not expose raw API headers. The `rate_limit_event` is its rendering of them.
- Hooks: [DOC] no hook receives usage percentages. `StopFailure` fires when a turn ends on an API error, with `error` = `rate_limit` (among others), `error_details`, `last_assistant_message`; output is ignored (logging only). Matcher can be `rate_limit`.
- `system/api_retry` stream event: [DOC] `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` category (`rate_limit`, `overloaded`, ...). Distinguish 429 quota (`rate_limit`) from 529 capacity (`overloaded`; "A 529 is not your usage limit and doesn't count against your quota").
- OpenTelemetry (`monitoring-usage`): token/cost metrics, not plan percentages. Not examined in depth. [UNV]

### 1f. What happens when a limit is hit in `-p` mode

- [DOC] Message text: `You've hit your session limit · resets 3:45pm`, `You've hit your weekly limit · resets Mon 12:00am`, `You've hit your Opus limit · ...`, `You've hit your Sonnet limit · ...`. "Claude Code blocks further requests until the reset time shown." Session and weekly limits are shared across models; Opus/Sonnet limits are per family. A warning precedes it: `You've used 85% of your session limit · resets 3:45pm`.
- [DOC] "Usage counts against the session and weekly allowances at the same time. A single burst of heavy activity, such as a large workflow fanout, can exhaust the weekly allowance before the session window resets."
- [DOC] `-p` exit status: "exits with code 0 on success and a non-zero code when the run fails ... When a failure happens inside the run ... Claude Code prints the failure as the result on stdout." Result fields: `is_error`, `api_error_status` (HTTP status of the terminating API error), `terminal_reason` (includes `api_error`, `blocking_limit`), `subtype`.
- [DOC] `rate_limit_event` with `status: "rejected"` carries `resetsAt` (epoch seconds); `errorCode: "credits_required"` means included usage is exhausted and the session cannot continue without usage credits.
- [DOC] Default: fails after `CLAUDE_CODE_MAX_RETRIES` (default 10). With `CLAUDE_CODE_RETRY_WATCHDOG=1` (meant for unattended runs) Claude Code instead **waits inside the process** until the limit resets ("a session that hits a usage limit waits out the remaining window"); bound it with `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` (v2.1.301+; fails at once when reset is further away than the cap) and `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS`. It fails at once on spend-limit / exhausted-credits 429s.
- [DOC] A subagent that hits a usage limit ends with `Agent terminated early due to an API error`.
- [UNV] The exact exit code number, and the exact result JSON for a limit hit, were **not tested** (cannot safely exhaust the limit here). Design for: non-zero exit OR `is_error: true`, `api_error_status == 429`, last `rate_limit_event.status == "rejected"`, and result text matching `hit your .* limit`.
- [DOC] Usage credits (overage): if enabled on the account, work continues past the limit and is billed. The experiment showed `overageStatus: "rejected"`, `isUsingOverage: false`. The orchestrator should treat `isUsingOverage: true` or `overageEnabled: true` as a stop condition unless the owner opted in.

### Does `claude -p` count against the subscription windows at all?

- [DOC] support.claude.com article 15036540: a planned split (announced May 2026: programmatic use moves to a separate monthly "Agent SDK credit" from 2026-06-15) was **paused on 2026-06-15**. Current text: "when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits." An October 7, 2026 update adds monthly API credits for Max/Ultra/Team that apply when running with an **API key** from a linked Console organization. (Page read through a summarizing fetch, not verbatim.)
- [2ND] Press coverage (The New Stack, The Register, others) confirms the announcement and the pause; no resumed date found.
- Risk: this policy has changed once and may change again. Keep "which pool does headless usage draw from" a configuration fact, and keep reading limits from the event stream rather than hardcoding plan numbers.

---

## 2. `claude -p` mechanics

### Output and events
- [DOC] `--output-format text | json | stream-json`. `json` = one result object; `stream-json` = NDJSON, needs `--verbose`; `--include-partial-messages` adds `stream_event` token deltas; `--include-hook-events` adds hook lifecycle events. Last line is the `result` message.
- [DOC][EXP] Event kinds seen/documented: `system/init` (model, tools, mcp_servers, plugins, `apiKeySource`, `permissionMode`, `claude_code_version`, `capabilities`; may be preceded by startup events), `system/status`, `system/api_retry`, `system/plugin_install`, `system/permission_denied`, `assistant`, `user`, `stream_event`, `rate_limit_event`, `system/post_turn_summary`, `result`. [EXP] also `active_goal`, `autocompact_state` before init. Ignore unknown types.
- [DOC][EXP] `result` fields: `type`, `subtype` (`success | error_max_turns | error_during_execution | error_max_budget_usd | error_max_structured_output_retries`), `is_error`, `result` (text), `structured_output`, `session_id`, `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage` (input/output/cache tokens), `modelUsage` (per model: tokens, `costUSD`, `contextWindow`), `permission_denials`, `terminal_reason`, `api_error_status`, `stop_reason`.
- [DOC] `total_cost_usd` is a **client-side estimate at API list prices**; for subscribers it is not a bill, but it is a usable relative cost unit. With `--resume`/`--continue` the total covers the whole conversation including earlier runs.
- [DOC] SIGTERM gives exit code 143 and no result for the unfinished turn; SIGINT ends the turn cleanly. Stdin: pass `< /dev/null` (otherwise a 3 s wait and a warning [EXP]). Piped stdin capped at 10 MB.
- [DOC] A `-p` run can stay open up to 10 minutes waiting for background work (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`).

### Structured output
- [DOC] `--json-schema '<schema>'` with `--output-format json`: validated output in `structured_output`. Invalid schema: exits with `Error: --json-schema is not a valid JSON Schema`. `format` keyword is not enforced. If the run ends without valid output the field is **absent** (check presence); exhaustion gives subtype `error_max_structured_output_retries`.

### Sessions
- [DOC] `--resume <id | name | path to .jsonl>`, `--continue` (most recent in cwd), `--session-id <uuid>` (choose the ID up front), `--fork-session` (new ID when resuming), `--no-session-persistence`, `-n/--name`. Resume by ID searches all projects on the machine (v2.1.223+).
- [DOC] Two concurrent runs resuming the same session write to one transcript and can lose messages; use `--fork-session`.
- [DOC] Resuming a session that ended inside a worktree returns to that worktree, including in `-p`.

### Permissions
- [DOC] `--permission-mode default(manual) | acceptEdits | plan | auto | dontAsk | bypassPermissions`. Since v2.1.302 `-p` starts in Manual when nothing sets a mode; calls needing approval are denied unless allowed by rule, `PermissionRequest` hook or `--permission-prompt-tool`.
- [DOC] `--allowedTools "Bash(git diff *),Read,Edit"` (permission rule syntax; auto-approve). `--disallowedTools`. `--tools` restricts which built-in tools exist. `--permission-prompts none` (v2.1.259+) for unattended runs: anything that would prompt is denied and Claude is told not to retry. `dontAsk` = deny everything not pre-allowed (good for locked-down runs). Denials are listed in `result.permission_denials`.
- [DOC] `-p` skips the workspace trust dialog and runs project hooks and `.mcp.json` servers; use `--setting-sources`, `--strict-mcp-config`, `--safe-mode` or `--restricted` to control that. `--bare` skips all discovery **but never reads OAuth** (API key only), so **`--bare` is unusable with subscription auth**. Docs say `--bare` "will become the default for `-p` in a future release": a breaking risk for subscription-based orchestration; pin the CLI version.

### Limits and model
- [DOC] `--max-turns N` (print mode; result subtype `error_max_turns`). `--max-budget-usd X` (client-side estimate, includes subagents, can overshoot; subtype `error_max_budget_usd`; resumed totals do not count). `--model <alias|full name>`, `--fallback-model a,b`, `--effort low..max`. `--append-system-prompt[-file]`, `--system-prompt[-file]`, `--append-subagent-system-prompt`.
- [EXP] `claude --help` lists no `--max-turns` (it is hidden) but the flag was accepted.

### Worktrees and parallelism
- [DOC] `--worktree [name]` creates `<repo>/.claude/worktrees/<name>` branching from the default branch (`worktree.baseRef: "head"` to branch from HEAD); works with `-p` (no trust check). **`-p` runs do not clean up their worktrees** and leave a git worktree lock; remove with `git worktree unlock` + `git worktree remove`. A deterministic orchestrator is better off creating worktrees itself with `git worktree add` and passing them as cwd.
- [DOC] Running multiple instances is an expected pattern (costs page, worktrees page, agent view). [UNV] No documented cap on concurrent `-p` processes per subscription; all draw from the same 5-hour and weekly windows, and bursts can trip 429 throttles ("Server is temporarily limiting requests", unrelated to plan quota).

### Auth on a headless server
- [DOC] `claude setup-token`: browser flow, prints a **one-year** OAuth token, requires a subscription; set as `CLAUDE_CODE_OAUTH_TOKEN`. Scope is `user:inference` only (so no `/usage` report, see 1b). Not read in `--bare` mode. `ANTHROPIC_API_KEY` and others rank above it in auth precedence: make sure the orchestrator's environment does not set an API key, or usage is billed to the API instead.
- [DOC] Alternative: interactive `claude` + `/login` once on the server (credentials in `~/.claude` / keychain), gives the full-scope credential. `CLAUDE_CONFIG_DIR` separates accounts/configs. `claude auth status` (JSON, exit 0/1) as preflight.

### Terms
- [DOC] legal-and-compliance: "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK." OAuth auth is "designed to support ordinary use of Claude Code and other native Anthropic applications". Third-party developers may not offer claude.ai login or route requests through plan credentials on behalf of **their users**, nor collect/intermediate credentials. An end user running the unmodified binary with their own subscription is explicitly allowed. Anthropic "reserves the right to take measures to enforce these restrictions ... without prior notice."
- Reading: an owner's own orchestrator spawning the unmodified `claude` binary under their own login is within the stated rules; sustained 24/7 maximal draining of the plan is outside "ordinary, individual usage" and is the grey area. Leaving a reserve and modest parallelism helps on both counts. [UNV: interpretation, not legal advice]

### Agent SDK as an alternative to spawning the CLI
- [DOC] `@anthropic-ai/claude-agent-sdk` (TypeScript) and `claude-agent-sdk` (Python) run the same agent loop; the CLI's `-p` mode is described as "the Agent SDK via the CLI". The SDK bundles a Claude Code build (SDK v0.3.x bundles CLI v2.1.x) and exchanges the same message types, so `rate_limit_event`, `result`, `usage_report` are identical.
- [DOC] Extras over the CLI: typed messages, `canUseTool` permission callback, in-process hooks and custom tools (in-process MCP), `interrupt()`, streaming input with queued messages, session helpers (`listSessions`, `fork_session`), `supportedCommands()`.
- Auth: [DOC] SDK docs tell developers to use API keys and state "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products". [DOC] The support article states that when signed in with a Claude plan, the Agent SDK draws from subscription limits, so it does work with subscription auth for personal use. Same terms as above.
- Trade-off for a deterministic TypeScript orchestrator: the SDK saves NDJSON parsing and gives clean interrupts; spawning the CLI gives process isolation, a pinned binary independent of the orchestrator's dependencies, and trivial kill/timeout handling. Both see the same usage data.

---

## 3. Local experiments (this container)

| Experiment | Result |
|---|---|
| `claude --version` | 2.1.327 |
| `claude --help` | captured; flags listed above confirmed present (`--json-schema`, `--session-id`, `--fork-session`, `--permission-mode`, `--permission-prompts`, `--max-budget-usd`, `--worktree`, `--bare`, `--restricted`, `--safe-mode`, `--no-session-persistence`, `--fallback-model`, `--effort`) |
| `claude auth status` | JSON, `loggedIn: true`, `authMethod: oauth_token` |
| `claude -p "/usage" --output-format stream-json --verbose` | exit 0, 0 tokens, text report, **no** `usage_report` field (credential lacks profile scope) |
| `claude -p "Reply with the single word ok" --model haiku ... stream-json` | exit 0; `rate_limit_event` with `unifiedWindows.five_hour` and `.seven_day` utilization and reset times; result with `total_cost_usd`, `usage`, `modelUsage`, `terminal_reason: "completed"` |

Not tested: hitting a limit (exit code, exact JSON), `setup-token` (needs a browser), `--resume`/`--fork-session`, `--json-schema`, `--worktree`, parallel runs, the OAuth usage endpoint, statusline under `-p`, Agent SDK packages.

---

## 4. Recommended design for the budget scheduler

1. **Primary signal: `rate_limit_event` from every worker's stream-json output.** Always run workers with `--output-format stream-json --verbose`. Keep one shared `UsageState { five_hour: {utilization, resetsAt}, seven_day: {...}, status, isUsingOverage, observedAt }`, updated from the newest event of any worker. Parse `unifiedWindows` when present, else the top-level `rateLimitType`/`utilization`/`resetsAt`. Utilization here is a 0-1 fraction; `/usage` and statusline use 0-100.
2. **Probe when idle or stale.** Before dispatching after a quiet period (state older than N minutes, or a `resetsAt` has passed), run the one-word Haiku probe (about 3 k cached input tokens, 4 output tokens). If the server uses a full `/login` credential, prefer `claude -p "/usage"` and read `usage_report` (zero tokens, also gives per-model weekly rows and credits); fall back to the probe when the field is absent.
3. **Admission control, not prediction.** Start a new packet only if `five_hour.utilization < 1 - reserve5h` and `seven_day.utilization < 1 - reserveWeek` (reserves are company/owner settings). Add a weekly pacing rule: allowed weekly utilization grows linearly with elapsed fraction of the 7-day window, so agents cannot spend the human's week on day one. Re-check between packets, and mid-run on each event: on crossing the threshold stop dispatching, let running workers finish their turn or send SIGINT.
4. **Learn cost per packet.** Record utilization delta and `total_cost_usd` per run to estimate "percent of window per dollar-equivalent"; use `--max-budget-usd` and `--max-turns` as per-worker hard caps so one runaway worker cannot eat the reserve. Limit parallelism (2-3) so deltas between observations stay small.
5. **Limit-hit handling.** Do not set `CLAUDE_CODE_RETRY_WATCHDOG` (or set it with a short `..._MAX_USAGE_LIMIT_WAIT_MS`), so a worker fails fast instead of sleeping for hours. On `status: "rejected"` / `api_error_status 429` / non-zero exit with "hit your ... limit": record `resetsAt`, pause dispatch until then, resume the session later with `--resume <session_id>`. Treat `overloaded`/529 and "Server is temporarily limiting requests" as transient, not quota. Stop immediately if `isUsingOverage` becomes true (paid credits).
6. **Robustness.** Pin the Claude Code version and re-verify the event shape on upgrade (undocumented `unifiedWindows`; `--bare` may become the `-p` default and breaks OAuth). Preflight with `claude auth status`. Ensure no `ANTHROPIC_API_KEY` in the environment. Keep the "headless draws from subscription windows" assumption configurable (the June 2026 split is paused, not cancelled).

---

## Sources

Official:
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/statusline
- https://code.claude.com/docs/en/agent-sdk/typescript (SDKRateLimitEvent, SDKUsageReport, SDKResultMessage, usage_report conditions)
- https://code.claude.com/docs/en/agent-sdk/python (RateLimitEvent, RateLimitInfo)
- https://code.claude.com/docs/en/agent-sdk/overview, /agent-loop, /cost-tracking, /structured-outputs, /sessions
- https://code.claude.com/docs/en/errors (Usage limits; retry watchdog variables)
- https://code.claude.com/docs/en/env-vars
- https://code.claude.com/docs/en/authentication (setup-token, precedence)
- https://code.claude.com/docs/en/commands (/usage, /status)
- https://code.claude.com/docs/en/hooks (StopFailure)
- https://code.claude.com/docs/en/worktrees, /sessions, /costs
- https://code.claude.com/docs/en/legal-and-compliance
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

Secondary:
- https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/
- https://www.theregister.com/ai-ml/2026/05/14/anthropic-tosses-agents-into-the-api-billing-pool/5240748
- https://docs.rs/crate/claude-usage/0.2.3/source/README.md (unofficial OAuth usage endpoint)
- https://docs.rs/crate/cship/1.7.1/source/src/usage_limits.rs (same)
