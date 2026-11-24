// Overview: the your-turn list first (what waits on a person, not the details), then the lanes. Columns on a wide screen, stacked
// and collapsible on a phone.

import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { BoardView, ControlPath, LaneView } from "./api.ts";
import { BatchMini } from "./Batch.tsx";
import { Card } from "./Card.tsx";
import { Dialog } from "./Dialog.tsx";
import { ItemForm } from "./ItemForm.tsx";
import { laneIcon, laneLabel } from "./format.ts";
import { itemHref } from "./route.ts";
import { itemNoun, words } from "./theme.ts";
import { useTheme } from "./useTheme.ts";
import { postItem } from "./api.ts";
import { laneMutedBy, laneSwitch, switchPath, switchTitle, SWITCH_WORDS } from "./switches.ts";
import type { SwitchName, SwitchState } from "./switches.ts";

const STORE_KEY = "scopesoup.closedLanes";


function readClosed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : ["done"];
  } catch {
    return ["done"];
  }
}

/** The lane's switch (Pause / Resume), and whether the lane is paused by it or, for Checking, by the merge queue's. */
interface LaneControl {
  own: SwitchName | null;
  mutedBy: SwitchName | null;
  states: Record<SwitchName, SwitchState>;
  busy: boolean;
  onSwitch: (path: ControlPath) => void;
}

function Lane({ lane, board, closed, toggle, control }: { lane: LaneView; board: BoardView; closed: boolean; toggle: () => void; control: LaneControl }) {
  // Checking, items are drawn as their batches: the box is what moves.
  const batches = lane.lane === "checking" ? board.queue.batches : [];
  const boxed = new Set(batches.flatMap((batch) => batch.members.flatMap((member) => member.items.map((item) => item.key))));
  const cards = lane.cards.filter((card) => !boxed.has(card.key));
  // From level 1 the backlog's last cards are the Items not triaged yet, below a divider.
  const below = lane.notTriaged ?? 0;
  const divideAt = lane.notTriaged === undefined ? -1 : cards.length - below;
  const { own, mutedBy, states } = control;
  const paused = mutedBy !== null && states[mutedBy] !== "started";
  const ownState = own ? states[own] : null;
  // Checking counts its batches (the boxes), and any card not in one.
  const count = lane.lane === "checking" ? batches.length + cards.length : lane.total;
  return (
    <section class={`lane lane-${lane.lane}${closed ? " lane-closed" : ""}${paused ? " lane-paused" : ""}`}>
      {/* The switch sits on the title row, after the count: a lane without one has no extra row, so the columns line up. */}
      <h2>
        <button type="button" class="lane-toggle" aria-expanded={!closed} onClick={toggle}>
          <span class="chevron" aria-hidden="true" />
          {laneIcon(lane.lane)}{laneLabel(lane.lane)}
          <span class="count num">{count}</span>
        </button>
        {/* On its own lane the Pause / Resume button says it all; only a stopped switch is also named. Checking names the merge queue. */}
        {paused && mutedBy && !(own && states[mutedBy] === "paused") && (
          <span class="lane-state" title={switchTitle(mutedBy, states[mutedBy])}>
            {own ? states[mutedBy] : `${SWITCH_WORDS[mutedBy]} ${states[mutedBy]}`}
          </span>
        )}
        {own && ownState && (
          <button
            type="button"
            class={`lane-switch${ownState === "started" ? "" : " primary"}`}
            id={`switch-${own}`}
            disabled={control.busy}
            title={switchTitle(own, ownState)}
            aria-label={`${ownState === "started" ? "Pause" : "Resume"} ${SWITCH_WORDS[own].toLowerCase()}`}
            onClick={() => control.onSwitch(switchPath(own, ownState))}
          >
            {ownState === "started" ? "Pause" : "Resume"}
          </button>
        )}
      </h2>
      <div class="lane-body">
        {count === 0 && <p class="empty">{words().emptyLane}</p>}
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
      {count} {count === 1 ? `${itemNoun(false, true)} has` : `${itemNoun(true, true)} have`} no triage: set level 1 and press Resume on the Backlog.
    </p>
  );
}

export function Overview({ board, busy, onSwitch }: { board: BoardView; busy: boolean; onSwitch: (path: ControlPath) => void }) {
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
  // The draft in the dialog has text in it: a click outside then keeps the dialog.
  const [dirty, setDirty] = useState(false);
  const level = board.status.level;
  const states = { triage: board.status.triage, implement: board.status.implement, review: board.status.review, mergeQueue: board.status.mergeQueue };
  const control = (lane: string): LaneControl => ({ own: laneSwitch(lane, level), mutedBy: laneMutedBy(lane, level), states, busy, onSwitch });
  const close = () => {
    setWriting(false);
    setDirty(false);
  };
  const dialog =
    board.canWrite && writing ? (
      <Dialog label={`New ${theme.words.itemOne}`} onClose={close} focusSelector="input" keepOnOutsideClick={dirty}>
        <h3 class="dialog-title">New {theme.words.itemOne}</h3>
        <ItemForm
          start={{ title: "", body: "", verification: "", labels: "", blockedBy: "", priority: "" }}
          withState={false}
          submitWords="Create"
          onDirty={setDirty}
          onSubmit={(fields) =>
            postItem(fields).then(({ ref }) => {
              close();
              location.hash = itemHref(ref);
            })
          }
          onCancel={close}
        />
      </Dialog>
    ) : null;
  const empty = board.lanes.every((lane) => lane.total === 0) && board.yourTurn.length === 0;
  if (empty) {
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
        {dialog}
      </section>
    );
  }
  return (
    <>
      {board.canWrite && (
        <p class="new-item">
          <button type="button" class="primary" onClick={() => setWriting(true)}>
            New {theme.words.itemOne}
          </button>
        </p>
      )}
      {dialog}
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
      <div class="lanes">
        {board.lanes.map((lane) => (
          <Lane key={lane.lane} lane={lane} board={board} closed={closed.includes(lane.lane)} toggle={() => toggle(lane.lane)} control={control(lane.lane)} />
        ))}
      </div>
    </>
  );
}
