// The vote on an Item: one number, default 0, a score offset in points added to the Item's score. A press of Vote up
// or Vote down computes it from the order at that moment (`voteForPlace` in the orchestrator's score.ts); no neighbour is stored.

/** The vote as a finite number rounded to 2 decimals; anything else counts as 0. */
export const cleanVote = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 || 0 : 0);

/** "voted up", "voted down"; empty for 0. The number of presses is not kept. */
export function voteWords(vote: number | undefined): string {
  const n = cleanVote(vote);
  return n === 0 ? "" : `voted ${n > 0 ? "up" : "down"}`;
}
