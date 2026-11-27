// Overview: the your-turn list first (what waits on a person, not the details), then the lanes. Columns on a wide screen, stacked
// and collapsible on a phone.

import { DraftCard } from "./DraftCard.tsx";
import { Fragment } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { BoardView, ControlPath, LaneView } from "./api.ts";
import { BatchMini } from "./Batch.tsx";
import { Card } from "./Card.tsx";
import type { LaneDrag } from "./boardMoves.ts";
import { laneDrag, shownCards, useCardDrag, useFlip } from "./boardMoves.ts";
import { withShown } from "./drag.ts";
import { usePendingMoves } from "./Pending.tsx";
import { laneIcon, laneLabel } from "./format.ts";
import { MERGE_LANE, mergeLane, queueShown } from "./mergeLane.ts";
import { itemNoun, words } from "./theme.ts";
import { useTheme } from "./useTheme.ts";
import { laneSwitch, switchPath, switchTitle, SWITCH_WORDS } from "./switches.ts";
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

/** The lane's switch (Pause / Resume); a lane is paused when its switch is. */
interface LaneControl {
  own: SwitchName | null;
  states: Record<SwitchName, SwitchState>;
  busy: boolean;
  onSwitch: (path: ControlPath) => void;
}

/** One lane's frame: the title row with the count and the switch, then the body. */
function LaneFrame({ id, title, count, closed, toggle, control, drag, children }: { id: string; title: string; count: number; closed: boolean; toggle: () => void; control: LaneControl; drag?: LaneDrag; children: ComponentChildren }) {
  const { own, states } = control;
  const ownState = own ? states[own] : null;
  const paused = ownState !== null && ownState !== "started";
  const dropping = drag?.refused !== undefined ? " drop-refused" : drag?.takes ? " drop-takes" : "";
  return (
    <section class={`lane lane-${id}${closed ? " lane-closed" : ""}${paused ? " lane-paused" : ""}${dropping}`} data-lane={id}>
      {/* The switch sits on the title row, after the count: a lane without one has no extra row, so the columns line up. */}
      <h2>
        <button type="button" class="lane-toggle" aria-expanded={!closed} onClick={toggle}>
          <span class="chevron" aria-hidden="true" />
          {title}
          <span class="count num">{count}</span>
        </button>
        {/* The Pause / Resume button says it all; only a stopped switch is also named. */}
        {own && ownState === "stopped" && (
          <span class="lane-state" title={switchTitle(own, ownState)}>
            {ownState}
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
        {drag?.refused !== undefined && <p class="drop-why" role="status">Can't go here: {drag.refused}</p>}
        {count === 0 && drag?.gapAt === undefined && <p class="empty">{words().emptyLane}</p>}
        {children}
      </div>
    </section>
  );
}

/** Where a dragged card would land: a gap as tall as the card. */
const Gap = ({ height }: { height: number }) => <div class="drop-gap" style={{ height: `${height}px` }} aria-hidden="true" />;

function Lane({ lane, closed, toggle, control, drag }: { lane: LaneView; closed: boolean; toggle: () => void; control: LaneControl; drag?: LaneDrag }) {
  // From level 1 To do's last cards are the Items not triaged yet, below a divider.
  const below = lane.notTriaged ?? 0;
  const divideAt = lane.notTriaged === undefined ? -1 : lane.cards.length - below;
  const cards = shownCards(lane.cards, drag);
  // The divider goes above the first card not triaged yet that is drawn (a carried one is not).
  const firstBelow = divideAt < 0 ? undefined : lane.cards.slice(divideAt).find((card) => cards.includes(card))?.key;
  return (
    <LaneFrame id={lane.lane} title={`${laneIcon(lane.lane)}${laneLabel(lane.lane)}`} count={lane.total} closed={closed} toggle={toggle} control={control} drag={drag}>
      {cards.map((card, position) => (
        <Fragment key={card.key}>
          {position === drag?.gapAt && <Gap height={drag.height} />}
          {card.key === firstBelow && <Divider title="Their triages run in this order: oldest first, a higher priority ahead" words="Not triaged yet" count={below} />}
          <Card card={card} />
        </Fragment>
      ))}
      {drag?.gapAt !== undefined && drag.gapAt >= cards.length && <Gap height={drag.height} />}
      {lane.total > lane.cards.length && <p class="empty">and {lane.total - lane.cards.length} older</p>}
    </LaneFrame>
  );
}

/** Queued and Checking as one lane: the batch under test on top, then the changes waiting, in queue order. */
function MergeQueueLane({ board, closed, toggle, control, drag }: { board: BoardView; closed: boolean; toggle: () => void; control: LaneControl; drag?: LaneDrag }) {
  const find = (key: string) => board.lanes.find((lane) => lane.lane === key);
  const { batches, waiting, count } = mergeLane(find("queued"), find("checking"), board.queue);
  const theme = words();
  return (
    <LaneFrame id={MERGE_LANE} title={`${theme.mergeLaneIcon ? `${theme.mergeLaneIcon} ` : ""}${theme.mergeLane}`} count={count} closed={closed} toggle={toggle} control={control} drag={drag}>
      {batches.map((batch) => (
        <BatchMini key={batch.key} batch={batch} />
      ))}
      {waiting.length > 0 && <Divider title="Waiting for a batch, in queue order: the first goes into the next one" words="Waiting" count={waiting.length} />}
      {shownCards(waiting, drag).map((card) => (
        <Card key={card.key} card={card} />
      ))}
      {drag?.gapAt !== undefined && <Gap height={drag.height} />}
    </LaneFrame>
  );
}

/**
 * A divider in a lane: To do's above the Items not triaged yet (in the order their triages run), the merge queue's above
 * the changes waiting for a batch.
 */
function Divider({ words: text, count, title }: { words: string; count: number; title: string }) {
  return (
    <p class="lane-divider" role="separator" title={title}>
      {text} · <span class="num">{count}</span>
    </p>
  );
}

/** At level 0: how many Items have no triage, and how to get them one. */
function NoTriage({ count }: { count: number }) {
  return (
    <p class="panel no-triage">
      {count} {count === 1 ? `${itemNoun(false, true)} has` : `${itemNoun(true, true)} have`} no triage: set level 1 and press Resume on To do.
    </p>
  );
}

export function Overview({ board: loaded, busy, onSwitch }: { board: BoardView; busy: boolean; onSwitch: (path: ControlPath) => void }) {
  const theme = useTheme();
  // A move waiting in its Undo wait shows already (#222): the card is in its new lane and place until it is sent or undone.
  const moves = usePendingMoves();
  const board = moves.length > 0 ? { ...loaded, lanes: withShown(loaded.lanes, moves) } : loaded;
  const lanesRef = useRef<HTMLDivElement>(null);
  const flip = useFlip(lanesRef);
  // The cards selected with Ctrl and Shift+click (#235), the ones still on the board.
  const [picked, setPicked] = useState<string[]>([]);
  const onBoard = new Set(board.lanes.flatMap((lane) => lane.cards.map((card) => card.key)));
  const selected = picked.filter((key) => onBoard.has(key));
  useEffect(() => {
    if (selected.length !== picked.length) setPicked(selected);
  });
  const drag = useCardDrag(lanesRef, board.lanes, flip, { keys: selected, set: setPicked });
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
  const level = board.status.level;
  const states = { triage: board.status.triage, implement: board.status.implement, review: board.status.review, mergeQueue: board.status.mergeQueue };
  const control = (lane: string): LaneControl => ({ own: laneSwitch(lane, level), states, busy, onSwitch });
  const drafts = board.drafts ?? [];
  const waiting = board.yourTurn.length + drafts.length;
  const empty = board.lanes.every((lane) => lane.total === 0) && waiting === 0;
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
      </section>
    );
  }
  return (
    <>
      {board.withoutTriage ? <NoTriage count={board.withoutTriage} /> : null}
      <section class={waiting > 0 ? "your-turn waiting" : "your-turn"} aria-labelledby="your-turn-title">
        <h2 id="your-turn-title">
          {theme.words.yourTurn} <span class="count num">{waiting}</span>
        </h2>
        {waiting === 0 ? (
          <p class="empty">Nothing waits for you.</p>
        ) : (
          <div class="your-turn-list">
            {board.yourTurn.map((card) => (
              <Card key={card.key} card={card} showLane />
            ))}
            {drafts.map((draft) => (
              <DraftCard key={draft.id} draft={draft} />
            ))}
          </div>
        )}
      </section>
      <div class="lanes" ref={lanesRef}>
        {board.lanes.map((lane) =>
          lane.lane === "checking" ? null : lane.lane === "queued" ? (
            !queueShown(board.status.level, mergeLane(lane, board.lanes.find((each) => each.lane === "checking"), board.queue).count) ? null :
            <MergeQueueLane key={MERGE_LANE} board={board} closed={closed.includes(MERGE_LANE)} toggle={() => toggle(MERGE_LANE)} control={control(MERGE_LANE)} drag={laneDrag(drag, MERGE_LANE)} />
          ) : (
            <Lane key={lane.lane} lane={lane} closed={closed.includes(lane.lane)} toggle={() => toggle(lane.lane)} control={control(lane.lane)} drag={laneDrag(drag, lane.lane)} />
          ),
        )}
      </div>
    </>
  );
}
