// Settings' "Connect to GitHub Issues" and "Connect to Jira" (#127): a dialog that asks what the host needs, lets the server check
// it (the configuration, the token from the environment, one look at the host) and say what connecting would do, and only then
// connects. The token is never asked for here: the server says which variable to set when it is missing.

import { useState } from "preact/hooks";
import { Dialog } from "./Dialog.tsx";
import { type ConfigView, postConnect } from "./api.ts";

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

function bodyOf(kind: ConnectKind, fields: Fields): Record<string, unknown> {
  if (kind === "github") return { kind, repo: fields.repo, write: fields.write };
  return {
    kind, site: fields.site, project: fields.project, deployment: fields.deployment, write: fields.write,
    ...(fields.deployment === "cloud" ? { email: fields.email } : {}),
    filter: fields.filter,
    components: fields.components.split(",").map((each) => each.trim()).filter((each) => each !== ""),
  };
}

export function ConnectDialog({ kind, onClose, onConnected }: { kind: ConnectKind; onClose: () => void; onConnected: (view: ConfigView, shared: string | undefined) => void }) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [busy, setBusy] = useState(false);
  // What the server said about these fields: the plan, and what stands in the way. Cleared by any edit.
  const [plan, setPlan] = useState<{ lines: string[]; problems: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = kind === "github" ? "Connect to GitHub Issues" : "Connect to Jira";
  const set = (patch: Partial<Fields>) => {
    setFields({ ...fields, ...patch });
    setPlan(null);
    setError(null);
  };
  const send = (confirm: boolean) => {
    setBusy(true);
    setError(null);
    postConnect({ ...bodyOf(kind, fields), confirm }).then(
      (answer) => {
        setBusy(false);
        if (answer.done && answer.view) onConnected(answer.view, answer.shared);
        else setPlan({ lines: answer.lines, problems: answer.problems });
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
  return (
    <Dialog label={title} onClose={onClose} focusSelector="input" keepOnOutsideClick>
      <h3 class="dialog-title">{title}</h3>
      <form
        class="item-form connect-form"
        onSubmit={(event) => {
          event.preventDefault();
          send(false);
        }}
      >
        {kind === "github" ? (
          <>
            <p class="muted">The project's Items become the repository's issues. The token is read from <code>SCOPESOUP_GITHUB_TOKEN</code> in the environment Scope Soup runs in; it is not asked for here.</p>
            {input("repo", "Repository", "owner/name")}
          </>
        ) : (
          <>
            <p class="muted">The project's Items become the Jira project's issues. The token is read from <code>SCOPESOUP_JIRA_TOKEN</code> in the environment Scope Soup runs in; it is not asked for here.</p>
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
        <label class="resource-check">
          <input type="checkbox" checked={fields.write} disabled={busy} onChange={(event) => set({ write: (event.target as HTMLInputElement).checked })} />
          {" "}Let Scope Soup write ({kind === "github" ? "issues, labels and comments" : "issues, comments, labels and properties"}); off: it only shows them, and the level must be 0 (Watch)
        </label>
        {plan && plan.problems.length > 0 && (
          <div class="notice notice-bad" role="alert">
            <b>Not connected:</b>
            <ul>{plan.problems.map((each) => <li key={each}>{each}</li>)}</ul>
          </div>
        )}
        {plan && plan.problems.length === 0 && (
          <div class="notice connect-plan" role="status">
            <b>Connecting would:</b>
            <ul>{plan.lines.map((each) => <li key={each}>{each}</li>)}</ul>
          </div>
        )}
        {error && <pre class="notice notice-bad settings-errors" role="alert">{error}</pre>}
        <div class="form-actions">
          {plan && plan.problems.length === 0 ? (
            <button type="button" class="primary" disabled={busy} onClick={() => send(true)}>{busy ? "Connecting…" : "Connect"}</button>
          ) : (
            <button type="submit" class="primary" disabled={busy}>{busy ? "Checking…" : "Check"}</button>
          )}
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
