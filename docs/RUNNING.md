# Running Scope Soup on a project

How to install, configure and start Scope Soup, and what the board shows. A Claude Code skill writes the configuration with you ("Onboarding with the Claude Code plugin", [`ONBOARDING.md`](ONBOARDING.md)); this page is the reference for every key. Why things are as they are: [`DECISIONS.md`](DECISIONS.md). How they work inside: [`DESIGN.md`](DESIGN.md).

## What the machine needs

- Node 22.18 or newer. pnpm, unless you install a release.
- git, with a clone of the project that can push to its remote without asking for a password.
- The `claude` command (Claude Code), logged in. Agent sessions run as that login and use its usage allowance.
- For a GitHub project: a GitHub token that can read the repository and, when writes are on, comment, label, edit and close issues (at level 4 with `mergeQueue.ci: "github"` also open the batches' pull requests; [`github-mapping.md`](github-mapping.md), "Token rights"). A meta branch project needs no token.

**Network.** With a meta branch host the server makes no network request of its own: only git talks to the project's remote (a test checks that sync, the board and item writes never call `fetch`). A GitHub or Jira host is read over its API, and the daily update check asks GitHub unless `SCOPESOUP_UPDATE_CHECK=off`. Nothing needs admin rights or a service.

The machine has to stay on. Scope Soup does nothing while it is asleep and picks up where it was when it starts again. On Windows it keeps the laptop awake itself while it has work (see "Windows").

## Installing and upgrading

Scope Soup runs released versions of itself. `pnpm release` makes `release/scopesoup-<version>/`, a zip of it and the zip's SHA-256: the sources, prompts, the built web app, the onboarding text files and `release.json` (the commit, whether the check passed on it, and the three format numbers). A release needs only Node, no `pnpm install`. On Windows it also builds a `.exe` that brings its own Node. A release's notes say whether the config file's, the meta branch's or the database's format changed, and what the migration does ("Cutting a release").

A machine has one **Scope Soup home**: a folder outside every git repository that holds a folder per version, a pointer to the one that runs, and the launcher:

```
scopesoup/                  Scope Soup's home (the onboarding skill proposes <parent of the config folder>/scopesoup/)
  bin/scopesoup.cmd         the launcher for Windows: runs the version `current` names
  bin/scopesoup             the launcher for sh (Git Bash, macOS, Linux)
  current                   one line: the folder of the version that runs, such as scopesoup-0.5.0
  upgrade.json              the last switch: from, to, when, whether the new version started, the backup
  scopesoup-0.5.0/          a release, unpacked as it came
  scopesoup-0.4.2/          the version before it, kept for "Go back" (at most one)
  backups/                  the database and config copied before the last upgrade
  node/node.exe             the Node the Windows .exe brought (only after the .exe)
```

**On Windows without Node: the .exe.** `scopesoup-<version>-win-x64.exe` (attached to a release) sets up the home in one step: run it (a double click asks for the folder, default `%LOCALAPPDATA%\ScopeSoup`; or `--home <folder>`). It unpacks the version and `node/node.exe` into the home, runs `setup-home` and says what to do next. It needs no admin rights and no network and changes no setting of the machine. Windows may warn that it is not signed.

**The first install.** Unpack the release zip into the home, then run once, in a terminal:

```
pnpm --dir <home>/scopesoup-0.5.0 setup-home
```

(or `node <home>/scopesoup-0.5.0/src/scopesoup.ts setup-home`). It writes `current` (only when there is none) and the two launchers in `<home>/bin`. **It does not change the PATH**: add `<home>/bin` yourself. On Windows: Settings, search "environment variables", "Edit environment variables for your account", Path, New, `<home>\bin`. On sh, `export PATH="<home>/bin:$PATH"` in `~/.profile`. Open a new terminal; `scopesoup version` prints the version.

**The one command.** `scopesoup <command>` runs the current version's command: `start` (the server), `open` (below), `shortcut`, `item ...` ("Item commands"), `config:check`, `config:register`, `config:setup`, `settings:init`, `offboard`, `meta:accept`, `version`. The CLAUDE.md section a project commits says `scopesoup item ...`, so it is right after every upgrade and never names a folder. Run in a project's repository, the commands find this machine's configuration themselves ("Which config a command reads").

**One button.** `scopesoup open`, run in the project's repository, opens the board in the default browser, first starting Scope Soup in the background if it is not running (no console window; output goes to `scopesoup.log` in the data folder). On Windows, `scopesoup shortcut --name <project>` makes a Start menu shortcut that does this (`--desktop` adds one on the desktop, `--startup` one in the Startup folder). It needs no admin rights and offboarding deletes it.

**The update check.** Scope Soup asks GitHub for the newest release of its own repository once a day and on "Check now"; the footer says when a newer one is known, and the Settings page has the version panel with the buttons below. It only reads; nothing is upgraded on its own. `SCOPESOUP_UPDATE_CHECK=off` switches the check off (a laptop that may not reach GitHub). **By hand**: unpack the new zip into the home beside the current version, stop Scope Soup when nothing runs, write the new folder's name into `current`, and start it with `scopesoup start`. The Settings page also has a theme picker ("Default", "Plain", "Graveyard Shift"), kept in this browser; a theme is an entry in `web/src/theme.ts`.

**Upgrade to X.Y.Z** (a button on the Settings page while a newer release is known, after a yes):

1. The folder of the version before the current one is deleted (at most two versions on disk).
2. The release zip is downloaded and checked (size, SHA-256, its contents, its version), then put in place through a temporary folder. The running version's folder is never touched.
3. The four switches (triage, implementors, review, the merge queue) are paused, and Scope Soup waits until no session and no queue batch runs. Nothing is cut off. The panel says what it waits for; Cancel stops the wait (the four stay paused).
4. The database (`VACUUM INTO`) and this machine's `scopesoup.config.json` are copied to `<home>/backups/before-scopesoup-<version>/`, replacing the copy of the upgrade before.
5. The pointer is switched and Scope Soup exits with code 75. The launcher starts the new version, which migrates what it must, comes up paused as after every start, and the board reloads on it.
6. When the new version listens, it starts again each switch that ran before Upgrade. The board says so for an hour, until dismissed, or until a switch is changed.

A development checkout has no Upgrade: update it with git. A version that cannot start right after a switch gives the pointer back to the version before it (once) and exits with code 75. The older version is deleted once the current one has run cleanly for a day, or at the next upgrade.

**Go back to X.Y.Z.** One step back, to the version the last switch left, while its folder is kept. When no format changed (the usual case) nothing else is needed. Across a breaking change the older version refuses the newer data: put the config file (kept as `scopesoup.config.v<old>.json`) and the database (`scopesoup.v<old>.sqlite` beside it, and `<home>/backups/`) back by hand with Scope Soup stopped; anything written since is lost. The meta branch cannot be put back (other laptops share it).

**Several projects on one machine** share the home: Upgrade on one board switches the pointer for all, and the other projects keep running the version they started with until restarted.

### Which config a command reads

Every command that reads this machine's `scopesoup.config.json` (`start`, `item`, `config:check`, `settings:init`, `offboard`) takes the first of (`src/config/locate.ts`):

1. `--config <file>` (for `config:check`, its file argument);
2. `SCOPESOUP_CONFIG`;
3. `scopesoup.config.json` in the folder the command runs in;
4. the config this machine knows for the git repository the command runs in.

For the last, Scope Soup's home keeps a list, `<home>/configs.json`; the onboarding skill adds the config it writes (`scopesoup config:register <file>` by hand too) and offboarding takes it off. A config is for the repository when the repository's top folder is its `ownClone`, `repoPath` or one of its `realPaths`, or the repository has a remote with its remote URL. Outside a repository, or with no or several matching configs, the command asks for `--config` or `SCOPESOUP_CONFIG`. A development checkout has no list. `scopesoup start` without a config is only a board.

## Start

In a clone of Scope Soup:

```
pnpm install
pnpm web:build
SCOPESOUP_GITHUB_REPO=owner/name SCOPESOUP_GITHUB_TOKEN=... SCOPESOUP_CONFIG=/path/to/project/scopesoup.config.json pnpm start
```

From a release, `scopesoup start` (or `scopesoup open`) in the project's repository does the same with the config it finds. The board is then on http://127.0.0.1:4310. The host can instead be set in the project's shared settings ("The host"); then `pnpm start` with only this machine's file is enough for a meta branch project.

| Variable | Does |
|---|---|
| `SCOPESOUP_META_REPO` | A local git repository (its own top level, a bare repository or a submodule folder) whose meta ref (`refs/scopesoup/meta`) holds the items ([`DESIGN.md`](DESIGN.md), "Items on a meta branch"). Read from its object store, never checked out. |
| `SCOPESOUP_META_WRITE` | `1` lets Scope Soup create and edit items, append to logs, and fetch and push the meta ref. Without it the ref is only read. Needs git 2.29 or newer. |
| `SCOPESOUP_META_AUTHOR_NAME`, `SCOPESOUP_META_AUTHOR_EMAIL` | With `SCOPESOUP_META_WRITE=1`, required: the person meta commits are made as. The machine's git config is not used. |
| `SCOPESOUP_META_PREFIX` | With `SCOPESOUP_META_WRITE=1`: this machine's prefix for the ids of items made here (`A` gives `A-12`). Never the same on two machines. Without it no item is created here, and Scope Soup says so at start. |
| `SCOPESOUP_META_REMOTE` | The remote the meta ref is pushed to and fetched from. Default `origin`; `none` keeps it local. A push runs the repository's own `pre-push` hook. |
| `SCOPESOUP_META_FETCH_SECONDS` | How often a read fetches the meta ref first. Default 60. |
| `SCOPESOUP_MERGE_QUEUE` | `off`: do not take the merge queue lease before merging. Default: with a writable meta branch host, merging waits for the lease on the remote's `refs/scopesoup/merge-queue`, so only one machine merges at a time. |
| `SCOPESOUP_GITHUB_REPO` | The repository to read, as `owner/name`. Without it or `SCOPESOUP_META_REPO` nothing is synced. |
| `SCOPESOUP_GITHUB_TOKEN` | The token for reading it, and for writes when they are on. |
| `SCOPESOUP_CONFIG` | This machine's private configuration. Default: "Which config a command reads". Without a file the orchestrator stays off and Scope Soup is only a board. |
| `SCOPESOUP_WRITE` | `1` lets Scope Soup write to GitHub ([`github-mapping.md`](github-mapping.md)): edit issues, add its labels, post its comments, close an item's issue when its change merges, and at level 4 with `mergeQueue.ci: "github"` open the batches' pull requests. Without it GitHub is only read. Writes stay off if the clone's remote is not the repository in `SCOPESOUP_GITHUB_REPO`. |
| `SCOPESOUP_DATA` | Where the database is kept. Default `data` in the folder of the configuration file found; `./data` only with no configuration. A folder inside a git working tree is refused at start. |
| `SCOPESOUP_HOST`, `SCOPESOUP_PORT` | Where the board listens. Default `127.0.0.1:4310`. |
| `SCOPESOUP_ALLOW_LAN` | `1` allows another address. There is no login, so only on a network you trust. |
| `SCOPESOUP_POLL_SECONDS` | How often the host is polled. Default 20. |
| `SCOPESOUP_PERSON` | Read by the item commands only, as the person's name when `--as` is not given. The board's person is the one picked at its top, remembered in that browser. |
| `SCOPESOUP_UPDATE_CHECK` | `off`: never ask GitHub for new releases. Default: once a day. |
| `SCOPESOUP_UPDATE_TOKEN` | A token that can read the releases of Scope Soup's repository, when it is private. |
| `SCOPESOUP_UPDATE_REPO`, `SCOPESOUP_UPDATE_API` | The repository whose releases are Scope Soup's (default `mikaeltulldahl/scopesoup`) and the API's address (default `https://api.github.com`). |
| `SCOPESOUP_LAUNCHER` | Set by the launcher, not by you. |

## Reading the board

The overview starts with **Your turn**: everything that waits for a person (questions, decisions, escalations, rewrites to accept, drafts, your own holds). A question is in every person's Your turn until someone answers it; there is no login: pick who you are at the top of the board (kept in that browser only). Below it, the lanes, left to right:

| Lane | What is in it |
|---|---|
| Backlog | Not chosen yet; no agent starts it ("Backlog and To do") |
| To do | Agents may start it, in the order of "How Items are ordered"; triage runs here |
| Blocked | In To do, but waits on another open Item |
| In progress | Being implemented, or held by a person |
| In review | Being reviewed, or handed over for a person to merge (a pull request) |
| Merge queue | Level 4 (hidden below it while empty): queued, or in the check of a batch |
| Done | Merged or closed |

A lane's header holds its switch ("Start, Pause and Stop"). A card opens the Item page: the description, the questions with their options, the Rounds table and history, the files changed, and the State menu ("Item commands"). The header links Items (search), Merge queue, Activity, Commits, Usage and Settings, and has Sync now and Stop; the status line under it says what runs, forecasts the usage windows and shows alerts.

## The project's configuration

A project's settings are in two places, and each key is in exactly one of them. A key in the wrong place is refused with a message that says where it belongs.

- **Shared, on the meta ref: `settings/settings.json` on `refs/scopesoup/meta`.** What decides the outcome, the same on every machine: `project`, `host`, `mainBranch`, `level`, `checkCommand`, `rerunFilesCommand`, `mergeQueue`, `setupCommand`, `setupWatch`, `bugLabels`, `roles`, `sharedResources`, `media`, `labels`, and the rule-like numbers under `settings` (`persistence`, `stallTimeoutMinutes`, `sessionTimeoutMinutes`, `retryBackoffCapSeconds`, `checkTimeoutMinutes`, `queueMinBatch`, `queueMaxBatch`, `queueRerunCost`, `queueMinOutcomes`, `triageMaxAgeDays`, `waitingCapTriage`, `waitingCapWork`). Scope Soup fetches the ref at start and then every minute. Every project has the ref. The setup script is code that runs, so it stays in the repository on the main branch.
- **Private, per machine: `scopesoup.config.json`.** `version`, `machineName`, where the repository is (`repoPath`, `remote`, `remoteUrl`), the local paths (`realPaths`, `ownClone`, `workspacesDir`, `workspaces`, `streamsDir`, `promptsDir`, `claude`), `keepAwake`, `multiplayer`, this machine's `resources`, its part of each host (`meta`, `jira`), and what this machine may spend and how often it looks, under `settings` (`maxParallelSessions`, `budgetFiveHour`, `budgetSevenDay`, `tickSeconds`): each machine has its own subscription. Tokens stay in the environment. Keep it, and `data/`, outside the project's repository.

`src/config/example.config.json` and `src/config/example.settings.json` show the two shapes. `pnpm config:check <file>` checks a pair. The first person on a project writes the shared settings with `pnpm settings:init`; after that they are changed on the Settings page. The keys that matter first:

- `repoPath`: the clone Scope Soup works in, relative to the configuration file. Scope Soup never works in the clone's own checkout.
- `workspaces`: where sessions work. Default `{ "kind": "worktree" }`: worktrees of `repoPath` under `workspacesDir`, reused like a pool. An item claims a free one, keeps it across its steps and frees it when it is parked or merges. Freeing resets tracked files, removes untracked files git does not ignore and detaches HEAD; ignored files (installed dependencies, build output) stay, so the next item finds the setup done. For a submodule project, see "A pool of clones".
- When a worktree is freed because the Item is parked, what the session left uncommitted is first written as `<streamsDir>/wip/<workspace>.diff` and applied, uncommitted, in the worktree the item gets when it resumes (a patch that does not apply is kept where it is).
- `setupCommand` and `setupWatch`: the setup of a fresh clone, below. `ownClone` (private): your own clone of the project on this machine, which `{{ownClone}}` in the shared `setupCommand` stands for.
- `realPaths`: anything on the machine that agents must never run in. Sessions refuse to start there.
- `machineName`: this machine's name where the hosts show it (claim comments, log lines, commit trailers, the merge queue lease, the address of session commits `scopesoup@<name>.invalid`). 1 to 40 letters, digits, `-`, `_` or `.`. Required, and different on each machine that shares a project, since two machines with the same name treat each other's claims as their own. Scope Soup never uses the computer's host name, as on a public repository everyone could read it. After a rename, claims under the old name stay until they expire (120 minutes).
- `keepAwake`: `true` (default) keeps a Windows laptop from sleeping while sessions run or work is waiting. See "Windows".
- `labels.aiGenerated` (shared): off by default. `true` or a label name (default `"ai-generated"`) puts that label on an Item Scope Soup creates from an agent's output or whose description an accepted triage rewrite changed. Scope Soup never removes it.
- `multiplayer` (private): `true` (default) shares `refs/scopesoup/*` on `remote` (Items, shared settings, leases, images with `media.push`). `false` keeps them in this clone. Work branches, the main branch and a GitHub or Jira host's Items are unchanged. Switching on reads the remote's shared settings first and asks when they name another project or host (decisions 93, 98).
- `level`: how much Scope Soup does on its own, 0 to 4 (default 0). See "Levels".
- `rules`: no rule switch is left. From level 1 the usage stop at `settings.reserveFiveHour` and `settings.reserveSevenDay` is always on, and Scope Soup claims the Items it starts on a shared host for a fixed 120 minutes ([`RULES.md`](RULES.md)).
- `claude` (private): the Claude Code provider's settings: `path` (see "Windows"), `prefixArgs` and `extraArgs`, `promptVia` (`"stdin"` default, or `"arg"`) and `dropApiKeyEnv` (default `true`: `ANTHROPIC_API_KEY` is taken out of the session's environment, so sessions draw from the subscription).
- `copilot` (private): the Copilot CLI provider's settings: `path` (default `copilot`), `prefixArgs`, `extraArgs`, and the plan's budget `monthlyRequests` (absent: Copilot sessions are not paced) and `resetDay` (1 to 28, resets at 00:00 UTC; default 1).
- `roles`: per role, the agent CLI (`provider`: `"claude"` default, or `"copilot"`), the model, the turn limit and the tools the agent may use. A role with no model runs on its default: opus for triage and review, sonnet for implement. An implementor can only run the commands listed, so list the project's test command. Every session is also refused `git push --force*`, `git push -f*` and `*--no-verify*`, and from level 4 any `git push`.
- `roles.implement.modelBySize` (shared): a model per triage size, for example `{ "small": "haiku", "medium": "sonnet", "large": "opus" }`. A size left out runs on `roles.implement.model`. After two send-backs by review the implement rounds run one model stronger (decision 105).
- `roles.<role>.effort`: the reasoning effort of a Claude role, passed as `claude --effort <level>` (`"low"` to `"max"`). Absent: the CLI picks. A higher effort uses more of the usage windows.
- `roles.<role>.mcpServers`: extra tools for a role, such as a browser, as MCP servers by name: `command`, `args` and `env`. `env` is a list of variable names, never values (a key with a value is refused). Every tool of a server counts as allowed for that role. A server that installs itself (`npx -y`) needs the network, which is the project's decision. On Windows write `"command": "cmd", "args": ["/c", "npx", ...]` for a `.cmd` program. A Playwright browser for the implement and review roles:

  ```json
  "roles": {
    "implement": { "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless"] } } },
    "review": { "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless"] } } }
  }
  ```

