# A Jira host

Research for issue #6, 2026-11-24. Reference, not instructions: nothing here is decided. Marks: **[docs]** checked on Atlassian's public documentation in this session; **[known]** from memory of the API, to check before it is built on; **[ours]** a fact about Scope Soup's code. Sites in examples are `example.atlassian.net`. No real Jira was called.

Atlassian pages used:
- Jira Cloud REST API v3: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
- Rate limiting: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- Atlassian Document Format (ADF): https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
- Entity properties: https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/
- API tokens (Cloud): https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
- Personal access tokens (Data Center): https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html
- The earlier, shorter Jira section of `docs/research/host-apis.md` (section 4).

## Summary

- Jira is a work host only. It has no pull requests and no CI, so a Jira project's changes stay on git and its code host.
- Most of the GitHub mapping carries over: an issue is an Item, a comment is a question, an answer, a claim or a log. The big differences are (1) rich text is ADF on Cloud, (2) state is a workflow status that may refuse a move, (3) priority, parent and "blocked by" are native fields, (4) hidden markers can be comment properties instead of text, (5) no conditional requests, so polling costs more.
- Recommended first slice: a read-only Jira Cloud host (list, get, comments, parent, links, priority, state), then writes. Data Center later.

## 1. What a Jira host must implement

Capabilities: `work` and `write`. Not `changes`, `ci`, `runners`, `batches`, `turn` ([ours] `src/ports/host.ts`).

### Work port

| Port call | Jira call |
|---|---|
| `listWork(since)` | `POST /rest/api/3/search/jql` with JQL `project = KEY AND updated >= "<cursor>" ORDER BY updated`, token pagination (`nextPageToken`) [known; the old `/search` was removed on Cloud, see host-apis.md]. |
| `getWork(ref)` | `GET /rest/api/3/issue/{key}?fields=...&expand=renderedFields` (not needed) and `GET /issue/{key}/comment` (paged). A moved issue still answers on its old key [known]; a deleted one is 404, which maps to `WorkGone`. |
| `labels()` | `GET /rest/api/3/label` lists all label names on the site [known]. Jira labels have no description and no per-project list. |
| `whoami()` | `GET /rest/api/3/myself` (Cloud: `accountId`, `displayName`; Data Center: `name`, `key`). |
| `apiBudget()` | None. Jira gives no remaining-quota figure for API-token traffic (section 4). |

Cursor: Jira has no ETag or `since`. The cursor is the newest `updated` time seen. JQL compares `updated` at minute resolution [known], so each poll asks from the cursor minus two minutes and drops what it already has. A comment bumps `updated` [known], so new answers show up.

Deletions are not in the change feed. A cheap key listing (`fields=key` only, JQL `project = KEY`) every few minutes finds issues that are gone or moved out, as the GitHub host's `removed` list does. Counting the cost: one request per 100 to 5,000 issues, depending on the page size [known].

### The WorkItem fields

