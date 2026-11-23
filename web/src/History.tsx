// The project's history: the commit graph with branches as lanes, drawn as inline SVG beside each
// commit. A commit opens its message and files. Everything from git is shown as text.

import { useState } from "preact/hooks";
import type { CommitView, HistoryCommit, SettingsLogEntry } from "./api.ts";
import { fetchCommit, fetchHistory, fetchSettingsLog, useView } from "./api.ts";
import { ago } from "./format.ts";
import { DiffFiles } from "./Item.tsx";
import { itemHref } from "./route.ts";

const STEP = 14;
const ROW = 30;
const COLORS = ["#1f5f8b", "#b5651d", "#2e9d5b", "#8a4fa8", "#c0392b", "#177e89"];
const x = (lane: number) => 9 + lane * STEP;
const color = (lane: number) => COLORS[lane % COLORS.length]!;

/** One row's lines and dot. A line runs from a lane at the row's edge to a lane at its middle. */
function Graph({ commit, lanes }: { commit: HistoryCommit; lanes: number }) {
  const mid = ROW / 2;
  const { lane, top, bottom } = commit.graph;
  return (
    <svg class="hist-graph" width={x(lanes - 1) + 9} height={ROW} aria-hidden="true">
      {top.map((line, index) => (
        <path key={`t${index}`} d={`M${x(line.from)} 0 L${x(line.to)} ${mid}`} stroke={color(line.from)} stroke-width="2" fill="none" />
      ))}
      {bottom.map((line, index) => (
        <path key={`b${index}`} d={`M${x(line.from)} ${mid} L${x(line.to)} ${ROW}`} stroke={color(line.to)} stroke-width="2" fill="none" />
      ))}
      <circle cx={x(lane)} cy={mid} r={commit.parents.length > 1 ? 3 : 4.5} fill={commit.onMain ? color(lane) : "var(--surface)"} stroke={color(lane)} stroke-width="2" />
    </svg>
  );
}

function Opened({ sha }: { sha: string }) {
  const { data, error } = useView<CommitView>(() => fetchCommit(sha), `commit:${sha}`);
  if (error) return <p class="notice notice-bad">{error}</p>;
  if (!data) return <p class="muted">Loading…</p>;
  if (!data.available) return <p class="muted">{data.reason}</p>;
  return (
    <div class="hist-open">
      <pre class="hist-message">{data.message}</pre>
      <p class="muted num">
        {data.files.length + data.omitted} file{data.files.length + data.omitted === 1 ? "" : "s"} · +{data.totalAdded} −{data.totalRemoved}
      </p>
      <DiffFiles files={data.files} />
      {data.omitted > 0 && <p class="muted">{data.omitted} more files are not listed.</p>}
    </div>
  );
}

/** A value of a setting in a line: JSON, cut short. */
const shown = (value: unknown): string => {
  if (value === undefined) return "none";
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

/** Who changed which shared setting, newest first, from the settings' log on the meta ref. */
function SettingsChanges({ entries, now }: { entries: SettingsLogEntry[]; now: number }) {
  const [all, setAll] = useState(false);
  if (entries.length === 0) return null;
  const list = all ? entries : entries.slice(0, 5);
  return (
    <div class="settings-log">
      <h4>Settings changes</h4>
      <ul>
        {list.map((entry, index) => (
          <li key={`${entry.at}-${index}`}>
            <span class="muted">{ago(entry.at, now)} · </span>
            <b>{entry.who}</b>
            {entry.machine ? <span class="muted"> on {entry.machine}</span> : null}
            {": "}
            {entry.changes.map((change, n) => (
              <span key={change.key}>
                {n > 0 ? "; " : ""}
                <code>{change.key}</code> {shown(change.from)} → {shown(change.to)}
              </span>
            ))}
          </li>
        ))}
      </ul>
      {entries.length > list.length && <button type="button" onClick={() => setAll(true)}>Show all {entries.length}</button>}
    </div>
  );
}

export function History() {
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error } = useView(() => fetchHistory(limit), `history:${limit}`);
  const settings = useView(fetchSettingsLog, "settings-log");
  return (
    <section class="panel">
      <h3>History</h3>
      {settings.data && <SettingsChanges entries={settings.data.entries} now={Date.parse(settings.data.now)} />}
      {error && <p class="notice notice-bad" role="alert">{error}</p>}
      {!data && !error && <p class="empty">Loading…</p>}
      {data && !data.available && <p class="empty">{data.reason}</p>}
      {data && data.available && (
        <>
          <p class="muted">The newest {data.commits.length} commits of {data.mainBranch} and the item branches. A filled dot is on {data.mainBranch}.</p>
          <ol class="hist">
            {data.commits.map((commit) => (
              <li key={commit.sha} class="hist-row">
                <div class="hist-line">
                  <Graph commit={commit} lanes={data.lanes} />
                  <button type="button" class="hist-subject" aria-expanded={open === commit.sha} onClick={() => setOpen(open === commit.sha ? null : commit.sha)}>
                    {commit.subject || "(no message)"}
                  </button>
                </div>
                <div class="hist-meta muted">
                  <span class="num">{commit.sha.slice(0, 8)}</span> · {commit.author} · {ago(commit.at, Date.parse(data.now))}
                  {commit.refs.map((name) => (
                    <span class="hist-ref" key={name}>{name}</span>
                  ))}
                  {commit.item && (
                    <a href={itemHref(commit.item)}>{commit.merged ? "merged " : ""}{commit.item.split(":").pop()}</a>
                  )}
                </div>
                {open === commit.sha && <Opened sha={commit.sha} />}
              </li>
            ))}
          </ol>
          {data.more && (
            <button type="button" onClick={() => setLimit(Math.min(500, limit + 50))} disabled={limit >= 500}>
              Show more
            </button>
          )}
        </>
      )}
    </section>
  );
}
