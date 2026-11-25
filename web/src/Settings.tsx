// The Settings page: the level first, as five rows with what each does and needs; then parallel sessions, the
// usage reserve (from level 1), the age after which a triage is taken again (from level 2) and the model of each role. Everything else is file-only, with its defaults.
// Picking level 4 while the file lacks its check command or remote URL asks for them right there, proposed by the server.
// The project's settings (level, check, setup, models, the triage's age) are shared by every machine: a save is
// one commit on the meta ref, named after the person picked at the top of the board, and in effect at once (on the other
// machines at their next fetch). Parallel sessions, the usage reserve and the remote's URL are this machine's own. The page shows
// the two as one: no key is in both.
// The limited resources: a shared one is a project setting (`sharedResources`), the others this machine's (`resources`).

import { ThemePicker } from "./ThemePicker.tsx";
import { useEffect, useState } from "preact/hooks";
import { VersionPanel } from "./Version.tsx";
import { SettingsHistory } from "./SettingsHistory.tsx";
import type { ConfigView, ProjectConfig, ProjectView } from "./api.ts";
import { FolderButton } from "./ProjectHeader.tsx";
import type { AskedField, MergeQueueSetup } from "../../src/config/levels.ts";
import type { Sliders } from "../../src/config/sliders.ts";
import { commandText, commandWords } from "../../src/config/commandLine.ts";
import { fetchConfig, postConfig } from "./api.ts";

const ONBOARDING = "https://github.com/mikaeltulldahl/scopesoup/blob/main/docs/ONBOARDING.md";

/** The settings the page shows, besides the level. */
const SETTINGS = ["maxParallelSessions", "budgetReserve", "triageMaxAgeDays"] as const;
type SettingName = (typeof SETTINGS)[number];

/** What a role set to the Copilot provider is told (`COPILOT_WARNING` in src/orchestrator/providers/copilot/command.ts; the board reads no server code). */
const COPILOT_WARNING = "Copilot's rules name a program and its first word only (such as git push), never a flag. So --no-verify and --force cannot be refused on Copilot: this role may use them on any git command it may run, and only its prompt says not to. Protect the main branch on the remote (no force push) to be safe.";

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
  roles: Record<string, { model: string }>;
  /** What level 4 asks for, as text: the check command as one line, the remote's URL. Saved only with level 4. */
  mergeQueue: Record<AskedField, string>;
  /** The setup of a fresh clone: the command as one line, the watched files one per line ("" for none in the file). */
  setup: { command: string; watch: string };
  /** The limited resources, as the form holds them. */
  resources: ResourceDraft[];
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
function draftOf(config: ProjectConfig, raw: unknown, mergeQueue: MergeQueueSetup | null | undefined): Draft {
  const setting = (name: SettingName) => String(config.settings[name].value);
  const roles: Draft["roles"] = {};
  const pinned = pinnedRoles(raw);
  for (const [name] of ROLES) roles[name] = { model: pinned.has(name) ? (config.roles as Record<string, { model: string } | undefined>)[name]?.model ?? "" : "" };
  const asked = { checkCommand: mergeQueue?.checkCommand ? commandText(mergeQueue.checkCommand) : "", remoteUrl: mergeQueue?.remoteUrl ?? "" };
  // The command as the shared file holds it, with {{ownClone}} unexpanded (the configuration in use has this machine's path in it).
  const command = (raw as { setupCommand?: unknown } | null)?.setupCommand;
  const setup = { command: Array.isArray(command) ? commandText(command as string[]) : config.setupCommand ? commandText(config.setupCommand) : "", watch: (config.setupWatch ?? []).join("\n") };
  return { level: config.level, settings: { maxParallelSessions: setting("maxParallelSessions"), budgetReserve: setting("budgetReserve"), triageMaxAgeDays: setting("triageMaxAgeDays") }, roles, mergeQueue: asked, setup, resources: resourceDrafts(config) };
}

/** The watched files as the file holds them: one per line, blank lines dropped. */
function watchLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}

