# qm (yc-software/qm): what it is, and what Scope Soup could learn from it

Research of 2026-11-24, read-only: the README, AGENTS.md, CONTRIBUTING.md, SECURITY.md, docs/SPEC.md, docs/loop-ingestion.md and parts of src/loops, src/decisions and scripts/select-ci.ts of https://github.com/yc-software/qm. Its code was not run. Paths below are inside that repository.

**In short:** qm is not a backlog or coding-agent tool, so it is not a competitor. A few of its ideas and one process are worth taking.

## 1. What qm is

- "A multiplayer agent harness for teams. In Slack and on the web" (README.md): an always-on assistant platform for a whole company. Each person and each room gets its own scoped memory, files, credentials, cron jobs, web apps and sandbox.
- Mainly a general work assistant (inbox triage, internal apps, search, background jobs). Working in a repository, opening pull requests and watching CI is one listed use, not the point.
- Made by "QM contributors" in the GitHub organisation yc-software; the docs are at labs.ycombinator.com/qm (Y Combinator is inferred from those names). MIT licence.
- Very active: created 2026-07-29, about 15.8k stars, 1.96k forks, 27 contributors, about 1,100 open issues, commits daily. Version 0.1.0, published on npm as @yc-software/qm.
- Stack: TypeScript run directly on Node 24+, Fastify, Postgres (required), the Pi agent loop with many model providers, Slack (Bolt), a web UI in Lit and Vite, sandboxes on E2B, Superserve, DigitalOcean, AWS and others, deployed to Render, Fly, AWS or Porter. A CLI, a desktop app and an iOS app.

## 2. How it works

- A central core (API, identity, policy, scheduler) takes requests from Slack and the web UI.
- A turn is a durable run: a worker claims a queued run from a Postgres run queue, and that claim is the only lock on the session. The agent loop calls a small fixed set of tools; `execute` runs commands in the scope's own sandbox. Results go into an append-only item log in Postgres (docs/SPEC.md, "Agent turns").
- Also: subagents and swarms, crons, watches and webhooks, scopes with explicit grants, a security posture per organisation (Strict, Auto, Dangerous), content screening, shared skills, memory behind an interface.
- Everything team-specific is in a "deployment directory" that the `qm` CLI checks and deploys (cli/README.md, docs/deploy-directory.md).
- "Loops" (src/loops/, docs/loop-ingestion.md) are the nearest thing to a backlog: a Loop takes events (schedule, signed webhook, Slack, Gmail), keeps a ledger of items, triages them (priority, duplicates grouped), drafts outputs, and sends each through a "ship gate": a policy that sends it automatically or holds it for a person, plus "grants" that let one kind of action go automatically after a person approved it once. A governor watches each Loop's health. Loops sit behind a feature flag that is off by default, and SPEC.md calls them over-built, so treat them as preview grade.

## 3. Overlap with Scope Soup

- Both put agents on a queue of work items, triage and prioritise them, and group duplicates.
- Both keep an append-only log as the source of truth.
- Both ask a person before irreversible actions, with graded autonomy: Scope Soup's levels 0 to 4; qm's postures and ship-gate grants.
- Both have agent-readable repository instructions (AGENTS.md, CLAUDE.md).
- The setting differs: Scope Soup is one local program per project (SQLite, Items in git or GitHub Issues, Claude Code, a board for a developer); qm is a hosted multi-tenant service (Postgres, many models, users who are mostly not developers).

## 4. Differences

- **qm has, Scope Soup does not:** Slack, multi-tenant scopes and grants, durable sandboxes, many model providers, swarms, memory, web apps, cron and webhook triggers, a CLI that deploys to clouds, native apps.
- **Scope Soup has, qm does not:** backlog work on a software project end to end (triage, implement in a work clone, a second agent's review), a batching merge queue with flake rerun and bisect, per-Item branches and workspaces, Items in the repository or GitHub Issues, questions that come with what was tried, options and a recommendation, usage forecasting against a Claude subscription, a local design with no login.
- qm's "merge queue" is GitHub's own merge queue plus `scripts/select-ci.ts`, which picks the tests a change can reach. No batching or bisect code was found (a firm reading, not exhaustive).

## 5. Ideas worth taking

1. **Tests picked by import graph** (`scripts/select-ci.ts`): map changed files to the tests they can reach; run everything when package, lock or CI files change; the queue runs it on the exact commit that will land. Would make Scope Soup's check per batch faster.
2. **Grants that graduate one kind of action** (`src/loops/ship-gate.ts`, `decideShip`): each kind of action is declared auto or hold; a person's approval can be kept as a grant tied to that action and a policy version, void when the policy changes, revocable. A finer step than raising a whole level.
3. **A health watcher per lane** (`src/loops/governor.ts`): healthy, degraded, failing, quarantined; throttles or quarantines after 3 failed runs in a row, or when more than half of the outputs a person reviewed were sent back (at least 4 decisions). Could pause one of Scope Soup's lanes by itself.
4. **Named review lenses** (docs/SPEC.md, `.github/workflows/wall-of-shame.yml`, the "wall of shame"): over-engineering, band-aid fix, duplication, config-matrix growth, historylessness, each with real past pull requests as examples; some always reviewed, some checked by CI from the diff, with a report required in the pull request. A strong template for Scope Soup's reviewer prompt.
5. **Smaller ones:**
   - A written ranking rule in the triage prompt (`src/loops/triage.ts`: rank by how soon a person must act; group only when one piece of work resolves all).
   - New automatic rules start in "observe" mode before they enforce (`src/decisions/decisions.ts`: named points like turn_end with a fixed set of actions, observe or enforce).
   - A run claim is the only lock and fences its writes (docs/SPEC.md): check Scope Soup's sessions keep the same single-owner rule.
   - Expire stale things instead of retrying them forever (SPEC.md, "Delivery retries"): for stale questions and notices.
   - Contributions as a short written proposal (CONTRIBUTING.md: a human-written .md in adrs/, implemented by agents): a shape for taking feature requests from others.

**To avoid:** SPEC.md itself lists config-matrix growth and "god files" as past mistakes; its zero-comments rule (AGENTS.md) is a house choice; an older attended/unattended split was still being removed, a warning against building permissions on "is a person watching"; its churn and scale are far beyond what Scope Soup needs.

## 6. Use or integration

- As a dependency: no. It needs Postgres, runs as a service and is a platform, not a library.
- As a provider or host: unlikely. It has no coding-agent-on-a-backlog interface Scope Soup could drive; its signed-webhook Loops could take events from Scope Soup, but there is no reason to.
- Copying small pieces (the select-ci logic, ship gate, governor): MIT is compatible with Scope Soup's MIT; keep the copyright notice in copied code. Writing the ideas anew needs nothing.
- Unsure: whether Y Combinator owns it (inferred), and how much of Loops is in real use.
