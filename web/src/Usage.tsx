// Who used the usage windows: a stacked bar over time and a table per role, from /api/usage.
// Inline SVG and CSS only. Every number says how it was split (alone, run time or tokens).

import { useState } from "preact/hooks";
import type { UsageView } from "./api.ts";
import { fetchUsage, useView } from "./api.ts";
import { clockTime } from "./format.ts";

type Window = UsageView["windows"][number];
type Key = keyof Window["shares"];

const ORDER: Key[] = ["implement", "review", "triage", "outside"];
const COLORS: Record<Key, string> = {
  implement: "#1f5f8b",
  review: "#8a4fa8",
  triage: "#2e9d5b",
  outside: "#9aa0a8",
};
const LABEL: Record<Key, string> = { implement: "Implement", review: "Review", triage: "Triage", outside: "Outside Scope Soup" };
const SPANS = [
  { id: "5h", label: "5 hours" },
  { id: "1d", label: "1 day" },
  { id: "7d", label: "Week" },
  { id: "30d", label: "30 days" },
];
const METHOD = { session: "one session ran", runtime: "split by run time", tokens: "split by tokens", outside: "no session ran" } as const;

const pct = (share: number) => `${(share * 100).toFixed(share >= 0.095 ? 0 : 1)} %`;

function Bars({ window, now }: { window: Window; now: number }) {
  const W = 300;
  const H = 110;
  const peak = Math.max(0.01, ...window.buckets.map((bucket) => ORDER.reduce((sum, key) => sum + (bucket.parts[key] ?? 0), 0)));
  const step = W / window.buckets.length;
  const first = window.buckets[0]?.from;
  return (
    <figure class="usage-fig">
      <svg viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label="Usage over time, stacked by role" preserveAspectRatio="none" class="usage-svg">
        <line x1="0" y1={H} x2={W} y2={H} stroke="var(--line)" />
        {window.buckets.map((bucket, index) => {
          let y = H;
          return (
            <g key={bucket.from}>
              <title>{`${clockTime(bucket.from, now)}: ${ORDER.filter((key) => bucket.parts[key]).map((key) => `${LABEL[key]} ${pct(bucket.parts[key]!)}`).join(", ") || "nothing"}`}</title>
              {ORDER.map((key) => {
                const part = bucket.parts[key] ?? 0;
                if (part <= 0) return null;
                const height = (part / peak) * (H - 4);
                y -= height;
                return <rect key={key} x={index * step + 0.5} y={y} width={Math.max(1, step - 1)} height={height} fill={COLORS[key]} />;
              })}
            </g>
          );
        })}
        <text x="0" y={H + 11} class="usage-axis">{first ? clockTime(first, now) : ""}</text>
        <text x={W} y={H + 11} text-anchor="end" class="usage-axis">now</text>
      </svg>
      <figcaption class="muted">Tallest bar: {pct(peak)} of the window.</figcaption>
    </figure>
  );
}

function WindowBlock({ window, now }: { window: Window; now: number }) {
  const title = window.kind === "five_hour" ? "5-hour window" : "Weekly window";
  if (window.readings < 2 || window.total <= 0) {
    return (
      <section class="panel">
        <h3>{title}</h3>
        <p class="empty">{window.readings < 2 ? "Too few readings in this span." : "No use in this span."}</p>
      </section>
    );
  }
  const rows = ORDER.filter((key) => window.shares[key] > 0);
  return (
    <section class="panel">
      <h3>{title}</h3>
      <p class="num">
        <b>{pct(window.total)}</b> of the window used
        {window.resets > 0 && <span class="muted"> · reset {window.resets}×</span>}
      </p>
      <Bars window={window} now={now} />
      <table class="usage-table">
        <thead>
          <tr>
            <th scope="col">Who</th>
            <th scope="col" class="num">Share</th>
            <th scope="col" class="num">Of use</th>
            <th scope="col" class="num">Sessions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((key) => (
            <tr key={key}>
              <th scope="row">
                <span class="usage-dot" style={{ background: COLORS[key] }} /> {LABEL[key]}
              </th>
              <td class="num">{pct(window.shares[key])}</td>
              <td class="num">{pct(window.shares[key] / window.total)}</td>
              <td class="num">{key === "outside" ? "" : window.sessions[key]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="muted usage-methods">
        How it was split:{" "}
        {(Object.keys(METHOD) as (keyof typeof METHOD)[])
          .filter((method) => window.methods[method] > 0)
          .map((method) => `${METHOD[method]} ${pct(window.methods[method] / window.total)}`)
          .join(", ")}
        .
      </p>
    </section>
  );
}

export function Usage() {
  const [span, setSpan] = useState("7d");
  const { data, error } = useView(() => fetchUsage(span), `usage:${span}`);
  const now = data ? Date.parse(data.now) : Date.now();
  return (
    <section class="usage">
      <div class="panel">
        <h3>Usage by role</h3>
        <div class="usage-spans" role="group" aria-label="Span">
          {SPANS.map((each) => (
            <button type="button" key={each.id} class={each.id === span ? "primary" : ""} aria-pressed={each.id === span} onClick={() => setSpan(each.id)}>
              {each.label}
            </button>
          ))}
        </div>
        {error && <p class="notice notice-bad" role="alert">{error}</p>}
        {!data && !error && <p class="empty">Loading…</p>}
        {data && (
          <p class="muted">
            {data.sessions} session{data.sessions === 1 ? "" : "s"} ran in this span, {data.withTokens} with token counts. Use while no session ran counts as outside Scope Soup.
          </p>
        )}
      </div>
      {data && data.windows.map((window) => <WindowBlock key={window.kind} window={window} now={now} />)}
    </section>
  );
}
