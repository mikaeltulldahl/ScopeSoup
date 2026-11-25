// Settings' "Connect to GitHub Issues" and "Connect to Jira" (#127, decision 98): a dialog that asks what the host needs, lets the
// server check it (the configuration, the token from the environment, one look at the host, no agent session running anywhere) and
// say what connecting would do, and only then connects. From the meta branch it lists the open Items; the ticked ones move.
// In join mode ("Set up this machine") the host is the project's, shown and not changed: only this machine's part is asked for.
// The token is never asked for here: the server says which variable to set when it is missing.

import { useEffect, useState } from "preact/hooks";
import { Dialog } from "./Dialog.tsx";
import { type ConfigView, fetchMachineSetup, type MachineSetupView, type MovableItem, postConnect } from "./api.ts";

export type ConnectKind = "github" | "jira";

interface Fields {
  repo: string;
  site: string;
  project: string;
  deployment: "cloud" | "datacenter";
  email: string;
  filter: string;
  components: string;
  write: boolean;
}

const EMPTY: Fields = { repo: "", site: "", project: "", deployment: "cloud", email: "", filter: "", components: "", write: true };

export const HOST_NAMES: Record<ConnectKind, string> = { github: "GitHub Issues", jira: "Jira" };

function bodyOf(kind: ConnectKind, fields: Fields, join: boolean, move: string[]): Record<string, unknown> {
  if (join) return { mode: "join", ...(kind === "jira" && fields.deployment === "cloud" ? { email: fields.email } : {}) };
  if (kind === "github") return { kind, repo: fields.repo, write: fields.write, move };
  return {
    kind, site: fields.site, project: fields.project, deployment: fields.deployment, write: fields.write,
    ...(fields.deployment === "cloud" ? { email: fields.email } : {}),
    filter: fields.filter,
    components: fields.components.split(",").map((each) => each.trim()).filter((each) => each !== ""),
    move,
  };
}

