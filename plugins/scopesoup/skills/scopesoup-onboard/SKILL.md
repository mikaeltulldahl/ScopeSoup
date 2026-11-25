---
name: scopesoup-onboard
description: Put the current project under Scope Soup. Finds the Scope Soup install (a release folder in Scope Soup's home, with the `scopesoup` launcher) on this machine, asks where the project's clone is, where its backlog is today and where to keep it from now on (Scope Soup's own Items, GitHub Issues or Jira, offering a one-time import of GitHub Issues into Items) and this machine's prefix, proposes the setup of a fresh clone, writes this machine's short scopesoup.config.json outside the project's repository, checks it with Scope Soup's own validator, and on a new project writes the shared settings (level 0) to the project's meta ref and pushes the setup script on a branch for the person to merge. On a project Scope Soup already runs it writes only this machine's private file. Use when the person asks to set up, onboard or configure Scope Soup for a project.
disable-model-invocation: true
argument-hint: "[path to the project's clone]"
---

# Onboard a project to Scope Soup

Scope Soup runs on this computer and shows a project's work on a board in the browser. At level 0, where every project starts, it only shows the work: it starts no agent and writes nothing on its own. The person raises the level later on the board's Settings page, which also says what each level needs (a check command, the remote's URL and so on are asked there, not here).

You ask **three things**: where the project's clone is, the backlog (in two parts: where it is today, and where to keep it from now on; plus what to do with the issues on GitHub when they are imported; on a new project also singleplayer or multiplayer, step 3c), and this machine's prefix (only for Scope Soup's own Items). Everything else you read or propose, the setup of a fresh clone included (step 4c: proposed and confirmed in the summary, never a fourth question). Then you show one summary, get one yes, write the files, check the configuration and, on a new project, write the shared settings.

Ground rules:

- Never invent the config format. Write the file, then run `pnpm config:check` (step 6) until it is clean.
- On a new project the repository gets two things: the shared settings on its meta ref `refs/scopesoup/meta`, written by `pnpm settings:init` as one commit named after the person, and a commit of the setup script `.scopesoup/scopesoup-setup.mjs`, made in Scope Soup's own clone (`repoPath`) on a branch `scopesoup/onboard` and pushed, for the person to merge the way the project's changes merge. On a project Scope Soup already runs it gets nothing. Nothing else, unless the person says yes to an optional step in the summary. Never commit in the project clone.
- Never read, print or repeat the content of a personal file (`.env`, local settings, credentials): only its name. Secrets never go into the repository, a prompt, the summary or a log.
- Before the yes, only read: do not clone, download, write, create folders or set git config.

Three folders, always named like this:

- **project clone**: the person's own clone of the project. Scope Soup never works in it.
- **Scope Soup install**: the release folder Scope Soup runs from (`scopesoup-<version>/`, with `scopesoup.cmd`). Called **SCOPESOUP** below. It sits in **Scope Soup's home**, a folder of its own that holds a folder per version, the file `current` naming the one that runs, and the launcher `bin/scopesoup.cmd` and `bin/scopesoup` (`SCOPESOUP/docs/RUNNING.md`, "Installing and upgrading"). Called **HOME** below. The project's committed files never name either: they say `scopesoup`, the launcher.
- **config folder**: where this machine's `scopesoup.config.json` and Scope Soup's data go, outside any git repository.

Two places, each key in exactly one (`SCOPESOUP/docs/RUNNING.md`, "The project's configuration"): the project's **shared** settings on its meta ref, `settings/settings.json` on `refs/scopesoup/meta` (`project`, `host`, `mainBranch`, `level`, `setupCommand`, `setupWatch`, roles and rules), and this machine's **private** `scopesoup.config.json` (`machineName`, `repoPath`, `remote`, `realPaths`, `ownClone`, `meta`, local paths, spending). Scope Soup refuses a key in the wrong place and says where it belongs.

**First, is the project run by Scope Soup already?** Run `git ls-remote <remote URL> refs/scopesoup/meta` in the project clone. If it prints a line, a teammate has onboarded the project: the person is **joining** (`SCOPESOUP/docs/RUNNING.md`, "Joining a project Scope Soup already runs"). Then write only this machine's private file: skip question 2 and the setup (step 4c; the host and the setup are the team's, in the shared settings), still ask question 3 for Items (read the host after the yes with `pnpm config:check`, step 6), and never write or commit shared settings or a script. Say so in the summary: "This project already runs Scope Soup: I will write only this machine's settings." This `ls-remote` only reads, to tell a project already run from a new one; it pushes nothing, in singleplayer too.

## 1. Find the Scope Soup install

This plugin runs from Claude Code's plugin cache, which is not a Scope Soup install: do not use `${CLAUDE_PLUGIN_ROOT}` for Scope Soup's commands.

1. Run `scopesoup version`. If it prints a version, the launcher is on the PATH: HOME is the folder above the launcher's `bin` folder, and SCOPESOUP is `HOME/<the folder named in HOME/current>`. Check it as in point 4.
2. Otherwise read `${CLAUDE_PLUGIN_DATA}/scopesoup-install.txt`. If it holds a path, check it as in point 4.
3. Otherwise look in the home folder and the project clone's parent folder, two levels down, for folders named `scopesoup-<version>` holding `scopesoup.cmd` or `scopesoup.sh`. Show what you found and let the person pick, or ask where it is.
4. A Scope Soup install has a `package.json` with `"name": "scopesoup"`, `src/config/check.ts`, `src/scopesoup.ts` (what the launcher runs), `docs/RUNNING.md`, `plugins/scopesoup/claude-md-section.md` and `scopesoup.cmd` or `scopesoup.sh`. Refuse a folder that is the project clone, inside it, or contains it. A folder with a `.git` is a development checkout: take it only if the person asks for a development setup. A release that lacks a file above is too old: offer a newer one.
5. With no install on Windows, and no Node 22.18 or newer or no pnpm, offer the release's `scopesoup-<version>-win-x64.exe` instead: the person runs it (it sets up HOME with its own Node and the launcher, `SCOPESOUP/docs/RUNNING.md`, "On Windows without Node: the .exe"), then run this skill's commands as `HOME/bin/scopesoup.cmd <command>` in place of `pnpm --silent --dir "SCOPESOUP" <command>`.
6. With no install otherwise, offer to download the latest release zip from `https://github.com/mikaeltulldahl/scopesoup/releases` and unpack it, as it is, into Scope Soup's home: a folder the person picks, outside any git repository, proposed as `<parent of the config folder>/scopesoup/`. After the yes in step 5.
7. HOME is the folder SCOPESOUP sits in. When HOME has no `bin/scopesoup.cmd` and `bin/scopesoup` yet, the launcher is written in step 6 (`setup-home`). A release folder that is not named `scopesoup-<its version>` cannot be set up: unpack the zip again as it is.

`SCOPESOUP/docs/RUNNING.md` ("The project's configuration", "The host") is the reference for every key below.

## 2. Question 1: where is the project's clone?

The current working directory, or `$ARGUMENTS`, is the likely answer: confirm it. Then read, without asking:

- `git remote -v` and `git symbolic-ref refs/remotes/origin/HEAD` in the project clone: set `remote` (private) and, on a new project, `mainBranch` (shared).
- `realPaths` and `ownClone`: the project clone. Scope Soup refuses to start an agent there; the setup copies personal files from `ownClone`.
- `repoPath`: Scope Soup's own clone of the project, proposed as `<config folder>/repo` and cloned after the yes.
- The config folder: propose `<parent of the project clone>/<project>-scopesoup/`. It must not be inside any git repository: walk up from it to the nearest folder that exists and check that `git -C <that folder> rev-parse --show-toplevel` fails.
- `project`: a short name, from the clone's folder name.

## 3. Question 2: the backlog, today and from now on

The backlog question has two parts, asked together in one message (decided): where the backlog is today, and where to keep it from now on. It is still one of the three questions: the second part decides the `host`, the first part decides what happens to the backlog that exists. Ask:

"Two parts about the backlog. (a) Where is it today, if anywhere: GitHub Issues, another tracker (which one), a text file, or nowhere yet? (b) Where do you want to keep it from now on: Scope Soup's own Items in the project's repository, GitHub Issues, or Jira?"

Offer "GitHub Issues" in (b) only when the remote is on GitHub. One question, three choices; "Jira" asks its details after (3d). What each answer to (b) means, in plain words, for the person:

- **Items**: the backlog lives in the project's own repository, on a ref of its own (`refs/scopesoup/meta`, next to the shared settings) that git fetches and pushes like a branch. Everyone who uses Scope Soup on the project shares it; it needs no token and no website, and it reads as plain files without Scope Soup. The board is where you read and change it. Config: `"host": { "kind": "metaBranch", "write": true }` in the shared settings, and this machine's `"meta": { "authorName": "...", "authorEmail": "...", "prefix": "A" }` in the private file, with `authorName` and `authorEmail` from `git config user.name` and `user.email` in the project clone, shown in the summary. Question 3 (the prefix) follows.
- **GitHub Issues**: the issues on GitHub stay the backlog, and Scope Soup reads them live (`docs/github-mapping.md`: GitHub is the source of truth). Nothing moves. It needs a token in the `SCOPESOUP_GITHUB_TOKEN` environment variable, never in the file. Config (shared settings): `"host": { "kind": "github", "repo": "owner/name", "write": false }`, with `owner/name` read from the remote's URL. No question 3.
- **Jira**: the Jira project is the backlog, read live; step 3d. It needs a token in `SCOPESOUP_JIRA_TOKEN`, never in a file. No question 3.

What the two answers lead to:

| Today | From now on | What happens |
|---|---|---|
| GitHub Issues | GitHub Issues | The github host. Nothing moves, nothing is imported. |
| GitHub Issues | Items | The meta branch host, and the import (below): one more part to the backlog question, what to do with the issues on GitHub. |
| Nowhere, or a text file | Items | The meta branch host, starting empty. Offer, as an optional step in the summary, to write the first Items (or file them from the text file, one Item per entry, each shown by title in the summary). |
| Nowhere, or a text file | GitHub Issues | The github host. A text file can be filed as issues by the person; the skill does not write to GitHub. |
| Anything | Jira | The Jira host (3d). Nothing is imported or moved. |
| Another tracker (Trello, ...) | Items, GitHub Issues or Jira | That host. Say plainly: "Importing from <tracker> is not supported yet, so the backlog there stays where it is and Scope Soup starts without it." |

Not sure yet? Items is a safe start: the Settings page's "Connect to GitHub Issues" and "Connect to Jira" switch the host later, moving the Items the person ticks. On a project whose host is GitHub or Jira, a machine without its token (or Jira Cloud email) is asked on its board to "Set up this machine".

### 3d. From now on Jira

Ask in one message what the host needs: the site (`https://...`, https only), the project key, Jira Cloud or Data Center, for Cloud the email of the account the token belongs to, and optionally a JQL filter and component names for new Items. Never ask for the token. Then run:

```
pnpm --silent --dir "SCOPESOUP" config:host jira --site <site> --project <KEY> [--deployment datacenter] [--email <email>] [--filter "<JQL>"] [--component <name>]... [--read-only] --look
```

It uses Settings' "Connect to Jira" checks and prints the `host` for the shared settings and `jira.email` for this machine's private file; copy both as printed. Exit 1: show the problems and ask again. Exit 3: the host is valid but could not be read; it names what is missing (usually `SCOPESOUP_JIRA_TOKEN` not set in this session): say so in the summary, the person sets it before starting Scope Soup. Exit 0: show how many open issues would be the Items.

### 3b. Today GitHub Issues, from now on Items: the import

Scope Soup can import the open issues once into Items (`pnpm item import github`, decision 67). Say what it does: every open issue becomes an Item with its title, text, labels, priority (from `priority:*` labels), parent and sub-issues, blockers, and its last 3 comments marked as imported; links between the issues are rewritten to the new Item ids; each Item says which issue it came from, so a second run never imports anything twice. Pull requests are never imported, and closed issues are left out (the person can ask for the last N, or all, in the summary). It is one commit on the meta ref `refs/scopesoup/meta`, by the person, so it can be read and undone. The import itself only reads GitHub.

Then ask the last part of the backlog question: "What should happen to the issues on GitHub after the import?"

- **Leave them** (the default): GitHub is not changed. The issues stay open there, and the two lists drift apart from now on.
- **Label them**: each open imported issue gets the label `moved-to-scopesoup` and one comment saying which Item it became. They stay open.
- **Close them**: as Label, and each is closed as "not planned" (the work goes on in Scope Soup, so it is not "completed"). Closed issues can be reopened on GitHub.

The answer becomes `--on-github leave|label|close`. Pull requests and closed issues are never touched. The import needs `SCOPESOUP_GITHUB_TOKEN` (reading the issues, and for Label and Close a token that may write them); check only whether it is set in this session, never print it.

### 3c. New project only: singleplayer or multiplayer

Ask with question 2, in one sentence: "Will you play alone on this project (singleplayer), or will others run Scope Soup on it too (multiplayer)?" What it means, in plain words:

- **Singleplayer**: Scope Soup's own refs stay in this clone; nothing under `refs/scopesoup/` is pushed (the Items and shared settings, the merge queue lease, images). Work branches and merges still go to the remote. Write `"multiplayer": false` in the private file.
- **Multiplayer** (today's way): those refs are shared on the remote, so teammates see the same Items and settings. Leave `multiplayer` out.

A person joining is multiplayer: do not ask. It can be switched later on the Settings page ("Players"); switching to multiplayer pushes what the clone has.

## 4. Question 3 (Items only): this machine's prefix

Every machine that writes Items needs its own prefix: `A` gives ids `A-1`, `A-2`. Singleplayer (step 3c) has one machine and nothing to read on the remote: propose `A` and skip the rest of this step. Otherwise read the ids that exist with `git ls-remote <remote URL> refs/scopesoup/meta`; if it prints nothing, nothing is taken. Otherwise confirm after the yes, in `repoPath`: `git fetch <remote> refs/scopesoup/meta`, then `git ls-tree --name-only FETCH_HEAD items/`; the letters before `-` in each name are taken. Propose the first free letter of `A`, `B`, `C`, ... and ask. A prefix is a letter followed by up to 15 letters or digits.

## 4b. The machine's name (proposed, not asked)

`machineName` is required: this machine's name in claims and log lines, which everyone can read on a public repository. Propose a short name of letters, digits, `-`, `_` or `.` (up to 40), such as `desk` or, for Items, `laptop-` and the prefix in lower case (`laptop-a`). Never propose the computer's host name. Every machine that shares the project needs its own name; show it in the summary, where the person can change it.

## 4c. The setup of a fresh clone (proposed, not asked)


Scope Soup's worktrees, clones and the merge queue's clone are fresh folders: they lack what the person's checkout has (installed dependencies, a virtual environment, generated files, submodules, a `.env` with test settings). A setup script sets one up; `setupCommand` runs it, once per folder and again when a file of `setupWatch` changes. `SCOPESOUP/docs/RUNNING.md`, "The setup of a fresh clone", is the reference.

1. Run, from the install (it only reads the clone):

   ```
   pnpm --silent --dir "SCOPESOUP" config:setup "<project clone>" "<repoPath>"
   ```

   It prints a proposal as JSON: `steps` (installs from the lockfiles, `git submodule update`, a venv for `requirements*.txt`, a `Makefile` setup target), `personalFiles` (ignored files in the clone that look like settings or secrets: names only), `setupWatch` and `setupCommand` (`node .scopesoup/scopesoup-setup.mjs --from-clone {{ownClone}}`: the script lives in the repository, and `{{ownClone}}` is each machine's own clone, from its private `ownClone`).
2. Read, without running anything: the README's setup instructions, the CI workflow's setup steps (`.github/workflows/*.yml`: what runs before the tests), code generation (what it reads goes into `setupWatch`), a test database. Add or drop steps to match. A step is `{ "run": ["program", "arg", ...], "cwd": "subfolder" }`; `{venv-python}` stands for the folder's `.venv` Python.
3. Personal files: propose only files that are ignored by git and hold the person's own settings (`.env`, `*.local.*`, `.npmrc`, test credentials). Nothing else is copied: a clone's build output has absolute paths that break elsewhere. The script copies each only to where git ignores it in the folder it runs in.
4. In the summary (step 5), show in plain words what the setup does, the personal files by name, and the watched files, as: "What has to happen in a fresh clone before you can build and test? I found: ...". The person confirms or corrects it there; it is part of the one yes, not a separate question.
5. After the yes (step 6), write the script with what was confirmed:

   ```
   pnpm --silent --dir "SCOPESOUP" config:setup "<project clone>" "<repoPath>" --write --project "<project>" --steps '<json steps>' --files '<json personal files>'
   ```

   It writes `<repoPath>/.scopesoup/scopesoup-setup.mjs`, on the `scopesoup/onboard` branch (step 6). Put its `setupCommand` and `setupWatch` into the shared settings. If the person wants no setup, leave both keys out and write no script.

## 4d. A browser for a web project (offered, never installed)

If the project is a web project (a `package.json` with a dev server or a front end, an `index.html`), offer in the summary (step 5), as one line the person can decline: "Give the implement and review roles a headless browser (Playwright, over MCP) to look at pages and take screenshots?" On a yes, add to the config file's `roles.implement` and `roles.review`: `"mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless"] } }` (on Windows `"command": "cmd"` with `"args": ["/c", "npx", ...]`). Install nothing yourself: the server downloads itself when a session first uses it. A server that needs a secret takes only the variable's name in `env`, never its value. `SCOPESOUP/docs/RUNNING.md`, `roles.<role>.mcpServers`, is the reference.

## 5. The summary and one yes

Show, in plain words:

- The folders and clones to make (config folder, `repoPath`), and the release to download, if any.
- Scope Soup's home and its launcher: `HOME/bin`, written by `setup-home` when it is not there. Scope Soup never changes the PATH: say that the person adds `HOME/bin` to their PATH themselves, and how (what `setup-home` prints).
- The setup of a fresh clone (step 4c): what it runs, which personal files it copies from the person's clone (names only), which files it watches, and the script it writes (`.scopesoup/scopesoup-setup.mjs` in the repository).
- What to write, in full. Both are short, for example this machine's `<config folder>/scopesoup.config.json`:

```json
{
  "version": 1,
  "repoPath": "repo",
  "remote": "origin",
  "realPaths": ["C:/Work/shop"],
  "ownClone": "C:/Work/shop",
  "machineName": "laptop-a",
  "meta": { "authorName": "Sam Example", "authorEmail": "sam@example.invalid", "prefix": "A" }
}
```

  (with `"multiplayer": false` for singleplayer) and, on a new project only, the project's shared settings, written to its meta ref as one commit named after the person and pushed in multiplayer (Scope Soup reads them from there at once; the setup script goes on the branch `scopesoup/onboard` for the person to merge):

```json
{
  "project": "shop",
  "mainBranch": "main",
  "level": 0,
  "host": { "kind": "metaBranch", "write": true },
  "setupCommand": ["node", ".scopesoup/scopesoup-setup.mjs", "--from-clone", "{{ownClone}}"],
  "setupWatch": ["package-lock.json"]
}
```

- The import, when the backlog moves from GitHub Issues to Items (step 3b): the command in full, that it imports the open issues (and the closed ones only if asked), and what happens on GitHub in plain words (left as it is, labelled, or labelled and closed). The person's yes to the summary is the yes to that step on GitHub; it is never done without it.
- The first Items to write, when the person picked that optional step (step 3), by title.
- What the person does themselves: set `SCOPESOUP_GITHUB_TOKEN` for a github host, or for the import; `SCOPESOUP_JIRA_TOKEN` for a Jira host (the variable is named, its value never asked for).
- A recommendation, when the remote is on GitHub (only said, never done by you): protect the main branch in the repository's settings on GitHub (no force pushes, and required status checks if the project has CI). It is the one guard that holds on the remote whatever an agent CLI can or cannot refuse: a role on GitHub Copilot CLI cannot be refused a flag such as `--no-verify` or `--force`. The board shows one dismissable warning when a GitHub remote's main branch has no protection.
- On Windows, an optional shortcut (step 6c), offered as: "A Start menu shortcut 'Scope Soup – <project>' that starts Scope Soup and opens the board (also on the desktop? start at login?)". Say it needs no admin rights and no PATH change, goes in the person's own folders, and is removed by offboarding. Not offered elsewhere (`scopesoup open` still works there).
- Optional, only if the project has a `README.md` (offer nothing otherwise): "A short part at the end of README.md saying how to open the board (`scopesoup open`)" (step 6d). Say offboarding removes it again.
- Two optional steps, each only if the person picks it: the plugin in the project's `.claude/settings.json` (step 8), and the Scope Soup section in the project's `CLAUDE.md` (step 9).

Ask once: "Do all of this?" Change the plan if they correct it and ask again. Do nothing until a clear yes.

## 6. Do it, write and check

After the yes: make the folders and clones, download and unpack the release into HOME if needed (a release needs no `pnpm install`), and when `HOME/bin` has no launcher run

```
pnpm --silent --dir "SCOPESOUP" setup-home
```

It makes SCOPESOUP the current version (the file `HOME/current`, only when there is none) and writes `HOME/bin/scopesoup.cmd` and `HOME/bin/scopesoup`. It changes no setting of the machine: show the person what it printed about adding `HOME/bin` to their PATH, for them to do. Never change the PATH, the registry or a profile file yourself. Then confirm the prefix, write the install's path to `${CLAUDE_PLUGIN_DATA}/scopesoup-install.txt`, and do the optional steps picked. Write `scopesoup.config.json` in the config folder.

**Joining** (the project has `refs/scopesoup/meta`): run only

```
pnpm --silent --dir "SCOPESOUP" config:check "<absolute path to scopesoup.config.json>"
```

It fetches the meta ref into `repoPath` (a clone does not bring it) and checks this machine's file with the project's shared settings. Nothing is committed and nothing is pushed.

**A new project:** write the shared settings to `<config folder>/settings.json` (outside every repository) and, in `repoPath`, make the branch `scopesoup/onboard` from `<remote>/<mainBranch>` and write the setup script there (step 4c). Run:

```
pnpm --silent --dir "SCOPESOUP" config:check "<absolute path to scopesoup.config.json>" --shared "<config folder>/settings.json"
```

Once it is clean, write the shared settings to the meta ref, named after the person (their name as in `git config user.name`):

```
pnpm --silent --dir "SCOPESOUP" settings:init "<config folder>/settings.json" --as "<the person's name>" --config "<absolute path to scopesoup.config.json>"
```

If it says the project has shared settings already, a teammate was first: nothing was written; go on as for joining. Then delete `<config folder>/settings.json` (the meta ref holds them now; they are changed on the Settings page), commit the script in `repoPath` (`git add .scopesoup`, then `git commit -m "Scope Soup's setup of a fresh clone"`, with the person's own git identity) and push the branch: `git push <remote> scopesoup/onboard`. Note it on offboarding's record (the manifest beside the config file): `pnpm --silent --dir "SCOPESOUP" offboard record setup-script --config "<absolute path to scopesoup.config.json>"`. Tell the person to merge it the way the project's changes merge (a pull request, or a merge); until it is on the main branch a setup fails and says the script is missing.

`"version": 1` is the format of the private file. If there is no `settings:init`, the install is older than the shared settings on the meta ref: offer a newer one.

Exit code 1 lists each problem: fix what is plainly a mistake, ask about the rest, and run it again. Exit code 0: the file is valid; show any recommendations.

Once it is clean (joining or new), put the file on this machine's list of configs in HOME, so `scopesoup` commands run in the project's repository (the clone, a worktree of it, Scope Soup's clone) find it without `--config` or `SCOPESOUP_CONFIG`:

```
pnpm --silent --dir "SCOPESOUP" config:register "<absolute path to scopesoup.config.json>"
```

Offboarding takes it off the list again. If a later `scopesoup item list` in the project clone says more than one config is for the repository, tell the person which files it named; do not remove another project's entry yourself.

## 6b. The import (today GitHub Issues, from now on Items)

Only after `config:check` is clean and the shared settings are on the meta ref (`settings:init`, or a teammate's), and only when the summary had the import. With `SCOPESOUP_GITHUB_TOKEN` set in this session, run it from the install:

```
pnpm --silent --dir "SCOPESOUP" item import github --repo owner/name --config "<absolute path to scopesoup.config.json>" --on-github leave|label|close [--yes] [--closed N|all]
```

Add `--yes` only for `label` or `close` (it is the person's yes from the summary; the command refuses those without it when it cannot ask in a terminal). Show what it printed: which issue became which Item, and what was done on GitHub. If it says the Items are not on the remote yet, GitHub was left as it is: fix the push and run the same command again; nothing is imported twice, and a step on GitHub that stopped halfway is finished.

Without the token in this session, do not ask for it: give the person the same command without `--yes` to run in their own terminal, where it asks before it changes anything on GitHub.

When the person picked writing the first Items (step 3), file them now with `pnpm --silent --dir "SCOPESOUP" item new --title "..." --config "<absolute path to scopesoup.config.json>"`, one per Item shown in the summary.

## 6c. The shortcut (optional, Windows)

Only when the person picked it in the summary. Run, in the person's own clone (the folder the shortcut runs `scopesoup open` in), adding `--desktop` and/or `--startup` only for what they chose:

```
pnpm --silent --dir "SCOPESOUP" shortcut --name "<project>" --repo "<the person's clone>" --config "<absolute path to scopesoup.config.json>" [--desktop] [--startup]
```

It writes "Scope Soup – <project>" into the person's Start menu (and the desktop, and the Startup folder, when asked) and records each file on the manifest. If it says there is no launcher, run `setup-home` (step 6) first.

## 6d. The README part (optional)

Only when the person picked it in the summary and the project's clone has a `README.md` (never make one). Append `SCOPESOUP/plugins/scopesoup/readme-line.md` to it as it is, after a blank line. Never copy its text into this skill, read it from the project clone, or write a path into it. The person commits it. Then note it for offboarding: `pnpm --silent --dir "SCOPESOUP" offboard record readme-line --config "<absolute path to scopesoup.config.json>"`.

## 7. How to start Scope Soup

Do not start it unless asked. If the shortcut was made (step 6c), tell the person to click "Scope Soup – <project>" in the Start menu: it starts Scope Soup in the background if needed and opens the board (`scopesoup open` does the same from the project's repository). Otherwise, PowerShell:

```
$env:SCOPESOUP_CONFIG = "<config folder>\scopesoup.config.json"
$env:SCOPESOUP_DATA = "<config folder>\data"
& "HOME\bin\scopesoup.cmd" start
```

Git Bash: `SCOPESOUP_CONFIG=... SCOPESOUP_DATA=... "HOME/bin/scopesoup" start`. Add `SCOPESOUP_GITHUB_TOKEN` for a github host, `SCOPESOUP_JIRA_TOKEN` for a Jira host. The board is on http://127.0.0.1:4310. Start it with the launcher (`scopesoup start` once `HOME/bin` is on the PATH): the Settings page's Upgrade then restarts it on a new version by itself. It fills and nothing runs. The overview then says how many Items have no triage; for triages the person sets level 1 on the Settings page and presses Start agents.

## 8. Optional: suggest the plugin to teammates

Merge this into the project's `.claude/settings.json`; the person commits it.

```json
{
  "extraKnownMarketplaces": {
    "scopesoup": { "source": { "source": "github", "repo": "mikaeltulldahl/scopesoup" } }
  },
  "enabledPlugins": { "scopesoup@scopesoup": true }
}
```

Then note it for offboarding: `pnpm --silent --dir "SCOPESOUP" offboard record plugin-settings --config "<absolute path to scopesoup.config.json>"`.

## 9. Optional: the Scope Soup section for the project's CLAUDE.md

`SCOPESOUP/plugins/scopesoup/claude-md-section.md` lists the item commands for the project's Claude Code sessions. Never read it from the project clone, and do not copy its text into this skill. Append it to the project's `CLAUDE.md` (make the file if there is none) as it is: its commands say `scopesoup item ...`, the launcher, and never a path. Never write SCOPESOUP, HOME, a version or the Scope Soup checkout into it: the file is committed, and every upgrade and every other machine would make a path wrong. Say that each person's sessions need `HOME/bin` on their PATH (set by them) and their own config on the list (their own onboarding does `config:register`); no `SCOPESOUP_CONFIG` is needed. The person commits it. Then note it for offboarding: `pnpm --silent --dir "SCOPESOUP" offboard record claude-md --config "<absolute path to scopesoup.config.json>"`.