### Running a role on GitHub Copilot CLI

A role runs on Copilot CLI when its `provider` is `"copilot"`; the other roles stay on Claude:

```json
"roles": { "triage": { "provider": "copilot" }, "review": { "provider": "copilot" } }
```

- **Sign in first**, once, as yourself: install Copilot CLI and run `copilot login`. Scope Soup never signs in. `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` are kept out of the setup command while a role runs on Copilot.
- **Model.** A Copilot role with no model runs on `fusion` with `autoTier` `"balance"`; set `roles.<role>.model` and `roles.<role>.autoTier` to change them. No reasoning effort is passed; `maxTurns` and `permissionMode` are not used.
- **Commands.** `allowedTools` become Copilot's rules (`Bash(pnpm check*)` is `shell(pnpm check:*)`). Copilot names a command by its program and first subcommand only, so an entry that says more (`Bash(npm run check*)`) is left out; the session is told only the commands it got. From level 4 `git push` is denied.
- **Warning: flags are not refused on Copilot.** Its rules never name a flag, so only the prompt tells the role not to use `--no-verify` or `--force`. The guard that holds is branch protection on the remote; the board warns once when the main branch is unprotected.
- **The answer.** Copilot has no JSON-schema output, so the prompt asks for one JSON object and Scope Soup checks it against the schema; when it does not fit, the session is resumed once to ask again, then it fails.
- **Resume and chat** work as on Claude. Scope Soup does not pass `--trust-folder` (it cannot go with `--resume`), so the repository's own Copilot hooks and MCP servers are not loaded.
- **Usage and pacing.** Copilot reports no 5-hour or weekly window, so no Copilot session starts once the month's premium requests (from `copilot.resetDay`, UTC) reach `copilot.monthlyRequests` minus the reserve. The Usage page has a Provider switch.

