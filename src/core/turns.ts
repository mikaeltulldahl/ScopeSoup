// Turns: who must act next on each item, and why, in plain words.

import type { Actor, Change, Ref, Parked, Session, Turn, TurnActor, WorkItem } from "../model/types.ts";
import { HANDBACK_LABEL, holdStands, ITEM_BRANCH_PREFIX } from "../model/people.ts";
import { refKey } from "../model/types.ts";
import { batchProgress } from "./estimates.ts";
import type { Self } from "./holdings.ts";
import { actorParts, holdDetails, isSelfPerson } from "./holdings.ts";
import type { Situation } from "./lanes.ts";
import { currentVerdicts, isApproved, isLive, openBlockers, situate } from "./lanes.ts";
import type { Index } from "./snapshot.ts";
import { durationWords, ms, refLabel } from "./snapshot.ts";
import { sameFilesWords } from "./sameFiles.ts";
import { clearWithoutTriage } from "./statedSize.ts";

/** How a card is coloured: is it moving, waiting its turn, stuck, or a person's? */
export type Tone = "moving" | "waiting" | "blocked" | "yours" | "done";

export interface Assessment {
  situation: Situation;
  turn: Turn;
  tone: Tone;
}

export interface TurnContext {
  index: Index;
  now: Date;
  /** Keys of approved changes waiting for a batch, first in line first. */
  queue: string[];
  unblocks: Map<string, number>;
  /** Keys of the open Items not triaged yet, when the caller knows them: with triage paused they wait for it, not for a slot. */
  notTriaged?: ReadonlySet<string>;
}

function isOpen(item: WorkItem): boolean {
  return item.state !== "done" && item.state !== "abandoned";
}

