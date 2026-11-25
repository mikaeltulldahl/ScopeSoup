# Onboarding a project

Onboarding puts a project under Scope Soup changing nothing on its branches but one commit of its setup script (`.scopesoup/scopesoup-setup.mjs`), which the person merges the way the project's changes merge. The project's shared settings go on its meta ref (`refs/scopesoup/meta`), beside the main branch, never on it. Scope Soup starts at level 0, where it only shows the work, and the person raises the level one step at a time when they want it to do more (decision 59, `docs/RULES.md`, "Levels").

## 1. The skill

The Claude Code skill `/scopesoup:scopesoup-onboard` (`plugins/scopesoup/skills/scopesoup-onboard`) runs in a session in the project. `docs/RUNNING.md`, "Onboarding with the Claude Code plugin", says how to install it. It asks three things:

1. Where the project's clone is.
2. The backlog, in two parts asked together: where it is today (GitHub Issues, another tracker, a text file, or nowhere yet), and where to keep it from now on (Scope Soup's own Items on the project's meta branch, or GitHub Issues when the remote is on GitHub).
3. For Items only: this machine's prefix for new ids (it proposes the first free one).

On a new project the backlog question also asks singleplayer or multiplayer (decision 93). Singleplayer is for a project you play alone: Scope Soup pushes nothing under `refs/scopesoup/*` (Items and shared settings, the merge queue lease, images stay in this clone), while work branches and merges go to the remote as ever. Multiplayer, today's way, shares them. It is this machine's `multiplayer` in its private file; a person joining is multiplayer. The Settings page switches it ("Players").

The two parts of the backlog question decide what happens (decided):

- **Today GitHub Issues, from now on GitHub Issues**: Scope Soup reads the issues live. Nothing moves.
- **Today GitHub Issues, from now on Items**: the skill offers the one-time import (decision 67, `docs/RUNNING.md`, "Importing from GitHub Issues"): every open issue becomes an Item with its labels, priority, parent, blockers and last 3 comments; pull requests and closed issues are left out. The import only reads GitHub. The backlog question then has one more part, what to do with the issues on GitHub: **leave** them (GitHub is not changed), **label** them `moved-to-scopesoup` with a comment naming the Item, or **close** them as not planned after labelling. The yes to the summary covers it; the import runs after the configuration is checked, and can be read and undone as one meta commit.
- **Today nowhere or a text file, from now on Items**: Items start empty; the skill offers to write the first ones, or file them from the text.
- **Today another tracker**: Items or GitHub Issues from now on, and the skill says that importing from that tracker is not supported yet.

