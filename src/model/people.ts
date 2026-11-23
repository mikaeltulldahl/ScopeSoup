// What people and Scope Soup agree on when a person takes an item and hands it back (docs/PEOPLE.md).

/** The label a hand-back puts on the pull request (GitHub): "Scope Soup, review this and take it on". */
export const HANDBACK_LABEL = "scopesoup:review";

/** The start of the branch name of every item branch Scope Soup works on, reviews and merges. */
export const ITEM_BRANCH_PREFIX = "scopesoup/";

/** A person's `claimed` line needs an `until`; a person's hold has no stall timer, so it is far away. */
export const PERSON_HOLD_YEARS = 10;

/** Where a hold came from, as written in the `from` field of a `claimed` line. */
export const FROM_CLAUDE_CODE = "claude-code";

/**
 * A hold stands at `at` (ms since the epoch). A person's always does: people have no stall timer, so a person's hold is
 * never ended by its `until` or by being quiet; only the person lets go (a `released` line, a hand-back, the assignee removed).
 * An agent's stands while its `until` is ahead, or always when it has none.
 */
export function holdStands(holder: { actor: { bot?: boolean }; until?: string } | undefined, at: number): boolean {
  if (!holder) return false;
  if (!holder.actor.bot || holder.until === undefined) return true;
  const until = Date.parse(holder.until);
  return Number.isNaN(until) || until > at;
}
