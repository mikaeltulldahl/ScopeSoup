# Autonomy: neither a wild goose chase nor a halt at every turn

**Superseded.** Areas, Steer, Assume and Auto, plan first and assume and tell were not built and are retired. How much Scope Soup does is now one setting, the `level` (`docs/RULES.md`, `docs/RUNNING.md`, "Levels"; decisions 52 to 59 in `docs/DECISIONS.md`). Questions always go to a person. What was built from this page stays: the limits of the `persistence` setting, questions with options on the item page, the proposed split, and the fence and progress guards. The rest of this page is kept as history.

Status: design, agreed in outline on 2026-11-18, settled on 2026-11-19 (decisions 38 and 44). Built so far: the fixed limits of the `persistence` slider, decisions on the item page. The `autonomy` slider that once took recommended options was removed: questions always go to a person. Planned: areas and levels, plan first, assumptions on the board, the fence and progress guards (built).

The orchestrator can fail in two directions. It can run far on a wrong guess, or it can stop and wait for an answer at every small question. Both waste the same thing: a person's attention. This is how Scope Soup is meant to find the middle.

## The idea: direction first, then growing freedom

A new feature needs a person to steer it. Once its direction is set and it has proved itself, changes to it are gradual and can happen with less asking. So freedom is not one setting for the project. It belongs to each **area** of the product, and it grows with evidence.

An area is a named part of the product with the paths that make it up ("bank import", "the board", "merge queue"). Each area has a level:

| Level | What happens to an item in the area | Typical for |
|---|---|---|
| **Steer** | Work starts with a plan a person approves: the goal, the approach, what is left out, the first slices. No code before that. The approved plan becomes items. | A new feature; an area nobody has decided the shape of |
| **Assume** | Agents build without asking. A small, reversible choice is made on the agent's recommendation and recorded on the item, where a person can overturn it. Only the stops listed below wait for an answer. | An area with an approved direction and working tests |
| **Auto** | As Assume, and low-risk changes merge without a person seeing them first. | A mature area changed in small steps |

**Steer is the plan gate for new areas.** Every area nobody has shaped yet starts at Steer, and it is the one standing approval gate. An item that touches no known area is treated as Steer. An item that spans areas takes the most careful level among them.

**Moving between levels**.
- The tool proposes moving an area up when the evidence is there: a number of items merged in it with no assumption overturned, no change reverted and no red batch traced to it. It shows the evidence; a person confirms.
- The tool moves an area down automatically, one level, when an assumption in it is overturned, a change is reverted, or an item there ends in an escalation. It says why.

This is the same shape as the staged rules in `docs/RULES.md`: those mature with the project, these with each feature.

## Plan first (the Steer level)

Planned. Today an item goes from triage to implementation with no plan step. Splitting is built on its own: when triage finds an item too large it proposes the parts, and a person accepts, edits or rejects the split on the item page; accepted, the parts become child items, invited at once, and the item an umbrella (`docs/DESIGN.md`, "Agents push back").

The plan step is plan mode made into a step of the cycle:

1. A planning session reads the item and the code and writes a plan: goal, approach, alternatives it rejected, what is out of scope, the slices in order, what proves each slice done, and the questions only a person can answer.
2. A person reads it on the item page, answers the questions, and approves, changes or rejects it. This is where steering is cheap: nothing has been built.
3. The approved plan becomes the item's fence (below) and, when it has several slices, child items.

## Assume and tell

Planned. Today every decision from triage, the implementer or the fixer waits on the item page (a set of several decisions from triage is never reused from an earlier answer, see `docs/DESIGN.md`, "Answers"); `assumption` lines that older versions wrote in the log are kept and shown in the item's history. Decision 66 brings back part of this section for the implementor: it decides questions that are cheap to change later itself and records them for Accept or Overturn on the board, and parks and asks the expensive ones.

Triage already separates "this hides a decision" from "this is ready" (built). The change is what happens next:

- A choice that is **cheap to undo** is made on the recommendation. The item records the assumption in words: what was chosen, what the other options were, why. A person sees assumptions in a list of their own, and overturning one reopens the item with the new answer.
- A choice is **not** cheap to undo when it is irreversible, costs money, touches real data, changes what users are promised, or changes the scope. Those wait, at every level.

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

## Usage is the orchestrator's to aim

Sessions are not given a usage budget to manage. The orchestrator decides what to start, from what each kind of item has cost before (by size and model) and what the windows have left, and it decides where spare quota goes: making more work ready rather than idling. A session is only ever stopped for the fence or for progress, never for having "used its share".

## A stop is never a dead end

When an item does stop:

- **Only that item stops.** The loop goes on with other items, and with making work ready when nothing else is.
- **It stops for one of a short list of reasons**: a decision that is not cheap to undo; a plan to approve; an approval of a high-risk change; the fence; no progress; not ready. Nothing else is allowed to wait for an answer.
- **It arrives prepared**: what was tried, what the options are, which one is recommended, so the answer is one tap on the board (built for decisions from triage, the implementer and the fixer; see the item page).
- **It may say the item is wrong**: any session can propose a rewrite of the item's description or verification with the reason. A person sees a diff and accepts, edits or rejects it; the item restarts from the accepted text, and a rejection goes to the next session (`docs/DESIGN.md`, "Agents push back"). Autonomy never decides this.

## How to tell whether the balance is right

Two numbers, shown per area:

- **Asked for nothing**: the share of stops a person answered with the recommendation unchanged. High means it asks too easily; that area can move up.
- **Overturned**: the share of assumptions and merged changes a person reversed. High means it runs too freely; that area moves down.

The levels are tuned on those two, not on feeling.
