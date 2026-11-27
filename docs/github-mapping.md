# GitHub mapping

How Scope Soup keeps a project whose backlog is GitHub issues on GitHub itself: GitHub is the source of truth, and Scope Soup's store is a cache that can be rebuilt from it. The design of the GitHub mapping, agreed on 2026-11-22. API facts marked **[docs]** were checked on docs.github.com; those marked **[known]** are from memory, and `docs/research/host-apis.md` says which are confirmed.

## 1. Principles

- **GitHub wins.** For a GitHub project the issue is the Item. If GitHub and Scope Soup's store disagree, GitHub is right and the store is wrong.
- **Write-through, then refresh.** Every Item change is an API call first. Only a successful answer changes the store, and Scope Soup takes the new state from the response or from a re-read. There is no outbox and no write waiting to be sent: a failed write fails visibly (section 4).
- **The store is a cache.** The `objects` rows for GitHub Items are filled only by the poll (conditional requests, decision 9) and by the re-read after a write. If `data/` is deleted, nothing about an Item is lost.
- **Only session state stays local**: jobs (step, workspace, branch, session ids, rounds), running sessions, streams, usage, and the switches and queue. These describe what this machine is doing, not what the Item is. Losing them costs a restart of a step, never a decision.
- **Scope Soup recognises its own conventions by three signs.**
  1. Labels with the prefixes `scopesoup:`, `priority:` and `size:`.
  2. A body section headed `## Verification`.
  3. Comments that end in one hidden marker line, `<!-- scopesoup:<kind> {json} -->`; and the description of a batch's pull request, which ends in a `batch` marker.
  4. Branches named `scopesoup/<item>` (an Item's work) and `scopesoup/batch-<batch>-<commit>` (a batch of the merge queue waiting for CI).
- **Everything on GitHub is untrusted data.** A marker counts only when the comment's author is the token's own login (`whoami`). An answer marker, or an `A:` reply (section 3), also counts from an author whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. A marker from anyone else is shown as a plain comment. All text Scope Soup writes goes through `inertText`. All text it reads stays data in prompts, between the markers that prompts already use.
- **One layer.** The conventions live in a separate layer, `src/hosts/github/conventions.ts`, on top of the plain adapter. This follows DESIGN.md: "a project's own conventions would be a layer on top of it".

## 2. The mapping table

`N` is the issue number. `id(N)` is the issue's database `id`, which the sub-issue and dependency calls take. "Marker" means the hidden line described in section 3.

| Scope Soup | GitHub representation | Scope Soup → GitHub write | GitHub → Scope Soup read | Lossy? Notes |
|---|---|---|---|---|
| `ref.id` | `number` | (created by GitHub) | `number`; issues in other repositories get `owner/name#N` | No |
| `title` | `title` | `PATCH /issues/N {title}` | `title` | No. Max 256 characters [known]. |
| `body` (description) | `body`, without Scope Soup's `## Verification` section | Read, change only the description part, `PATCH {body}` (made inert), then re-read | `body` with the Verification section cut out | Body max 65,536 characters [known]. No If-Match on issues, so a race window of about 1 s is possible (section 4). |
| `verification` | `## Verification` section of `body` | Replace or append only that section, same call as above | Section parser (section 3) | No. An empty section reads as none. |
| `state: todo` | Open, no assignee, no `scopesoup:claimed` | If closed: `PATCH {state:"open", state_reason:"reopened"}`. Remove `scopesoup:claimed`. | Open, no assignee, no live `scopesoup:claimed` | Lossy: a person's assignee cannot be cleared by a state change, so the Item stays `doing`. |
| `state: doing` | Open with an assignee (a person's hold) or a live `scopesoup:claimed` (an agent's claim) | `item claim` assigns a person; an agent adds `scopesoup:claimed` (see holder) | Open with an assignee or a live claim | Assignees and labels need push access. Without it they are dropped silently [docs], so Scope Soup re-reads and checks. |
| `state: waiting` | Not mapped on GitHub | Refused (the board does not offer it) | Never: no label or field reads as `waiting` | Scope Soup sets `waiting` only for an unreadable Item file on the meta branch, and a GitHub issue is never unreadable. The board column "Queued" is derived from the pull request and is unrelated. |
| `state: done` | Closed, `state_reason` `completed` (or null) | `PATCH {state:"closed", state_reason:"completed"}` after the merged comment | Closed and not abandoned | No |
| `state: abandoned` | Closed, `state_reason` `not_planned` or `duplicate` | `PATCH {state:"closed", state_reason:"not_planned"}`; for a duplicate, `state_reason:"duplicate", duplicate_issue_id: id(target)` [docs] | Closed with `not_planned` or `duplicate` | No |
| `hostState` | `open` / `closed:<state_reason>` | (read-only) | As today | No |
| `priority` | One label: `priority:blocker`, `priority:critical`, `priority:major`, `priority:minor` | Add the new label, delete the other `priority:*` labels (add/remove endpoints, never a full replace). Clearing the priority deletes all of them. | `priorityFromLabels`: case-insensitive; the most urgent wins | No. Today's `createWork` drops the priority; that ends. |
| Stated size | `size:small` / `size:medium` | Only when a person sets it. Never written from the triage's size. | `statedSize` (unchanged) | The triage's `size` goes into the log comment, not a label, because the label makes the Item skip the triage. |
| `holder` (claim) | An agent: label `scopesoup:claimed` plus one claim comment whose marker holds `until` and `machine` (the required `machineName` setting; never the computer's host name). A person: the assignee. | Create the claim comment, then add the label. Renew by `PATCH /issues/comments/{id}`. Release by editing it to "Released" and removing the label. | Agent holder = the live claim comment (lowest comment id, `until` in the future, not released). Person holder = assignee. | **Lossy**: GitHub has no expiry; it lives only in the claim comment's marker. An expired claim whose label stays counts as no claim. |
| `parent` | Sub-issue parent | `POST /issues/{parent}/sub_issues {sub_issue_id: id(N)}`; moving uses `replace_parent: true`; clearing uses `DELETE /issues/{parent}/sub_issue {sub_issue_id}` [docs] | `parent_issue_url` | The parent must have the same repository owner [docs]. |
| `children`, `openChildren` | Sub-issues | Order: `PATCH /issues/N/sub_issues/priority {sub_issue_id, after_id}` [docs] | `sub_issues_summary` total / completed | The order is not read today. At most 100 sub-issues per parent and 8 levels [known]. |
| `blockedBy` | Issue dependencies "blocked by" | `POST /issues/N/dependencies/blocked_by {issue_id: id(B)}`; removing uses `DELETE .../blocked_by/{issue_id}` [docs] | `GET .../blocked_by` when the summary says there is one (as today) | Reverses an earlier decision. The read keeps only open blockers, which is enough for `openBlockers`. |
| `blocks` link | Dependencies "blocking" | Written as `blocked_by` on the other issue | `GET .../dependencies/blocking` (new; only for the Item page) | No |
| `duplicateOf` | Open Item: a question comment. On close: `state_reason:"duplicate"` + `duplicate_issue_id`. | The close, only on the answer | `closed:duplicate`. The target comes from the timeline event `marked_as_duplicate` [known]. | Lossy: the issue object does not name the target. |
| `conflictsWith` | A question comment (as today), then a line in the log comment | (the comment) | Log comment marker | **Lossy**: no GitHub field. Visible only as text plus a cross-reference. |
| `related` | A line in the log comment that names `#M` | (the comment) | Log comment marker | **Lossy**: GitHub shows only a "mentioned" cross-reference on `#M`. |
| `labels` | All labels | Scope Soup adds or removes only `scopesoup:*`, `priority:*`, `size:*`, and the project's bug label when it creates an Item. On a person's Accept or Edit of a triage rewrite, also the labels the rewrite proposes (section 3, "Labels in a rewrite") | `labels` as they are | Other labels are never removed. |
| `needsDecision` | Open question comments, plus the label `scopesoup:needs-decision` | Add the label with a question or a triage rewrite; remove it once the Item no longer waits for an answer (below) | True while the Item waits for an answer, the label's rule: a question comment has no answer comment, or a triage rewrite waits for Accept, Edit or Reject | The label means "the Item waits for an answer": an open Scope Soup question, or a triage rewrite waiting for Accept, Edit or Reject. It is for people to filter by and is never read as state. |
| `openQuestions` (with options, recommendation, context, parked, round) | One comment per question, marker `question` | `POST /issues/N/comments` | Parse the marker. Question id = comment id. | Notifies watchers; that is wanted. |
| Answers (`person.answers`: answer, question, options, `textHash`, by, at) | One comment per answer, marker `answer` with `to` = question comment id; answers sent together from the board are one comment with an `answers` list | `POST /issues/N/comments` | Answer comments by trusted authors | No. Answer reuse works from these. |
| Triage rewrite (`job.rewrite`: original, text, round, questions, labels) | One comment per round, marker `rewrite`; its questions are question comments with `"rewrite": <comment id>` | Comment. Accept or Edit: body `PATCH` (decision 48), then the proposed label changes one call per label, plus an answer comment with `"proposal":"accepted"` or `"edited"`. Reject: answer comment with `"rejected"`. | Newest unanswered `rewrite` comment; `original` = the body whose sha256 is `bodySha` | Rewrite limit about 60,000 characters. `settled` and `stop` stay in the job. |
| Proposed restructuring (`proposal`: reason, original, parts, carried) | Question comment with `proposal` in its marker | Comment. Accept makes each part where it goes (sub-issue, related or unlinked issue, or a section added to an existing issue), each with the "Part n of restructuring <id> of #N." line, then narrows, leaves or closes the issue (decision 94). | Marker. `created` = issues carrying the part line. | `created` stops being stored. A restructuring over the size limit stays local, and the board says so. |
| Log `created` | The issue's `created_at` and `user` | (none) | Timeline | No |
| Log `edited` (changed, via, was) | GitHub's own edit history, plus a log-comment line for Scope Soup's edits (`changed`, `via`, `wasSha`) | Log comment edit | Timeline `renamed`, labeled/unlabeled; the log comment | **Lossy**: REST does not give the body edit history [known]. `was` becomes a hash. |
| Log `claimed` / `released` | Claim comment (see holder) | As holder | As holder | Machine kept in the marker |
| Log `session` (role, model, outcome, summary, durationMs, next, size; sessionId, costUsd, ready) | A line in the log comment | Log comment edit | Marker | Summary cut to 500 characters. Oldest lines dropped over 60,000 characters (`dropped` counts them). |
| Log `question` / `answer` | Question and answer comments | As above | As above | No |
| Log `assumption` (`decisions`, each question, chosen, others, why) and a person's verdicts (`accepted`, `overturned`) | One comment per implementor answer with decisions, marker `assumption` with `decisions`; the verdicts go into the same marker's `settled` list (`n`, verdict, by, at, answer, item; `work: true` instead of `item` when the answer went into the running work), the comment edited in place. While any is open the issue has the label `scopesoup:assumption`, which does not block and is not `scopesoup:needs-decision`. | `POST /issues/N/comments` (label first), then `PATCH /issues/comments/{id}`. While the change has not merged and is still in the implementor's hands, Overturn creates no issue and writes only the verdict. Otherwise (merged, in the merge queue, handed over, or no work under way) Overturn first creates the new issue (blocked by this one while its change has not merged), whose body ends with a hidden `<!-- scopesoup:overturns {item, decision} -->` line; pressed again, it reuses the issue that line names the decision in, and writes only the verdict. | Markers from the token's own login. Decision id = `<comment id>-<n>`. | No |
| Log `revision` (sha, branch, handback) | A log line; for a hand-back, the existing pull request with label `scopesoup:review` | Log comment edit | Marker; pull requests as today | No |
| Log `review` (sha, verdict, findings) | A log line; findings cut to 2,000 characters | Log comment edit | Marker | Long findings stay in the job |
| Log `check` (sha, verdict, command, findings, batch) | A log line | Log comment edit | Marker | Findings cut to 2,000 characters |
| Log `merged` (sha, target, batch) | The closing comment "Merged on …" with marker `merged` | Today's `closeWork`, plus the marker | Marker. Counts for `mergedWork` only if newer than the last `reopened` timeline event. | No |
| `history` | Comments plus timeline events, in words | (none) | `GET /issues/N/timeline`, only when the Item page opens | No `machine` for events GitHub made |
| `updatedAt` | `updated_at` | (set by GitHub) | `updated_at` | A comment bumps it [known], so the poll sees new answers. |
| `risk` (meta branch header) | None | (none) | (none) | Removed |

Not mapped: milestone, `locked`, reactions, issue types and organisation issue fields (user-owned repositories have neither), GitHub Projects fields.

## 3. Formats

### Labels

Scope Soup creates a label the first time it needs it, with `POST /repos/{r}/labels {name, color, description}`. A 422 `already_exists` is fine. It never recolours or renames an existing label. A project that already has `priority:high` keeps it. Scope Soup does not read it, and the board lists it under "labels Scope Soup does not know".

| Label | Colour | Description | When created |
|---|---|---|---|
| `scopesoup:needs-decision` | `d93f0b` | A Scope Soup question or rewrite waits for an answer | First question or rewrite |
| `scopesoup:claimed` | `0e8a16` | Held by a Scope Soup agent (see the claim comment) | First claim |
| `scopesoup:todo` | `0052cc` | In To do: Scope Soup's agents may start it (without it, it waits in Backlog) | First move to To do (decision 121). An open issue without it is in Backlog; new issues get it only when a person picks To do |
| `scopesoup:assumption` | `fef2c0` | A Scope Soup agent decided something itself: accept or overturn it on the board | First recorded decision |
| `scopesoup:review` | `1d76db` | Hand-back: Scope Soup reviews this pull request | Exists today |
| `priority:blocker` / `critical` / `major` / `minor` | `b60205` / `d93f0b` / `fbca04` / `c2e0c6` | Priority, read by Scope Soup | First write of that value |
| `size:small` / `size:medium` | `c5def5` / `bfd4f2` | Stated size: skips the triage | First write |
| `moved-to-scopesoup` | `ededed` | Moved to Scope Soup: the comment names the Item | The step on GitHub after an import, when the person says yes; with it a comment with marker `moved` (`issue`, `item`) |
$1`scopesoup:needs-decision` is on while the Item waits for an answer: a Scope Soup question is open, or a triage rewrite waits for Accept, Edit or Reject. A rewrite waits even with no question, and also when it is parked only on a label proposal. The label goes on before the question or rewrite comment is posted. It comes off only when every question is answered or deleted and the rewrite is settled: Accept, Edit or Reject, or an answer otherwise than recommended, which starts a new round (whose rewrite puts it on again). Answering a rewrite's questions with the recommendations leaves it on until Accept, Edit or Reject.

### Labels in a rewrite
$1The triage is shown the repository's labels (`GET /repos/{r}/labels`, names and descriptions) and the Item's own, without `scopesoup:*`, and may answer `labels: { add, remove }`. Scope Soup keeps only labels the repository has, never `scopesoup:*` (its code sets them), and only an add of a label the Item lacks or a remove of one it has. `priority:*` and `size:*` may be proposed like any other label; a proposed `size:*` takes effect only on Accept, like the rest. A label the repository does not have is dropped and noted in the reason the Item is parked and on the board ("Dropped, because the repository has no such label"); it is not an error. With labels proposed, the rewrite waits for an answer even with no question and the description unchanged.

The board shows the proposal with the rewrite as `+bug, −question`. **Accept** applies the description and the label changes together; **Edit** lets a person change both (`POST /api/rewrite` with `labels: { add, remove }`); **Reject** applies neither. At Accept the labels are read again, then each label is added (`POST /issues/N/labels {labels:[name]}`) or removed (`DELETE /issues/N/labels/{name}`) with its own call, never a full replace, and a re-read must show them. A change that no longer makes sense (an add of a label already there, a remove of one already gone, an add of a label the repository no longer has) is no call, so a label a person changed after the rewrite stays as they set it. The log comment gets an `edited` line with `changed: ["labels"]`, `added` and `removed`, and the answer comment on the rewrite names the changes. On the meta branch the labels are written to the Item the same way (the changes that still make sense, in the same edit as the description); the labels a triage may propose there are every label the host's Items have, without descriptions.

### The Verification section

- The section starts at a line that matches `^##\s+Verification\s*$` (any case). Lines inside fenced code blocks do not count.
- It runs to the next line starting with `# ` or `## `, or to the end of the body.
- If there are several such headings, the last one is used, and the board notes the extra ones.
- Its trimmed text is `verification`. The description is the body with that section removed, trimmed.
- On a write, Scope Soup replaces only that section, keeping its place. If there is no section, it appends `\n\n## Verification\n\n<text>`. Clearing removes the section.
- A person may edit the section freely: it is plain text. Renaming the heading (`## How to verify`) means the Item has no verification. The board shows "no verification", which is correct, because GitHub wins.

### Comment markers

A Scope Soup comment is visible markdown, then a blank line, then exactly one last line:

```
<!-- scopesoup:<kind> <json> -->
```

- `<kind>` is one of `question`, `answer`, `rewrite`, `claim`, `log`, `merged`, and `batch` on a pull request's description (below).
- `<json>` is one object, always with `"v":1`. Inside strings, `--` is written `\u002d-` (each `-` that a `-` follows becomes `\u002d`) and `>` is written `\u003e`, JSON escapes that `JSON.parse` reads back, so the HTML comment cannot end early.
- The reader takes the last line. If it does not match `^<!-- scopesoup:([a-z]+) (\{.*\}) -->$`, if the JSON does not parse, or if the author is not trusted, the comment is a plain comment.
- The marker is what Scope Soup reads. The visible part is for people and is written from the same data.

A question, for example:

```
**Q1: Which store format?**

- **SQLite** (recommended): one file, already used.
- **JSON files**: simpler to read by hand.

Answer on Scope Soup's board, or reply here with `A1: <your answer>`.

<!-- scopesoup:question {"v":1,"question":"Which store format?","options":[{"label":"SQLite","description":"one file, already used"},{"label":"JSON files","description":"simpler to read by hand"}],"recommendation":"SQLite","parked":"needs-decision","step":"triage","machine":"laptop-a"} -->
```

The other markers carry these fields:

- **Answer**: `{"v":1,"to":<question comment id>,"answer":"SQLite","by":"<login>","textHash":"<sha256 of title+description+verification>","options":["SQLite: …","JSON files: …"]}`. For a rewrite or a restructuring it also has `"proposal":"accepted|edited|rejected"`, and for a send-back `"sentBack":true`. Answers sent together from the board are one comment, `**A1:** …` and `**A2:** …` in the visible part, and one marker `{"v":1,"answers":[{"to":…,"n":1,"answer":…,"options":[…],"textHash":…}, …],"by":"<login>"}`; each entry reads as a one-answer marker (a rewrite's decision is an entry with `proposal`). A one-answer comment is written and read as before.
- **Rewrite** (marker `rewrite`): `{"v":1,"round":2,"bodySha":"<sha256 of the body it read>","labels":{"add":["bug"],"remove":["question"]}}`. The visible part is the rewrite, inside `<details><summary>Triage, round 2: proposed description</summary>`, then, when labels are proposed, a line `Labels: +bug, −question`. `labels` is left out when none are proposed.
- **Claim**: `{"v":1,"machine":"laptop-a","until":"2026-11-21T11:00:00Z","released":false}`. The visible part is one line: "Scope Soup (laptop-a) works on this until 11:00 UTC." `machine` is the project configuration's required `machineName`; the computer's host name is never written. Claims under an earlier name stay live until their `until`; this machine renews only claims under its current name.
- **Log** (one per Item, edited in place; an edit sends no notification): `{"v":1,"lines":[{"at":"…Z","kind":"session","fields":{…}}, …],"dropped":0}`. The visible part is a list in words, newest last. Once a question is deleted it also keeps `"deleted":[{"question":"Which unit?","n":2}]` and `"asked":2`, the highest question number used, which are never dropped.
- **Withdrawn question**: the question's marker with `"withdrawn":true`. The visible part is one line, "~~Q2~~ Withdrawn: Scope Soup asks again." It is no open question and takes no answer, and its number stays used.
- **Merged**: `{"v":1,"sha":"<40 hex>","target":"main","batch":12}`.
- **Batch** (the last line of a batch's pull request description, not a comment): `{"v":1,"batch":12,"sha":"<40 hex>","base":"<40 hex>","members":["3","5"]}`. It says which batch and commit the pull request is for. Scope Soup closes a pull request, or deletes its branch, only when this marker is there and the pull request was opened by the token's own login.

### The batch's pull request

With `mergeQueue.ci: "github"` the merge queue waits for the project's CI on a pull request of its own for each commit it tests (docs/RUNNING.md, "Waiting for CI on GitHub"):

| | |
|---|---|
| Head branch | `scopesoup/batch-<batch>-<first 7 digits of the commit>`, pushed by git, never forced. Unique per commit, so a rebuilt batch or a fresh store never meets an old branch. |
| Base | the main branch |
| Title | `Scope Soup merge queue: batch <batch>` |
| Description | Scope Soup's own words: "Batch 12 of Scope Soup's merge queue: #3, #5, built on main at 0f1e2d3.", a line that Scope Soup pushes the same commit when every check is green, then the `batch` marker. Items are named by number without a closing keyword, so the pull request links to no Item as its change and closes nothing. No item or agent text. |
| Labels, comments, reviewers | none |
| Read | `GET /commits/{sha}/check-runs` (latest of each name) and `GET /commits/{sha}/status` (latest of each context); for a failing GitHub Actions check, `GET /actions/jobs/{id}/logs` |
| Merged | by a fast-forward `git push` of the tested commit to main; GitHub then shows the pull request as merged. No merge API call. |
| Not merged | a red, timed-out, no-CI or ended batch (main moved, a member left; bisect probes too): one comment why (`POST /issues/N/comments`, not posted again when Scope Soup's same comment is there), then `PATCH /pulls/N {state: closed}`, then `DELETE /git/refs/heads/scopesoup/batch-...` (a 404 or 422 counts as gone) |
| Merged | only `DELETE /git/refs/heads/scopesoup/batch-...`, once GitHub shows the pull request merged (deleting an open pull request's head would close it unmerged) |
| Guard | every one of these writes needs all three: the head branch matches `scopesoup/batch-<n>-<hex>` and is the branch Scope Soup pushed, the description ends in the `batch` marker, and the pull request's author is the token's login. Otherwise nothing is written and the Queue page notes it. A failure is retried at the next tick and never holds the queue up. |

A second call for the same branch finds the open pull request (`GET /pulls?state=open&head=<owner>:<branch>`) and opens none.

### Q and A replies

Scope Soup numbers the open questions on an issue: `Q1:`, `Q2:`, … in the visible text, and `"n":1` in the marker. Numbers are not reused on that issue, also not a deleted question's: the next number is one more than the highest in the markers and in the log comment's `asked`. A reply from a trusted author (section 1) whose first line starts with `A1:` answers question 1; a bare `A:` answers the newest open question. The text after the colon is the answer. A later line that starts `A2:` (with a number) begins the next answer, so one reply can answer several questions. A reply that names an answered or unknown number is shown as a plain comment, and the board notes it.

### Claim expiry

An agent's claim is the label `scopesoup:claimed` plus a claim comment. The expiry is the `until` value in that comment's hidden marker line, a fixed 120 minutes after the claim; there is no setting. The claim is renewed by editing `until` once less than half the time is left (decision 45).

When two Scope Soup instances claim, the claim comment with the lower comment id wins while it is live. GitHub orders comments, not the two clocks. The losing instance edits its own comment to `released` and does not start.

A claim whose `until` has passed counts as no claim, and Scope Soup removes its stale label. A person's hold, made by `item claim`, is an assignee and nothing more. It never expires (as today). So an assignee always means a person.

## 4. Conflicts and edge cases

- **A person edits the issue at the same time.** Title, state, labels and assignees are separate fields and separate calls, so they never overwrite each other. The body is the risk. Scope Soup does GET, then splices, then PATCHes, then GETs again. If the body it read changed between the GET and the PATCH, the other edit is lost, but GitHub's edit history keeps it. The re-read compares the result with what Scope Soup meant to write, and on a difference it writes `orchestrator.host_write_conflict`. A rewrite's Accept checks `bodySha` first: if the body changed since the rewrite, Accept is refused with 409 `BODY_CHANGED`, and a person sees the new body next to the rewrite.
- **A person removes a label.** For `priority:*` and `size:*` this is a real change, and Scope Soup follows it. Removing `scopesoup:needs-decision` changes nothing Scope Soup reads: the question comments rule, so a question that is still open stays open.
- **A marker is edited or deleted.**
  - A deleted question comment means the question is withdrawn. If the Item is parked on it, the job is released, and the Item starts again at the triage. Since a later decision it means "don't ask that". The log comment keeps it, and every prompt names it and says not to ask it again. Scope Soup's other open questions on the issue are edited to "Withdrawn: Scope Soup asks again" and stop counting as open.
  - A deleted answer re-opens its question.
  - A marker that no longer parses counts as deleted, and the board notes it once.
  - The comment listing with `since` does not show deletions. So while an Item is parked on a question, its comments are re-listed each poll with an ETag, which costs a free 304 when nothing changed.
- **A person edits the visible part** of Scope Soup's comment. The marker still rules, and the board shows the marker's text. Their edit is not lost: it is on GitHub.
- **An issue is transferred.** GET answers 301. The Item leaves the board, its job is released, and the event `work.removed` says "moved to <url>".
- **An issue is deleted.** GET answers 410. The same as transferred, without a target.
- **Closed, then reopened.** GitHub wins: the Item is open again. The `merged` marker counts only if it is newer than the last `reopened` timeline event, so a reopened merged Item is work again, not Done.
- **Rate limits.** A personal token gets 5,000 requests an hour. A 304 is free [known]. GitHub also has secondary limits on content creation, about 80 a minute and 500 an hour [known]. One Item cycle writes about 12 times (claim, labels, a question, an answer, about six log edits, close). The poll lists changed comments for the whole repository in one conditional request: `GET /repos/{r}/issues/comments?since=…&sort=updated`. With a 403 or 429 and `retry-after`, writes wait for it, and the tick goes on with other work.
- **Offline, or GitHub down.** No Item can change. Sessions already running go on. A board action fails with the reason, and the typed text stays in the form. A step that needs a write (posting a question, closing a merged Item) is parked as "escalated: GitHub could not be written", and the next tick retries it. This is done for posting questions and rewrites: a 5xx, a rate limit or no answer at all is retried by each tick, and what GitHub may have taken before it failed is looked for among the comments first, so nothing is posted twice. A refusal (a 403 for missing rights, a label that did not take) stays an escalation for a person. Nothing is queued: a queued write would be a second truth.
- **A write fails.** The cache is not touched, the event `orchestrator.host_write_failed` is written, the board shows the failure on the Item, and the next tick retries the step. A partly done sequence (an issue created but not linked) is finished from what GitHub shows, as `linkChild` does today.
- **Token rights.** A fine-grained token needs Issues: read and write, Pull requests: read and write, Contents: read, and Metadata: read; with `mergeQueue.ci: "github"` also Checks: read, Commit statuses: read, Actions: read (the log of a failing job; without it the check's link is given instead) and Contents: read and write (deleting a batch branch). The pushes go by git with the clone's own credentials. A classic token needs `repo`. Labels and assignees without push access are dropped silently [docs], so every label and assignee write is checked by the re-read. A write that did not take effect fails as above.
- **GitHub Projects fields** (Status, Priority, Iteration in Projects v2) are out of scope. They need GraphQL and are not read or written. A team that keeps priority only there gets no priority in Scope Soup.
- **A locked issue.** A person's token can still comment. Scope Soup never locks or unlocks.

## 5. What moves to GitHub, and what stays local

**Stops being kept locally for GitHub Items:**

- kv `person.answers` → answer comments. The store reads answers from the cache.
- kv `scopesoup.blockedBy` → issue dependencies.
- Job `decision`, `triage.decision(s)` as the source of open questions → question comments. The job keeps only the index it waits on.
- Job `answered` → answer comments.
- Job `rewrite.original`, `text`, `questions`, `round` → rewrite and question comments. `rewriteRounds` is derived from the number of rewrite comments.
- Job `proposal.reason/parts/carried` → the question marker. `proposal.created` → sub-issues and their part lines.
- kv `orchestrator.logs_read` → `recover.ts` gains a GitHub path that reads the log, question and answer comments.
- The `objects` rows for GitHub work become an explicit cache that can be rebuilt.

**Stays local (session state):**

- The jobs' `step`, `workspace`, `branch`, `sessionId`, `failures`, `fixRounds`, `notBefore`, `resume`, `agentSession`, `resumeWith`, `merge`, `base`, `head`, `queued`, `merged`, `owes`, `parked`, `rewrite.settled`/`stop`, `implement`, `review` (full findings) and `reusedAnswers`. They describe a run on this machine.
- Sessions, streams, `usage_samples`, the `events` table (an audit log, never read for state).
- kv `control.*`, `runners`, `sync`, `merge queue`, `orchestrator.idle_reason`, `.said`, `.handbacks`, `.main_seen`, `.answers_wait`, `.queue*`, `.config`, `.workspaces*`. These are machine state or derived.
- The lanes stay derived (`src/core/lanes.ts`). They are never written to GitHub.

## 6. Migration

A project that Scope Soup ran on GitHub in an earlier version kept answers, blockers and parked questions in Scope Soup's own store. The only such install had them moved to GitHub once, by hand; there is no command for it. Scope Soup still reads what that move wrote: an answer comment with `"migrated":true` and an `at` counts as given at that `at`. An entry of `scopesoup.blockedBy` for a GitHub Item is not read.

## 7. The answers (2026-11-22)

1. **Claims:** the label `scopesoup:claimed` plus a claim comment. No assignee, so an assignee always means a person.
2. **Progress:** one `log` comment per Item, edited in place.
3. **Answers on GitHub:** yes, besides the board. Questions are written `Q1:`, `Q2:`; replies `A1:`, `A2:`; a bare `A:` answers the newest open question.
4. **Held for a person:** not mapped on GitHub (no `waiting`; dropped 2026-11-22). `scopesoup:needs-decision` means "the Item waits for an answer": an open Scope Soup question or a triage rewrite waiting for Accept, Edit or Reject. Queued is derived, never a label.
5. **Rewrites:** each triage round is posted as a comment.
6. **Priority:** `priority:*` labels only. Projects and organisation fields are out of scope.
