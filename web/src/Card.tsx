// One item on the board. The reason it is where it is always shows, in words.

import { useState } from "preact/hooks";
import type { CardView, SessionView } from "./api.ts";
import { postVote, useNow } from "./api.ts";
import { ago, dateOf, laneLabel } from "./format.ts";
import { fill, words } from "./theme.ts";
import { itemHref } from "./route.ts";
import { browserStorage, heldCount } from "./heldAnswers.ts";
import { picksCount, unsentNote } from "./heldDecisions.ts";

/** "anyone" is a question: in every person's "Your turn", so it is yours too. */
const ACTORS = (): Record<CardView["actor"], string> => ({ anyone: words().turnYours, person: "", agent: "agent", queue: "queue", runner: "runner", nobody: "" });

/** Whose turn, in a tag: yours, or the person's by name. */
export function actorWords(card: Pick<CardView, "actor" | "person">): string {
  if (card.actor === "person" && card.person) return card.person.mine ? words().turnYours : fill(words().turnOf, { name: card.person.name });
  return ACTORS()[card.actor];
}

/** The tag's colour: everyone's turn and a person's turn that is yours look the same; another person's is dashed. */
export function actorClass(card: Pick<CardView, "actor" | "person">): string {
  return card.actor === "person" ? (card.person?.mine ? "tag-actor-yours" : "tag-actor-person") : card.actor === "anyone" ? "tag-actor-yours" : `tag-actor-${card.actor}`;
}

export function SessionChip({ session }: { session: SessionView }) {
  return (
    <span class={`tag tag-session${session.status === "stalled" || session.status === "limit" ? " tag-blocked" : ""}`}>
      {session.live && session.status !== "stalled" && <span class="pulse" aria-hidden="true" />}
      {session.chat ? `chat · ${session.role}` : session.role}
      {session.model ? ` · ${session.model}` : ""}
      {session.status !== "running" && session.status !== "starting" ? ` · ${session.status}` : ""}
    </span>
  );
}

/** Vote up and Vote down: each moves the Item one place. At the edge of its group a button is off, with the reason. */
export function VoteButtons({ itemKey, off }: { itemKey: string; off?: { up?: string; down?: string } }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const step = (direction: "up" | "down") => (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    setBusy(true);
    setProblem("");
    postVote(itemKey, direction).catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  };
  return (
    <span class="vote">
      <button type="button" class="vote-button" disabled={busy || !!off?.up} title={off?.up} onClick={step("up")}>Vote up</button>
      <button type="button" class="vote-button" disabled={busy || !!off?.down} title={off?.down} onClick={step("down")}>Vote down</button>
      {(off?.up || off?.down) && <span class="vote-off">{[off.up, off.down].filter(Boolean).join(" ")}</span>}
      {problem && <span class="reason" role="alert">{problem}</span>}
    </span>
  );
}

/** A card nobody has touched for this long counts as quiet (a themed badge only). */
const QUIET_MS = 3 * 24 * 3600 * 1000;

export function Card({ card, showLane = false }: { card: CardView; showLane?: boolean }) {
  const now = useNow();
  const theme = words();
  const running = card.session && card.session.live && !card.session.chat && card.lane === "in-progress";
  // Answers held in this browser count where it is this person's turn; picks on implementors' decisions always (they do not block).
  const unsent = unsentNote(card.actor === "anyone" || card.person?.mine ? heldCount(browserStorage(), card.key) : 0, picksCount(browserStorage(), card.key));
  const quiet = card.tone !== "done" && card.tone !== "moving" && !card.session && card.since !== undefined && now - Date.parse(card.since) > QUIET_MS;
  return (
    <a class={`card tone-${card.tone}`} href={itemHref(card.key)}>
      {card.tone === "done" && theme.doneBadge && <span class="grave-top" aria-hidden="true">{theme.doneBadge}</span>}
      <div class="card-head">
        {card.position !== undefined && !showLane && (
          <span class="num" title="Planned order of execution: 1 starts next">
            {card.position}.
          </span>
        )}
        <span class="ref num">{card.label}</span>
        <span class="card-title">{card.title}</span>
      </div>
      <p class={card.tone === "done" ? "reason epitaph" : "reason"}>{showLane && card.waits ? card.waits : card.reason}</p>
      {card.why && <p class="why">{card.why}</p>}
      <div class="tags">
        {actorWords(card) && <span class={`tag ${actorClass(card)}`}>{actorWords(card)}</span>}
        {showLane && <span class="tag">{laneLabel(card.lane)}</span>}
        {card.heldBy && !showLane && !card.reason.includes(`held by ${card.heldBy}`) && <span class="tag">held by {card.heldBy}</span>}
        {card.openDecisions && <span class="tag tag-decisions">{card.openDecisions} {card.openDecisions === 1 ? "decision" : "decisions"} to look at</span>}
        {unsent && <span class="tag">{unsent}</span>}
        {card.session && <SessionChip session={card.session} />}
        {running && theme.sessionBadge && <span class="tag tag-flair">{fill(theme.sessionBadge, { n: card.session!.attempt })}</span>}
        {quiet && theme.staleBadge && <span class="tag tag-flair tag-stale">{fill(theme.staleBadge, { date: dateOf(card.since!) })}</span>}
        {card.priority && card.priority !== "major" && <span class={`tag tag-priority-${card.priority}`}>{card.priority}</span>}
        {card.unblocks > 0 && <span class="tag tag-unblocks">unblocks {card.unblocks}</span>}
        {card.tone !== "done" && card.tone !== "moving" && card.since && <span class="when num">{ago(card.since, now)}</span>}
        {card.why && <VoteButtons itemKey={card.key} off={card.voteOff} />}
      </div>
    </a>
  );
}
