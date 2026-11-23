// The decisions implementors took themselves, as cheap to change later. They do not block: the work went on. A person
// accepts each (it closes) or overturns it with an answer. While the change has not merged the answer goes into the running
// work (the implementor's own session is told); once it has merged it makes a new {itemNoun(false, true)} that reworks or reverts it.

import { useState } from "preact/hooks";
import type { AssumptionView } from "./api.ts";
import { postAssumption } from "./api.ts";
import { ago } from "./format.ts";
import { itemNoun } from "./theme.ts";
import { itemHref } from "./route.ts";

function Decision({ decision, now, showItem, canSettle, onDone }: { decision: AssumptionView; now: number; showItem: boolean; canSettle: boolean; onDone?: () => void }) {
  const [overturning, setOverturning] = useState(false);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (action: "accept" | "overturn") => {
    setBusy(true);
    setError(null);
    postAssumption(decision.item.key, decision.id, action, action === "overturn" ? answer.trim() : undefined).then(
      () => {
        setBusy(false);
        setOverturning(false);
        onDone?.();
      },
      (problem: unknown) => {
        setError(problem instanceof Error ? problem.message : String(problem));
        setBusy(false);
      },
    );
  };
  const settled = decision.settled;
  return (
    <li class={`row decision${settled ? " decision-settled" : ""}`}>
      <div class="row-head">
        {showItem && (
          <a class="num" href={itemHref(decision.item.key)}>
            {decision.item.label}
          </a>
        )}
        <span class="row-title">{decision.question}</span>
        <span class="muted num">{ago(decision.at, now)}</span>
      </div>
      {showItem && <p class="muted decision-item">{decision.item.title}</p>}
      <p>
        <span class="muted">Chose:</span> {decision.chosen}
      </p>
      {decision.others.length > 0 && (
        <p>
          <span class="muted">Other options:</span> {decision.others.join("; ")}
        </p>
      )}
      {decision.why && (
        <p>
          <span class="muted">Why:</span> {decision.why}
        </p>
      )}
      {settled ? (
        <p class="decision-verdict">
          <span class={`tag tag-${settled.verdict}`}>{settled.verdict}</span>{" "}
          <span class="muted">
            by {settled.by} {ago(settled.at, now)}
          </span>
          {settled.answer && <span>: {settled.answer}</span>}
          {decision.newItem && (
            <>
              {" · "}
              <a href={itemHref(decision.newItem.key)}>{decision.newItem.label}</a> reworks it.
            </>
          )}
          {!decision.newItem && settled.work && <> · It went into the running work.</>}
        </p>
      ) : canSettle ? (
        overturning ? (
          <div class="decision-overturn">
            <label>
              Your decision
              <textarea rows={3} value={answer} onInput={(event) => setAnswer((event.target as HTMLTextAreaElement).value)} placeholder="What it should be instead" />
            </label>
            <p class="muted">While the change has not merged, your decision goes into the running work: the implementor changes it before review. Once it has merged, Overturn makes a new {itemNoun(false, true)} that reworks or reverts it.</p>
            <p>
              <button type="button" class="primary" disabled={busy || answer.trim() === ""} onClick={() => send("overturn")}>
                {busy ? "Working…" : "Overturn"}
              </button>{" "}
              <button type="button" disabled={busy} onClick={() => setOverturning(false)}>
                Cancel
              </button>
            </p>
          </div>
        ) : (
          <p>
            <button type="button" class="primary" disabled={busy} onClick={() => send("accept")}>
              {busy ? "Working…" : "Accept"}
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => setOverturning(true)}>
              Overturn
            </button>
          </p>
        )
      ) : (
        <p class="muted">Open. Writes to this {itemNoun(false, true)}'s host are off, so it cannot be settled here.</p>
      )}
      {error && <p class="error">{error}</p>}
    </li>
  );
}

/** The decisions, newest first. `showItem`: the list spans Items (the overview), so each names its Item. */
export function Assumptions({ list, now, showItem, canSettle, onDone }: { list: AssumptionView[]; now: number; showItem: boolean; canSettle: (decision: AssumptionView) => boolean; onDone?: () => void }) {
  return (
    <ul class="rows decisions">
      {list.map((decision) => (
        <Decision key={`${decision.item.key}:${decision.id}`} decision={decision} now={now} showItem={showItem} canSettle={canSettle(decision)} onDone={onDone} />
      ))}
    </ul>
  );
}
