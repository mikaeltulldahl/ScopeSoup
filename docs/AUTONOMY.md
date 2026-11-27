# Autonomy: the limits that keep a run from wandering

How much Scope Soup does is one setting, the `level` ([`RULES.md`](RULES.md), [`RUNNING.md`](RUNNING.md), "Levels"; decisions 52 to 59 in [`DECISIONS.md`](DECISIONS.md)). Questions always go to a person. Areas, Steer, Assume and Auto, plan first, and assume and tell were never built and are retired (decisions 13, 38, 58). What was built stays and is described here: the fence and the progress guards, the limits of the `persistence` setting, questions with options on the item page, and the proposed restructuring ([`DESIGN.md`](DESIGN.md), "Agents push back").

The orchestrator can fail in two directions: run far on a wrong guess, or stop at every small question. Both waste a person's attention. An Item stops only for a decision, the fence, no progress, or not ready; it stops with what was tried, the options and a recommendation, so the answer is one tap on the board; and any session may say the Item itself is wrong by proposing a rewrite for a person to accept, edit or reject. Only that Item stops: the loop goes on with the others.

## Two guards against wandering

Built. The session is never asked to judge its own drift: the program checks both guards.

**The fence (scope).** The triage states the Item's size (`small`, `medium`, `large`) and the paths it should touch (`paths` in its answer). From level 3, before a built change goes to review, the program compares the branch's real change with them: the files it changes and its changed lines (added plus removed, from `git diff --numstat` against where the branch left main). The limits are constants in `src/core/fence.ts`:

| What | Limit | Why |
|---|---|---|
| Changed files outside the triage's paths | 5 (`FENCE_OUTSIDE_FILES`) | Leaves room for the docs, a fixture and a shared type a change usually also touches. |
| Changed lines, `small` | 300 (`FENCE_LINES`) | Tests and docs count too, so the limits are generous: the fence stops a change that has wandered, not one a little larger than guessed. |
| Changed lines, `medium` | 1,000 | |
| Changed lines, `large` | 3,000 | |

A file counts as inside when the triage named it, it is under a named folder, a named glob (`*`, `**`, `?`) matches it, or it sits beside a named file in the same folder (a test next to its code). A change past either limit is parked as a decision (`orchestrator.fenced`): the report says which files are outside and how much larger it is ("2.5 times the 300 a small Item is held to"), with a proposed split (the part inside the paths, then the rest by folder, at most four parts) and two options, "Cut it back" (recommended) and "Go on as it is". The answer resumes the implementor's own session with the report and the answer. What the person saw widens the fence for that Item, so "Go on as it is" goes on to review, and a change that grows again is stopped again. A change inside the limits goes on to review. An Item with no triage, or one whose triage named no paths, is not fenced. At level 2 there is no step between the build and the merge, so there is no fence.

**Progress.** Rounds are judged by whether they get anywhere, not by how long they take. Each ends the Item's run (escalated, with the open findings or the failure) even before the `persistence` slider's round limit:
- A review round that still has `must` findings must have fewer than the round before. The first round sets the count; an approval starts it afresh.
- The same failure twice in a row: the same `must` finding as the round before (the same file and text, case and spacing aside; a reworded finding is another), or a merge that fails the same way as the merge before (the check fails in the same files, or with the same output when it names none; a conflict with the same change).
- A reviewer's `should` findings on a change it approves follow `review.shouldFindings` (decision 95): `"fix"` (the default) sends them back to the implementor once before the merge, a round that is not counted toward the limit or the progress guard; what an approval still says `should` after that round merges and becomes one Item draft. `"draft"` merges at once and makes them one draft. Drafts (also those agents list in `drafts`) wait for a person's Approve; nothing is filed on a host by itself. An implementor that answers done with nothing committed on its first build found nothing to change in the code: the Item is escalated as "Nothing to change" for a person to close (or to answer, which runs the step again), not retried.

Also built: a proposed split when triage finds an item too large (above), and the limits on fix rounds and on failed attempts set by the `persistence` slider. A send-back by a person starts a fresh budget of fix rounds, counted from the send-back; the agents' earlier rounds do not count against it, and neither do the progress guards' memory.
