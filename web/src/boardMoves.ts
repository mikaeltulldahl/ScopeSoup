// The board's motion and moves (#222). `useFlip`: a card that changes place, by a drop or on its own (an agent started, a merge),
// glides from where it was (the FLIP technique) instead of jumping; none with prefers-reduced-motion. `useCardDrag`: dragging a card
// with pointer events, and Alt with the arrow keys on a focused card. Where it may go is the State menu's (drag.ts); a drop goes
// into the same Undo wait (Pending.tsx).

import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { CardView, ItemPage, LaneView } from "./api.ts";
import { fetchItem } from "./api.ts";
import type { Verdict } from "./drag.ts";
import { beforeKey, dropVerdict, inOrder, insertionIndex, keyMove, ORDERED_LANES, placeText } from "./drag.ts";
import { laneLabel } from "./format.ts";
import { MERGE_LANE } from "./mergeLane.ts";
import { queueChange, showNotice } from "./Pending.tsx";
import { currentState, effectNote, stateOptions, toastText } from "./stateMenu.ts";
import { words } from "./theme.ts";

const reducedMotion = (): boolean => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

type Box = { x: number; y: number };
const pageBox = (element: Element): Box => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + window.scrollX, y: rect.top + window.scrollY };
};
const cardsIn = (root: Element): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>("[data-card]"));
const FLIP_ID = "card-flip";

/**
 * Each render measures where the cards under `root` are on the page (with any glide under way, so a new one starts from what is
 * seen); after the commit each card that moved glides from there. `from(key, element)` sets where a card comes from that is not
 * on the board now (the dragged card's ghost).
 */
export function useFlip(root: RefObject<HTMLElement>): { from: (key: string, element: Element) => void } {
  const before = useRef(new Map<string, Box>());
  const extra = useRef(new Map<string, Box>());
  if (root.current) {
    const seen = new Map<string, Box>();
    for (const card of cardsIn(root.current)) seen.set(card.dataset.card!, pageBox(card));
    before.current = seen;
  }
  useLayoutEffect(() => {
    const old = new Map([...before.current, ...extra.current]);
    extra.current.clear();
    if (!root.current || reducedMotion()) return;
    for (const card of cardsIn(root.current)) {
      const was = old.get(card.dataset.card!);
      if (!was) continue;
      for (const running of card.getAnimations?.() ?? []) if (running.id === FLIP_ID) running.cancel();
      const now = pageBox(card);
      const dx = was.x - now.x;
      const dy = was.y - now.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const glide = card.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
      if (glide) glide.id = FLIP_ID;
    }
  });
  return { from: (key, element) => void extra.current.set(key, pageBox(element)) };
}

/** A drag under way, as the lanes draw it. `keys`: the cards carried (one for now; several once multi-select comes). */
export interface DragView {
  keys: string[];
  /** The carried card's height, for the gap that opens where it would land. */
  height: number;
  /** The lane and the place among its shown cards (without the carried ones) under the pointer. */
  over?: { lane: string; index: number };
  /** Per lane, whether it takes the card, once the Item's page has said (`dropVerdict`). */
  verdicts?: Record<string, Verdict>;
}

/** What a drop is decided from: the Item's page, read when the card is picked up. */
interface Judged {
  page: ItemPage;
  verdict: (lane: string) => Verdict;
}

async function judge(key: string): Promise<Judged> {
  const page = await fetchItem(key);
  const options = stateOptions(page, words());
  const current = currentState(page);
  return { page, verdict: (lane) => dropVerdict(options, current, lane) };
}

/** Puts a move in the Undo wait, or says why the lane does not take it. `before`: the card it lands above, in an ordered lane. */
function makeMove(judged: Judged, lanes: readonly LaneView[], key: string, lane: string, before: string | null | undefined): void {
  const { page } = judged;
  const theme = words();
  const verdict = judged.verdict(lane);
  const label = page.item.label;
  const laneName = lane === MERGE_LANE ? theme.mergeLane : laneLabel(lane);
  if (!verdict.ok) return showNotice(`${label} can't go to ${laneName}: ${verdict.why}.`);
  const ordered = ORDERED_LANES.includes(lane) && before !== undefined;
  const labelOf = (other: string | null): string | null => (other === null ? null : lanes.flatMap((each) => each.cards).find((card) => card.key === other)?.label ?? other);
  const where = ordered ? placeText(labelOf(before!), laneName) : "";
  const shown = { key, lane, ...(ordered ? { before } : {}) };
  if (!verdict.option) {
    if (!ordered) return;
    // Its own lane: only the place changes; a drop where it is does nothing.
    const cards = lanes.find((each) => each.lane === lane)?.cards ?? [];
    const index = cards.findIndex((card) => card.key === key);
    if (index >= 0 && !inOrder(cards[index]!)) return showNotice(`${label} has no place in ${laneName}'s order: an umbrella or an Item a person holds is not planned.`);
    if (index >= 0 && beforeKey(cards.filter((card) => card.key !== key), index) === before) return;
    return queueChange({ itemKey: key, state: currentState(page), seen: page.item.updatedAt, steps: [], text: `${label} → ${where}`, shown, place: true });
  }
  const option = verdict.option;
  const text = toastText(label, option.key, effectNote(option.key, page, theme), theme);
  queueChange({ itemKey: key, state: option.key, seen: page.item.updatedAt, steps: option.steps, text: ordered ? `${text} · ${where}` : text, shown, place: ordered });
}

