// The order of the backlog (decision 79): each Item gets a score from what is known of it, the vote is added, and
// the Items go by score, highest first. Pure. The weights are the fixed defaults in `WEIGHTS`, documented in docs/RUNNING.md.
//
// What stays outside the score: Items that had a triage come before those that did not, and a `blocker` Item goes
// before every other Item that has the same triage standing.

import type { Priority, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { cleanVote, voteWords } from "../model/vote.ts";
import type { Job, Jobs, TriageAnswer } from "./jobs.ts";

/** The weights, in points. One place: change them here and in docs/RUNNING.md ("How the backlog is ordered"). */
export const WEIGHTS = {
  /** A `blocker` goes first whatever its score; its points only order blockers. An Item without a priority gets `noPriority`: below major, above minor. */
  priority: { blocker: 100, critical: 60, major: 30, minor: -30 } satisfies Record<Priority, number>,
  noPriority: 0,
  /** A bug: an Item with one of the project's bug labels. */
  bug: 10,
  /** Per open Item this one blocks, up to `unblocksMost` Items. */
  unblocks: 5,
  unblocksMost: 4,
  /** Already started: code has been written (a branch ahead of main, or the implement or review step). Finishing beats starting. */
  started: 35,
  /** Per open Item that is newer: slow, so with 100 open Items the oldest gets 25 more than the newest and nothing waits forever. */
  agePerPlace: 0.25,
  /** Subtracted by the size the triage gave; no size counts as medium. */
  size: { small: 0, medium: 3, large: 8 } satisfies Record<TriageAnswer["size"], number>,
  /** A vote that moves an Item past the top (or bottom) of its group: this many points beyond the Item it passes. */
  voteMargin: 1,
  /** A vote between two Items with the same score: this many points beyond them. */
  voteGap: 0.05,
} as const;

export type PartName = "priority" | "bug" | "unblocks" | "started" | "age" | "size" | "vote";

export interface Score {
  key: string;
  /** Had its triage: only these count bugs, size, blocking and having started. */
  triaged: boolean;
  /** Priority `blocker`: goes first among the Items with the same standing. */
  blocker: boolean;
  points: number;
  /** Points per part, as they were added (size is negative). */
  parts: Record<PartName, number>;
  unblocks: number;
  vote: number;
}

/** What scoring needs besides the Item: all the Items (to count whom one blocks and how old it is), the jobs and the bug labels. */
export interface ScoreContext {
  all: WorkItem[];
  jobs: Jobs;
  bugLabels: string[];
}

const OPEN = (item: WorkItem): boolean => item.state !== "done" && item.state !== "abandoned";

/**
 * The model has no creation time. Numeric ids on one host are handed out in order, so the lower one is older; otherwise the
 * Item untouched for longest goes first.
 */
export function older(a: WorkItem, b: WorkItem): number {
  if (a.ref.host === b.ref.host && /^\d+$/.test(a.ref.id) && /^\d+$/.test(b.ref.id)) return Number(a.ref.id) - Number(b.ref.id);
  return Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || (a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0);
}

/**
 * The Item has had its triage: a `session` line of the triage (`role: triage`) in its log, whoever wrote it, or
 * a stored triage result, or its job is past the triage. Pure.
 */
export function hasTriage(item: WorkItem, job: Job | undefined): boolean {
  if ((item.log ?? []).some((line) => line.kind === "session" && line.fields.role === "triage")) return true;
  if (!job) return false;
  return job.triage !== undefined || job.step !== "triage";
}

/**
 * Already started means code has been written: the Item is in the review step, or an implement session has run for the job
 * (it recorded its answer in `implement`), or the job records a branch head (the
 * head last written to the log in a `revision` line) that differs from `base` (with no `base` recorded any head counts).
 * The implement step alone does not count, since a job has it right after the triage. An answered question, a session
 * besides the triage and a revision line alone do not count: clarifying an Item's intent does not make it more important.
 */
export function isStarted(_item: WorkItem, job: Job | undefined): boolean {
  if (!job) return false;
  return job.step === "review" || job.implement !== undefined || (job.head !== undefined && job.head !== job.base);
}

/** The scores of `items`, in the context of all Items. */
export function scoreItems(items: WorkItem[], context: ScoreContext): Map<string, Score> {
  const open = context.all.filter(OPEN).sort(older);
  const placeOf = new Map(open.map((item, place) => [refKey(item.ref), place]));
  const unblocked = new Map<string, number>();
  for (const item of open) for (const blocker of new Set(item.blockedBy.map(refKey))) unblocked.set(blocker, (unblocked.get(blocker) ?? 0) + 1);
  const bugs = new Set(context.bugLabels.map((label) => label.toLowerCase()));
  const scores = new Map<string, Score>();
  for (const item of items) {
    const key = refKey(item.ref);
    const job = context.jobs[key];
    const triaged = hasTriage(item, job);
    const vote = cleanVote(item.vote);
    const unblocks = unblocked.get(key) ?? 0;
    const newer = open.length - 1 - (placeOf.get(key) ?? open.length - 1);
    const parts: Record<PartName, number> = {
      priority: item.priority ? WEIGHTS.priority[item.priority] : WEIGHTS.noPriority,
      bug: triaged && item.labels.some((label) => bugs.has(label.toLowerCase())) ? WEIGHTS.bug : 0,
      unblocks: triaged ? Math.min(unblocks, WEIGHTS.unblocksMost) * WEIGHTS.unblocks : 0,
      started: triaged && isStarted(item, job) ? WEIGHTS.started : 0,
      age: newer * WEIGHTS.agePerPlace,
      size: triaged ? -WEIGHTS.size[job?.triage?.size ?? "medium"] : 0,
      vote,
    };
    const points = Object.values(parts).reduce((sum, each) => sum + each, 0);
    scores.set(key, { key, triaged, blocker: item.priority === "blocker", points, parts, unblocks: triaged ? unblocks : 0, vote });
  }
  return scores;
}

/** The comparison for `Array.sort`: triage, then a blocker, then the higher score; ties go to the older Item. */
export function compareItems(bugLabels: string[], jobs: Jobs, all: WorkItem[]): (a: WorkItem, b: WorkItem) => number {
  const scores = scoreItems(all, { all, jobs, bugLabels });
  const scoreOf = (item: WorkItem): Score => scores.get(refKey(item.ref)) ?? scoreItems([item], { all: [...all, item], jobs, bugLabels }).get(refKey(item.ref))!;
  return (a, b) => {
    const x = scoreOf(a);
    const y = scoreOf(b);
    return Number(y.triaged) - Number(x.triaged) || Number(y.blocker) - Number(x.blocker) || y.points - x.points || older(a, b);
  };
}

/** What a press of Vote up or Vote down does: the new vote (a score offset in points), or why the button is off. */
export type VoteMove = { ok: true; vote: number } | { ok: false; reason: string };

/**
 * One press of Vote up or Vote down (decision 79): the vote that puts Item `index` of `order` (the Items in the places the
 * board shows them) exactly one place up or down, within its own group: the Items that had a triage, or those that did
 * not, and a blocker among blockers. The score merges halfway between the two Items on that side (a fixed margin beyond the
 * last one when there is only one), the vote is that score less the Item's other points, rounded to 2 decimals. Pure; nothing
 * about the neighbours is kept.
 */
function moveVote(order: WorkItem[], scores: Map<string, Score>, index: number, direction: "up" | "down"): VoteMove {
  const scoreOf = (at: number): Score => scores.get(refKey(order[at]!.ref))!;
  const self = scoreOf(index);
  const sign = direction === "up" ? 1 : -1;
  const near = order[index - sign];
  const far = order[index - 2 * sign];
  const group = (score: Score): string => `${score.triaged}/${score.blocker}`;
  const edge = direction === "up" ? "first" : "last";
  if (!near) return { ok: false, reason: `Already ${edge} of the backlog.` };
  const nearScore = scoreOf(index - sign);
  if (group(nearScore) !== group(self)) {
    return { ok: false, reason: self.triaged !== nearScore.triaged ? `Already ${edge} among the Items ${self.triaged ? "triaged" : "not triaged yet"}.` : `Already ${edge} among the ${self.blocker ? "blockers" : "Items that are not blockers"}.` };
  }
  const farScore = far && group(scoreOf(index - 2 * sign)) === group(self) ? scoreOf(index - 2 * sign) : undefined;
  const base = self.points - self.parts.vote;
  const midpoint = farScore ? (nearScore.points + farScore.points) / 2 : nearScore.points + sign * WEIGHTS.voteMargin;
  const beyond = farScore ? (direction === "up" ? Math.max(nearScore.points, farScore.points) + WEIGHTS.voteGap : Math.min(nearScore.points, farScore.points) - WEIGHTS.voteGap) : midpoint;
  const compare = (a: WorkItem, aPoints: number, b: WorkItem, bPoints: number): number => bPoints - aPoints || older(a, b);
  const item = order[index]!;
  // Where the Item merges against its two neighbours with `vote`: the first candidate that gives exactly one place wins; two
  // neighbours with one score and no age between them leave only the small gap beyond both.
  const merges = (vote: number): boolean => {
    const points = base + vote;
    const passes = direction === "up" ? compare(item, points, order[index - 1]!, nearScore.points) < 0 : compare(order[index + 1]!, nearScore.points, item, points) < 0;
    const stops = !farScore || (direction === "up" ? compare(far!, farScore.points, item, points) < 0 : compare(item, points, far!, farScore.points) < 0);
    return passes && stops;
  };
  const candidates = [midpoint, beyond].map((points) => cleanVote(points - base));
  const vote = candidates.find(merges) ?? candidates[1]!;
  return { ok: true, vote };
}

/** The vote for one press of Vote up or Vote down on the Item with `key`, given the board's order of the backlog. */
export function voteForPlace(order: WorkItem[], key: string, direction: "up" | "down", context: ScoreContext): VoteMove {
  const index = order.findIndex((item) => refKey(item.ref) === key);
  if (index < 0) return { ok: false, reason: "Not in the backlog." };
  return moveVote(order, scoreItems(order, context), index, direction);
}

/** For every Item of `order`, why each button is off (absent when it works): what the board and the Item page show. */
export function voteLimits(order: WorkItem[], context: ScoreContext): Map<string, { up?: string; down?: string }> {
  const scores = scoreItems(order, context);
  const limits = new Map<string, { up?: string; down?: string }>();
  order.forEach((item, index) => {
    const up = moveVote(order, scores, index, "up");
    const down = moveVote(order, scores, index, "down");
    limits.set(refKey(item.ref), { ...(up.ok ? {} : { up: up.reason }), ...(down.ok ? {} : { down: down.reason }) });
  });
  return limits;
}

const ORDINAL_END: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };
/** 1st, 2nd, 3rd, 4th, 11th, 21st. */
export function ordinal(n: number): string {
  const end = n % 100 >= 11 && n % 100 <= 13 ? "th" : (ORDINAL_END[n % 10] ?? "th");
  return `${n}${end}`;
}

