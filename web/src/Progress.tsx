// One progress bar. Between refreshes it moves on its own from the elapsed time.

import type { Progress } from "./api.ts";
import { useNow } from "./api.ts";
import { clockSpan } from "./format.ts";

const CAP = 0.99;

/** The progress as it is this second, counted from `startedAt` on the server's clock. */
function current(progress: Progress, now: number): { elapsed: number; fraction?: number } {
  const start = progress.startedAt ? Date.parse(progress.startedAt) : NaN;
  const elapsed = Number.isNaN(start) ? progress.elapsedMs : Math.max(progress.elapsedMs, now - start);
  if (progress.state !== "running" || !progress.estimateMs) return { elapsed };
  return { elapsed, fraction: Math.min(CAP, elapsed / progress.estimateMs) };
}

export function progressLabel(progress: Progress, now: number): string {
  const { elapsed } = current(progress, now);
  if (progress.state === "waiting-for-runner") return `waiting for a runner · ${clockSpan(elapsed)}`;
  if (progress.state === "indeterminate") return `${clockSpan(elapsed)} · no estimate yet`;
  if (progress.state === "running" && progress.estimateMs) return `${clockSpan(elapsed)} / ~${clockSpan(progress.estimateMs)}`;
  return progress.words;
}

export function ProgressBar({ progress, label = true }: { progress: Progress; label?: boolean }) {
  const now = useNow();
  if (progress.state === "finished") return null;
  const { fraction } = current(progress, now);
  const text = progressLabel(progress, now);
  return (
    <div class={`progress progress-${progress.state}${progress.likelyStuck ? " progress-stuck" : ""}`}>
      <div
        class="bar"
        role="progressbar"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === undefined ? undefined : Math.round(fraction * 100)}
      >
        <div class="fill" style={fraction === undefined ? undefined : { width: `${(fraction * 100).toFixed(2)}%` }} />
      </div>
      {label && (
        <div class="progress-text">
          <span class="num">{text}</span>
          {progress.likelyStuck && <span class="tag tag-blocked">likely stuck</span>}
        </div>
      )}
    </div>
  );
}
