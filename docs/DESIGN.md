# Design

What Scope Soup is: a server program with a web GUI that runs a software project's work loop with coding agents, for one person or a small team. It keeps work moving on its own, shows everything in one place, and asks people only for what needs them. The decisions behind this design are in `docs/DECISIONS.md`.

## Parts

```
            +--------------------- one process ----------------------+
 browser <--| server (HTTP, SSE)                                      |
            |    ^                                                    |
            |    | events                                             |
            |  store (SQLite: tables + append-only events)            |
            |    ^                         ^                          |
            |    |                         |                          |
            |  sync (poll hosts)        orchestrator (tick loop)      |
            |    |                         |        |                 |
            +----|-------------------------|--------|-----------------+
                 v                         v        v
           host adapters             queue engine   agent runner
           (GitHub, ...)             (pure)         (claude -p children)
```

| Directory | Holds | May import |
|---|---|---|
| `src/model` | The host-neutral types | nothing |
| `src/ports` | The interfaces a host adapter implements | `model` |
| `src/core` | Pure rules: lanes, turns, estimates, readiness | `model` |
| `src/queue` | The batch engine: chain, batch size, flake rerun, bisect. Pure: `(state, input) -> (state, effects)` | `model` |
| `src/store` | SQLite behind an interface; tables plus the events table | `model` |
| `src/hosts/<name>` | One adapter per host | `model`, `ports` |
| `src/orchestrator` | The tick loop, the agent runner, the usage check | everything above |
| `src/server` | HTTP, SSE, the status endpoint | everything above |
| `src/sim` | The lifecycle simulator: the real tick, store, sync and server against fakes, with the rules checked after every step (decision 120) | everything above |
| `web` | The board (Preact), built with Vite | only the server's HTTP API |

The rule that matters most: `model`, `core`, `queue` and `store` never import a host. A test checks it (`src/core/boundaries.test.ts`).

## Model

Defined in `src/model/types.ts`. The work item is the root; everything else hangs off it.

| Object | Is |
|---|---|
| Work item | A piece of work with a state, dependencies, an optional verification and a priority |
| Change | A proposed set of commits for one or more items, with revisions |
| Verdict | One judgement of one revision in one dimension (review, risk, check) |
| Run | One execution of a check on one commit (a host's CI run, or Scope Soup's own) |
| Batch | Changes tested together, with the probes of a bisect |
| Session | One agent run on an item or a change, live or finished |
| Turn | Who must act next on an item, and why |
| Budget | The usage windows, what is used and what is reserved |

## Hosts

Ports are split by capability (`src/ports/host.ts`), so a deployment can combine hosts (one for work items, one for changes, one for CI), and a host that lacks a capability does not implement that port.

- Events from a host are hints. The core always refetches. A poll, a webhook and an SSH stream are then interchangeable, and a missed event costs only delay.
- A host adapter holds no project-specific conventions; a project's own conventions would be a layer on top of it. Scope Soup's own conventions on GitHub (comment markers, `Q1:`/`A1:` replies, labels) are such a layer, `src/hosts/github/conventions.ts`; the design is [`docs/github-mapping.md`](github-mapping.md).

### Hosts and players: the switches

What Scope Soup does when a project changes its host (Settings' Connect, decision 98, and Move back, decision 99) or a machine switches between singleplayer and multiplayer (Settings' Players, decisions 93 and 98).

