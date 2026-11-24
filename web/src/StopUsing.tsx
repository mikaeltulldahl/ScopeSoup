// "Stop using Scope Soup", a page under Settings. First the reversible step (pausing is not leaving: Stop, or level 0), then
// everything Scope Soup left for this project, grouped as offboarding acts on it, each with what removing it does and its default.
// Read only: nothing is removed from here. The removal is the plugin skill /scopesoup:scopesoup-offboard or `pnpm offboard`.

import { useEffect, useState } from "preact/hooks";
import type { OffboardView } from "./api.ts";
import { fetchOffboard } from "./api.ts";

const OFFBOARDING = "https://github.com/mikaeltulldahl/scopesoup/blob/main/docs/ONBOARDING.md#offboarding";

export function StopUsing({ stopped, busy, onStop }: { stopped: boolean; busy: boolean; onStop: () => void }) {
  const [view, setView] = useState<OffboardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchOffboard().then(setView, (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem)));
  }, []);

  return (
    <div class="settings">
      <section class="panel stop-using">
        <div class="panel-head">
          <h3>Stop using Scope Soup</h3>
          <a class="tag-link" href="#/settings">Back to Settings</a>
        </div>
        <h4>Pausing is not leaving</h4>
        <p>
          To stop Scope Soup's work and keep everything, press Stop (it ends running sessions and pauses triage, implementors, review and the merge queue), or set level 0 on the Settings page.
          {" "}Both are undone with Resume on the lanes of the overview, or by raising the level. Nothing below is needed for that.
        </p>
        <p>
          <button type="button" class="stop" disabled={busy || stopped} onClick={onStop}>{stopped ? "Stopped" : "Stop"}</button>
        </p>
        <h4>Leaving</h4>
        <p class="muted">
          This is everything Scope Soup left for this project, as offboarding would act on it. Nothing is removed from this page: run the Claude Code skill
          {" "}<code>/scopesoup:scopesoup-offboard</code> in a session in the project, or <code>pnpm offboard</code> in Scope Soup's folder, after Scope Soup is stopped.
          {" "}Each group is removed only on its own yes, the Items are exported as Markdown files first, and the project's history (merged commits, closed issues and pull requests, comments) is never rewritten.
          {" "}<a class="tag-link" href={OFFBOARDING} target="_blank" rel="noreferrer">How offboarding works</a>
        </p>
      </section>
      {error && <p class="notice notice-bad" role="alert">{error}</p>}
      {!view && !error && <p class="empty">Looking at what Scope Soup left…</p>}
      {view && !view.available && <p class="notice">{view.reason}</p>}
      {view && view.available && (
        <>
          {view.plan.groups.map((group) => (
            <section key={group.group} class="panel stop-group">
              <h4>{group.title}</h4>
              <p class="muted">{group.intro}</p>
              {group.entries.length === 0 ? (
                <p class="empty">Nothing found.</p>
              ) : (
                <ul class="stop-entries">
                  {group.entries.map((entry) => {
                    const mark = entry.manual ? "you" : entry.action.do === "none" ? "kept" : entry.default;
                    return (
                      <li key={entry.key} class={`stop-entry stop-${mark}`}>
                        <span class="stop-mark">{mark === "you" ? "yours to do" : mark === "remove" ? "removed on a yes" : "kept"}</span>
                        <span class="stop-what">{entry.what}</span>
                        <span class="muted stop-then">
                          {entry.manual || entry.action.do === "none" ? entry.onRemove : `On removal: ${entry.onRemove}.`}
                          {entry.why && !entry.manual && entry.action.do !== "none" ? ` Kept by default: ${entry.why}.` : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
          <p class="muted">The Items, the patch for the project's files and the report go to <code>{view.outFolder}</code>, beside the config folder <code>{view.configFolder}</code>, so they outlive it.</p>
        </>
      )}
    </div>
  );
}
