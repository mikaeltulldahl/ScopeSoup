// Questions an agent asks about another Item than its own, and from triage a rewrite of that Item's description
// (`aboutOthers` in its answer). Scope Soup, not the agent, writes them on that Item as triage's own rewrite and questions are
// written (`writeAboutOthers` in cycle.ts), once no session runs on it and nobody holds it. Until then they wait here, in the
// store, by the other Item's ref key. Kept apart from the jobs, as overturns are, so the asker's job and the other Item's never race.

import type { RecordedAnswer, Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { holdStands } from "../model/people.ts";
import { asksAboutDuplicate, duplicateSettled, itemTextHash, optionTexts, reusableAnswer, sameDecision } from "../core/answerReuse.ts";
import { knownAnswers } from "../store/answers.ts";
import type { Store } from "../store/store.ts";
import type { Context } from "./context.ts";
import type { AboutOther, Decision, Job } from "./jobs.ts";
import { changedRewrite, sameText, where } from "./jobs.ts";
import type { ProposedRewriteView } from "../core/snapshot.ts";
import { plural } from "../model/plural.ts";
import { changeHandedOn, sessionOf, stepOf } from "../core/phase.ts";
import { phaseOf } from "./phase.ts";

/** Questions (and a rewrite) waiting to be written on another Item. Agent text: data. */
export interface WaitingAbout {
  /** Who asked, in words: "the implementor of A-12", "triage of A-3". */
  askedBy: string;
  /** The asker's Item, by ref key. */
  from: string;
  /** Each question names who asked. */
  questions: Decision[];
  rewrite?: string;
  at: string;
}

/** By the other Item's ref key, oldest first. */
export type WaitingAbouts = Record<string, WaitingAbout[]>;

const KEY = "orchestrator.aboutOthers";

export function readWaitingAbouts(store: Store): WaitingAbouts {
  const text = store.getValue(KEY);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as WaitingAbouts) : {};
  } catch {
    return {};
  }
}

/** Writes the list; call it in the transaction that writes the event. */
export function writeWaitingAbouts(store: Store, waiting: WaitingAbouts): void {
  for (const key of Object.keys(waiting)) if (waiting[key]!.length === 0) delete waiting[key];
  store.setValue(KEY, JSON.stringify(waiting));
}

/**
 * A rewrite of an Item's description that another Item's triage gave with no question (decision 110). It never touches that Item's
 * job: it waits here, by the Item's ref key, for a person's Accept, Edit or Reject (`POST /api/proposed-rewrite`). A newer one for the
 * same Item replaces it. Agent text: data.
 */
export interface ProposedRewrite {
  /** "triage of A-3". */
  askedBy: string;
  /** The asker's Item, by ref key. */
  from: string;
  /** The description the rewrite was compared with. */
  original: string;
  text: string;
  at: string;
}

const PROPOSED = "orchestrator.proposedRewrites";

export function readProposedRewrites(store: Store): Record<string, ProposedRewrite> {
  const text = store.getValue(PROPOSED);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, ProposedRewrite>) : {};
  } catch {
    return {};
  }
}

/**
 * The proposed rewrites a person may still decide: their Item is open, and its description does not read as the rewrite already
 * (whitespace aside). One whose Item was edited since stays, shown with the description as it is now; Accept is then refused.
 */
export function openProposedRewrites(store: Store): ProposedRewriteView[] {
  const works = new Map(store.list<WorkItem>("work").map((work) => [refKey(work.ref), work]));
  return Object.entries(readProposedRewrites(store)).flatMap(([key, each]) => {
    const work = works.get(key);
    return work && isOpenItem(work) && !sameText(work.body ?? "", each.text) ? [{ subject: work.ref, askedBy: each.askedBy, original: each.original, text: each.text, at: each.at }] : [];
  });
}

