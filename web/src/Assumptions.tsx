// The decisions implementors took themselves, as cheap to change later. They do not block: the work went on. A person
// picks Accept (it closes) or Overturn with a decision for each; the picks stay in this browser until Send, and Send records an
// Item's picks together (one write on the host). While the change has not merged an overturn goes into the running work (the
// implementor's own session is told); once it has merged it makes a new {itemNoun(false, true)} that reworks or reverts it.

import { useState } from "preact/hooks";
import type { AssumptionView } from "./api.ts";
import { postDecisions } from "./api.ts";
import { ago } from "./format.ts";
import { browserStorage } from "./heldAnswers.ts";
import type { HeldPick } from "./heldDecisions.ts";
import { clearPicks, loadPicks, readyPicks, savePicks } from "./heldDecisions.ts";
import { itemNoun } from "./theme.ts";
import { itemHref } from "./route.ts";
import { Stepper } from "./Stepper.tsx";

function Decision({ decision, now, showItem, canSettle, pick, busy, onPick }: { decision: AssumptionView; now: number; showItem: boolean; canSettle: boolean; pick: HeldPick | undefined; busy: boolean; onPick: (pick: HeldPick | null) => void }) {
  const settled = decision.settled;
  return (
    <li class={`row decision${settled ? " decision-settled" : ""}${pick ? " decision-picked" : ""}`}>
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
      ) : !canSettle ? (
        <p class="muted">Open. Writes to this {itemNoun(false, true)}'s host are off, so it cannot be settled here.</p>
      ) : pick?.action === "overturn" ? (
        <div class="decision-overturn">
          <p>
            <span class="tag tag-picked">Overturn picked</span> <span class="muted">not sent</span>
          </p>
          <label>
            Your decision
            <textarea rows={3} value={pick.answer} disabled={busy} onInput={(event) => onPick({ action: "overturn", answer: (event.target as HTMLTextAreaElement).value })} placeholder="What it should be instead" />
          </label>
          <p class="muted">While the change has not merged, your decision goes into the running work: the implementor changes it before review. Once it has merged, Overturn makes a new {itemNoun(false, true)} that reworks or reverts it.</p>
          <p>
            <button type="button" disabled={busy} onClick={() => onPick(null)}>
              Undo
            </button>
          </p>
        </div>
      ) : pick?.action === "accept" ? (
        <p>
          <span class="tag tag-picked">Accept picked</span> <span class="muted">not sent</span>{" "}
          <button type="button" disabled={busy} onClick={() => onPick(null)}>
            Undo
          </button>
        </p>
      ) : (
        <p>
          <button type="button" class="choice" disabled={busy} onClick={() => onPick({ action: "accept", answer: "" })}>
            Accept
          </button>{" "}
          <button type="button" class="choice" disabled={busy} onClick={() => onPick({ action: "overturn", answer: "" })}>
            Overturn
          </button>
        </p>
      )}
    </li>
  );
}

/** The open decisions' ids of each Item in `list`. */
function openIds(list: AssumptionView[]): Map<string, string[]> {
  const ids = new Map<string, string[]>();
  for (const decision of list) if (!decision.settled) ids.set(decision.item.key, [...(ids.get(decision.item.key) ?? []), decision.id]);
  return ids;
}

/**
 * The decisions, newest first, with the held picks and one Send. `showItem`: the list spans Items (the overview), so each names
 * its Item, and Send sends each Item's picks as one request. On one Item's page (not `showItem`) they show one at a time, with
 * arrows and a counter, like its questions.
 */
export function Assumptions({ list, now, showItem, canSettle, onDone }: { list: AssumptionView[]; now: number; showItem: boolean; canSettle: (decision: AssumptionView) => boolean; onDone?: () => void }) {
  const ids = openIds(list);
  // Read from this browser on every render, so picks made on another page (the Item's, or the overview) show here too.
  const [, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picksOf = (itemKey: string) => loadPicks(browserStorage(), itemKey, ids.get(itemKey) ?? []);
  const change = (decision: AssumptionView, pick: HeldPick | null) => {
    const picks = picksOf(decision.item.key);
    if (pick) picks[decision.id] = pick;
    else delete picks[decision.id];
    savePicks(browserStorage(), decision.item.key, picks);
    setVersion((version) => version + 1);
  };
  const ready = [...ids.entries()].flatMap(([itemKey, open]) => {
    const entries = readyPicks(picksOf(itemKey), open);
    return entries.length > 0 ? [{ itemKey, entries }] : [];
  });
  const picked = [...ids.entries()].reduce((count, [itemKey]) => count + Object.keys(picksOf(itemKey)).length, 0);
  const count = ready.reduce((sum, each) => sum + each.entries.length, 0);
  const sendAll = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const { itemKey, entries } of ready) {
        await postDecisions(itemKey, entries);
        clearPicks(browserStorage(), itemKey, entries.map((entry) => entry.id));
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
    setBusy(false);
    setVersion((version) => version + 1);
    onDone?.();
  };
  const row = (decision: AssumptionView) => (
    <Decision
      key={`${decision.item.key}:${decision.id}`}
      decision={decision}
      now={now}
      showItem={showItem}
      canSettle={canSettle(decision)}
      pick={decision.settled ? undefined : picksOf(decision.item.key)[decision.id]}
      busy={busy}
      onPick={(pick) => change(decision, pick)}
    />
  );
  // Answered: settled, or a pick held here that Send would send (an Overturn once its decision is written).
  const answered = list.map((decision) => !!decision.settled || readyPicks(picksOf(decision.item.key), [decision.id]).length > 0);
  return (
    <>
      {showItem ? (
        <ul class="rows decisions">{list.map(row)}</ul>
      ) : (
        list.length > 0 && <Stepper noun="Decision" answered={answered}>{(index) => <ul class="rows decisions">{row(list[index]!)}</ul>}</Stepper>
      )}
      {picked > 0 && (
        <div class="answer">
          <p class="muted num">
            {count} picked{picked > count ? `, ${picked - count} overturn${picked - count > 1 ? "s" : ""} still without your decision` : ""}. Nothing is recorded until you send; your picks are kept in this browser.
          </p>
          <button type="button" class="primary" onClick={() => void sendAll()} disabled={busy || count === 0}>
            {busy ? "Sending…" : count > 1 ? `Send ${count} decisions` : "Send"}
          </button>
          {error && <p class="error">{error}</p>}
        </div>
      )}
    </>
  );
}
