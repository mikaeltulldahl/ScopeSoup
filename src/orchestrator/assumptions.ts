// The decisions an implementor took itself, as cheap to change later, and a person's Accept and Overturn. Pure.
// An overturned decision becomes a new Item that carries the answer as the decision: the change is reworked, or
// reverted where it has merged already.

import type { Assumption, Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";

/** The new Item an overturn makes: its title, description and verification. Agent and person text inside it is data. */
export interface OverturnItem {
  title: string;
  body: string;
  verification: string;
  /** The original Item's change has merged: the new Item reverts or changes it on main. Otherwise it reworks it. */
  merged: boolean;
}

const clip = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/** How an Item is named in another Item's text: `#12` for a numbered issue, else its id. */
export const itemName = (item: WorkItem): string => (/^\d+$/.test(item.ref.id) ? `#${item.ref.id}` : item.ref.id);

/**
 * The hidden last line of an overturn's Item: the Item and the decision it was filed for. A second Overturn of the same decision
 * (its verdict could not be written the first time) finds the Item by it and files no second one (`overturnedBy`).
 */
export function overturnMark(item: WorkItem, assumption: Assumption): string {
  return `<!-- scopesoup:overturns ${JSON.stringify({ item: refKey(item.ref), decision: assumption.id })} -->`;
}

/** The Item already filed for overturning `assumption` of `item`, among `items` (the host's, as the store has them); null when none. */
export function overturnedBy(items: readonly WorkItem[], item: WorkItem, assumption: Assumption): WorkItem | null {
  const mark = overturnMark(item, assumption);
  return items.find((each) => each.ref.host === item.ref.host && refKey(each.ref) !== refKey(item.ref) && (each.body ?? "").includes(mark)) ?? null;
}

/** The Item an overturn makes, linked back to `item` by name. `answer` is a person's decision. */
export function overturnItem(item: WorkItem, assumption: Assumption, answer: string): OverturnItem {
  const merged = item.state === "done";
  const name = itemName(item);
  const others = assumption.others.length > 0 ? ` The other options were: ${assumption.others.join("; ")}.` : "";
  const body = [
    `A person overturned a decision the implementor of ${name} ("${item.title}") took itself.`,
    `**Decided by a person:** ${answer.trim()}`,
    `The question was: ${assumption.question} The implementor chose: ${assumption.chosen}.${others}${assumption.why ? ` Its reason: ${assumption.why}` : ""}`,
    merged
      ? `${name}'s change has merged. Change the code to follow a person's decision, or revert the part of ${name}'s change that made the other choice.`
      : `${name}'s change has not merged yet; this Item waits for it. Then rework that part of it to follow a person's decision.`,
    overturnMark(item, assumption),
  ].join("\n\n");
  return {
    title: clip(`Overturned in ${name}: ${assumption.question}`, 120),
    body,
    verification: `The code follows a person's decision: ${clip(answer.trim(), 500)}`,
    merged,
  };
}

/** The decision's place in its record: meta branch `<at>#<n>`, GitHub `<comment>-<n>`. */
export function splitAssumptionId(id: string): { record: string; n: number } | null {
  const match = /^(.+)[#-](\d+)$/.exec(id);
  return match ? { record: match[1]!, n: Number(match[2]) } : null;
}

/** A person's pick on one decision, sent with the others of the Item: Accept, or Overturn with a person's decision. */
export interface AssumptionPick {
  id: string;
  action: "accept" | "overturn";
  /** With "overturn": a person's decision. */
  answer?: string;
}

/** What a pick came to on the host: the verdict, the Item an overturn filed (or reused), or `work` when it went into the running work. */
export interface AssumptionOutcome {
  id: string;
  verdict: "accepted" | "overturned";
  item?: Ref;
  /** The Item was filed for this decision before (a Send whose verdicts could not be written): reused, no second one filed. */
  reused?: true;
  work?: true;
}
