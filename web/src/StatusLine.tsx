// The status line: runners, usage windows, the last sync. The lanes and the Merge queue page say what the queue does.

import type { StatusLine as Status } from "./api.ts";
import { useLive, useNow } from "./api.ts";
import { ago, clockTime, percent } from "./format.ts";

function Meter({ value }: { value: number }) {
  const level = value >= 0.9 ? "high" : value >= 0.75 ? "mid" : "low";
  return (
    <span class={`meter meter-${level}`} aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.round(value * 100))}%` }} />
    </span>
  );
}

export function StatusLine({ status }: { status: Status }) {
  const now = useNow();
  const live = useLive();
  const { runners, usage, sync } = status;
  return (
    <section class="status" aria-label="Status">
      <div class="status-group">
        <span class="status-name">Runners</span>
        {runners.total === 0 && <span class="muted">none known</span>}
        {runners.list.map((runner) => (
          <span class="status-item" key={runner.id}>
            <span class={`dot ${runner.online ? (runner.busy ? "dot-busy" : "dot-ok") : "dot-off"}`} aria-hidden="true" />
            <b>{runner.name}</b> <span class="num">{runner.words}</span>
          </span>
        ))}
      </div>
      <div class="status-group">
        <span class="status-name">Usage</span>
        {!usage && <span class="muted">not reported yet</span>}
        {usage?.windows.map((window) => (
          <span class="status-item" key={window.kind}>
            <b>{window.label}</b>{" "}
            {window.utilization === undefined ? (
              <span class="muted">unknown</span>
            ) : (
              <>
                <Meter value={window.utilization} />
                <span class="num">{percent(window.utilization)}</span>
              </>
            )}{" "}
            <span class="muted num">resets {clockTime(window.resetsAt, now)}</span>
            {window.forecast && <span class={`num ${window.forecast.outcome === "used_up" ? "" : "muted"}`}> · {window.forecast.words}</span>}
          </span>
        ))}
        {usage?.status === "rejected" && <span class="tag tag-blocked">limit reached</span>}
      </div>
      <div class="status-group">
        <span class="status-name">Sync</span>
        <span class="status-item">
          <span class={`dot ${sync.error ? "dot-bad" : live ? "dot-ok" : "dot-off"}`} aria-hidden="true" />
          <span class="num">{sync.lastAt ? ago(sync.lastAt, now) : "never"}</span>
          {!live && <span class="muted"> · reconnecting</span>}
        </span>
      </div>
      {status.idle && <p class="status-idle muted">{status.idle}</p>}
      {status.alerts.length > 0 && (
        <ul class="alerts">
          {status.alerts.map((alert) => (
            <li key={alert}>{alert}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
