// Overview: the your-turn list first, then the lanes. Columns on a wide screen, stacked
// and collapsible on a phone.

import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { BoardView, LaneView } from "./api.ts";
import { BatchMini } from "./Batch.tsx";
import { Card } from "./Card.tsx";
import { Holdings } from "./Holdings.tsx";
import { Resources } from "./Resources.tsx";
import { ItemForm } from "./ItemForm.tsx";
import { Assumptions } from "./Assumptions.tsx";
import { laneIcon, laneLabel } from "./format.ts";
import { itemHref } from "./route.ts";
import { itemNoun, words } from "./theme.ts";
import { useTheme } from "./useTheme.ts";
import { postItem, useNow } from "./api.ts";

const STORE_KEY = "scopesoup.closedLanes";


function readClosed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : ["done"];
  } catch {
    return ["done"];
  }
}

function Lane({ lane, board, closed, toggle, onAdd }: { lane: LaneView; board: BoardView; closed: boolean; toggle: () => void; onAdd?: () => void }) {
  // Checking, items are drawn as their batches: the box is what moves.
  const batches = lane.lane === "checking" ? board.queue.batches : [];
  const boxed = new Set(batches.flatMap((batch) => batch.members.flatMap((member) => member.items.map((item) => item.key))));
  const cards = lane.cards.filter((card) => !boxed.has(card.key));
  // From level 1 the backlog's last cards are the Items not triaged yet, below a divider.
  const below = lane.notTriaged ?? 0;
  const divideAt = lane.notTriaged === undefined ? -1 : cards.length - below;
  return (
    <section class={`lane lane-${lane.lane}${closed ? " lane-closed" : ""}`}>
      <h2>
        <button type="button" class="lane-toggle" aria-expanded={!closed} onClick={toggle}>
          <span class="chevron" aria-hidden="true" />
          {laneIcon(lane.lane)}{laneLabel(lane.lane)}
          <span class="count num">{lane.total}</span>
        </button>
        {onAdd && (
          <button type="button" class="lane-add" title={`New ${words().itemOne}`} aria-label={`New ${words().itemOne}`} onClick={onAdd}>
            +
          </button>
        )}
      </h2>
      <div class="lane-body">
        {lane.total === 0 && <p class="empty">{words().emptyLane}</p>}
        {batches.map((batch) => (
          <BatchMini key={batch.key} batch={batch} />
        ))}
        {cards.map((card, position) => (
          <Fragment key={card.key}>
            {position === divideAt && <NotTriaged count={below} />}
            <Card card={card} />
          </Fragment>
        ))}
        {lane.total > lane.cards.length && <p class="empty">and {lane.total - lane.cards.length} older</p>}
      </div>
    </section>
  );
}

/** The backlog's divider: above it the Items that passed a triage, below it those not triaged yet, in the order their triages run. */
function NotTriaged({ count }: { count: number }) {
  return (
    <p class="not-triaged" role="separator" title="Their triages run in this order: oldest first, a higher priority ahead">
      Not triaged yet · <span class="num">{count}</span>
    </p>
  );
}

/** At level 0: how many Items have no triage, and how to get them one. */
function NoTriage({ count }: { count: number }) {
  return (
    <p class="panel no-triage">
      {count} {count === 1 ? `${itemNoun(false, true)} has` : `${itemNoun(true, true)} have`} no triage: set level 1 and press Start agents.
    </p>
  );
}

/** Decisions implementors took themselves, newest first. Not blocking: the work went on, so they are not "your turn". */
function Decisions({ board }: { board: BoardView }) {
  const now = useNow();
  const open = board.assumptions.filter((each) => !each.settled).length;
  const settles = new Set(board.settles ?? []);
  return (
    <section class="panel decisions-panel" aria-labelledby="decisions-title">
      <h2 id="decisions-title">
        Decided by implementors <span class="count num">{open}</span>
      </h2>
      <p class="muted">Cheap to change later, so the work went on: nothing waits on these. Pick Accept, or Overturn with your decision, for each; nothing is recorded until you press Send.</p>
      <Assumptions list={board.assumptions} now={now} showItem canSettle={(each) => settles.has(each.item.ref.host)} />
    </section>
  );
}

