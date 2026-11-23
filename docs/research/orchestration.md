# Research: T3 Code, elephant-goldfish-model, and the state of orchestration

Written 2026-11-21. Read-only research: nothing was changed in the repository, and no Items were filed or commented on.

## 1. Summary

- **T3 Code is a different product from Scope Soup, and it is worth a row in the README table.** It is a fast, open-source control panel for coding agents you run yourself (Claude Code, Codex and about ten others), on desktop, web and phone. A person starts every thread, approves actions and presses the commit or PR button. It has no backlog that gets worked through on its own, no review stage, no landing queue and no risk classes. What Scope Soup should take: push notifications to the phone when work needs the person, a usage view broken down by model, replay-backed tests of the agent runner, and maybe an MCP endpoint so outside agents can work with Items.
- **elephant-goldfish-model (EGM) is a design-review method, not an orchestrator.** One agent with all the context (the elephant) writes a spec. Reviewers with no memory of the conversation (goldfish) check it in five stages. A person approves the spec before any code is written. It fits Scope Soup's planned Steer level and could be used alongside Scope Soup. Its best ideas for Scope Soup: the author may *contest* a finding with evidence instead of always complying; settled findings stay settled; a review loop stops when a new finding would undo an earlier fix; and a "zoom out" reviewer whose only job is to cut over-engineering.
- **Guardrails: strict at the boundary, loose inside.** The evidence favours a few hard limits enforced by the environment (a sandbox, no pushes, no production access, checks run by the harness) and few rules written in prose. Prose rules cost tokens and make tasks harder. Scope Soup's core rules already follow this pattern. Its prompts do not: the per-command micro-rules, and the gap between what prompts say and what the allowlists permit, caused several of yesterday's interventions.
- **Roles: keep the deterministic orchestrator, a strong first read (ingestion), one implementer and a reviewer with fresh context. Do not add a standing tech-lead agent.** Its useful jobs fit inside ingestion (plan, scope, fence) and a periodic zoom-out and drift job. The role to shrink is the LLM checklist: most of its rules can become code checks. A centralised orchestrator contains errors. Parallel writers and agents chatting freely with each other do badly.
- **Nobody has published a controlled study of role splits for coding.** What exists: multi-agent systems use about 15 times the tokens of a chat; separate reviewers do catch real bugs; and the right harness changes with each model generation. Scope Soup can only answer the owner's "which constellation" questions by measuring itself: cost per role, rounds per Item, owner stops, interventions, reverts.
- **Cheaper models: partly.** A cheap model checked by a strong one does gain, but the strong model sets the quality ceiling. Anthropic's advisor results and Cognition's 2026 report agree on this. Use cheap models where a deterministic check catches their mistakes (small implementation with tests, re-triage of what changed). Use strong models where mistakes compound unseen (first triage, review). Switch to a stronger model after a failed round rather than spend more cheap rounds.
- **Claude Code itself now covers much of the session layer Scope Soup built by hand,** and Scope Soup should build on it. The docs list subagent definitions with their own model and tools, hooks, worktree isolation, auto mode, scripted "dynamic workflows" and a background "agent view". Projects (beta, cloud-only) adds an LLM coordinator with threads, a board of who needs you, and PRs that fix their own CI failures. What Claude Code does not do: keep durable Items across days on one's own machine, land through a check or a batching queue, assign risk classes, ask only owner-only questions, or pace the 5-hour and weekly windows. Its coordinators are LLMs, and the docs say limits given to them are "not enforced settings". Scope Soup's README row for Claude Code is out of date and should be updated (section 5).
- **Bottlenecks others focus on:** human review time (the most cited, now measured), spec and intent quality, verification, and context engineering. **What Scope Soup has underweighted:** the reliability and observability of its own harness. Yesterday most interventions were the keeper's own plumbing (invisible loops, overwritten results, lost work, refused commands) or first-pass triage. Agents writing poor code caused few of them. A second gap is the owner's review cost for owner-risk changes, where nothing yet prepares a short guide to the change.

---

## 2. T3 Code

