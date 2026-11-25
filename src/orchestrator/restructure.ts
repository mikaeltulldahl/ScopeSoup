// A proposed restructuring (decision 93): triage names parts, where each goes (the Item itself, a new child, related or unlinked
// Item, or into an existing Item) and what becomes of the Item (it keeps a part, becomes an umbrella, or is replaced). A person
// accepts, edits or rejects it on the item page (`POST /api/proposal`); nothing is made before. What was made is kept in the job,
// and each part's text ends with a marker line naming its part and the Item, so a retry (even on a store rebuilt from nothing)
// makes only the rest.

import type { CreatedPart, OriginalFate, ProposedPart, Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { LogLineInput, NewWork, WorkPatch } from "../ports/host.ts";
import type { Store } from "../store/store.ts";
import { inertText } from "./hostText.ts";
import type { Job, Proposal } from "./jobs.ts";
import { loadJobs, releaseIn, saveJobs } from "./jobs.ts";

/** The restructuring this job is parked on, if it parked on one. */
export function restructuringOf(job: Job | undefined): Proposal | undefined {
  const proposal = job?.parked?.as === "needs-decision" ? job.proposal : undefined;
  return proposal?.parts && proposal.parts.length > 0 ? proposal : undefined;
}

/** The restructuring the item parked on now, as stored (a copy). */
export function currentRestructuring(store: Store, item: Ref): Proposal | undefined {
  const proposal = restructuringOf(loadJobs(store)[refKey(item)]);
  return proposal ? structuredClone(proposal) : undefined;
}

/** How a part's marker line names the Item: `#N` on a host whose items are numbered issues (GitHub), so the host links it; else its ref key. */
function itemName(item: Ref, issueNumbers: boolean): string {
  return issueNumbers ? `#${item.id}` : refKey(item);
}

/**
 * The last line of a part's text: which part of which Item's restructuring it is. An unlinked part names the Item by its ref key
 * even on GitHub, so the host makes no link.
 */
export function partMarker(parent: Ref, part: number, issueNumbers = false): string {
  return `Part ${part + 1} of the restructuring of ${itemName(parent, issueNumbers)}.`;
}

const MARKER = /^Part (\d+) of the restructuring of (\S+)\.$/gm;

/** Whether a part found on the host is where it should be: only a child has a link of its own to make (a sub-issue, a sub-task). */
export function partLinked(part: ProposedPart, work: WorkItem, parent: Ref): boolean {
  return part.goes !== "child" || (work.parent !== undefined && refKey(work.parent) === refKey(parent));
}

/**
 * The items on the host that carry parts of this Item's restructuring, by their marker line: part number (0-based) to the item.
 * Found whether or not a child is linked under the Item, so an unlinked one is linked instead of made again. Only items on the
 * Item's own host count; a new part only when its title is the part's, and a part into an existing Item only in that Item, so an
 * item that merely quotes the marker line is not taken for the part.
 */
export function markedParts(works: readonly WorkItem[], parent: Ref, parts: readonly ProposedPart[]): Map<number, WorkItem> {
  const key = refKey(parent);
  const found = new Map<number, WorkItem>();
  for (const work of works) {
    if (work.state === "abandoned" || work.ref.host !== parent.host || refKey(work.ref) === key) continue;
    // On GitHub the marker line may follow the Verification section, so it is read as part of the verification.
    for (const match of `${work.body ?? ""}\n${work.verification ?? ""}`.matchAll(MARKER)) {
      const index = Number(match[1]) - 1;
      const part = parts[index];
      // `#N` on GitHub; the ref key on the other hosts and for an unlinked part.
      const named = match[2] === key || (/^\d+$/.test(parent.id) && match[2] === `#${parent.id}`);
      if (!named || !part || part.goes === "original" || found.has(index)) continue;
      const same = part.goes === "into" ? work.ref.id === part.into : work.title.trim() === inertText(part.title.trim()) || work.title.trim() === part.title.trim();
      if (same) found.set(index, work);
    }
  }
  return found;
}

/**
 * Parts found on the host that the store does not know (it was rebuilt, or a person made one by hand) are recorded, before
 * anything is made. Returns how many were added.
 */
export function adoptFound(store: Store, item: Ref, works: readonly WorkItem[], actor: string, at: string): number {
  return store.tx(() => {
    const jobs = loadJobs(store);
    const key = refKey(item);
    const proposal = restructuringOf(jobs[key]);
    if (!proposal) return 0;
    const known = new Set((proposal.created ?? []).map((each) => each.part));
    const added: CreatedPart[] = [];
    for (const [part, work] of markedParts(works, item, proposal.parts)) {
      if (known.has(part)) continue;
      added.push({ part, ref: work.ref, linked: partLinked(proposal.parts[part]!, work, item) });
    }
    if (added.length === 0) return 0;
    proposal.created = [...(proposal.created ?? []), ...added].sort((a, b) => a.part - b.part);
    saveJobs(store, jobs);
    store.appendEvent({ kind: "orchestrator.restructure_parts_found", subject: key, actor, data: { reason: `Found ${added.length} part(s) of the restructuring already on the host: ${added.map((each) => refKey(each.ref)).join(", ")}.`, found: added.map((each) => ({ part: each.part, ref: refKey(each.ref), linked: each.linked })) } }, at);
    return added.length;
  });
}

/**
 * A person accepts the restructuring. Fixes what is made: a person's own version (`edited`, from an edit) while no part exists yet,
 * else the stored one, so a retry finishes the same restructuring. Returns a copy as stored, with the parts made so far; undefined
 * when the item is not parked on a restructuring (any more).
 */
export function acceptRestructuring(store: Store, item: Ref, edited: { original: OriginalFate; parts: ProposedPart[] } | undefined, actor: string, at: string): Proposal | undefined {
  return store.tx(() => {
    const jobs = loadJobs(store);
    const key = refKey(item);
    const proposal = restructuringOf(jobs[key]);
    if (!proposal) return undefined;
    const created = proposal.created ?? [];
    if (created.length === 0 && edited) Object.assign(proposal, edited);
    saveJobs(store, jobs);
    const count = proposal.parts.length;
    const reason = created.length === 0
      ? `A person accepted the restructuring: ${count} parts.`
      : `A person accepted the restructuring again: ${created.length} of ${count} parts exist, the rest are linked or made now.`;
    store.appendEvent({ kind: "orchestrator.restructure_accepted", subject: key, actor, data: { reason, parts: count, original: proposal.original, created: created.map((each) => refKey(each.ref)) } }, at);
    return structuredClone(proposal);
  });
}

/** One part was made (or linked, or written into an existing Item): recorded at once, so a failure on the next one, or a second press, does not make it twice. */
export function recordPart(store: Store, item: Ref, made: CreatedPart, actor: string, at: string): void {
  store.tx(() => {
    const jobs = loadJobs(store);
    const key = refKey(item);
    const proposal = restructuringOf(jobs[key]);
    if (!proposal) return;
    const before = (proposal.created ?? []).find((each) => each.part === made.part);
    proposal.created = [...(proposal.created ?? []).filter((each) => each.part !== made.part), made].sort((a, b) => a.part - b.part);
    saveJobs(store, jobs);
    const what = before ? (made.linked ? "Linked" : "Recorded") : made.linked ? "Made" : "Made, not linked yet,";
    store.appendEvent({ kind: "orchestrator.restructure_part_made", subject: key, actor, data: { reason: `${what} part ${made.part + 1} of ${proposal.parts.length}: ${refKey(made.ref)}.`, part: refKey(made.ref), index: made.part, linked: made.linked } }, at);
  });
}

/**
 * The restructuring is settled: the proposal is spent and the item parked as "not-ready" with `reason` (with open children an
 * umbrella shows as one; on a read-only host it is a person's to act on). With `release` (the Item kept a part and its text was
 * narrowed) it is released instead, so triage looks at the narrowed text again.
 */
export function finishRestructuring(store: Store, item: Ref, actor: string, at: string, reason: string, release = false): boolean {
  return store.tx(() => {
    const jobs = loadJobs(store);
    const key = refKey(item);
    const job = jobs[key];
    const proposal = restructuringOf(job);
    if (!job || !proposal) return false;
    const created = proposal.created ?? [];
    const original = proposal.original;
    delete job.proposal;
    delete job.answered;
    job.parked = { as: "not-ready", reason, at };
    if (release) releaseIn(jobs, key, actor);
    saveJobs(store, jobs);
    store.appendEvent({ kind: "orchestrator.restructure_done", subject: key, actor, data: { reason, original, created: created.map((each) => refKey(each.ref)) } }, at);
    return true;
  });
}

/** The answers carried over into a new part: a section of its text. */
function carriedSection(parent: Ref, carried: string | undefined): string {
  return carried?.trim() ? `\n\n## Decisions carried over from ${parent.id}\n\n${inertText(carried.trim())}` : "";
}

/**
 * The new Item for part `index` (0-based): a child under the Item, a related Item (linked where the host keeps links apart from
 * the text: Jira's "relates to"; on GitHub the marker line's `#N` links it), or an unlinked one. The decisions recorded on the Item
 * are carried into its text. A host without a verification field (GitHub) gets it as a section of the text. The text, made inert,
 * ends with the part's marker line.
 */
export function partWork(part: ProposedPart, index: number, options: { parent: Ref; carried?: string; verificationInBody?: boolean; issueNumbers?: boolean; by: LogLineInput["by"] }): NewWork {
  const verification = inertText(part.verification.trim());
  const inBody = options.verificationInBody && verification ? `\n\n## Verification\n\n${verification}` : "";
  const marker = partMarker(options.parent, index, options.issueNumbers === true && part.goes !== "unlinked");
  const body = `${inertText(part.description.trim())}${carriedSection(options.parent, options.carried)}${inBody}\n\n${marker}`.trim();
  return {
    title: inertText(part.title),
    body,
    ...(part.goes === "child" ? { parent: options.parent } : {}),
    ...(part.goes === "related" ? { relatedTo: options.parent } : {}),
    labels: [],
    ...(!options.verificationInBody && verification ? { verification } : {}),
    log: [{ kind: "created", by: options.by, fields: { via: `restructuring of ${options.parent.id}` } }],
  };
}

/** An existing Item's description with part `index` added at its end (made inert), ending with the part's marker line. */
export function intoBody(body: string, part: ProposedPart, index: number, options: { parent: Ref; issueNumbers?: boolean }): string {
  const verification = part.verification.trim() ? `\n\nVerification: ${inertText(part.verification.trim())}` : "";
  const added = `## Added from ${itemName(options.parent, options.issueNumbers === true)}: ${inertText(part.title.trim())}\n\n${inertText(part.description.trim()) || "(no description)"}${verification}\n\n${partMarker(options.parent, index, options.issueNumbers)}`;
  return `${body.trim()}\n\n${added}`.trim();
}

/** The Item narrowed to the part it keeps: its title, description and verification, made inert. */
export function keptPatch(part: ProposedPart): WorkPatch {
  return { title: inertText(part.title.trim()), body: inertText(part.description.trim()), verification: inertText(part.verification.trim()) };
}

/** Where a part goes, in words. */
export function goesWords(part: ProposedPart, parent: Ref): string {
  switch (part.goes) {
    case "original": return `stays in ${parent.id}`;
    case "child": return `a new sub-item of ${parent.id}`;
    case "related": return `a new Item related to ${parent.id}`;
    case "unlinked": return "a new Item on its own";
    case "into": return `added to ${part.into}`;
  }
}

/** What becomes of the Item, in words. */
export function fateWords(original: OriginalFate, parent: Ref): string {
  return original === "keeps" ? `${parent.id} keeps the part that stays in it` : original === "umbrella" ? `${parent.id} becomes an umbrella over its sub-items` : `${parent.id} is closed as replaced by the parts`;
}

/** The restructuring as text, for a person to carry out by hand (a read-only host). Each new part keeps its marker line. */
export function restructuringText(parent: Ref, original: OriginalFate, parts: readonly ProposedPart[], carried?: string): string {
  const listed = parts.map((part, index) => {
    const marker = part.goes === "original" ? "" : `\n\n${partMarker(parent, index)}`;
    return `### ${index + 1}. ${part.title} (${goesWords(part, parent)})\n\n${part.description.trim() || "(no description)"}${part.goes === "original" || part.goes === "into" ? "" : carriedSection(parent, carried)}\n\n## Verification\n\n${part.verification.trim() || "(none given)"}${marker}`;
  });
  return [...listed, `Then: ${fateWords(original, parent)}.`].join("\n\n");
}
