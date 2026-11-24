# People doing the work

Status: design, agreed in outline on 2026-11-18. It is built together with three laptops, next after the queue follow-ups (decision 39). Built so far: claiming an item and handing it back with a branch from the command line (`pnpm item`, `docs/RUNNING.md`), the board's cards and Item pages showing who holds what, each person's own "your turn" and no stall timer for people, and people as equals: a person picker on the board, questions in everyone's "your turn", and anyone releasing anyone's hold. Also built: the board's own buttons for claim, hand back and release, and Take showing the Item's branch with Hand back reading it from the remote. Not built: a person taking one step of an item rather than the whole item.

Scope Soup is not only for agents. Any step of an item's cycle can be done by a person, item by item.

The people on a project are equals and trust each other (decision 69). Scope Soup has no login: whoever is at a board says who they are with the picker at its top, and anyone may answer Scope Soup's questions, claim an Item, and release anyone's hold.

## Every step has a doer

The cycle is the same whoever does it: triage, implement, review, merge. Each step of each item is done by an agent or by a person.

| Step | A person doing it means |
|---|---|
| Triage | Writing or refining the item, splitting it, answering what it leaves open |
| Implement | Pushing commits to the item's branch from their own machine and editor |
| Review | Giving the verdict and the findings, on the item page or with the host's own review |
| Decide, approve | Anyone's, at any board (built: the answer box on the item page, Accept, Edit and Reject for a triage draft or a proposed split, and a Start over button for an item that is parked on a question or escalation of implement, whose answer otherwise resumes that step) |
| Verify | A check only a person can make ("upload the file and see that it is accepted") |

## Claiming and handing back

- On the board a person **claims** an item, or one step of it. From then on the orchestrator leaves that step alone and waits for its result: a branch with commits, a verdict, an answer.
- When the result arrives, the cycle goes on with the next step, done by whoever is the default for it. A person can implement and let agents review; an agent can implement and a person review.
- A person **hands back** at any time, with a note. An agent then picks the step up from where the branch stands.
- On the meta branch, claiming an item is a `claimed` line written by a person. `pnpm item claim` writes it (the person as author of the line, `until` far ahead because the format needs one, a `from` field when it came from a Claude Code session), and `pnpm item handback` follows it with a `revision` line (`handback: true`) and a `released` line, which the orchestrator takes on from the review. On GitHub the person is the issue's assignee, and that exists today: an item someone is assigned to on the host counts as a holder, so people who never open Scope Soup are respected (built: a held item is not picked).

## The same road to main

A person's change goes the same way as an agent's: the item's branch, a review by an agent (from level 3), and at level 4 the queue and the batch. At level 2 a hand-back is parked for the person until main contains the branch. There is no side door, and none is needed: the queue treats a change the same whoever wrote it.

What differs for people:

- **No stall timer.** An agent that is silent for minutes is stuck. A person who is silent for a day is living their life. A person's hold does not expire by itself; after a while the board shows it as quiet and asks; the person, or anyone else, releases it. Built: no `until` frees a person's hold, on the meta branch's log as in Scope Soup's own picking, and the board says "Quiet" after a day without a line. A `released` line ends it: the holder's own, or anyone's that names the holder in `of` (`pnpm item release`, or Release on the Item page), so the log says who released whose. On GitHub the assignee is removed and a comment names both. An agent's claim is not released by a person: it ends at its `until`.
- **No fence stop.** If a person's change grows beyond the item, the reviewer says so; nothing is halted.
- **Their attention is shown.** "Your turn" is per person: what waits for me, most unblocking first (built). The board's person is the one picked at its top: the people Scope Soup knows (from holds, log lines and answers) are offered, and a new name can be typed. The pick is remembered in that browser only, and every request names it, so answers, claims and releases record who did them. Their list has:
  - the Items they hold: their turn until they hand back or release;
  - an Item parked after they handed it back (the hand-over at level 2 or an escalation after their hand-back): that person's turn, until Scope Soup's own work supersedes the hand-back;
  - every question Scope Soup asks (a triage's questions and draft, a split, a decision, what an Item needs before it can start), and parked Items no person holds or handed back: everyone's turn, in every person's list until someone answers. The answer records who answered.
  A person is not tied to a machine: their hold is theirs on every board where they are picked, whatever machine wrote it, and they hand it back or release it from any board. Only agents' claims are machine-bound.
  Another person's turn is on the board too, named ("bob's turn"), but not in this person's list. A board with nobody picked shows every person's turn, and asks who is there before it records anything.

## Mixed work on one item

- A person can step into a running item: take the change back after a review, or take over an implementation that an agent could not finish. The session's summary and the findings are on the item page, so they start from where it stopped.
- A person can ask an agent for help inside their own step: "write the tests for this", as a session on the same branch. It is a session on the item like any other.
- Work done outside Scope Soup still shows up: a branch or pull request that names an item is attached to it by the sync (built for GitHub).
