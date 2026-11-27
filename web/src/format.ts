// Times and durations as a person reads them.

import { LANE_KEYS, words } from "./theme.ts";
import type { LaneKey } from "./theme.ts";

import type { DecisionOption } from "../../src/model/types.ts";

const isLaneKey = (lane: string): lane is LaneKey => (LANE_KEYS as readonly string[]).includes(lane);

/** "4:10", "1:02:05". */
export function clockSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "40 s", "14 min", "3 h", "2 d". */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export function ago(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "" : `${span(now - at)} ago`;
}

/** "13:10" today, "Thu 13:10" on another day. */
export function clockTime(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay ? time : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** "12 Nov". */
export const dateOf = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString([], { day: "numeric", month: "short" });
};

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

/** The Queue page's "Recent flaky tests": the newest `limit` entries, each with its test and how often it failed. */
export function flakyRows(flaky: readonly { test: string; count: number; at: string }[] | undefined, limit = 10): { test: string; count: number; at: string; times: string }[] {
  return (flaky ?? []).slice(0, limit).map((entry) => ({ ...entry, times: entry.count === 1 ? "1 time" : `${entry.count} times` }));
}

/** Item states as the board words them (the theme's words). The stored value stays `todo` etc.; only the label differs. */
export function stateLabel(state: string): string {
  const theme = words();
  const labels: Record<string, string> = { todo: theme.lanes.todo, doing: theme.lanes["in-progress"], waiting: "Waiting", done: theme.lanes.done, abandoned: theme.abandoned, open: "Open" };
  return labels[state] ?? state;
}

/** Where a hold came from, in words; empty when the claim does not say. */
export const fromWords = (from: string | undefined): string => (from === "claude-code" ? "from a Claude Code session" : from ? `from ${from}` : "");

/** Lanes as the overview's columns word them: the theme's words (the default theme's are the core's LANE_TITLES). */
export const laneLabel = (lane: string): string => (isLaneKey(lane) ? words().lanes[lane] : lane.replace(/-/g, " "));

/** A lane's glyph in the theme, with a space after it; "" for none. */
export const laneIcon = (lane: string | null): string => {
  const theme = words();
  const glyph = lane === null ? theme.abandonedIcon : isLaneKey(lane) ? theme.laneIcons[lane] : "";
  return glyph ? `${glyph} ` : "";
};

/** The word for an Item's lane on a tag, the State line and the list's lane filter; no lane means abandoned. */
export const laneWord = (lane: string | null): string => (lane ? laneLabel(lane) : words().abandoned);

/** The Item page's State line: the lane's word, and the host's own state only where it differs from the lane. */
export function stateFacts(lane: string | null, hostState: string, differs: boolean): { state: string; host: string | null } {
  return { state: laneWord(lane), host: differs ? hostState : null };
}

/** One option of a decision as a row: a short label and, in lighter text under it, what choosing it means. */
export type OptionRow = { label: string; description: string; recommended: boolean; answer: string };

/** A recommendation that marks no row, to show as a grey note ("Recommended: …"); null when there is none or a row carries it. */
export function unmatchedRecommendation(rows: readonly OptionRow[], recommendation?: string): string | null {
  const text = (recommendation ?? "").trim();
  return text !== "" && !rows.some((row) => row.recommended) ? text : null;
}

/**
 * The rows of a decision, the recommended one first. An option is `{ label, description }`; an older plain
 * text one is shown whole as the label. The recommendation matches a row by its label or text (case aside),
 * else by its start: a recommendation that opens with a label ("Keep it, because ...") marks that row.
 * One that matches no row is not made a row of its own: the options are what can be picked.
 * `answer` is what is sent when the row is picked: the label, or the plain text.
 */
export function optionRows(options: readonly DecisionOption[], recommendation?: string): OptionRow[] {
  const rows: OptionRow[] = options.map((option) =>
    typeof option === "string"
      ? { label: option.trim(), description: "", recommended: false, answer: option }
      : { label: option.label, description: option.description, recommended: false, answer: option.description ? `${option.label}: ${option.description}` : option.label });
  const wanted = (recommendation ?? "").trim().toLowerCase();
  if (wanted === "") return rows;
  let at = rows.findIndex((row) => row.answer.trim().toLowerCase() === wanted || row.label.toLowerCase() === wanted);
  if (at < 0) {
    // The longest label the recommendation starts with, at a word end.
    let best = 0;
    rows.forEach((row, index) => {
      const label = row.label.toLowerCase();
      if (label.length > best && wanted.startsWith(label) && !/[a-z0-9]/.test(wanted[label.length] ?? " ")) (at = index), (best = label.length);
    });
  }
  if (at < 0) return rows;
  const [found] = rows.splice(at, 1);
  return [{ ...found!, recommended: true }, ...rows];
}
