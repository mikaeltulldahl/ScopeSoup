// The Usage page, from /api/usage: how full each usage window is now (with the reserve and the forecast), a line plot per
// window of how full it got over the span by who used it, and who used how much. Inline SVG and CSS only; the maths (plot
// points, forecast line, ticks, stacking) is in src/core/usage.ts.

import { useEffect, useRef, useState } from "preact/hooks";
import type { UsagePageWindow, UsageView } from "./api.ts";
import { fetchUsage, useView } from "./api.ts";
import { clockTime, span as spanWords } from "./format.ts";
import { stackPlot, timeTicks, usageParts } from "../../src/core/usage.ts";
import type { UsageKey, UsagePlotKey } from "../../src/core/usage.ts";

/** Bottom to top in the plot, top to bottom in the table. */
const ROLES: UsageKey[] = ["implement", "review", "triage", "outside"];
const STACK: UsagePlotKey[] = ["earlier", ...ROLES];
const COLOR: Record<UsagePlotKey, string> = {
  earlier: "var(--line)",
  implement: "var(--use-implement)",
  review: "var(--use-review)",
  triage: "var(--use-triage)",
  outside: "var(--use-outside)",
};
const LABEL: Record<UsagePlotKey, string> = { earlier: "Before the readings", implement: "Implement", review: "Review", triage: "Triage", outside: "Outside Scope Soup" };
/** The plot's direct labels are short: the table spells them out. */
const SHORT: Record<UsagePlotKey, string> = { ...LABEL, earlier: "Earlier", outside: "Outside" };
const SPANS = [
  { id: "5h", label: "5 hours" },
  { id: "1d", label: "1 day" },
  { id: "7d", label: "week" },
  { id: "30d", label: "30 days" },
];
const METHOD = { session: "one session ran", runtime: "split by run time", tokens: "split by tokens", outside: "no session ran" } as const;
const TITLE = { five_hour: "5-hour window", seven_day: "Weekly window" } as const;

const pct = (share: number) => `${(share * 100).toFixed(share >= 0.095 || share === 0 ? 0 : 1)} %`;

