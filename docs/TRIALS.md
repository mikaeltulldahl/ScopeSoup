# Trials

Issue numbers written GF-n refer to the tracker of the earlier private repository and are not issues here.

What has been run for real, as opposed to tested with fakes. Add a dated entry when something new is tried.

## Keeping trials cheap

A trial checks the machinery, not the quality of the code, so use the smallest models. In the trial's `scopesoup.config.json`:

```json
"roles": {
  "triage":    { "model": "haiku" },
  "implement": { "model": "haiku" },
  "fix":       { "model": "haiku" },
  "review":    { "model": "sonnet" }
}
```

Any role may run on any model. A reviewer on a different model from the implementor is recommended, not required, which is why review is the one step above haiku here; Scope Soup prints that advice at start when they are the same. Keep the items tiny, and leave `maxParallelSessions` at 1.

## 2026-11-18: GitHub sync against a real private project, read-only

`pnpm start` against a private repository, read-only.

- Synced its open issues, pull requests and runs with no failed part.
- The board rendered at 390 and 1280 px with no console errors and no horizontal overflow.
- Found and fixed: the orchestrator and the board disagreed on the value of the stop switch; a change waiting for the owner's approval was shown as waiting for a reviewer; every merged batch was drawn as a bisect.

## 2026-11-18: one item through the packet cycle with real `claude -p` sessions

A throwaway repository with one item ("add a slugify function"), stage 1 rules on, `dryRun` off, Claude Code CLI 2.1.327 on Linux.

| Step | Model | Seconds | Outcome |
|---|---|---|---|
| triage | haiku | 11 | Found a decision hidden in the item (keep non-Latin letters or not) and parked it for the owner instead of choosing |
| triage, after the answer | haiku | 8 | Ready, small, low risk |
| implement | sonnet | 27 | Committed the function and tests on its branch; the tests pass |
| review | opus | 18 | Approved, with one real finding about letters that do not decompose |

Confirmed by this run:
- The prompt on stdin, `--json-schema` together with stream output, and the structured answers all work; no malformed stream lines.
- Usage was read from the stream: both windows, with utilisation and reset time.
- The worktree was removed afterwards and no process was left behind.

Found:
- Weekly pacing stopped the run after triage (38 % of the week used against an even pace of 13 %) and would have waited two days. Pacing is now its own switch, off by default.
- There is no way yet to answer a parked decision except through code; the board needs that action.
- The reviewer's finding was recorded but nothing acts on a "should" finding of an approved change.

Not tried: a usage limit being hit, resuming a session, a stall, several sessions at once, Windows.

## 2026-11-18: Scope Soup takes an issue of its own repository to a merged pull request

Scope Soup ran on this repository with writes on (`SCOPESOUP_WRITE=1`), stage 1 rules, `inviteLabel: "scopesoup"`, haiku for triage, implement and fix, sonnet for review. Issue 17 ("Add GET /api/health") carried the label; the seven other open issues did not and were skipped as "not invited".

It took three runs. The first two each found a defect in Scope Soup, which was fixed through the normal issue and pull request route before the next run.

| Run | What happened | Led to |
|---|---|---|
| 1 | The implementor chained its first shell commands, had them refused, concluded the shell was unavailable and committed nothing. Scope Soup showed the owner a "decision". | GF-19: every prompt lists the commands the role may run; a refused tool is an escalation, not a decision |
| 2 | The implementor committed a correct change, but `pnpm check` exited 1 in its session and the output was too long for it to find the failing test. The failure was a fragile test tripped by a warning line from the trial's own environment. | GF-21: `pnpm test` prints dots and then only failures; the test fixed |
| 3 | Triage (13 s), implement (35 s), review asking for changes with two findings (14 s), fix (70 s), second review approving (7 s). Scope Soup pushed `scopesoup/17`, opened pull request 23 with the summary and a closing line for issue 17, and wrote the review on it. | The pull request was checked with `pnpm check` and merged by the orchestrator session. About a minute later Scope Soup saw the merge, wrote `orchestrator.finished`, forgot the packet and deleted the local branch. |

Confirmed by run 3:
- The write path against the real GitHub: push, opening a pull request, a comment.
- A fix round driven by a reviewer's findings.
- The newest main fetched before the branch was made.
- Finishing after a merge, with no branch and no process left behind.