**What it is.** T3 Code ([pingdotgg/t3code](https://github.com/pingdotgg/t3code), MIT; repo created 2026-02-08, about 68 000 stars and pushed to daily as of 2026-11-21) calls itself "the open-source control plane for coding agents". A Node WebSocket server on your machine wraps the agent CLIs you are already signed in to: Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, Kiro and others, plus any ACP agent. It serves one interface to an Electron desktop app, a web app and native iOS and Android apps. It resells no tokens. Its AGENTS.md claims over 500 000 users (the project's own figure).

**How it runs agents.** The unit is a **thread**: one durable conversation in a project, made of **turns**. Each thread can work in its own git worktree. You can switch provider in the middle of a thread, and the switch writes an explicit "context handoff" artifact ([orchestration-v2 docs](https://github.com/pingdotgg/t3code/tree/main/docs/orchestration-v2)). An orchestrator MCP server lets an agent inside T3 Code spawn sub-agents on any provider, wait for them, start other threads, and **schedule recurring work**. Agents started outside T3 Code (Claude Code in a terminal, ChatGPT) can join over the same MCP server ([outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)).

**Queueing, review and landing.** There is no backlog and no queue. Work is whatever threads the person starts. Review means the person reads the diff of a turn or a branch. Landing means the person presses commit, push, or open PR, with the text written by a cheap "text generator" model ([source control](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md), [text generation](https://github.com/pingdotgg/t3code/blob/main/docs/user/text-generation.md)). No agent reviews a change, no merge queue exists, and no CI is run by the tool.

**What the person sees and decides.** Four **permission modes** per thread: Supervised, Auto-accept edits, Auto (the provider's own classifier approves routine actions), and Full access, which is the default. Approvals and questions appear in the thread, including those from sub-agents. Phone push notifications fire when an agent finishes, fails, needs approval or asks a question, and Android 16 shows them as Live Updates ([mobile notifications](https://github.com/pingdotgg/t3code/blob/main/docs/user/mobile-notifications.md)). A Usage page combines token use across providers, with cache savings and estimated API-equivalent cost by model ([usage](https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md)).

| | T3 Code | Scope Soup |
|---|---|---|
| Unit of work | Thread (a conversation) | Item (issue or git-stored), with change, verdicts and sessions |
| Who starts the next step | The person, every turn | The keeper, a deterministic loop |
| Backlog worked through unattended | No | Yes |
| Agent review | None built in | Checklist, then a strong reviewer, then fix rounds |
| Landing | Person presses commit, push or PR | Check on newest main, fast-forward push or batching queue with bisect |
| Risk classes, autonomy per area | No (permission modes per thread) | Yes (low or owner; Steer, Assume, Auto planned) |
| Human interface | Desktop, web, native phone apps, push notifications | Web board on localhost; Your turn list |
| Providers | About 12, switchable mid-thread | Claude Code only |
| Usage | Dashboard of past use, API-equivalent cost | Forecast of the 5-hour and weekly windows, reserve, pacing |
| Remote | Core feature (LAN, Tailscale, own tunnel) | Localhost only (decision 26) |
| Isolation | Worktree per thread | Worktree or pool of full clones per Item |
| Persistence | SQLite event store with projections | SQLite cache plus append-only per-Item logs in git |

**Where they overlap:** worktree per unit of work, an event-sourced store, using the person's subscription, a usage view, a phone-friendly UI. **Where they differ:** T3 Code makes *one person driving agents* fast. Scope Soup makes *agents keep going without the person*. They are complements: a Scope Soup user could use T3 Code for the hands-on sessions that `pnpm item take` covers today.

**What Scope Soup should take.**
1. **Notifications that reach the phone.** A notice was added when Scope Soup is idle waiting on the owner. T3 Code shows how far this can go: alerts for "needs you", "failed" and "finished", and a live card. Scope Soup is localhost-only, so a push service the owner already has (for example a self-hosted ntfy, or a Windows toast to start with) is the practical route. This is about the owner's attention, Scope Soup's second bottleneck.
2. **Replay-backed tests of the agent runner.** T3 Code's V2 rule is that orchestration tests replay recorded provider streams, and the only stand-in is the transport. Several of yesterday's interventions were runner and cycle bugs that tests with fakes did not catch (one was a fake queue that accepted what the real one refuses). Recording real `claude -p` stream-json sessions and replaying them is the same idea.
3. **Usage by role and model, in API-equivalent cost.** Scope Soup forecasts windows. It does not yet show cost per role or per Item, which section 4 says it needs in order to tune itself.
4. **A cheap text generator for mechanical text.** T3 Code writes commit messages and PR text with a cheap model from the staged diff. Scope Soup spent fix rounds on commit bodies. A deterministic step after the session ("write the why for each commit from the diff and the session summary") would remove the cause rather than police it.
5. **Maybe later: an MCP endpoint for Items.** T3 Code lets outside agents read and start threads over MCP. Scope Soup has `pnpm item` for Claude Code sessions, and an MCP endpoint would let any agent file, take and hand back Items. This is low priority while there is one laptop.

**README table:** yes. Suggested row: *T3 Code: Does well: one fast interface for many agent CLIs on desktop, web and phone, approvals and alerts on the phone, a worktree per thread. Leaves out: a backlog worked through on its own, agent review, a landing queue, whose turn it is.*

---

## 3. elephant-goldfish-model

**What it is.** [google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) (EGM). Apache-2.0; created 2026-09-13; about 21 700 stars; last pushed 2026-11-20; marked "not an officially supported Google product". It is a **plugin of skills and reviewer prompts** for Claude Code, Codex, Antigravity, Cursor, Copilot, Windsurf and OpenCode. Its tagline is "Design with an elephant. Review with a goldfish." It comes from Dave Rensin's 2026 essay of the same name. It does not run code, keep a backlog or land anything.

**How it organises work.**
- **Elephant:** the main agent with the whole conversation. It brainstorms, then drafts a design document section by section, pausing for the person's feedback after each one. Artifacts are files: `concepts_brief.md`, `design_draft.md`, and approved specs in `docs/designs/`.
- **Goldfish:** read-only subagents with **no conversation history** that read only the document and the files it references. If the harness cannot start a fresh subagent, EGM *stops* rather than review in the same context ([review design](https://github.com/google/elephant-goldfish-model/blob/main/docs/designs/review.md), 2026-06-10). The reason given: a model reviewing in the context it drafted in assumes what it remembers is on the page.
- **Five review stages**, each with its own reviewers: zoom out (a "Skeptical Architect" hunting YAGNI and reinvention) together with an inventive catalyst (TRIZ, a method for resolving trade-offs); comprehension (a naive reader); critics (design, structure, style); a *second* zoom out that prunes the defensive additions the critics caused; then implementation readiness (a "Tech Lead Auditor" requiring every file to be listed as an explicit write boundary with a test plan) and a codebase auditor that checks named APIs exist. A **synthesizer** runs reviewers in parallel, removes duplicate findings and writes one report.
- **Resolve:** for each finding the elephant answers PROPOSE FIX, CONTEST (cite evidence the reviewer could read), ESCALATE (only outside knowledge refutes it, so the person decides) or DECLINE (a nit, recorded and not fixed). Comprehension gaps cannot be contested. Settled findings stay settled across rounds. A round is clean with no unsettled blocker or major finding. The loop ends after **two clean rounds**, or asks the person at **5 rounds** or **when a new finding would be resolved by reverting an earlier fix**.
- **Hand-off to people:** the person picks the triage mode (accept all fixes, walk through them, inline comments on the artifact, or ad-hoc questions), approves the design, and only then asks for implementation. EGM-Lite ([lite](https://github.com/google/elephant-goldfish-model/blob/main/docs/designs/lite.md), 2026-11-10) is a short path for small changes: critique, a checklist, scoped execution, an adversarial review of the diff by a fresh reviewer, then resolution.
- **Drift report:** compares checked-in design docs with the code and lists missing features, incomplete models and so on, as a ritual "gardening" task ([drift](https://github.com/google/elephant-goldfish-model/blob/main/docs/designs/drift_report.md)).
- **Evidence:** the repo has `test_scenarios.yaml` benchmarks for its skills, but publishes no results. The FAQ is candid: design review "can" become a human bottleneck, and the person should measure total time and rework on their own tasks. Treat EGM as a well-built practice, not proven gains.

| | EGM | Scope Soup |
|---|---|---|
| Phase | Design, before code (Lite also covers small code changes) | Whole loop, from Item to main |
| Runs on its own | No; a person drives every phase in chat | Yes |
| Memory | The elephant's conversation plus design files | Item text, log, graph; sessions start fresh |
| Review | 5 stages, about 9 personas, fresh context required | Checklist, then one strong reviewer, fresh context |
| Finding handling | Fix, contest, escalate or decline; settled stays settled | Every `must` goes to a fix round |
| Loop end | 2 clean rounds, 5 rounds, or oscillation, then ask the person | Persistence limits; no-progress rule |
| Human gate | Approves the design before code | Owner-risk changes, decisions, plans (Steer, planned) |
| Docs vs code | Drift report | Not covered (design rules in review) |
| Landing, CI, backlog | None | Core |

**What Scope Soup should take.**
1. **Let the fixer contest a finding.** Today a `must` finding sends the change to a fix round, and the fixer has to comply. EGM's CONTEST, which needs evidence the reviewer could have read, and ESCALATE, which hands the question to the owner, would cut rounds spent on wrong findings. Scope Soup already lets agents push back on the *Item*, and this extends the same idea to *findings*. It bears on cases where rounds were used up on trivia.
2. **Settled findings stay settled, and oscillation stops the loop.** Scope Soup's checklist already does not count *new* findings against the limit. EGM adds: a finding that was contested or declined is not raised again, and a finding whose fix would revert an earlier fix goes to the owner. That is a precise, cheap signal of "no progress", the gap described earlier.
3. **A zoom-out reviewer for bloat.** Nothing in Scope Soup's review asks "is this more than the Item needs, and does something in the codebase already do it?" EGM gives it a persona of its own and runs it again after the critics, because reviews themselves add defensive code. Either add it as one question to the strong review, or run it on large Items only.
4. **Implementation readiness equals the fence.** EGM's readiness check requires every file to be listed with a reason and a test plan. That is exactly what the fence needs from ingestion: paths the change should touch, checked by the program afterwards.
5. **The drift report as a periodic Item.** Scope Soup's docs are large (DESIGN.md is 42 kB, RUNNING.md 48 kB), and one intervention showed design rules living "in people's heads". A weekly cheap-model job that compares docs with code and files what it finds as an Item is a good fit for spare quota.
6. **Use EGM for Steer.** For a new area, the plan step could simply invoke EGM's draft and review skills in the planning session, rather than Scope Soup writing its own plan reviewer.

**README table:** it fits, but as a different kind of tool. Suggested row: *elephant-goldfish-model: Does well: reviewing a design with fresh-context reviewers in stages, and a human-approved spec before any code. Leaves out: running the work, a backlog, review of the code, landing, CI.*

---

## 4. Orchestration, state of the art

A caveat first: the field is moving fast, and most "evidence" about orchestration for *coding* is vendor engineering blogs or single-team reports. Peer-reviewed controlled studies exist mostly for general multi-agent systems or narrow benchmarks. Each claim below says which kind of evidence it rests on.

### 4.1 Stricter guardrails, or fewer and looser?

**Answer:** fewer rules overall, but the ones that remain should be hard and enforced by the environment, not written in the prompt. Inside a sandbox, give the agent more freedom, and check its output with deterministic verifiers afterwards.

**Evidence.**
- Anthropic's sandboxing post (2025) says sandboxing cut permission prompts by 84% in internal use. Its auto-mode post (2026) says users approve 93–97% of prompts anyway. That means per-action approval mostly trains people to click yes. In Anthropic's testing, humans caught 13.6% of dangerous commands and the auto-mode classifier caught 89% ([sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing), [auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)). *Vendor data.*
- **Prose rules have a cost.** The ETH Zurich study "Evaluating AGENTS.md" (arXiv 2602.11988, Feb 2026, ICLR 2026) found that repository context files did not raise task success and *tended to lower it*, and raised inference cost by over 20%. LLM-written files hurt, and human-written ones helped slightly. The authors conclude that such files should "describe only minimal requirements". *Peer-reviewed benchmark, Python repos.*
- **Production teams narrow what the agent does rather than add rules.** Spotify's background agent (Dec 2025) only edits code and calls verifiers. Pushing, Slack and prompt writing are done by the surrounding infrastructure. The verifiers are hidden behind an MCP tool, so the agent "doesn't know what the verification does and how", and a stop hook blocks the PR if any verifier fails ([Spotify part 3](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3)). Stripe's Minions (2026) mix deterministic steps with agent steps in "blueprints", and secondary write-ups say CI retries are capped at two ([Stripe part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2)). *Engineering blogs.*
- Anthropic's harness posts (Nov 2025, Mar 2026) say every harness part encodes an assumption about what the model cannot do. Those assumptions go stale, so parts should be removed one at a time to find which ones carry load ([long-running harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)).

**For Scope Soup.** RULES.md already has the right shape: a code-enforced core, stages switched on after a failure, and numbers as settings. The prompts do not have that shape. Each role prompt carries five command micro-rules (one command per call, no `cd`, no chaining, use file tools, try the plain form), plus prose about commit bodies and where message files go. Those cost tokens, and when prose and allowlist disagree the agent fails: one run (told to run a command the allowlist refuses), another (told how to write a message file but not where, so the pre-approval check refused it five times) and a third (commit bodies policed after the fact). The Spotify pattern would remove the class: run the session in a sandboxed work clone with broad freedom inside it, expose "run the check" as one tool or command that Scope Soup owns, and let the harness, not the agent, do anything it can do deterministically (commit message files, cleanup of scratch files, pushing).

### 4.2 Which roles? Is a tech lead a good addition? Should a role go?

**Answer.**
- **Orchestrator:** keep it as plain code (decision 4). This is the best-supported choice in the whole report.
- **Ingestion (strong, first read):** add it. Evidence supports a planner up front.
- **Triage (cheap):** keep it only as a delta check after ingestion.
- **Implementer and fixer:** one writer at a time per Item. Treat them as one role with resumable sessions, not two personas.
- **Reviewer 1 (checklist LLM):** shrink it. Move every rule that code can judge into code, and keep the LLM only for rules that need judgement.
- **Reviewer 2 (strong, fresh context, preferably another model):** keep it.
- **Helper:** only as an *advisor* the writer can consult, and only if measured to help.
- **Tech lead:** do not add it as a standing agent. Put its jobs where they act: plan, scope and fence in ingestion; design rules in review; a periodic zoom-out and drift job for the codebase as a whole.

**Evidence.**
- **A centralised orchestrator contains errors; independent agents multiply them.** Google Research and MIT, "Towards a Science of Scaling Agent Systems" (arXiv 2512.08296, Dec 2025; blog 2026-01-28): 180 configurations. Independent agents amplified errors up to 17.2 times, and centralised ones 4.4 times, because the orchestrator acts as a "validation bottleneck". Multi-agent setups helped on parallelisable tasks (+80.9% on a finance task) and *hurt* on sequential ones (−39% to −70%). Coordination costs rise with tool count, and the authors cite a coding agent with 16+ tools. No coding benchmark was included. *Preprint, controlled.*
- **Most multi-agent failures are about organisation and verification, not model skill.** MAST (Berkeley, arXiv 2503.13657, 2025): 1600+ traces across 7 frameworks, 14 failure modes in three groups: system design, misalignment between agents, and task verification (premature stop, missing or wrong verification). *Peer-reviewed.*
- **Single-threaded writes, many readers.** Cognition argued "Don't build multi-agents" (June 2025): parallel writers make conflicting choices. Its April 2026 follow-up says what works now: writes stay single-threaded; reviewer agents with a clean context catch more (Devin Review finds on average 2 bugs per PR, about 58% severe, *vendor data*); and the advisor pattern works "when both models are strong" ([2025](https://cognition.ai/blog/dont-build-multi-agents), [2026](https://cognition.com/blog/multi-agents-working)).
- **A separate evaluator beats self-evaluation, and a planner prevents under-scoping.** Anthropic, Mar 2026: agents "reliably skew positive when grading their own work". A standalone evaluator was easier to tune toward scepticism, though even it talked itself into approving issues until its prompt was tuned. When Opus 4.6 arrived they removed sprints and moved the evaluator to one pass at the end. They *kept* the planner, because without it the generator under-scoped. *Vendor engineering blog, single team.*
- **Fresh context or another model for review.** A 2026 preprint on self-attribution bias found that models rate an action more favourably when it is implicitly their own, and most of all on incorrect code. Other work finds little self-preference. No definitive head-to-head study exists for code review. A fresh context is the well-supported part; another model is a reasonable default.
- **Claude Code's own guidance** ([Run agents in parallel](https://code.claude.com/docs/en/agents), read 2026-11-21) sorts the options by *who holds the plan*: Claude turn by turn (subagents), a lead agent (agent teams), you (agent view), or a script (dynamic workflows). Subagents are for side tasks that would flood the main context. The docs advise against them when "multiple phases share significant context" or the work needs back-and-forth. Agent teams use "significantly more tokens", are worse for "sequential tasks, same-file edits, or work with many dependencies", and should start at 3–5 teammates. The docs say to start teams on research and review, not parallel implementation. Workflows move the plan into code so that independent agents can "adversarially review each other's findings". That is the same split Scope Soup made in decision 4: a deterministic plan, with agents at the judgement points. *Vendor docs, not measurements.*
- **Tech lead:** no study compares adding a tech-lead role. The closest evidence is EGM's "Tech Lead Auditor", which is a *readiness check on the plan*, and the Anthropic planner. Both act before code is written. A tech lead that supervises sessions while they run would be the "AI session supervises" pattern Scope Soup rejected for Gas Town, and the scaling paper's sequential-task result argues against an extra hop in a sequential loop.

**For Scope Soup.** The interventions back this up. Eight of the 22 intervention Items were first-pass triage falling short, the ingestion one among them. That is the planner and ingestion slot. One was a reviewer that did not know the project's design rules, a "tech lead" piece of knowledge that belongs in the review prompt. None of them was an implementer who needed supervision while it worked. The checklist reviewer's failures came from rules that code could judge: commit bodies, scratch files, tests present.

### 4.3 Do different constellations change usage, correctness, bloat, drift and speed?

**Answer:** yes in direction, but nobody has measured it for a Scope Soup-like loop. What is known:

| Effect | What the evidence says | Strength |
|---|---|---|
| **Usage** | Agents use about 4 times the tokens of chat, multi-agent about 15 times (Anthropic, June 2025). Token volume explained about 80% of performance variance on their research eval. Agent teams cost roughly 3–4 times one session (third-party). Anthropic's full planner, generator and evaluator harness cost over 20 times a solo run (6 h and $200 against 20 min and $9) and produced a working app where the solo run did not. | Vendor, single-team |
| **Correctness** | Separate reviewers catch real defects: Devin Review averages 2 bugs per PR; Spotify's judge vetoed about a quarter of sessions, and the agent recovered about half the time. METR (2026-03-10): about half of SWE-bench-passing PRs would not be merged by maintainers, so passing tests is not enough and some review of quality is needed. | Vendor plus independent (METR) |
| **Bloat** | CodeRabbit (Dec 2025, *vendor*): AI PRs had 1.7 times as many issues, and performance problems almost 8 times as often. GitClear (2025 and 2026, *vendor*): duplication up, refactoring down. Faros (2025): PRs 154% larger with high AI adoption. No study shows a role that reduces bloat. EGM's zoom-out persona is the only explicit design for it. | Vendor, correlational |
| **Drift** (scope creep inside an Item) | Spotify's judge most often fired on the agent going outside the instructions. Anthropic: the planner keeps scope, and sprint contracts kept scope until the model got better. | Engineering blogs |
| **Drift** (docs and code over time) | EGM drift report; Anthropic progress files. No measurements. | Practice only |
| **Speed** | Sequential multi-agent hops hurt sequential tasks (scaling paper). Each review round adds wall time. Anthropic's harness took hours. | Preprint plus blog |

**For Scope Soup.** The owner's question can only be answered with Scope Soup's own numbers. The trial already recorded about $0.01 per haiku session and $0.14 per sonnet review (docs/TRIALS.md). What is missing is a per-Item ledger: sessions by role and model with cost; checklist and review rounds; owner stops by reason; interventions; time from invite to landed; reverts and overturned assumptions afterwards. A short **ablation** schedule should go with it (Anthropic's advice): switch off one role or switch one model on a batch of similar Items and compare. AUTONOMY.md already defines "asked for nothing" and "overturned"; this extends the same measuring habit to cost and roles.

### 4.4 How do others handle the human in the loop?

**Answer:** the industry is converging on three things. Approval moves from each action to each *outcome*, usually the PR. Agents review the work before a human sees it. Human review time is now the measured bottleneck.

**Evidence.**
- **Gate at the PR, not the action.** GitHub Copilot's coding agent opens a PR. The person who asked for it cannot approve it, and Copilot cannot approve or merge it. CI workflows wait for a maintainer's approval unless an admin turns that off, which became an option on 2026-03-13 ([docs](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations), [changelog](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/)). Stripe: over 1000 merged PRs a week written entirely by agents, all reviewed by a human. Spotify: humans review the PRs the agent opens.
- **Gate at the design, for big things.** EGM: the person approves the spec before any code. Anthropic's harness: the planner sets the spec. Both match Scope Soup's Steer level.
- **Per-action approval is mostly theatre.** People approve 93–97% of prompts (Anthropic). T3 Code still offers per-action modes but defaults to Full access, and adds phone alerts for the moments that matter.
- **Agents ask too little.** Ambig-SWE (arXiv 2502.13069, ICLR 2026): on underspecified SWE-bench tasks, interaction with the user improved results by up to 74%. Most models default to not asking and are poor at telling vague tasks from clear ones, and prompting alone helped little. That argues for a *structural* moment of asking, which is ingestion, rather than hoping the implementer asks.
- **Claude Code's native surfaces** (docs read 2026-11-21) follow the same pattern. Agent view groups background sessions under *Needs input*, *Working* and *Completed*, notifies when a session needs input, finishes or fails, and lets you peek and reply without attaching. Its sessions push a branch and may open a draft PR, but "never merges", never pushes to `main` and never force-pushes; the person merges "when its number turns green". Projects has an Overview with *Ready for review*, *Waiting on you*, *Working* and *Landing*. It runs threads in auto mode, watches each PR, fixes CI failures and review comments ("auto-fix"), and puts "what needs your go-ahead" in the project instructions. Those instructions are, in the docs' words, "not enforced settings". Permission prompts from subagents and teammates surface in the parent session.
- **Review is the bottleneck.** Faros AI (2025, telemetry from over 10 000 developers): with high AI adoption, 98% more PRs were merged and review time rose 91%. Secondary coverage of their 2026 report gives +441% median review time and 31% more PRs merged without review. *Vendor, correlational.* METR's randomised trial (2025) found experienced developers 19% slower with early-2025 tools. METR now calls that result historical and says its 2026 follow-up data are unreliable because of selection effects.

**For Scope Soup.** Scope Soup's design is ahead of most of these on "ask only what only you can answer": decisions arrive prepared, there is assume-and-tell, autonomy per area, and only the affected Item waits. It is behind in two places. (1) **Reach:** the board is localhost and the owner has to look at it (the idle notice helps; T3 Code shows the full version). (2) **Cost of the owner's review:** an owner-risk change arrives as a diff plus verdicts. Nothing prepares a one-screen "review guide": what changed, why, where to look, what the reviewer was unsure of, what was assumed. T3 Code generates review guides. EGM opens every human-facing phase with a plain one-paragraph summary ("BLUF", bottom line up front). Given the Faros data, this is the cheapest lever on the owner's time.

### 4.5 Can orchestration reach the same results with cheaper models?

**Answer:** not the same, but close enough in specific slots. A cheap model guided or checked by a strong one gains a lot, but the strong model sets the quality ceiling. Cheap models work where a deterministic check catches their mistakes.

**Evidence.**
- Anthropic's advisor strategy (2026-04-09; *vendor*): Sonnet with an Opus advisor scored 2.7 points higher on SWE-bench Multilingual than Sonnet alone, at 11.9% lower cost per task. Haiku with an Opus advisor scored 41.2% on BrowseComp against 19.7% for Haiku alone, still well below Sonnet solo, at 85% lower cost. No Haiku result on SWE-bench was published ([advisor](https://claude.com/blog/the-advisor-strategy)).
- Cognition (Apr 2026): a cheaper *primary* model with escalation was capped by the weaker primary. The advisor pattern worked only when both models were strong.
- Routing research: SWE-Router (2026) lets a cheap model explore for a few turns, then a learned head decides whether to hand over to a strong model, with large savings on SWE-bench Verified. TurnCost (2026) warns that reported routing savings come mostly from short tasks, and that switching models loses the prompt cache. Both are *preprints*.
- The scaffold matters less than the model. mini-SWE-agent (about 100 lines, bash only) reaches over 74% on SWE-bench Verified with a frontier model (*self-reported*). Simple loops are not the limit; model strength is.
- Claude Code's docs (read 2026-11-21) offer the controls but have become *more* conservative about cheap models. Each subagent definition has a `model` field, and the docs suggest routing tasks "to faster, lower-cost models like Haiku". But the built-in Explore subagent now runs on Opus by default, not Haiku. Projects defaults to Opus everywhere: high effort for threads, low effort for the coordinator. Workflows ask you to name smaller models only "for stages that don't need the strongest one". The pattern is a strong model for the work and low effort, not a weak model, for coordination.
- Anthropic's research system: an Opus lead with Sonnet workers beat Opus alone by 90.2% on their research eval. That is strong-over-strong, on a parallel task.

**For Scope Soup.** The current defaults (haiku for triage, implement and fix; sonnet for review) put the cheap model in the slot where mistakes compound unseen, first-pass triage. That is where most interventions came from (the list of interventions includes a haiku answer that ran its fields together and parked with "No reason given"). A better allocation by the evidence: **strong for ingestion and review; cheap for re-triage of what changed, small implementations with tests, rebase and mechanical text; and switch the writer to the stronger model after the first failed fix round instead of spending all the cheap rounds.** That last rule is a simple cascade with a deterministic trigger: the check failed, or the same finding came back. It is cheaper to build and easier to trust than a learned router.

### 4.6 Which bottlenecks do others focus on? Did Scope Soup miss one?

**What others focus on (2025–2026):**
1. **Human review and attention:** Faros, Cognition's "scale human taste", Copilot's PR gate. Scope Soup has this as bottleneck two.
2. **Spec and intent quality:** spec-driven development (EGM, Anthropic's planner, Ambig-SWE). Scope Soup is building this as ingestion and plan first.
3. **Verification and feedback loops:** Spotify, Stripe, and Anthropic's evaluator. Scope Soup has this as review, the check and the queue.
4. **Context engineering:** Cognition, Anthropic's progress files, the AGENTS.md study. Scope Soup covers it partly (Item graph; design rules).
5. **CI throughput:** Stripe shifts checks left, and the batching queues. Scope Soup has this as bottleneck three, and few others treat it as central.

**What Scope Soup underweights:**
- **The harness's own reliability and observability.** This is the main finding of this report. Of the 22 intervention Items, about nine were the keeper's own plumbing, not agent quality: pre-approval checks overwriting each other and refusals never logged; a loop running over an hour with 742 retries and nothing on the board; a flaky test or check taken as real; scratch files blocking checks; work thrown away at escalation; a command the agent was told to run but not allowed to; fix-round accounting that punished the owner's send-back; an answer resuming the wrong step. Others treat the harness as a product with its own tests: T3 Code uses replay-backed orchestration tests and probes of real provider behaviour, and Anthropic says to re-check the harness on every model release. Scope Soup's README names three bottlenecks for the *project*. A fourth, for Scope Soup itself, is that **the keeper must be at least as reliable as the agents it runs, and must make its own stalls visible.** Progress counting started this, and it should become a standing design rule: every repeated step has a counter, every refusal is an event, and every rest keeps the work.
- **Measuring itself.** Without per-role cost and outcome data, the owner's questions (roles, models, guardrails) are argued from blogs like this one rather than from Scope Soup's own runs.
- **The owner's review cost on owner-risk changes** (section 4.4): a review guide.
- **Long-term codebase health** (bloat, docs drift). Every check is per-Item. Nothing looks at the whole codebase over weeks. This matters more as autonomy grows to Auto.

---

## 5. Scope Soup compared with Claude Code's own agent features

Source: [Run agents in parallel](https://code.claude.com/docs/en/agents) and the pages it links on [subagents](https://code.claude.com/docs/en/sub-agents), [agent view](https://code.claude.com/docs/en/agent-view), [agent teams](https://code.claude.com/docs/en/agent-teams), [dynamic workflows](https://code.claude.com/docs/en/workflows) and [Projects](https://code.claude.com/docs/en/claude-projects). All read 2026-11-21. The agent view and Projects pages were longer than one fetch, so their tail sections (including agent view's "Limitations") were not read.

**What Claude Code now offers.** Five ways to run several tasks at once:
- **Subagents:** fresh-context workers inside one session, each with its own `model`, `tools`, hooks, optional worktree isolation and optional persistent memory. They can nest up to three levels deep, with 20 running at once by default.
- **Agent view** (`claude agents`, research preview): background sessions under a supervisor process that survives restarts and sleep. Each session moves into its own worktree before it edits. Rows show *Needs input*, *Working* and *Completed*, with PR check status, and notifications fire when a session needs input, finishes or fails.
- **Agent teams** (experimental, off by default): an LLM lead with peer sessions, a shared task list with dependencies, mailboxes, and `TeammateIdle` and `TaskCompleted` hooks as quality gates. There is no resume, and the docs call it a poor fit for sequential work.
- **Dynamic workflows:** a JavaScript script runs up to 16 agents at once and up to 1000 per run, with schema-checked outputs, automatic restart of stalled agents, a pause when a usage limit is hit, and resume within the session. The docs list "no mid-run user input" among its limits.
- **Projects** (public beta, Pro, Max and Ultra, cloud): an LLM coordinator starts threads, mostly cloud sessions, each on its own branch and PR. Project memory and instructions are shared. An Overview shows *Ready for review*, *Waiting on you*, *Working*, *Landing* and *Resolved*. Threads auto-fix CI failures and review comments on their PRs.

| Scope Soup part | Covered natively by Claude Code? | Notes |
|---|---|---|
| Agent session in an isolated workspace | **Yes** (worktrees, agent view's automatic worktree, subagent `isolation: worktree`) | Scope Soup's pool of full clones for a submodule project (decision 27) is still its own |
| Role prompts with a model and tools per role | **Yes** (subagent definitions: `model`, `tools`, `disallowedTools`, `permissionMode`, hooks, `effort`) | Scope Soup could ship its roles as subagent definitions instead of long prompts plus allowlists |
| Fresh-context reviewer | **Yes** (a fresh subagent; a workflow fan-out with adversarial cross-checks) | Claude-only, so no model diversity outside Claude models |
| A loop that keeps going without the person | **Partly.** Workflows inside one session; Projects with an LLM coordinator; teams with an LLM lead | No deterministic loop that outlives the session and picks the next backlog Item. A Projects coordinator's limits are "not enforced settings" |
| Durable Items over days | **Partly.** Projects keeps threads and memory in the cloud; team task lists stay on disk but are session-scoped | No tracker that lives in the project's own repository (decision 23) and can be read without the tool |
| Board of whose turn it is | **Partly.** Agent view and the Projects Overview show who needs you | Lists *sessions* waiting, not *decisions* prepared with options and a recommendation. No assume-and-tell, no autonomy per area |
| Landing through the project's check | **No.** Sessions push branches and open PRs; a person merges; Projects auto-fixes CI | No fast-forward landing after a check on newest main, and no batching queue with flake rerun and bisect |
| Risk classes, owner-only decisions | **No** (permission modes and auto mode work per *action*, not per *change*) | |
| Budget windows, forecast, reserve | **No.** Workflows pause at a usage limit; Projects warns that it uses limits faster | No pacing across the 5-hour and weekly windows, and no reserve kept for the owner |
| Append-only audit log in plain words | **No** (transcripts, run state) | |
| Local-only, no cloud (decision 26) | Agent view, subagents and workflows: **yes**. Projects: **no**, cloud first | Projects does not fit the work use as decided |

**Where Scope Soup still adds value.** The deterministic, long-lived keeper over a durable backlog; landing that keeps main green (check on newest main, fast-forward, batching queue); risk classes and decisions surfaced as prepared questions; usage pacing against the subscription windows; and Items that live in the project's own repository. These are exactly the parts the docs show Claude Code does not attempt. Claude Code's coordinators (team lead, Projects coordinator) are LLMs, which decision 4 rules out for supervising and merging. Its deterministic option (workflows) is bound to one session and takes no input from the person mid-run.

**Where Scope Soup overlaps and should stop building its own.** Session isolation, per-role models and tools, hooks as gates, stall restarts, and the sandbox and auto mode all exist now in the harness Scope Soup already runs. Agent view's states and notifications also overlap the board's live-session view, though agent view is a terminal tool on one machine.

**README row for Claude Code: update it.** Today's row says Claude Code leaves out "a board of whose turn" and work "worked through on its own over days". That is no longer quite true. Suggested row: *Claude Code: Does well: writing and reviewing code; subagents with their own model and tools; background sessions with a needs-input view (agent view); scripted multi-agent workflows; Projects (cloud) with an LLM coordinator and PRs that fix their own CI. Leaves out: a deterministic loop over a durable backlog kept in the repository; landing through a check or a batching queue; risk classes and prepared owner decisions; pacing across the 5-hour and weekly windows.*

---

## 6. Recommendations for Scope Soup (ranked)

| # | Recommendation | Expected effect | Cost | Kind |
|---|---|---|---|---|
| 1 | **Ingestion on a strong model**, extended to output the fence (paths and size), the readiness checks (EGM's implementation-readiness questions), and every decision at once. Keep cheap triage only for deltas. | Removes the largest class of yesterday's interventions (8 of 22). One strong session per Item, small next to fix rounds and owner round trips. | Medium | Already proposed; owner confirms scope |
| 2 | **Make harness reliability a design rule:** every repeated step counted, every refusal an event, every rest keeps uncommitted work, every idle-on-owner visible. Add a "harness health" line to the board (repeats, refusals, stuck packets). | Turns silent stalls into Items, not hours lost. Generalises earlier fixes. | Small per rule; the board line is small | Small change plus one rule in DESIGN.md |
| 3 | **Per-Item cost and outcome ledger:** cost by role and model, rounds, stops by reason, interventions, time to land, later reverts. Show it on Usage and the Item page. | Lets the owner answer such questions from data; prerequisite for 6 and 7. | Small to medium (the data mostly exists in session events) | Small change |
| 4 | **Move checklist rules into code where possible** (commit bodies, tests present, scratch files, paths inside the fence). Generate commit bodies in a deterministic post-step. Keep the LLM checklist only for rules that need judgement. | Fewer rounds and tokens; removes failures of that type. | Small each | Small changes |
| 5 | **Align guardrails with the sandbox:** run sessions with Claude Code's sandbox in the work clone, cut the per-command micro-rules from the prompts, give one Scope Soup-owned "run the check" command (Spotify-style), and have `config:check` refuse a prompt that names a command the allowlist refuses. | Removes the prose-versus-allowlist failure class; shorter prompts. | Medium | **Design decision** (changes the security model of sessions) |
| 6 | **Model cascade on failure:** cheap writer first; after one failed fix round or a repeated finding, switch the writer to the stronger model. Ingestion and review strong by default. | Cheap where cheap works, strong where it pays off. Measurable with 3. | Small (role settings plus one rule) | **Design decision** on defaults |
| 7 | **Findings can be contested or declined** (EGM resolve): the fixer may contest with evidence, contested and declined findings stay settled, and a fix that would revert an earlier fix escalates. | Fewer wasted rounds; precise no-progress signal. | Small to medium | Small change to the prompt and fold |
| 8 | **Review guide for owner-risk hand-overs:** one screen with a plain summary first, what changed, where to look, what was assumed, and what the reviewer was unsure of. | Cuts the owner's time per hand-over, the industry's top bottleneck. | Small (one cheap session, or part of the review answer) | Small change |
| 9 | **Notifications beyond the board:** owner-turn, failed and stuck alerts through a channel that reaches the phone (Windows toast first, then a self-hosted push such as ntfy). | Fewer idle hours (one case showed 40 min). | Small to medium | **Design decision** (decision 26 says localhost only) |
| 10 | **Periodic zoom-out and drift job:** weekly, on spare quota, compare docs and design rules with code, look for duplication and dead code, and file the findings as Items. | Counters bloat and docs drift as autonomy grows. | Small | Small change |
| 11 | **Replay-backed runner tests:** record real `claude -p` sessions and replay them in the cycle and runner tests. | Catches bugs of that class before a trial does. | Medium | Small change in tooling |
| 12 | **Build on Claude Code primitives rather than reimplement them:** (a) ship each role as a subagent definition (model, tools, effort, hooks) started with `claude -p --agent`, replacing the per-command prompt rules; (b) use a `Stop` hook running the project's verifiers so a session cannot finish with a red check (the Spotify pattern, native); (c) run sessions in auto mode or the sandbox inside the work clone; (d) for broad reviews of large Items, run a saved dynamic workflow (parallel lenses with an adversarial cross-check) as the review step instead of writing a fan-out in Scope Soup. | Less Scope Soup code to maintain; enforcement moves from prose to the harness; follows Claude Code releases for free. | Small to medium each; needs a check of which features work in `claude -p` (teams do not; workflows do, without prompts) | (a) to (c) small changes; (d) **design decision** on review depth |
| 13 | **Update the README's Claude Code row and say why Scope Soup exists next to agent view and Projects.** | Keeps the pitch honest as Claude Code grows. | Small | Small change |
| 14 | **Re-check the harness on each model release:** a short ablation (drop one role or switch one model on a batch of Items) using the ledger. | Keeps roles from going stale (Anthropic's lesson). | Small, recurring | Process; owner decides cadence |

Not recommended now: a standing tech-lead agent; parallel writers on one Item; free chat between agents; a learned router; building on agent teams (experimental, no resume, not available in `claude -p`) or on Projects (cloud, against decision 26).

---

## 7. Proposed follow-up Items (not created)

1. **Add T3 Code and elephant-goldfish-model to the README's existing-tools table.**
   Two rows as worded in sections 2 and 3. Closes the README part of two interventions.
2. **Ingestion returns the fence and readiness, not only decisions** (extends the first-pass triage).
   The ingest answer lists the paths and size the change should stay within, and an implementation-readiness check (files, test plan). The program uses the paths for the fence.
3. **Per-Item cost and outcome ledger.**
   Record cost by role and model, rounds, owner stops by reason, interventions, time to land and later reverts. Show it per Item and summed by role on the Usage page.
4. **Checklist rules that code can judge are checked by code.**
   Commit bodies, tests present, scratch files and paths outside the fence become program checks before the LLM checklist. Only judgement rules stay with the model.
5. **Harness health: no silent repeats, refusals or lost work** (design rule plus board line).
   Write the rule in DESIGN.md and add a board line counting repeats, refusals and stuck packets. Any repeated step without a new result escalates.
6. **The fixer may contest a finding with evidence; settled findings stay settled.**
   Add contest, decline and escalate to the fix answer, following EGM's resolve. A new finding that would revert an earlier fix goes to the owner.
7. **Switch the writer to a stronger model after a failed fix round** (owner decision on defaults).
   Cheap first, strong on the second try, with ingestion and review strong by default. Compare cost and rounds using item 3.
8. **Review guide on owner-risk hand-overs.**
   A one-screen guide with a plain summary first: what changed, where to look, assumptions, reviewer doubts. Shown at the top of the Item page when it is the owner's turn.
9. **Sandboxed sessions with fewer prompt rules** (owner design decision).
   Run sessions in Claude Code's sandbox inside the work clone, drop the per-command micro-rules, and give one Scope Soup-owned check command. `config:check` refuses a prompt that names a refused command.
10. **Weekly zoom-out and drift Item on spare quota.**
    A cheap session compares docs and design rules with code and looks for duplication and dead code. It files what it finds as Items.
11. **Roles as Claude Code subagent definitions, with a Stop hook for the check.**
    Each role becomes an agent definition (model, tools, effort, hooks) run with `claude -p --agent`, and a `Stop` hook runs the verifiers. Removes the per-command prompt rules and the prompt-versus-allowlist gap.
12. **Update the README's Claude Code row for agent view, workflows and Projects.**
    Use the row in section 5, and add one line on why Scope Soup is still needed: a durable local backlog, landing through a check or queue, risk classes, pacing.

---

## 8. Sources

**Projects**
- T3 Code, [github.com/pingdotgg/t3code](https://github.com/pingdotgg/t3code): README, AGENTS.md, docs/user/* (permission modes, source control, usage, mobile notifications, outside agents, text generation), docs/orchestration-v2/*. Read 2026-11-21; repo created 2026-02-08.
- elephant-goldfish-model, [github.com/google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model): README, docs/designs/review.md (2026-06-10), drift_report.md (2026-06-07), lite.md (2026-11-10), docs/faq.md, agents/*.md. Read 2026-11-21; repo created 2026-09-13.
- mini-SWE-agent, [github.com/SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) (self-reported scores, 2025–2026).

**Claude Code documentation** (all read 2026-11-21; the pages are versioned with Claude Code releases)
- [Run agents in parallel](https://code.claude.com/docs/en/agents): comparison of subagents, agent view, agent teams, dynamic workflows and Projects.
- [Subagents](https://code.claude.com/docs/en/sub-agents), [Agent view](https://code.claude.com/docs/en/agent-view) (research preview; first 100 000 characters read), [Agent teams](https://code.claude.com/docs/en/agent-teams) (experimental), [Dynamic workflows](https://code.claude.com/docs/en/workflows), [Projects](https://code.claude.com/docs/en/claude-projects) (public beta).

**Papers**
- Kim, Liu et al., "Towards a Science of Scaling Agent Systems", [arXiv 2512.08296](https://arxiv.org/abs/2512.08296), Dec 2025; [Google Research blog](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/), 2026-01-28.
- Cemri et al., "Why Do Multi-Agent LLM Systems Fail?" (MAST), [arXiv 2503.13657](https://arxiv.org/abs/2503.13657), 2025.
- Gloaguen et al., "Evaluating AGENTS.md", [arXiv 2602.11988](https://arxiv.org/abs/2602.11988), Feb 2026 (ICLR 2026).
- Vijayvargiya et al., "Ambig-SWE: Interactive Agents to Overcome Underspecificity in Software Engineering", [arXiv 2502.13069](https://arxiv.org/abs/2502.13069), v3 Feb 2026 (ICLR 2026).
- SWE-Router, [arXiv 2607.00053](https://arxiv.org/abs/2607.00053), 2026; TurnCost, [arXiv 2610.15093](https://arxiv.org/pdf/2610.15093), 2026 (preprints, read as abstracts).
- Agentic PRs on GitHub: AIDev dataset [arXiv 2507.15003](https://arxiv.org/abs/2507.15003) (2025); failed agentic PRs [arXiv 2601.15195](https://arxiv.org/abs/2601.15195) (2026); task-stratified acceptance [arXiv 2602.08915](https://arxiv.org/abs/2602.08915) (2026). Consulted for background; acceptance rates vary with filtering, so none were used in conclusions.
- Self-attribution bias in agent review: [arXiv 2603.04582](https://arxiv.org/abs/2603.04582) (2026 preprint, read as summary).

**Independent evaluations**
- METR, "Many SWE-bench-passing PRs would not be merged into main", [note](https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/), 2026-03-10.
- METR, early-2025 developer productivity RCT ([arXiv 2507.09089](https://arxiv.org/abs/2507.09089), July 2025) and [uplift update](https://metr.org/blog/2026-02-24-uplift-update/), 2026-02-24.

**Engineering blogs (vendor or single-team evidence)**
- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), 2025-06-13.
- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), Nov 2025.
- Anthropic, [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps), 2026-03-24.
- Anthropic, [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing), 2025; [Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode), 2026.
- Anthropic, [The advisor strategy](https://claude.com/blog/the-advisor-strategy), 2026-04-09.
- Cognition, [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents), 2025-06-12; [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working), 2026-04-22.
- Spotify, [Background coding agents, part 3: feedback loops](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3), 2025-12-09. Later reports that the judge was dropped are secondary only ([InfoQ, 2026-03](https://www.infoq.com/news/2026/03/spotify-honk-rewrite)).
- Stripe, [Minions part 1](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents) and [part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2), 2026. The retry-cap detail is from secondary write-ups.
- GitHub, [Copilot coding agent risks and mitigations](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations) (docs, current); [changelog: optionally skip workflow approval](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/), 2026-03-13.
- Claude Code [agent teams docs](https://code.claude.com/docs/en/agent-teams.md) (experimental, 2026). Cost multipliers are from third-party guides.

**Industry reports (vendor, correlational)**
- CodeRabbit, [State of AI vs Human Code Generation](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report), 2025-12-17.
- GitClear, [AI code quality research](https://www.gitclear.com/ai_assistant_code_quality_2025_research), Feb 2025, and [2026 follow-up](https://gitclear.com/the_ai_code_quality_maintainability_gap).
- Faros AI, [AI Productivity Paradox Report 2025](https://www.faros.ai/blog/ai-productivity-paradox-report-2025), 2025.

**Scope Soup (local and issues)**
- README.md, docs/DESIGN.md, docs/AUTONOMY.md, docs/RULES.md, docs/DECISIONS.md, docs/TRIALS.md, prompts/*.
- Intervention Items, as listed with `gh issue list --label intervention`, 2026-11-20 to 2026-11-21.
