# Research: which agent CLIs Scope Soup can drive

Written 2026-11-23 for the provider choice. Read-only research from official docs, source code and release pages. No CLI was installed, signed in to or run, so nothing here is "tried": where the docs are silent, the text says so. Doc pages from the vendors carry no date unless noted; "fetched 2026-11-23" applies to every link.

## 1. Summary

- **Recommendation: Codex CLI is the second provider.** It is the only candidate that meets five of the six points with a personal subscription that its vendor allows a local program to use: a JSON Lines event stream with a thread id, resume by id, `--output-schema`, a sandbox on Windows that needs no admin rights on current Windows 11, and the 5-hour and weekly windows readable by a program. Its gap is the core rule: Codex holds commands with a **sandbox** (writes only in the workspace, no network) and **deny rules**, not an allowlist of commands. Scope Soup would have to accept "sandbox plus deny list" as meeting "commands are limited", or not use Codex for writing roles. That needs a person's decision (section 5).
- **Gemini CLI enforces an allowlist best** (its policy engine turns every "ask" into "deny" in headless mode), but it has no JSON-schema output and no readable usage, and since 2026-06-18 Google has moved free and Google One users to Antigravity CLI. It is a fair reviewer-only candidate for people on a paid Gemini Code Assist licence.
- **Antigravity CLI has the best feature fit on paper** (stream-json, `--conversation <id>`, `--json-schema`, allow/deny/ask rules, a sandbox) but its own FAQ says wrapping `agy` in another application "is not supported under consumer plans" and calls third-party access a ToS violation. Ruled out for personal subscriptions until Google says otherwise.
- **GitHub Copilot CLI** is the runner-up: it denies in `-p` mode every tool not allowed with `--allow-tool` (a real allowlist), resumes by id and prints JSONL. It has no schema output and no readable usage.
- **Cursor CLI and OpenCode** both run headless and resume, but neither has schema output or readable usage, and their command limits are weaker (Cursor lets any sandboxed command run; OpenCode's base policy allows everything and has no sandbox).

## 2. How Scope Soup drives `claude` today (what a provider must match)

From `src/orchestrator/roles.ts` (`buildCommand`), `stream.ts`, `runner.ts` and `fixtures/fake-claude.ts`:

| Coupling point | What Scope Soup does with Claude Code |
|---|---|
| 1. Start and stream | `claude -p` with the prompt on stdin, `--output-format stream-json --verbose`, `--model`, `--max-turns`. A defensive NDJSON parser reads `system/init` (session id), assistant actions, `rate_limit_event` and the final `result` (`is_error`, `subtype`, `structured_output`, permission denials). |
| 2. Resume | `--resume <session id>` for fix rounds and chat. |
| 3. Command limits | `--permission-mode dontAsk`, `--allowedTools` from `roles.<role>.allowedTools` (for example `Bash(git diff *)`), and `--disallowedTools` for force pushes and `--no-verify` at every level. A command not on the list is refused by the CLI. |
| 4. Usage | `rate_limit_event` in the stream: status, utilization and reset time of the 5-hour and weekly windows. A limit hit becomes session status `limit` with a resume time. |
| 5. Structured output | `--json-schema`; the run fails if no answer fits. |
| 6. Test fake | `fake-claude.ts`, a Node script put on PATH that prints canned NDJSON by mode (`ok`, `limit`, `hang`, ...). |

## 3. Candidates

### 3.1 Codex CLI (OpenAI)

Version: 0.171.0, released 2026-11-20 ([releases](https://github.com/openai/codex/releases)). Open source (Apache-2.0).

1. **Headless and events.** `codex exec "<task>"` (or `codex exec -` to read the prompt from stdin). Progress goes to stderr, the final message to stdout. `--json` prints JSON Lines: `thread.started` (`thread_id`), `turn.started`, `turn.completed` (`usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`), `turn.failed` (`error.message`), `item.started` / `item.updated` / `item.completed`, and `error` (`message`, fatal). Item types: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error`. The final answer is the last `item.completed` with an `agent_message`. `-o <file>` also writes it to a file. Errors are free text only: there is no subtype that says "usage limit". Sources: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) (formerly developers.openai.com/codex/noninteractive), [`exec_events.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs) (last changed 2026-09-17).
2. **Resume.** `codex exec resume <SESSION_ID> "<prompt>"` or `--last`; the id is `thread_id` from `thread.started`. `--ephemeral` writes no session files, which also rules out resume. Source: same page, [`cli.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs).
3. **Command limits.** Three layers, all enforced by the CLI:
   - Sandbox: `--sandbox read-only` (the `exec` default), `workspace-write` or `danger-full-access`. Network is off in `workspace-write` unless `network_access = true`. On Windows the `mxc` implementation needs no admin and no extra accounts, on Windows 11 24H2 build 26100.9278 / 25H2 build 26200.9278 or later; the older `elevated` mode needs admin-approved setup, `unelevated` does not but isolates the network less well ([Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox), mentions CLI 0.162.0).
   - Rules: `prefix_rule(pattern = ["git", "push"], decision = "forbidden")` in `~/.codex/rules/*.rules`; strictest match wins. `allow` means "run outside the sandbox without asking", not "only these may run". Rules are marked experimental ([rules](https://learn.chatgpt.com/docs/agent-configuration/rules)).
   - Approval policy: `exec` defaults to `never` ([`exec/src/lib.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs)). In the source, a command that matches no rule is **allowed** under `never` "relying on the sandbox"; only commands Codex itself flags as dangerous are forbidden ([`core/src/exec_policy.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs), `render_decision_for_unmatched_command_for_platform`). The policy that asked for every unlisted command, `untrusted`, is retired in the docs ([approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)) though the app-server schema still lists it.
   - So: **no default-deny command allowlist.** A Codex implementor can run any program inside the worktree, without network.
   - Likely trap, not confirmed in current official docs: `workspace-write` keeps `.git` (and a worktree's `gitdir` pointer) read-only, so `git commit` fails inside the sandbox. Third-party mirrors of the docs and the sandbox source (`read_only_subpaths` in [`linux-sandbox/src/bwrap.rs`](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/src/bwrap.rs)) point that way. Scope Soup's implementor commits today (`Bash(git *)`); with Codex, Scope Soup would commit for it or add the repository's git directory to `writable_roots`.
4. **Usage.** Not in `exec --json`. Readable by a program through `codex app-server` (JSON-RPC on stdio): `account/rateLimits/read` returns `rateLimits.primary` / `secondary` with `usedPercent` (0 to 100), `windowDurationMins` (300 and 10080 in practice) and `resetsAt`, plus `planType` and `rateLimitReachedType`; `account/rateLimits/updated` pushes changes ([`GetAccountRateLimitsResponse.ts`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/GetAccountRateLimitsResponse.ts), [`RateLimitWindow.ts`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/RateLimitWindow.ts)). The app-server is partly marked experimental. The same snapshot sits in `token_count` events (`rate_limits`) in the session files under `~/.codex/sessions` ([`protocol.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)); several third-party usage tools read those, which is not a documented contract.
5. **Structured output.** `--output-schema <file>` (a JSON Schema) constrains the final message; also `outputSchema` on app-server `turn/start`. Whether a non-conforming answer fails the run is not documented.
6. **Sign-in.** `codex login` with a ChatGPT plan (browser callback on localhost port 1455) or `codex login --device-auth`; credentials in `~/.codex/auth.json` or the OS keyring (`cli_auth_credentials_store`). Install via npm or a standalone binary, no admin. Network: OpenAI's endpoints only. Source: [auth](https://learn.chatgpt.com/docs/auth). OpenAI documents ChatGPT sign-in for third-party clients too (OpenCode's [providers](https://opencode.ai/docs/providers/) page offers "Sign in with ChatGPT"), so a local program driving `codex` with the person's plan is not against the grain.

Second route: `codex app-server` gives one long-lived process with `thread/start`, `thread/resume`, `turn/start` (with `approvalPolicy`, `sandboxPolicy`, `outputSchema`), approval requests sent to the client (`item/commandExecution/requestApproval`), and rate limits. It covers points 1 to 5 in one protocol, but it is a bigger and partly experimental surface; `exec --json` is the closer match to Scope Soup's process-per-session runner.

### 3.2 Gemini CLI (Google)

Version: 0.70.0, released 2026-11-19 ([releases](https://github.com/google-gemini/gemini-cli/releases)). Open source. Every doc page carries a banner: Gemini CLI "was replaced by Antigravity CLI on June 18th, 2026" for unpaid-tier and Google One users.

1. **Headless and events.** `gemini -p "<prompt>"` with `--output-format json` (one object: `response`, `stats`, `error`) or `stream-json`: `init` (`session_id`, `model`), `message` (`role`, `content`, `delta`), `tool_use`, `tool_result` (`status`, `error`), `error` (`severity`, `message`), `result` (`status`, `error`, `stats` with tokens per model). Exit codes 0, 1, 42 (bad input), 53 (turn limit). Sources: [headless](https://geminicli.com/docs/cli/headless/) (updated 2026-03-10), [`output/types.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts).
2. **Resume.** `--resume <uuid | index | latest>`; `--session-id <uuid>` starts a session with a chosen id, which saves parsing it. Sessions kept 30 days by default ([session management](https://geminicli.com/docs/cli/session-management/), updated 2026-06-18).
3. **Command limits.** Policy engine: TOML rules in `~/.gemini/policies/` or `--policy <file>`, `toolName = "run_shell_command"` with `commandPrefix` or `commandRegex`, decision `allow` / `deny` / `ask_user`, and **`ask_user` is treated as `deny` in non-interactive mode**. With `--approval-mode default`, every shell command not allowed is therefore refused: a real allowlist. `--allowed-tools` is deprecated in favour of the policy engine. A `--sandbox` flag exists (container or macOS Seatbelt; not checked on Windows). Source: [policy engine](https://geminicli.com/docs/reference/policy-engine/) (updated 2026-04-30), [`config.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts).
4. **Usage.** Token counts only. The CLI fetches quota internally (`retrieveUserQuota` in `code_assist/server.ts`) for its UI, but nothing documented prints it in headless output.
5. **Structured output.** No JSON-schema flag (none in `config.ts`).
6. **Sign-in.** Google account login (cached), Gemini API key, or Vertex AI. The [authentication page](https://geminicli.com/docs/get-started/authentication/) (updated 2026-09-18) still lists Google AI Pro and Ultra, while the banner says Google One users moved to Antigravity; Google AI Pro is sold through Google One, so whether a personal Pro plan still works in Gemini CLI could not be confirmed.

Test aid: hidden flags `--fake-responses <file>` and `--record-responses <file>` replay model responses.

### 3.3 Antigravity CLI (`agy`, Google)

Version: 1.5.14, released 2026-11-21 ([releases](https://github.com/google-antigravity/antigravity-cli/releases)).

1. **Headless.** `agy -p` with `--output-format json | stream-json`: `init` (once), `step_update` (`conversation_id`, `state`, `step_type`, `tool_info`, `usage`), `result` (`status`: `SUCCESS`, `ERROR`, `CANCELED`, ...; `structured_output`; `usage`). Permission requests that cannot be approved are soft-denied and the run continues ([headless](https://antigravity.google/docs/cli/headless)).
2. **Resume.** `--conversation <id>` or `-c`.
3. **Command limits.** `permissions.allow` / `deny` / `ask` with `command(git)` or `command(regex:...)`, Deny > Ask > Allow, rules apply in and out of the sandbox ([permissions](https://antigravity.google/docs/permissions)). Since v1.5.7 the headless default mode is `auto`, so it must be pinned (`--mode`). What an unlisted command does in `-p` with `default` mode is implied (soft-deny) but not stated.
4. **Usage.** `/usage` shows a 5-hour and a weekly limit per model group, interactive panel only ([usage](https://antigravity.google/docs/cli/commands/usage)).
5. **Structured output.** `--json-schema` (string, file or primitive type).
6. **Sign-in.** Google OAuth into the OS keyring; Free, Pro and Ultra personal plans; Workspace plans excluded ([authenticate](https://antigravity.google/docs/install)). **Blocking:** the [FAQ](https://antigravity.google/docs/faq) says wrapping `agy` in third-party applications "is not supported under consumer plans" and that third-party access can lead to suspension; it points third-party agents to an API key. Forum answers conflict ([example thread](https://discuss.ai.google.dev/t/is-external-orchestration-of-antigravity-cli-headless-mode-supported-with-account-based-usage/183051)). No Windows download is listed in the docs index.

### 3.4 GitHub Copilot CLI

Version: 1.0.114, released 2026-11-18 ([releases](https://github.com/github/copilot-cli/releases)).

1. **Headless.** `copilot -p "<prompt>"`, `--output-format json` gives JSONL; the event schema for `-p` runs is not documented (only for `copilot workflow run`). Non-zero exit on interruption or an empty final answer ([programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)).
2. **Resume.** `--resume=<SESSION-ID>`, `--continue`, `--session-id`.
3. **Command limits.** `--allow-tool='shell(git:*)'`, `--deny-tool`, `--allow-url`; "requests that still require your approval are denied in non-interactive runs". A real allowlist enforced by the CLI. No sandbox documented.
4. **Usage.** Not documented in programmatic output.
5. **Structured output.** Not documented.
6. **Sign-in.** `copilot` login with a GitHub account that has Copilot, or a token in `COPILOT_GITHUB_TOKEN` / `GH_TOKEN`. npm install, no admin ([run programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)).

### 3.5 Cursor CLI (`agent`)

No version or date on the doc pages; the CLI auto-updates.

1. **Headless.** `agent -p` with `--output-format json | stream-json`: `system/init`, `assistant`, `tool_call` (`started`, `completed`), `result` ([headless](https://cursor.com/docs/cli/headless)).
2. **Resume.** `--resume [chatId]`, `agent create-chat` returns an id first ([parameters](https://cursor.com/docs/cli/reference/parameters)).
3. **Command limits.** `permissions.allow` / `deny` with `Shell(commandBase)` (first word, or `Shell(curl:*)`), deny wins ([permissions](https://cursor.com/docs/cli/reference/permissions)). In print mode "shell commands run if they're allowlisted **or can run in the sandbox**", so with the sandbox on it is not an allowlist; with it off, unlisted commands are rejected.
4. **Usage.** None documented.
5. **Structured output.** None.
6. **Sign-in.** `agent login` with a Cursor account, or `CURSOR_API_KEY`. Native Windows install by a PowerShell script into the user profile ([installation](https://cursor.com/docs/cli/installation)); admin rights not stated.

### 3.6 OpenCode

Version: 2.3.2, released 2026-11-18 ([releases](https://github.com/anomalyco/opencode/releases), formerly sst/opencode).

1. **Headless.** `opencode run --format json "<message>"`; it talks to a shared background server it starts per user, or `--standalone` ([CLI](https://opencode.ai/docs/cli/)). The JSON event schema is not documented on the page.
2. **Resume.** `--session <id>` (created if missing), `--continue`, `--fork` (flag list in [`commands.json`](https://github.com/anomalyco/opencode/blob/dev/packages/cli-rs/crates/cli/tests/fixtures/commands.json)).
3. **Command limits.** `permissions` rules (`action: "shell"`, `resource: "git push *"`, `effect: allow | deny | ask`), last match wins, but the base policy allows everything and there is no sandbox; what `ask` does in `run` without `--auto` is not documented ([permissions](https://opencode.ai/docs/permissions/)).
4. **Usage.** None documented. 5. **Structured output.** None.
6. **Sign-in.** ChatGPT Plus/Pro, GitHub Copilot (device login), OpenCode Go, or API keys. It is a second way to reach a ChatGPT plan, but through one more layer than Codex itself.

Not covered further: Qwen Code (a Gemini CLI fork), Amp, Kiro CLI, Grok CLI. Each has a headless mode, but none was found to offer schema output plus readable usage, and their subscriptions are less likely to be what a Scope Soup user already pays for.

## 4. Table

✓ = documented and fits Scope Soup; ~ = partly; ✗ = not available or not documented.

| | Codex CLI 0.171 | Gemini CLI 0.70 | Antigravity 1.5.14 | Copilot CLI 1.0.114 | Cursor CLI | OpenCode 2.3.2 |
|---|---|---|---|---|---|---|
| 1. Headless stream, final result, errors | ✓ JSONL; errors free text | ✓ stream-json, exit codes | ✓ stream-json, status | ~ JSONL, schema undocumented | ✓ stream-json | ~ JSON, schema undocumented |
| 2. Resume by id | ✓ | ✓ (and `--session-id`) | ✓ | ✓ | ✓ | ✓ |
| 3. Allowlist enforced by CLI | ✗ sandbox + deny rules only | ✓ ask = deny headless | ✓ rules (mode must be pinned) | ✓ unlisted denied in `-p` | ~ only with sandbox off | ✗ base allows all |
| Sandbox | ✓ (Windows: no admin on 24H2+) | ~ container / Seatbelt | ✓ terminal sandbox | ✗ | ✓ | ✗ |
| 4. Subscription windows readable | ✓ app-server (experimental) | ✗ | ✗ interactive only | ✗ | ✗ | ✗ |
| 5. JSON-schema output | ✓ `--output-schema` | ✗ | ✓ `--json-schema` | ✗ | ✗ | ✗ |
| 6. Own subscription, no admin | ✓ ChatGPT plan | ~ personal plans moved to Antigravity | ✗ wrapping unsupported on consumer plans | ✓ Copilot plan | ✓ Cursor plan | ✓ several |

## 5. Recommendation: Codex CLI, and its gaps

Codex CLI is the second provider: `codex exec --json` matches Scope Soup's process-per-session runner, it has resume and schema output, its usage windows are readable, and a ChatGPT plan is a subscription many people already have. Against the six coupling points:

1. **Start and stream:** a second parser for `thread.started` / `item.*` / `turn.*` / `error`. Gap: no result subtype, so "limit hit" versus "other error" must be read from `turn.failed.error.message` text, or from the rate-limit snapshot taken just before.
2. **Resume:** `codex exec resume <thread_id>`; must not run with `--ephemeral`. No gap.
3. **Command limits:** the real gap. Codex cannot hold a session to `roles.<role>.allowedTools`. What it can enforce: `read-only` sandbox for triage and review (no writes anywhere, no network), `workspace-write` without network for the implementor, and `forbidden` prefix rules for force push and `--no-verify` (pushes fail anyway without network). Needed before building: a person decides whether that counts as meeting the core rule, or Codex is limited to read-only roles (review, first look). The `.git` write protection also has to be checked in a trial; Scope Soup may have to make the commit itself.
4. **Usage reading:** start `codex app-server` beside the session (or once per tick) and call `account/rateLimits/read`. Gap: experimental API, a second process, and not in the `exec` stream; `windowDurationMins` 300 and 10080 map onto Scope Soup's 5-hour and weekly windows.
5. **Structured output:** write the role's schema to a file for `--output-schema`, read the final `agent_message` as JSON. Gap: what happens when the answer does not fit is not documented, so Scope Soup validates it itself.
6. **Test fakes:** a `fake-codex.ts` beside `fake-claude.ts` that prints `exec --json` lines and honours `exec resume <id>`. The generated TypeScript types in `app-server-protocol/schema/typescript` help build fixtures. No gap beyond the work.

If the person decides that an enforced allowlist is a hard requirement for every role, the fallback is GitHub Copilot CLI (allowlist enforced, resume, JSONL) with Scope Soup validating answers itself instead of a schema and pacing without window data, or Gemini CLI for people on a Code Assist licence.

## 6. Not confirmed

- Whether Codex `workspace-write` blocks `git commit` in a worktree or a pool clone today (third-party mirrors and source hints only).
- Whether Codex fails a run whose answer does not fit `--output-schema`.
- Whether `account/rateLimits/read` works the same with every ChatGPT plan, and its exact cadence of `account/rateLimits/updated`.
- Whether Codex's `mxc` Windows sandbox is available on Windows 11 Home, and the admin story on older builds beyond the docs' wording.
- Whether a personal Google AI Pro plan still signs in to Gemini CLI after 2026-06-18.
- The `-p` JSON event schemas of Copilot CLI and OpenCode, and what OpenCode's `run` does with `ask`.
- Antigravity's position on local orchestrators (FAQ and forum answers conflict).
- Nothing was run: every fact is from docs or source as of 2026-11-23, and a trial on a synthetic repository should confirm points 1 to 5 for Codex before the second-provider part is built.
