// A proposed split: triage found an item too large and named its parts. A person accepts, edits or
// rejects it on the item page (`POST /api/proposal`); on accept the parts become children of the item
// and the item an umbrella. What was created is kept in the job, and each child's text ends with a
// marker line naming its part and the parent, so a retry (even on a store rebuilt from nothing) makes
// only the rest.

import type { CreatedPart, ProposedPart, Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { LogLineInput, NewWork } from "../ports/host.ts";
import type { Store } from "../store/store.ts";
import type { Job, Proposal } from "./jobs.ts";
import { loadJobs, saveJobs } from "./jobs.ts";

/** The split this job is parked on, if it parked on one. */
export function splitOf(job: Job | undefined): Proposal | undefined {
  const proposal = job?.parked?.as === "needs-decision" ? job.proposal : undefined;
  return proposal?.parts && proposal.parts.length > 0 ? proposal : undefined;
}

/** The split the item parked on now, as stored (a copy). */
export function currentSplit(store: Store, item: Ref): Proposal | undefined {
  const split = splitOf(loadJobs(store)[refKey(item)]);
  return split ? structuredClone(split) : undefined;
}

/**
 * The last line of a part's text: which part of which item's split it is. On a host whose items are numbered issues
 * (GitHub) the parent is named `#N`, so the host links it.
 */
export function partMarker(parent: Ref, part: number, issueNumbers = false): string {
  return `Part ${part + 1} of the split of ${issueNumbers ? `#${parent.id}` : refKey(parent)}.`;
}

const MARKER = /^Part (\d+) of the split of (\S+)\.$/gm;

/**
 * The items on the host that are parts of this item's split, by their marker line: part number (0-based) to the item.
 * Found whether or not they are linked under the item, so an unlinked one is linked instead of made again. Only items on
 * the parent's own host count (a child is only ever made and linked there), and only one whose title is the part's, so an
 * item that merely quotes the marker line is not taken for the part.
 */
export function markedParts(works: readonly WorkItem[], parent: Ref, parts: readonly ProposedPart[]): Map<number, WorkItem> {
  const key = refKey(parent);
  const found = new Map<number, WorkItem>();
  for (const work of works) {
    if (work.state === "abandoned" || work.ref.host !== parent.host) continue;
    // On GitHub the marker line follows the Verification section, so it is read as part of the verification.
    for (const match of `${work.body ?? ""}\n${work.verification ?? ""}`.matchAll(MARKER)) {
      const part = Number(match[1]) - 1;
      // `#N` on GitHub; the ref key in lines written before, and on the meta branch.
      const named = match[2] === key || (/^\d+$/.test(parent.id) && match[2] === `#${parent.id}`);
      if (named && part >= 0 && work.title.trim() === parts[part]?.title.trim() && !found.has(part)) found.set(part, work);
    }
  }
  return found;
}

/**
 * Children found on the host that the store does not know (it was rebuilt, or a person made one by hand) are recorded,
 * before anything is created. Returns how many were added.
 */
export function adoptFound(store: Store, item: Ref, works: readonly WorkItem[], actor: string, at: string): number {
  return store.tx(() => {
    const jobs = loadJobs(store);
    const key = refKey(item);
    const split = splitOf(jobs[key]);
    if (!split) return 0;
    const known = new Set((split.created ?? []).map((each) => each.part));
    const added: CreatedPart[] = [];
    for (const [part, work] of markedParts(works, item, split.parts!)) {
      if (known.has(part)) continue;
      added.push({ part, ref: work.ref, linked: work.parent !== undefined && refKey(work.parent) === key });
    }
    if (added.length === 0) return 0;
    split.created = [...(split.created ?? []), ...added].sort((a, b) => a.part - b.part);
    saveJobs(store, jobs);
    store.appendEvent({ kind: "orchestrator.split_children_found", subject: key, actor, data: { reason: `Found ${added.length} part(s) of the split already on the host: ${added.map((each) => refKey(each.ref)).join(", ")}.`, found: added.map((each) => ({ part: each.part, ref: refKey(each.ref), linked: each.linked })) } }, at);
    return added.length;
  });
}

/**
 * A person accepts the split. Fixes the parts the children are made from: a person's own version (`parts`, from an edit)
 * while no child exists yet, else the stored one, so a retry finishes the same split. Returns a copy of the split as stored,
 * with the children made so far; undefined when the item is not parked on a split (any more).
 */
export function acceptSplit(store: Store, item: Ref, parts: ProposedPart[] | undefined, actor: string, at: string): Proposal | undefined {
  return store.tx(() => {
    const jobs = loadJobs(store);
    const key = refKey(item);
    const split = splitOf(jobs[key]);
    if (!split) return undefined;
    const created = split.created ?? [];
    if (created.length === 0 && parts && parts.length > 0) split.parts = parts;
    saveJobs(store, jobs);
    const count = split.parts!.length;
    const reason = created.length === 0
      ? `A person accepted the split into ${count} parts.`
      : `A person accepted the split again: ${created.length} of ${count} parts exist, the rest are linked or created now.`;
    store.appendEvent({ kind: "orchestrator.split_accepted", subject: key, actor, data: { reason, parts: count, created: created.map((each) => refKey(each.ref)) } }, at);
    return structuredClone(split);
  });
}

/** One child was made (or linked): recorded at once, so a failure on the next one, or a second press, does not make it twice. */
export function recordSplitChild(store: Store, item: Ref, child: CreatedPart, actor: string, at: string): void {
  store.tx(() => {
    const jobs = loadJobs(store);
    const key = refKey(item);
    const split = splitOf(jobs[key]);
    if (!split) return;
    const before = (split.created ?? []).find((each) => each.part === child.part);
    split.created = [...(split.created ?? []).filter((each) => each.part !== child.part), child].sort((a, b) => a.part - b.part);
    saveJobs(store, jobs);
    const what = before ? (child.linked ? "Linked" : "Recorded") : child.linked ? "Created" : "Created, not linked yet,";
    store.appendEvent({ kind: "orchestrator.split_child_created", subject: key, actor, data: { reason: `${what} part ${child.part + 1} of ${split.parts!.length}: ${refKey(child.ref)}.`, child: refKey(child.ref), index: child.part, linked: child.linked } }, at);
  });
}

/**
 * The split is settled: the proposal is spent and the item parked as "not-ready" with `reason`. With open children that parked Item
 * shows as an umbrella; without them (a read-only host, the parts to be made by hand) it is a person's to act on.
 */
export function finishSplit(store: Store, item: Ref, actor: string, at: string, reason: string): boolean {
  return store.tx(() => {
    const jobs = loadJobs(store);
    const key = refKey(item);
    const job = jobs[key];
    const split = splitOf(job);
    if (!job || !split) return false;
    const created = split.created ?? [];
    delete job.proposal;
    delete job.answered;
    job.parked = { as: "not-ready", reason, at };
    saveJobs(store, jobs);
    store.appendEvent({ kind: "orchestrator.split_done", subject: key, actor, data: { reason, created: created.map((each) => refKey(each.ref)) } }, at);
    return true;
  });
}

/** The answers carried over into a part: a section of its text. */
function carriedSection(parent: Ref, carried: string | undefined): string {
  return carried?.trim() ? `\n\n## Decisions carried over from ${parent.id}\n\n${carried.trim()}` : "";
}

/**
 * The child item for part `part` (0-based). The decisions recorded on the parent are carried into its text.
 * A host without a verification field (GitHub) gets it as a section of the text.
 * The text ends with the part's marker line.
 */
export function childWork(part: ProposedPart, index: number, options: { parent: Ref; carried?: string; verificationInBody?: boolean; issueNumbers?: boolean; by: LogLineInput["by"] }): NewWork {
  const verification = part.verification.trim();
  const inBody = options.verificationInBody && verification ? `\n\n## Verification\n\n${verification}` : "";
  const body = `${part.description.trim()}${carriedSection(options.parent, options.carried)}${inBody}\n\n${partMarker(options.parent, index, options.issueNumbers)}`.trim();
  return {
    title: part.title,
    body,
    parent: options.parent,
    labels: [],
    ...(!options.verificationInBody && verification ? { verification } : {}),
    log: [{ kind: "created", by: options.by, fields: { via: `split of ${options.parent.id}` } }],
  };
}

/** The parts as text, for a person to create by hand (a read-only host). Each keeps its marker line. */
export function splitText(parent: Ref, parts: readonly ProposedPart[], carried?: string): string {
  return parts
    .map((part, index) => `### ${index + 1}. ${part.title}\n\n${part.description.trim() || "(no description)"}${carriedSection(parent, carried)}\n\n## Verification\n\n${part.verification.trim() || "(none given)"}\n\n${partMarker(parent, index)}`)
    .join("\n\n");
}
