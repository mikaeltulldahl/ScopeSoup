# Rules: a small core, and levels

An earlier project started with no rules about how agents work and grew them over nine days. Its history shows a pattern:

- Rules written in advance survived only where they guard something irreversible or something only a person may do.
- Every guessed number or procedure was changed within 3 to 28 hours.
- Every rule written after a concrete failure still stands. The ones enforced by code stayed fixed; the ones in prose were broken again.

So Scope Soup keeps a small core that is always on and enforced in code. How much Scope Soup does on its own is one setting, the `level` (0 to 4). How agents work in a project (tests, commit messages, whether to merge or open a pull request) is the project's own `CLAUDE.md`'s call, not Scope Soup's.

## Core: always on, enforced in code

1. **No real data, no production.** Agent sessions and checks never run against a path the project has marked as real (`realPaths`).
2. **Nothing irreversible without a person.** Tags, releases, repository settings and deleting branches others own need a person. A push to the main branch is revertible: at levels 2 and 3 it is the implementing session's call, and at level 4 only Scope Soup's merge queue pushes there. Scope Soup deletes only branches it made itself (its own batch branches).
3. **A stop switch.** One action, Stop, pauses triage, implementors, review and the merge queue at once and ends all running sessions. The everyday Pause on each of those lanes lets that role's running sessions finish their step (the merge queue's: starts no new merging and lets one under way finish); the others go on. Scope Soup starts paused after every start-up.
4. **An append-only log.** Every action the tool takes is an event with who or what did it and on whose authority. Events are never edited or removed.
5. **People's decisions are surfaced, not made.** An Item an agent proposes is a draft that waits for a person's Approve; agents create none. When an item needs a decision, the tool asks with options and a recommendation and waits. Scope Soup never takes the recommendation itself. This is the one core rule that is parked on judgement; the tool provides the place to put decisions and the list that shows them.

Enforced on the command line: every session is refused `git push --force*`, `git push -f*` and `*--no-verify*` (`--disallowedTools`), and from level 4 any `git push`. A role on GitHub Copilot CLI, which cannot refuse a flag, gets the git rules its `allowedTools` map to and the prompt forbids `--no-verify` and force pushes, with a warning on the Settings page; branch protection on the remote is the guard there (decision 85). After every session Scope Soup checks that the remote's main moved only fast-forward; if not, it pauses the three agent roles with the reason.

## Levels

One setting, `level`, says how much Scope Soup does. Each level includes the ones below. The default is 0, and nothing runs until a switch is resumed on its lane. The details are in `docs/RUNNING.md`, "Levels".

| Level | Scope Soup does |
|---|---|
| 0 Watch | Shows the work. Starts nothing, writes nothing on its own. |
| 1 Triage | A read-only triage at each Item: ready or not, size, questions, a rewrite of the description, a proposed restructuring. |
| 2 Implement | Runs an implementor per Item in its own clone. The implementor merges when it judges the work done, as the project's `CLAUDE.md` says. |
| 3 Review | A reviewer reads every built change. Findings go back to the implementor; after approval the implementor merges. |
| 4 Autopilot | Scope Soup merges every reviewed change itself, through its merge queue (its switch on the Merge queue lane: Resume and Pause). |

There is no level above 4: no change waits for a person's approval. A project that wants a person to merge stays below level 4 and says so in its `CLAUDE.md`.

The level limits only what Scope Soup does on its own: a person's pick of an Item's state works at any level (`docs/RUNNING.md`, "The State menu"). A level change is an event with the level it came from and went to.

## Always on with the levels: the usage stop and claims

No rule is a switch any more; an older file's `rules` is dropped, with a notice, when Scope Soup migrates the file to format 1 (`docs/RUNNING.md`).

- **The usage stop.** From level 1 Scope Soup keeps the share of the 5-hour and weekly windows that `settings.budgetReserve` names for you (default 20 %): no session starts while less is left. The reserve is the one usage setting.
- **Claims.** When the host is shared with other machines, Scope Soup claims each Item before it starts work on it, so two machines do not start the same Item: on a meta branch with writes on and a remote to share it with, a `claimed` line; on GitHub with writes on, a claim comment. A claim lasts a fixed 120 minutes and is renewed once less than half is left. On a meta branch with no remote nothing is claimed.

## Removed rules

A file of format 0 that names a removed key still loads: Scope Soup migrates it to format 1 at start, dropping the key with a notice. In a format-1 file it is an unknown key.

- `isolatedResources`, `oneCoordinator`, `toolVerification`, `queueOnlyWriter` (never built). The merging rules below stay.
- `irreversibleActions` (read by no code), `testsWithChange` and `agentCheckCommand` (the project's `CLAUDE.md` says how changes are tested), `changePerItem`, `weeklyPacing` and `waitingCap`, and the check before a risk-class change.
- `reviewer` (level 3 reviews every change).
- `riskClasses` (with its effects) and `pinnedApproval`. Approve and merge, Send back and the PR for the record are gone.
- `hardBudgetStop` (the usage stop is always on from level 1) and `claims` (claims are written by themselves on a shared host).

## The queue is the only writer of the main branch

At level 4 Scope Soup itself merges reviewed changes on the main branch, always through its merge queue. "The queue is the only writer" means this, and the code enforces each part:

- One queue, one batch at a time, built in the queue's own clone. One waiting change is a batch of one.
- The batch is built on the newest main branch, checked on the tip of that chain, and only that checked commit is pushed. A push is fast-forward only and never forced.
- The check is the project's `checkCommand`, or with `mergeQueue.ci: "github"` every check run and commit status on GitHub for that exact commit.
- When the main branch moved and the push is refused, the queue builds a new chain on the new main branch and checks again. It never pushes a commit the check did not pass.
- A failed check or a conflict goes back to the implementor's session. Scope Soup never resolves a conflict itself.
- Without a check (no `checkCommand`, and not `mergeQueue.ci: "github"`) nothing merges; the item goes to a person.
- No new merging starts while merging is paused (its Pause, Stop, or after a start-up); a merge under way finishes on Pause. After Stop nothing is pushed, and a check that is running is stopped.
- Nothing is pushed to a remote that is not `remoteUrl`. Git's hooks run as usual.
- People may still push to the main branch. Scope Soup's merging is then refused and starts again from the fetch.

Below level 4 Scope Soup pushes nothing to the main branch; the implementing session does, and Scope Soup only checks that main moved forward.

## Numbers are settings

Batch size, the budget reserve, stall timeouts and similar numbers are settings, never rules. A number edited by hand can carry a `reason`. In the earlier project every one of them was changed within a day or two of first guessing it.

## Adding a rule

A new rule should name the failure that caused it (an event, a commit, an issue). A rule added in advance should guard something irreversible or something only a person may do; otherwise wait for the failure.