### Levels

One setting, `level`, says how much Scope Soup does; each level includes the ones below it:

| `level` | Name | What the orchestrator starts | How a finished change ends |
|---|---|---|---|
| 0 | Watch | Nothing. The board still syncs and shows the work. | - |
| 1 | Triage | Triage sessions only. A triaged item waits at its implement step. | - |
| 2 | Implement | Triage and implement. An item that states its size (`size:small` or `size:medium`) skips triage. | The implementor merges it itself, as the project's CLAUDE.md says (or opens a pull request) |
| 3 | Review | Also review: every built change is reviewed; findings go back to the implementor. | After the reviewer approves, the implementor merges it as CLAUDE.md says |
| 4 | Autopilot | Everything, and Scope Soup merges every reviewed change through its merge queue (one waiting change is a batch of one). Needs `remoteUrl`, and `checkCommand` to merge anything (or with `mergeQueue.ci: "github"` a GitHub host with writes on). | Merged on the main branch by the queue |

Start picks from To do in order (priority, then bugs, smaller, older). Agents never start an Item in Backlog ("Backlog and To do"). Below level 4 Scope Soup merges nothing ("Merging by the session"). A step above the level waits where it is and goes on when the level is raised. The keep-awake hold is off at level 0.

### The file's format and upgrades

`version` is the format of the private file, raised only when an older file would no longer load as it is. This Scope Soup uses format 3; a file without `version` is format 0 (release 0.5.0 and before). The shared settings have no `version` (the meta ref has its `format`). A file that still holds project settings is refused, each key with where it belongs.

- **An older file is migrated at start** (`src/config/migrate.ts`): Scope Soup keeps a copy beside it, `scopesoup.config.v<old>.json` (only the newest), rewrites the file and prints a notice of what changed. The step from 0 to 1 drops keys no Scope Soup reads any more (the old `rules.*` switches, `inviteLabel`, `autonomy`, `triageDepth`, `modelStrength`, the roles `fix`, `check-review`, `rebase`, `situation`), merges `settings.parallelSessions` into `maxParallelSessions` and turns `dryRun` into `level` (the table); the step from 1 to 2 replaces `settings.budgetReserve` with `reserveFiveHour` and `reserveSevenDay` (decision 118); the step from 2 to 3 turns each reserve into a budget, `budgetFiveHour` and `budgetSevenDay`, 1 minus the reserve (decision 133).

  | Old file | Level |
  |---|---|
  | `dryRun: true`, or no `dryRun` and no `level` | 0 (a notice names the level the rest of the file describes) |
  | `dryRun: false`, `mergeQueue: "person"` or none | 1 |
  | `dryRun: false`, `mergeQueue: "push"` or `"queue"` | 4 |

  A file that sets `level` keeps it. There is no approval step: no change waits for an Approve. A project that wants a person to merge stays below level 4 and says so in its CLAUDE.md.
- **A file that would not load is not touched.** What no step can invent, such as `machineName`, stops the start with a message; add the key and the next start migrates it. A file that cannot be written (read-only) stops the start.
- **A newer file is refused:** "this project's config is from a newer Scope Soup; upgrade Scope Soup", and the file is not changed.
- `pnpm config:check` and the item commands only read: they show an older file as it would be migrated. A save on the Settings page migrates it as the start would.

A change to the file is picked up at the next tick. A file that does not validate is ignored with an error and the last good one stays in use. A change to `host` needs a restart.

### Start, Pause and Stop

Four switches, each on the overview lane it feeds, and the stop switch in the board's header. **Scope Soup comes up paused after every start-up** and starts nothing of its own until a switch is resumed (a person's pick below a switch's level still runs). While any switch is paused, a bar under the header names them with a **Resume all** button.

| Switch | Lane | From level | Endpoints | Events |
|---|---|---|---|---|
| Triage | To do | 1 | `POST /api/triage/start`, `/api/triage/pause` | `control.triage_started`, `control.triage_paused` |
| Implementors | In progress | 2 | `POST /api/implement/start`, `/api/implement/pause` | `control.implement_started`, `control.implement_paused` |
| Review | In review | 3 | `POST /api/review/start`, `/api/review/pause` | `control.review_started`, `control.review_paused` |
| Merge queue | Merge queue | 4 | `POST /api/merge-queue/start`, `/api/merge-queue/pause` | `control.merge_queue_started`, `control.merge_queue_paused` |
| Stop | the header | | `POST /api/stop` | `control.stopped` |

- **Pause** on an agent role's lane: nothing new of that role starts; the others go on. Running sessions finish their current step; a step that is next for that role waits and keeps no slot. Review paused (or implementors, at level 2) also leaves hand-backs waiting.
- **Pause** on the merge queue: no new merging starts and the queue builds no new batch. A merging under way finishes: its check runs to the end and it pushes if green. With `mergeQueue.ci: "github"` nothing is merged while merging is paused; a green batch merges once merging is started.
- **Stop** (core rule 3, [`RULES.md`](RULES.md)): pauses all four, ends running sessions and cuts off a merge under way at its next safe point: a running check is stopped and nothing is pushed. The four show as "stopped"; each must be resumed again.
- `POST /api/agents/start` and `/api/agents/pause` set the three agent roles at once. `POST /api/pause` and `/api/resume` do the same for all four.

A paused lane has a muted header and says "paused" ("stopped" after Stop). Below the level that uses a role its switch is not shown, and with no configuration file none are. `GET /api/status` carries the four switches, `agents` and `level`.

**Items with no triage.** At level 0 the overview says once there are ready Items that have none. Level 1 with triage started triages every one. From level 1 the Backlog has a divider: above it the Items that passed a triage, in planned order; below it, "Not triaged yet · N", in the order their triages run (oldest first, `priority:blocker` or `priority:critical` ahead, `priority:minor` behind), `maxParallelSessions` at a time.

**The merge queue switch and the queue's own pause are two things.** The queue pauses itself when it cannot go on safely (a refused push, an unusable check): `orchestrator.queue_paused`, and only **Resume the queue** on the Merge queue page lets it go on. The switch is a person's switch over all merging. The queue merges only while both are clear.

### The setup of a fresh clone

Scope Soup's worktrees, the clones of a pool and the merge queue's clone are fresh folders: they lack what your own checkout has (installed dependencies, a virtual environment, generated files, submodules, a `.env`). `setupCommand` sets one up:

```json
"setupCommand": ["node", ".scopesoup/scopesoup-setup.mjs", "--from-clone", "{{ownClone}}"],
"setupWatch": ["package-lock.json", "api/requirements.txt"]
```

Both are shared settings, and the script is committed in the repository. `{{ownClone}}` is each machine's own clone (`ownClone` in its private file), so personal files are copied from each person's own clone and never enter the repository.

- `setupCommand`: the program and its arguments, run without a shell in the folder, like `checkCommand` (on Windows an `.exe`). The onboarding skill writes the setup script into Scope Soup's own clone, to be committed on the main branch, and fills this in: it copies the personal files you confirmed from your own clone and runs the install steps. Absent: nothing is set up.
- It runs once in each folder, and again when a watched file changes, or `setupCommand` itself, or a file it names inside the repository. It is checked before each implement or review session and before each check in the queue's clone (the last successful setup is recorded in `scopesoup-setup.json` in the folder's git directory).
- `setupWatch`: the files, relative to the repository (`*` matches inside one part of a path). Absent: the lockfiles and dependency lists that are there (`package-lock.json`, `pnpm-lock.yaml`, `requirements*.txt`, `Cargo.lock`, `go.sum`, `.gitmodules` and the like). List what your code generation reads too.
- It has `settings.checkTimeoutMinutes` to finish, and its environment has no `SCOPESOUP_*` variable and no `ANTHROPIC_API_KEY`. Stop ends a setup under way. The first setup in a folder can take minutes.
- What it makes must be ignored by git and tracked files must stay as they are, or the setup fails: a copied secret never ends up in a commit.
- **A failed setup is reported as the setup's**: in a session's folder no agent starts, and the item is parked for you as an escalation, not counted as a failed attempt; fix the setup and answer to try again. In the queue's clone it pauses the queue; Resume the queue once it is fixed.
- **Its output never leaves this machine.** It is in the local event `orchestrator.setup_failed`, on the Item page and the Merge queue page. The host sees only `Setup failed in <folder> (exit N); the output is on Scope Soup's board on <machineName>.`
- Prompts say the setup has run (`{{setup}}`), so agents do not install again. After you change a personal file, it is copied the next time the setup runs; delete `scopesoup-setup.json` in a folder's git directory to run it there now.

### Limited resources

Some projects need something only so many of exist: a license with a few seats, an Android emulator or a phone on USB, a GPU, a shared test database, a paid API quota (decision 74). Declare each one, and sessions and the merge queue's check take turns with it:

```json
"resources": [
  { "name": "phone", "units": 1, "neededBy": ["implement", "check"], "env": { "ANDROID_SERIAL": "phone-{{unit}}" } }
]
```