/** Only what differs from the configuration in use, as the server takes it. */
function changeOf(draft: Draft, base: Draft, asks: readonly AskedField[], showsCheck: boolean): Record<string, unknown> {
  const change: Record<string, unknown> = {};
  if (draft.level !== base.level) change.level = draft.level;
  // Level 4's missing needs go with it, as the file holds them: the check command as a list, run without a shell.
  // The check command shown at level 4 is saved when it was changed, too.
  if (draft.level === 4) {
    if (asks.includes("checkCommand") || (showsCheck && draft.mergeQueue.checkCommand.trim() !== base.mergeQueue.checkCommand.trim())) change.checkCommand = commandWords(draft.mergeQueue.checkCommand);
    if (asks.includes("remoteUrl")) change.remoteUrl = draft.mergeQueue.remoteUrl.trim();
  }
  // The setup, at any level; emptied, it is removed from the file (no setup, or the default watched files).
  if (draft.setup.command.trim() !== base.setup.command.trim()) change.setupCommand = draft.setup.command.trim() === "" ? null : commandWords(draft.setup.command);
  const watch = watchLines(draft.setup.watch);
  if (JSON.stringify(watch) !== JSON.stringify(watchLines(base.setup.watch))) change.setupWatch = watch.length === 0 ? null : watch;
  const settings: Record<string, unknown> = {};
  for (const name of SETTINGS) {
    if (draft.settings[name] !== base.settings[name]) settings[name] = { value: Number(draft.settings[name]) };
  }
  if (Object.keys(settings).length > 0) change.settings = settings;
  const roles: Record<string, unknown> = {};
  for (const [name, role] of Object.entries(draft.roles)) {
    if (role.model.trim() !== "" && role.model !== base.roles[name]?.model) roles[name] = role;
  }
  if (Object.keys(roles).length > 0) change.roles = roles;
  // Each list whole, when it differs; an emptied list is removed from its file.
  const lists = resourceLists(draft.resources);
  const before = resourceLists(base.resources);
  for (const key of ["resources", "sharedResources"] as const) {
    if (JSON.stringify(lists[key]) !== JSON.stringify(before[key])) change[key] = lists[key].length === 0 ? null : lists[key];
  }
  return change;
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

export function Settings({ project, openHistory = false }: { project?: ProjectView | undefined; openHistory?: boolean } = {}) {
  const [view, setView] = useState<ConfigView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // What a save of a project setting did: saved for every machine, by whom.
  const [committed, setCommitted] = useState<string | null>(null);

  const show = (next: ConfigView) => {
    setView(next);
    setDraft(next.present && next.config ? draftOf(next.config, next.raw, next.mergeQueue) : null);
  };
  useEffect(() => {
    fetchConfig().then(show, (problem: unknown) => setLoadError(problem instanceof Error ? problem.message : String(problem)));
  }, []);

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
  const pinned = pinnedRoles(view.raw);
  const defaultModels: Readonly<Record<string, string | undefined>> = view.defaultModels ?? {};
  const levels = view.levels ?? [];
  const asks = draft.level === 4 ? (levels[4]?.asks ?? []) : [];
  const mergeQueue = view.mergeQueue ?? null;
  // At level 4 with the project's own check command (not mergeQueue.ci "github"), the check question is always shown.
  const showsCheck = draft.level === 4 && (asks.includes("checkCommand") || (view.config.mergeQueue?.ci ?? "local") === "local");
  const run = (change: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    setCommitted(null);
    postConfig(change).then(
      (next) => {
        show(next);
        setCommitted(next.shared ?? null);
        after?.();
        setBusy(false);
      },
      (problem: unknown) => {
        setError(problem instanceof Error ? problem.message : String(problem));
        setBusy(false);
      },
    );
  };
  const change = changeOf(draft, base, asks, showsCheck);
  const dirty = Object.keys(change).length > 0;
  const save = (event: Event) => {
    event.preventDefault();
    run(change, () => setSaved(true));
  };
  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch });
  };
  const setSetting = (name: SettingName, value: string) => set({ settings: { ...draft.settings, [name]: value } });
  const setAsked = (name: AskedField, value: string) => set({ mergeQueue: { ...draft.mergeQueue, [name]: value } });
  const parallel = draft.settings.maxParallelSessions;
  const reserve = draft.settings.budgetReserve;
  const lookAge = draft.settings.triageMaxAgeDays;

  return (
    <div class="settings">
      <ThemePicker />
      <VersionPanel />
      <form class="panel item-form settings-form" onSubmit={save}>
        <div class="panel-head">
          <h3>Settings</h3>
          <a class="tag-link settings-stop-link" href="#/settings/stop">Stop using Scope Soup</a>
        </div>
        <Folders project={project} />
        <p class="muted">
          The project's settings (the level, the check, the setup, the models, the triage's age) are the same on every machine: a save takes effect at once, here and on the other machines at their next fetch, and History says who changed what.
          {" "}Parallel sessions, the usage reserve and the remote's URL are this machine's own. Everything not on this page is set by hand.
        </p>

        <fieldset class="levels" disabled={busy}>
          <legend><b>Level</b>: how much Scope Soup does on its own; each level includes the ones below</legend>
          {levels.map((choice) => {
            // The level in use stays pickable even when a need went missing since, so the page can show it.
            // A level whose only missing needs the page asks for (level 4's check command and remote URL) can be picked.
            const off = !(choice.pickable ?? choice.blocked === null) && choice.level !== base.level;
            return (
              <label key={choice.level} class={`level-row${off ? " level-off" : ""}${draft.level === choice.level ? " level-on" : ""}`}>
                <input type="radio" name="level" value={String(choice.level)} checked={draft.level === choice.level} disabled={off} onChange={() => set({ level: choice.level })} />
                <span>
                  <b>{choice.level} {choice.name}</b>
                  <span class="level-text">{choice.text}</span>
                  {choice.blocked && !(choice.level === draft.level && asks.length > 0) && <span class="level-blocked">{choice.blocked}</span>}
                </span>
              </label>
            );
          })}
          {(asks.length > 0 || showsCheck) && (
            <div class="level-asks">
              <p class="muted">{asks.length > 0 ? "Level 4 needs these, saved with it. Scope Soup merges through its own merge queue." : "Scope Soup merges through its own merge queue with this check."}</p>
              {/* with mergeQueue.ci "github" (file-only) no check command is asked for; the level's own text says it needs a GitHub host with writes on. */}
              {showsCheck && (
                <div class="check-ask">
                  <label>
                    <b>What command decides a change is OK — the one you would want green before anything merges?</b>
                    <input type="text" value={draft.mergeQueue.checkCommand} placeholder="for example: npm run check" onInput={(event) => setAsked("checkCommand", (event.target as HTMLInputElement).value)} />
                  </label>
                  {(mergeQueue?.checkCandidates?.length ?? 0) > 0 && (
                    <div class="check-candidates">
                      <span class="muted">Found in the repository; pick one:</span>
                      <ul>
                        {(mergeQueue?.checkCandidates ?? []).map((candidate) => {
                          const text = commandText(candidate.command);
                          return (
                            <li key={text}>
                              <button type="button" class={`candidate${draft.mergeQueue.checkCommand.trim() === text ? " candidate-on" : ""}`} onClick={() => setAsked("checkCommand", text)}>
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
                  <input type="text" value={draft.mergeQueue.remoteUrl} placeholder="as git remote get-url shows it" onInput={(event) => setAsked("remoteUrl", (event.target as HTMLInputElement).value)} />
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

        <div class="settings-grid">
          <div class="settings-row">
            <label>
              <b>Parallel sessions</b>
              <input type="range" min={1} max={Math.max(8, Number(parallel))} step={1} value={parallel} disabled={busy} onInput={(event) => setSetting("maxParallelSessions", (event.target as HTMLInputElement).value)} />
              <span>{parallel} session(s) at once, of every role (1 = efficiency, more = speed)</span>
            </label>
          </div>
          {draft.level >= 1 && (
            <div class="settings-row">
              <label>
                <b>Usage reserve</b>
                <input type="range" min={1} max={5} step={1} value={reserve} disabled={busy} onInput={(event) => setSetting("budgetReserve", (event.target as HTMLInputElement).value)} />
                <span>Position {reserve}: {budgetReserveText(Number(reserve), view.sliders.budgetReserve)}</span>
              </label>
            </div>
          )}
          {draft.level >= 2 && (
            <div class="settings-row">
              <label>
                <b>Triage again after</b>
                <input type="number" min={1} max={365} step={1} value={lookAge} disabled={busy} onInput={(event) => setSetting("triageMaxAgeDays", (event.target as HTMLInputElement).value)} />
                <span>days: an Item whose triage is older is triaged again before its work starts, as it is when its text was edited, a blocker finished, or commits changed the files its triage named</span>
              </label>
            </div>
          )}
        </div>

        <h4>Setup of a fresh clone</h4>
        <p class="muted">Scope Soup's worktrees and clones, and the merge queue's clone, start without what your own checkout has (installed dependencies, generated files, a .env with test settings). The setup runs once in each, and again when a watched file changes, before an agent's session and before the check. The onboarding skill writes a setup script and fills these in.</p>
        <div class="settings-grid">
          <label>
            <b>Setup command</b>
            <input type="text" value={draft.setup.command} placeholder="none: nothing is set up" disabled={busy} onInput={(event) => set({ setup: { ...draft.setup, command: (event.target as HTMLInputElement).value } })} />
            <span class="muted">Run without a shell in each folder, for example <code>node .scopesoup/scopesoup-setup.mjs --from-clone {"{{ownClone}}"}</code>; <code>{"{{ownClone}}"}</code> is each machine's own clone. Empty: no setup.</span>
          </label>
          <label>
            <b>Watched files</b>
            <textarea rows={3} value={draft.setup.watch} placeholder={(view.setupWatchDefault ?? []).join("\n")} disabled={busy} onInput={(event) => set({ setup: { ...draft.setup, watch: (event.target as HTMLTextAreaElement).value } })} />
            <span class="muted">One per line, relative to the repository; <code>*</code> matches inside one part of a path. The setup runs again when one of them changes. Empty: the usual lockfiles (shown faintly).</span>
          </label>
        </div>

        <h4>Resources</h4>
        <p class="muted">
          What a session or the check needs and only so many exist of: license seats, emulators, a phone on USB, a test database. Each takes a unit before it starts and gives it back when it ends; without a free unit it waits, and other work goes on.
          {" "}A shared resource is counted across every machine, held on the project's remote; the others are this machine's own. In the environment variables <code>{"{{unit}}"}</code> is the unit's number, from 1.
        </p>
        {draft.resources.map((resource, index) => {
          const setResource = (patch: Partial<ResourceDraft>) => set({ resources: draft.resources.map((each, at) => (at === index ? { ...each, ...patch } : each)) });
          return (
            <fieldset key={index} class="resource-edit" disabled={busy}>
              <div class="settings-grid">
                <label>
                  <b>Name</b>
                  <input type="text" value={resource.name} placeholder="for example: emulator" onInput={(event) => setResource({ name: (event.target as HTMLInputElement).value })} />
                </label>
                <label>
                  <b>Units</b>
                  <input type="number" min={1} max={64} step={1} value={resource.units} onInput={(event) => setResource({ units: (event.target as HTMLInputElement).value })} />
                </label>
              </div>
              <label class="resource-check">
                <input type="checkbox" checked={resource.shared} onChange={(event) => setResource({ shared: (event.target as HTMLInputElement).checked })} />
                {" "}Shared by every machine (a project setting); otherwise this machine's own
              </label>
              <div class="resource-users">
                <span class="muted">Needed by:</span>
                {RESOURCE_USERS.map(([user, title]) => (
                  <label key={user} class="resource-check">
                    <input
                      type="checkbox"
                      checked={resource.neededBy.includes(user)}
                      onChange={(event) => setResource({ neededBy: (event.target as HTMLInputElement).checked ? [...resource.neededBy, user] : resource.neededBy.filter((each) => each !== user) })}
                    />
                    {title}
                  </label>
                ))}
              </div>
              <label>
                <b>Environment variables</b>
                <textarea rows={2} value={resource.env} placeholder={"one per line, for example: TEST_DB=test_{{unit}}"} onInput={(event) => setResource({ env: (event.target as HTMLTextAreaElement).value })} />
              </label>
              <div>
                <button type="button" onClick={() => set({ resources: draft.resources.filter((_, at) => at !== index) })}>Remove {resource.name || "this resource"}</button>
              </div>
            </fieldset>
          );
        })}
        <div>
          <button type="button" disabled={busy} onClick={() => set({ resources: [...draft.resources, { name: "", units: "1", shared: false, neededBy: ["implement"], env: "" }] })}>Add a resource</button>
        </div>

        <h4>Models</h4>
        <div class="settings-grid">
          {ROLES.map(([name, title]) => (
            <label key={name}>
              <b>{title}</b>
              <input type="text" value={draft.roles[name]?.model ?? ""} placeholder={defaultModels[name] ?? ""} disabled={busy} onInput={(event) => set({ roles: { ...draft.roles, [name]: { model: (event.target as HTMLInputElement).value } } })} />
              {pinned.has(name) ? (
                <span class="muted">
                  {" "}set for the project; the default is {defaultModels[name]}{" "}
                  <button type="button" disabled={busy || dirty} title={dirty ? "Save or undo your changes first" : ""} onClick={() => run({ roles: { [name]: { model: null } } })}>Use default</button>
                </span>
              ) : (
                <span class="muted"> the default: {defaultModels[name]} (type a model to set it)</span>
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

        <div class="form-actions">
          <button type="submit" class="primary" disabled={busy || !dirty}>{busy ? "Saving…" : "Save"}</button>
          <button type="button" disabled={busy || !dirty} onClick={() => set(base)}>Undo changes</button>
          {saved && !committed && <span class="muted" role="status">Saved.</span>}
        </div>
        {committed && <p class="notice settings-committed" role="status">{committed}</p>}
        {error && <pre class="notice notice-bad settings-errors" role="alert">{error}</pre>}
      </form>
      <SettingsHistory open={openHistory} />
    </div>
  );
}