const ARROWS: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
/** Pixels a mouse moves before a press becomes a drag; a finger holds still this long instead (so it can still scroll). */
const SLOP = 5;
const HOLD_MS = 350;
const EDGE = 48;

/**
 * Drags the cards under `root` (elements with `data-card`) to the lanes (elements with `data-lane`). `lanes`: the lanes as drawn,
 * in their order on the board. `flip` sets where a dropped card glides from.
 */
export function useCardDrag(root: RefObject<HTMLElement>, lanes: readonly LaneView[], flip: { from: (key: string, element: Element) => void }): DragView | null {
  const [drag, setDrag] = useState<DragView | null>(null);
  const lanesNow = useRef(lanes);
  lanesNow.current = lanes;
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    if (!focusAfter.current || !root.current) return;
    const card = root.current.querySelector<HTMLElement>(`[data-card="${CSS.escape(focusAfter.current)}"]`);
    if (card) {
      card.focus();
      focusAfter.current = null;
    }
  });

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let justDragged = false;
    let cleanup: (() => void) | null = null;
    const laneOf = (key: string): string | undefined => lanesNow.current.find((lane) => lane.cards.some((card) => card.key === key))?.lane;

    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || cleanup) return;
      const target = event.target as Element;
      if (target.closest("button, input, select, textarea, summary")) return;
      const card = target.closest<HTMLElement>("[data-card]");
      if (!card || !element.contains(card)) return;
      const key = card.dataset.card!;
      const from = laneOf(key);
      if (!from) return;
      const start = { x: event.clientX, y: event.clientY };
      const touch = event.pointerType === "touch";
      const judged = judge(key);
      judged.catch(() => undefined);
      let ghost: HTMLElement | null = null;
      let offset = { x: 0, y: 0 };
      let over: DragView["over"];
      let scroll = 0;
      let last = start;
      let hold = touch ? window.setTimeout(() => begin(), HOLD_MS) : 0;

      const begin = () => {
        hold = 0;
        const rect = card.getBoundingClientRect();
        ghost = card.cloneNode(true) as HTMLElement;
        ghost.removeAttribute("data-card");
        ghost.classList.add("card-ghost");
        Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
        offset = { x: last.x - rect.left, y: last.y - rect.top };
        document.body.appendChild(ghost);
        document.body.classList.add("card-dragging");
        window.getSelection()?.removeAllRanges();
        const index = (lanesNow.current.find((lane) => lane.lane === from)?.cards ?? []).findIndex((each) => each.key === key);
        over = { lane: from, index: Math.max(0, index) };
        setDrag({ keys: [key], height: rect.height, over });
        judged.then((said) => {
          const verdicts = Object.fromEntries([...lanesNow.current.map((lane) => lane.lane), MERGE_LANE].map((lane) => [lane, said.verdict(lane)]));
          setDrag((now) => (now && now.keys[0] === key ? { ...now, verdicts } : now));
        }, () => undefined);
      };

      const place = () => {
        if (!ghost) return;
        ghost.style.transform = `translate(${last.x - offset.x - parseFloat(ghost.style.left)}px, ${last.y - offset.y - parseFloat(ghost.style.top)}px)`;
        const under = document.elementFromPoint(last.x, last.y);
        const laneElement = under?.closest<HTMLElement>("[data-lane]");
        let next: DragView["over"];
        if (laneElement && element.contains(laneElement)) {
          const lane = laneElement.dataset.lane!;
          const middles = laneElement.classList.contains("lane-closed") ? [] : cardsIn(laneElement).map((each) => {
            const rect = each.getBoundingClientRect();
            return rect.top + rect.height / 2;
          });
          next = { lane, index: laneElement.classList.contains("lane-closed") ? 0 : insertionIndex(middles, last.y) };
        }
        if (next?.lane !== over?.lane || next?.index !== over?.index) {
          over = next;
          setDrag((now) => (now ? { ...now, over } : now));
        }
      };

      // Near the top or bottom of the window the page scrolls, so a lane out of sight can be reached.
      const autoScroll = () => {
        scroll = 0;
        if (!ghost) return;
        const speed = last.y < EDGE ? -(EDGE - last.y) / 3 : last.y > window.innerHeight - EDGE ? (last.y - (window.innerHeight - EDGE)) / 3 : 0;
        if (speed === 0) return;
        window.scrollBy(0, speed);
        place();
        scroll = window.requestAnimationFrame(autoScroll);
      };

      const move = (moved: PointerEvent) => {
        if (moved.pointerId !== event.pointerId) return;
        last = { x: moved.clientX, y: moved.clientY };
        const far = Math.hypot(last.x - start.x, last.y - start.y);
        if (!ghost) {
          if (touch) {
            if (far > 8) end(false);
            return;
          }
          if (far < SLOP) return;
          begin();
        }
        moved.preventDefault();
        place();
        if (!scroll) scroll = window.requestAnimationFrame(autoScroll);
      };

      const end = (drop: boolean) => {
        window.clearTimeout(hold);
        window.cancelAnimationFrame(scroll);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", escape, true);
        window.removeEventListener("touchmove", still);
        cleanup = null;
        if (!ghost) return;
        justDragged = true;
        window.setTimeout(() => (justDragged = false), 0);
        flip.from(key, ghost);
        ghost.remove();
        document.body.classList.remove("card-dragging");
        setDrag(null);
        const at = over;
        if (!drop || !at) return;
        const shownNow = lanesNow.current;
        const cards = (shownNow.find((lane) => lane.lane === at.lane)?.cards ?? []).filter((each) => each.key !== key);
        const before = ORDERED_LANES.includes(at.lane) ? beforeKey(cards, at.index) : undefined;
        judged.then((said) => makeMove(said, shownNow, key, at.lane, before), (problem: unknown) => showNotice(`${key}: ${problem instanceof Error ? problem.message : String(problem)}`));
      };
      const up = (released: PointerEvent) => released.pointerId === event.pointerId && end(true);
      const cancel = (cancelled: PointerEvent) => cancelled.pointerId === event.pointerId && end(false);
      const escape = (pressed: KeyboardEvent) => {
        if (pressed.key !== "Escape" || !ghost) return;
        pressed.preventDefault();
        pressed.stopPropagation();
        end(false);
      };
      // Once a finger has picked a card up, the page does not scroll under it.
      const still = (moved: TouchEvent) => ghost && moved.cancelable && moved.preventDefault();
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", escape, true);
      window.addEventListener("touchmove", still, { passive: false });
      cleanup = () => end(false);
    };

    // The click that ends a drag does not open the Item.
    const click = (event: MouseEvent) => {
      if (!justDragged) return;
      event.preventDefault();
      event.stopPropagation();
      justDragged = false;
    };
    // A finger held on a card picks it up rather than opening the link's menu.
    const menu = (event: Event) => {
      if (document.body.classList.contains("card-dragging") || (event.target as Element).closest?.("[data-card]") && (event as PointerEvent).pointerType === "touch") event.preventDefault();
    };

    const keyDown = (event: KeyboardEvent) => {
      const arrow = ARROWS[event.key];
      if (!arrow || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const card = (event.target as Element).closest?.<HTMLElement>("[data-card]");
      if (!card || !element.contains(card)) return;
      event.preventDefault();
      const key = card.dataset.card!;
      const shownNow = lanesNow.current;
      const target = keyMove(shownNow, key, arrow);
      if (!target) return;
      focusAfter.current = key;
      judge(key).then((said) => makeMove(said, shownNow, key, target.lane, target.before), (problem: unknown) => showNotice(`${key}: ${problem instanceof Error ? problem.message : String(problem)}`));
    };

    element.addEventListener("pointerdown", pointerDown);
    element.addEventListener("click", click, true);
    element.addEventListener("contextmenu", menu);
    element.addEventListener("keydown", keyDown);
    return () => {
      cleanup?.();
      element.removeEventListener("pointerdown", pointerDown);
      element.removeEventListener("click", click, true);
      element.removeEventListener("contextmenu", menu);
      element.removeEventListener("keydown", keyDown);
    };
  }, [root.current]);

  return drag;
}

/** What one lane draws of a drag: the carried cards left out, the gap where they would land, or why it does not take them. */
export interface LaneDrag {
  hidden: ReadonlySet<string>;
  gapAt?: number;
  height: number;
  refused?: string;
  takes?: boolean;
}

export function laneDrag(drag: DragView | null, lane: string): LaneDrag | undefined {
  if (!drag) return undefined;
  const hidden = new Set(drag.keys);
  const verdict = drag.verdicts?.[lane];
  const here = drag.over?.lane === lane;
  if (verdict && !verdict.ok) return { hidden, height: drag.height, ...(here ? { refused: verdict.why } : {}) };
  return { hidden, height: drag.height, ...(here ? { gapAt: drag.over!.index, takes: verdict?.ok === true } : {}) };
}

/** The lane's cards as drawn during a drag: without the carried ones. */
export const shownCards = (cards: readonly CardView[], drag: LaneDrag | undefined): CardView[] => (drag ? cards.filter((card) => !drag.hidden.has(card.key)) : [...cards]);
