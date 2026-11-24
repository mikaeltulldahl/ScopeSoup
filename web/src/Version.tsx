// Scope Soup's version on the board. The footer shows the version that runs and, when a newer release is known,
// "Scope Soup X.Y.Z is available". The Settings page has the panel: the check, the release's notes, Upgrade and Go back.

import { useEffect, useRef, useState } from "preact/hooks";
import type { UpgradeView } from "./api.ts";
import { fetchUpgrade, postUpgrade } from "./api.ts";
import { Markdown } from "./Markdown.tsx";

const INSTALLING = "https://github.com/mikaeltulldahl/scopesoup/blob/main/docs/RUNNING.md#installing-and-upgrading";
const ACTIVE = new Set(["downloading", "waiting", "switching", "restarting"]);

/** The upgrade view, read once and again every few seconds while a switch is under way (and the server restarts). */
function useUpgrade(): [UpgradeView | null, (next: UpgradeView) => void] {
  const [view, setView] = useState<UpgradeView | null>(null);
  // After a switch the server comes back as another version: the page is reloaded, so it is that version's board.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!view) return;
    if (seen.current !== null && seen.current !== view.version) location.reload();
    seen.current = view.version;
  }, [view?.version]);
  const active = view?.task !== null && view?.task !== undefined && ACTIVE.has(view.task.state);
  useEffect(() => {
    let gone = false;
    const read = () => fetchUpgrade().then((next) => !gone && next && setView(next), () => undefined);
    read();
    const timer = setInterval(read, active ? 2000 : 10 * 60_000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [active]);
  return [view, setView];
}

/** After an upgrade or a going back: what was started again, until it is dismissed or an hour has passed. */
export function UpgradeNote() {
  const [note, setNote] = useState<UpgradeView["note"]>(null);
  useEffect(() => {
    let gone = false;
    const read = () => fetchUpgrade().then((next) => !gone && next && setNote(next.note), () => undefined);
    read();
    const timer = setInterval(read, 30_000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, []);
  if (!note) return null;
  const dismiss = () => {
    setNote(null);
    postUpgrade("dismiss").catch(() => undefined);
  };
  return (
    <p class="notice notice-person upgrade-note" role="status" id="upgrade-note">
      {note.text}.{" "}
      <button type="button" onClick={dismiss}>Dismiss</button>
    </p>
  );
}

export function VersionFooter() {
  const [view] = useUpgrade();
  if (!view) return null;
  return (
    <footer class="version-footer">
      <span>Scope Soup {view.version}{view.install === "checkout" ? " (checkout)" : ""}</span>
      {view.available && view.latest && (
        <a class="version-available" href="#/settings">Scope Soup {view.latest.version} is available</a>
      )}
    </footer>
  );
}

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "never");

export function VersionPanel() {
  const [view, setView] = useUpgrade();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<"get" | "back" | null>(null);
  if (!view) return null;

  const act = (what: "check" | "get" | "back" | "cancel") => {
    setBusy(true);
    setError(null);
    setAsking(null);
    postUpgrade(what).then(setView, (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem))).finally(() => setBusy(false));
  };
  const task = view.task;
  const active = task !== null && ACTIVE.has(task.state);
  const latest = view.latest;

  return (
    <section class="panel version-panel" id="version">
      <div class="panel-head">
        <h3>Scope Soup {view.version}</h3>
        <a class="tag-link" href={INSTALLING} target="_blank" rel="noreferrer">Installing and upgrading</a>
      </div>
      <p class="muted">
        {view.install === "checkout" && "Runs from a development checkout."}
        {view.install === "release" && <>Runs from Scope Soup's home <code>{view.home}</code>.</>}
        {view.install === "folder" && "Runs from a release folder outside Scope Soup's home."}
        {" "}{view.checkOff ?? <>Last checked for a new release: {when(view.checkedAt)}.</>}
      </p>
      {view.checkProblem && <p class="notice notice-bad" role="alert">{view.checkProblem}</p>}

      {view.available && latest ? (
        <div class="version-new">
          <p class="notice version-notice" role="status">
            <b>Scope Soup {latest.version} is available.</b> Nothing changes until you press Upgrade.
            {latest.page && <> <a class="tag-link" href={latest.page} target="_blank" rel="noreferrer">The release</a></>}
          </p>
          {latest.notes.trim() && (
            <details class="version-notes" open>
              <summary>What is new in {latest.version}</summary>
              <Markdown text={latest.notes} />
            </details>
          )}
        </div>
      ) : null}

      {task && (
        <p class={`notice${task.state === "failed" ? " notice-bad" : ""} version-task`} role="status">
          {task.text}
          {task.state === "restarting" && " This page reloads by itself."}
        </p>
      )}
      {view.lastSwitch?.failedStart && (
        <p class="notice notice-bad" role="status">
          Scope Soup {view.lastSwitch.from.replace(/^scopesoup-/, "")} could not start, so {view.version} runs again.
        </p>
      )}

      <div class="form-actions version-actions">
        {view.available && latest ? (
          <button type="button" class="primary" disabled={busy || !view.getLatest.can} title={view.getLatest.why ?? ""} onClick={() => setAsking("get")}>
            Upgrade to {latest.version}
          </button>
        ) : (
          <button type="button" disabled={busy || view.checking || view.checkOff !== null} onClick={() => act("check")}>
            {view.checking ? "Checking…" : "Check now"}
          </button>
        )}
        {view.back && (
          <button type="button" disabled={busy || !view.back.can} title={view.back.why ?? ""} onClick={() => setAsking("back")}>
            {view.back.newer ? "Return to" : "Go back to"} {view.back.version}
          </button>
        )}
        {active && (task.state === "waiting" || task.state === "downloading") && (
          <button type="button" disabled={busy} onClick={() => act("cancel")}>Cancel</button>
        )}
      </div>
      {!view.getLatest.can && view.available && view.getLatest.why && <p class="muted">{view.getLatest.why}</p>}

      {asking && (
        <div class="notice version-confirm" role="dialog" aria-label="Switch Scope Soup">
          <p>
            {asking === "get"
              ? <>Upgrade to Scope Soup {latest?.version}: it is downloaded, checked and unpacked beside this version. Then agents and the merge queue are paused, Scope Soup waits until no session and no queue batch runs, copies the database and the config, and restarts on {latest?.version}. It comes back paused; this version stays for Go back.</>
              : <>Switch back to Scope Soup {view.back?.version}: agents and the merge queue are paused, Scope Soup waits until nothing runs and restarts on {view.back?.version}. It comes back paused.{view.lastSwitch?.backup ? <> If {view.version} changed the data's format, {view.back?.version} will not start on it: the copy from before the upgrade is in <code>{view.lastSwitch.backup}</code>.</> : null}</>}
          </p>
          <div class="form-actions">
            <button type="button" class="primary" disabled={busy} onClick={() => act(asking)}>{asking === "get" ? `Yes, upgrade to ${latest?.version}` : `Yes, switch to ${view.back?.version}`}</button>
            <button type="button" disabled={busy} onClick={() => setAsking(null)}>No</button>
          </div>
        </div>
      )}
      {error && <p class="notice notice-bad" role="alert">{error}</p>}
    </section>
  );
}