/** For each open item: how many open items are transitively blocked behind it. */
export function computeUnblocks(works: readonly WorkItem[]): Map<string, number> {
  const open = works.filter(isOpen);
  const keys = new Set(open.map((item) => refKey(item.ref)));
  const dependents = new Map<string, string[]>();
  for (const item of open) {
    for (const blocker of item.blockedBy) {
      const key = refKey(blocker);
      if (!keys.has(key)) continue;
      const list = dependents.get(key);
      if (list) list.push(refKey(item.ref));
      else dependents.set(key, [refKey(item.ref)]);
    }
  }
  const result = new Map<string, number>();
  for (const start of keys) {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
      for (const next of dependents.get(stack.pop() as string) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    result.set(start, seen.size - 1);
  }
  return result;
}

/** Approved changes that are in no batch yet, longest-waiting first. */
export function waitingQueue(index: Index): Change[] {
  return index.snapshot.changes
    .filter((change) => {
      if (!isApproved(change, index)) return false;
      const sha = change.revisions[change.revisions.length - 1]?.sha;
      return !(index.batchesByChange.get(refKey(change.ref)) ?? []).some((batch) => {
        if (batch.status === "merged") return false;
        const member = batch.members.find((candidate) => refKey(candidate.change) === refKey(change.ref));
        if (batch.status === "failed") return member?.state === "culprit" && member.sha === sha;
        return member?.state !== "requeued" && member?.state !== "culprit";
      });
    })
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

export function turnContext(index: Index, now: Date, notTriaged?: ReadonlySet<string>): TurnContext {
  return { index, now, queue: waitingQueue(index).map((change) => refKey(change.ref)), unblocks: computeUnblocks(index.snapshot.works), ...(notTriaged ? { notTriaged } : {}) };
}

function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function since(at: string | undefined, now: Date): string {
  const then = ms(at);
  return then === null ? "a while" : durationWords(now.getTime() - then);
}

function resetWords(ctx: TurnContext): string {
  const resets = (ctx.index.snapshot.usage?.windows ?? [])
    .map((window) => ms(window.resetsAt))
    .filter((at): at is number => at !== null && at > ctx.now.getTime())
    .sort((a, b) => a - b);
  return resets[0] === undefined ? "" : `; the window resets in ${durationWords(resets[0] - ctx.now.getTime())}`;
}

function batchName(ref: Ref): string {
  return `batch ${ref.id}`;
}

type Draft = { actor: TurnActor; reason: string; waits?: string; tone: Tone; since?: string; person?: Actor };

/**
 * The person an item is with now, if any: a person who holds it, else the person whose hand-back is its newest revision
 * (a `revision` line with `handback: true` on the meta branch, an open pull request labelled for review on GitHub, `handedBack` on Jira). Scope Soup's own later
 * revision supersedes a hand-back.
 */
export function personOf(situation: Pick<Situation, "item" | "change">): Actor | undefined {
  const { item, change } = situation;
  if (item.holder && !item.holder.actor.bot) return item.holder.actor;
  if (item.handedBack && !item.handedBack.by.bot) return item.handedBack.by;
  const newest = [...(item.log ?? [])].reverse().find((line) => line.kind === "revision");
  if (newest && !newest.by.agent && newest.fields.handback === true) {
    const { who, machine } = newest.by;
    return machine ? { id: `${who}@${machine}`, name: `${who} on ${machine}` } : { id: who, name: who };
  }
  if (change?.state === "open" && (change.labels ?? []).includes(HANDBACK_LABEL) && change.author && !change.author.bot) return change.author;
  return undefined;
}

/**
 * Held and no session running here. A person's hold is their turn and has no stall timer: it never runs out and is never
 * called stuck; after a quiet day it only says so. An agent's (another machine's) claim runs out at its `until`.
 */
function heldTurn(item: WorkItem, ctx: TurnContext): Draft {
  const holder = item.holder!;
  if (!holder.actor.bot) {
    const details = holdDetails(item, ctx.now);
    const touched = [...(item.log ?? [])].pop()?.at ?? item.updatedAt;
    return {
      actor: "person", person: holder.actor, tone: "yours", ...(details?.since ? { since: details.since } : {}),
      waits: `held by ${actorParts(holder.actor).who}`,
      reason: `held by ${holder.actor.name}; Scope Soup leaves it alone until they hand it back or release it${details?.quiet ? `. Quiet: nothing written for ${since(touched, ctx.now)}` : ""}`,
    };
  }
  const expired = !holdStands(holder, ctx.now.getTime());
  return {
    actor: "agent",
    tone: expired ? "blocked" : "waiting",
    reason: expired ? `held by ${holder.actor.name}, but the claim ran out ${since(holder.until, ctx.now)} ago and no session is running` : `held by ${holder.actor.name}; no session is running here`,
  };
}

function sessionTurn(session: Session, ctx: TurnContext): Draft {
  const who = session.model ? ` (${session.model})` : "";
  if (session.status === "limit") {
    return { actor: "nobody", tone: "blocked", since: session.lastEventAt ?? session.startedAt, reason: `the ${session.role} session stopped at the usage limit and resumes on its own${resetWords(ctx)}` };
  }
  if (session.status === "stalled") {
    return { actor: "agent", tone: "blocked", since: session.lastEventAt ?? session.startedAt, reason: `the ${session.role} session has stalled: no activity for ${since(session.lastEventAt ?? session.startedAt, ctx.now)}` };
  }
  const doing = session.lastAction ? `: ${session.lastAction}` : "";
  return { actor: "agent", tone: "moving", since: session.startedAt, reason: `${session.role} session running for ${since(session.startedAt, ctx.now)}${who}${doing}` };
}

function umbrellaTurn(item: WorkItem): Draft {
  return { actor: "nobody", tone: "waiting", reason: `has ${item.openChildren} open sub-item${item.openChildren === 1 ? "" : "s"}; the work happens there` };
}

function allPartsDoneTurn(item: WorkItem): Draft {
  const total = item.children ?? 0;
  return { actor: "anyone", tone: "yours", waits: "ready to close", reason: `Close it if nothing is left: all ${total} sub-item${total === 1 ? " is" : "s are"} done` };
}

function backlogTurn(situation: Situation, ctx: TurnContext): Draft {
  const { item, session } = situation;
  if (session) return sessionTurn(session, ctx);
  if (item.openChildren > 0) return umbrellaTurn(item);
  if ((item.children ?? 0) > 0 && item.state === "todo") return allPartsDoneTurn(item);
  const blockers = openBlockers(item, ctx.index);
  if (blockers.length > 0) {
    const words = blockers.map((blocker) => `${refLabel(blocker.ref)}${blocker.needsDecision ? " (needs your decision)" : ""}`);
    return { actor: "nobody", tone: "blocked", reason: `blocked by ${list(words)}` };
  }
  if (item.state === "waiting") return { actor: "nobody", tone: "blocked", reason: `waiting on the host (status "${item.hostState}")` };
  // A held item is not waiting for a free slot here: a person works on it, or another machine's agent does.
  if (item.holder && holdStands(item.holder, ctx.now.getTime())) return heldTurn(item, ctx);
  // Triaged, and its paths overlap those of an Item in progress or in review: it waits for that one, not for a slot.
  const sameFiles = ctx.index.snapshot.sameFiles?.find((each) => refKey(each.subject) === refKey(item.ref));
  if (sameFiles) return { actor: "nobody", tone: "waiting", reason: sameFilesWords(sameFiles.waitsFor) };
  if (ctx.index.snapshot.paused) return { actor: "nobody", tone: "blocked", reason: "ready, but agents are paused (Resume on the lanes)" };
  if (ctx.index.snapshot.usage?.status === "rejected") return { actor: "nobody", tone: "blocked", reason: `ready, but the usage limit is reached${resetWords(ctx)}` };
  // Its next step is the triage and triage is paused: it waits for that switch, not for a slot. (A stated size skips the triage from level 2.)
  const triageNext = ctx.notTriaged?.has(refKey(item.ref)) && !((ctx.index.snapshot.level ?? 0) >= 2 && clearWithoutTriage(item));
  if (triageNext && ctx.index.snapshot.triage !== "started") return { actor: "nobody", tone: "blocked", reason: "ready, but triage is paused (Resume on Backlog)" };
  // Its next step is the implement (it is triaged, or needs no triage), and no implementor takes it now: implementors are
  // paused, or the level is below 2. The status line says which; the card says only "ready".
  if (!triageNext && (ctx.index.snapshot.implement !== "started" || (ctx.index.snapshot.level ?? 2) < 2)) return { actor: "nobody", tone: "waiting", reason: "ready" };
  return { actor: "agent", tone: "waiting", reason: "ready; waiting for a free agent slot" };
}

function progressTurn(situation: Situation, ctx: TurnContext): Draft {
  const { item, change, batch, member, session } = situation;
  if (batch && member?.state === "culprit") {
    if (session && isLive(session)) return { ...sessionTurn(session, ctx), reason: `it broke ${batchName(batch.ref)}; ${sessionTurn(session, ctx).reason}` };
    return { actor: "agent", tone: "blocked", since: batch.finishedAt, reason: `it broke ${batchName(batch.ref)} and was taken out; waiting for an implementor session` };
  }
  if (session) return sessionTurn(session, ctx);
  if (change) return { actor: "agent", tone: "waiting", since: change.updatedAt, reason: "its pull request is not marked ready for review and no session is running; waiting for a free agent slot" };
  if (item.holder) return heldTurn(item, ctx);
  return { actor: "agent", tone: "blocked", reason: "marked in progress on the host, but nobody holds it and no session is running" };
}

function reviewTurn(situation: Situation, change: Change, ctx: TurnContext): Draft {
  const { session } = situation;
  if (session) return sessionTurn(session, ctx);
  // A pull request that is not an item branch and was not handed back is not Scope Soup's to review.
  if (change.branch !== undefined && !change.branch.startsWith(ITEM_BRANCH_PREFIX) && !(change.labels ?? []).includes(HANDBACK_LABEL)) {
    return { actor: "nobody", tone: "waiting", since: change.updatedAt, reason: `open pull request by ${change.author?.name ?? "someone"}; Scope Soup does not review it` };
  }
  const verdicts = currentVerdicts(change);
  const failed = verdicts.filter((verdict) => verdict.value === "fail");
  if (failed.some((verdict) => verdict.dimension === "ci")) return { actor: "agent", tone: "blocked", since: change.updatedAt, reason: "the checks failed on the current revision; waiting for an implementor session" };
  if (failed.length > 0) {
    return { actor: "agent", tone: "blocked", since: change.updatedAt, reason: `the ${list(failed.map((verdict) => verdict.dimension))} verdict is a fail; waiting for an implementor session` };
  }
  if (change.verdicts.some((verdict) => verdict.stale && verdict.dimension === "review")) {
    return { actor: "agent", tone: "waiting", since: change.updatedAt, reason: "it has a new revision since the last review; waiting for a reviewer session" };
  }
  const level = ctx.index.snapshot.level;
  // Below level 3 nobody reviews, and the review switch is not shown: the change waits for its implementor to merge it.
  if (level !== undefined && level < 3) return belowReviewTurn(change, level, ctx);
  const paused = ctx.index.snapshot.review !== "started" ? ", and review is paused (Resume on In review)" : "";
  return { actor: "agent", tone: paused ? "blocked" : "waiting", since: change.updatedAt, reason: `waiting for a reviewer session${paused}` };
}

/** A change not merged below level 3, where nobody reviews: at level 2 its implementor merges it; below that nothing is built or merged. */
function belowReviewTurn(change: Change, level: number, ctx: TurnContext): Draft {
  if (level < 2) return { actor: "nobody", tone: "blocked", since: change.updatedAt, reason: `its change is not merged, and at level ${level} nothing is built or merged (raise the level to go on)` };
  const paused = ctx.index.snapshot.implement !== "started" ? ", but implementors are paused (Resume on In progress)" : "";
  return { actor: "agent", tone: paused ? "blocked" : "waiting", since: change.updatedAt, reason: `its change is not merged; nobody reviews at level 2: its implementor merges it${paused}` };
}

function queueTurn(situation: Situation, change: Change, ctx: TurnContext): Draft {
  const { batch, member } = situation;
  if (change.mergeable === false) {
    const why = change.blockers && change.blockers.length > 0 ? `: ${change.blockers.join("; ")}` : "";
    return { actor: "agent", tone: "blocked", since: change.updatedAt, reason: `approved, but it cannot merge${why}; the branch needs a rebase on main` };
  }
  if (batch && batch.status === "forming") return { actor: "queue", tone: "waiting", since: change.updatedAt, reason: `in ${batchName(batch.ref)}, which is being prepared for its check` };
  const again = batch && member?.state === "requeued" ? `back in the queue after ${batchName(batch.ref)} failed on another change` : "approved";
  // Below level 4 Scope Soup merges nothing and the merge queue's switch is not shown: the implementor (or a person) merges it.
  const level = ctx.index.snapshot.level;
  if (level !== undefined && level < 4 && !batch) {
    const merger = level >= 2 ? "its implementor or a person" : "a person";
    return { actor: "nobody", tone: "waiting", since: change.updatedAt, reason: `${again}; at level ${level} Scope Soup merges nothing itself: ${merger} merges it` };
  }
  if (ctx.index.snapshot.paused) return { actor: "queue", tone: "blocked", since: change.updatedAt, reason: `${again}, but the queue is paused` };
  const position = ctx.queue.indexOf(refKey(change.ref));
  const place = position >= 0 ? ` (position ${position + 1} of ${ctx.queue.length})` : "";
  return { actor: "queue", tone: "waiting", since: change.updatedAt, reason: `${again}; waiting in the queue${place}` };
}

function testTurn(situation: Situation, ctx: TurnContext): Draft {
  const batch = situation.batch!;
  const name = batchName(batch.ref);
  const { snapshot } = ctx.index;
  if (batch.status === "bisecting") {
    const suspect = batch.suspect && situation.change && refKey(batch.suspect) === refKey(situation.change.ref);
    return {
      actor: "queue",
      tone: suspect ? "blocked" : "waiting",
      since: batch.startedAt,
      reason: suspect ? `${name} failed and this change is the suspect; the bisect is checking` : `${name} failed; a bisect is finding which change broke it`,
    };
  }
  const progress = batchProgress(batch, ctx.index.run, snapshot.runs, ctx.now);
  if (progress.state === "waiting-for-runner") {
    const none = snapshot.runners.length > 0 && !snapshot.runners.some((runner) => runner.online);
    return { actor: "runner", tone: none ? "blocked" : "waiting", since: progress.startedAt, reason: none ? `in ${name}, waiting for a runner: none is online` : `in ${name}, ${progress.words}` };
  }
  return { actor: "runner", tone: progress.likelyStuck ? "blocked" : "moving", since: progress.startedAt ?? batch.startedAt, reason: `in ${name}, checking: ${progress.words}` };
}

/**
 * The orchestrator put the item down and waits for a person. Each kind says what is asked of them. A question (a decision
 * or what an item needs before it can start) is everyone's turn until someone answers it. A hand-over or an escalation on
 * an item a person holds or handed back is that person's turn; otherwise everyone's.
 */
function parkedTurn(parked: Parked, situation: Situation): Draft {
  const person = parked.as === "needs-decision" || parked.as === "not-ready" ? undefined : personOf(situation);
  const base = { ...(person ? { actor: "person" as const, person } : { actor: "anyone" as const }), tone: "yours" as const, since: parked.at };
  if (parked.as === "needs-decision") {
    const count = (n: number): string => `${n} question${n === 1 ? "" : "s"}`;
    if (parked.proposal) return { ...base, waits: "a restructuring to accept", reason: `Accept, edit or reject the proposed restructuring: ${parked.proposal.reason}` };
    const open = (parked.questions ?? []).filter((question) => question.answer === undefined);
    if ((parked.questions ?? []).length > 0) return { ...base, waits: open.length === 0 && parked.rewrite ? "a rewrite to accept" : count(open.length), reason: `Answer ${open.length} of ${parked.questions!.length} questions: ${(open[0] ?? parked.questions![0]!).question}` };
    if (parked.decision && parked.decision.options.length > 0) return { ...base, waits: "1 question", reason: `Pick an option: ${parked.decision.question}` };
    return { ...base, waits: parked.rewrite ? "a rewrite to accept" : "1 question", reason: `Answer the question: ${parked.decision?.question ?? parked.reason}` };
  }
  if (parked.as === "handed-over") {
    const { change, item } = situation;
    const what = change ? `Merge pull request ${change.ref.id}` : `Merge branch ${ITEM_BRANCH_PREFIX}${item.ref.id}`;
    return { ...base, waits: "to merge", reason: `${what}: handed over to you. ${parked.reason}` };
  }
  if (parked.as === "not-ready") return { ...base, waits: "not ready", reason: `Answer or edit the item so it can start: ${parked.reason}` };
  return { ...base, waits: "escalated", reason: `Look at it and decide what next: the agents gave up. ${parked.reason}` };
}


function draft(situation: Situation, ctx: TurnContext): Draft {
  const { item, lane, change } = situation;
  if (lane === null) return { actor: "nobody", tone: "done", reason: item.duplicateOf ? `duplicate of ${refLabel(item.duplicateOf)}` : "abandoned" };
  if (lane === "done") {
    return { actor: "nobody", tone: "done", reason: item.state === "done" ? "done" : "its change is merged; waiting for the host to close the item" };
  }
  const parked = ctx.index.parkedByWork.get(refKey(item.ref));
  // An item split into sub-items is an umbrella: a "too large, split it" verdict is spent.
  if (parked?.as === "not-ready" && lane === "backlog" && item.state === "todo") {
    if (item.openChildren > 0) return umbrellaTurn(item);
    if ((item.children ?? 0) > 0) return allPartsDoneTurn(item);
  }
  if (parked && parked.as !== "queued") return parkedTurn(parked, situation);
  if (item.needsDecision) return { actor: "anyone", tone: "yours", waits: "1 question", reason: "Answer the question: the item needs a decision" };
  // Another Item's triage proposed a rewrite of the description (decision 110): a person's turn while nothing else runs on the Item.
  const proposed = (lane === "backlog" || lane === "blocked") && !situation.session ? ctx.index.snapshot.proposedRewrites?.find((each) => refKey(each.subject) === refKey(item.ref)) : undefined;
  if (proposed) return { actor: "anyone", tone: "yours", since: proposed.at, waits: "a rewrite to accept", reason: `Accept, edit or reject the rewrite of the description by ${proposed.askedBy}` };
  if (lane === "backlog" || lane === "blocked") return backlogTurn(situation, ctx);
  if (lane === "in-progress" || !change) return progressTurn(situation, ctx);
  if (lane === "in-review") return reviewTurn(situation, change, ctx);
  if (lane === "queued") return queueTurn(situation, change, ctx);
  return testTurn(situation, ctx);
}

export function assess(situation: Situation, ctx: TurnContext): Assessment {
  const result = draft(situation, ctx);
  const turn: Turn = {
    subject: situation.item.ref,
    actor: result.actor,
    ...(result.person ? { person: result.person } : {}),
    reason: result.reason,
    ...(result.waits ? { waits: result.waits } : {}),
    since: result.since ?? situation.item.updatedAt,
    unblocks: ctx.unblocks.get(refKey(situation.item.ref)) ?? 0,
  };
  return { situation, turn, tone: result.tone };
}

/** Every item on the board with its turn, in snapshot order. Abandoned items are left out. */
export function assessAll(index: Index, now: Date, notTriaged?: ReadonlySet<string>): Assessment[] {
  const ctx = turnContext(index, now, notTriaged);
  return index.snapshot.works.map((item) => assess(situate(item, index), ctx)).filter((assessment) => assessment.situation.lane !== null);
}

/**
 * This turn is the viewer's. Everyone's turns (questions) are on every board: people are equals and anyone answers. A
 * person's turn is only that person's board's. A board that does not know its person (none picked) shows every person's turn.
 */
export function isMyTurn(turn: Pick<Turn, "actor" | "person">, self?: Self): boolean {
  if (turn.actor === "anyone") return true;
  if (turn.actor !== "person" || !turn.person) return false;
  return !self?.person || isSelfPerson(turn.person, self);
}

/** The viewer's list: everyone's turns and the viewer's own, most unblocking first, then longest waiting. */
export function yourTurn<T extends { turn: Turn }>(assessments: readonly T[], self?: Self): T[] {
  return assessments
    .filter((assessment) => isMyTurn(assessment.turn, self))
    .sort((a, b) => (b.turn.unblocks ?? 0) - (a.turn.unblocks ?? 0) || (a.turn.since ?? "").localeCompare(b.turn.since ?? ""));
}
