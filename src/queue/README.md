# The queue engine

A batching merge queue as a pure function:

```ts
step(state: QueueState, input: QueueInput, config: QueueConfig, now: string): { state: QueueState; effects: QueueEffect[] }
```

It does no I/O and reads no clock. The caller (the orchestrator) loads the state, calls `step` with one thing that happened, stores the new state, performs the effects, and feeds each answer back as a new input. The state is plain JSON. `toBatch(state)` gives the model's `Batch[]` for the store and the board.

## How a step works

1. **Fold** (`fold.ts`): the input is written into the state as a fact: a change is ready, a run finished, the main branch is somewhere else.
2. **Advance** (`advance.ts`): from the facts alone, do everything that can be done now, and stop at the first thing that needs the caller. It is idempotent: a step with no new fact (`tick`) does nothing. While the queue is paused, facts are still recorded and advance is skipped.
3. **Record** (`step.ts`): what set the step off and what it did is appended to `state.steps` and to the `history` of each batch it touched.

## The batch

```
(no batch) --build-chain--> building --chain-built--> testing --> done
```

- **building**: the first `n` ready changes (leaders of the previous batch first) are sent out as `build-chain`. `n` is the size in `[min, max]` with the best modelled throughput given the culprit rate and the flake rate, or `clamp(round(c / p), min, max)` until 10 outcomes are known (`docs/BATCH_SIZE.md`).
- **testing**: the whole chain is tested first. Green: fast-forward to the tip. Red: the failed files are run again on the same commit (`rerun-files`); if they pass it was a flake and the batch merges. Still red: the failing files are mapped to a member by the paths it touches, and the batch is bisected. Every green prefix is merged as soon as it is known; when prefix `k-1` is green and prefix `k` red, member `k` is sent back and the members behind it lead the next batch.
- **done**: with a note saying why.

A batch also ends, and its members are rebuilt in the next one, when the main branch moves outside the queue or a member changes or leaves.

## Inputs

| Input | Meaning |
|---|---|
| `change-ready` | A change may merge, at this head, touching these paths |
| `change-left` | It may no longer merge (closed, approval withdrawn) |
| `change-head` | The change's head as the host shows it now |
| `chain-built` / `chain-failed` | The answer to `build-chain`: per member a commit (and optionally its tree), or a conflict naming the change it conflicts with |
| `run-started` | Optional: the host's run for a run the queue asked for |
| `run-finished` / `rerun-finished` | pass, fail (with the failing test files) or cancelled; a rerun also says which files ran |
| `merge-result` | The answer to `fast-forward` |
| `main-moved` | The main branch head as the host shows it now |
| `pause` / `resume` / `tick` | |

Any input may carry `by` ("poll", or the name of the person who asked), which goes into the history.

## Effects

| Effect | The caller |
|---|---|
| `build-chain` | replays each change on the previous one that applied, starting at the base |
| `start-run` | runs the full suite on a commit |
| `rerun-files` | runs only the named test files on the same commit |
| `fast-forward` | moves the main branch to a commit, only if it is at the expected one |
| `mark-merged` | records the members as merged; `tested` is the commit whose run passed |
| `send-back` | returns a change to its author: `conflict` (with whom), `culprit` (failing files, excerpt) |
| `file-flake` | files the flaky test files as a bug |
| `suspect-order-dependence` | reports files that failed and then passed on rerun in two batches in a row |
| `cancel-run` | may stop a run whose result is no longer needed |
| `report-outside-write`, `report-problem` | tells a person |
| `idle` | nothing; the reason says what the queue waits for |

One rule is checked in the engine itself and by a test with random inputs: a `fast-forward` is only ever asked for a commit that has a passing run recorded on exactly that commit.

## Settings

All in `QueueConfig` (`config.ts` has the defaults). Numbers: the batch bounds and constants, `rerunCount`, `reportFileCap`, `maxRunAttempts`, the limits on kept history. Switches: `mapping.enabled` and its rule (test suffix, feature folders, aliases: project data, none built in), `reuseResults`, `orderDependence` (`off`, `report`, `hold`), and the two stage 3 rules of `docs/RULES.md`, both off by default:

- `onlyWriter`: a move of the main branch that the queue did not make is reported. Either way the batch ends and is rebuilt on the new head.

## Design choices, and why

The design follows the usual bors-style chain: the batch size formula, the rerun of failed files on the same commit, the mapping, the bisect that rounds up and merges every green prefix, leaders, the report cap, the check that a green rerun really ran the failed files, and restarting cancelled runs. The choices that shape the engine:

| Choice | Why |
|---|---|
| Pure engine with inputs and effects, not a step that calls a host and git | The design's import rule; testable without a host; one program drives it (research problem 13) |
| State is one JSON value in the store, not a comment per batch | No host to keep it in; the "trust only own comments" and "interrupted build" cases become `chain-failed` |
| Each step records its trigger and what it did, per batch and for the queue | Problem 13: which step did what was down to chance and invisible |
| A merge is two steps: `fast-forward`, then `mark-merged` on `merge-result` | The engine cannot see the main branch; nothing is marked merged before it is |
| Member states, probes and suspect are kept in the model's vocabulary; `toBatch` | The board draws the bisect straight from it |
| Files that pass only on rerun are remembered; twice in a row is `suspect-order-dependence` | Problem 12: a rerun of only the failed files hides order and shared-state failures |
| A conflict names the change it conflicts with and the members ahead | Problem 21: a rebase on the main branch cannot fix a conflict inside a batch |
| The chain is built from the head that was handed over | The engine never rewrites a change's branch, so checks stay on the commits they ran on (problem 16) |
| Results are reused: a pass for the very same commit, a failure also for the same tree | A6.15. A failure is forgotten when one of its changes becomes ready again |
| The mapping rule and every number are settings | `docs/RULES.md`: numbers are settings |
| A refused fast-forward with the main branch in place pauses the queue | A pure engine reports and waits for a person; it does not throw |

What the engine leaves to the caller, because it belongs to a host or a project convention: labels, comments and any batch comment format, branch names for batches and their pruning, resetting a change's branch to its own commits, handing merged items to a "done" step (the caller acts on `mark-merged`), re-dispatching a run that never showed up (the caller reports `cancelled`), and filling a batch up past members that conflict (the batch is just smaller).