Still not tried: a usage limit being hit, resuming a session, a stall, several sessions at once, Windows, a failed push, an owner-risk change waiting for approval, a decision answered on the board during a real run.

Notes:
- Everything ran in a temporary cloud container. Scope Soup has not yet run on a machine of the owner's.
- The pull request and comment were made with the owner's identity, so they read as the owner's. The tool's own GitHub App is still to come.
- The 5-hour usage window stood at 90 % during the run, mostly from the day's other work.

## 2026-11-18: first trial on Windows

A private synthetic repository, made for trials and kept for later ones. It is a tiny Node project with one helper and one test. Windows 11, Node 26.13, Claude Code CLI 2.1.325 started as `claude.exe` from PATH (the native install in `.local\bin`). Scope Soup ran from branch `scopesoup/26` (issue 26).

One item, labelled `scopesoup`: "Add a slugify function". Writes were off (no `SCOPESOUP_WRITE`), so nothing was pushed. Stage 1 rules, `dryRun` false, `keepAwake` true, haiku for triage and implement, sonnet for review.

| Step | Model | Seconds | Outcome |
|---|---|---|---|
| triage | haiku | 11 | Ready, small, low risk |
| implement | haiku | 11 | Stopped by the stop switch (`POST /api/pause`). The session was marked cancelled and logged as interrupted, not as a failure |
| implement, after `POST /api/resume` | haiku | 19 | Resumed 19 s after the pause. Continued the cut-off session and committed `src/slugify.js` and its test on `scopesoup/1` |
| review | sonnet | 13 | Approved and handed to the merge queue. The queue is connected to nothing, so with writes off the work stays on the local branch |

Confirmed by this run:
- Sessions start on Windows with `claude.exe` resolved from PATH. The prompt on stdin, the structured answers and the usage readings (5-hour window 31 %, weekly 47 %) all worked.
- Stopping mid-run: before the pause the session was `claude.exe` with a `bash.exe` and a `conhost.exe` child. A few seconds after the pause none of them existed, as a process listing showed. `taskkill /T /F` ended the tree.
- Keep-awake on and off: `orchestrator.keep_awake` was true when the first session started, false at the pause, true again at resume, and false when the review was done and nothing was left to do. The `powershell.exe` holder existed as a child of Scope Soup while it held, and was gone after each release.
- The worktree under `data\workspaces` was removed afterwards, and the git worktree list was clean.
- Scope Soup itself was then ended with a hard kill. No child process was left.

Found:
- A project configuration with `riskClasses` on and no effects is refused at start, with a clear message. The trial's first configuration did this.

Not tried on Windows:
- The request seen in `powercfg /requests`. It needs an administrator terminal. Only the holder process and the events were observed.
- The laptop actually left idle past its sleep timer.
- The startup sweep against a real leftover session. It was covered only by the test, with a harmless process.
- A stall.
- A usage limit.
- A `.cmd`-only install of `claude` in a real run.
- Writes to the host.

## 2026-11-19: the whole loop on the stand-in (GF-36)

The stand-in from `pnpm standin` (GF-36): bare remotes for an outer repository and a small project, the project as a submodule, a pool of two clones, items on `refs/scopesoup/meta` of the project's remote. Windows 11, Node 26.13, git 2.36, Claude Code CLI 2.1.325 as `claude.exe`. Scope Soup from `main` at 092b15b. Configuration as the script writes it: gitmeta host with writes on, pool workspaces, `landing: "push"` with `node --test` as the check, `testsWithChange` on, haiku for triage, implement and fix, sonnet for review, `dryRun` false.

| Item | What it tested | Outcome |
|---|---|---|
| A-1 "Add nautical miles" | Written on the board's form, nothing touched by hand after | Triage, implement with a test, review (approve, one "should"), check, push. Landed on the remote's `main` about 70 s after it was created |
| A-2 "Round converted values" | An item that needs a decision | Triage put it down with three options and a recommendation. Answered on the item page with "Use this". Triage asked a follow-up (how many figures); answered "12" in the answer box. Then implemented, reviewed and landed |
| A-3 "Add statute miles and yards" | A check that fails once | While A-3 was implemented, a "teammate" pushed a commit to the remote's `main` adding unit names and a test that every unit has one. At landing, after the rebase, the check failed (exit code 1) and nothing was pushed. Fix round 1 of 2 added the names; review again, check passed, landed on top of the teammate's commit |
| A-4 "Add inches and feet" | Scope Soup stopped during review, `data/` deleted, started again | The rebuild from the log put A-4 at review and restored A-2's two answers. Landed, but see the first finding below |
| A-5 "Accept upper-case unit names" | The item says "no test is needed" | Triage told the implementer the project needs a test anyway; it added one. Landed |
| A-6 "Warn when a conversion loses precision" | The owner's answer says "no test is needed" | The implementer added a test anyway. Landed |