- `resources` in this machine's file are this machine's own. `sharedResources`, in the shared settings, have the same shape and are counted across every machine. A name is used once, in both lists together.
- `name`: letters, digits, `-` and `_`, at most 40. `units`: how many there are, 1 to 64. `neededBy`: `triage`, `implement`, `review` and `check` (the merge queue's check, level 4).
- `env` (optional): environment variables for the session or check that holds a unit, so each gets its own instance. `{{unit}}` in a value is the unit's number, from 1.
- **Taking turns.** A session takes a unit of each resource it needs before its workspace and claim, all or none. When none is free the Item waits ("implement for A-12 waits: all 1 unit(s) of phone are held: implement for A-9") and the next Item that does not need it may start. The unit goes back when the session ends, however it ends. The queue's check waits without pausing the queue.
- **Across machines.** A unit of a shared resource is also held on the remote, one lease per unit on `refs/scopesoup/resources/<name>/<unit>` (like the merge queue lease), so it works on a GitHub project too. A lease lasts as long as the longest a session or check may run, plus 15 minutes. When the remote cannot be reached, work that needs a shared resource waits.
- **The board** shows each resource on the Merge queue page: units in use, who holds each and what waits. **Settings** has them under Resources ("Shared by every machine" puts one in `sharedResources`). Onboarding does not ask for them.

### Images agents attach

An agent may attach a picture to what it answers: a screenshot, a before and after, a diagram (decision 91). Every prompt tells it how: save the image in `.scopesoup/media/` of its clone (git-ignored) and write `![what it shows](media/<name>)` in its summary, a question, an option or a decision.

- **After the session** Scope Soup takes the images into `<data>/media/<key>/` and empties the clone's folder. It keeps PNG, JPEG, GIF, WebP and SVG, checked by extension and first bytes; at most 5 MB each and 20 per Item. Anything else is deleted and named in the `media.collected` event; links are never followed.
- **On the board** the Item page shows each image where the agent referred to it. Each has a Delete button (here and, when pushed, on the remote; History records who). A note says who sees them.
- **Privacy: off by default.** `media.push` (Settings, under Images) decides whether images leave this machine; it is off for every repository, private ones too. On: each Item's images are committed to `refs/scopesoup/media/<key>`, never merged anywhere, and pushed to `remote`; another machine's board fetches that ref when it shows the Item. A screenshot can catch what should not leave the computer, so turn it on only when that is fine for the project.
- **Delete and retention reach the remote even with `media.push` off:** when an Item's images were pushed once, a delete or an expiry also shrinks or deletes the remote's ref; when it cannot be updated the page says "Deleted here, but still on the remote" and Scope Soup tries again every hour.
- **Hosts never get a picture.** On GitHub and Jira an attached image becomes words ("(what it shows: image on the board)"); nothing is uploaded.
- **Retention.** `media.keepDaysAfterClose`: a closed Item's images are deleted that many days after this machine saw it closed (data folder, ref and remote's ref). `null` or absent (default) keeps them.

```json
"media": { "push": false, "keepDaysAfterClose": null }
```

A media ref Scope Soup pushes goes on the manifest; offboarding deletes every `refs/scopesoup/*`, media refs included.

### Which project a board is, and its folders

The header shows the project's name (`project` in the shared settings). Where settings can be written, double-click the name to rename it (Enter saves it as one meta commit, Escape cancels). The browser tab is titled `Scope Soup · <project>`, and the dot beside the name and the tab icon have a colour made from the name, the same on every machine.

### Reading a change: word marks and your diff tool

The Item page's "Files changed" shades the changed words inside a changed line (in each hunk the i-th removed line and the i-th added line are partners). Lines with no word in common are not marked.

"Open in my diff tool" (on the change and on each file) runs `git difftool` in the Item's clone on the machine Scope Soup runs on. It is refused unless the request comes from this machine. Only your **global** git config picks the tool (`diff.tool`, and for an unknown tool `difftool.<name>.cmd`); a tool the repository's own `.git/config` names is never used, since it would be code from the repository. For VS Code:

```
git config --global diff.tool vscode
git config --global difftool.vscode.cmd "code --wait --diff \"$LOCAL\" \"$REMOTE\""
```

### The Settings page and the sliders

**Saves at once.** There is no Save button. A pick saves when it is made; a slider after half a second at rest; a text field when it is left or Enter is pressed, if valid. Each control shows a short "Saved", or the reason the save was refused. A switch of Players answers with one line saying what stays on this machine or what was shared.

**Where a save goes.** A save of this machine's own settings (parallel sessions, the usage reserve, the remote's URL) writes its `scopesoup.config.json`. A save of a project setting is one commit on the meta ref, written the way Items are ([`DESIGN.md`](DESIGN.md), "Writing to the meta branch"), with a line in `settings/log.jsonl` saying who changed what (shown as "History of settings"). The author is the person picked at the top of the board; with nobody picked the save is refused. It is in effect at once here and on other machines at their next fetch; saves from two machines merge.

**The level.** The page opens with the five levels. A level whose needs are missing is shown but cannot be picked, with what is missing: level 1 and up need the `claude` program, level 4 needs `checkCommand` and `remoteUrl` (with `mergeQueue.ci: "github"`: a GitHub host with writes on, and `remoteUrl`). Picking level 4 while either is missing opens its fields right there.

- **The check command**, asked as "What command decides a change is OK — the one you would want green before anything merges?", with candidates found in the repository (`package.json` scripts, `run:` steps of GitHub Actions workflows, `Makefile` targets). It is proposed from `package.json` (its `check` script, else `test`). On Windows a package manager that is only a `.cmd` shim is proposed as `["cmd.exe", "/d", "/c", "pnpm", "run", "check"]`. A command that cannot be started (on Windows it must be an `.exe`) is refused with the reason; nothing is run to test it.
- **The remote's URL** is read with `git remote get-url <remote>` in the project's clone (nothing is contacted).

Level 4 always merges through Scope Soup's own merge queue; whether its check command or the project's CI on GitHub checks the batches (`mergeQueue.ci`) is file-only. The project's name is saved from the header, not here.

Below the level the page has: the most sessions at once, the usage budgets, the caps on what waits for you, the age after which a triage is taken again, the setup of a fresh clone, the limited resources, the images, what a review's `should` findings do and the model of each role. Everything else is file-only. The host is changed only with "Connect to GitHub Issues" or "Connect to Jira" (decision 98), which checks the token, reads the host once and says what connecting would do first; "Move back to the meta branch" (decision 99) does the reverse (between GitHub and Jira you go through the meta branch). Both are refused while an agent session runs on any machine. What each switch of host or players does: [`DESIGN.md`](DESIGN.md#hosts-and-players-the-switches).

| Setting | Positions | What it sets |
|---|---|---|
| `maxParallelSessions` | 1 to 32 (default 1) | The most sessions at once, of every role: the ceiling for this machine. Scope Soup paces below it (decision 133): one more starts only while each window, with it, stays under its pace line by the time it would end; with nothing running one starts only at or under the line, or in a fresh window. The Usage tab says how many run by role, how many the pace allows now and why. |
| `persistence` | 1 to 5 (default 3) | Failed attempts per step and review rounds before an item goes to you: 1/0, 2/1, 3/2, 5/4, 8/6. |
| `budgetFiveHour`, `budgetSevenDay` | 0 to 2 (default 0.8 each) | The share of the 5-hour and of the weekly window's even pace Scope Soup may use, each its own, in steps of 5 % (the marker on each meter on the Usage tab, or two sliders on Settings): the pace line rises from 0 at the window's start to it at the reset. From level 1 no session starts once a window is at its budget. Above 100 % it paces faster than the window lasts ("go fast now"), and the window may run out before its reset; the provider's limit stops it. |
| `waitingCapTriage`, `waitingCapWork` | 1 to 100 (default 2 and 5) | Shared. No new Item's triage starts while that many things wait for you (questions, drafts, decisions to look at), and no new work (a first implement step) while `waitingCapWork` do. Work under way and the steps your answers resume go on. |
| `triageMaxAgeDays` | 1 to 365 days (default 30) | From level 2: a waiting Item whose triage is older has it again before its implement step ("Triage again after"). |

Numbers under `settings` are `{ "value": n }`, with an optional `"reason"` when you edit the file by hand.

**Questions always go to you.** A decision from triage or the implementer is parked on the item page with its options and the agent's recommendation, and Scope Soup never takes the recommendation itself. An item that states its own size (a `size:small` or `size:medium` label), has no open question and waits for no decision skips triage from level 2.

