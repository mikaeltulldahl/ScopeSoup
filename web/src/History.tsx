// The project's history: an activity timeline (what happened, newest first, grouped by day, with filters by Item,
// person or agent and kind), then the commits of the main branch and the item branches with the lane graph drawn as
// inline SVG. Rows link to their Items; a commit opens its message and files. Everything from people, agents and git is
// shown as text.

import { useState } from "preact/hooks";
import { foldSessions } from "../../src/core/activity.ts";
import type { ActivityKind, ActivityRow, ActivityView, CommitView, FoldedActivityRow, HistoryCommit } from "./api.ts";
import { fetchActivity, fetchCommit, fetchHistory, useView } from "./api.ts";
import { ago } from "./format.ts";
import { DiffFiles } from "./Item.tsx";
import { itemHref } from "./route.ts";

const STEP = 14;
const ROW = 30;
const COLORS = ["#1f5f8b", "#b5651d", "#2e9d5b", "#8a4fa8", "#c0392b", "#177e89"];
const x = (lane: number) => 9 + lane * STEP;
const color = (lane: number) => COLORS[lane % COLORS.length]!;
/** Rows of the timeline and commits shown at first, and added by "Show older". */
const ROWS_PAGE = 60;
const COMMITS_PAGE = 30;

/** The kinds in the filter and on each row. */
const KINDS: [ActivityKind, string][] = [
  ["item", "Items"],
  ["triage", "Triage drafts"],
  ["question", "Questions"],
  ["decision", "Decisions"],
  ["session", "Sessions"],
  ["merge", "Merges"],
  ["batch", "Merge queue"],
  ["switch", "Switches"],
  ["upgrade", "Upgrades"],
  ["settings", "Settings"],
];
const KIND_WORD: Record<ActivityKind, string> = { item: "Item", triage: "triage", question: "question", decision: "decision", session: "session", merge: "merge", batch: "batch", switch: "switch", upgrade: "upgrade", settings: "settings" };

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

const dayKey = (iso: string): string => {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

/** "Today", "Yesterday", "Mon 23 Nov", with the year when it is not this one. */
function dayName(iso: string, now: number): string {
  const date = new Date(iso);
  if (dayKey(iso) === dayKey(new Date(now).toISOString())) return "Today";
  if (dayKey(iso) === dayKey(new Date(now - 24 * 3600_000).toISOString())) return "Yesterday";
  const year = date.getFullYear() !== new Date(now).getFullYear();
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
}
const clock = (iso: string): string => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function Row({ row, nested }: { row: FoldedActivityRow; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li class={`act-row${row.tone ? ` act-${row.tone}` : ""}`}>
      <time class="act-time num" dateTime={row.at} title={new Date(row.at).toLocaleString("en-GB")}>{clock(row.at)}</time>
      <span class="act-kind">{KIND_WORD[row.kind]}</span>
      <div class="act-body">
        <span class={`act-who${row.agent ? " act-agent" : ""}`}>{row.who}</span>{" "}
        <span class="act-text">{row.text}</span>
        {row.kind === "settings" && <> <a class="tag-link act-more" href="#/settings/history">History of settings</a></>}
        {!nested && row.items.map((item) =>
          item.gone ? (
            <span key={item.key} class="act-item act-gone" title="No such Item is known here any more.">#{item.id}</span>
          ) : (
            <a key={item.key} class="act-item" href={itemHref(item.key)}>
              #{item.id}{item.title ? ` ${item.title}` : ""}
            </a>
          ),
        )}
        {row.detail && <p class="act-detail">{row.detail}</p>}
        {row.folded && (
          <>
            {" "}
            <button type="button" class="act-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Hide the sessions" : "Show the sessions"}
            </button>
            {open && <ol class="act-rows act-folded">{[...row.folded].reverse().map((each) => <Row key={each.id} row={each} nested />)}</ol>}
          </>
        )}
      </div>
    </li>
  );
}