The remote's `main` holds what landed: the commits of the seven items (A-3 as two, its own and the fix) and the teammate's, each with its tests, and the meta ref holds the seven items with their whole logs. Each session's cost as the CLI reported it: about $0.01 for a haiku session and $0.14 for a sonnet review. The 5-hour window went from 34 % to 36 % over the run.

Confirmed by this run:
- The whole loop with nothing touched by hand: board, triage, implement with tests, review on another model, check, fast-forward push to the main branch, item done.
- A question in the log, answered on the item page, picked up again with the answer in the prompt.
- A failed check at landing pushes nothing and goes to a fix round with the check's output.
- After `data/` is deleted the store is rebuilt from the logs: items done stay done, the item mid-review starts its review again, answers come back.
- The stop ended the review session; no `claude` process was left.

Found:
- GF-61: after the rebuild, the pool refused the clone that held A-4's implement commits (the new store had no record that Scope Soup made the branch there), made the branch fresh in the other clone, and started the review on a branch without the change. The reviewer saw that and asked for the change; the fix round then did the work again. Only the reviewer stood between this and an approved empty change.
- GF-62: in a pool clone the local `main` is never moved, so the review's `git diff main...HEAD` showed every earlier landed item as part of the change. A-5's reviewer said so.
- Agents' commits in the pool used the machine's global git identity. Since GF-117 each session commits as itself (`Scope Soup implement 12 (sonnet)`, a no-reply address) through environment variables.
- A test in `landing.test.ts` failed once under load while another suite ran, like those in GF-44.
- Small, for later: a landed item's page still says "handed to the merge queue… finished once it shows as done" until the next sync; the state reads "done (host: todo)".

Fixed during the run, and run again:
- GF-61 and GF-62 were fixed (PR 64, PR 63), Scope Soup restarted on `main` at 8d7c414, and the delete-`data/` case run again with A-7 "Add a function that lists units with their names". Scope Soup was stopped during the review and `data/` deleted. After the start the rebuild took clone `two`, "the clone holds A-7's newest revision 1d799354027e (from the item's log), so it is the item's own". The review ran on the real change, approved with no findings (no earlier commits in its diff any more), and A-7 landed.

Not shown:
- GF-34's case of a reviewer sending back a change without a test: no change came without one. Triage and the implementer applied the rule even when the item and the owner's answer said a test was not needed.
- A pre-push hook on the remote, a slow check command, a usage limit, two laptops.

## 2026-11-19: the release unpacked and started with Node only (GF-57)

On the owner's Windows laptop (Node 26), `pnpm web:build` then `pnpm release` made `release/scopesoup-0.0.0/` and its zip (with `tar -a`). The zip was unpacked into a temporary folder outside the repository; it has no `node_modules`. A stand-in was made with `pnpm standin` (a gitmeta configuration, `dryRun` set to true so no `claude` session could start), and the unpacked `scopesoup.cmd` was started with `SCOPESOUP_PORT=4357`.

- It printed "Scope Soup is listening", synced `refs/scopesoup/meta` and started the orchestrator; the board's page answered 200 on 4357.
- It was stopped afterwards and the port no longer answered.

Not shown: the POSIX script `scopesoup.sh` (not run, no POSIX machine), a machine with no network at all (the run used no registry access, but the laptop was online), and anything past the board answering (no item was taken through the loop).

## 2026-11-19: landing through the merge queue on the stand-in (GF-106)

`landing: "queue"` was run for real with real git and the project's own check (`node --test`), and with no `claude` session at all. A stand-in was made in a temporary folder, `dryRun` was set to true (so no session could start), and `pnpm queue-trial setup <folder>` seeded it: four items on the meta ref, each with the log lines a finished item has (a `revision` and a passing `review` of that revision), and their branches committed by hand in the pool's two clones (`src/queueTrial.ts`). Scope Soup was started on it with `SCOPESOUP_PORT=4340`. It rebuilt each item's packet from the log, took the clone that holds the branch, and handed the change to the queue. Nothing in the trial spent model usage.