/** The element's width in CSS pixels, kept up to date. */
function useWidth(): [{ current: HTMLDivElement | null }, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function Meter({ window, now }: { window: UsagePageWindow; now: number }) {
  const current = window.current;
  const limit = window.reserve === undefined ? undefined : 1 - window.reserve;
  if (!current) {
    return (
      <div class="usage-meter">
        <div class="usage-meter-head"><b>{TITLE[window.kind]}</b></div>
        <p class="empty">No reading yet.</p>
      </div>
    );
  }
  const used = Math.min(1, current.utilization);
  const over = limit !== undefined && used >= limit;
  const resetsIn = Date.parse(current.resetsAt) - now;
  return (
    <div class="usage-meter">
      <div class="usage-meter-head">
        <b>{TITLE[window.kind]}</b>
        <span><b class="usage-big">{pct(current.utilization)}</b> used</span>
      </div>
      <div class="usage-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label={`${TITLE[window.kind]} used`}>
        {limit !== undefined && <div class="usage-track-reserve" style={{ left: `${limit * 100}%` }} />}
        <div class={`usage-track-fill${over ? " over" : ""}`} style={{ width: `${used * 100}%` }} />
        {limit !== undefined && <div class="usage-track-mark" style={{ left: `${limit * 100}%` }} title={`Reserve: Scope Soup starts nothing from ${pct(limit)}`} />}
      </div>
      <ul class="usage-facts">
        <li>{resetsIn > 0 ? `Resets ${clockTime(current.resetsAt, now)} (in ${spanWords(resetsIn)})` : `Reset due ${clockTime(current.resetsAt, now)}`}</li>
        {current.forecast && <li class={current.forecast.outcome === "used_up" ? "usage-warn" : ""}>Forecast: {current.forecast.words}</li>}
        {limit !== undefined && <li>Reserve: Scope Soup starts nothing from {pct(limit)}</li>}
      </ul>
    </div>
  );
}

interface Label {
  y: number;
  text: string;
  color?: string;
  dashed?: boolean;
}

/** Moves labels apart so none overlaps the next, keeping them inside [top, bottom]. */
function spread(labels: Label[], gap: number, top: number, bottom: number): Label[] {
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  for (let i = 0; i < sorted.length; i++) sorted[i]!.y = Math.max(sorted[i]!.y, i === 0 ? top : sorted[i - 1]!.y + gap);
  for (let i = sorted.length - 1; i >= 0; i--) sorted[i]!.y = Math.min(sorted[i]!.y, i === sorted.length - 1 ? bottom : sorted[i + 1]!.y - gap);
  return sorted;
}

const H = 190;
const M = { top: 18, right: 96, bottom: 24, left: 42 };

function Plot({ window, from, to }: { window: UsagePageWindow; from: number; to: number }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const plot = window.plot;
  const line = window.forecastLine;
  // Room after now for the forecast, up to half the span; a reset further away is cut off at the edge.
  const resetAt = line.length > 0 ? Date.parse(line[line.length - 1]!.at) : to;
  const end = Math.max(to, Math.min(resetAt, to + (to - from) / 2));
  const inner = Math.max(10, width - M.left - M.right);
  const x = (ms: number) => M.left + ((ms - from) / (end - from)) * inner;
  const y = (share: number) => M.top + (1 - Math.min(1.05, share)) * (H - M.top - M.bottom);
  const times = plot.points.map((point) => Date.parse(point.at));
  const bands = stackPlot(plot.points, STACK);
  const first = plot.firstAt ? Math.max(from, Date.parse(plot.firstAt)) : to;
  const limit = window.reserve === undefined ? undefined : 1 - window.reserve;
  const ticks = width > 0 ? timeTicks(from, end, Math.max(2, Math.floor(inner / 72)), (ms) => -new Date(ms).getTimezoneOffset() * 60_000) : [];
  const total = (index: number) => bands.at(-1)?.hi[index] ?? 0;

  // Direct labels at the right: each band at its middle now, and the forecast at its end.
  const last = plot.points.length - 1;
  const labels: Label[] = last < 0 ? [] : bands.filter((band) => band.hi[last]! - band.lo[last]! > 0.001).map((band) => ({ y: y((band.lo[last]! + band.hi[last]!) / 2), text: SHORT[band.key], color: COLOR[band.key] }));
  let forecastEnd: number | undefined;
  if (line.length > 1) {
    // The forecast's level at the plot's edge: at its end, or where the edge cuts it.
    for (let i = 1; i < line.length; i++) {
      const a = Date.parse(line[i - 1]!.at);
      const b = Date.parse(line[i]!.at);
      if (end <= b || i === line.length - 1) {
        const share = b > a ? Math.min(1, Math.max(0, (Math.min(end, b) - a) / (b - a))) : 1;
        forecastEnd = line[i - 1]!.value + (line[i]!.value - line[i - 1]!.value) * share;
        break;
      }
    }
    if (forecastEnd !== undefined) labels.push({ y: y(forecastEnd), text: "Forecast", dashed: true });
  }
  const placed = spread(labels, 14, M.top + 4, H - M.bottom);

  const onMove = (event: MouseEvent) => {
    const box = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    const at = from + ((event.clientX - box.left - M.left) / inner) * (end - from);
    if (times.length === 0 || at < first || at > to) return setHover(null);
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i]! - at) < Math.abs(times[best]! - at)) best = i;
    setHover(best);
  };
  const hovered = hover === null ? undefined : plot.points[hover];

  return (
    <div class="usage-plot" ref={ref}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={`How full the ${TITLE[window.kind]} got over time, by who used it`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <clipPath id={`clip-${window.kind}`}>
              <rect x={M.left} y={0} width={inner} height={H} />
            </clipPath>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((share) => (
            <g key={share}>
              <line class="usage-grid" x1={M.left} x2={M.left + inner} y1={y(share)} y2={y(share)} />
              <text class="usage-tick" x={M.left - 6} y={y(share) + 4} text-anchor="end">{share * 100} %</text>
            </g>
          ))}
          {ticks.map((tick) => (
            <g key={tick.at}>
              <line class="usage-grid" x1={x(tick.at)} x2={x(tick.at)} y1={M.top} y2={H - M.bottom} />
              <text class="usage-tick" x={x(tick.at)} y={H - 6} text-anchor="middle">{tick.label}</text>
            </g>
          ))}
          {first > from && (
            <g>
              <rect class="usage-none" x={x(from)} y={M.top} width={Math.max(0, x(first) - x(from))} height={H - M.top - M.bottom} />
              {x(first) - x(from) > 70 && (
                <text class="usage-tick" x={(x(from) + x(first)) / 2} y={(M.top + H - M.bottom) / 2} text-anchor="middle">no readings</text>
              )}
            </g>
          )}
          <g clip-path={`url(#clip-${window.kind})`}>
            {bands.map((band) => {
              const top = times.map((at, i) => `${x(at).toFixed(1)},${y(band.hi[i]!).toFixed(1)}`);
              const bottom = times.map((at, i) => `${x(at).toFixed(1)},${y(band.lo[i]!).toFixed(1)}`).reverse();
              return <polygon key={band.key} class={`usage-band${band.key === "earlier" ? " earlier" : ""}`} points={[...top, ...bottom].join(" ")} fill={COLOR[band.key]} />;
            })}
            {times.length > 0 && <polyline class={`usage-total${times.length > inner / 3 ? " dense" : ""}`} points={times.map((at, i) => `${x(at).toFixed(1)},${y(total(i)).toFixed(1)}`).join(" ")} />}
            {line.length > 1 && <polyline class="usage-forecast" points={line.map((point) => `${x(Date.parse(point.at)).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ")} />}
          </g>
          {limit !== undefined && (
            <g>
              <line class="usage-reserve" x1={M.left} x2={M.left + inner} y1={y(limit)} y2={y(limit)} />
              <text class="usage-tick usage-reserve-text" x={M.left + 4} y={y(limit) - 4}>Reserve: nothing starts from {pct(limit)}</text>
            </g>
          )}
          {end > to && (
            <g>
              <line class="usage-now" x1={x(to)} x2={x(to)} y1={M.top - 4} y2={H - M.bottom} />
              <text class="usage-tick" x={x(to)} y={M.top - 7} text-anchor="middle">now</text>
            </g>
          )}
          {placed.map((label) => (
            <g key={label.text}>
              {label.dashed ? (
                <line class="usage-forecast" x1={M.left + inner + 6} x2={M.left + inner + 16} y1={label.y} y2={label.y} />
              ) : (
                <rect x={M.left + inner + 6} y={label.y - 5} width={10} height={10} rx={2} fill={label.color} />
              )}
              <text class="usage-label" x={M.left + inner + 20} y={label.y + 4}>{label.text}</text>
            </g>
          ))}
          {hovered && hover !== null && (
            <line class="usage-cross" x1={x(times[hover]!)} x2={x(times[hover]!)} y1={M.top} y2={H - M.bottom} />
          )}
        </svg>
      )}
      {hovered && hover !== null && (
        <div class="usage-tip" style={{ left: `${Math.min(width - 190, Math.max(0, x(times[hover]!) + 10))}px` }}>
          <b>{clockTime(hovered.at, to)}</b>: {pct(total(hover))} full
          {STACK.filter((key) => hovered.parts[key]).map((key) => (
            <div key={key}>
              <span class="usage-dot" style={{ background: COLOR[key] }} /> {LABEL[key]} {pct(hovered.parts[key]!)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WindowBlock({ window, view }: { window: UsagePageWindow; view: UsageView }) {
  const rows = ROLES.filter((key) => window.shares[key] > 0.0005);
  const methods = (Object.keys(METHOD) as (keyof typeof METHOD)[]).filter((method) => window.methods[method] > 0);
  const parts = usageParts(window, rows);
  const sessions = rows.reduce((sum, key) => sum + (key === "outside" ? 0 : window.sessions[key]), 0);
  return (
    <section class="panel usage-window">
      <h3>{TITLE[window.kind]}</h3>
      <Plot window={window} from={Date.parse(view.from)} to={Date.parse(view.to)} />
      <h4>Who used it</h4>
      {rows.length === 0 ? (
        <p class="empty">{window.readings < 2 ? "Too few readings in this span." : "No use in this span."}</p>
      ) : (
        <table class="usage-table">
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col" class="num">{parts.several ? "Of all use" : "Of the window"}</th>
              <th scope="col" class="num">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((key) => (
              <tr key={key}>
                <th scope="row">
                  <span class="usage-dot" style={{ background: COLOR[key] }} /> {LABEL[key]}
                </th>
                <td class="num">{parts.several ? `${parts.percents[key]} %` : pct(window.shares[key])}</td>
                <td class="num">{key === "outside" ? "" : window.sessions[key]}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">In all</th>
              <td class="num">{parts.several ? "100 %" : pct(window.total)}</td>
              <td class="num">{sessions}</td>
            </tr>
          </tfoot>
        </table>
      )}
      {parts.several && rows.length > 0 && <p class="muted">{parts.windows === 1 ? "About 1 window's worth in all." : `About ${parts.windows} windows' worth in all.`}</p>}
      <details class="usage-how">
        <summary>How this is counted</summary>
        <p>
          Between two readings the rise of the window is spread evenly over the time and given to whoever ran then: one session gets it all; several share it by run time,
          or by tokens when every one of them has a token count. Use while no session ran counts as outside Scope Soup. After a reset, what is read counts from the reset.
          {" "}Over several windows the shares are of all use in the span.
        </p>
        {methods.length > 0 && (
          <p>
            In this span: {methods.map((method) => `${METHOD[method]} ${pct(window.methods[method] / window.total)}`).join(", ")}.
          </p>
        )}
        <p>
          {view.sessions} session{view.sessions === 1 ? "" : "s"} ran in this span, {view.withTokens} with token counts.
        </p>
      </details>
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
        <div class="usage-top">
          <h3>Now</h3>
          <div class="usage-spans" role="group" aria-label="Span of the plots">
            <span class="muted">Show:</span>
            {SPANS.map((each, index) => (
              <span key={each.id} class="usage-span">
                {index > 0 && <span class="muted" aria-hidden="true">·</span>}
                <button type="button" class={each.id === span ? "primary" : ""} aria-pressed={each.id === span} onClick={() => setSpan(each.id)}>
                  {each.label}
                </button>
              </span>
            ))}
          </div>
        </div>
        {error && <p class="notice notice-bad" role="alert">{error}</p>}
        {!data && !error && <p class="empty">Loading…</p>}
        {data && (
          <div class="usage-meters">
            {data.windows.map((window) => <Meter key={window.kind} window={window} now={now} />)}
          </div>
        )}
      </div>
      {data && data.windows.map((window) => <WindowBlock key={window.kind} window={window} view={data} />)}
    </section>
  );
}
