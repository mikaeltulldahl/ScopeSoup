# Research: Claude Code's `/ship` and `/steward`

Written 2026-11-25 from Anthropic's public docs only. Nothing was run, so nothing here is "tried". Where the docs are silent, section 4 says so.

## 1. What `/ship` does

`/ship` is a built-in command for a local terminal session. It does not run in the cloud ([`/ship`](https://code.claude.com/docs/en/ship-command.md), [troubleshooting](https://code.claude.com/docs/en/ship-command-troubleshooting.md)). It takes the work in the session through four steps:

1. **Commit and push.** Claude writes the commit message from the session. On the default branch it makes a new branch first. Then it pushes. Esc cancels before the commit and before the push. Secrets are checked by file name only.
2. **Open a GitHub PR.** No confirmation is asked.
3. **Review.** It runs `/code-review`, a forked subagent in the background. Effort is `low` to `max`, default `high` ([`/code-review`](https://code.claude.com/docs/en/code-review-local.md)).
4. **Watch.** It starts `/steward --tend`, a recurring task in the session. The watch fixes failing checks and re-runs them. It answers review comments from people with write access and resolves the threads. When the PR conflicts, it merges the base branch in. Then it pushes.

`/steward` is step 4 alone, for a PR that is already open.

The watch ends when the PR is merged or closed, after 7 days, on Esc, `/clear`, a new `/ship`, a declined prompt, an error or a usage limit. It does not survive `claude --continue`.

**Merging.** Claude never merges on its own. Merge, approve, auto-merge and force-push are blocked while it acts without a message from you. Auto-merge that you switched on yourself can still merge the PR.

## 2. Limits

- Needs CLI 2.1.330 or newer, `gh` 2.63 or newer signed in, and git 2.38 or newer.
- GitHub only for the PR. On GitLab, Bitbucket and Azure DevOps only the review and the watch work.
- Not handled: forks, GitHub Enterprise, draft PRs, PR templates, base branches other than the default.
- No watch on native Windows, in `bypassPermissions` mode, in plan mode or in a background session.
- One watch per session, in the same checkout. For parallel work, use another clone and another session.
- Claude's own git writes skip the repository's hooks (`core.hooksPath=/dev/null`).
- No plan requirement is documented. Admins can turn it off with `skillOverrides` (`ship-local` and `steward` set to off) or `CLAUDE_CODE_DISABLE_SHIP=1`. It arrives through feature flags, so a variable that disables flag fetching hides it.
- A merge queue or batching is not mentioned anywhere.

**Org products.** Three are separate from the commands: Code Review, PR Steward and Claude Approvals ([overview](https://code.claude.com/docs/en/claude-ship.md)). PR Steward is a GitHub App for Team and Enterprise plans, paid from usage credits, and designed not to approve or merge ([setup](https://code.claude.com/docs/en/pr-steward-setup.md)). `/autofix-pr` is a cloud auto-fix that needs the Claude GitHub App ([Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web.md)).

## 3. Compared with Scope Soup

Scope Soup is a server with a web board that works through a project's backlog with coding agents, and asks a person only when needed ([`docs/DESIGN.md`](../DESIGN.md)). `/ship` is one session finishing one change. They do not compete much.

| | `/ship` and `/steward` | Scope Soup |
|---|---|---|
| Scope | One change, in one session | A backlog of Items, kept across days |
| Triage, restructuring, drafts | None | Level 1: size, questions, draft description, proposed restructuring |
| Who writes and who reviews | The same session, then a background `/code-review` | A separate implementor and a separate reviewer, each in its own worktree or clone |
| Review rounds | One review; the watch answers comments | Rounds of findings, marked must or should, back to the implementor |
| Merging | Never on its own; you or your auto-merge | Levels 2 and 3: the implementor merges. Level 4: Scope Soup's merge queue, in batches checked against the newest `main` |
| Hosts | GitHub for the PR; others review and watch only | GitHub issues, or Items on a Jira or git meta branch |
| Windows | No watch on native Windows | Runs on Windows |
| Agent CLI | Claude Code | Claude Code or GitHub Copilot CLI |
| Hooks | Skipped for Claude's own git writes | Never skipped; `--no-verify` and force pushes are refused |
| Needs you at the keyboard | Yes, the session stays open | No |

## 4. What Scope Soup could use

- **`/code-review` as the reviewer role.** It has effort tiers. Worth a trial (run headless, if the CLI allows it: not confirmed) against the reviewer prompt: findings per round, cost, how often a fix round was needed.
- **The watch idea at levels 2 and 3.** Once a PR is open, something has to fix its failing checks, answer comments and merge the base branch in. Scope Soup's fix rounds do part of this inside a session. A long-lived watch on each open PR would cover the time after the implementor has finished.
- **The same line on merging.** "Never merge unasked" matches Scope Soup's levels: only level 4 merges by itself, and only through the queue ([`docs/RULES.md`](../RULES.md)). The wording in the `/ship` docs is a good model for ours.

## 5. Could not confirm

The public docs do not say:

- whether the watch works with a merge queue, or with batches;
- whether a session in a git worktree can run a watch, or two worktrees of one repository can run two;
- how many review rounds the watch or `/code-review` will do before it stops;
- whether it works under WSL, or only the Linux and macOS side counts as "not native Windows".
