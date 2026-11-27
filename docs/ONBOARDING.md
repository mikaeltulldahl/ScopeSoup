# Onboarding a project

Onboarding changes nothing on a project's branches but one commit of its setup script (`.scopesoup/scopesoup-setup.mjs`), which the person merges the way the project's changes merge. The shared settings go on the meta ref (`refs/scopesoup/meta`), never on the main branch. Scope Soup starts at level 0, where it only shows the work, and the person raises the level one step at a time (decision 59, [`RULES.md`](RULES.md), "Levels").

## 1. The skill

The Claude Code skill `/scopesoup:scopesoup-onboard` (`plugins/scopesoup/skills/scopesoup-onboard`) runs in a session in the project ([`RUNNING.md`](RUNNING.md), "Onboarding with the Claude Code plugin", has the install). It asks three things:

1. Where the project's clone is.
2. The backlog, in two parts asked together: where it is today (GitHub Issues, another tracker, a text file, or nowhere yet), and where to keep it from now on (Scope Soup's own Items on the project's meta branch, GitHub Issues when the remote is on GitHub, or Jira; one question, three choices).
3. For Items only: this machine's prefix for new ids (it proposes the first free one).

On a new project it also asks singleplayer (nothing under `refs/scopesoup/*` is pushed) or multiplayer (shared through the remote; decision 93). A person joining is multiplayer.

The two parts of the backlog question decide what happens (decided):

