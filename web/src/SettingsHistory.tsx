// The Settings page's "History of settings": every save of the project's shared settings, newest first, in plain
// words ("Models: triage Haiku", "Level 2 → 3"), from their log on the meta ref. Closed until opened.

import { useEffect, useRef } from "preact/hooks";
import { settingsWords } from "../../src/core/settingsWords.ts";
import { fetchSettingsLog, useView } from "./api.ts";
import { ago } from "./format.ts";

export function SettingsHistory({ open = false }: { open?: boolean }) {
  const { data, error } = useView(fetchSettingsLog, "settings-log");
  const box = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (open && box.current) {
      box.current.open = true;
      box.current.scrollIntoView({ block: "start" });
    }
  }, [open, data !== null]);
  const entries = data?.entries ?? [];
  return (
    <details class="panel settings-history" id="settings-history" ref={box}>
      <summary>
        <h3>History of settings</h3>
        {data && <span class="muted">{entries.length === 0 ? "no saves yet" : `${entries.length} save${entries.length === 1 ? "" : "s"}`}</span>}
      </summary>
      {error && <p class="notice notice-bad" role="alert">{error}</p>}
      {!data && !error && <p class="empty">Loading…</p>}
      {data && entries.length === 0 && <p class="empty">The project's settings have not been saved from a board yet.</p>}
      {entries.length > 0 && (
        <ol class="settings-log">
          {entries.map((entry, index) => {
            const words = settingsWords(entry.changes);
            return (
              <li key={`${entry.at}-${index}`}>
                <span class="muted" title={new Date(entry.at).toLocaleString("en-GB")}>{ago(entry.at, Date.parse(data!.now))} · </span>
                <b>{entry.who}</b>
                {entry.machine ? <span class="muted"> on {entry.machine}</span> : null}
                {words.length <= 1 ? <>: {words[0] ?? "no change"}</> : <ul>{words.map((each, n) => <li key={n}>{each}</li>)}</ul>}
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}
