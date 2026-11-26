// Queue: sections in a fixed order, each hidden when empty (after `mergify queue status`).

import type { BoardView } from "./api.ts";
import { postQueueResume, useNow } from "./api.ts";
import { useState } from "preact/hooks";
import { BatchBox } from "./Batch.tsx";
import { ago, flakyRows } from "./format.ts";
import { Resources } from "./Resources.tsx";
import { itemHref } from "./route.ts";

function Health({ health }: { health: NonNullable<BoardView["queue"]["health"]> }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = () => {
    setBusy(true);
    setError(null);
    postQueueResume().then(
      () => setBusy(false),
      (problem: unknown) => {
        setError(problem instanceof Error ? problem.message : String(problem));
        setBusy(false);
      },
    );
  };
  const m = health.measured;
  const notes = [...health.notes].reverse().slice(0, 8);
  const flaky = flakyRows(health.flaky);
  return (
    <section class="queue-health">
      {health.paused && (
        <div class="notice notice-paused" role="status">
          <b>The queue is paused</b> <span class="muted num">{ago(health.paused.at, now)}</span>: {health.paused.reason}{" "}
          <button type="button" class="primary" disabled={busy} onClick={resume}>Resume the queue</button>
          {error && <span role="alert"> {error}</span>}
        </div>
      )}
      {notes.length > 0 && (
        <>
          <h2>
            Flakes and problems <span class="count num">{health.notes.length}</span>
          </h2>
          <ul class="queue-notes">
            {notes.map((note) => (
              <li key={`${note.at}${note.text}`}>
                <span class={`tag ${note.kind === "problem" ? "tag-blocked" : ""}`}>{note.kind}</span> <span class="muted num">{ago(note.at, now)}</span> {note.text}
              </li>
            ))}
          </ul>
        </>
      )}
      {flaky.length > 0 && (
        <>
          <h2>Recent flaky tests</h2>
          <ul class="queue-flaky">
            {flaky.map((entry) => (
              <li key={entry.test}>
                <code>{entry.test}</code> failed and passed on a rerun <span class="num">{entry.times}</span>, last <span class="muted num">{ago(entry.at, now)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {m && (m.timedRuns > 0 || m.reruns > 0 || m.culpritBatches > 0) && (
        <p class="muted num">
          Batch size uses what the queue measured: {m.timedRuns} timed {m.timedRuns === 1 ? "run" : "runs"}
          {m.rerunCost !== undefined ? `, a rerun costs ${Math.round(m.rerunCost * 100)}% of the failed run (${m.reruns} ${m.reruns === 1 ? "rerun" : "reruns"})` : ""}
          {m.culpritBatches > 0 ? `, the failure report named the culprit in ${m.culpritNamed} of ${m.culpritBatches} ${m.culpritBatches === 1 ? "batch" : "batches"}` : ""}.
        </p>
      )}
    </section>
  );
}

/** Only one machine merges at a time: which one, as this machine last saw it. */
function MergeLease({ lease }: { lease: NonNullable<BoardView["queue"]["mergeQueue"]> }) {
  const until = lease.until && lease.holder !== null ? `, until ${new Date(lease.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : "";
  return <p class="merge-queue">Merges: {lease.holder === null ? "nobody at the moment" : lease.mine ? "this machine" : lease.holder}{until}</p>;
}

export function Queue({ board }: { board: BoardView }) {
  const now = useNow();
  const { batches, forming, waiting, recent } = board.queue;
  const empty = batches.length + forming.length + waiting.length + recent.length === 0;
  return (
    <div class="queue">
      {board.queue.health && <Health health={board.queue.health} />}
      {board.queue.mergeQueue && <MergeLease lease={board.queue.mergeQueue} />}
      {board.resources && <Resources resources={board.resources} />}
      {empty && <p class="empty">The queue is empty.</p>}
      {waiting.length > 0 && (
        <section>
          <h2>
            Queued <span class="count num">{waiting.length}</span>
          </h2>
          <ol class="waiting">
            {waiting.map((entry) => {
              const item = entry.items[0];
              return (
                <li key={entry.change.label}>
                  <a class="waiting-row" href={item ? itemHref(item.key) : "#/queue"}>
                    <span class="order num">{entry.position}</span>
                    <span class="ref num">{item?.label ?? entry.change.label}</span>
                    <span class="waiting-title">{item?.title ?? entry.change.title}</span>
                    <span class="when num">queued {ago(entry.since, now)}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {/* There is one batch at a time: while it is prepared (its changes merged onto main) and while it is checked. */}
      {batches.length + forming.length > 0 && (
        <section>
          <h2>
            Checking <span class="count num">{batches.length + forming.length}</span>
          </h2>
          {[...batches, ...forming].map((batch) => (
            <BatchBox key={batch.key} batch={batch} />
          ))}
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <h2>Recently finished</h2>
          {recent.map((batch) => (
            <BatchBox key={batch.key} batch={batch} />
          ))}
        </section>
      )}
    </div>
  );
}
