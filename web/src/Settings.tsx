// The Settings page: the level first, as five rows with what each does and needs; then parallel sessions, the
// usage reserve (from level 1), the age after which a triage is taken again (from level 2) and the model of each role. Everything else is file-only, with its defaults.
// Everything saves when it is changed (a text field when it is left, a slider when it rests), one save at a time, with a short
// "Saved" or the reason beside the control (#157). Picking level 4 while the file lacks its check command or remote URL asks for
// them right there, proposed by the server; the level is saved once they are filled in.
// The project's settings (level, check, setup, models, the triage's age) are shared by every machine: a save is
// one commit on the meta ref, named after the person picked at the top of the board, and in effect at once (on the other
// machines at their next fetch). Singleplayer or multiplayer, parallel sessions, the usage reserve and the remote's URL are this
// machine's own. The page shows
// the two as one: no key is in both.
// The limited resources: a shared one is a project setting (`sharedResources`), the others this machine's (`resources`).
// Where the Items are (the host) is a project setting too, changed only through the connect dialogs (Connect.tsx); a Jira host's
// filter and the components of new Items are edited here, and a filter that adds Items asks to confirm first (#141).

import { ThemePicker } from "./ThemePicker.tsx";
import { useEffect, useRef, useState } from "preact/hooks";
import { VersionPanel } from "./Version.tsx";
import { SettingsHistory } from "./SettingsHistory.tsx";
import type { ConfigView, ProjectConfig, ProjectView } from "./api.ts";
import { FolderButton } from "./ProjectHeader.tsx";
import type { AskedField } from "../../src/config/levels.ts";
import type { Sliders } from "../../src/config/sliders.ts";
import { commandText, commandWords } from "../../src/config/commandLine.ts";
import { fetchConfig, FilterWidens, PlayersDiffer, postConfig } from "./api.ts";
import { EFFORT_LEVELS } from "../../src/config/types.ts";
import { commandChange, keepDaysChange, levelFourFilled, pendingFourText, resourcesReady, serialQueue, wholeNumber } from "./settingsSave.ts";
import { ConnectDialog, type DialogKind, HOST_NAMES } from "./Connect.tsx";

const ONBOARDING = "https://github.com/mikaeltulldahl/scopesoup/blob/main/docs/ONBOARDING.md";

/** The settings the page shows, besides the level. */
const SETTINGS = ["maxParallelSessions", "budgetReserve", "triageMaxAgeDays"] as const;
type SettingName = (typeof SETTINGS)[number];

/** What a role set to the Copilot provider is told (`COPILOT_WARNING` in src/orchestrator/providers/copilot/command.ts; the board reads no server code). */
const COPILOT_WARNING = "Copilot's rules name a program and its first word only (such as git push), never a flag. So --no-verify and --force cannot be refused on Copilot: this role may use them on any git command it may run, and only its prompt says not to. Protect the main branch on the remote (no force push) to be safe.";

/** Singleplayer or multiplayer, as the page names them (decision 93). */
const PLAYERS: [boolean, string, string][] = [
  [false, "Singleplayer", "Scope Soup stays on this machine: nothing under refs/scopesoup/ is pushed."],
  [true, "Multiplayer", "Several machines share the Items, the merge queue and (if on) images through the remote."],
];

/** The three roles, as the page names them. */
const ROLES: [string, string][] = [
  ["triage", "Triage"],
  ["implement", "Implement"],
  ["review", "Review"],
];

/** What each budget reserve position keeps for people's own use, in percent. The table comes from the server. */
function budgetReserveText(position: number, table: Sliders["budgetReserve"]): string {
  const { fiveHour, sevenDay } = table[Math.min(table.length, Math.max(1, Math.round(position))) - 1] ?? { fiveHour: 0.2, sevenDay: 0.2 };
  return `keeps ${Math.round(fiveHour * 100)}% of the 5-hour window and ${Math.round(sevenDay * 100)}% of the week for you; Scope Soup starts nothing past it`;
}

/** What the page may change, as the form holds it. */
interface Draft {
  level: number;
  settings: Record<SettingName, string>;
  roles: Record<string, { model: string; effort: string }>;
  /** What level 4 asks for, as text: the check command as one line, the remote's URL. */
  mergeQueue: Record<AskedField, string>;
  /** The setup of a fresh clone: the command as one line, the watched files one per line ("" for none in the file). */
  setup: { command: string; watch: string };
  /** The limited resources, as the form holds them. */
  resources: ResourceDraft[];
  /** Agents' images: pushed to the remote or not, and the days a closed Item's are kept ("" keeps them). */
  media: { push: boolean; keepDays: string };
  /** Multiplayer (refs/scopesoup/* shared on the remote) or singleplayer (they stay in this clone): this machine's. */
  multiplayer: boolean;
  /** What a reviewer's `should` findings on an approved change do (decision 95). */
  shouldFindings: "fix" | "draft";
  /** The label on Items an AI made or rewrote ("" for none). */
  aiLabel: string;
  /** A Jira host's filter ("" for none) and the components of new Items, comma separated. */
  jira: { filter: string; components: string };
}

/** One resource in the form: the units as typed, the environment one `NAME=value` per line. */
interface ResourceDraft {
  name: string;
  units: string;
  shared: boolean;
  neededBy: string[];
  env: string;
}

/** What may need a resource, as the page names it. */
const RESOURCE_USERS: [string, string][] = [...ROLES, ["check", "Check"]];

function resourceDrafts(config: ProjectConfig): ResourceDraft[] {
  return (config.resources ?? []).map((each) => ({
    name: each.name, units: String(each.units), shared: each.shared, neededBy: [...each.neededBy],
    env: Object.entries(each.env).map(([name, value]) => `${name}=${value}`).join("\n"),
  }));
}

