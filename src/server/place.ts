// A drop on the board at a place in a lane's order (#222): the vote that puts the Item right above another one (or last), in one
// step instead of pressing Vote up or Vote down place by place. The order is the score order (decision 79, `scoreItems`): the vote
// is a score offset, so the Item's score is set between the two Items it lands between, as one press does for its neighbours. It
// stays within its group (the Items that had a triage, or not; a blocker among blockers): a drop past the edge of the group lands
// at that edge, and the answer says so. Pure; nothing about the neighbours is kept.

import type { WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { cleanVote } from "../model/vote.ts";
import { older, scoreItems, WEIGHTS } from "../orchestrator/score.ts";
import type { Score, ScoreContext } from "../orchestrator/score.ts";

export type PlaceMove = { ok: true; vote: number; note?: string } | { ok: false; reason: string };

/** The group's rank: triaged before not, a blocker before the rest (as `compareItems`). */
const rank = (score: Score): number => (score.triaged ? 0 : 2) + (score.blocker ? 0 : 1);
const groupWords = (score: Score): string => (score.blocker ? (score.triaged ? "the blockers" : "the blockers not triaged yet") : score.triaged ? "the Items triaged" : "the Items not triaged yet");

/**
 * The vote that puts `item` right above the Item with key `before` in `order` (the lane's Items in the places the board shows them),
 * or last when `before` is null or not in it. `item` may be in `order` (a move within the lane) or not yet (it has just been moved in).
 */
export function voteToPlace(order: WorkItem[], item: WorkItem, before: string | null, context: ScoreContext): PlaceMove {
  const key = refKey(item.ref);
  const rest = order.filter((each) => refKey(each.ref) !== key);
  const scores = scoreItems([...rest, item], { ...context, all: context.all.some((each) => refKey(each.ref) === key) ? context.all : [...context.all, item] });
  const scoreOf = (each: WorkItem): Score => scores.get(refKey(each.ref))!;
  const self = scoreOf(item);
  const found = before === null ? -1 : rest.findIndex((each) => refKey(each.ref) === before);
  let at = found < 0 ? rest.length : found;
  const asked = at;
  // Within its group: past the Items of a group that goes first, before those of one that goes after.
  while (at > 0 && rank(scoreOf(rest[at - 1]!)) > rank(self)) at--;
  while (at < rest.length && rank(scoreOf(rest[at]!)) < rank(self)) at++;
  const note = at === asked ? undefined : `${item.ref.id} stays among ${groupWords(self)}: it goes ${at < asked ? "last" : "first"} of them.`;
  const withNote = (vote: number): PlaceMove => ({ ok: true, vote, ...(note ? { note } : {}) });
  // Where it is already: the vote stays.
  const now = order.findIndex((each) => refKey(each.ref) === key);
  if (now >= 0 && now === at) return withNote(self.vote);
  const same = (each: WorkItem | undefined): WorkItem | undefined => (each && rank(scoreOf(each)) === rank(self) ? each : undefined);
  const above = same(rest[at - 1]);
  const below = same(rest[at]);
  const base = self.points - self.parts.vote;
  // Ahead of `other` with `points`: the higher score, then the older Item (as `compareItems`).
  const ahead = (points: number, other: WorkItem): boolean => points - scoreOf(other).points > 0 || (points === scoreOf(other).points && older(item, other) < 0);
  const fits = (points: number): boolean => (!above || !ahead(points, above)) && (!below || ahead(points, below));
  let candidates: number[];
  if (above && below) {
    const high = scoreOf(above).points;
    const low = scoreOf(below).points;
    candidates = [(high + low) / 2, low + WEIGHTS.voteGap, high - WEIGHTS.voteGap];
  } else if (above) candidates = [scoreOf(above).points - WEIGHTS.voteMargin];
  else if (below) candidates = [scoreOf(below).points + WEIGHTS.voteMargin];
  else return withNote(self.vote);
  const votes = candidates.map((points) => cleanVote(points - base));
  const vote = votes.find((each) => fits(base + each)) ?? votes[0]!;
  return withNote(vote);
}
