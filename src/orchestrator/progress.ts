// The progress guards' pure parts. A review round must leave fewer `must` findings than the one before, and the same
// failure twice in a row ends the run. A reviewer's `should` findings on an approved change go back once or become a draft.

import type { WorkItem } from "../model/types.ts";
import { itemName } from "./assumptions.ts";
import type { ProposedDraft } from "./drafts.ts";
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

/** The one draft the `should` findings of an approved change of `item` become (`review.shouldFindings: "draft"`). Their text is data from an agent. */
export function shouldDraft(item: Pick<WorkItem, "ref" | "title">, should: readonly Finding[]): ProposedDraft {
  const name = itemName(item as WorkItem);
  const listed = should.map((finding) => `- ${finding.file ? `\`${finding.file}\`: ` : ""}${clip(finding.text.trim(), 600)}`).join("\n");
  return {
    title: clip(`After ${name}: ${should[0]!.text.trim().replace(/\s+/g, " ")}`, 120),
    description: [
      `The review of ${name} ("${item.title}") approved its change and said ${should.length === 1 ? "this finding" : "these findings"} should still change:`,
      listed,
      `${name}'s change went on to the merge without ${should.length === 1 ? "it" : "them"}. One small change that does what the finding${should.length === 1 ? " says" : "s say"}.`,
    ].join("\n\n"),
    verification: `Each finding of the review of ${name} listed above is done.`,
  };
}