/** The draft's resources as the files hold them: this machine's (`resources`) and the shared ones (`sharedResources`). */
function resourceLists(drafts: readonly ResourceDraft[]): { resources: unknown[]; sharedResources: unknown[] } {
  const out = { resources: [] as unknown[], sharedResources: [] as unknown[] };
  for (const draft of drafts) {
    const env: Record<string, string> = {};
    for (const line of draft.env.split("\n")) {
      const at = line.indexOf("=");
      if (line.trim() === "") continue;
      if (at < 1) env[line.trim()] = "";
      else env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const entry = { name: draft.name.trim(), units: Number(draft.units), neededBy: draft.neededBy, ...(Object.keys(env).length > 0 ? { env } : {}) };
    (draft.shared ? out.sharedResources : out.resources).push(entry);
  }
  return out;
}

/** The roles whose model the file itself sets; the others run on their default model. */
function pinnedRoles(raw: unknown): Set<string> {
  const roles = (raw as { roles?: Record<string, { model?: unknown }> } | null)?.roles;
  return new Set(Object.entries(roles ?? {}).filter(([, role]) => typeof role?.model === "string").map(([name]) => name));
}

/** A role's model in the draft: its own when the file sets it, "" when the role runs on its default. */
function draftOf(config: ProjectConfig, raw: unknown, mergeQueue: { remoteUrl?: string | null } | null | undefined): Draft {
  const setting = (name: SettingName) => String(config.settings[name].value);
  const roles: Draft["roles"] = {};
  const pinned = pinnedRoles(raw);
  for (const [name] of ROLES) roles[name] = { model: pinned.has(name) ? (config.roles as Record<string, { model: string } | undefined>)[name]?.model ?? "" : "", effort: (config.roles as Record<string, { effort?: string } | undefined>)[name]?.effort ?? "" };
  // The check command as the file holds it (what Settings proposes is a placeholder, and fills the field only when level 4 is picked).
  const asked = { checkCommand: config.checkCommand ? commandText(config.checkCommand) : "", remoteUrl: mergeQueue?.remoteUrl ?? "" };
  // The command as the shared file holds it, with {{ownClone}} unexpanded (the configuration in use has this machine's path in it).
  const command = (raw as { setupCommand?: unknown } | null)?.setupCommand;
  const setup = { command: Array.isArray(command) ? commandText(command as string[]) : config.setupCommand ? commandText(config.setupCommand) : "", watch: (config.setupWatch ?? []).join("\n") };
  return { level: config.level, settings: { maxParallelSessions: setting("maxParallelSessions"), budgetReserve: setting("budgetReserve"), triageMaxAgeDays: setting("triageMaxAgeDays") }, roles, mergeQueue: asked, setup, resources: resourceDrafts(config), media: { push: config.media?.push ?? false, keepDays: config.media?.keepDaysAfterClose === null || config.media?.keepDaysAfterClose === undefined ? "" : String(config.media.keepDaysAfterClose) }, multiplayer: config.multiplayer, shouldFindings: config.review?.shouldFindings ?? "fix", aiLabel: config.labels?.aiGenerated || "", jira: { filter: config.host?.kind === "jira" ? config.host.filter ?? "" : "", components: config.host?.kind === "jira" ? (config.host.components ?? []).join(", ") : "" } };
}

/** Component names as typed: comma separated, blanks dropped. */
function componentList(text: string): string[] {
  return text.split(",").map((name) => name.trim()).filter((name) => name !== "");
}

/** The watched files as the file holds them: one per line, blank lines dropped. */
function watchLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}

/** The project's folders, each opened in the file manager by the server: your checkout, Scope Soup's clone, the configuration's folder. */
function Folders({ project }: { project: ProjectView | undefined }) {
  const [problem, setProblem] = useState<string | null>(null);
  if (!project || project.folders.length === 0) return null;
  return (
    <div class="settings-folders">
      <span class="muted">Open in the file manager:</span>
      {project.folders.map((folder) => <FolderButton key={folder} folder={folder} onError={setProblem} />)}
      {problem && <p class="notice notice-bad" role="alert">{problem}</p>}
    </div>
  );
}


/** One control's answer to a save, shown next to it: "Saved" (fades) or the reason it was refused. */
interface Mark {
  text: string;
  bad: boolean;
}

/** A save: what to send, the control it came from, and what the control goes back to when the server refuses it. */
interface Saving {
  key: string;
  change: Record<string, unknown>;
  /** The draft's part to restore from the configuration in use when refused (a pick); a text field keeps what was typed. */
  undo?: (base: Draft) => Partial<Draft>;
}

/** The delay of a slider's save: one save when the thumb has rested, not one per step. */
const SLIDER_DELAY_MS = 500;
const SAVED_SHOWN_MS = 2500;

