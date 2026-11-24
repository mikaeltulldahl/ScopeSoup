// One item on the board, with one short line of text (cardText.ts); the Item page has the long reason.

import { useState } from "preact/hooks";
import type { CardView, SessionView } from "./api.ts";
import { postVote, useNow, usePerson } from "./api.ts";
import { cardText, heldByViewer } from "./cardText.ts";
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

/**
 * Vote up and Vote down: each moves the Item one place. At the edge of its group a button is off, with the reason as its title
 * (and, on the Item page, in words beside it). `small`: the card's ▲ ▼ at its side.
 */
export function VoteButtons({ itemKey, off, small = false }: { itemKey: string; off?: { up?: string; down?: string }; small?: boolean }) {
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
    <span class={small ? "vote vote-small" : "vote"}>
      <button type="button" class="vote-button" disabled={busy || !!off?.up} title={off?.up ?? "Vote up"} aria-label="Vote up" onClick={step("up")}>
        {small ? "▲" : "Vote up"}
      </button>
      <button type="button" class="vote-button" disabled={busy || !!off?.down} title={off?.down ?? "Vote down"} aria-label="Vote down" onClick={step("down")}>
        {small ? "▼" : "Vote down"}
      </button>
      {!small && (off?.up || off?.down) && <span class="vote-off">{[off.up, off.down].filter(Boolean).join(" ")}</span>}
      {problem && <span class={small ? "vote-problem" : "reason"} role="alert" title={problem}>{small ? "!" : problem}</span>}
    </span>
  );
}

/** A person's name as a mention: marked when it is the person viewing the board. */
export function Mention({ name, mine }: { name: string; mine: boolean }) {
  return <span class={mine ? "mention mention-mine" : "mention"}>@{name}</span>;
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
  const viewer = usePerson();
  const text = cardText(card, viewer);
  return (
    <a class={`card tone-${card.tone}`} href={itemHref(card.key)}>
      {card.tone === "done" && theme.doneBadge && <span class="grave-top" aria-hidden="true">{theme.doneBadge}</span>}
      <div class="card-head">
        <span class="ref num">{card.label}</span>
        <span class="card-title">{card.title}</span>
        {card.why && !showLane && <VoteButtons itemKey={card.key} off={card.voteOff} small />}
      </div>
      {text.kind === "text" && <p class={card.tone === "done" ? "reason epitaph" : "reason"}>{text.text}</p>}
      {text.kind === "held" && (
        <p class="reason">
          held by <Mention name={text.name} mine={text.mine} />
        </p>
      )}
      <div class="tags">
        {actorWords(card) && <span class={`tag ${actorClass(card)}`}>{actorWords(card)}</span>}
        {showLane && <span class="tag">{laneLabel(card.lane)}</span>}
        {card.heldBy && !showLane && text.kind !== "held" && !card.reason.includes(`held by ${card.heldBy}`) && (
          <span class="tag">
            held by <Mention name={card.heldBy} mine={heldByViewer(card, viewer)} />
          </span>
        )}
        {card.openDecisions && <span class="tag tag-decisions">{card.openDecisions} {card.openDecisions === 1 ? "decision" : "decisions"} to look at</span>}
        {unsent && <span class="tag">{unsent}</span>}
        {card.session && <SessionChip session={card.session} />}
        {running && theme.sessionBadge && <span class="tag tag-flair">{fill(theme.sessionBadge, { n: card.session!.attempt })}</span>}
        {quiet && theme.staleBadge && <span class="tag tag-flair tag-stale">{fill(theme.staleBadge, { date: dateOf(card.since!) })}</span>}
        {card.priority && card.priority !== "major" && <span class={`tag tag-priority-${card.priority}`}>{card.priority}</span>}
        {card.unblocks > 0 && <span class="tag tag-unblocks">unblocks {card.unblocks}</span>}
        {card.tone !== "done" && card.tone !== "moving" && card.since && <span class="when num">{ago(card.since, now)}</span>}
      </div>
    </a>
  );
}