- **Today GitHub Issues, from now on GitHub Issues**: Scope Soup reads the issues live. Nothing moves.
- **Today GitHub Issues, from now on Items**: the skill offers the one-time import ([`RUNNING.md`](RUNNING.md), "Importing from GitHub Issues"; decision 67) and asks what to do with the issues on GitHub: **leave** them, **label** them `moved-to-scopesoup`, or **close** them as not planned after labelling. The yes to the summary covers it; the import runs after the configuration is checked, as one meta commit.
- **Today nowhere or a text file, from now on Items**: Items start empty; the skill offers to write the first ones, or file them from the text.
- **From now on Jira** (any "today"): the skill asks the site (https only), project, deployment, Cloud email and optionally a filter and components, and builds and checks the host with `pnpm config:host jira` (as Settings' "Connect to Jira", decision 98). Nothing is imported or moved. The token comes only from `SCOPESOUP_JIRA_TOKEN`, never asked for or written (decision 101).
- **Today another tracker**: Items, GitHub Issues or Jira from now on, and the skill says that importing from that tracker is not supported yet.

Everything else it reads from the clone or proposes: the remote and main branch, `realPaths`, Scope Soup's own clone (`repoPath`), `machineName`, and a config folder outside any git repository.

It also proposes the setup of a fresh clone (decision 65; [`RUNNING.md`](RUNNING.md), "The setup of a fresh clone"), without a fourth question: from what it finds (lockfiles, `Makefile` targets, CI setup steps, and the ignored personal files in the person's clone, with `pnpm config:setup`) it proposes the steps, the personal files to copy and the files to watch, and the person confirms or corrects them in the summary. Secrets never go into the repository, a prompt or a log: the script copies only the files listed, from the person's clone, only to where git ignores them, and prints names only.

It shows one summary with the whole file and does nothing before one yes. Then it writes this machine's `scopesoup.config.json` in the config folder and checks it with the shared settings it proposes (`pnpm config:check --shared`) until both are clean. As the first person on the project it writes those shared settings (`level: 0`, the host, `setupCommand`, `setupWatch`) to the meta ref, one commit named after the person (`pnpm settings:init`). The setup script is committed in Scope Soup's own clone on a branch `scopesoup/onboard` and pushed, for the person to merge.

## Joining a project Scope Soup already runs

A person who joins runs the same skill in a session in their own clone. The shared settings are on the meta ref already, so the skill writes only that machine's private `scopesoup.config.json` and runs `pnpm config:check`, which fetches the meta ref and checks the file with the project's settings. Nothing is committed or pushed. The level and every other project setting are as the team set them; a change on the Settings page is in effect for everyone, and History says who made it.

Three optional steps, each only on the person's yes: the plugin in the project's `.claude/settings.json`, the Scope Soup section in the project's `CLAUDE.md`, and a short part at the end of the `README.md` saying how to open the board. The skill does not ask for a check command or the remote's URL: the Settings page asks when the level needs them.

## 2. Level 0: Watch

Scope Soup starts and the board fills. Nothing runs: no session, no write on its own. A person can still create and edit Items from the board when the host is writable.

## 3. Raising the level

On the Settings page the levels are five rows; a level whose needs are missing cannot be picked, and picking level 4 asks for the check command and the remote's URL right there ([`RUNNING.md`](RUNNING.md), "The Settings page and the sliders"). The level is a project setting, the same on every machine. After it is saved, the person presses Resume on the lanes ([`RUNNING.md`](RUNNING.md), "Start, Pause and Stop"); Scope Soup comes up paused after every start-up.

A typical order:

1. **Level 1.** Read the triages: answer the questions, accept, edit or reject the drafts and restructurings.
2. **Level 2 or 3.** Small Items first. At level 2 the implementor merges as the project's `CLAUDE.md` says; at level 3 a reviewer reads each change first.
3. **Level 4.** Scope Soup merges through its merge queue, on its own check command or the project's CI on GitHub.

Each level can be lowered again at any time. A step above the new level waits where it is.

## An existing project

- The existing backlog is not changed, unless the person imports it and picks label or close for the issues on GitHub. On GitHub Scope Soup adds its own labels and comments to the issues it works on ([`github-mapping.md`](github-mapping.md)).
- Existing habits are read, not replaced: labels, branch names and CI stay as they are. How a session works is what the project's `CLAUDE.md` says.
- The first Items at level 2 should be small, so the first evidence is cheap.

## An empty project

There is nothing to read, so the first Items are the skeleton: the repository layout, a check that passes, a `CLAUDE.md` that says how to work. Until there is a check, level 4 cannot be picked and nothing merges through Scope Soup.

## Offboarding

Everything Scope Soup adds is a file or state that reads without Scope Soup: a configuration file outside the repository, the shared settings and Items on the meta ref (or issues, labels and comments on GitHub), merged commits. Offboarding (decision 75) lists and removes what Scope Soup left, so trying Scope Soup and deciding against it is easy and safe.

**Pausing is not leaving.** Stop on the board, or level 0, stops Scope Soup's work and keeps everything; Resume, or a higher level, undoes it.

**A record from the start.** Onboarding, and Scope Soup while it runs, append to a manifest in the config folder (`scopesoup.manifest.jsonl`) what they made or changed outside it. Offboarding works from it and from Scope Soup's own names (`refs/scopesoup/*`, `scopesoup/*` branches, its labels, the `.v*` copies); nothing else of the person's is listed.

**Leaving** is the skill `/scopesoup:scopesoup-offboard`, or `pnpm offboard` ([`RUNNING.md`](RUNNING.md), "Offboarding"). The Settings page's "Stop using Scope Soup" shows the same list, read only. The skill has Scope Soup stopped, shows everything in five groups with what would happen to each, asks one yes per group, then acts and reports:

- **Work in progress:** `scopesoup/*` branches on the remote and in the clones, open pull requests Scope Soup opened (a batch's pull request and `scopesoup/batch-...` branch left after a failure among them). Anything not merged is kept unless the person says so for that group's kept entries too.
- **Items:** exported first as Markdown files (one per Item, with its log) and the shared settings; then `refs/scopesoup/meta`, `refs/scopesoup/merge-queue` and `refs/scopesoup/resources/*` are deleted on the remote. Exporting as GitHub issues is not built.
- **On GitHub:** the labels Scope Soup created. Its comments stay: they are history.
- **In the project:** the CLAUDE.md section, the README part, the plugin lines and the setup script, taken out as a patch the person applies and commits. Their checkout is not touched.
- **On this machine:** the `.v*` copies, worktrees, streams, data folder, Scope Soup's clone, and the config folder last. Pool clones are the person's and stay. The installation and the plugin (`/plugin uninstall scopesoup@scopesoup`) are the person's to remove.

The project's history (merged commits, closed issues and pull requests, comments) is never rewritten.
