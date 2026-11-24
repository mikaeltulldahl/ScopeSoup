// The board's view-model: lanes of cards, batches as boxes, the your-turn list, the status line.

import type { Batch, Change, Ref, Parked, Session, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { bisectState } from "./bisect.ts";
import { batchProgress, runProgress } from "./estimates.ts";
import type { Lane } from "./lanes.ts";
import { isLive, LANES, LANE_TITLES } from "./lanes.ts";
import type { Index, Snapshot } from "./snapshot.ts";
import { buildIndex, refLabel } from "./snapshot.ts";
import { buildStatusLine } from "./status.ts";
import type { Assessment } from "./turns.ts";
import type { Self } from "./holdings.ts";
import { actorParts } from "./holdings.ts";
import { assessAll, isMyTurn, waitingQueue, yourTurn } from "./turns.ts";
import type { AssumptionView, BatchMemberView, BatchView, BoardView, CardView, ChangeLink, ItemLink, LaneView, ProbeView, QueueView, SessionView } from "./views.ts";

/** How many done items the board carries; the lane's `total` has the real count. */
export const DONE_SHOWN = 12;
export const RECENT_BATCHES = 3;

export function itemLink(ref: Ref, index: Index): ItemLink {
  return { ref, key: refKey(ref), label: refLabel(ref), title: index.work.get(refKey(ref))?.title ?? "(not synced)" };
}

/** An item's decisions as views, oldest first (the order they were taken in; the page opens on the first one still open). */
export function assumptionViews(item: WorkItem, index: Index): AssumptionView[] {
  return (item.assumptions ?? [])
    .map((each): AssumptionView => ({ ...each, item: itemLink(item.ref, index), ...(each.settled?.item ? { newItem: itemLink(each.settled.item, index) } : {}) }))
    .sort(oldestFirst);
}

const oldestFirst = (a: AssumptionView, b: AssumptionView): number => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function changeLink(change: Change): ChangeLink {
  const link: ChangeLink = { ref: change.ref, label: refLabel(change.ref), title: change.title, draft: change.draft };
  if (change.ref.url) link.url = change.ref.url;
  return link;
}

function changeLinkFor(ref: Ref, index: Index): ChangeLink {
  const change = index.change.get(refKey(ref));
  if (change) return changeLink(change);
  // The queue's changes are the items themselves when the host has no change object for them.
  const item = index.work.get(refKey(ref));
  return { ref, label: refLabel(ref), title: item?.title ?? "(not synced)", draft: false };
}

export function sessionView(session: Session): SessionView {
  const { ref, role, status, subject, model, lastAction, attempt, startedAt, lastEventAt, finishedAt, costUsd, endReason } = session;
  return { ref, role, status, live: isLive(session), subject, model, lastAction, attempt, startedAt, lastEventAt, finishedAt, costUsd, endReason, ...(session.chat ? { chat: true as const } : {}) };
}

/** A person's turn as the card shows it: their name, and on another person's board not coloured as yours. */
function personCard(card: CardView, assessment: Assessment, self: Self | undefined): CardView {
  const { turn } = assessment;
  if (turn.actor !== "person" || !turn.person) return card;
  const mine = isMyTurn(turn, self);
  return { ...card, person: { name: actorParts(turn.person).who, mine }, ...(mine ? {} : { tone: card.tone === "yours" ? "waiting" : card.tone }) };
}

export function cardView(assessment: Assessment, parkedFor?: Map<string, Parked>): CardView {
  const { situation, turn, tone } = assessment;
  const { item, change, session, batch } = situation;
  const card: CardView = {
    ref: item.ref,
    key: refKey(item.ref),
    label: refLabel(item.ref),
    title: item.title,
    lane: situation.lane as Lane,
    actor: turn.actor,
    reason: turn.reason,
    ...(turn.waits ? { waits: turn.waits } : {}),
    tone,
    since: turn.since,
    unblocks: turn.unblocks ?? 0,
    needsDecision: item.needsDecision === true,
  };
  if (item.holder) card.heldBy = item.holder.actor.bot ? item.holder.actor.name : actorParts(item.holder.actor).who;
  const decisions = (item.assumptions ?? []).filter((each) => !each.settled).length;
  if (decisions > 0) card.openDecisions = decisions;
  if (item.priority) card.priority = item.priority;
  if (item.ref.url) card.url = item.ref.url;
  if (change) card.change = changeLink(change);
  if (session) card.session = sessionView(session);
  if (batch) card.batch = { ref: batch.ref, name: `batch ${batch.ref.id}`, status: batch.status };
  return card;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function labels(members: BatchMemberView[]): string {
  const names = members.map((member) => member.items[0]?.label ?? member.change.label);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function batchView(batch: Batch, index: Index, now: Date): BatchView {
  // The first full run of a batch is a probe too, so probes alone do not mean a bisect: one failed.
  const bisected = batch.status === "bisecting" || batch.probes.some((probe) => probe.status === "failed");
  const state = bisected ? bisectState(batch) : undefined;
  const members: BatchMemberView[] = batch.members.map((member, position) => {
    const change = index.change.get(refKey(member.change));
    const view: BatchMemberView = {
      change: changeLinkFor(member.change, index),
      items: change ? change.works.map((ref) => itemLink(ref, index)) : index.work.has(refKey(member.change)) ? [itemLink(member.change, index)] : [],
      sha: member.sha,
      state: member.state,
      suspect: batch.suspect !== undefined && refKey(batch.suspect) === refKey(member.change),
    };
    if (state) view.mark = state.marks[position];
    return view;
  });
  const progress = batchProgress(batch, index.run, index.snapshot.runs, now);
  const view: BatchView = {
    ref: batch.ref,
    key: refKey(batch.ref),
    name: `batch ${batch.ref.id}`,
    status: batch.status,
    words: "",
    base: batch.base,
    members,
    progress,
  };
  if (batch.note) view.note = batch.note;
  if (batch.startedAt) view.startedAt = batch.startedAt;
  if (batch.finishedAt) view.finishedAt = batch.finishedAt;
  if (state) {
    const probes: ProbeView[] = batch.probes.map((probe) => {
      const run = probe.run ? index.run.get(refKey(probe.run)) : undefined;
      const active = probe.status === "queued" || probe.status === "running";
      const probeProgress = run && active ? runProgress(run, index.snapshot.runs, now) : undefined;
      const words = `first ${probe.prefix} of ${batch.members.length}: ${probeProgress ? probeProgress.words : probe.status}`;
      return probeProgress ? { prefix: probe.prefix, status: probe.status, words, progress: probeProgress } : { prefix: probe.prefix, status: probe.status, words };
    });
    view.bisect = { goodPrefix: state.goodPrefix, badPrefix: state.badPrefix, probes };
    if (state.culprit) view.bisect.culprit = changeLinkFor(state.culprit, index);
  }
  view.words = batchWords(batch, view);
  return view;
}

function batchWords(batch: Batch, view: BatchView): string {
  const size = plural(batch.members.length, "change");
  if (batch.status === "forming") return `preparing ${size} for the check`;
  if (batch.status === "merged") return `merged ${size}`;
  if (batch.status === "testing") return view.progress.state === "waiting-for-runner" ? view.progress.words : `checking: ${view.progress.words}`;
  const culprit = view.members.filter((member) => member.mark === "culprit" || member.state === "culprit");
  if (culprit.length > 0) return `${batch.status === "failed" ? "failed" : "bisecting"}: ${labels(culprit)} broke it`;
  const doubt = view.members.filter((member) => member.mark === "in-doubt");
  if (batch.status === "failed") return "failed";
  return doubt.length > 0 ? `failed; bisecting: the culprit is among ${labels(doubt)}` : "failed; bisecting";
}

export function buildQueue(index: Index, now: Date): QueueView {
  const views = index.snapshot.batches.map((batch) => batchView(batch, index, now));
  const byStart = (a: BatchView, b: BatchView) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.key.localeCompare(b.key);
  return {
    batches: views.filter((batch) => batch.status === "testing" || batch.status === "bisecting").sort(byStart),
    forming: views.filter((batch) => batch.status === "forming").sort(byStart),
    waiting: waitingQueue(index).map((change, position) => ({
      position: position + 1,
      change: changeLink(change),
      items: change.works.map((ref) => itemLink(ref, index)),
      since: change.updatedAt,
    })),
    recent: views
      .filter((batch) => batch.status === "merged" || batch.status === "failed")
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
      .slice(0, RECENT_BATCHES),
    ...(index.snapshot.queue ? { health: index.snapshot.queue } : {}),
  };
}

const TONE_ORDER = { yours: 0, blocked: 1, moving: 2, waiting: 3, done: 4 } as const;

function cardOrder(a: CardView, b: CardView): number {
  if (a.lane === "done") return (b.since ?? "").localeCompare(a.since ?? "");
  return TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || b.unblocks - a.unblocks || (a.since ?? "").localeCompare(b.since ?? "");
}

/**
 * Sorts the backlog by `planned`, the item keys in planned order of execution (next first).
 * The order comes from the orchestrator (planOrder), so there is one definition of it.
 * With `notTriaged`, the Items not triaged yet go below the ones that were, in their own planned order.
 */
function planBacklog(cards: CardView[], planned: string[], unplanned: Set<string>, notTriaged?: Set<string>): CardView[] {
  const rank = new Map(planned.map((key, position) => [key, position]));
  const at = (card: CardView): number => rank.get(card.key) ?? Number.MAX_SAFE_INTEGER;
  const below = (card: CardView): number => (notTriaged?.has(card.key) ? 1 : 0);
  let next = 0;
  // An umbrella is not in the plan: it gets no number and does not use one.
  return cards.sort((a, b) => below(a) - below(b) || at(a) - at(b) || cardOrder(a, b)).map((card) => (unplanned.has(card.key) ? card : { ...card, position: ++next }));
}

/**
 * `self`: the machine and person this board belongs to: a person's turn is in `yourTurn` only on their board.
 * `notTriaged` (from level 1): the keys of the Items not triaged yet; the backlog shows them below a divider.
 */
export function buildBoard(snapshot: Snapshot, now: Date, backlogOrder?: string[], self?: Self, notTriaged?: Set<string>): BoardView {
  const index = buildIndex(snapshot);
  // Not in the plan: an umbrella, whose work happens in its open children, and an item a person holds: Scope Soup never starts it.
  const unplanned = new Set(snapshot.works.filter((item) => item.openChildren > 0 || (item.holder !== undefined && !item.holder.actor.bot)).map((item) => refKey(item.ref)));
  const cards = assessAll(index, now, notTriaged).map((assessment) => ({ ...personCard(cardView(assessment, index.parkedByWork), assessment, self), turn: assessment.turn }));
  const queue = buildQueue(index, now);
  const strip = ({ turn: _turn, ...card }: (typeof cards)[number]): CardView => card;
  return {
    now: now.toISOString(),
    lanes: LANES.map((lane): LaneView => {
      const found = cards.filter((card) => card.lane === lane).map(strip);
      const backlog = lane === "backlog" && backlogOrder !== undefined;
      const inLane = backlog ? planBacklog(found, backlogOrder, unplanned, notTriaged) : found.sort(cardOrder);
      const view: LaneView = { lane, title: LANE_TITLES[lane], total: inLane.length, cards: lane === "done" ? inLane.slice(0, DONE_SHOWN) : inLane };
      if (lane === "backlog" && notTriaged) view.notTriaged = inLane.filter((card) => notTriaged.has(card.key)).length;
      return view;
    }),
    yourTurn: yourTurn(cards, self).map(strip),
    queue,
    status: buildStatusLine(index, queue, now),
  };
}