Round 1, four changes ready at once (A-1 area helper, A-2 volume helper, A-3 changes the length of a kilometre so an existing test fails, A-4 mass helper), all in one batch of four:
- Check on the chain of four: failed; the failed file was run again (the whole check, same commit): failed again.
- The mapping pointed at A-3 (the failing `test/units.test.js` against its `src/units.js`); the bisect checked the first two: passed. The first two were pushed, fast-forward, on top of the old main (`70fb461`). A-1 and A-2 got `landed` lines and their items went done.
- The first three: failed, rerun failed. A-3 was sent back: the item went to a fix step (round 1 of 2) with the failing file and the output as the finding; as the trial was in dry run it shows as "would start fix". A-4 led the next batch: a chain of one on the new main, check passed, pushed (`8b198b8`), landed.
- The remote's `main` has three commits more than the seed (A-1, A-2, A-4), no merge commit, and A-3's change is not in it. The Queue page data (`/api/board`) shows batch 1 failed with A-1 and A-2 merged, A-3 as the culprit and A-4 requeued, then batch 2 merged. The members read "(not synced)" because the queue's changes are the items themselves.

Round 2, `pnpm queue-trial flaky` while Scope Soup ran: A-5 has a test that fails the first time it runs anywhere and passes after (a marker file outside the repository). Batch 3: check failed on `test/flaky.test.js`, the rerun of the same commit passed, the batch was pushed (`35fcd45`) and `orchestrator.queue_flake` was logged naming the file. A-5 landed.

Found:
- A-6, created while Scope Soup was running, was seen by a tick between the item being created and its log lines arriving, so it was treated as a new item (a dry run would triage it) and never queued. The seeding script's order (create, then append) races the sync; it is not the queue's. It is not part of the result.
- `ctx.commit` stamps every event of a tick with the tick's start time, so a tick that spends seconds in the queue logs its events with the first second. The order is right.

Not shown: a real `claude` implementing a fix after a send-back (dry run), a conflict between two items of one batch (covered by `queueDriver.test.ts`), a stop in the middle of a check, a restart in the middle of a batch (the state is read back from the store, but no trial restarted it), batches of more than four, a slow check, two laptops, a remote with a pre-push hook.

## 2026-11-19: the review in two stages (GF-121), not run for real

The stand-in trial the issue asks for (one rule failing, then passing, with haiku) was not run. One item through the full cycle needs triage, implement, a checklist session, a fix, a second checklist session and a review, six real `claude` sessions, which is not cheap enough for the trial rules above. What is covered instead is in `src/orchestrator/tick.test.ts` ("checklist: ..."): a failed rule goes to a fix round with its reason and no review session is started; the fixed change is checked again, passes, and goes on to the review; the review depth positions pick the stages; the program-checked test rule needs no session. Run it on the stand-in (`pnpm standin`) with `review.checklist` set to one rule when the owner wants it.

## 2026-11-20: a person files, takes and hands back; Scope Soup's reviewer takes over (GF-134)