| Situation | What happens |
|---|---|
| 1. Singleplayer on the meta branch, Connect to Jira or GitHub | The dialog checks the token and the host, lists the open Items to tick, moves the ticked ones (new issues first, then references, history and last the old Items' close) and then writes the shared `host`; the rest stay on the meta branch. |
| 2. Multiplayer on the meta branch, Connect | The same, and each other machine keeps its own per-host parts; at its next start it reads the new host, or, lacking the token or Jira email, shows "Set up this machine for <host>" and starts no agent. |
| 5. Singleplayer, switch to multiplayer, the remote's settings name another host or project | The page shows both and asks: "Join theirs" keeps this clone's unshared Items only in `refs/scopesoup-backup/meta-<commit>` and uses the remote's; "Make mine the project's" warns that it changes every machine and puts this clone's commits on top of the remote's. |
| 6. Singleplayer on the meta branch, switch to multiplayer, the same host and project on the remote | The switch needs no question; this clone's own commits go on top of the remote's: Items merge and an id taken on both sides is renumbered. |
| 7. A new machine joins, or a project starts on Jira | Onboarding writes its private file (a new project that picks Jira gets the Jira host in its first shared settings, decision 101); a machine that lacks what the host needs shows "Set up this machine". |
| 9. Jira to GitHub, or either back | Two steps through the meta branch: "Move back to the meta branch", then Connect; Connect itself refuses to go from one to the other directly. |
| 10. GitHub or Jira, Move back to the meta branch | The dialog asks this machine's meta part (name, email, id prefix), lists the host's open issues to tick and whether they are closed or left open there; the ticked ones become Items in one meta commit (references rewritten, comments as one log line, found again by `importedFrom` on a retry), then each old issue gets a comment naming its Item and is closed or left open; only then the shared `host` becomes the meta branch. |

## Items on a meta branch

For a project whose items live in its own repository (decisions 23 and 24), the host is `src/hosts/metaBranch`. It reads one ref, `refs/scopesoup/meta` (a fixed name; the shared settings are on it too), straight from the object store with `git rev-parse`, `git ls-tree` and `git cat-file --batch`. It never checks the branch out, and fetches and writes only when writes are switched on ("Writing to the meta branch"). A repository without the ref is an empty project. The cursor of a listing is the meta commit plus the ids it returned, so a listing on an unchanged ref is free.

```
format                  the meta branch's format: a whole number and a line end
settings/settings.json  the project's shared settings: one JSON object
settings/log.jsonl      one line per save of the settings: who changed what
requests/<yyyy-mm>.jsonl  a month's picks asked of the machine that runs an Item's work, and its answers (decision 104)
items/<id>/item.md      what the item is
items/<id>/log.jsonl    what has happened to it
```

Anything else under `items/`, and any `item.md` or `log.jsonl` that is not a regular file (a symlink or submodule entry is never followed), is skipped and named in the read report. A file over 1 MB is not read: an `item.md` over it makes its item malformed, a `log.jsonl` over it counts as one malformed line.

**The shared settings** (`src/hosts/metaBranch/settings.ts`, `src/config/metaSettings.ts`). Every project has the meta ref on every host; a GitHub-host project has it for the settings alone. `settings/settings.json` holds the keys of [`RUNNING.md`](RUNNING.md), "The project's configuration". `settings/log.jsonl` is append-only like an item's log; its lines have the kind `settings` and `changes`, a list of `{ key, from?, to? }` (the dotted path of each changed value). A save is one commit by the writer, with the person who saved as author and as the line's `by`, and the two files as the only changed paths.

**The format** (decision 63, `src/hosts/metaBranch/format.ts`). `format` is a regular file holding a whole number and an optional line end; a branch without it is format 0. It is raised only for a breaking change; a new log kind or an optional field is not one. This Scope Soup is format 1. A newer format, or an unreadable file, is read only: items are read as usual and every write is refused ("this project's data is from a newer Scope Soup; upgrade"). An older format is written to as it is when every step from it only adds (true for 0 to 1); otherwise writes wait for the migration (`src/hosts/metaBranch/migrate.ts`): one commit on top of the remote's tip, pushed, made only by the machine that holds the merge queue lease (decision 31; none needed without a remote or with `SCOPESOUP_MERGE_QUEUE=off`). A new branch's first commit carries `format`.

**Ids.** The directory name is the id and the only place it comes from: a letter or digit followed by up to 63 letters, digits, `-` or `_` (`A-12`). So an id has no `.`, no path separator and no leading `-`, and cannot leave `items/<id>/` or be read by git as an option. The same rule applies to `parent` and `blockedBy`. A `sha` in a log line must be a full id: 40 or 64 lower-case hex digits.

**`item.md`** is a header between two lines that are exactly `---`, then the description in markdown.

```
---
id: A-12
title: Add a regression suite
state: doing
labels: tests, core
parent: A-3
blockedBy: A-10, A-11
verification: pnpm check runs the new suite
priority: major
---

The description.
```

The header is not YAML. What it accepts, and nothing more:

- An optional UTF-8 byte order mark; `\n` or `\r\n` line ends.
- Each line is `key: value`: a key is a letter followed by letters and digits; the value is the rest of the line after the first `:`, trimmed, taken literally (no quoting, escapes or multi-line values). Blank lines and lines starting with `#` are ignored.
- `title` and `state` are required. `state` is one of `todo`, `doing`, `waiting`, `done`, `abandoned`.
- `labels` and `blockedBy` are comma-separated lists (one pair of enclosing `[` `]` allowed).
- `id` is optional and must equal the directory name when present. `parent` is an id. `duplicateOf` is an id: an `abandoned` item closed as that one's duplicate. `verification` is one line. `priority` is `blocker`, `critical`, `major` or `minor` (none counts as `major`). `lane: backlog` puts an open `todo` item in Backlog, where no agent starts it (decision 121); no `lane` line, or `lane: todo`, is To do.
- An empty `parent:` or `priority:` means none. Other keys are kept in file order and otherwise ignored.
- Any other line, a key given twice, or a value that does not fit its field makes the item malformed. A malformed item is still listed, with state `waiting`, the title `<id>: item.md cannot be read` and `hostState` `malformed: <the problems>`, so a person sees it and agents leave it alone. It never breaks the read of other items.

**`log.jsonl`** is append-only: one JSON object per line, never edited or removed. Every line has:

| Field | Is |
|---|---|
| `at` | ISO 8601 time with a zone. Writers write UTC with `Z`; a reader also accepts an offset. |
| `by` | `{ "who": "robin", "machine": "laptop-a", "agent": false }` (`machine` and `agent` optional). A reader also accepts a bare string, read as `who`. |
| `kind` | A short lower-case word: a letter, then up to 39 of `a-z`, digits, `-`, `_` |

The kinds and their own fields (all optional unless named):

| `kind` | Fields | Folded into |
|---|---|---|
| `created` | | Nothing (the item page's log) |
| `edited` | `changed` (the fields changed) | Nothing |
| `claimed` | `until` (time, required) | The holder |
| `released` | `reason`; `of` (the holder, `who@machine`, when someone else releases a person's hold) | The holder |
| `session` | `role`, `model`, `outcome`, `summary`, `durationMs`; Scope Soup adds `next` (the step that comes next), `size`, `sessionId`, `costUsd`, and for a triage `ready` | Nothing (the Rounds table) |
| `question` | `question` (required), `options` (each `{ label, description }`), `recommendation`, `context`; Scope Soup adds `parked` (why the item is parked), `retry`, `rewrite` (the round), and for a proposed restructuring `proposal` (`original`, `parts`, `carried`, `reason`) | The open questions |
| `answer` | `answer` (required), `to` (the `at` of the question answered), `toBy` (that question's `by`); Scope Soup adds `toQuestion` (that question's text), `toSet` (the park's set, for a question not read back yet), `question` (the question as the answer is recorded, when the line does not name it otherwise) and `answers` (each `{ question, answer }`: the answers one line stands for, as a triage rewrite's) | The open questions; every machine's answers (decision 131) |
| `assumption` | `decisions` (each `question`, `chosen`, `others`, `why`): decisions an implementor took as cheap to change later | The Item's decisions |
| `accepted` / `overturned` | `to` (the `at` of the `assumption` line), `n` (the decision's place in it, from 0); `overturned` adds `answer` and either `item` (the new Item that reworks it) or `work: true` (the change had not merged, so the answer went into the running work) | Settles that decision; the first verdict counts |
| `revision` | `sha` (required, full), `branch` | The change |
| `review` | `sha`, `verdict` (`pass` or `fail`) (required), `findings` | The change's review verdicts |
| `check` | `sha`, `verdict` (required), `command`, `findings`, `batch` | The change's `ci` verdicts |
| `merged` | `sha` (required, full), `target` | The change's state |

**The fold.** The order of the lines in the file does not matter, so two laptops' logs merge by keeping both sets of lines.

1. Order. Lines are folded ordered by `at` as an instant, then by `by` in canonical text form, then by position in the file.
2. Duplicates. A line's identity is its whole parsed content; identical lines are dropped before folding. Revisions with the same `sha` are one revision: the first stays.
3. `merged` counts only for the newest revision. A `merged` for another revision is ignored; a revision after it opens the change again. A `sha` that is not a full id makes its line malformed.
4. Verdicts. A change has the latest `review` per reviewer and the latest `check` per command. A verdict on the newest revision wins; otherwise the latest on an older revision is taken and marked stale.
5. Done. When the newest revision has merged, the item is done whatever `item.md`'s `state` says (the log is mechanical and append-only; the header is edited by hand). The exception is an item whose `item.md` cannot be read: it stays `waiting`. On GitHub, an item whose change has merged shows Done while its issue is still open (`mergedWork` in `src/core/lanes.ts`) and is never started again.
6. Times and actors. Readers map every time to UTC ISO 8601 with milliseconds and one actor for both spellings of the same `who`.
7. Holder. `claimed` requires `until`; one without a valid `until` is malformed, so a dead laptop cannot hold an item forever. A `claimed` takes the item when nobody holds it, when the holder claims again, or when an agent holder's `until` has passed by the line's `at`; otherwise the earlier claim stands. A person's claim never runs out (people have no stall timer): only a `released` line ends it. An agent's holder line has the same `who` and `machine`; a person's (not tied to a machine) the same `who` from any machine. `released` lets go when it is the holder's own, or when a person writes it with `of` naming a person holder. An agent's claim is let go only by that agent.
8. Questions. A `question` is open until an `answer` closes it. An answer's `to` is the `at` of the question; it closes every open question with that `at`, unless it carries `toBy`, and then only those by that writer. An answer without `to` closes the newest open question. An open question sets the item's `needsDecision`.

There is a change when there is a `revision` line: it has the item's id, the branch of the newest revision that names one, and every revision oldest first. The target is the `merged` line's, else the host's setting (default `main`). Once the change is on main Scope Soup writes `state: done` to the header (decision 114). The item's `updatedAt` is the newest `at` in its log. The read gives each item its log twice: `history` (in words) and `log` (with fields). A line that is not JSON, lacks a valid `at`, `by` or `kind`, or is a known kind whose fields do not fit is kept with its problem and counted, never fatal. Text from items and logs is data: it is never executed, and nothing from it reaches a path or a git argument without the checks above.

**A conflict.** `items/<id>/item.conflict-<12 hex>.md` is a version of `item.md` put aside because `item.md` was changed on two machines at once; the hex is the start of that version's blob id. The reader does not read it, but an item with one is everyone's turn: `needsDecision`, and its `hostState` says where the other version is. Agents leave it alone.

## Writing to the meta branch

With writes switched on (`SCOPESOUP_META_WRITE=1`), `src/hosts/metaBranch/writer.ts` creates items, edits `item.md` and appends log lines, through the write port (`createWork`, `editWork`, `appendLog`). Each returns the item (whose id may have moved, see below), whether it is shared, pending or local only, and whether the item is in conflict. Without writes the host changes nothing in the repository, not even by a fetch.

**One write, one commit.** The writer builds the new files with `git hash-object`, the changed directories with `git mktree --batch`, the commit with `git commit-tree`, and moves the ref with `git update-ref <ref> <new> <old>`. No checkout, no working directory, no index. When another writer on the machine moved the ref first, the write is planned again from the new value. The ref is never moved while a working copy has it checked out.

- Every changed path must be `items/<id>/item.md`, `log.jsonl` or a conflict file of the item written. A save of the settings changes only the two settings files; a pick's request or answer only that month's `requests/<yyyy-mm>.jsonl`. The other exception is `format` in a new branch's first commit and the migration.
- The write first checks the format of the tree it starts from: a newer or unreadable one refuses it.
- `item.md` is written by `serializeItem` so that the reader gives back exactly the same fields, or the value is refused (a line break or other control character, white space the reader would trim, a comma or bracket in a label, a file over 1 MB). An edit writes the whole header in canonical form: known keys in a fixed order, unknown keys kept in their order; comment lines in a hand-written header are not kept.
- A log line is written by `serializeLogLine` (UTC with `Z`, `by` with this machine's name) and must read back as one entry with its required fields, or it is refused. A line is at most 16 KB; an identical line is not written again.
- **Append-only.** A write that changes a log checks that every old line is still there, unchanged, with lines only added at the end.
- **New ids:** the machine's prefix (`SCOPESOUP_META_PREFIX`, one per machine) and one more than the highest number with that prefix on the ref the write read. Two writers on one machine both read the same number; the second one's `update-ref` fails and its write, planned again, takes the next number.
- Commits are made as the configured person (`SCOPESOUP_META_AUTHOR_NAME`, `..._EMAIL`), passed to git directly, never from the machine's git config. Local plumbing runs with hooks, signing and automatic gc off; a push runs the repository's hooks. Nothing may prompt (`GIT_TERMINAL_PROMPT=0`, ssh in batch mode). Writing needs git 2.29 or newer.

**Sharing.** With a remote (`SCOPESOUP_META_REMOTE`, default `origin`; without one, or `none`, writes still work locally):

- After each write the ref is pushed, `<commit>:<ref>`, fast-forward only, never forced; the repository's own hooks run.
- What was last fetched is kept under `refs/scopesoup-remote/<remote>/<ref without refs/>`; a fetch uses the explicit refspec `+<ref>:refs/scopesoup-incoming/<remote>/<...>`, and what it brings is checked before it is taken.
- A refused push is told apart from other failures by asking the remote: if its ref moved, fetch, put the own commits on top, push again, at most five pushes per round. Any other failure is reported, not retried.
- Before reading, the ref is fetched, at most once a minute. A problem with sharing never fails a read; it is in the sharing report.

**Putting own commits on top.** A pushed commit is never rewritten. Scope Soup knows which commits are this machine's own and unshared, and only those are put on top again:

- Every commit the writer makes ends with the trailer `ScopeSoup-Machine: <machine>`.
- `refs/scopesoup-local/shared/<remote>/<ref without refs/>` is the last commit of the local meta ref known to be on the remote.
- The own unshared commits are the first-parent line from that commit to the local tip, each carrying this machine's trailer; one without it stops sharing with a message. The fetched tip must contain the shared commit, else nothing is taken and the fetched commit is set aside under `refs/scopesoup-incoming/...`.
- With no shared commit and no local meta ref, the fetched history is taken as it is. With a local history (the first share from this machine), that history is put on top only if every commit carries this machine's trailer; otherwise the histories are unrelated and Scope Soup refuses.

Each own commit, oldest first, is made again on top of the fetched one as a three-way merge, keeping its author and message:

- A path only one side changed takes that side's version.
- `log.jsonl` (an item's, the settings', or a month's `requests`) changed on both sides: both sets of lines, the other side's as they are, then this side's new lines in the order written.
- `item.md` changed on both sides, differently: a real conflict. The other side's version stays in `item.md`, this side's goes to `item.conflict-<blob>.md`. Neither is lost, and the item is everyone's turn.
- **Resolving.** While the item is in conflict an edit is refused unless it names the versions it settles (`editWork(..., { resolveConflict: { supersedes: [blob ids] } })`). That edit writes `item.md` and removes only those versions; one that arrived after the person looked stays.
- `settings/settings.json` changed on both sides: the values this side's save changed are made again on the other side's settings, so saves of different keys both merge. The loader refuses settings that do not validate and keeps the last good ones.
- A conflict file one side removed is removed. Any other file changed on both sides is not Scope Soup's to merge: nothing is pushed and the problem is reported.
- **An id taken on both sides** (two machines with one prefix). An item whose create is among this machine's own unshared commits and whose id the other side has used for another item is created again under the next free id with that prefix; its files move, and the `id:`, `parent:` and `blockedBy:` lines of this machine's own new items follow. Only such an item can move, and two items are never merged into one. The sharing report and the write's outcome (`movedFrom`) name the new id; for an hour a write to the old id is refused with the new id named, since the old id is now the other machine's item.
- A commit of this side that removed or changed a log line is refused, and so is a result that would lose any line this machine's own commits wrote.

**A history that lost something.** A fetched ref must contain the commit last fetched, be linear since then (first parents, no merge commit), and no commit along it may remove or change a log line its parent had. If not, it is not taken: the local ref stays as it was, nothing is pushed, the fetched commit stays at `refs/scopesoup-incoming/...`, and the sharing report says so ([`RUNNING.md`](RUNNING.md), "When the meta ref refuses what it fetched"). Reading and writing go on locally. A machine that has fetched nothing yet takes any history as the remote's.

**Accepting a refused history** is `Writer.accept()`, run as `pnpm meta:accept`: it saves the local meta ref under `refs/scopesoup-backup/<time>`, takes the fetched commit as the local, fetched and shared state, puts this machine's own unshared commits on top, and pushes. Lines the accepted history removed stay removed.

**Fixed for good once machines hold real history.** Lines are compared byte for byte, so the writer's key order (`at`, `by`, `kind`, then the fields), its time format, `by` as `{ who, machine, agent }` and the conflict file's name must not change. An item is never deleted or renamed by a write (except by the id rule, before it is shared).

## Store

One SQLite file (`src/store`).

- Plain tables are the source of truth.
- One append-only `events` table is written in the same transaction as each state change. Its sequence number is the SSE event id, so a browser resumes from `Last-Event-ID`. Events are never read to compute state.
- Raw agent streams go to files, one per session; the store holds only an index row.
- One writer: the process itself.
- A schema version in `PRAGMA user_version` (decision 64, `src/store/schema.ts`): `openStore` migrates an older database in one transaction, keeping a copy `scopesoup.v<old>.sqlite` before a step that changes the schema; a newer one is opened read only.

## Orchestrator

A tick loop, in this order (after Symphony's specification):

1. Reconcile: check running sessions for stalls, refresh host state.
2. Load and validate the project's configuration (private file plus the shared settings on the meta ref; `src/config/shared.ts`); a bad reload keeps the last good one.
3. Ask the usage check whether work may start. It is a pure function over the newest usage sample (5-hour and weekly windows), the reset times and the budgets (`budgetFiveHour`, `budgetSevenDay`, applied from level 1); at dispatch the pace line and the caps on what waits for a person decide each further start (`src/orchestrator/pacing.ts`, decision 133). A session cut off by a limit is resumed after the reset.
4. Pick ready items; dispatch into free slots, as the level allows and only while agents are started.

The `level` (0 to 4) gates the tick ([`RULES.md`](RULES.md), [`RUNNING.md`](RUNNING.md), "Levels"). Each agent role has its own switch, and the merge queue has one; Scope Soup comes up with all four paused.

Judgement points call the agent CLI (`claude -p` today, through its provider) with a prompt template, a JSON schema for the answer, a tool allow-list and a turn limit. The program reads the structured result. The judgement points are triage (which for an item too large for one change also proposes its parts), implement, and review.

**The prompts** are minimal: `prompts/triage.md`, `implement.md` and `review.md`, under 50 lines together. Each is the Item between markers (data, not instructions), where the session works, the project's own CLAUDE.md to follow, what earlier sessions on the Item did and what a person answered (`{{history}}`; decision 112), for the implementor the Items linked to its Item (`{{linked}}`; decision 115), the commands it may run (`{{allowedCommands}}`), and the answer it gives, in a small schema. The implement prompt's end (`{{finish}}`) depends on the level and is fixed when the session starts: at level 2, and at level 3 after approval, the session merges to main the way CLAUDE.md says (or opens a pull request); otherwise it commits and stops. How Scope Soup then decides the Item is done: [`RUNNING.md`](RUNNING.md), "Merging by the session" (decision 108).

**No fix role.** Review findings and a failed merging go back to the implementor: the job keeps its agent session id (`agentSession`) and the message (`resumeWith`), and the implement step resumes that session with only that message. Without a known id, or after a resumed session failed, a fresh implementor gets its prompt with the message after it.

**Enforced on the command line.** Every session gets `--disallowedTools` with `Bash(git push --force*)`, `Bash(git push -f*)` and `Bash(*--no-verify*)`, and from level 4 also `Bash(git push*)`. After every session Scope Soup checks that the remote's main moved only fast-forward from the commit it last saw (`src/orchestrator/mainGuard.ts`); otherwise it pauses the three agent roles with the reason.

**Agent providers.** Everything that depends on which agent CLI runs a session sits behind `AgentProvider` (`src/orchestrator/agent.ts`), in `src/orchestrator/providers/<name>/` (Claude, Copilot): building the command line (also for resume), what the CLI enforces for command limits, MCP servers, usage, the structured answer, and reading a finished stream file. Which provider a session runs on is `providerFor` in `providers/index.ts`: the role's `provider`, else Claude. A test (`providers/boundary.test.ts`) checks that nothing outside a provider's folder names its CLI, its flags or its event format, apart from a short explained list.

The agent runner:
- spawns the provider's executable directly, with stream output, and records every child process id in the store; kills whole process trees on stop; treats no stream event for N minutes as a stall;
- manages git worktrees itself, reused across items like a pool (`src/orchestrator/slots.ts`), or hands out full clones from a pool for a submodule project (`src/orchestrator/workspaces.ts`); runs the project's setup when it must (`src/orchestrator/setup.ts`); keeps the uncommitted edits of a parked item as a patch (`src/orchestrator/wip.ts`) and puts them back when it resumes;
- fetches the remote's main before every session (`freshBase` in `src/orchestrator/runner.ts`) and moves the clone's local main branch to it (`followRemoteMain`, decision 107); a main checked out in a worktree is fast-forwarded there when clean, else left (`orchestrator.main_not_moved`). Prompts compare with `{{base}}`, the remote's main.

**Limited resources** (decision 74, `src/orchestrator/resources.ts`). The tick takes a unit of each resource the step needs (all or none) before the workspace and the claim, so an Item without one waits and the next may start. The runner gives units back when a session is over; a shared resource's unit is also a lease on the remote made with the merge queue's lease code.

## Board

Hash routes (`web/src/route.ts`), a header with the seven views and the Sync now and Stop buttons. The four switches (`src/store/control.ts`, `web/src/switches.ts`) sit in the headers of the lanes they feed; a paused lane is muted, and a switch is not shown below the level that uses its role. While any switch shown is paused a bar under the header names them with one Resume all button (decision 109).

- **Overview** (`#/`): lanes (backlog, blocked, to do, in progress, in review, merge queue, done), the "your turn" list (each card says only what waits: "2 questions", "a rewrite to accept", "to merge", "not ready", "escalated"), and a status line (runners, usage windows with a forecast, the last sync, the orchestrator's idle reason). The backlog lane is in the orchestrator's planned pick order (`planOrder` in `src/orchestrator/candidates.ts`), with ▲ ▼ vote buttons; from level 1 a divider puts the Items not triaged yet below the rest. The Merge queue lane shows the batch under test as a box, then a "Waiting · N" divider; below level 4 it is hidden while the queue is empty. An item parked as "too large, split it first" (or restructured by an accepted proposal) becomes an umbrella once it has open sub-items; an umbrella is never triaged or started itself, and when its last sub-item is done it returns to "your turn" as "Close it if nothing is left". A card's tags: whose turn it is when a person's, decisions to look at, unsent answers, the running or stalled session, a priority other than major, "unblocks N", the time; held items say "held by @mira".
- **Items** (`#/items?...`): every item, open and closed, with search, filters and ready-made views (`src/core/item-list.ts`).
- **Queue** (`#/queue`): batches as boxes around their changes with one progress bar each; a bisect drawn as a tree under a failed batch.
- **Activity** (`#/activity`, `src/core/activity.ts`): a timeline, newest first, filtered by Item, person or agent and kind, built from what is already recorded (the Items' logs, stored sessions, merge queue batches, decisions, the store's events and the settings' log).
- **Commits** (`#/commits`): the commits of the main branch and the item branches as lanes, read with git from `repoPath` (`src/orchestrator/history.ts`); a main commit links to the Item that merged it (`src/core/commitLinks.ts`).
- **Usage** (`#/usage`, `GET /api/usage?span=`): a meter per window (used, the reserve mark, the reset, the forecast), a line plot of how full each window got over the span stacked by role, and "Who used it". The maths is pure, in `src/core/usage.ts`.
- **Settings** (`#/settings`): the level and the settings listed in [`RUNNING.md`](RUNNING.md), "The Settings page and the sliders".
- **Item** (`#/item/<key>`): a dialog over the board, read top to bottom: the header (title, status line, tags, a link to the host), the Item (description, verification, links, place in the backlog, who holds it), what waits for the person (rewrite, questions, decisions, restructuring proposal, conflict), the work (Rounds, Change with its diff, `GET /api/diff`, `src/orchestrator/diff.ts`; Runs; Talk to a session), then the history. The page has one primary button, for what waits for the person.

**Who is at the board.** There is no login: a person picker in the header (remembered in the browser only) names the person in `X-ScopeSoup-Person` on every request; the server builds that person's "Your turn" (`src/core/turns.ts`: questions are `anyone`'s, in every list until answered; a person's holds and hand-backs are `person` turns) and records the name on answers, claims and releases. When a tick leaves Scope Soup idle with "your turn" not empty, one desktop notification is shown per stretch of waiting (`src/orchestrator/answerWait.ts`).

**Writing items.** When the host can be written to, the overview has a New item dialog and the item page an Edit button, Abandon and Reopen (State picks, [`RUNNING.md`](RUNNING.md), "The State menu"). `POST /api/items` takes `{ title, body?, verification?, labels?, blockedBy? }` and `POST /api/item/edit` takes `{ ref, ... }` with the fields to change. Each write adds a `created` or `edited` line to the item's log, then syncs before it answers. On GitHub with writes on, Edit changes title, description, verification and priority through `editWork` ([`github-mapping.md`](github-mapping.md)); labels and blockers are refused there. On a read-only host both are refused. The item page shows the description as markdown, parsed by `web/src/markdownParse.ts` into plain data and built into elements by `web/src/Markdown.tsx`, so no HTML in an item reaches the page.

**Images agents attach** (decision 91; `src/core/media.ts` has the rules, `src/orchestrator/media.ts` the files and git). The runner makes `.scopesoup/media/` (git-ignored) in the clone before a session and, once it is over, moves the images that pass (extension and magic bytes agree; 5 MB each, 20 per Item) into `<data>/media/<key>/`. Links are never followed, and a read serves only a plain file whose real path is inside `<data>/media`. With `media.push` on they are also committed to `refs/scopesoup/media/<key>` and pushed fast-forward to `remote`; the ref is never merged and never part of the meta ref's history. A failed update is kept (`media.pending`) and tried again every hour. `GET /media/<item key>/<name>` serves with a fixed content type, `nosniff`, a restrictive `Content-Security-Policy` and `Cross-Origin-Resource-Policy: same-origin`; `POST /api/item/media/delete` takes `{ ref, name }`. The Markdown parser has an image node for `![alt](media/<name>)` with a plain image name only, so no URL is loaded. `inertText` turns each attached image into "(alt: image on the board)" for hosts.

`GET /api/status` returns the board as JSON, for scripts and agents. `GET /api/health` answers `{ ok, seq, now }` from the store's last event number alone, for a service monitor.

## Answers

When the orchestrator puts an item down with a question, the item page shows the question, a note for its `context`, and the options as rows to pick (the recommended one first and marked), with an "Other" row. `POST /api/answer` (`{ ref, answer, to?, question?, parkedAt? }`) keeps the answer in Scope Soup's own store (on GitHub the only place for it), gives it to every later session on the item, and picks the item up again. An answer is kept with `textHash` (a hash of the item's title, description and verification when it was given). When a later step asks the same question about the same decision on an item whose text is unchanged, the recorded answer is taken as the reply and a person is not asked again (`orchestrator.answer_reused`); once the text has changed, or for a set of several decisions, a person is asked.

Triage may list several open decisions (`decisions`); the job keeps all of them (`jobQuestions`), and the item page lists each ("Question n of m"). Each answer names its question by its index, with `parkedAt`, the time of the parked state the page read, so a stale page never answers a question it did not show (409 `PARKED_CHANGED`). A question has one answer (409 `ALREADY_ANSWERED`). The job is released only by the answer to the last open question (`answerQuestion`: one store transaction).

**The board answers an Item's questions like a dialog, sent together.** All of an Item's open questions are in one panel; every question has a free-text "Other", and a `multiSelect` question takes several options. What is picked stays in the browser (`web/src/heldAnswers.ts`) until Send, one `POST /api/answers`: the answers are recorded in one store transaction or not at all, written in one write (GitHub: one comment; the meta branch: one commit with an `answer` line per question), and the item is picked up once. A partial Send is allowed. A triage rewrite keeps its own panel; Accept, Edit, Reject or "Send my answers" is one call.

An answer to a question or an escalation from implement resumes that step: the job keeps its step, review round and findings, and the next session is the same step with the answer in its prompt (or after the implementor's resumed message). An answer to a triage question or a round-limit escalation starts at triage; an answer to an Item parked at hand-over keeps the job and repeats the hand-over.

**Starting over.** An item parked as "needs-decision" or "escalated" from its implement step shows a **Start over** button: `POST /api/start-over` (`{ ref }`) drops the job (branch, review round and findings with it), so the item starts at triage.

**Talking to a session.** The Item page lists the Item's sessions Scope Soup knows; a person picks one and writes. Each message is one more turn of that session (`src/orchestrator/chat.ts`): the runner starts `claude -p --resume <session>` in the Item's worktree with only the message, the role's model and allowed tools (a triage or a reviewer stays read-only), without the role's answer schema. The turn never becomes the job's `sessionId`, so its reply is never read as the role's answer. `POST /api/chat` answers 202 once the turn has started; `GET /api/chat?ref=` gives the sessions with their turns and `blocked`, the reason no message can be sent now (a session runs on the Item, after Stop, a person holds it, the usage stop, it is queued, merging or merged, or it has no job). The conversation is kept in the store, not on the host.

## Agents push back

An agent can stop for a person in these ways. Every one always goes to a person; Scope Soup never takes a recommendation itself.

**A question with options from the implementer.** The answer of implement may carry `question`, exactly as triage's. The item is parked as "needs-decision" and the `question` line in the log carries it. A question a person already answered on the unchanged item is answered from the record and the same step runs again, at most three times per item. An answer that is not done and has no `question` parks the item with its `summary` as the reason; one that stopped after a refused command is parked as escalated, with advice on `allowedTools`.

**The triage rewrites the description.** The triage searches and reads the other Items with the item commands (its default `allowedTools` add `item list*` and `item show*`; sessions get `SCOPESOUP_CONFIG` so the commands find the project). Its answer adds `rewrite` and `links` (`blockedBy`, `blocks`, `duplicateOf`, `conflictsWith`, `related`, each with the other Item's id and why).

- A `blockedBy` link to an open Item is the only one acted on by itself: on the meta branch Scope Soup records it as its own blocker (in its store and in the item's `blockedBy` field with an `edited` line); on GitHub it writes `blocked_by` on the issue (decision 49) and the re-read makes the Item blocked. The Item waits in Blocked, and once the blocker is done the triage runs again. A `blocks` link is written as `blocked_by` on the other open issue.
- A `duplicateOf` link becomes a question: "Close A-3 as a duplicate of A-1" (recommended), "Close A-1 as a duplicate of A-3", or "Keep both" (decision 113). Closing the other Item is done on the host where Scope Soup can, unless that could lose work (a session, a chat, someone else's hold, a change in review, queued, merged or handed over, or commits on its branch ahead of main); then it stays open and the event says so.
- A `conflictsWith` link becomes "A-3 conflicts with A-1 … Go on with both, or hold A-3 until A-1 is done?", with "Go on with both" recommended. A hold makes the Item blocked by the other, and no hold is offered when it would close a cycle. The answer is kept per pair (`pairAnswer`). A `conflictsWith` link also makes the Item's first implement step wait while the other is busy, as for overlapping paths (`sameFilesWait`), unless a person answered "Go on with both" (decision 115). `related` (and `blocks`) are shown on the Item page and to the implementor (`{{linked}}`).
- With questions, or a rewrite that differs from the description (not only in whitespace: decision 110), the item is parked as "needs-decision" on the rewrite (the job's `rewrite`). Keeping every recommendation, one press accepts the rewrite (also Edit and Reject); any other answer shows "Send my answers" and the triage runs again with the answers, round after round with no cap. `POST /api/rewrite` records the answers as a person's. Accept or Edit writes the text as the item's description (an `edited` line with `via: "triage, round n"` and `was`; on GitHub with writes on only the issue's description part is replaced, made inert, and its `## Verification` section is kept; when that fails or writes are off the text is recorded as an answer the agents use in place of the host's). Reject keeps the description. From level 2 no implementor starts before a person decided the final rewrite.
- The rewrite may carry label changes (`rewrite.labels`, kept to the host's existing labels and never `scopesoup:*`), shown as `+bug, −question`; Accept applies them with the description (on GitHub one call per label and a re-read; [`github-mapping.md`](github-mapping.md), "Labels in a rewrite"), Edit changes both, Reject neither.
- **Item drafts** (decision 95). Triage, the implementor and the reviewer may list `drafts` (title, description, verification); a review's `should` findings may become one. `src/orchestrator/drafts.ts` files each as an `ItemDraft` object in the store (id from the source Item and the normalized text, so it is filed once), its text made inert. The board lists the open ones in Your turn; `POST /api/item-draft` approves (the source Item's host's `createWork`; Approve first records `approving`, so one that did not finish is retried without making the Item twice) or denies. Nothing is written to a host before Approve.
- **Questions about other Items.** Triage and the implementor may add `aboutOthers`: for another Item, questions with options and a recommendation, and from triage only a `rewrite` of that Item's description. Scope Soup writes them there, not the agent, each ending "(asked by triage of A-3)", and the Item parks on them as on triage's own rewrite, with the same Accept, Edit and Reject. Allowed on any open Item when no session or chat turn runs on it, nobody else holds it, and it waits for no answer of its own, no review and no merge; until then they wait in the store (`orchestrator.aboutOthers`). An unknown or closed Item drops them, and so does a question asked there before. A rewrite with no question is only proposed (decision 110): it never touches the Item's job and is kept on this machine's board only; `POST /api/proposed-rewrite` writes Accept or Edit as an accepted triage rewrite is written, Reject drops it.

**Triage again.** A job waiting at its implement step with nothing of the step begun (`awaitsImplement` in `src/orchestrator/recheck.ts`) is checked when the tick is about to start that step: its triage is out of date when commits on main touch the paths it named, the Item's text hash differs from the one the triage was given, a blocker open then is done, or it is older than `settings.triageMaxAgeDays`. Then the job goes back to `triage` with `recheck` (the reasons, the previous answer, the commits, the old text), rendered into `{{recheck}}`.

**No proposed rewrites from other steps.** A session that finds the item's description or verification wrong asks a question with options; the rewrite loop exists only in triage.

**The fence and progress.** From level 3, before review, the program compares the branch's change (`changeStat`: each changed path with its lines) with the triage's `paths` and `size` (`src/core/fence.ts`, pure). A change well beyond them parks the implement step as a decision (`orchestrator.fenced`) with the report and a proposed split; the answer resumes the implementor, and `job.fence` keeps what the person saw, which widens the fence. The review step keeps `job.progress` and escalates a round that gets nowhere (`noProgress` in `src/orchestrator/progress.ts`). An approval's `should` findings go back to the implementor once or become one Item draft (`review.shouldFindings`). [`AUTONOMY.md`](AUTONOMY.md) gives the limits.

**A proposed restructuring** (decision 94). Triage may give `restructure`: a `reason`, what becomes of the item (`original`: it `keeps` one part, becomes an `umbrella`, or is `replaced`), and `parts`, each a `title`, `description`, `verification` and where it `goes`: `original`, a new `child`, a new `related` Item, a new `unlinked` Item, or `into` an existing Item. A restructuring that does not hold together is left out. The item is parked as "needs-decision" (the job's `proposal`, and the `question` line's `proposal`), whatever `ready` or `size` says; a large item without one is parked as "not-ready", too large. The decisions already made on the item are carried into each new part. The item page lists the parts with where each goes and the item's fate, with Accept, Edit and Reject (`POST /api/proposal`). Nothing is made before Accept:

- Accept, or Edit with a person's version, makes the parts through the item's own host, in order, with text made inert: a child with `createWork` and `parent` (a sub-issue on GitHub, a sub-task on Jira, a child Item on the meta branch), a related Item, an unlinked Item, and the parts `into` an Item as `## Added from <item>: <title>` sections at the end of that Item's description (skipping a section whose marker is already there). Each part's text ends with a marker line, `Part <n> of restructuring <id> of <item>.`; agent text is made inert and any line shaped like a marker is broken (`inertPart`). Then the item itself: one that keeps a part gets that part's text and is released, so triage looks at it again; an umbrella is parked as "not-ready" with the parts named; a replaced item is closed as abandoned (refused while it has an open change, an agent session or a running job).
- What was made is recorded in the job as it is made. Before it makes anything, an accept looks on the host for items carrying the marker lines, so a store rebuilt after `data/` was deleted, or a part made by hand, is not made again. A part `into` an Item that is not on the host or is closed is refused before anything is made. Once a part exists the restructuring is fixed: an edit is refused and the page offers Accept (finish it) and **Stop here**, which ends it with the parts made so far, records the rest as text on the Item and parks it as "not-ready". The item's own change goes last, so a retry finds every part.
- On a host Scope Soup cannot create items on (`write: false`, or a GitHub clone whose remote is another repository), accepting makes nothing: the decision is recorded with the restructuring as text, for a person to carry out by hand, and the item is parked as "not-ready" saying so.
- Reject records the rejection as an answer and starts the item over at triage, which is told not to propose it again. Once any part exists, Reject is refused.

## The orchestrator's progress in the item's log

On a host that keeps a log per item (meta branch), the local store is never the only copy of where an item stands. The orchestrator writes:

- `claimed` and `released` for its own sessions, when the meta branch has writes on and a remote to share it with. A person's claim is written by `scopesoup item claim` and the hand-back by a `revision` line with `handback: true` and a `released` line ([`RUNNING.md`](RUNNING.md), "Item commands").
- `session` when a session ends, with `next`, the step the item goes to now. No transcript.
- `question` when it puts the item down for a person, with `parked` (why) and the options and recommendation for a decision; for a proposed restructuring, `proposal`. When triage lists several decisions, each is its own `question` line, and an answer from the board names its line (`to`).
- `revision` when the branch has a new head after implement, and `review` with the verdict and findings on that head.
- `check`, `revision` and `merged` at merging (level 4), and `revision` and `merged` when the implementing session merged (levels 2 and 3). `check` is `pass` on the merged commit with its batch, and `fail` on the change's commit with the failing check's name or the last lines of the check command in `findings` when a red batch sends it back. A conflict in the batch is not a check and has no line.

**The Rounds table.** The Item page shows the cycle as a table built from these lines alone (`src/core/rounds.ts`): one row per step with its model, what it found or decided, what it did, how long it took and what it cost, and a last row for the outcome. Each row with a session opens its details (`GET /api/session?id=`, `src/server/sessionDetails.ts`) and a button that picks that session in the chat panel.

**Read back.** The first tick that sees an item in the store rebuilds its job and its answers from its log when the store has none (`src/orchestrator/recover.ts`), so deleting `data/` loses nothing that matters:

1. An open question by Scope Soup (a proposed restructuring too): the item is parked, waiting for the answer. Triage's several question lines all come back, in log order, as `decisions`.
2. The last `session` names a `next` step: that step starts again.
3. The newest revision has a passing review and has not merged: the hand-over is done again, without a session.
4. Anything else: the item starts as a new item, with the answers from the log in its sessions.

The step and the review round live in the job, not in the log, so an answered question or escalation from implement has no job to resume after `data/` is deleted, and the item restarts at triage with the answer in its prompt. Lines are read back by `who` (`scopesoup`), not by machine, so with a pool of clones a hand-over rebuilt this way takes a clone again on the item's branch (and waits, saying so, while none is free). On GitHub the same record is kept on the issue ([`github-mapping.md`](github-mapping.md)).

## Design rules

Rules every change to Scope Soup keeps. A reviewer reads them here; keep each rule one line, and add one when a review misses something a person then catches.

- Never await long work in the tick. A check, a session or a host call that can take minutes runs beside the tick and is picked up on a later one; dispatch must not stall.
- Server actions on jobs go through one store transaction, and every state change writes its event in that same transaction.
- A fake refuses what the real port refuses. A test double of the queue, a host or the store must reject the same inputs the real one rejects, or a test on it proves nothing.
- A change of what Scope Soup writes to a host is a person's to decide before it is merged.
- A bug in the Item lifecycle is a gap in the simulator's rules (`src/sim/rules.ts`): a rule that fails on it comes first, then the fix.

## Further design

- [`RULES.md`](RULES.md): the core rules and the levels.
- [`PEOPLE.md`](PEOPLE.md): people taking steps of the cycle.
- [`ONBOARDING.md`](ONBOARDING.md): putting a project under Scope Soup at level 0 and raising the level.

## What is not here yet

- Exporting Items as GitHub issues when a project leaves Scope Soup: offboarding exports them as Markdown files only.
- No login: the board listens on localhost only (decision 42).