const BECAUSE: Record<PartName, (other: string, a: Score) => string> = {
  priority: (other) => `${other} has a higher priority`,
  bug: (other) => `${other} is a bug`,
  unblocks: (other, a) => `${other} unblocks ${a.unblocks}`,
  started: (other) => `${other} is already started`,
  age: (other) => `${other} is older`,
  size: (other) => `${other} is smaller`,
  vote: (other) => `${other} has more votes`,
};

/**
 * One line per Item of `order` (the Items in the places the board shows them, in the order `compareItems` gives): its place
 * and what counts for it in words, and what puts the Item before it ahead ("2nd: major bug, unblocks 2, small, voted up
 * once; behind #41 because #41 is already started"). The words name a vote, never its number.
 */
export function explainOrder(order: WorkItem[], context: ScoreContext): Map<string, string> {
  const scores = scoreItems(order, context);
  const why = new Map<string, string>();
  order.forEach((item, index) => {
    const score = scores.get(refKey(item.ref))!;
    const size = context.jobs[refKey(item.ref)]?.triage?.size;
    const reasons: string[] = [];
    if (score.parts.bug > 0) reasons.push(`${item.priority ? `${item.priority} ` : ""}bug`);
    else if (item.priority) reasons.push(item.priority);
    if (score.unblocks > 0) reasons.push(`unblocks ${score.unblocks}`);
    if (score.parts.started > 0) reasons.push("already started");
    if (score.triaged && size && size !== "medium") reasons.push(size);
    if (score.parts.age >= 5) reasons.push("waiting a long time");
    const vote = voteWords(score.vote);
    if (vote) reasons.push(vote);
    let text = `${ordinal(index + 1)}${reasons.length > 0 ? `: ${reasons.join(", ")}` : ""}`;
    const above = order[index - 1];
    if (above) {
      const other = scores.get(refKey(above.ref))!;
      const name = `#${above.ref.id}`;
      let because: string;
      if (other.triaged !== score.triaged) because = `${name} had its triage`;
      else if (other.blocker !== score.blocker) because = `${name} is a blocker`;
      else {
        let best: PartName | undefined;
        let most = 0;
        for (const part of Object.keys(score.parts) as PartName[]) {
          const gain = other.parts[part] - score.parts[part];
          if (gain > most) (most = gain), (best = part);
        }
        because = best ? BECAUSE[best](name, other) : `${name} is older`;
      }
      text += `${reasons.length > 0 ? "; " : ": "}behind ${name} because ${because}`;
    }
    why.set(refKey(item.ref), text);
  });
  return why;
}
