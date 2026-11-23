// The item page: the item drawn with everything attached. It stores nothing of its own.

import type { Ref, Run, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { assumptionViews, batchView, changeLink, itemLink, sessionView } from "./board.ts";
import { runProgress } from "./estimates.ts";
import type { Self } from "./holdings.ts";
import { actorParts, holdDetails } from "./holdings.ts";
import { situate } from "./lanes.ts";
import { buildRounds } from "./rounds.ts";
import type { Snapshot } from "./snapshot.ts";
import { buildIndex, refLabel } from "./snapshot.ts";
import { assess, isMyTurn, turnContext } from "./turns.ts";
import type { ItemChangeView, ItemPage, RunView } from "./views.ts";

/** Where the decision is. A host with a log (meta branch) has it on this page; another host has it at the item's link. */
function decisionWords(item: WorkItem): string {
  if (!item.needsDecision) return "No decision is waiting.";
  if ((item.openQuestions ?? []).some((question) => question.proposal)) return "This item waits for your decision on the proposed split below.";
  if ((item.openQuestions ?? []).length > 0) return "This item waits for your answer to the question below.";
  if (item.hostState.includes("conflict:")) return "The item's text was changed on two machines. Keep one version or write the result below.";
  if (!item.ref.url) return "This item waits for your decision.";
  return "This item waits for your decision. The options and the discussion are on the host.";
}

/**
 * Accepts a Ref or its refKey ("host:work:id"). Returns null when the item is not in the snapshot. `blocking`: the open Items
 * this one blocks as its host says (GitHub's dependencies); without it they are found in the snapshot.
 */
/** `self`: this board's person, so a person's turn says whether it is theirs. */
export function buildItemPage(snapshot: Snapshot, ref: Ref | string, now: Date, blocking?: Ref[], self?: Self): ItemPage | null {
  const index = buildIndex(snapshot);
  const key = typeof ref === "string" ? ref : refKey(ref);
  const item = index.work.get(key);
  if (!item) return null;
  const { turn, tone, situation } = assess(situate(item, index), turnContext(index, now));

  const changes = [...(index.changesByWork.get(key) ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const changeKeys = new Set(changes.map((change) => refKey(change.ref)));
  const batches = snapshot.batches
    .filter((batch) => batch.members.some((member) => changeKeys.has(refKey(member.change))))
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

  // Runs on a revision of one of the changes, plus the runs of its batches and their probes.
  const shas = new Set(changes.flatMap((change) => change.revisions.map((revision) => revision.sha)));
  const runKeys = new Set<string>();
  for (const batch of batches) for (const run of [...batch.runs, ...batch.probes.flatMap((probe) => (probe.run ? [probe.run] : []))]) runKeys.add(refKey(run));
  const runs: Run[] = snapshot.runs
    .filter((run) => shas.has(run.sha) || runKeys.has(refKey(run.ref)))
    .sort((a, b) => (b.startedAt ?? b.createdAt ?? "").localeCompare(a.startedAt ?? a.createdAt ?? ""));

  const sessions = [...(index.sessionsBySubject.get(key) ?? []), ...changes.flatMap((change) => index.sessionsBySubject.get(refKey(change.ref)) ?? [])]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(sessionView);

  const parent = item.parent ? (index.work.has(refKey(item.parent)) ? itemLink(item.parent, index) : { ref: item.parent, label: refLabel(item.parent) }) : undefined;
  const page: ItemPage = {
    now: now.toISOString(),
    item: {
      ...itemLink(item.ref, index),
      body: item.body,
      state: item.state,
      hostState: item.hostState,
      labels: item.labels,
      verification: item.verification,
      priority: item.priority,
      holder: item.holder ? { ...item.holder, ...holdDetails(item, now) } : undefined,
      parent,
      openChildren: item.openChildren,
      updatedAt: item.updatedAt,
      url: item.ref.url,
    },
    lane: situation.lane,
    actor: turn.actor,
    ...(turn.actor === "person" && turn.person ? { person: { name: actorParts(turn.person).who, mine: isMyTurn(turn, self) } } : {}),
    reason: turn.reason,
    tone,
    unblocks: turn.unblocks ?? 0,
    decision: { needed: item.needsDecision === true, words: decisionWords(item) },
    questions: item.openQuestions ?? [],
    answers: (snapshot.answers ?? [])
      .filter((answer) => refKey(answer.subject) === key)
      .sort((a, b) => a.at.localeCompare(b.at))
      .map(({ question, answer, by, at }) => ({ ...(question ? { question } : {}), answer, by, at })),
    blockedBy: item.blockedBy.map((blocker) => {
      const other = index.work.get(refKey(blocker));
      return { ...itemLink(blocker, index), open: other ? other.state !== "done" && other.state !== "abandoned" : false };
    }),
    blocks: blocking
      ? blocking.map((other) => itemLink(other, index))
      : snapshot.works
        .filter((other) => other.state !== "done" && other.state !== "abandoned" && other.blockedBy.some((blocker) => refKey(blocker) === key))
        .map((other) => itemLink(other.ref, index)),
    changes: changes.map((change): ItemChangeView => {
      const current = change.revisions[change.revisions.length - 1];
      return {
        ...changeLink(change),
        state: change.state,
        target: change.target,
        author: change.author,
        revisions: change.revisions.length,
        sha: current?.sha ?? "",
        verdicts: change.verdicts.map(({ dimension, value, score, by, stale, url }) => ({ dimension, value, score, by, stale, url })),
        mergeable: change.mergeable,
        blockers: change.blockers ?? [],
        updatedAt: change.updatedAt,
      };
    }),
    runs: runs.map((run): RunView => ({
      ref: run.ref,
      pipeline: run.pipeline,
      status: run.status,
      sha: run.sha,
      runner: run.runner,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      progress: runProgress(run, snapshot.runs, now),
      url: run.ref.url,
    })),
    batches: batches.map((batch) => {
      const position = batch.members.findIndex((member) => changeKeys.has(refKey(member.change)));
      return { batch: batchView(batch, index, now), memberState: batch.members[position]!.state, position: position + 1 };
    }),
    sessions: { live: sessions.filter((session) => session.live), finished: sessions.filter((session) => !session.live) },
    rounds: [],
    history: item.history ?? [],
    assumptions: assumptionViews(item, index),
  };
  const parked = index.parkedByWork.get(key);
  // The steps from the item's log (meta branch), or from Scope Soup's log comment (GitHub); costs and links from the store's sessions.
  const mergedMark = item.merged && !item.merged.reopened ? item.merged : undefined;
  page.rounds = buildRounds({
    log: item.log ?? item.hostRecord?.log ?? [],
    sessions: index.sessionsBySubject.get(key) ?? [],
    ...(parked ? { parked } : {}),
    ...(mergedMark ? { merged: mergedMark } : {}),
  });
  const proposed = (item.openQuestions ?? []).filter((question) => question.proposal).pop();
  const proposal = proposed?.proposal ?? parked?.proposal;
  if (proposal) {
    // The children made so far are only in Scope Soup's store (the rest), not in the log's question line; the parts are fixed once one exists.
    const created = parked?.proposal?.created ?? [];
    // The stored parts are a person's edit (or fixed once a child exists); the log's line keeps triage's.
    const parts = parked?.proposal?.parts ?? proposal.parts;
    page.proposal = {
      reason: proposal.reason,
      parts,
      ...(proposal.carried ? { carried: proposal.carried } : {}),
      ...(created.length > 0 ? { created: created.map((child) => itemLink(child.ref, index)) } : {}),
      ...(proposed ? { at: proposed.at, by: proposed.by } : {}),
    };
  }
  if (parked) {
    // "queued" and "handed-over" are ends of the cycle, not questions: an answer does not restart them.
    const canAnswer = parked.as === "needs-decision" || parked.as === "not-ready" || parked.as === "escalated";
    page.parked = { as: parked.as, reason: parked.reason, at: parked.at, canAnswer, ...(parked.canStartOver ? { canStartOver: true } : {}), ...(parked.decision ? { decision: parked.decision } : {}), ...(parked.questions && parked.questions.length > 0 ? { questions: parked.questions } : {}), ...(parked.refine ? { refine: parked.refine } : {}) };
  }
  const links = (snapshot.links ?? []).find((each) => refKey(each.subject) === key)?.links ?? [];
  if (links.length > 0) {
    page.links = links.map((link) => {
      const id = link.item.replace(`${item.ref.host}:work:`, "").replace(/^#/, "");
      const other = [...index.work.values()].find((work) => work.ref.host === item.ref.host && work.ref.id === id);
      return { type: link.type, item: other ? itemLink(other.ref, index) : { label: link.item }, ...(link.reason ? { reason: link.reason } : {}) };
    });
  }
  return page;
}