export function Settings({ project, openHistory = false }: { project?: ProjectView | undefined; openHistory?: boolean } = {}) {
  const [view, setView] = useState<ConfigView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const baseRef = useRef<Draft | null>(null);
  // Each control's answer, by its key; "Saved" fades after a moment, a reason stays until the next save of that control.
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  // What a switch of Players did, shown until the page is left; what connecting to a host did.
  const [playersNote, setPlayersNote] = useState<string | null>(null);
  const [hostNote, setHostNote] = useState<string | null>(null);
  // The connect dialog open, if one is (#127).
  const [connecting, setConnecting] = useState<DialogKind | null>(null);
  // A switch to multiplayer refused because the remote's shared settings name another project or host: both sides, and the change.
  const [players, setPlayers] = useState<(PlayersDiffer["players"] & { change: Record<string, unknown> }) | null>(null);
  // A new Jira filter that adds Items, waiting for the person's yes: what it adds and removes, and the change (#141).
  const [widens, setWidens] = useState<(FilterWidens["filter"] & { change: Record<string, unknown> }) | null>(null);
  const queue = useRef(serialQueue());
  const timers = useRef<Record<string, number>>({});
  const lastSent = useRef<Record<string, string>>({});

  const show = (next: ConfigView) => {
    setView(next);
    const fresh = next.present && next.config ? draftOf(next.config, next.raw, next.mergeQueue) : null;
    draftRef.current = fresh;
    setDraft(fresh);
  };
  useEffect(() => {
    fetchConfig().then(show, (problem: unknown) => setLoadError(problem instanceof Error ? problem.message : String(problem)));
    return () => Object.values(timers.current).forEach((timer) => window.clearTimeout(timer));
  }, []);

  const mark = (key: string, next: Mark | null) => {
    setMarks((all) => {
      const { [key]: _gone, ...rest } = all;
      return next ? { ...rest, [key]: next } : rest;
    });
    window.clearTimeout(timers.current[`mark:${key}`]);
    if (next && !next.bad) timers.current[`mark:${key}`] = window.setTimeout(() => setMarks((all) => { const { [key]: _gone, ...rest } = all; return rest; }), SAVED_SHOWN_MS);
  };
  /** The draft's changes, at once (the render after may be later than the next event). */
  const update = (patch: Partial<Draft>) => {
    const next = { ...(draftRef.current as Draft), ...patch };
    draftRef.current = next;
    setDraft(next);
  };

  if (loadError) return <p class="notice notice-bad" role="alert">{loadError}</p>;
  if (!view) return <p class="empty">Loading…</p>;
  if (!view.present) {
    return (
      <div class="settings">
        <ThemePicker />
        <VersionPanel />
        <section class="panel">
          <h3>Settings</h3>
          <p>
            There is no project configuration: Scope Soup runs as a board only, and the orchestrator is off. Make this machine's <code>scopesoup.config.json</code> with the onboarding skill (on a new project it writes the project's shared settings too)
            {" "}(<a class="tag-link" href={ONBOARDING} target="_blank" rel="noreferrer">how to onboard a project</a>), then start Scope Soup again.
          </p>
        </section>
      </div>
    );
  }
  if (!view.config || !draft) {
    return (
      <>
      <ThemePicker />
      <section class="panel">
        <h3>Settings</h3>
        <p>The configuration is not valid, so it cannot be changed here. Fix it in <code>{view.file}</code>, or in the project's shared settings (<code>settings/settings.json</code> on <code>refs/scopesoup/meta</code>):</p>
        <ul class="settings-errors">{view.errors.map((each) => <li key={each}>{each}</li>)}</ul>
      </section>
      </>
    );
  }

  const base = draftOf(view.config, view.raw, view.mergeQueue);
  baseRef.current = base;
  const hostKind = view.config.host?.kind;
  const pinned = pinnedRoles(view.raw);
  const defaultModels: Readonly<Record<string, string | undefined>> = view.defaultModels ?? {};
  const levels = view.levels ?? [];
  const mergeQueue = view.mergeQueue ?? null;
  const fourAsks: readonly AskedField[] = levels[4]?.asks ?? [];
  // Level 4 picked but not saved yet: its fields are open, and the old level stays in effect until they are filled in.
  const pendingFour = draft.level === 4 && base.level !== 4 && fourAsks.length > 0;
  const asks = pendingFour ? fourAsks : [];
  // With the project's own check command (not mergeQueue.ci "github") there is a check command to show and to change.
  const hasCheck = mergeQueue !== null && (view.config.mergeQueue?.ci ?? "local") === "local";
  const inLevels = pendingFour || (base.level === 4 && hasCheck);

  /** Sends a save after the ones before it; its answer goes next to the control it came from. */
  const submit = ({ key, change, undo }: Saving, after?: (next: ConfigView) => void) => {
    const text = JSON.stringify(change);
    if (lastSent.current[key] === text) return;
    lastSent.current[key] = text;
    mark(key, null);
    void queue.current(() => postConfig(change)).then(
      (next) => {
        setView(next);
        if (next.playersNote) setPlayersNote(next.playersNote);
        mark(key, { text: next.shared && /not on the remote yet/.test(next.shared) ? next.shared : "Saved", bad: false });
        after?.(next);
      },
      (problem: unknown) => {
        delete lastSent.current[key];
        // A switch to multiplayer whose remote names another project or host waits for the person's choice.
        if (problem instanceof PlayersDiffer) setPlayers({ ...problem.players, change });
        else if (problem instanceof FilterWidens) setWidens({ ...problem.filter, change });
        else mark(key, { text: problem instanceof Error ? problem.message : String(problem), bad: true });
        if (undo && baseRef.current) update(undo(baseRef.current));
      },
    );
  };
  /** A slider: the draft follows the thumb, and one save follows when it has rested. */
  const slide = (key: string, patch: Partial<Draft>, saving: Saving) => {
    update(patch);
    window.clearTimeout(timers.current[key]);
    timers.current[key] = window.setTimeout(() => submit(saving), SLIDER_DELAY_MS);
  };
  /** A text field saves when it is left, or on Enter (which leaves it). */
  const leave = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") (event.target as HTMLInputElement).blur();
  };
  const Marked = ({ k }: { k: string }) => {
    const each = marks[k];
    return each ? <span class={`saved-mark${each.bad ? " saved-bad" : ""}`} role={each.bad ? "alert" : "status"}>{each.text}</span> : null;
  };

  const setSettingNow = (name: SettingName, text: string, min: number, max: number) => {
    const number = wholeNumber(text, min, max);
    if (!number.ok) return void mark(name, { text: number.reason, bad: true });
    if (String(number.value) === base.settings[name]) return void mark(name, null);
    submit({ key: name, change: { settings: { [name]: { value: number.value } } }, undo: (b) => ({ settings: { ...draftRef.current!.settings, [name]: b.settings[name] } }) });
  };
  const setSetting = (name: SettingName, value: string) => update({ settings: { ...draftRef.current!.settings, [name]: value } });
  const setAsked = (name: AskedField, value: string) => update({ mergeQueue: { ...draftRef.current!.mergeQueue, [name]: value } });
  const sliderSetting = (name: SettingName, value: string) => {
    const current = draftRef.current!;
    slide(name, { settings: { ...current.settings, [name]: value } }, { key: name, change: { settings: { [name]: { value: Number(value) } } } });
  };

  const pickLevel = (level: number) => {
    // Level 4 with a need missing opens its fields; it is saved once they are filled in.
    if (level === 4 && fourAsks.length > 0) {
      const current = draftRef.current!;
      const proposed = mergeQueue?.checkCommand ? commandText(mergeQueue.checkCommand) : "";
      update({ level, mergeQueue: { ...current.mergeQueue, checkCommand: current.mergeQueue.checkCommand || proposed } });
      return;
    }
    update({ level });
    submit({ key: "level", change: { level }, undo: (b) => ({ level: b.level }) });
  };
  /** The check command as typed: below level 4 it saves (emptied, it is removed); level 4 refuses it emptied, with the reason. */
  const commitCheck = () => {
    const text = draftRef.current!.mergeQueue.checkCommand;
    if (pendingFour) return void commitLevelFour();
    if (text.trim() === base.mergeQueue.checkCommand.trim()) return void mark("check", null);
    submit({ key: "check", change: { checkCommand: commandChange(text) } });
  };
  const commitLevelFour = () => {
    const current = draftRef.current!;
    const fields = { checkCommand: current.mergeQueue.checkCommand, remoteUrl: current.mergeQueue.remoteUrl };
    if (!levelFourFilled(fourAsks, fields)) return;
    const change: Record<string, unknown> = { level: 4 };
    if (fourAsks.includes("checkCommand") || fields.checkCommand.trim() !== base.mergeQueue.checkCommand.trim()) change.checkCommand = commandChange(fields.checkCommand);
    if (fourAsks.includes("remoteUrl")) change.remoteUrl = fields.remoteUrl.trim();
    submit({ key: "level", change });
  };
  const pickCandidate = (text: string) => {
    setAsked("checkCommand", text);
    if (pendingFour) commitLevelFour();
    else if (text.trim() !== base.mergeQueue.checkCommand.trim()) submit({ key: "check", change: { checkCommand: commandChange(text) } });
  };

  const saveMedia = (patch: Partial<Draft["media"]>) => {
    const media = { ...draftRef.current!.media, ...patch };
    update({ media });
    const days = keepDaysChange(media.keepDays);
    if (!days.ok) return void mark("keepDays", { text: days.reason, bad: true });
    submit({ key: patch.push !== undefined ? "push" : "keepDays", change: { media: { push: media.push, keepDaysAfterClose: days.value } }, undo: (b) => ({ media: b.media }) });
  };
  const saveResources = (resources: ResourceDraft[], key: string) => {
    update({ resources });
    if (!resourcesReady(resources)) return void mark(key, { text: "Each resource needs a name and units from 1 to 64.", bad: true });
    const lists = resourceLists(resources);
    const before = resourceLists(base.resources);
    const change: Record<string, unknown> = {};
    for (const each of ["resources", "sharedResources"] as const) {
      if (JSON.stringify(lists[each]) !== JSON.stringify(before[each])) change[each] = lists[each].length === 0 ? null : lists[each];
    }
    if (Object.keys(change).length === 0) return void mark(key, null);
    submit({ key, change });
  };
  const saveRole = (name: string, patch: { model?: string | null; effort?: string }) => {
    submit({ key: `role:${name}:${Object.keys(patch)[0]}`, change: { roles: { [name]: patch } } });
  };
  const saveHost = (patch: { filter?: string | null; components?: string[] | null }) => {
    submit({ key: `jira:${Object.keys(patch)[0]}`, change: { host: patch } });
  };

  return (
    <div class="settings">
      <ThemePicker />
      <VersionPanel />
      <form class="panel item-form settings-form" onSubmit={(event) => event.preventDefault()}>
        <div class="panel-head">
          <h3>Settings</h3>
          <a class="tag-link settings-stop-link" href="#/settings/stop">Stop using Scope Soup</a>
        </div>
        <Folders project={project} />
        <p class="muted">
          Changes save as they are made (a text field when you leave it). The project's settings (the level, the check, the setup, the models, the triage's age) are the same on every machine: they take effect at once, here and on the other machines at their next fetch, and History says who changed what.
          {" "}Singleplayer or multiplayer, parallel sessions, the usage reserve and the remote's URL are this machine's own. Everything not on this page is set by hand.
        </p>

        <fieldset class="levels">
          <legend><b>Players</b>: this machine's choice <Marked k="players" /></legend>
          {PLAYERS.map(([multiplayer, name, text]) => (
            <label key={name} class={`level-row${draft.multiplayer === multiplayer ? " level-on" : ""}`}>
              <input type="radio" name="players" checked={draft.multiplayer === multiplayer} onChange={() => { update({ multiplayer }); submit({ key: "players", change: { multiplayer }, undo: (b) => ({ multiplayer: b.multiplayer }) }); }} />
              <span>
                <b>{name}</b>
                <span class="level-text">{text}</span>
              </span>
            </label>
          ))}
          {playersNote && <p class="saved-note" role="status">{playersNote}</p>}
        </fieldset>

        {players && (
          <div class="notice notice-paused players-choice" role="alert">
            <p><b>The remote's shared settings are another project's.</b> Multiplayer shares one set of settings and Items; pick whose.</p>
            <dl class="facts">
              <dt>Theirs (the remote)</dt>
              <dd>{players.theirs.project ?? "no project name"} on {players.theirs.host}</dd>
              <dt>Yours (this clone)</dt>
              <dd>{players.mine.project ?? "no project name"} on {players.mine.host}</dd>
            </dl>
            <div class="form-actions">
              <button type="button" class="primary" onClick={() => { const { change: wanted } = players; setPlayers(null); submit({ key: "players", change: { ...wanted, players: "join" }, undo: (b) => ({ multiplayer: b.multiplayer }) }, show); }}>Join theirs</button>
              <button type="button" onClick={() => { const { change: wanted } = players; setPlayers(null); submit({ key: "players", change: { ...wanted, players: "mine" }, undo: (b) => ({ multiplayer: b.multiplayer }) }, show); }}>Make mine the project's</button>
              <button type="button" onClick={() => { setPlayers(null); update({ multiplayer: base.multiplayer }); }}>Cancel</button>
            </div>
            <p class="muted">Join theirs uses the remote's settings and Items: <b>this clone's settings, and its Items that were never shared, leave the board</b> and are kept only in <code>{players.backup}</code>. Make mine the project's puts this clone's settings and Items on top of the remote's: <b>it changes the project for every machine</b> (Items merge; an id taken on both sides is renumbered).</p>
          </div>
        )}

        <fieldset class="levels">
          <legend><b>Level</b>: how much Scope Soup does on its own; each level includes the ones below <Marked k="level" /></legend>
          {levels.map((choice) => {
            // The level in use stays pickable even when a need went missing since, so the page can show it.
            // A level whose only missing needs the page asks for (level 4's check command and remote URL) can be picked.
            const off = !(choice.pickable ?? choice.blocked === null) && choice.level !== base.level;
            const four = choice.level === 4 && pendingFour;
            return (
              <label key={choice.level} class={`level-row${off ? " level-off" : ""}${draft.level === choice.level ? " level-on" : ""}`}>
                <input type="radio" name="level" value={String(choice.level)} checked={draft.level === choice.level} disabled={off} onChange={() => pickLevel(choice.level)} />
                <span>
                  <b>{choice.level} {choice.name}</b>
                  <span class="level-text">{choice.text}</span>
                  {/* red only for the level in use whose need is missing; otherwise what a level needs is said calmly */}
                  {four
                    ? <span class="level-needs">{pendingFourText(base.level, fourAsks, levelFourFilled(fourAsks, draft.mergeQueue))}</span>
                    : choice.blocked && <span class={choice.level === base.level ? "level-blocked" : "level-needs"}>{choice.blocked}</span>}
                </span>
              </label>
            );
          })}
          {inLevels && (
            <div class="level-asks">
              <p class="muted">{pendingFour ? "Level 4 needs these. It is saved when they are filled in; Scope Soup merges through its own merge queue." : "Scope Soup merges through its own merge queue with this check."}</p>
              {/* with mergeQueue.ci "github" (file-only) no check command is asked for; the level's own text says it needs a GitHub host with writes on. */}
              {hasCheck && (
                <div class="check-ask">
                  <label>
                    <b>What command decides a change is OK — the one you would want green before anything merges?</b>
                    <input type="text" value={draft.mergeQueue.checkCommand} placeholder="for example: npm run check" onInput={(event) => setAsked("checkCommand", (event.target as HTMLInputElement).value)} onBlur={commitCheck} onKeyDown={leave} />
                    <Marked k="check" />
                  </label>
                  {(mergeQueue?.checkCandidates?.length ?? 0) > 0 && (
                    <div class="check-candidates">
                      <span class="muted">Found in the repository; pick one:</span>
                      <ul>
                        {(mergeQueue?.checkCandidates ?? []).map((candidate) => {
                          const text = commandText(candidate.command);
                          return (
                            <li key={text}>
                              <button type="button" class={`candidate${draft.mergeQueue.checkCommand.trim() === text ? " candidate-on" : ""}`} onClick={() => pickCandidate(text)}>
                                <code>{text}</code>
                              </button>
                              <span class="muted">{candidate.from}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  <span class="muted">
                    It runs without a shell in Scope Soup's own fresh clone, after the setup below, on the newest main with the change merged in; a change merges only when it passes.
                    {mergeQueue?.checkCommand ? ` Now: from ${mergeQueue.checkCommandFrom}.` : mergeQueue ? ` Nothing proposed: ${mergeQueue.checkCommandFrom}.` : ""}
                  </span>
                  {mergeQueue?.checkCommandProblem && draft.mergeQueue.checkCommand === base.mergeQueue.checkCommand && <span class="level-blocked">{mergeQueue.checkCommandProblem}</span>}
                </div>
              )}
              {asks.includes("remoteUrl") && (
                <label>
                  <b>Remote's URL</b>
                  <input type="text" value={draft.mergeQueue.remoteUrl} placeholder="as git remote get-url shows it" onInput={(event) => setAsked("remoteUrl", (event.target as HTMLInputElement).value)} onBlur={commitLevelFour} onKeyDown={leave} />
                  <span class="muted">
                    The repository the main branch is pushed to; Scope Soup checks the remote against it before every push.
                    {mergeQueue?.remoteUrl ? ` Read from git (remote "${mergeQueue?.remote}").` : ""}
                  </span>
                  {mergeQueue?.remoteUrlProblem && <span class="level-blocked">{mergeQueue.remoteUrlProblem}</span>}
                </label>
              )}
            </div>
          )}
        </fieldset>

        {hasCheck && !inLevels && (
          <div class="settings-grid">
            <label>
              <b>Check command</b>
              <input type="text" value={draft.mergeQueue.checkCommand} placeholder={mergeQueue?.checkCommand ? commandText(mergeQueue.checkCommand) : "none"} onInput={(event) => setAsked("checkCommand", (event.target as HTMLInputElement).value)} onBlur={commitCheck} onKeyDown={leave} />
              <span class="muted">What decides a change is OK; level 4 merges only on it. Empty: none (level 4 asks for one).</span>
              <Marked k="check" />
            </label>
          </div>
        )}

        <div class="settings-grid">
          <div class="settings-row">
            <label>
              <b>Parallel sessions</b>
              <input type="range" min={1} max={Math.max(8, Number(draft.settings.maxParallelSessions))} step={1} value={draft.settings.maxParallelSessions} onInput={(event) => sliderSetting("maxParallelSessions", (event.target as HTMLInputElement).value)} />
              <span>{draft.settings.maxParallelSessions} session(s) at once, of every role (1 = efficiency, more = speed)</span>
              <Marked k="maxParallelSessions" />
            </label>
          </div>
          {draft.level >= 1 && (
            <div class="settings-row">
              <label>
                <b>Usage reserve</b>
                <input type="range" min={1} max={5} step={1} value={draft.settings.budgetReserve} onInput={(event) => sliderSetting("budgetReserve", (event.target as HTMLInputElement).value)} />
                <span>Position {draft.settings.budgetReserve}: {budgetReserveText(Number(draft.settings.budgetReserve), view.sliders.budgetReserve)}</span>
                <Marked k="budgetReserve" />
              </label>
            </div>
          )}
          {draft.level >= 2 && (
            <div class="settings-row">
              <label>
                <b>Triage again after</b>
                <input type="number" min={1} max={365} step={1} value={draft.settings.triageMaxAgeDays} onInput={(event) => setSetting("triageMaxAgeDays", (event.target as HTMLInputElement).value)} onBlur={() => setSettingNow("triageMaxAgeDays", draftRef.current!.settings.triageMaxAgeDays, 1, 365)} onKeyDown={leave} />
                <span>days: an Item whose triage is older is triaged again before its work starts, as it is when its text was edited, a blocker finished, or commits changed the files its triage named</span>
                <Marked k="triageMaxAgeDays" />
              </label>
            </div>
          )}
        </div>

        <h4>Setup of a fresh clone</h4>
        <p class="muted">Scope Soup's worktrees and clones, and the merge queue's clone, start without what your own checkout has (installed dependencies, generated files, a .env with test settings). The setup runs once in each, and again when a watched file changes, before an agent's session and before the check. The onboarding skill writes a setup script and fills these in.</p>
        <div class="settings-grid">
          <label>
            <b>Setup command</b>
            <input type="text" value={draft.setup.command} placeholder="none: nothing is set up" onInput={(event) => update({ setup: { ...draftRef.current!.setup, command: (event.target as HTMLInputElement).value } })} onBlur={() => { const command = draftRef.current!.setup.command; if (command.trim() !== base.setup.command.trim()) submit({ key: "setupCommand", change: { setupCommand: command.trim() === "" ? null : commandWords(command) } }); }} onKeyDown={leave} />
            <span class="muted">Run without a shell in each folder, for example <code>node .scopesoup/scopesoup-setup.mjs --from-clone {"{{ownClone}}"}</code>; <code>{"{{ownClone}}"}</code> is each machine's own clone. Empty: no setup.</span>
            <Marked k="setupCommand" />
          </label>
          <label>
            <b>Watched files</b>
            <textarea rows={3} value={draft.setup.watch} placeholder={(view.setupWatchDefault ?? []).join("\n")} onInput={(event) => update({ setup: { ...draftRef.current!.setup, watch: (event.target as HTMLTextAreaElement).value } })} onBlur={() => { const watch = watchLines(draftRef.current!.setup.watch); if (JSON.stringify(watch) !== JSON.stringify(watchLines(base.setup.watch))) submit({ key: "setupWatch", change: { setupWatch: watch.length === 0 ? null : watch } }); }} />
            <span class="muted">One per line, relative to the repository; <code>*</code> matches inside one part of a path. The setup runs again when one of them changes. Empty: the usual lockfiles (shown faintly).</span>
            <Marked k="setupWatch" />
          </label>
        </div>

        <h4>Resources</h4>
        <p class="muted">
          What a session or the check needs and only so many exist of: license seats, emulators, a phone on USB, a test database. Each takes a unit before it starts and gives it back when it ends; without a free unit it waits, and other work goes on.
          {" "}A shared resource is counted across every machine, held on the project's remote; the others are this machine's own. In the environment variables <code>{"{{unit}}"}</code> is the unit's number, from 1.
        </p>
        {draft.resources.map((resource, index) => {
          const key = `resource:${index}`;
          const setResource = (patch: Partial<ResourceDraft>) => update({ resources: draftRef.current!.resources.map((each, at) => (at === index ? { ...each, ...patch } : each)) });
          const pickResource = (patch: Partial<ResourceDraft>) => saveResources(draftRef.current!.resources.map((each, at) => (at === index ? { ...each, ...patch } : each)), key);
          const leaveResource = () => saveResources(draftRef.current!.resources, key);
          return (
            <fieldset key={index} class="resource-edit">
              <div class="settings-grid">
                <label>
                  <b>Name</b>
                  <input type="text" value={resource.name} placeholder="for example: emulator" onInput={(event) => setResource({ name: (event.target as HTMLInputElement).value })} onBlur={leaveResource} onKeyDown={leave} />
                </label>
                <label>
                  <b>Units</b>
                  <input type="number" min={1} max={64} step={1} value={resource.units} onInput={(event) => setResource({ units: (event.target as HTMLInputElement).value })} onBlur={leaveResource} onKeyDown={leave} />
                </label>
              </div>
              <label class="resource-check">
                <input type="checkbox" checked={resource.shared} onChange={(event) => pickResource({ shared: (event.target as HTMLInputElement).checked })} />
                {" "}Shared by every machine (a project setting); otherwise this machine's own
              </label>
              <div class="resource-users">
                <span class="muted">Needed by:</span>
                {RESOURCE_USERS.map(([user, title]) => (
                  <label key={user} class="resource-check">
                    <input
                      type="checkbox"
                      checked={resource.neededBy.includes(user)}
                      onChange={(event) => pickResource({ neededBy: (event.target as HTMLInputElement).checked ? [...resource.neededBy, user] : resource.neededBy.filter((each) => each !== user) })}
                    />
                    {title}
                  </label>
                ))}
              </div>
              <label>
                <b>Environment variables</b>
                <textarea rows={2} value={resource.env} placeholder={"one per line, for example: TEST_DB=test_{{unit}}"} onInput={(event) => setResource({ env: (event.target as HTMLTextAreaElement).value })} onBlur={leaveResource} />
              </label>
              <div>
                <button type="button" onClick={() => saveResources(draftRef.current!.resources.filter((_, at) => at !== index), key)}>Remove {resource.name || "this resource"}</button>
                {" "}<Marked k={key} />
              </div>
            </fieldset>
          );
        })}
        <div>
          <button type="button" onClick={() => update({ resources: [...draftRef.current!.resources, { name: "", units: "1", shared: false, neededBy: ["implement"], env: "" }] })}>Add a resource</button>
          <span class="muted"> saved once it has a name</span>
        </div>

        <h4 id="host">Where the Items are</h4>
        <p class="muted">
          {view.config.host?.kind === "github" ? `GitHub Issues: ${view.config.host.repo}.` : view.config.host?.kind === "jira" ? `Jira: project ${view.config.host.project} on ${view.config.host.site}.` : view.config.host?.kind === "metaBranch" ? "The project's meta branch (refs/scopesoup/meta)." : "Set by the environment (SCOPESOUP_GITHUB_* or SCOPESOUP_META_*)."}
          {" "}For every machine, after a restart. You pick which open Items move. Between GitHub and Jira, move back to the meta branch first.
        </p>
        <div class="form-actions">
          {(["github", "jira"] as const).map((kind) => {
            // GitHub and Jira are connected only from the meta branch (or no host): between them, the way is back to the meta branch first.
            const across = (hostKind === "github" || hostKind === "jira") && hostKind !== kind;
            const why = across ? `Going between GitHub and Jira goes through the meta branch: "Move back to the meta branch" first.` : "";
            return <button key={kind} type="button" disabled={across} title={why} onClick={() => setConnecting(kind)}>Connect to {HOST_NAMES[kind]}</button>;
          })}
          {(hostKind === "github" || hostKind === "jira") && (
            <button type="button" onClick={() => setConnecting("metaBranch")}>Move back to the meta branch</button>
          )}
        </div>
        {hostNote && <p class="notice settings-committed" role="status">{hostNote}</p>}

        {view.config?.host?.kind === "jira" && (
          <>
            <h4 id="jira">Jira</h4>
            <p class="muted">
              Project <b>{view.config.host.project}</b>. Only issues that match the filter (JQL) are Items: Scope Soup does not read, show or touch the others.
              {" "}A project setting, in effect from the next read on every machine. Jira checks a new filter and counts what it adds and removes before it is saved.
            </p>
            <div class="settings-grid">
              <div class="settings-row">
                <label>
                  <b>Filter</b>
                  <input type="text" value={draft.jira.filter} placeholder="none: every issue of the project is an Item" onInput={(event) => update({ jira: { ...draftRef.current!.jira, filter: (event.target as HTMLInputElement).value } })} onBlur={() => { const filter = draftRef.current!.jira.filter.trim(); if (filter !== base.jira.filter.trim()) saveHost({ filter: filter === "" ? null : filter }); }} onKeyDown={leave} />
                  <Marked k="jira:filter" />
                </label>
              </div>
              <div class="settings-row">
                <label>
                  <b>Components of new Items</b>
                  <input type="text" value={draft.jira.components} placeholder="none" onInput={(event) => update({ jira: { ...draftRef.current!.jira, components: (event.target as HTMLInputElement).value } })} onBlur={() => { const components = componentList(draftRef.current!.jira.components); if (JSON.stringify(components) !== JSON.stringify(componentList(base.jira.components))) saveHost({ components: components.length === 0 ? null : components }); }} onKeyDown={leave} />
                  <span class="muted">Comma separated. A new Item outside the filter is reported on the board.</span>
                  <Marked k="jira:components" />
                </label>
              </div>
            </div>
          </>
        )}

        <h4 id="images">Images</h4>
        <p class="muted">
          Agents may attach images to what they answer (a screenshot, a before and after of a UI change). Scope Soup keeps them in this machine's data folder and shows them on the Item page. Hosts (GitHub, Jira) get only the words "image on the board", never the picture.
        </p>
        <div class="settings-grid">
          <label>
            <b>Push images to the remote</b>
            {draft.multiplayer ? (
              <span class="check-line">
                <input type="checkbox" checked={draft.media.push} onChange={(event) => saveMedia({ push: (event.target as HTMLInputElement).checked })} />
                {" "}Everyone with the repository sees them
              </span>
            ) : <span class="muted">Singleplayer: images stay on this machine.</span>}
            <span class="muted">A project setting. Off: only the machine that ran the session sees them.</span>
            <Marked k="push" />
          </label>
          <label>
            <b>Delete a closed Item's images</b>
            <span class="check-line">
              <select value={draft.media.keepDays === "" ? "never" : "after"} onChange={(event) => saveMedia({ keepDays: (event.target as HTMLSelectElement).value === "never" ? "" : draftRef.current!.media.keepDays || "30" })}>
                <option value="never">Never</option>
                <option value="after">After a number of days</option>
              </select>
              {draft.media.keepDays !== "" && (
                <>
                  <input type="number" min={0} max={3650} step={1} value={draft.media.keepDays} onInput={(event) => update({ media: { ...draftRef.current!.media, keepDays: (event.target as HTMLInputElement).value } })} onBlur={() => saveMedia({})} onKeyDown={leave} />
                  {" "}days
                </>
              )}
            </span>
            <span class="muted">Here and on the remote. Never: the Item's history keeps its pictures.</span>
            <Marked k="keepDays" />
          </label>
        </div>

        <h4>Review</h4>
        <div class="settings-grid">
          <label>
            <b>A review's "should" findings on a change it approves</b>
            <select value={draft.shouldFindings} onChange={(event) => { const shouldFindings = (event.target as HTMLSelectElement).value as Draft["shouldFindings"]; update({ shouldFindings }); submit({ key: "should", change: { review: { shouldFindings } }, undo: (b) => ({ shouldFindings: b.shouldFindings }) }); }}>
              <option value="fix">Fix before merging (one more round)</option>
              <option value="draft">Merge; make them a draft Item</option>
            </select>
            <span class="muted">A project setting. A draft waits in Your turn for Approve or Deny.</span>
            <Marked k="should" />
          </label>
        </div>

        <h4>Labels</h4>
        <div class="settings-grid">
          <label>
            <b>Label on Items an AI made or rewrote</b>
            <input type="text" value={draft.aiLabel} placeholder="no label" onInput={(event) => update({ aiLabel: (event.target as HTMLInputElement).value })} onBlur={() => { const label = draftRef.current!.aiLabel.trim(); if (label !== base.aiLabel.trim()) submit({ key: "aiLabel", change: { labels: { aiGenerated: label === "" ? false : label } } }); }} onKeyDown={leave} />
            <span class="muted">A project setting. On Items from a restructuring, a draft, an overturned decision or a triage rewrite; never removed.</span>
            <Marked k="aiLabel" />
          </label>
        </div>

        <h4>Models</h4>
        <div class="settings-grid">
          {ROLES.map(([name, title]) => (
            <label key={name}>
              <b>{title}</b>
              <input type="text" value={draft.roles[name]?.model ?? ""} placeholder={defaultModels[name] ?? ""} onInput={(event) => update({ roles: { ...draftRef.current!.roles, [name]: { effort: "", ...draftRef.current!.roles[name], model: (event.target as HTMLInputElement).value } } })} onBlur={() => { const model = (draftRef.current!.roles[name]?.model ?? "").trim(); if (model !== "" && model !== base.roles[name]?.model) saveRole(name, { model }); }} onKeyDown={leave} />
              <Marked k={`role:${name}:model`} />
              {pinned.has(name) ? (
                <span class="muted">
                  {" "}set for the project; the default is {defaultModels[name]}{" "}
                  <button type="button" onClick={() => saveRole(name, { model: null })}>Use default</button>
                </span>
              ) : (
                <span class="muted"> the default: {defaultModels[name]} (type a model to set it)</span>
              )}
              {view.config?.roles[name as "implement"]?.provider !== "copilot" && (
                <span class="muted">
                  {" "}Effort{" "}
                  <select value={draft.roles[name]?.effort ?? ""} onChange={(event) => { const effort = (event.target as HTMLSelectElement).value; update({ roles: { ...draftRef.current!.roles, [name]: { model: "", ...draftRef.current!.roles[name], effort } } }); saveRole(name, { effort }); }}>
                    <option value="">default</option>
                    {EFFORT_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                  {" "}higher effort uses more of the usage windows
                  {" "}<Marked k={`role:${name}:effort`} />
                </span>
              )}
              {view.config?.roles[name as "implement"]?.provider === "copilot" && (
                <span class="notice notice-paused copilot-warning" role="note"><b>Runs on Copilot.</b> {COPILOT_WARNING}</span>
              )}
            </label>
          ))}
        </div>

        <h4>Allowed commands</h4>
        <p class="muted">What each role may run, from <code>roles.&lt;role&gt;.allowedTools</code>. The implement and review roles can always run the project's check command; its rule is added here when the file does not list it.</p>
        {["implement", "review"].map((name) => {
          const tools = view.config?.roles[name as "implement" | "review"]?.allowedTools ?? [];
          return (
            <p key={name}>
              <b>{ROLES.find(([role]) => role === name)?.[1]}</b>: {tools.length > 0 ? tools.map((tool) => <code key={tool}>{tool} </code>) : "nothing"}
            </p>
          );
        })}

        <h4>MCP servers</h4>
        <p class="muted">Extra tools per role (a browser, an image tool), from <code>roles.&lt;role&gt;.mcpServers</code>. Edit them in the configuration file for now; a variable named under <code>env</code> takes its value from the environment, never from the file.</p>
        {ROLES.map(([name, label]) => {
          const servers = Object.entries((view.config?.roles[name as "implement"] as { mcpServers?: Record<string, { command: string; args?: string[]; env?: string[] }> } | undefined)?.mcpServers ?? {});
          return (
            <p key={name}>
              <b>{label}</b>: {servers.length > 0 ? servers.map(([server, spec]) => <span key={server}><code>{server}</code> ({[spec.command, ...(spec.args ?? [])].join(" ")}{spec.env ? `; env ${spec.env.join(", ")}` : ""}){" "}</span>) : "none"}
            </p>
          );
        })}

        {widens && (
          <div class="notice notice-paused players-choice" role="alert">
            <p><b>The new Jira filter adds {widens.added} Item{widens.added === 1 ? "" : "s"}.</b> Nothing is saved until you say so.</p>
            <ul>{widens.lines.map((line) => <li key={line}>{line}</li>)}</ul>
            <div class="form-actions">
              <button type="button" class="primary" onClick={() => { const { change: wanted } = widens; setWidens(null); submit({ key: "jira:filter", change: { ...wanted, confirm: true } }); }}>Add them and save</button>
              <button type="button" onClick={() => { setWidens(null); update({ jira: { ...draftRef.current!.jira, filter: base.jira.filter } }); }}>Cancel</button>
            </div>
          </div>
        )}
      </form>
      {connecting && (
        <ConnectDialog
          kind={connecting}
          {...(hostKind === "github" || hostKind === "jira" ? { from: hostKind } : {})}
          onClose={() => setConnecting(null)}
          onConnected={(next, shared, moved) => {
            setConnecting(null);
            show(next);
            setHostNote(`${moved && moved.length > 0 ? `Moved: ${moved.join("; ")}. ` : ""}${shared ?? "Connected."} Start Scope Soup again to use the new host.`);
          }}
        />
      )}
      <SettingsHistory open={openHistory} />
    </div>
  );
}
