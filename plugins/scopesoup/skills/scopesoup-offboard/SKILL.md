---
name: scopesoup-offboard
description: Stop using Scope Soup on the current project, safely. Says first that pausing is not leaving (Stop on the board, or level 0, can be undone), stops Scope Soup, shows everything Scope Soup left for the project grouped (work in progress, Items, on GitHub, in the project, on this machine) with what would happen to each and its default, asks one yes per group, then removes only what was chosen (exporting the Items to Markdown files first) and gives a short report. Never rewrites the project's history and never touches the person's own checkout. Use when the person asks to stop using, remove, uninstall or offboard Scope Soup from a project.
disable-model-invocation: true
argument-hint: "[path to this machine's scopesoup.config.json]"
---

# Offboard a project from Scope Soup

It must be easy, and feel safe, to try Scope Soup and decide not to use it. This skill finds what Scope Soup left for the project, shows it, asks, and only then removes what the person chose. Scope Soup's own command does the work: `pnpm offboard` in the Scope Soup install. It shows the plan by default and changes nothing; it removes only the groups named with `--remove`.

Ground rules:

- **Questions first, then act.** Nothing is removed before the person has seen the whole list and said yes for that group.
- **One yes per group.** Never take a yes for one group as a yes for another, and never remove an entry marked `[keep]` (it holds work: a branch not merged, an open pull request, a clone with changes not pushed) unless the person said so for that group's kept entries too.
- **The project's history is never rewritten**: merged commits, closed issues and pull requests, and comments stay.
- **The person's own checkout is never touched.** What onboarding added to the project's files is taken out as a patch the person reads and commits.
- Never print or repeat the content of a personal file (`.env`, local settings, credentials), or a token.

Three folders, named as in onboarding: the **project clone** (the person's own), the **Scope Soup install** (called **SCOPESOUP** below; read `${CLAUDE_PLUGIN_DATA}/scopesoup-install.txt`, or ask), and the **config folder** (where this machine's `scopesoup.config.json`, the manifest `scopesoup.manifest.jsonl` and usually the data folder are). `$ARGUMENTS`, or `SCOPESOUP_CONFIG`, or the config `scopesoup offboard` finds from the project clone (it prints the plan for it; the entry "on this machine's list of configs" names the file), or asking, gives the config file.

## 1. Pausing is not leaving

Say this before anything else: "If you want Scope Soup to stop working but keep everything, you do not need to offboard. Press Stop on the board (it ends running sessions and pauses agents and the merge queue), or set level 0 on the Settings page. Both can be undone: Start agents, or raise the level." Ask whether they want to pause, or leave. If they want to pause, stop here.

## 2. Stop Scope Soup

Ask the person to press Stop on the board, wait for running sessions to end, then end the Scope Soup program (Ctrl-C in its terminal). Offer to check that it is gone; never end a process yourself without a yes. `pnpm offboard --remove ...` refuses to act while a board answers on `SCOPESOUP_PORT` (default 4310). On a project shared with teammates, say that their machines use the same meta ref and branches: they should stop too, or the person keeps the Items and refs group.

## 3. Show everything, grouped

Run, from the install (it only reads):

```
pnpm --silent --dir "SCOPESOUP" offboard --config "<absolute path to scopesoup.config.json>"
```

With a GitHub host it reads GitHub's labels and open pull requests with `SCOPESOUP_GITHUB_TOKEN` when it is set in this session (check only whether it is set; never print it). Without it, the GitHub group says it could not be read: tell the person, and they can run the same commands in their own terminal with the token set.

Show the list in plain words, group by group, as the command printed it. Each entry has `[remove]` (goes on a yes for its group), `[keep]` (stays unless the person also says yes for that group's kept entries, with why it is kept), `[kept]` (only listed: never removed) or `[you]` (the person does it). The groups:

- **Work in progress** (`work`): `scopesoup/*` branches on the remote and in the clones, and open pull requests Scope Soup opened, including a batch pull request and its `scopesoup/batch-...` branch left after a failure. Merged branches are `[remove]`; anything not merged is `[keep]`.
- **Items** (`items`): `refs/scopesoup/meta` (the Items and the shared settings), `refs/scopesoup/merge-queue` (the merge queue lease), `refs/scopesoup/resources/*` (shared resources' leases). The Items are exported first, as Markdown files (`items/<id>.md`: the Item, then its log), with the shared settings; `refs/scopesoup/meta` is deleted only when the export worked. Exporting them as GitHub issues is not built: say so if asked, and that the Markdown files can be filed by hand.
- **On GitHub** (`github`): labels Scope Soup created (`scopesoup:*`, and `priority:*` only if Scope Soup made them; deleting a label takes it off every issue). `moved-to-scopesoup` is `[keep]`: it says which issues were imported into Items. Comments Scope Soup left are `[kept]`: they are history.
- **In the project** (`project`): the Scope Soup section of `CLAUDE.md`, the "Open the Scope Soup board" part of `README.md`, the plugin lines of `.claude/settings.json` and the setup script `.scopesoup/scopesoup-setup.mjs`, on the main branch. Removing them writes a patch (`scopesoup-offboard.patch`) for the person to read, apply in their checkout (`git apply`) and commit the way the project's changes merge.
- **On this machine** (`machine`): the config's entry on this machine's list of configs in Scope Soup's home (taken off, so commands in the project's repository no longer find it), the copies kept by format migrations (`scopesoup.config.v*.json`, `scopesoup.v*.sqlite`), the shortcuts onboarding made (Start menu, desktop, Startup folder: each a file on the manifest, deleted), Scope Soup's worktrees, the streams, the data folder, Scope Soup's clone, and the config folder last. Pool clones are the person's and are `[kept]`. The Scope Soup install and the plugin are `[you]`.

Then ask, in one message, one question per group that has something to remove: "Remove <group>? (yes / no)", and for a group with `[keep]` entries also "Remove its kept entries too: <list them>? (yes / no; no is the default)". Ask where the export should go only if the person wants another place than the folder the plan names (beside the config folder, so it outlives it). Do nothing until each group has a clear answer.

## 4. Act

With the groups that got a yes (`work`, `items`, `github`, `project`, `machine`) and those whose kept entries got a yes:

```
pnpm --silent --dir "SCOPESOUP" offboard --config "<absolute path to scopesoup.config.json>" --remove <groups> [--include-kept <groups>] [--out "<export folder>"]
```

It acts in the plan's order: work in progress, the Items (export first), GitHub, the project's patch, this machine (the config folder last). A step that fails is reported and does not stop the others, except that `refs/scopesoup/meta` is kept when the export failed.

## 5. A short report

Say, from what it printed (it is also in `report.txt` in the export folder): what was removed, what was kept and why, what failed and what to do about it, and where the export and the patch are. Then what is left for the person:

- Apply `scopesoup-offboard.patch` in their checkout and commit it, if the project group was removed.
- Delete the Scope Soup install folder, if no other project uses it.
- Uninstall the plugin: `/plugin uninstall scopesoup@scopesoup`.