Run for real on a stand-in made by `pnpm standin`, with the configuration changed to worktrees of the project clone (`workspaces` removed: with a pool the person's branch has to be in a pool clone) and the review role on haiku. Scope Soup was started on port 4331 with `SCOPESOUP_LANDER=off`; the item commands ran as separate `node src/item.ts` processes from the project clone, `CLAUDECODE=1` set as Claude Code's shells set it. The server was up, so every command went through its API.

- With Scope Soup running, a first try filed A-1 and Scope Soup started its triage within a second; `item take` was then refused: "A-1 has a triage session running now. Scope Soup stops nothing that runs: pause Scope Soup on the board, or wait for the session to end." (The refusal is right; the trial's order was not.) The run was started again with Scope Soup paused (`POST /api/pause`) while the item was filed and taken, then resumed.
- `item new --title ... --priority minor`: filed A-1. `item take A-1 --as "Trial Person"`: held; a second `item take A-1 --as "Other Person"` was refused ("is held by Trial Person on <machine>. Ask them to release it"). `item list` showed "held by Trial Person on <machine>".
- After Scope Soup was resumed it left A-1 alone for 40 s (no session on it, the item on the board's Backlog lane with the holder shown "from claude-code").
- The person's branch `scopesoup/A-1` (one commit: a function and a test) was committed in the project clone, and `item handback A-1 --as "Trial Person" --note ...` was run. In an earlier run, without `--as`, the name came from the configuration's meta author and the command refused: "held by Trial Person ..., not by Scope Soup trial. Only the holder hands an item back." That is the rule working, and a reason to pass `--as` (or `SCOPESOUP_PERSON`) every time when the name differs from the author's.
- The hand-back pushed the branch to the stand-in's remote and wrote a `revision` line (the commit, the branch) and a `released` line. Scope Soup made a packet and the cycle went on, with real haiku sessions: checklist review (4 of 5 rules: the commit message lacked the why), a fix session (reworded the commit), the checklist again (5 of 5), the review (approve, three "should" findings), the check (`node --test`: pass) and the landing: "Landed ace7b39 in main". The item went to Done. About two and a half minutes from the hand-back to landed, four sessions.

Found:
- `item list` showed an item just handed back as "free" (nobody holds it) until it landed, though Scope Soup was reviewing it. Fixed after the trial: it shows "in review".
- Filing and then taking raced Scope Soup's pick-up (see the first bullet), so `item new --take` was added: the item is created already held, in one meta commit. Covered by tests (`src/items/take.test.ts`, and through the server in `cli.test.ts`), not run again on the stand-in.
- The reviewer's three findings are `should`, so they did not stop the landing; the change landed with them. That is the existing rule.
- The trial script's `fetch` reused a connection the server had closed (ECONNRESET); the script retries. The server was not at fault.

Not shown: GitHub with a real token (the commands are tested against a fake API only), a hand-back from a pool of clones (it waits unless the branch is in a clone), two laptops (a person on one and Scope Soup on another), the board showing "quiet" after a day (tested on data), and a hand-back with the reviewer rule off.

## 2026-11-20: who commits are authored and committed by (GF-117), not run on the stand-in

No real session was run for this. What is covered instead, with synthetic repositories: `runner.test.ts` checks that a session's commit has the session as author and no personal address; `landing.test.ts` ("a rebased landing keeps the session as author ...") lands a branch from a clone whose configuration names a person, and the pushed commit reads `%an|%ae|%cn|%ce` = `Scope Soup implement 1 (sonnet)|scopesoup@box.invalid|Scope Soup|scopesoup@landing.invalid`, with no personal name or address. `queueDriver.test.ts` ("a queued change keeps the session as author ...") does the same through the merge queue's cherry-pick and reads `Scope Soup implement 1 (sonnet)|scopesoup@box.invalid|Scope Soup|scopesoup@queue.invalid` on the remote's main. Run a haiku session on the stand-in (`pnpm standin`) and read `git log --format='%an|%ae|%cn|%ce'` on its remote when the owner wants it shown on a real session.

## 2026-11-22: two Scope Soup instances on one machine against one stand-in remote, and a person's own turn (GF-385)

Run on the owner's Windows laptop (Node 26.13, git 2.36) from branch `scopesoup/385`, on a stand-in from `pnpm standin`, with no real `claude`: the configuration's `claude` was `node` with a trial-only fake script that answers each role's schema (a first look that is ready with no draft, an implementor that commits `notes/<item>.txt`, a reviewer that approves). Two configurations were made from the stand-in's: `trial-a` (prefix A, `repoPath` the stand-in's clone, data in `data-a`, port 4396, `SCOPESOUP_PERSON=ada`) and `trial-b` (prefix B, a second clone of the same bare remote, data in `data-b`, port 4397, `SCOPESOUP_PERSON=bo`), both worktree workspaces, level 4, one session at a time, the lander lease on (the default), and a check command that waits 25 s and then runs the project's `node --test`, so that landings overlap.

- Five Items were filed through the two servers (A-1..A-3 on trial-a, B-1, B-2 on trial-b), and B-3 was filed already held by bo (`POST /api/items` with `take`). Agents and landing were started on both within a second.
- **Never the same Item.** Each Item's log shows the sessions of one machine only: trial-a ran A-1, A-3 and B-2, trial-b ran A-2 and B-1. Both claimed A-1 in the same second; the fold kept trial-a's, and trial-b recorded `orchestrator.claim_lost` ("triage for A-1 ... does not start: held by scopesoup on trial-a"); trial-a lost A-2 and B-1 to trial-b the same way.
- **One lands while the other waits.** trial-a took the lander lease and landed A-1; meanwhile trial-b logged `orchestrator.lander_wait` four times ("The merge queue waits: trial-a lands until ..."). Then trial-b landed A-2 and B-1 in one batch while trial-a waited ("trial-b lands until ..."), then trial-a landed A-3 and B-2, then trial-b landed B-3. The remote's main has the six commits, fast-forward, in that order.
- **A person's own turn.** bo's board (trial-b) had B-3 in "Your turn" ("held by bo on trial-b; Scope Soup leaves it alone until they hand it back or release it", tag "your turn"); ada's board (trial-a) showed the same card in the Backlog with the tag "bo's turn" and an empty "Your turn". Neither Scope Soup started B-3 while bo held it.
- **The person hands back.** bo committed `notes/B-3.txt` on `scopesoup/B-3` in trial-b's clone and ran `item handback B-3 --as bo` against trial-b's server: a `revision` line with `handback: true` and a `released` line. trial-b took it on (review, check, landing) and landed it.

Not shown: the take and hand-back from buttons on the board (there are none; the item commands went through the server the board is served from, and the board showed the result), real `claude` sessions (the fake answered; the real sessions' side of the cycle was shown in the earlier trials), two physical laptops, and the "Quiet" note on a person's hold after a day (tested on data). The board running during the trial was started before a small fix found in it: a person's held Item got a number in the Backlog's planned order (B-3 was "1."), though Scope Soup never starts it; it now gets none (`board.test.ts`).

## 2026-11-22: onboarding a project whose backlog is on GitHub Issues, choosing Items from now on, and the import (GF-363)

A stand-in, run on the owner's Windows laptop from branch `scopesoup/363`, with synthetic data only and no real GitHub, `claude` or repository. The onboarding skill is instructions for an agent, so its steps were followed by hand, not by a `claude` session running `/scopesoup:scopesoup-onboard`.

- **The project**: a fresh local repository `tides` (README, `package.json`, a lockfile, an ignored `.env`) pushed to a bare `origin.git` in a temporary folder.
- **The skill's steps, as written**: question 1 confirmed the clone; `git remote -v` and `git ls-remote origin HEAD` gave `origin` and `main` (`refs/remotes/origin/HEAD` was not set in the fresh clone, so `mainBranch` came from the remote's HEAD). The config folder `tides-scopesoup/` was checked to be outside any repository. Question 2, in two parts: today GitHub Issues (`harbour/tides`, given by hand, since the stand-in's remote is a local path and not a GitHub URL), from now on Items; its third part, what to do with the issues on GitHub: label. Question 3: `git ls-remote origin.git refs/heads/scopesoup-meta` printed nothing, so prefix `A`; `machineName` `laptop-a`. Step 4c: `pnpm config:setup` proposed `npm ci` from the lockfile, `.env` as a personal file and `package-lock.json` as watched; written with `--write`. Step 6: the `repoPath` clone was made, the config written (gitmeta, `write: true`, prefix A, level 0), and `pnpm config:check` said it was valid with no recommendations.
- **Step 6b, the import**: against `fakeIssues` from `src/hosts/github/fakeIssues.ts`, filled like a real issue set: an epic with two sub-issues (parent links), blockers (#3 blocked by #2, #9 by #2 and #3), `priority:*` and other labels, an issue assigned to the token's user and one to someone else, five comments on one issue (one from a bot), an empty body, a link to another repository, a pull request (#6) and a closed issue (#7). `pnpm item` has no switch for the API's address, so a trial script called `runItemCli` (what `pnpm item` runs) with the same arguments and the fake as its `fetch`, in process; nothing was served on a port.
  - `--on-github label` with no terminal and no `--yes`: refused ("needs a yes"), nothing read or written.
  - `--dry-run`: 7 of 7 issues would be imported (#1-#5, #8, #9 as A-1..A-7), the 7 would be labelled; nothing written.
  - `--on-github label --yes` (the command step 6b gives): one meta commit "Import 7 issues from GitHub harbour/tides" by Sam Example, pushed to `origin.git`; then the label `moved-to-scopesoup` was created and each of the 7 issues labelled and commented once. The pull request and the closed issue were not imported and not touched; no issue was closed.
  - The same again: "Nothing new to import", and on GitHub each "already done before": no write.
  - Read on the remote's `scopesoup-meta`: A-1 has priority major and "Sub-issues: A-2, A-3."; A-3 has `parent: A-1`, `blockedBy: A-2` and "Needs A-2 first."; A-7 `blockedBy: A-2, A-3`; A-2 has a `claimed` line by Sam Example (assigned to the token's user); A-4 has "the last 3 of 4 comments" (the bot's left out) and "Assigned there to @bea-example", and its "#6" became `harbour/tides#6` (the pull request is not an Item); each Item has `importedFrom: github:harbour/tides#N` and a link. The token was not printed.

Not shown: a real `claude` session running the skill (the questions' wording was not tried on a person), a real GitHub and token, the question asked in a terminal (tested in `cli.test.ts`), `--on-github close` (tested there), and a remote whose URL names the GitHub repository. The temporary folder was deleted afterwards.

## 2026-11-23: offboarding on the stand-in (GF-152), automated, no agent session

Run on the owner's Windows laptop from branch `scopesoup/152`, as `src/offboard/trial.slow.test.ts` (part of `pnpm check`), with synthetic data only: the stand-in of GF-36 in a temporary folder with local bare remotes, a fake GitHub and no real `claude`.

- **Onboard**: the stand-in's shared settings on `refs/scopesoup/meta`; the setup script landed from `scopesoup/onboard`, the CLAUDE.md section and the plugin lines landed on main; the manifest written as `settings:init` and `pnpm offboard record` write it; a config folder of its own naming the person's checkout (`ownClone`, `realPaths`).
- **One Item**: filed with `item new` (A-1 on the meta ref, pushed). Its run was done by hand with Scope Soup's own pieces, not an agent session: the branch `scopesoup/A-1` made in a pool clone and pushed, the lander lease taken, the branch landed on main, the lease let go; a shared resource's lease taken (`refs/scopesoup/resources/emulator/1`); a batch's branch and its pull request (fake) left as after a failure; an unpushed `scopesoup/A-2` in the other pool clone; `scopesoup.config.v0.json` and `scopesoup.v1.sqlite` copies.
- **Plan only**: every one of those on the list, grouped, with the batch's branch and pull request and `scopesoup/A-2` kept by default; the person's label `bug` and the `priority:minor` Scope Soup did not make not on it; nothing changed. Acting refused while a board answers.
- **Offboard, every group, kept entries too**: 20 steps done, none failed. The project's remote has no `refs/scopesoup/*` and no `scopesoup/*` branch; main keeps the landed work. GitHub (fake): `scopesoup:claimed`, `scopesoup:needs-decision` and `priority:major` deleted, `bug` and `priority:minor` kept, the batch's pull request closed. The export holds `items/A-1.md`, the settings and `scopesoup-offboard.patch`, which applied to a fresh clone leaves CLAUDE.md and `.claude/settings.json` without Scope Soup's parts (the rest unchanged) and no `.scopesoup/`. The config folder and Scope Soup's clone are gone; the pool clones stay, without `scopesoup/*` branches; the person's checkout is byte for byte as before.

Not shown: a real agent session running the Item, the skill run by a `claude` session with a person, a real GitHub and token.

## 2026-11-23: a stand-in v0.1.0 upgrades to a test release and goes back (GF-150), automated

`src/upgrade/trial.slow.test.ts`, part of `pnpm check`, on the owner's Windows laptop. Two releases are built from the checkout with `buildRelease` (versions 0.1.0 and 0.2.0, a stand-in web app) and zipped. The 0.1.0 zip is unpacked into a temporary home and `setup-home` writes the pointer and the launchers (the PATH is not touched). A local HTTP server stands in for GitHub's releases API and serves 0.2.0 with its zip and digest: nothing is downloaded from the internet. Scope Soup is started through `bin/scopesoup.cmd start` (board only, no project, its own port and data folder).

- The board answered as 0.1.0, from a home. Check now found 0.2.0.
- Get latest downloaded, checked and unpacked the zip, waited for idle (nothing ran), copied the database to `backups/before-scopesoup-0.2.0/`, switched the pointer and exited with 75; the launcher started 0.2.0, which answered with Go back to 0.1.0 offered. The 0.1.0 folder stayed.
- Go back switched to 0.1.0 the same way; it offered "Return to 0.2.0".
- About 20 s in all. Not run: a real GitHub release (none was made: the owner asked to wait with releases), the sh launcher (the test picks it on macOS and Linux), and an upgrade across a format change.