**The triage's rewrite.** Triage also writes the Item's description as it would read with every recommendation taken. You accept, edit or reject it in one press; another answer runs the triage again. Accept or Edit replaces the description (on GitHub only the issue's body, with writes on; decision 48), and may apply label changes triage proposed. When the issue cannot be written, the accepted text is kept as your answer and given to the agents in place of the issue's.

**Questions about other Items.** Triage and implementors may notice a gap in another Item. They do not change it: Scope Soup asks the questions on that Item, each naming who asked, and once answered it is triaged again. A rewrite with no question is only proposed (Accept, Edit, Reject), and only for a contradiction or a fact that changed, never for wording. While the Item is busy the questions wait.

**Triage again** (decision 68). When a waiting Item comes to the front (from level 2), Scope Soup checks whether its triage is out of date and, if so, runs it again: commits on the main branch changed the paths it named; the Item's text was edited since; a blocker is done; or it is older than `triageMaxAgeDays`. The backlog behind the front is never triaged again in bulk, and an Item whose implement step has begun is never sent back.

**Items that change the same files** (decisions 87 and 115). A triaged Item whose implement step is next does not start while a busy Item names an overlapping path in its triage, nor while a busy Item is linked to it with `conflictsWith` (unless a person answered "Go on with both"). The next Item in line starts instead, and the waiting card says why. Busy is an implement step that has started, a review step, or a change not yet on main.

**Decisions the implementor took.** The implementor records decisions it judged cheap to change later, shown on the Item's page for Accept or Overturn (decision 66). An Overturn while the change has not merged goes into the running work; after merging it files a new Item.

The status line forecasts when each usage window is used up, from its readings over the last hour (5-hour window) or day (weekly) (decision 122); the Usage page shows the forecast with each window's meter and reserve. `pnpm config:check` prints advice about a valid file.

An item may carry a priority (`priority: blocker | critical | major | minor` in its header; `priority:<name>` as a GitHub label), which orders To do ("How Items are ordered"). An item in state `todo` that waits on an open item (`blockedBy`) is in the Blocked column, and its card says what it waits for; when the last blocker is done it moves to To do by itself. An item that itself waits on your decision stays in Your turn.

### The review

From level 3 a built change goes straight to a review session on the strong model. "Changes requested" resumes the implementor's own session with the findings. This goes on within the limit of rounds (`persistence`); then the item goes to you with the open findings, or sooner when a round gets nowhere ([`AUTONOMY.md`](AUTONOMY.md), "Two guards against wandering"). Before review, the fence compares the change with the triage's paths and size and stops one well beyond them with a proposed split. An approval's `should` findings follow `review.shouldFindings`: `"fix"` (default) sends them back once before the merge, `"draft"` merges at once and makes them one draft. At level 2 there is no review.

### Item drafts

Triage, the implementor and the reviewer may propose new Items (`drafts` in their answer), and a review's `should` findings may become one. Each is a draft: kept on this machine only, in every person's Your turn, tagged "draft", with the Item it was found on. Approve (after Edit, if you like) creates the Item on that Item's host; Deny drops it. Where Scope Soup cannot create Items on that host, Approve is not offered. The same draft is filed once.

### Merging by the session (levels 2 and 3)

At levels 2 and 3 the implementing session merges its own change (decision 47). Its prompt says, at level 2 and at level 3 after the approval, to merge it to main and push the way CLAUDE.md says (or open a pull request if it says so); at level 3 before the approval, to commit and stop. Scope Soup sets no gate before that merge; the project's CLAUDE.md decides. The answer names what it did in `mergedAs`: the commit on main, or the pull request's URL.

Scope Soup does not take the answer's word. When the session says it is done, it fetches the remote's main and checks whether it contains the branch head:
- **Contains it**: the Item is done. Scope Soup writes the `revision` and `merged` lines and an `orchestrator.merged` event, and closes the Item on its host as after a merge.
- **Squash-merged**: main does not contain the head, but `mergedAs` names a commit on the remote's main that was not in main when the item's first implement session started and has every file the branch changed exactly as the branch head has it. Done as above; `merged` names the squash commit.
- **`mergedAs` is a URL**: the session opened a pull request. The Item is handed over, with the link in Your turn and the In review lane; merging it is a person's call.
- **Neither**: the Item is parked for you with the reason. Answer once it is merged, and Scope Soup looks again. If main still does not contain it, your answer goes to the implementor (its own session is resumed and merges; at level 3 before an approval it goes to review first).

A level change applies to work that starts after it: a session started at level 2 keeps its prompt and may merge although the level is 3 or 4 by the time it ends (decision 108). A session told to commit and stop that merged anyway is escalated, since nobody reviewed it. A change handed back by a person at level 2 is parked for you the same way; at level 3 it is reviewed, then merged by a fresh implementor.

A job that waits at the review step when the level is lowered to 2 is resumed to merge by its implementor's own session. The board's reasons never name a switch the level hides.

**The main branch only moves forward.** After every session ends, Scope Soup fetches the remote's main and compares it with the commit it last saw (`orchestrator.main_seen`). A main that moved any way but a fast-forward (a force push, rewritten history) is an `orchestrator.main_rewritten` event, and Scope Soup pauses triage, implementors and review: running sessions finish their step and nothing new starts. Look at the main branch, then press Resume all.

### The host

`host` says where the items live: `{ "kind": "github", ... }`, `{ "kind": "metaBranch", ... }` or `{ "kind": "jira", ... }`. A relative path in the private file is relative to that file. A token is never in either file; a key with "token" in its name is refused.

- **github**: `repo` (`owner/name`) and `write` (like `SCOPESOUP_WRITE=1`; with `write: false` the board says to close the issue by hand). The token is `SCOPESOUP_GITHUB_TOKEN`.
- **meta branch**: `write` and `fetchSeconds` in the shared `host`. The Items are on the meta ref of `repoPath`, shared with `remote`. What belongs to one machine or person is in that machine's private file as `meta`: `meta.authorName`, `meta.authorEmail`, `meta.prefix` (the `SCOPESOUP_META_*` variables); they are refused in the shared `host`. With `write: true` every machine needs all three: a machine without them reads no Items, starts no agent, and its board asks "Set up this machine for the meta branch".
- **jira** (untried on a real site): Jira Cloud or Data Center. In the shared `host`:
  - `site` (`https://example.atlassian.net`, or your Data Center's base URL), `project` (the key), `deployment` (`"cloud"` or `"datacenter"`), `write`.
  - Optional: `priorities` (Jira priority name to `blocker`, `critical`, `major` or `minor`; default Highest blocker, High critical, Medium major, Low and Lowest minor, and the older Blocker, Critical, Major, Minor, Trivial), `abandonedResolutions` (resolutions that make a done issue abandoned; default Won't Do, Won't Fix, Duplicate, Cannot Reproduce, Incomplete, Declined), `blocksLink` (the link type read as "is blocked by"; default `Blocks`).
  - `filter`: a JQL condition (no `ORDER BY`) ANDed with the project that decides which issues are Items. Issues outside it are not read, shown or touched. New Items are created in `project`, with the components in `components`. Both are edited in Settings; before a new filter is saved the board counts the open issues it adds and removes, and saves only on a yes.
  - The token is `SCOPESOUP_JIRA_TOKEN`: on Cloud an API token, sent with the account's email (`jira.email` in this machine's private file); on Data Center a personal access token. A machine without them asks on its board to "Set up this machine for Jira" and starts no agent.
  - The board shows state (from the status category), priority, labels, parent, sub-tasks, "is blocked by" links, the assignee as a person's hold, and the description as Markdown.
  - With `write: true` Scope Soup writes as the token's account: it creates issues (`issueType`, default `Task`; a restructuring's children as `childIssueType`), edits summary, description, labels, "Blocks" links, priority and the assignee, and moves an issue with the workflow's transitions. `transitions` names the transition (or the status it goes to) for `backlog`, `todo`, `doing`, `done` and `abandoned` (defaults Backlog, To Do, In Progress, Done, Won't Do); a name the workflow does not offer falls back to a transition into the same status category (`backlog` has no fallback). `resolutions` (for `done`, `abandoned`, `duplicate`; defaults Done, Won't Do, Duplicate), `childIssueType` (default `Sub-task`), `relatesLink`, `duplicateLink` and `commentLimit` (default 32000 characters) have defaults too.
  - Scope Soup's own records (questions, answers, rewrites, decisions) are comments with their data in a hidden comment property; a person answers with a reply that starts `A1:`, as on GitHub. An agent's hold is the hidden issue property `scopesoup.claim`. Only a comment by the token's own account counts as Scope Soup's. An answer or an `A1:` reply also counts from the people Jira lists as assignable in the project and those named in `answerers` (account ids on Cloud, user names on Data Center); anyone else's is a plain comment. The research before it was built (some key names differ): [`research/jira.md`](research/jira.md).
  - Jira has no pull requests, so changes stay on the git remote, as with the meta branch host: branches are `scopesoup/DEMO-12`, at levels 2 and 3 the session merges to the main branch of `remote`, at level 4 the merge queue pushes there. `mergeQueue.ci: "github"` is refused. Jira for Items with GitHub for changes (mixed hosts) is not built. The item commands work on a Jira host ("Item commands").

How the file and the environment meet:

- The file has `host`: the file wins. `SCOPESOUP_GITHUB_REPO`, `SCOPESOUP_WRITE` and `SCOPESOUP_META_*` are not read; Scope Soup names the ones that are set, at start.
- The file has no `host`, or there is no file: the environment variables work. Writing needs the file's `machineName`, so without a file the hosts are only read.
- The installation's own settings (`SCOPESOUP_DATA`, `SCOPESOUP_PORT` and the rest) and tokens always come from the environment.
- `pnpm meta:accept` reads the `SCOPESOUP_META_*` variables and takes the machine's name as `--machine <name>`.

An example for one laptop. Your own clone is `C:\projects\shop`; the file is `C:\projects\shop-scopesoup\scopesoup.config.json`, outside any repository, and Scope Soup's own clone is `C:\projects\shop-scopesoup\repo`:

```json
{
  "version": 2,
  "repoPath": "repo",
  "realPaths": ["C:/projects/shop"],
  "machineName": "laptop-a",
  "meta": { "authorName": "Robin Example", "authorEmail": "robin@example.invalid", "prefix": "A" }
}
```

with the project's shared settings on its meta ref (written once by the first person, `pnpm settings:init`):

```json
{ "project": "shop", "level": 0, "host": { "kind": "metaBranch", "write": true } }
```

Start it with `$env:SCOPESOUP_CONFIG = "C:\projects\shop-scopesoup\scopesoup.config.json"` and `pnpm start`. Raise the level on the Settings page (1 for triages, then 2 or 3) when the board looks right.

### Merging through the merge queue

Level 4 always merges through the merge queue (a batch of one is the same thing):

```json
"level": 4,
"remoteUrl": "ssh://git@git.example.invalid/team/project.git",
"checkCommand": ["node", "scripts/check.js"],
"settings": { "checkTimeoutMinutes": { "value": 60, "reason": "The check takes about 10 minutes." } }
```

- `remoteUrl`: the repository the main branch is pushed to. Before it pushes, Scope Soup compares it with `git remote get-url <remote>`, ignoring case, a trailing `.git`, a user name, a port and the difference between `https://`, `ssh://` and `git@host:` forms. When they differ nothing is pushed.
- `checkCommand`: the program and its arguments, run without a shell in the queue's clone. On Windows it must be an `.exe`: a `.cmd` or `.bat` is refused, as for `claude`. Name `node.exe` and the tool's script, or start a script of the project's own with `["cmd.exe", "/d", "/c", "check.cmd"]`. Without it nothing merges: a reviewed change is parked as an escalation, and an answer once it is set hands it to the queue.
- `checkTimeoutMinutes`: a check that runs longer is stopped, with everything it started, and counts as failed. Default 60.

A reviewed change is not pushed on its own. It is parked as "queued" and the queue (`src/queue`) takes it, one check per batch:

1. Changes that are ready together are built into one chain: each is replayed (cherry-picked) on the one before it, starting at the main branch, in a clone Scope Soup keeps in `<workspacesDir>/queue`. Nothing runs in an item's workspace or a person's checkout. A change that does not apply is sent back with the change it conflicts with.
2. The setup runs there first when it must ("The setup of a fresh clone"), then `checkCommand` runs on the tip of the chain. Green: the tip is pushed to the main branch, fast-forward only, and every change in the chain is merged.
3. Red: the files the output names as failing are tried again on the same commit (only those files with `rerunFilesCommand`, else the whole check). If it passes, the batch merges and a flake is logged as `orchestrator.queue_flake`. If it fails again, the chain is bisected: every green prefix is pushed as soon as it is known, and the first change that makes a prefix red is sent back to its item as a fix round. The changes behind it lead the next batch.
4. The engine chooses batch size from the measured failure rate, the cost of a rerun and how long checks take ([`BATCH_SIZE.md`](BATCH_SIZE.md)). The settings are `queueMinBatch` (default 2), `queueMaxBatch` (12), `queueRerunCost` (0.15) and `queueMinOutcomes` (10).
5. The head that was handed over is what merges; a branch that moves afterwards is not built.

`rerunFilesCommand` (file-only) reruns only the failed files: the program and its arguments with exactly one argument `"{files}"`, for example `["node", "--test", "{files}"]`. Only relative names of files that exist in the repository are passed on.

The safety rules: the remote must be the configured repository; only a commit on which the check passed is pushed, by its id; the push is a plain fast-forward `git push`, never forced, hooks never skipped; after Stop nothing is pushed and a running check is stopped. If the check changes a tracked file it counts as failed.

The queue's state is kept in the store and shown as batches on the Merge queue page, with recent flakes and problems; a restart goes on from the state. When the engine pauses itself the reason is in the log as `orchestrator.queue_paused`; press Resume the queue on the page. A paused queue or a problem in the last day shows in the status line's alerts.

### Waiting for CI on GitHub

On a GitHub project the project's own CI can check each batch instead of `checkCommand`:

```json
"level": 4,
"remoteUrl": "https://github.com/acme/widgets.git",
"host": { "kind": "github", "repo": "acme/widgets", "write": true },
"mergeQueue": { "ci": "github", "ciTimeoutMinutes": 60 }
```

- `mergeQueue.ci`: `"local"` (default) runs `checkCommand` as above; `"github"` waits for the project's CI on GitHub, and level 4 then needs no `checkCommand`. It needs a GitHub host with writes on, with the clone's remote pointing at that repository, and `remoteUrl` naming the same repository (compared as for every push); a meta branch `host` is refused. Otherwise a reviewed change is parked as an escalation that names the reason.
- `mergeQueue.ciTimeoutMinutes`: how long a check may stay pending, 1 to 1440. Default 60.

The queue builds the batch as before. Then, for the commit it would test:

1. It pushes the commit to a branch of its own, `scopesoup/batch-<batch>-<first 7 digits of the commit>`, with a plain `git push`, and opens a pull request from it into the main branch: title "Scope Soup merge queue: batch N", a description of Scope Soup's own data and a `batch` marker ([`github-mapping.md`](github-mapping.md)). The items' numbers carry no closing keyword; merging closes the items as always.
2. Each tick it reads every check run and commit status on exactly that commit, the latest of each name. Branch protection and "required" checks are not read: every check counts.
3. **All green** (success, neutral or skipped): that same commit is pushed to the main branch fast-forward (no squash; what merges is what was tested), and GitHub shows the pull request as merged. If main moved meanwhile, the batch is rebuilt and checked again on a new pull request.
4. **A check red**: the change is sent back to its implementor with the failing check's name, its conclusion and the end of its log (or its link when the log cannot be read). A batch of several is bisected, each shorter chain on a pull request of its own; failed files are not rerun.
5. **Still pending after `ciTimeoutMinutes`**: the Items leave the queue and are parked for a person with the pending checks' links; nothing is merged. An answer hands them to the queue again.
6. **No check at all** 5 minutes after the push: the Items are parked for a person saying no CI ran, rather than merging unchecked.

When GitHub cannot be reached (a 5xx, a rate limit, offline) the queue tries again at the next tick. A refusal (missing rights, a branch that cannot be pushed) pauses the queue with the reason. GitHub's own auto-merge is not used.

**Tidying up.** A batch's pull request that ends without merging gets one comment why, is closed, and its `scopesoup/batch-...` branch is deleted. Scope Soup touches only a pull request whose head is a `scopesoup/batch-...` branch, whose description ends in the `batch` marker and that the token's own login opened.

### A pool of clones

The pool's clones belong to Scope Soup; developers do not work in them (decision 35). Git worktrees do not work well with submodules. When the project's repository is a submodule of an outer repository that the tests need, make a few full clones of the outer repository side by side (with the submodule checked out) and list them:

```json
"workspaces": { "kind": "pool", "paths": ["../pool/one", "../pool/two"], "projectSubdir": "libs/project" }
```

- `paths`: the clones, relative to the configuration file. Each is a folder of its own. A path may not equal, contain or lie inside `repoPath`; `realPaths` apply to every clone and its subfolder.
- `projectSubdir`: where the project's repository is inside each clone, relative and without `..`. Left out, the clone itself is the project's repository. It must be a git repository of its own (the submodule), not a plain folder of the outer repository.
- An item claims a free clone and its sessions work in `<clone>/<projectSubdir>` on the item's branch. It keeps the clone across its steps and frees it when it is parked or finished; when none is free the item waits. Before it starts, Scope Soup fetches the main branch there and makes the item's branch from it. When an item is freed, the project's repository is left on a detached HEAD at the item's last commit.
- **Never edit in a clone that an item holds.** When the clone is freed, Scope Soup discards everything uncommitted in the project's repository there if a session of the item ran in it, since it cannot tell a person's edits from a session's. The edits are recorded first (below), but work in a clone no item holds.
- **When the discard happens.** Only when the clone is freed, no session of the item is running, the repository is on the item's branch (or a detached HEAD at its tip) with no rebase, merge or other operation in progress, and the path checks pass. Otherwise nothing is touched and the clone is passed over until you clean it (`orchestrator.workspace_not_discarded` says why).
  - **Never discarded:** anything, when no session of the item ran in the clone, or the leftovers are over 500 MB; files git ignores; paths matching `workspaces.keep` (patterns as in `.gitignore`, for example `"keep": ["build/", "**/*.cache"]`); nested repositories, submodules, links; and the outer repository.
  - **Getting it back.** Before anything is discarded, a full copy goes to `<streamsDir>/discarded/<item>-<time>/` on this machine; if it cannot be written, nothing is discarded. The folder holds the diffs, copies of the removed files, `discarded.json` and `RESTORE.md`. **To get it back, open the folder and follow `RESTORE.md`.**
  - The event `orchestrator.workspace_discarded` names the clone, the item and the record's folder.
- **When a clone is not available.** Scope Soup passes a clone over, and never cleans it, when its repository has uncommitted changes (not counting untracked files under `keep`), an operation in progress, a branch that looks like a person's work, or a stale item branch. When no clone is left the item waits. Finish or put away your work to give it back to the pool.
- **The outer repository shows the project as modified** while an item works in it. Scope Soup never touches it; keeping it up to date is your job, while no session runs in that clone.

## Backlog and To do

The board has two lanes for work not started (decision 121). **Backlog** holds what a person has not chosen yet: no agent triages or implements it. **To do** holds what agents may start; triage runs when an Item comes there. A person moves an Item with the State menu; moving an Item with work under way to To do or Backlog drops that work. An Item a triage parks as not ready stays where it is.

- **New Items land in Backlog**: approved drafts, follow-ups an agent files, and a person's New item ("Create in To do" in the dialog and `item new --claim` file in To do). A person's overturn rework goes to To do. A person's claim, hand-back or Implement anyway on a Backlog Item moves it to To do.
- **Triage on a Backlog card** runs one triage, at any level, for its questions and a size; the Item stays in Backlog until a person moves it to To do.
- **Hosts.** Meta branch: a `lane: backlog` line in `item.md`'s header. GitHub: the label `scopesoup:todo` (an open issue without it is in Backlog). Jira: the status named by `host.transitions.backlog` (default "Backlog"); on a Jira project with no such status a new Item is refused with the reason ("Create in To do" still works).

## How Items are ordered

The To do column, the order of the board's numbers and the item Scope Soup starts next are one order (decision 79). Items that had a triage come before those that did not (the divider "Not triaged yet"). Among each, a `priority:blocker` Item goes first, then the higher score. A score is points; the weights are fixed defaults in `src/orchestrator/score.ts` (`WEIGHTS`), not settings:

| What | Points |
|---|---|
| Priority | critical 60, major 30, no priority 0, minor -30 |
| Bug (one of `bugLabels`) | 10 |
| Each open Item it unblocks | 5, up to 4 Items |
| Already started (the Item is in the implement or review step, or its branch head differs from main) | 35 |
| Age | 0.25 for each open Item that is newer, so nothing waits forever |
| Size from the triage | small 0, medium -3, large -8 |
| A person's vote | the points the vote buttons set, 2 decimals |

Until the triage, only priority, vote and age count. Ties go to the older Item.

**Votes.** Each Item has one vote. Each press of "Vote up" or "Vote down" (▲ ▼ on the To do card and the Item page) moves the Item exactly one place within its own group (with or without triage; blockers among blockers); up then down gives the old order back. The board never shows the number; the Item page says its place and why in words. On the meta branch host the vote is the header field `vote`; on GitHub it is kept in Scope Soup's own store and does not travel to other machines.

## A stand-in for trials

To try the whole loop on repositories shaped like a submodule setup, with made-up content:

```
pnpm standin C:\trials\standin
```

The folder must be new or empty. It gets:

- `remotes/harbour-tools.git` and `remotes/tidy-units.git`: bare "remotes" for an outer repository and a small project (a few lines of JavaScript, one `node:test` test).
- `pool/one` and `pool/two`: full clones of the outer repository, with the project as the submodule `libs/tidy-units`.
- `scopesoup-repo`: Scope Soup's own clone of the project, with the items on `refs/scopesoup/meta`, pushed to the project's remote.
- `scopesoup.config.json`: a meta branch host with writes on (prefix `A`), the pool, the merge queue with `node --test` as the check, haiku for every role but review (sonnet), and `level: 4`.
- `data/`: the database, workspaces and stream files.

The script prints the command to start Scope Soup on it, with the board on port 4330. At level 4 an item written on the board starts real `claude` sessions; set `"level": 0` to look first.

## Item commands: file, claim and hand back from a terminal or a Claude Code session

A person, or an interactive Claude Code session working for one, files and claims items with `scopesoup item <verb>`, run in the project's repository, which finds this machine's config ("Which config a command reads"); from anywhere else give `--config <file>` or `SCOPESOUP_CONFIG`:

```
scopesoup item new --title "..." [--body-file notes.md | --body "..."] [--priority blocker|critical|major|minor] [--label bug] [--claim]
scopesoup item claim A-12 [--as "Name"]
scopesoup item handback A-12 [--note "..."]
scopesoup item release A-12 [--note "..."]
scopesoup item list [--mine | --free] [--all] [--search "words"] [--json]
scopesoup item show A-12 [--json]
```

In a clone of Scope Soup, `pnpm --dir <Scope Soup> item <verb>` does the same (pnpm keeps the caller's folder in `INIT_CWD`). Exit code 0 is done, 1 is refused or failed (the reason is printed), 2 is a misuse of the command.

- **new** files an item (on GitHub an issue; GitHub has no priority field). **`--claim`** files it already held by the person, in one write. Use it for new work you mean to build: filing and then `claim` is a race, because Scope Soup starts a free item within seconds.
- **claim** makes the person the holder. Scope Soup does not start the item. It is **refused** when an agent holds the item or a session is running on it. A person's hold never expires; the board calls it quiet after a day without a line. The Item is in that person's "Your turn".
- **handback** says the work is on the item's branch, `scopesoup/<item>`, pushed to the project's remote (`git push origin scopesoup/A-12` first). The command fetches the branch and records its newest commit; a branch that is not on the remote, or has no commits beyond main, is refused. On the meta branch it writes a `revision` and a `released` line; on GitHub it opens a pull request ("Closes #N") labelled `scopesoup:review` and unassigns. Scope Soup then takes it on as if an implement session had just finished: review from level 3, then the check and the merge (level 4); at level 2 it goes straight to the hand-over, parked for you until main contains the branch.
- **release** lets go without a branch. Anyone may release anyone's hold. An agent's claim is not released: it ends at its `until`.
- **list** shows the open items and who holds what (`--all` adds finished ones). An item nobody holds that already has a change shows as "in review", not "free", and `--free` leaves it out. **`--search`** keeps the items whose id, title, labels, description or verification hold every word.

The person's name is `--as`, else `SCOPESOUP_PERSON`, else the configured author name, else git's `user.name`. On GitHub the holder is the token's user, and `--as` may only name that user. A session started by Claude Code says so in the claim (`from: claude-code`), and the board shows "from a Claude Code session".

**On the board**, the Item page has the same three as buttons for the board's picked person (meta branch, or Jira with `write`; not GitHub): **Claim**, **Hand back**, **Release**. A button that cannot be pressed says why. After Claim, the holder sees the commands to start the branch (`git fetch origin && git switch -c scopesoup/48 origin/main`, later `git push origin scopesoup/48`). The board does not push.

**The State menu** (decisions 103 and 104). The Item page shows the state as a menu: the board's columns plus Triage and Abandoned. Picking one does what that column means, by the rules the buttons and the agents already follow; an option that cannot be picked now is greyed with the reason.

- **Triage**: its triage runs again next, ahead of new Items, at any level; the one before and any work since is dropped, the branch stays.
- **Blocked**: pick the Item that blocks it; it is added to Blocked by.
- **Backlog**: a person's hold is released and work under way is dropped (the branch stays); a done or abandoned Item is reopened.
- **In progress**: Claim; over another person's hold it releases theirs first.
- **In review**: the review step starts now, at any level; it needs a revision on the Item's branch.
- **Merge queue** (level 4 only): a reviewed change is handed to the queue now. The approval counts only for the revision it was given on.
- **Done**, **Abandoned**: the state edit.
- **Implement anyway** is a button by the reason of an Item that triage parked as not ready or too large. It starts the implement step now with triage's notes as they are, and History says who overruled triage (decision 105).

Triage, Backlog's drop, In review and Merge queue are refused while the merge queue holds the Item's branch, or (except Backlog) while a person holds it. A pick that interrupts a running step ends that session at once (the process tree is killed; a person's chat turn is left alone); Done lets the step finish.

**On another machine**: when an agent of another machine holds the Item, the pick is written to the meta ref as a request, and that machine carries it out after its next fetch, once, as the person who picked, unless the Item changed since. The menu shows the newest request under it: waiting, refused with the reason, or lapsed.

Every pick waits about 5 seconds with a toast, "A-2 → Backlog · Undo"; Undo sends nothing. An Item that changed since the page showed it is refused with "changed meanwhile" rather than overwritten. History names who did each.

**On Jira** the person is the token's account, and `--as` may only name it. Ids are issue keys (`DEMO-12`). **new** creates an issue of `issueType`; **claim** makes you the assignee (an agent's claim refuses it, and an agent's claim that lands within two seconds wins); **handback** posts a comment "Handed back on `scopesoup/DEMO-12`" whose hidden property holds the branch and its newest commit, then unassigns you; **release** unassigns. Scope Soup counts a hand-back only from its own account, the assignee at the time, or someone in `answerers`, and only when the branch is at exactly that commit. The board's buttons do the same for the picked person, who must be a Jira account.

### Importing from GitHub Issues

A project whose backlog is on GitHub Issues and that moves to Items imports it once (decision 67). The host is meta branch with `write: true`; the token is `SCOPESOUP_GITHUB_TOKEN`, from the environment only. It writes straight on the meta ref, never through the server:

```
scopesoup item import github --repo OWNER/NAME [--closed N|all] [--comments N|none] [--on-github leave|label|close [--yes]] [--dry-run] [--github-login LOGIN]
```

- **What comes along.** Every open issue becomes an Item with its title, body, labels, priority, parent and sub-issues, blocked-by links and, when it is the token's user, the assignee as holder. Links between imported issues are rewritten to the new Item ids; each Item records `importedFrom: github:OWNER/NAME#N`.
- **Comments**: the last 3 of each issue by default (`--comments N`, or `none`), quoted in the description. **Closed issues** are left out unless asked for (`--closed N` or `all`). Pull requests are never imported.
- **One commit** by the person who runs it, pushed with the meta ref, so it can be read and undone. A second run skips issues already imported. `--dry-run` writes nothing.
- **GitHub is only read**, unless `--on-github` says otherwise: `label` gives each open imported issue the label `moved-to-scopesoup` and a comment naming its Item; `close` also closes it as not planned. Both are asked first in a terminal, or need `--yes`.

The onboarding skill offers the import when the backlog is on GitHub Issues today. Only GitHub is supported as a source. When a project leaves Scope Soup, offboarding exports the Items back as Markdown files ("Offboarding").

### The text for a project's CLAUDE.md and README

`plugins/scopesoup/claude-md-section.md` is the text the onboarding skill offers to add to a project's `CLAUDE.md`: the backlog is Scope Soup's Items, and the item commands as `scopesoup item ...`. It sets no rules for a session. `plugins/scopesoup/readme-line.md` is the optional line appended to the README under "Open the Scope Soup board"; offboarding removes it by that heading.

## Starting on a real project

What the stand-in trial ([`TRIALS.md`](TRIALS.md), 2026-11-19) taught, in the order to do it:

1. **Look first.** Start with `"level": 0`. The board fills from the meta ref and nothing starts. Then set level 1, move a few Items to To do, press Resume on To do and read the triages.
2. **One prefix and one name per laptop.** `meta.prefix` and `machineName` must differ on every machine that writes items.
3. **The check command** ("Merging through the merge queue"). Set `settings.checkTimeoutMinutes` well above how long it takes, and run it once by hand in a pool clone first.
4. **The remote.** `remoteUrl` must name the repository the clones push to. The project's pre-push hook runs; Scope Soup never skips it.
5. **Small items first, then raise the level.** Watch the first item go through at each level: triage, implement, review, then at level 4 check and merging. The item page has the log; the meta ref on the remote has the same.
6. **If Scope Soup's `data/` is lost,** start it again: items and answers come back from the logs on the remote. An item that was waiting on an answered implement question or escalation restarts at triage with the answer in its prompt.

## Onboarding with the Claude Code plugin

This repository is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) with one plugin, `scopesoup` (`plugins/scopesoup/`), whose skill `scopesoup-onboard` walks you through "Starting on a real project" from your own Claude Code session. What it asks and does, step by step: [`ONBOARDING.md`](ONBOARDING.md). Install it once, in any session:

```
/plugin marketplace add mikaeltulldahl/scopesoup
/plugin install scopesoup@scopesoup
```

Then, in a session in the project's clone, run `/scopesoup:scopesoup-onboard` (optionally with the clone's path).

To join a project Scope Soup already runs, run the same skill in your clone: it writes only this machine's private file ([`ONBOARDING.md`](ONBOARDING.md), "Joining a project Scope Soup already runs").

### Writing the shared settings of a new project

```
pnpm settings:init <settings.json> --as <your name> [--config <this machine's scopesoup.config.json>]
```

Checks the file with this machine's private file, fetches the meta ref from `remote`, and when the project has no shared settings yet writes them as one commit named after you and pushes it. Exit code 0 when written, 1 when refused.

### Building a Jira host for onboarding

```
pnpm config:host jira --site <https address> --project <KEY> [--deployment cloud|datacenter] [--email <email>] [--filter <JQL>] [--component <name>]... [--read-only] [--look]
```

Builds the `host` as Settings' "Connect to Jira" does, checks it (https only, project key, filter, components, Cloud email), and prints the shared `host` and this machine's `jira.email` as JSON. With `--look` it reads the project once with `SCOPESOUP_JIRA_TOKEN` from the environment and counts the open issues (exit 3 when it could not). The token is never asked for or printed.

### Checking a configuration file

```
pnpm config:check [file] [--shared <path to settings.json>]
```

Validates the private file together with the project's shared settings, with the orchestrator's rules, then prints every problem, or the recommendations for a valid pair. The shared settings are read from `refs/scopesoup/meta` of the `repoPath` the file names, fetched from `remote` first; `--shared` reads a file instead, for settings not written yet. Without a file it checks the config the command finds ("Which config a command reads"). Exit code 0 for a valid file, 1 for a missing or invalid one.

## A GitHub project

GitHub is the source of truth for a GitHub project: the issue is the Item, and Scope Soup's store is a cache of it ([`github-mapping.md`](github-mapping.md)). Look first with `SCOPESOUP_GITHUB_REPO` and a token and no configuration, or with `level: 0`. With writes on, Scope Soup's questions and rewrites appear as comments on the issues, and it closes the issue once main contains the branch. When it needs you, the issue carries `scopesoup:needs-decision`.

## The meta branch's format and upgrades

The meta branch carries its format (decision 63): a file `format` at the root of its tree with a whole number, raised only for a breaking change. A branch without it is format 0. This Scope Soup reads and writes format 1, which is format 0 plus the file. Laptops on different versions share one branch and it cannot be restored from a backup, so the rules are forward only:

- **An older branch is migrated once, by one machine.** With `SCOPESOUP_META_WRITE=1` Scope Soup checks the format at start and every two minutes while the branch is older; the machine that takes the merge queue lease makes one commit (`Meta branch format 0 to 1`), pushes it and lets the lease go. Writes go on meanwhile.
- **A newer branch is read only.** It is still shown, but every write is refused with "this project's data is from a newer Scope Soup; upgrade". Commits made before it saw the newer format are shared at the next push after the upgrade.
- There are no downgrade migrations: an older Scope Soup, after the branch was migrated, only reads.

## The database's schema version and upgrades

The database (`scopesoup.sqlite` in `SCOPESOUP_DATA`) carries its schema version (decision 64) in `PRAGMA user_version`, raised only when the schema changes. A database without one is version 0. This Scope Soup uses version 1 (a new database starts there). For a meta-branch project the database also holds the answers and the work in progress, so an upgrade must not lose it.

- **An older database is migrated when it is opened**, in one transaction, every row kept; if a step fails nothing changes (`src/store/schema.ts`). Scope Soup prints `… was migrated from version 0 to version 1` once and writes a `scopesoup.store_migrated` event. The step from 0 to 1 only sets the number.
- **A copy is kept before a step that changes the schema**: `scopesoup.v<old>.sqlite` beside the database. To go back, use the old Scope Soup folder plus the copy (stop Scope Soup first); anything written after the upgrade is not in it. The step from 0 to 1 makes no copy.
- **A newer database is read only.** It is opened without changing anything; every write is refused with "this project's data is from a newer Scope Soup; upgrade". The server does not start on one: the start stops with that message and the path.
- There are no downgrade migrations.

## When the meta ref refuses what it fetched

With `SCOPESOUP_META_WRITE=1`, Scope Soup does not take a fetched meta ref that was rewritten, has a merge commit, removed or changed a log line it had seen, or no longer contains the last commit this machine shared. It keeps writing on its own copy and stops pushing, and the sharing report says why. To look (ref names for the default remote `origin`):

```
git log --oneline --first-parent refs/scopesoup-incoming/origin/scopesoup/meta
git diff refs/scopesoup-remote/origin/scopesoup/meta refs/scopesoup-incoming/origin/scopesoup/meta -- items
```

The first is the history that came in; the second shows what changed against the last good fetch. If what came in is right (a person rewrote the history on purpose), stop Scope Soup and accept it with

```
pnpm meta:accept --machine <machineName>
```

with the same `SCOPESOUP_META_*` settings Scope Soup runs with, and `--machine` the `machineName` of the configuration. It saves this machine's meta ref under `refs/scopesoup-backup/<time>`, takes the fetched history as the remote's, puts this machine's own unshared commits on top, pushes, and prints each step and where the backup is. Commits on the meta ref here that this machine did not make stay in the backup, and the command names them.

## ssh

Fetch and push never wait for a password or a host key: ssh runs in batch mode (your own `GIT_SSH_COMMAND` or `core.sshCommand` is kept with `-o BatchMode=yes` added, or `-batch` for PuTTY's `plink`; a `GIT_SSH` program is left as it is). Set up the key (an agent, or a key without a passphrase) so that `git fetch` works in a fresh terminal without a prompt.

## Stopping

**Pause** on a lane lets that role's running sessions finish and starts nothing new of it; **Stop** also ends running sessions and cuts off a merge under way; both keep everything ("Start, Pause and Stop"). Ctrl-C stops the process; sessions resume or restart once their switches are resumed after the next start. Deleting `data/` forgets Scope Soup's own state (jobs, answers, the event log) and nothing on the host.

## Offboarding

Pausing is not leaving. To leave, [`ONBOARDING.md`](ONBOARDING.md) ("Offboarding") says what happens; the skill `/scopesoup:scopesoup-offboard` runs this command with you (decision 75):

```
pnpm offboard [--config <scopesoup.config.json>] [--data <folder>]
pnpm offboard --remove work,items,github,project,machine|all [--include-kept <groups>|all] [--out <folder>]
pnpm offboard record setup-script|claude-md|readme-line|plugin-settings [--config <scopesoup.config.json>]
```

Without `--config` it offboards the config it finds. Without `--remove` it only prints the plan: everything Scope Soup left for the project in five groups (work, items, github, project, machine), each entry with what removing it does and `[remove]` or `[keep]`, read from the manifest `scopesoup.manifest.jsonl` beside the config file and from the remote, the clones, the project's files and the config list. The data folder is `--data`, else `SCOPESOUP_DATA`, else what the manifest recorded.

`--remove` acts on the groups named, in order, and only on their `[remove]` entries; `--include-kept` names the groups whose `[keep]` entries (branches not merged, open pull requests, folders with work not pushed) go too. It refuses while a board answers on `SCOPESOUP_PORT`. The Items are exported to `<out>/items/<id>.md` with the shared settings before `refs/scopesoup/meta` is deleted; the project's files become `<out>/scopesoup-offboard.patch`; the report is `<out>/report.txt`. Branches and refs are deleted with a plain push, never forced; a folder that overlaps the person's checkout, a pool clone or the install is never removed. The installation and the plugin are left to the person.

`record` is for the onboarding skill: it notes the setup script (and its `scopesoup/onboard` branch), the CLAUDE.md section, the README part or the plugin lines on the manifest. The Settings page's "Stop using Scope Soup" (`#/settings/stop`) shows the same plan, read only, with Stop.

## Cutting a release

A release is a tag `vX.Y.Z` on `main` whose commit passed `pnpm check` as it is, with a GitHub release carrying the zip, the `.exe`, their `.sha256` files and notes. In a clean clone of Scope Soup, on the commit to release (normally `main` after `git pull`), with `version` in `package.json` raised:

```
pnpm release
pnpm release:publish X.Y.Z --notes-file notes.md
```

`pnpm release`:
1. Refuses a tree that is not clean, and a version that is already a tag in the clone or on `origin`.
2. Runs `pnpm check` on that commit, then makes sure the tree is still clean and `HEAD` did not move. When something merged in between, there is no release: run it again.
3. Builds `release/scopesoup-<version>/`, the zip and its `.sha256`, writes the commit and the three format numbers into `release.json`, and prints them.
4. Builds the Windows `.exe` and its `.sha256`, unless `--no-exe` is given or it cannot be built here (it says so and goes on).
5. Writes `release/scopesoup-<version>.checked.json`, the checked commit. It tags, pushes and publishes nothing.

`pnpm release:publish` is run only after a person said yes. It tags the checked commit `vX.Y.Z`, pushes the tag and runs `gh release create` with the zip, the `.exe`, their `.sha256` files and the notes. It refuses, before changing anything, when there is no `--notes-file`, the release files are missing, the checked commit is not on origin's main, or `vX.Y.Z` already exists.

The notes say what changed, and for each of the config file, the meta branch and the database whether its format changed (the numbers `pnpm release` printed against the last release's `release.json`) and what the migration does. `pnpm release --no-check` makes a test build without the check; its `release.json` says `"checked": false` and `pnpm release:publish` refuses it.

## Windows

Scope Soup runs on Windows 11 with the same commands; use PowerShell or Git Bash. In PowerShell set the variables as `$env:SCOPESOUP_GITHUB_REPO = "owner/name"` before `pnpm start`.

**Besides the list above the machine needs:**
- Git for Windows. This repository pins line endings to LF with `.gitattributes`, whatever `core.autocrlf` says.
- `claude` as a real executable, see below.
- `powershell.exe` (Windows PowerShell 5.1, always present) for keep-awake and the desktop notification. Nothing needs elevation. On macOS the notification is made with `osascript`, on Linux with `notify-send`.

**How `claude` is found.** Sessions start `claude` without a shell, and Windows cannot start a `.cmd` shim that way. With `claude.path` left at `claude`, Scope Soup searches `PATH`, `claude.exe` first; if only a shim exists (the `claude.cmd` npm installs) the session is refused with a message that names it. Set `claude.path` to the real executable (the native install puts it at `%USERPROFILE%\.local\bin\claude.exe`), or set `path` to `node.exe` and put the script in `claude.prefixArgs`.

**Stopping.** A stalled, overdue or stopped session is ended with every process it started, found by parent id and creation time, since Windows reuses process ids.

**Keep-awake.** While a session runs, an item is ready to start, or something waits for a time (a retry or a usage-limit reset), Scope Soup starts a small `powershell` child that asks Windows not to go to sleep. When there is nothing to do, agents are paused or stopped, or the level is 0, it ends. The screen may still turn off. Set `"keepAwake": false` to switch it off.


**Known limits.**
- Closing the lid is a separate Windows setting: if the laptop is set to sleep on lid close, the request does not override it.
- The request does not stop a sleep or shutdown that a person asks for, nor a forced hibernation at critical battery.