/** Writes the map; call it in the transaction that writes the event. */
export function writeProposedRewrites(store: Store, proposed: Record<string, ProposedRewrite>): void {
  store.setValue(PROPOSED, JSON.stringify(proposed));
}

/** The Item a name from an agent points at (`#12`, `12`, `A-3` or a ref key), on the subject's own host; null when the store has none, or it is the subject itself. */
export function linkedItem(store: Store, subject: Ref, name: string): WorkItem | null {
  let id = name.trim();
  const prefix = `${subject.host}:work:`;
  if (id.startsWith(prefix)) id = id.slice(prefix.length);
  id = id.replace(/^#/, "");
  if (id === subject.id) return null;
  return store.list<WorkItem>("work").find((work) => work.ref.host === subject.host && work.ref.id === id) ?? null;
}

const clip = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

export const isOpenItem = (work: WorkItem): boolean => work.state !== "done" && work.state !== "abandoned";

/** "triage of A-3", "the implementor of A-12". */
export function askerName(role: "triage" | "implement", item: Ref): string {
  return role === "triage" ? `triage of ${item.id}` : `the implementor of ${item.id}`;
}

const plain = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Why a question about `other` is not asked there again, or null: the same question (the asker named in it, its text matched as
 * answers are for reuse) already waits to be written on it, is open there now, or was answered there on its text as it is now.
 * An answer given to the questions all at once is kept with the parked reason as its question, so that text containing it counts too.
 */
export function askedBefore(ctx: Context, other: WorkItem, question: Decision): string | null {
  const key = refKey(other.ref);
  const asked = { question: question.question, options: optionTexts(question.options) };
  const same = (each: Decision) => sameDecision(asked, { question: each.question, options: optionTexts(each.options) });
  if ((readWaitingAbouts(ctx.deps.store)[key] ?? []).some((entry) => entry.questions.some(same))) return "it already waits to be asked there";
  const job = ctx.jobs[key];
  if (where(job)?.parked?.as === "needs-decision" && job!.rewrite?.questions.some(same)) return "it is open there";
  const answers = knownAnswers(ctx.deps.store);
  const hash = itemTextHash(other);
  const found = reusableAnswer(answers, other, question)
    ?? answers.findLast((answer) => refKey(answer.subject) === key && answer.textHash === hash && plain(answer.question ?? "").includes(plain(question.question)));
  return found ? `a person answered it there at ${found.at} ("${clip(found.answer.trim(), 300)}")` : null;
}

/** Who already proposed this rewrite of `other`'s description (whitespace aside), or null: its own triage, or another Item's. */
function proposedThere(store: Store, job: Job | undefined, other: WorkItem, rewrite: string): string | null {
  const key = refKey(other.ref);
  if (job?.rewrite && sameText(job.rewrite.text, rewrite)) return job.rewrite.askedBy ? `${job.rewrite.askedBy.join(" and ")} proposed` : "its own triage proposed";
  const proposed = readProposedRewrites(store)[key];
  if (proposed && sameText(proposed.text, rewrite)) return `${proposed.askedBy} proposed`;
  const waiting = (readWaitingAbouts(store)[key] ?? []).find((entry) => entry.rewrite !== undefined && sameText(entry.rewrite, rewrite));
  return waiting ? `${waiting.askedBy} proposed` : null;
}

/**
 * Why an agent's question about which of `asker` and `other` to keep is not asked, or null: Scope Soup asks that itself
 * (`duplicateQuestion`), so it is dropped when the asker's triage reports one a duplicate of the other (`reported`), or a person
 * already settled the duplicate question about the pair (`duplicatePairSettled`): asking again could only contradict it.
 */
export function duplicateAsked(ctx: Context, asker: Ref, other: Ref, question: Decision, reported: boolean): string | null {
  if (!asksAboutDuplicate(question, asker.id, other.id)) return null;
  const answered = duplicatePairSettled(ctx.deps.store, asker, other);
  if (answered) return `a person answered which of ${asker.id} and ${other.id} closes at ${answered.at} ("${clip(answered.answer.trim(), 300)}")`;
  return reported ? `Scope Soup asks which of ${asker.id} and ${other.id} closes itself` : null;
}

/** The person's answer that settled which of `a` and `b` closes: "Keep both", or a close that took effect (`duplicateSettled`). */
export function duplicatePairSettled(store: Store, a: Ref, b: Ref, answers: readonly RecordedAnswer[] = knownAnswers(store)): RecordedAnswer | undefined {
  return duplicateSettled(answers, a, b, (id) => store.get<WorkItem>({ ...a, id })?.state === "abandoned");
}

/** The Items a triage answer reports this one a duplicate of, by ref key. */
export function reportedDuplicates(store: Store, subject: Ref, links: readonly { type: string; item: string }[] | undefined): Set<string> {
  const found = new Set<string>();
  for (const link of links ?? []) {
    if (link.type !== "duplicateOf") continue;
    const other = linkedItem(store, subject, link.item);
    if (other) found.add(refKey(other.ref));
  }
  return found;
}

/**
 * Keeps an answer's questions about other Items, each naming who asked, until they are written on that Item. An unknown or closed
 * Item (or the asker's own) is dropped with an event; so is a rewrite that changes nothing with no question, and a question already
 * open or answered there (`askedBefore`).
 */
export function keepAboutOthers(ctx: Context, job: Job, role: "triage" | "implement", list: readonly AboutOther[] | undefined): void {
  if (!list || list.length === 0) return;
  const { store } = ctx.deps;
  const subject = refKey(job.item);
  const askedBy = askerName(role, job.item);
  const duplicates = role === "triage" ? reportedDuplicates(store, job.item, job.triage?.links) : new Set<string>();
  for (const entry of list) {
    const other = linkedItem(store, job.item, entry.item);
    if (!other || !isOpenItem(other)) {
      const why = other ? `it is ${other.state}` : "there is no such open Item other than its own";
      ctx.commit("orchestrator.about_other_dropped", `The ${role === "triage" ? "triage" : "implementor"} of ${job.item.id} asked about ${JSON.stringify(entry.item.slice(0, 60))}, but ${why}: ${plural(entry.questions.length, "question")}${entry.rewrite ? " and a rewrite" : ""} dropped.`, subject, { item: entry.item.slice(0, 200) });
      continue;
    }
    // Whitespace alone, or the Verification field appended again, is no change (decision 110); nor is a rewrite already proposed there.
    let rewrite = changedRewrite(entry.rewrite, other.body, other.verification) || undefined;
    const repeated = rewrite !== undefined ? proposedThere(store, ctx.jobs[refKey(other.ref)], other, rewrite) : null;
    if (repeated) {
      ctx.commit("orchestrator.about_other_dropped", `Triage of ${job.item.id} rewrote ${other.ref.id}'s description as ${repeated} already: the rewrite is dropped.`, subject, { item: refKey(other.ref), again: true });
      rewrite = undefined;
    }
    const questions: Decision[] = [];
    for (const each of entry.questions) {
      const question = { ...each, question: `${each.question.trim()} (asked by ${askedBy})` };
      const duplicate = duplicateAsked(ctx, job.item, other.ref, each, duplicates.has(refKey(other.ref)));
      if (duplicate) {
        ctx.commit("orchestrator.about_other_dropped", `${askedBy[0]!.toUpperCase()}${askedBy.slice(1)} asked ${other.ref.id} which duplicate to keep: ${clip(each.question.trim(), 300)} Not asked: ${duplicate}.`, subject, { item: refKey(other.ref), duplicate: true });
        continue;
      }
      const why = askedBefore(ctx, other, question);
      if (!why) questions.push(question);
      else ctx.commit("orchestrator.about_other_dropped", `${askedBy[0]!.toUpperCase()}${askedBy.slice(1)} asked about ${other.ref.id} again: ${clip(each.question.trim(), 300)} Not asked again: ${why}.`, subject, { item: refKey(other.ref), again: true });
    }
    if (questions.length === 0 && !rewrite) {
      if (entry.questions.length === 0 && !repeated) ctx.commit("orchestrator.about_other_dropped", `Triage of ${job.item.id} rewrote ${other.ref.id}'s description as it already is (whitespace aside), with no question: nothing to write.`, subject, { item: refKey(other.ref) });
      continue;
    }
    const key = refKey(other.ref);
    if (questions.length === 0 && rewrite) {
      store.tx(() => proposeRewrite(ctx, other, askedBy, subject, rewrite));
      continue;
    }
    store.tx(() => {
      const waiting = readWaitingAbouts(store);
      waiting[key] = [...(waiting[key] ?? []), { askedBy, from: subject, questions, ...(rewrite ? { rewrite } : {}), at: ctx.at }];
      writeWaitingAbouts(store, waiting);
      ctx.commit("orchestrator.about_other_kept", `${askedBy[0]!.toUpperCase()}${askedBy.slice(1)} asked ${plural(questions.length, "question")}${rewrite ? " and gave a rewrite of its description" : ""} about ${other.ref.id}; Scope Soup writes them there once no session runs on it and nobody holds it.`, key, { from: subject, questions: questions.length, rewrite: rewrite !== undefined });
    });
  }
}

/**
 * Only a rewrite of `other`'s description from another Item's triage: proposed there for a person, and its job is left as it is
 * (decision 110). Call it in a transaction.
 */
export function proposeRewrite(ctx: Context, other: WorkItem, askedBy: string, from: string, rewrite: string): void {
  const { store } = ctx.deps;
  const key = refKey(other.ref);
  const proposed = readProposedRewrites(store);
  proposed[key] = { askedBy, from, original: (other.body ?? "").trim(), text: rewrite, at: ctx.at };
  writeProposedRewrites(store, proposed);
  ctx.commit("orchestrator.rewrite_proposed", `${askedBy[0]!.toUpperCase()}${askedBy.slice(1)} proposed a rewrite of ${other.ref.id}'s description, with no question: it waits for a person to accept, edit or reject it, and ${other.ref.id}'s work goes on as it is.`, key, { from });
}

/**
 * Why questions from other Items cannot be written on this Item now, or null when they can: a session or a person's chat runs
 * on it, someone else holds it, it waits for an answer to questions of its own, or its change is in review, merged, queued or handed over.
 * This machine's own claim does not count: its job holds it.
 */
export function busyWhy(ctx: Context, item: WorkItem, job: Job | undefined): string | null {
  const working = workingWhy(ctx, item, job);
  if (working) return working;
  if (job && phaseOf(job).at === "asked") return "it waits for a person's answer to its own questions";
  return null;
}

/** As `busyWhy`, but an Item waiting for an answer to its own questions is free: why the Item's work cannot be taken from it now. */
export function workingWhy(ctx: Context, item: WorkItem, job: Job | undefined): string | null {
  if (ctx.deps.runner.busy?.(item.ref)) return "a person is talking to one of its sessions";
  const phase = job ? phaseOf(job) : undefined;
  if (phase && sessionOf(phase)) return `its ${stepOf(phase)} session runs`;
  const holder = item.holder;
  if (holder && holdStands(holder, Date.parse(ctx.at)) && !(holder.actor.bot && holder.actor.id === ctx.deps.actions.claimant)) return `it is held by ${holder.actor.name}`;
  if (!job || !phase) return null;
  // A change in review (its session about to start, or between attempts) is not pulled back to triage by another Item's question.
  if (phase.at === "review") return "its change is in review";
  if (changeHandedOn(phase) || job.queued !== undefined) return "its change is merged, in the merge queue or handed over";
  return null;
}