function Activity() {
  const { data, error } = useView<ActivityView>(fetchActivity, "activity");
  const [item, setItem] = useState("");
  const [who, setWho] = useState("");
  const [kind, setKind] = useState("");
  const [noSessions, setNoSessions] = useState(false);
  const [shown, setShown] = useState(ROWS_PAGE);
  if (error) return <p class="notice notice-bad" role="alert">{error}</p>;
  if (!data) return <p class="empty">Loading…</p>;
  const now = Date.parse(data.now);

  const items = new Map<string, string>();
  for (const row of data.rows) for (const each of row.items) if (!items.has(each.key)) items.set(each.key, `#${each.id}${each.title ? ` ${each.title}` : ""}`);
  const itemOptions = [...items].sort((a, b) => b[1].localeCompare(a[1], "en", { numeric: true }));
  const people = [...new Set(data.rows.filter((row) => !row.agent).map((row) => row.who))].sort();
  const agents = [...new Set(data.rows.filter((row) => row.agent).map((row) => row.who))].sort();
  const kinds = KINDS.filter(([name]) => data.rows.some((row) => row.kind === name));

  const matching = data.rows.filter((row) => (!item || row.items.some((each) => each.key === item)) && (!who || row.who === who) && (!kind || row.kind === kind) && !(noSessions && row.kind === "session"));
  const entries = foldSessions(matching);
  const page = entries.slice(0, shown);
  const days: { key: string; name: string; rows: FoldedActivityRow[] }[] = [];
  for (const row of page) {
    const key = dayKey(row.at);
    const last = days.at(-1);
    if (last?.key === key) last.rows.push(row);
    else days.push({ key, name: dayName(row.at, now), rows: [row] });
  }
  const filtered = item !== "" || who !== "" || kind !== "" || noSessions;
  const pick = (set: (value: string) => void) => (event: Event) => {
    set((event.currentTarget as HTMLSelectElement).value);
    setShown(ROWS_PAGE);
  };

  return (
    <div class="act">
      <div class="list-filters act-filters">
        <label>
          Item
          <select value={item} onChange={pick(setItem)}>
            <option value="">Every Item</option>
            {itemOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label>
          Person or agent
          <select value={who} onChange={pick(setWho)}>
            <option value="">Everyone</option>
            {people.length > 0 && <optgroup label="People">{people.map((name) => <option key={name} value={name}>{name}</option>)}</optgroup>}
            {agents.length > 0 && <optgroup label="Agents and Scope Soup">{agents.map((name) => <option key={name} value={name}>{name}</option>)}</optgroup>}
          </select>
        </label>
        <label>
          Kind
          <select value={kind} onChange={pick(setKind)}>
            <option value="">Every kind</option>
            {kinds.map(([name, label]) => <option key={name} value={name}>{label}</option>)}
          </select>
        </label>
        <label class="act-nosessions">
          <input type="checkbox" checked={noSessions} onChange={(event) => { setNoSessions((event.currentTarget as HTMLInputElement).checked); setShown(ROWS_PAGE); }} />
          Everything but sessions
        </label>
        {filtered && (
          <button type="button" class="act-clear" onClick={() => { setItem(""); setWho(""); setKind(""); setNoSessions(false); setShown(ROWS_PAGE); }}>
            Clear filters
          </button>
        )}
      </div>
      {data.rows.length === 0 && <p class="empty">Nothing has happened yet. Items, sessions, merges and switches show here as they happen.</p>}
      {data.rows.length > 0 && matching.length === 0 && <p class="empty">Nothing matches these filters.</p>}
      {days.map((day) => (
        <section key={day.key} class="act-day">
          <h4>{day.name}</h4>
          <ol class="act-rows">
            {day.rows.map((row) => <Row key={row.id} row={row} />)}
          </ol>
        </section>
      ))}
      {entries.length > page.length && (
        <button type="button" onClick={() => setShown(shown + ROWS_PAGE)}>
          Show older ({entries.length - page.length} more)
        </button>
      )}
      {data.more && entries.length <= page.length && <p class="muted">Older activity is not shown.</p>}
    </div>
  );
}

function Commits() {
  const [limit, setLimit] = useState(COMMITS_PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error } = useView(() => fetchHistory(limit), `history:${limit}`);
  if (error) return <p class="notice notice-bad" role="alert">{error}</p>;
  if (!data) return <p class="empty">Loading…</p>;
  if (!data.available) return <p class="empty">{data.reason}</p>;
  const now = Date.parse(data.now);
  return (
    <>
      <p class="muted">
        The newest {data.commits.length} commits of {data.mainBranch} and the item branches. A filled dot is on {data.mainBranch}; a commit an Item merged links to it.
      </p>
      <ol class="hist">
        {data.commits.map((commit) => {
          const starts = new Set(commit.starts ?? []);
          return (
            <li key={commit.sha} class="hist-row">
              <div class="hist-line">
                <Graph commit={commit} lanes={data.lanes} />
                <button type="button" class="hist-subject" aria-expanded={open === commit.sha} onClick={() => setOpen(open === commit.sha ? null : commit.sha)}>
                  {commit.subject || "(no message)"}
                </button>
              </div>
              <div class="hist-meta muted">
                <span class="num">{commit.sha.slice(0, 8)}</span> · {commit.author} · {ago(commit.at, now)}
                {commit.refs.map((name) =>
                  starts.has(name) ? (
                    <span class="hist-ref hist-ref-start" key={name} title="The branch starts here: it has no commits of its own yet, and nothing of it is merged.">{name} starts here</span>
                  ) : (
                    <span class="hist-ref" key={name}>{name}</span>
                  ),
                )}
                {commit.item && (
                  <a href={itemHref(commit.item)}>{commit.merged ? "merged " : ""}#{commit.item.split(":").pop()}</a>
                )}
              </div>
              {open === commit.sha && <Opened sha={commit.sha} />}
            </li>
          );
        })}
      </ol>
      {data.more && (
        <button type="button" onClick={() => setLimit(Math.min(500, limit + COMMITS_PAGE))} disabled={limit >= 500}>
          Show {COMMITS_PAGE} older commits
        </button>
      )}
    </>
  );
}

export function History() {
  return (
    <section class="panel history-page">
      <h3>History</h3>
      <Activity />
      <h3 class="hist-commits-head">Commits</h3>
      <Commits />
    </section>
  );
}