Everything else it reads from the clone or proposes: the remote and main branch, `realPaths` (the person's own clone), Scope Soup's own clone (`repoPath`), `machineName`, and a config folder outside any git repository.

It also proposes the setup of a fresh clone (decision 65), without a fourth question: Scope Soup's worktrees and clones lack what the person's checkout has (installed dependencies, generated files, submodules, a `.env` with test settings). From what it finds (lockfiles, `requirements*.txt`, `Makefile` targets, CI setup steps, the README, and the ignored personal files in the person's clone, with `pnpm config:setup`) it proposes the steps, the personal files to copy and the files to watch, and the person confirms or corrects them in the summary. Nothing is copied blindly, and secrets never go into the repository, a prompt or a log: the script copies only the files listed, from the person's clone (`--from-clone`), only to where git ignores them, and prints names only.

It shows one summary with the whole file and does nothing before one yes. Then it writes this machine's `scopesoup.config.json` in the config folder (its name, where the clones are, a few lines), and checks it with the shared settings it proposes (`pnpm config:check --shared`) until both are clean. As the first person on the project it writes those shared settings (`level: 0`, the host, `setupCommand`, `setupWatch`) to the meta ref, one commit named after the person, pushed in multiplayer (`pnpm settings:init`): Scope Soup reads them from there at once. The setup script `.scopesoup/scopesoup-setup.mjs` is code that runs, so it goes into the repository: committed in Scope Soup's own clone on a branch `scopesoup/onboard` and pushed, for the person to merge the way the project's changes merge. The Settings page shows the setup afterwards and lets the person edit it.

## Joining a project Scope Soup already runs

A person who joins a project that a teammate already runs with Scope Soup runs the same skill on their own machine, in a session in their clone of the project. The project's shared settings are on its meta ref already, so the skill writes only that machine's private `scopesoup.config.json` (its name, where the clones are, for Items the person's name, email and own prefix, what the machine may spend). It runs `pnpm config:check`, which fetches the meta ref and checks the private file with the project's settings. Nothing is committed and nothing is pushed: `pnpm settings:init` refuses when the settings exist, and says the person is joining. The level and every other project setting are as the team set them; a change on the Settings page is in effect for everyone, and History says who made it.

Two optional steps, each only on the person's yes: the plugin in the project's `.claude/settings.json`, for teammates, and the Scope Soup section in the project's `CLAUDE.md`. That section lists the item commands and sets no rules for sessions.

The skill does not ask for a check command, the remote's URL or anything else a higher level needs. The Settings page asks for those when the level is picked.

## 2. Level 0: Watch

Scope Soup starts and the board fills. Nothing runs: no session, no write on its own. A person can still create and edit Items from the board when the host is writable. When there are ready Items without a triage, the overview says so: "N Items have no triage: set level 1 and press Resume on the Backlog."

## 3. Raising the level

On the Settings page the levels are five rows, each with one sentence of what Scope Soup does and what it needs. A level whose needs are missing is shown but cannot be picked, with what is missing. Picking level 4 asks for the check command and the remote's URL right there: "What command decides a change is OK — the one you would want green before anything merges?", with the candidates Scope Soup found in the repository (`package.json` scripts, CI workflow files, `Makefile` targets) to pick from. It runs in a fresh clone after the setup.

The level is a project setting, the same on every machine: saving it is one commit on the meta ref, named after the person picked at the top of the board, in effect at once here and on the other machines at their next fetch. After a level is saved, the person presses Resume on the lanes: triage on Backlog, from level 2 implementors on In progress, from level 3 review on In review, at level 4 the merge queue on Merge queue. Scope Soup comes up paused after every start-up, so they are resumed again after a restart (an upgrade from the board restores them itself).

A typical order:

1. **Level 1.** Read the triages: answer the questions, accept, edit or reject the drafts and splits.
2. **Level 2 or 3.** Small Items first. At level 2 the implementor merges as the project's `CLAUDE.md` says; at level 3 a reviewer reads each change first.
3. **Level 4.** Scope Soup merges through its merge queue, on its own check command or the project's CI on GitHub.

Each level can be lowered again at any time. A step above the new level waits where it is.

## An existing project

- The existing backlog is not changed, unless the person imports it from GitHub Issues into Items and picks label or close for the issues on GitHub. At level 1 and up, Scope Soup picks from the whole backlog in order. On GitHub it adds its own labels and comments to the issues it works on (`docs/github-mapping.md`).
- Existing habits are read, not replaced: labels, branch names and CI stay as they are. How a session works (tests, commit messages, merge or pull request) is what the project's `CLAUDE.md` says.
- The first Items at level 2 should be small, so the first evidence is cheap.

## An empty project

There is nothing to read, so the first Items are the skeleton: the repository layout, a check that passes, a `CLAUDE.md` that says how to work. Until there is a check, level 4 cannot be picked and nothing merges through Scope Soup.

## Offboarding

Everything Scope Soup adds is a file or state that reads without Scope Soup: a configuration file outside the repository, the shared settings and Items on the meta ref (or issues, labels and comments on GitHub), merged commits. Offboarding (decision 75) lists and removes what Scope Soup left, so trying Scope Soup and deciding against it is easy and safe.

**Pausing is not leaving.** Stop on the board (it ends running sessions and pauses triage, implementors, review and the merge queue), or level 0, stops Scope Soup's work and keeps everything; Resume on the lanes, or a higher level, undoes it. Nothing below is needed for that.

**A record from the start.** Onboarding, and Scope Soup while it runs, append to a manifest in the config folder (`scopesoup.manifest.jsonl`) what they made or changed outside it: Scope Soup's clone and folders, the meta ref, the `scopesoup/onboard` branch, the setup script, the CLAUDE.md section, the plugin lines and the labels Scope Soup created on GitHub. Offboarding works from it and from Scope Soup's own names (`refs/scopesoup/*`, `scopesoup/*` branches, its labels, the `.v*` copies); nothing else of the person's is listed.

**Leaving** is the skill `/scopesoup:scopesoup-offboard` (`plugins/scopesoup/skills/scopesoup-offboard`), or `pnpm offboard` in Scope Soup's folder (`docs/RUNNING.md`, "Offboarding"). The Settings page's "Stop using Scope Soup" shows the same list, read only, with Stop. The skill says pausing is not leaving, has Scope Soup stopped, shows everything in five groups with what would happen to each, asks one yes per group, then acts and reports:

- **Work in progress:** `scopesoup/*` branches on the remote and in the clones, open pull requests Scope Soup opened (a batch's pull request and `scopesoup/batch-...` branch left after a failure among them). Anything not merged is kept unless the person says so for that group's kept entries too.
- **Items:** exported first as Markdown files (one per Item, with its log) and the shared settings; then `refs/scopesoup/meta`, `refs/scopesoup/merge-queue` and `refs/scopesoup/resources/*` are deleted on the remote. Exporting as GitHub issues is not built.
- **On GitHub:** the labels Scope Soup created. Its comments stay: they are history.
- **In the project:** the CLAUDE.md section, the plugin lines and the setup script, taken out as a patch the person applies and commits. Their checkout is not touched.
- **On this machine:** the `.v*` copies, worktrees, streams, data folder, Scope Soup's clone, and the config folder last. Pool clones are the person's and stay. The installation and the plugin (`/plugin uninstall scopesoup@scopesoup`) are the person's to remove.

The project's history (merged commits, closed issues and pull requests, comments) is never rewritten.