export function Overview({ board }: { board: BoardView }) {
  const theme = useTheme();
  const [closed, setClosed] = useState(readClosed);
  const toggle = (lane: string) => {
    const next = closed.includes(lane) ? closed.filter((each) => each !== lane) : [...closed, lane];
    setClosed(next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      // Private mode: the choice lasts until the page is closed.
    }
  };
  const [writing, setWriting] = useState(false);
  // The Backlog's "+" opens the same form, at the top of the board: brought into view, its title ready to type in.
  const openFromLane = () => {
    setWriting(true);
    requestAnimationFrame(() => {
      const form = document.getElementById("new-item");
      if (!form) return;
      // Below the sticky header, which is tall on a phone.
      const header = document.querySelector("header.top")?.getBoundingClientRect().bottom ?? 0;
      window.scrollBy({ top: form.getBoundingClientRect().top - header - 12, behavior: "smooth" });
      form.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    });
  };
  const empty = board.lanes.every((lane) => lane.total === 0) && board.yourTurn.length === 0;
  if (empty && !writing) {
    return (
      <section class="panel empty-board">
        <h2>No {theme.words.itemMany} yet</h2>
        {board.canWrite ? (
          <p>Create {theme.words.itemOne === "item" ? "an item" : `a ${theme.words.itemOne}`} to start, or start a plan-mode session in Claude Code in the project: it files the {theme.words.itemMany} (see the project's CLAUDE.md).</p>
        ) : (
          <p>
            This board cannot create {theme.words.itemMany} here: the project's host is read-only. Open an issue on GitHub to start; it shows up here after the next sync. A plan-mode session in Claude Code in the
            project can file the {theme.words.itemMany} too (see the project's CLAUDE.md).
          </p>
        )}
        {board.canWrite && (
          <p>
            <button type="button" class="primary" onClick={() => setWriting(true)}>
              New {theme.words.itemOne}
            </button>
          </p>
        )}
      </section>
    );
  }
  return (
    <>
      {board.canWrite && !writing && (
        <p class="new-item">
          <button type="button" class="primary" onClick={() => setWriting(true)}>
            New {theme.words.itemOne}
          </button>
        </p>
      )}
      {board.canWrite && writing && (
        <section class="panel" id="new-item">
          <h3>New {theme.words.itemOne}</h3>
          <ItemForm
            start={{ title: "", body: "", verification: "", labels: "", blockedBy: "", priority: "" }}
            withState={false}
            submitWords="Create"
            onSubmit={(fields) =>
              postItem(fields).then(({ ref }) => {
                setWriting(false);
                location.hash = itemHref(ref);
              })
            }
            onCancel={() => setWriting(false)}
          />
        </section>
      )}
      {board.withoutTriage ? <NoTriage count={board.withoutTriage} /> : null}
      <section class={board.yourTurn.length > 0 ? "your-turn waiting" : "your-turn"} aria-labelledby="your-turn-title">
        <h2 id="your-turn-title">
          {theme.words.yourTurn} <span class="count num">{board.yourTurn.length}</span>
        </h2>
        {board.yourTurn.length === 0 ? (
          <p class="empty">Nothing waits for you.</p>
        ) : (
          <div class="your-turn-list">
            {board.yourTurn.map((card) => (
              <Card key={card.key} card={card} showLane />
            ))}
          </div>
        )}
      </section>
      {board.assumptions.length > 0 && <Decisions board={board} />}
      {board.holdings && <Holdings holdings={board.holdings} />}
      {board.resources && <Resources resources={board.resources} />}
      <div class="lanes">
        {board.lanes.map((lane) => (
          <Lane key={lane.lane} lane={lane} board={board} closed={closed.includes(lane.lane)} toggle={() => toggle(lane.lane)} onAdd={lane.lane === "backlog" && board.canWrite && !writing ? openFromLane : undefined} />
        ))}
      </div>
    </>
  );
}