| Field | Source |
|---|---|
| `ref.id` | the issue key, `KEY-12` (the numeric `id` is needed only in a few calls). The branch name `scopesoup/KEY-12` works as is. |
| `title`, `body` | `summary`, `description` (ADF on Cloud, section 3). |
| `state`, `hostState` | `status.statusCategory.key`: `new` is `todo`, `indeterminate` is `doing`, `done` is `done`. `hostState` is the status name. `abandoned` when `resolution` is a configured "won't do" or "duplicate" name. `waiting` is not mapped, as on GitHub. |
| `labels` | `labels` (strings, no spaces [known]). |
| `priority` | The native `priority` field, by a name map (section 2). |
| `parent`, `children`, `openChildren` | `parent` and `subtasks` in `fields`. |
| `blockedBy` | `issuelinks` of type "Blocks", the entries that say "is blocked by" (`inwardIssue` present) [known]. Only open blockers count, as on GitHub. |
| `holder` | `assignee` (a person's hold), or Scope Soup's claim (below). |
| `verification` | A heading "Verification" in the description, as on GitHub. |
| `updatedAt` | `updated`. |
| `history` | `expand=changelog`, only when the Item page opens [known]. |
| `answers`, `openQuestions`, `hostRecord`, `merged` | Parsed from comments and their properties (below). |

### Write port

| Port call | Jira call |
|---|---|
| `createWork` | `POST /rest/api/3/issue` with `project.key`, `issuetype`, `summary`, `description`, `labels`, `priority`, `parent` [known]. Needs an issue type from the config. A project whose create screen has other required fields refuses it (risk 2). |
| `editWork` (title, body, labels, priority, verification) | `PUT /rest/api/3/issue/{key}` with `fields` and, for labels, `update.labels: [{add}, {remove}]`, which never replaces the set [known]. Description: read, splice the Verification section, write whole (no `If-Match`; same race as GitHub, section 4 of github-mapping.md). |
| `editWork` state | `GET /issue/{key}/transitions`, then `POST /issue/{key}/transitions {transition:{id}}` [docs via host-apis.md]. Only moves the workflow allows from here, and a screen may demand a field (resolution). Config names the transition to use per target. |
| `editWork` parent | `PUT` with `fields.parent`; `linkChild` is then a field write, not a separate call. Hierarchy rules apply (section 2). |
| `addBlockers` | `POST /rest/api/3/issueLink {type:{name:"Blocks"}, inwardIssue:{key: blocked}, outwardIssue:{key: blocker}}`; remove with `DELETE /issueLink/{id}` [known]. Check the direction against a fixture. |
| `setAssignees` | `PUT /issue/{key}/assignee {accountId}` [known]. |
| `setLabels`, `changeLabels` | The `update.labels` add and remove above, then a re-read. |
| `comment`, `askQuestions`, `postDraft`, `answerQuestion(s)`, `postAssumptions`, `withdrawQuestions` | `POST /issue/{key}/comment`, edit with `PUT /issue/{key}/comment/{id}`, delete with `DELETE` [known]. |
| `logLine` | Scope Soup's one log per Item (below). |
| `claim`, `releaseClaim` | A claim comment and a label, as on GitHub. |
| `closeWork` | Comment with the `merged` marker, then the done transition (with a resolution if the screen needs one). |
| `openChange`, `closeChange`, `merge`, `queueCi` | Not Jira's. See section 5. |

### The markers

GitHub puts one hidden HTML comment line at the end of a comment. ADF has no hidden text and no HTML comment, so a Jira host has three options:

1. **Comment properties** (recommended). `PUT /rest/api/3/comment/{id}/properties/scopesoup` with the marker's JSON, up to 32 KB, keys up to 255 bytes [docs: entity properties support comments, issues and projects]. They are not shown in the Jira UI. Anyone who can read the comment can read them and anyone who can edit it can change them [docs], so the trust rule stays what it is on GitHub: a marker counts only when the comment's author (`author.accountId`) is the token's own account, and an answer also from the listed trusted people.
   - Cost: one extra write per comment, and a read per comment unless the comment list can expand properties (check; [known] that `GET .../comment?expand=properties` exists).
   - The write is not atomic with the comment. Post the comment, then the property. A comment without its property is a plain comment until the property lands; the retry that "looks among the comments first" ([ours] `WriteLater`) must also look for a visible tag (option 2) to finish it.
2. **A visible tag in the text.** A last line such as `scopesoup:question#a1b2c3` that points to the property, or the whole JSON in a code block. Ugly, but survives a copy of the issue to another site, where properties do not follow.
3. **Issue properties** for state that has no comment of its own: the log and the claim (`PUT /issue/{key}/properties/scopesoup.log`). Silent to watchers, invisible to people. People read the log as a comment on GitHub, where one edit sends no notification; whether a Jira comment edit notifies watchers is not checked here (open question 5).

Recommended: comment property as the marker, plus a short visible first line ("Scope Soup question Q1") so a person reads the comment without it. `Q1:` and `A1:` replies work unchanged, since they are parsed from the comment text.

## 2. GitHub concept to Jira concept

| GitHub (Scope Soup today) | Jira | Gap |
|---|---|---|
| Issue number | Issue key `KEY-12` | Ids are strings with a dash. Check every place that assumes a number or `owner/name#N`. |
| Open / closed, `state_reason` | Status in a workflow, status category, `resolution` | Per project and issue type. A move can be refused or want fields. Config must name the transitions. |
| `priority:*` label (blocker, critical, major, minor) | Native `priority` field. Default names Highest, High, Medium, Low, Lowest [known], editable per site | Names are config: a map from Jira names to the four Scope Soup values. A project with five levels must say which two go together. No label needed. |
| `size:*` label | Label `size-small` (no colon assumed) or none | Stated size can stay a label. |
| `scopesoup:*` labels | Labels. Label names cannot hold spaces; colons are probably allowed but not checked. Use `scopesoup-needs-decision`, `scopesoup-claimed`, `scopesoup-assumption`. | No colour, no description, no "repository list": a label exists by being used. |
| Assignee (a person's hold) | `assignee` (one person) | Same. |
| Claim: label plus comment with `until` | Same: label plus comment, `until` in the comment property | Jira has no expiry either. |
| Sub-issues (`parent`, 8 levels, 100 children) | `parent` field. Epic, then Story/Task/Bug, then Sub-task [known]. Hierarchy depends on the project type (company-managed or team-managed) and site settings. | A Story cannot have a Story child. A split's children must be Sub-tasks or sit under an Epic. Config: `childIssueType`. Parent, move and clear are one field write. |
| Dependencies "blocked by" | Issue link "Blocks" | Link type names are per site; "Blocks" is the default. Deleting needs the link id, found in `issuelinks`. |
| `duplicateOf` | Link "Duplicate" plus a resolution "Duplicate" [known] | Close needs the right transition and resolution. |
| Comments | Comments (ADF on Cloud) | Comment body max about 32,767 characters on Cloud by default [known]; GitHub's 65,536 and Scope Soup's `COMMENT_LIMIT` of 60,000 do not fit (risk 4). |
| Hidden marker line | Comment property (or issue property) | Section 1. Properties do not travel with a copied issue. |
| Log comment edited in place | Same, or an issue property | Section 1. |
| `needs-decision` label | Same label | |
| `updated_at` | `updated` | Minute resolution in JQL. |
| ETag, 304 | None | Every poll is a paid request. |
| Issue timeline | `expand=changelog` | Fields only; no "marked as duplicate" event, but the link is visible directly. |
| Transfer (301), delete (410) | Move changes the key; delete is 404 | Key listing finds both. |
| `@`-mentions notify | ADF: only a `mention` node notifies, plain text `@name` does not | Inertness is easier on Cloud (section 3). |
| Closing keywords in a PR | None in Jira | Nothing to defuse in Jira text. A pull request on a code host with the Jira app does react to keywords in its own way; Scope Soup's text there is made inert already. |
| Projects fields, milestone | Fix versions, components, sprints, custom fields | Out of scope, as on GitHub. |

## 3. Text format

Jira Cloud's REST v3 takes and returns description and comment bodies as ADF: a JSON tree `{version:1, type:"doc", content:[...]}` [docs]. Block nodes include paragraph, heading, bulletList, orderedList, codeBlock, blockquote, rule, table, panel, expand, media; inline nodes include text, hardBreak, mention, emoji, status, date, inlineCard; marks include strong, em, code, link, strike, underline, textColor [docs]. Scope Soup's server side takes no runtime dependencies ([ours] CLAUDE.md), so the converter is written by hand.

**Markdown to ADF** (Scope Soup writes): a small subset is enough for what Scope Soup posts: paragraphs, headings, bullet and numbered lists, fenced code (language kept), inline code, bold, italic, links, blockquote, rule, and a `details` block turned into an `expand` node. Tables are optional. Anything else becomes plain text. An unknown ADF node sent to Jira is rejected with a 400, so a validator in the fake (section 6) must refuse what Jira refuses.

**ADF to Markdown** (Scope Soup reads): the same subset, plus: mention to `@displayName`, emoji to its text, status to `[TEXT]`, inlineCard to the URL, panel to a blockquote with its type, media to `[attachment]`, expand to a `<details>` block.

**Made inert.** `inertText` ([ours] `src/orchestrator/hostText.ts`) puts a zero-width space after `@` and in closing keywords. In ADF the text node `@name` is not a mention, so `@` needs no change. Mentions are made only by a `mention` node that the converter never emits. Keep the zero-width space in closing keywords anyway: the text may also reach a code host. On Data Center (wiki markup), `[~user]` is a live mention and `{code}` and macros are live, so that path needs real escaping.

**What is lost** when a description goes Jira, Scope Soup, Jira:
- panels, expand, status lozenges, mentions, inline cards, emoji, colours, media and attachments, merged table cells, comments attached to text (inline comments);
- the exact ADF of any text Scope Soup edits.

The risk is the last one: a person's description with a panel or a mention, edited by Scope Soup (a draft accept, the Verification section), would come back flattened. Options: (a) refuse to write a description whose ADF has nodes outside the subset, and say why on the board (like `BodyChanged`); (b) change only the part of the ADF tree that holds the Verification section and keep every other node as is (preferred; the section is found by a heading node, so this is a tree splice, not a conversion); (c) accept the loss. Recommended: (b), with (a) for a draft accept, since a draft replaces the whole description.

Cloud also still takes wiki-markup strings in API v2 [known]. That would skip ADF but gives worse results (Jira converts, and reads back its own rendering) and is the only text format on Data Center. Not recommended for Cloud.

## 4. Authentication and configuration

What the person sets:

| Setting | Where | Notes |
|---|---|---|
| Kind | shared `host`: `{ "kind": "jira", ... }` | |
| Site URL | shared `host.url`: `https://example.atlassian.net` | Cloud and Data Center both. |
| Flavor | `host.flavor`: `cloud` or `datacenter` | Decides auth, API version and text format. |
| Project key | `host.project`: `KEY` | One project in the first version. |
| Account email | private file `host.email` (Cloud only) | An email is not a secret but is personal: private file, not shared. |
| Token | env var `SCOPESOUP_JIRA_TOKEN`, never a file | [ours] RUNNING.md: a key with "token" in its name is refused in the config. |
| Issue type for new Items, child type | `host.issueType`, `host.childIssueType` | |
| Priority map, done / doing / todo transition names, "won't do" resolution | `host.priorities`, `host.transitions` | Defaults: Jira's default names. |
| `write` | `host.write` | As on GitHub. |

**Cloud**: Basic auth, `Authorization: Basic base64(email:token)` [docs]. The token comes from id.atlassian.com, lasts 1 to 365 days (default one year) and is shown once [docs]. A token has the account's permissions. Scoped tokens exist and must call `https://api.atlassian.com/ex/jira/{cloudId}/...` instead of the site URL [docs]; the first version should use an unscoped token and the site URL, and note that scoped tokens need the cloud id from `GET https://example.atlassian.net/_edge/tenant_info` [known]. Scope Soup must say when a token expires: a 401 turns into "the token was refused (it may have expired)".

**Data Center / Server**: a personal access token, `Authorization: Bearer <token>`, created in the profile (Jira 8.14 and later), up to 365 days by default, 10 per user, an admin may disable them [docs]. API v2 (`/rest/api/2`), wiki-markup text, JQL search at `/rest/api/2/search` with offset paging, users by `name` or `key`, not `accountId` [known]. No `/search/jql`. Separate code for text, users and paging.

**Rate limits**: since 2026-03-02 Atlassian enforces points-based hourly quotas, but the page says "API token based traffic is not affected" and stays under burst limits (100 per second for GET and POST per tenant and endpoint) [docs]. Per-issue write limits (20 per 2 s, 100 per 30 s) are listed on the same page [docs]; one Item cycle writes about 12 times, so they hold. On a 429, honour `Retry-After`, read `RateLimit-Reason`, back off with jitter, at most four tries [docs]. Map it to `WriteLater` ([ours]). A poll every 30 to 60 s is far below any limit.

**Webhooks**: admin webhooks need Jira admin and a public HTTPS URL; dynamic webhooks are for Forge, Connect or OAuth apps and expire in 30 days (host-apis.md, section 4). Scope Soup listens on localhost only ([ours] decision 42). So: poll. `watch` is not implemented.

**Trust**: every comment's author is `author.accountId` (Cloud). `whoami` gives the token's own. A Jira admin can edit any comment; same as GitHub.

## 5. Changes stay on git

Jira has no pull requests and no merge. Scope Soup's `changes`, `ci`, merge queue and `queueCi` come from another host, in practice GitHub (or a plain git remote). Two things follow:

1. **Config.** `host` is one kind today ([ours] `src/config/types.ts`, `levels.ts`). Jira for Items and GitHub for changes needs a combination: `host: { kind: "jira", changes: { kind: "github", repo } }`, or two named hosts. The ports already split by capability, so the core can take a work host and a changes host; the config, setup and the places that test `kind === "github"` are the work (section 7).
2. **Linking an Item to its branch and change.** Without any Jira app:
   - the branch is `scopesoup/KEY-12`, so the key is in the name and any Jira app that watches the code host would link it;
   - Scope Soup posts a comment on the issue with the change's URL, and can add a Web Link: `POST /rest/api/3/issue/{key}/remotelink {object:{url, title}}` [known]. It shows under "Web links" on the issue. No app, no admin.
   - Jira's Development panel (branches, commits, pull requests) is filled by an installed app ("GitHub for Jira", Bitbucket). Installing it needs a Jira admin. Reading the panel through REST is only the internal `dev-status` endpoint, undocumented and unreliable with tokens (host-apis.md, section 4). Do not depend on it.
   - Closing: the merged comment plus the done transition, as `closeWork` does on GitHub. Closing keywords in the change's description do nothing in Jira without the app's automation, and Scope Soup does not rely on them.

## 6. Testing

No real Jira in tests ([ours] CLAUDE.md). The GitHub host has `fakeIssues.ts`, `fakeFetch.ts` and `fixtures.ts` to copy in shape.

- **A fake Jira** (`fakeJira.ts`): an in-memory site behind a `FetchLike`. It refuses what Jira refuses ([ours] DESIGN.md: "a fake refuses what the real port refuses"):
  - workflow: only the transitions allowed from the current status; a done transition without a resolution fails when the screen demands it;
  - hierarchy: a Story under a Story is refused; a Sub-task needs a parent;
  - labels with spaces;
  - ADF that is not valid (unknown node, text outside a paragraph);
  - comment body over the length limit;
  - property over 32 KB, key over 255 bytes;
  - 429 with `Retry-After` and `RateLimit-Reason` on demand;
  - per-minute rounding in JQL `updated`, so overlap bugs show;
  - a 401 for an expired token.
- **Recorded fixtures with synthetic data.** Hand-written from the documented response shapes first (JSON files of issue, comment, search page, transitions, link, error answers, ADF samples). Then, once a person owns a throwaway Jira Cloud site with made-up issues (the free plan is enough [known]), record real answers, replace the account ids, emails and site name with `example.atlassian.net` placeholders, and commit those. A test checks that no fixture holds a real-looking email, a token or a host other than `example.atlassian.net`.
- **Converter tests**: Markdown to ADF to Markdown round trips on the subset; ADF samples with panels, mentions and media to the documented loss; the splice of the Verification section leaves other nodes byte-equal; random inputs as the other formats do.
- **Contract tests**: the same sequences that the GitHub adapter tests run (ask, answer, draft, claim race by lowest comment id, close) run against the Jira host and its fake, so both hosts keep to the port.
- **A trial** in `docs/TRIALS.md` on a person's own throwaway site, with the smallest model, writes off.

## 7. Effort, risks, first slice

Sizes: small is a day or less of an implementor, medium a few days, large a week or more. The GitHub host is about 4,500 lines with tests for comparison [ours].

| Part | Size | Notes |
|---|---|---|
| A. HTTP client: auth, retries, 429, paging, error classes | small | Copy `client.ts` in shape. |
| B. Config, env var, `whoami`, setup and onboarding text, offboarding manifest | small to medium | New `kind`; places that name `github` need a look. |
| C. ADF and Markdown subset converter, both ways, with the splice | medium | The riskiest unit; pure, easy to test. |
| D. Read mapping: list with cursor and overlap, key listing for removals, get, state, priority, parent, links, comments, properties, `WorkItem` | medium | |
| E. Fake Jira and fixtures | medium | Needed before any write. |
| F. Writes: create, edit, labels, assignee, links, parent, transitions | medium | Transitions and create screens are where real sites differ. |
| G. Scope Soup conventions on Jira: questions, answers, drafts, claims, log, assumptions, merged, with properties | large | `conventions.ts` is 850 lines and GitHub-shaped (a line marker). Split the shared logic (numbering, trust, `Qn`/`An` parsing) from the encoding, so both hosts use it. Worth doing once. |
| H. Mixed hosts: Jira for Items, git host for changes, in config and core | medium | Unknown size until the config code is read for it; may be larger. |
| I. Data Center: API v2, PAT, wiki markup, offset paging, user names | medium | After Cloud. |
| J. Import and "moved to Scope Soup" for a Jira project | medium | Optional, later. |

Total for a Cloud host with writes and mixed hosts: roughly large, about 3 to 4 weeks of implementor time in parts, one part at a time.

### Risks

1. ADF edits flatten what people wrote (section 3). Mitigation: tree splice, refuse on unknown nodes.
2. Create and transition screens with required fields. A real project can refuse every create. Mitigation: read `createmeta` and the transition's `fields` once and say "this project requires X" instead of failing blind. Needs a real site to learn.
3. Workflows differ per project. Done may need a resolution; "won't do" may not exist. Config names them; a wrong name fails loudly.
4. Comment length. About 32,767 characters on Cloud [known] against Scope Soup's 60,000. `COMMENT_LIMIT` becomes a property of the host; drafts and splits over the limit stay on the board, as GitHub's do over 60,000.
5. Properties are a second write, and a person with edit rights can change them. Same trust rule as a GitHub marker edit; plan for a comment whose property is missing.
6. No conditional requests: each poll is paid. Fine at one project; check on a project with ten thousand issues.
7. Hierarchy rules of the project type break splits (a Story under a Story).
8. Token expiry (at most one year [docs]) and scoped-token URLs.
9. Atlassian changes the API often (the search endpoint was replaced; rate limits changed in 2026 [docs]). The fake and fixtures need a date and a note of the API version.
10. Mixed hosts touch config, the core and the board in many places (part H).

### Recommended first slice

A **read-only Jira Cloud host**: parts A, B, C (read direction only, plus the splice later), D and E (the fake and hand-written fixtures). The board lists a Jira project's issues with state, priority, parent, blockers and comments, and Scope Soup's questions and answers are shown when present. No writes, so nothing irreversible and no screen or workflow problems. It proves the cursor, key handling, mapping and fixtures. Second slice: writes without Scope Soup's conventions (F: edit, labels, comment, close). Third: conventions (G) and mixed hosts (H). Then Data Center.

## 8. Open questions for the owner

1. **Cloud, Data Center, or both?** Options: (a) Cloud first, Data Center later; (b) both together; (c) Data Center only. Recommend (a): Cloud is the one a single person can get for free, and the two differ in auth, text format, paging and user ids.
2. **Where do Jira's Items' changes live?** Options: (a) Jira for Items, GitHub (or another git host) for changes and CI, combined in the config; (b) Jira with the meta branch for changes and no code host; (c) Jira only for Items and the code reviewed on the board without a host. Recommend (a), since the rest of the program already assumes pull requests on a host. It costs part H.
3. **How are Scope Soup's hidden markers stored?** Options: (a) comment properties plus a short visible first line; (b) a visible tag in the text only; (c) issue properties only. Recommend (a).
4. **Is the log a visible comment (edited in place) or a hidden issue property?** Options: (a) comment, as on GitHub, if an edit sends no notification; (b) issue property, silent but invisible; (c) both. Recommend (b) for the first version and a visible summary line later; check the notification point first.
5. **Do you have, or will you make, a throwaway Jira Cloud site for recording fixtures and a trial?** Options: (a) yes, with made-up issues and a free plan; (b) no, hand-write fixtures from the docs only. Recommend (a); (b) works for the read-only slice but not for writes (create screens, transitions).
6. **Should one config name the status transitions and the priority map, or should Scope Soup guess them?** Options: (a) config with Jira's default names as defaults; (b) guess from the workflow (`statusCategory`). Recommend (a) for writes; reads use `statusCategory` anyway.
7. **Should a split's children be Sub-tasks, or issues of a child type under an Epic?** Options: (a) Sub-tasks, always; (b) a configured child type; (c) refuse a split on Jira. Recommend (b), default Sub-task.
8. **Is one Jira project per Scope Soup project enough?** Options: (a) one project key; (b) a JQL filter in config. Recommend (a) first; (b) later if asked.
9. **Edits to descriptions with nodes Scope Soup cannot write (panels, mentions): refuse, splice, or flatten?** Recommend splice for the Verification section and refuse for a whole-description draft accept (section 3).
