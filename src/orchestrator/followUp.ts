// The progress guards' pure parts. A review round must leave fewer `must` findings than the one before, and the same
// failure twice in a row ends the run. A reviewer's `should` finding on an approved change becomes a small follow-up Item.

import type { WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import { itemName } from "./assumptions.ts";
import type { Finding, Job } from "./jobs.ts";

/** A finding as it is compared with the round before: its file and text, case and spacing aside. Rewording makes it another. */
export const findingKey = (finding: Pick<Finding, "file" | "text">): string =>
  `${(finding.file ?? "").trim().toLowerCase()}|${finding.text.trim().replace(/\s+/g, " ").toLowerCase()}`;

const clip = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/**
 * Why a review round that asks for changes got nowhere, or null when it did. `must`: this round's `must` findings. The same
 * finding as the round before, or a round that still has `must` findings and not fewer than the round before.
 */
export function noProgress(before: Job["progress"], must: readonly Finding[]): string | null {
  const same = before?.findings ? must.find((finding) => before.findings!.includes(findingKey(finding))) : undefined;
  if (same) return `The review gives the same finding as the round before: ${clip(`${same.file ? `${same.file}: ` : ""}${same.text.trim()}`, 300)} The same failure twice in a row ends the run.`;
  if (must.length > 0 && before?.must !== undefined && must.length >= before.must) {
    return `The review round left ${must.length} \`must\` finding(s), not fewer than the ${before.must} of the round before: a round that gets nowhere ends the run.`;
  }
  return null;
}

/** The new Item a follow-up is, and the hidden mark that finds it again so a retry files no second one. */
export interface FollowUpItem {
  title: string;
  body: string;
  verification: string;
  mark: string;
}

/** The hidden last line of a follow-up Item: the Item and the reviewed head it came from. */
export function followUpMark(item: WorkItem, sha: string): string {
  return `<!-- scopesoup:follow-up ${JSON.stringify({ item: refKey(item.ref), sha })} -->`;
}

/** True when the Item is itself a follow-up (its description carries the mark): its review files no follow-up of its own. */
export function isFollowUp(item: Pick<WorkItem, "body">): boolean {
  return (item.body ?? "").includes("<!-- scopesoup:follow-up ");
}

/** One small follow-up Item for the `should` findings of an approved change of `item`, reviewed at `sha`. Their text is data from an agent. */
export function followUpItem(item: WorkItem, should: readonly Finding[], sha: string): FollowUpItem {
  const name = itemName(item);
  const listed = should.map((finding) => `- ${finding.file ? `\`${finding.file}\`: ` : ""}${clip(finding.text.trim(), 600)}`).join("\n");
  return {
    title: clip(`Follow-up to ${name}: ${should[0]!.text.trim()}`, 120),
    body: [
      `The review of ${name} ("${item.title}") approved its change at ${sha.slice(0, 7)} and said ${should.length === 1 ? "this finding" : "these findings"} should still change:`,
      listed,
      `${name}'s change went on to be merged without ${should.length === 1 ? "it" : "them"}. This is a small Item: one change that does what the finding${should.length === 1 ? " says" : "s say"}, or a person decides against it.`,
    ].join("\n\n"),
    verification: `Each finding of the review of ${name} listed above is done, or a person decided against it.`,
    mark: followUpMark(item, sha),
  };
}