/** The host the dialog would talk to, named as the person typed it, before any Check: the site's host name, or the repository. */
function whereText(kind: ConnectKind, fields: Fields): string {
  if (kind === "github") {
    const repo = fields.repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
    return repo ? `Talks to github.com, repository ${repo}.` : "Talks to github.com.";
  }
  const site = fields.site.trim();
  if (site === "") return "Talks to the Jira site you name.";
  if (/^http:\/\//i.test(site)) return "An http site is refused: the token would travel unencrypted. Use its https address.";
  try {
    return `Talks to ${new URL(site).host}${fields.project.trim() ? `, project ${fields.project.trim().toUpperCase()}` : ""}.`;
  } catch {
    return "Not an address yet: write it as https://example.atlassian.net.";
  }
}

export function ConnectDialog({ kind, join = false, host, onClose, onConnected }: {
  kind: ConnectKind;
  /** Set up this machine for the project's host (`host`, shown, not changed). */
  join?: boolean;
  host?: MachineSetupView["host"];
  onClose: () => void;
  onConnected: (view: ConfigView, shared: string | undefined, moved: string[] | undefined) => void;
}) {
  const [fields, setFields] = useState<Fields>(host ? { ...EMPTY, repo: host.repo ?? "", site: host.site ?? "", project: host.project ?? "", deployment: host.deployment ?? "cloud", write: host.write ?? true } : EMPTY);
  const [busy, setBusy] = useState(false);
  // What the server said about these fields: the plan, and what stands in the way. Cleared by any edit.
  const [plan, setPlan] = useState<{ lines: string[]; problems: string[] } | null>(null);
  // The meta branch's open Items, from the last check; kept while ticks change.
  const [items, setItems] = useState<MovableItem[] | null>(null);
  const [move, setMove] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const title = join ? `Set up this machine for ${HOST_NAMES[kind]}` : `Connect to ${HOST_NAMES[kind]}`;
  const set = (patch: Partial<Fields>) => {
    setFields({ ...fields, ...patch });
    setPlan(null);
    setError(null);
  };
  const tick = (id: string, on: boolean) => {
    setMove((now) => (on ? [...now.filter((each) => each !== id), id] : now.filter((each) => each !== id)));
    setPlan(null);
  };
  const send = (confirm: boolean) => {
    setBusy(true);
    setError(null);
    postConnect({ ...bodyOf(kind, fields, join, move), confirm }).then(
      (answer) => {
        setBusy(false);
        if (answer.done && answer.view) return onConnected(answer.view, answer.shared, answer.moved);
        setPlan({ lines: answer.lines, problems: answer.problems });
        if (answer.items) setItems(answer.items);
      },
      (problem: unknown) => {
        setBusy(false);
        setError(problem instanceof Error ? problem.message : String(problem));
      },
    );
  };
  const input = (name: "repo" | "site" | "project" | "email" | "filter" | "components", label: string, placeholder: string, note?: string) => (
    <label>
      <b>{label}</b>
      <input type="text" value={fields[name]} placeholder={placeholder} disabled={busy} onInput={(event) => set({ [name]: (event.target as HTMLInputElement).value })} />
      {note && <span class="muted">{note}</span>}
    </label>
  );
  const variable = kind === "github" ? "SCOPESOUP_GITHUB_TOKEN" : "SCOPESOUP_JIRA_TOKEN";
  return (
    <Dialog label={title} onClose={onClose} focusSelector="input, button.primary" keepOnOutsideClick>
      <h3 class="dialog-title">{title}</h3>
      <form
        class="item-form connect-form"
        onSubmit={(event) => {
          event.preventDefault();
          send(false);
        }}
      >
        {join ? (
          <>
            <p class="muted">The project's Items are on {kind === "github" ? `GitHub Issues: ${fields.repo}` : `Jira: project ${fields.project} on ${fields.site}`}. This machine needs its own access before it reads them or starts agents. The token is read from <code>{variable}</code> in the environment Scope Soup runs in; it is not asked for here.</p>
            {kind === "jira" && fields.deployment === "cloud" && input("email", "Your Jira account's email", "you@example.com", "This machine's own: kept in its scopesoup.config.json, not in the shared settings.")}
          </>
        ) : kind === "github" ? (
          <>
            <p class="muted">The project's Items become the repository's issues. The token is read from <code>{variable}</code> in the environment Scope Soup runs in; it is not asked for here.</p>
            {input("repo", "Repository", "account/repository")}
          </>
        ) : (
          <>
            <p class="muted">The project's Items become the Jira project's issues. The token is read from <code>{variable}</code> in the environment Scope Soup runs in; it is not asked for here.</p>
            {input("site", "Site", "https://example.atlassian.net")}
            {input("project", "Project key", "DEMO")}
            <fieldset class="connect-deployment" disabled={busy}>
              <legend><b>Deployment</b></legend>
              <label class="resource-check"><input type="radio" name="deployment" checked={fields.deployment === "cloud"} onChange={() => set({ deployment: "cloud" })} /> Jira Cloud (an API token with the account's email)</label>
              <label class="resource-check"><input type="radio" name="deployment" checked={fields.deployment === "datacenter"} onChange={() => set({ deployment: "datacenter" })} /> Data Center (a personal access token)</label>
            </fieldset>
            {fields.deployment === "cloud" && input("email", "Your Jira account's email", "you@example.com", "This machine's own: kept in its scopesoup.config.json, not in the shared settings.")}
            {input("filter", "Filter (optional)", 'component = "Board" AND labels = scopesoup', "JQL, ANDed with the project: only issues within it are Items. Empty: every issue of the project.")}
            {input("components", "Components of new Items (optional)", "Board", "Comma separated. Empty: none.")}
          </>
        )}
        {!join && <p class="connect-where" role="status">{whereText(kind, fields)}</p>}
        {!join && (
          <label class="resource-check">
            <input type="checkbox" checked={fields.write} disabled={busy} onChange={(event) => set({ write: (event.target as HTMLInputElement).checked })} />
            {" "}Let Scope Soup write ({kind === "github" ? "issues, labels and comments" : "issues, comments, labels and properties"}); off: it only shows them, and the level must be 0 (Watch)
          </label>
        )}
        {items && items.length > 0 && (
          <fieldset class="connect-items" disabled={busy}>
            <legend><b>Move these Items to {HOST_NAMES[kind]}</b> (the others stay on the meta branch)</legend>
            <label class="resource-check">
              <input type="checkbox" checked={move.length === items.length} onChange={(event) => { setMove((event.target as HTMLInputElement).checked ? items.map((item) => item.id) : []); setPlan(null); }} />
              <i>All {items.length}</i>
            </label>
            {items.map((item) => (
              <label key={item.id} class="resource-check">
                <input type="checkbox" checked={move.includes(item.id)} onChange={(event) => tick(item.id, (event.target as HTMLInputElement).checked)} />
                <code>{item.id}</code> {item.title}
              </label>
            ))}
          </fieldset>
        )}
        {plan && plan.problems.length > 0 && (
          <div class="notice notice-bad" role="alert">
            <b>{join ? "Not set up:" : "Not connected:"}</b>
            <ul>{plan.problems.map((each) => <li key={each}>{each}</li>)}</ul>
          </div>
        )}
        {plan && plan.lines.length > 0 && (
          <div class="notice connect-plan" role="status">
            <b>{plan.problems.length > 0 ? "Once that is settled, " : ""}{join ? (plan.problems.length > 0 ? "setting up would:" : "Setting up would:") : plan.problems.length > 0 ? "connecting would:" : "Connecting would:"}</b>
            <ul>{plan.lines.map((each) => <li key={each}>{each}</li>)}</ul>
          </div>
        )}
        {error && <pre class="notice notice-bad settings-errors" role="alert">{error}</pre>}
        <div class="form-actions">
          {plan && plan.problems.length === 0 ? (
            <button type="button" class="primary" disabled={busy} onClick={() => send(true)}>{busy ? (move.length > 0 ? "Moving…" : "Saving…") : join ? "Set up" : move.length > 0 ? `Move ${move.length} and connect` : "Connect"}</button>
          ) : (
            <button type="submit" class="primary" disabled={busy}>{busy ? "Checking…" : "Check"}</button>
          )}
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}

/** The board's "Set up this machine for <host>" note, while this machine lacks what the project's host needs (no agent runs). */
export function MachineSetupNote() {
  const [view, setView] = useState<MachineSetupView | null>(null);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    fetchMachineSetup().then(setView, () => setView(null));
  }, []);
  const setup = view?.setup;
  if (!setup || !view?.host) return null;
  const name = HOST_NAMES[setup.kind];
  return (
    <>
      <p class="notice notice-paused" role="status" id="setup-banner">
        {done ? (
          <><b>Saved.</b> Start Scope Soup again on this machine to read {name} and start agents{setup.missing.some((each) => each.startsWith("SCOPESOUP_")) ? `, with ${setup.missing.filter((each) => each.startsWith("SCOPESOUP_")).join(" and ")} set in its environment` : ""}.</>
        ) : (
          <><b>This machine is not set up for {name}</b> ({setup.missing.join(" and ")} missing), so it reads no Items and starts no agents. <button type="button" onClick={() => setOpen(true)}>Set up this machine for {name}</button></>
        )}
      </p>
      {open && (
        <ConnectDialog
          kind={setup.kind}
          join
          host={view.host}
          onClose={() => setOpen(false)}
          onConnected={() => {
            setOpen(false);
            setDone(true);
          }}
        />
      )}
    </>
  );
}
