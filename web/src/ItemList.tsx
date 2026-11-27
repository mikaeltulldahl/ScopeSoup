// The flat list of all items with search, filters and ready-made views. The filters live in the
// URL (#/items?lane=in-progress&label=bug), so a view can be bookmarked and shared.

import { useEffect, useRef, useState } from "preact/hooks";
import type { ItemListRow } from "./api.ts";
import { fetchItems, useNow, useView } from "./api.ts";
import { ago, dateOf, laneWord } from "./format.ts";
import { itemHref } from "./route.ts";
import { fill, itemNoun, words } from "./theme.ts";

const RECENT_KEY = "scopesoup.recentItems";
const RECENT_MAX = 30;

function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "null");
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
  } catch {
    return [];
  }
}

/** Notes that an item page was opened, for the "recently viewed" view. Kept in this browser only. */
export function rememberViewed(key: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...readRecent().filter((each) => each !== key)].slice(0, RECENT_MAX)));
  } catch {
    // Private mode: nothing is remembered.
  }
}

const VIEWS: { name: string; query: string }[] = [
  { name: "All", query: "" },
  { name: "Recently viewed", query: "view=recent" },
  { name: "Created by me", query: "createdBy=me" },
  { name: "Waiting for an answer", query: "turn=anyone" },
  { name: "Recently done", query: "lane=done&doneDays=14" },
];

/** The same filters in a fixed order, so two spellings of one view compare equal. */
const canonical = (query: string): string => [...new URLSearchParams(query)].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");

const LANE_FILTERS = ["backlog", "todo", "blocked", "in-progress", "in-review", "queued", "checking", "done", "abandoned"];
const TURNS = ["anyone", "person", "agent", "queue", "runner", "nobody"];
const PRIORITIES = ["blocker", "critical", "major", "minor"];

function Row({ row, now }: { row: ItemListRow; now: number }) {
  return (
    <li>
      <a class={`card tone-${row.tone}`} href={itemHref(row.key)}>
        <div class="card-head">
          <span class="ref num">{row.label}</span>
          <span class="card-title">{row.title}</span>
        </div>
        <p class="reason">{row.reason}</p>
        <div class="tags">
          <span class="tag">{laneWord(row.lane)}</span>
          {row.actor === "anyone" && <span class="tag tag-actor-yours">{words().turnYours}</span>}
          {row.priority && row.priority !== "major" && <span class={`tag tag-priority-${row.priority}`}>{row.priority}</span>}
          {row.holder && <span class="tag">held by {row.holder}</span>}
          {row.change && <span class="tag">change {row.change.label} {row.change.state}</span>}
          {row.labels.map((label) => (
            <span class="tag" key={label}>{label}</span>
          ))}
          <span class="when num">{ago(row.updatedAt, now)}</span>
          {row.lane === null && words().staleBadge && <span class="tag tag-stale">{fill(words().staleBadge, { date: dateOf(row.updatedAt) })}</span>}
        </div>
      </a>
    </li>
  );
}

export function ItemList({ query }: { query: string }) {
  const [params, setParams] = useState(() => new URLSearchParams(query));
  const timer = useRef<number | undefined>(undefined);
  const now = useNow();

  const change = (name: string, value: string, wait = 0) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next);
    window.clearTimeout(timer.current);
    // Typing does not fill the browser's history: the address is replaced, not added to.
    timer.current = window.setTimeout(() => history.replaceState(null, "", `#/items${next.size > 0 ? `?${next}` : ""}`), wait);
  };

  const text = params.toString();
  // "Recently viewed" is kept in this browser, so it is sent as the list of items to show.
  const sent = new URLSearchParams(params);
  if (sent.get("view") === "recent") {
    sent.delete("view");
    sent.set("keys", readRecent().join(",") || "none");
  }
  const { data, error } = useView(() => fetchItems(sent.toString()), `items:${sent}`);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const get = (name: string) => params.get(name) ?? "";
  const select = (name: string, title: string, options: string[], labelOf?: (option: string) => string) => (
    <label>
      {title}
      <select value={get(name)} onChange={(event) => change(name, event.currentTarget.value)}>
        <option value="">any</option>
        {options.map((option) => (
          <option key={option} value={option}>{labelOf ? labelOf(option) : option}</option>
        ))}
      </select>
    </label>
  );

  return (
    <section class="item-list-page" aria-label={`All ${itemNoun(true)}`}>
      <nav class="list-views" aria-label="Ready-made views">
        {VIEWS.map((view) => (
          <a key={view.name} href={`#/items${view.query ? `?${view.query}` : ""}`} aria-current={canonical(view.query) === canonical(text) ? "true" : undefined}>
            {view.name}
          </a>
        ))}
      </nav>
      <div class="list-filters">
        <label class="list-search">
          Search title, id and description
          <input type="search" value={get("q")} onInput={(event) => change("q", event.currentTarget.value, 300)} />
        </label>
        {select("lane", "State", LANE_FILTERS, (option) => (option === "abandoned" ? laneWord(null) : laneWord(option)))}
        {select("priority", "Priority", PRIORITIES)}
        {select("turn", "Whose turn", TURNS)}
        {select("label", "Label", data?.labels ?? (get("label") ? [get("label")] : []))}
        <label>
          Held by (name, or none)
          <input type="text" value={get("holder")} onInput={(event) => change("holder", event.currentTarget.value, 300)} />
        </label>
        {select("change", "Has a change", ["yes", "no"])}
        <label>
          Done in the last (days)
          <input type="number" min="0" value={get("doneDays")} onInput={(event) => change("doneDays", event.currentTarget.value, 300)} />
        </label>
      </div>
      {error && <p class="notice notice-bad" role="alert">{error}</p>}
      {!data && !error && <p class="empty">Loading…</p>}
      {data && (
        <>
          <p class="empty" role="status">
            {data.total} {itemNoun(data.total !== 1)}
            {data.total > data.items.length ? `, the ${data.items.length} most recently changed shown` : ""}          </p>
          <ul class="item-list">
            {data.items.map((row) => (
              <Row key={row.key} row={row} now={now} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
