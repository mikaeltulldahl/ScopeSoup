// Item drafts (decision 95): new Items agents propose wait in this machine's store for a person's yes. Triage, the implementor
// and the reviewer may list `drafts` in their answer; with `review.shouldFindings: "draft"` an approval's `should` findings are one
// more. Each is linked to the Item it was found on, its text made inert, and filed once per source Item and title. The board shows
// them in Your turn: Approve makes the real Item on the source Item's host, Deny drops it. Nothing reaches a host before Approve.

import { createHash } from "node:crypto";
import type { ItemDraft, Ref } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { LogLineInput, NewWork } from "../ports/host.ts";
import type { Store } from "../store/store.ts";
import { inertText, withoutMarks } from "./hostText.ts";

/** Where drafts are kept in the store: never a host's. */
export const DRAFT_HOST = "scopesoup";

/** A draft as an agent gave it. Text from an agent: data. */
export interface ProposedDraft {
  title: string;
  description: string;
  verification: string;
}

/** Most drafts taken from one answer; the rest are dropped. */
export const MAX_DRAFTS = 10;

const text = (value: unknown, chars: number): string => (typeof value === "string" ? value.trim().slice(0, chars) : "");

/** The `drafts` of an answer: each needs a title. At most `MAX_DRAFTS`, each text clipped. Markup is the caller's to check. */
export function asDrafts(value: unknown, hasMarkup: (value: unknown) => boolean): ProposedDraft[] {
  if (!Array.isArray(value)) return [];
  const out: ProposedDraft[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null || hasMarkup(entry)) continue;
    const given = entry as Record<string, unknown>;
    const title = text(given.title, 200).replace(/\s+/g, " ");
    if (!title) continue;
    out.push({ title, description: text(given.description, 20_000), verification: text(given.verification, 5_000) });
  }
  return out.slice(0, MAX_DRAFTS);
}

/** A title as drafts are compared: case and spacing aside. */
export const normalTitle = (title: string): string => title.trim().replace(/\s+/g, " ").toLowerCase();

/** A draft's id: its source Item and normalized title, so the same draft is one object however often it is proposed. */
export function draftId(from: Ref, title: string): string {
  return createHash("sha256").update(`${refKey(from)}\n${normalTitle(title)}`).digest("hex").slice(0, 12);
}

export const draftRef = (id: string): Ref => ({ host: DRAFT_HOST, kind: "draft", id });

/** Lines shaped like a restructuring part's marker (`inertPart` in restructure.ts) or a draft's. */
const MARKER_LINES = /^(\s*)(P)(art \d+ of restructuring)|^(\s*)(F)(ound while working on)/gim;

/** Agent text made inert: no mention or closing keyword, no hidden mark, no line that could pose as a part's or a draft's marker. */
export function inertDraft(value: string): string {
  return withoutMarks(inertText(value)).replace(MARKER_LINES, (_all: string, a?: string, b?: string, c?: string, d?: string, e?: string, f?: string) =>
    b ? `${a}${b}​${c}` : `${d}${e}​${f}`);
}

/** The last line of an approved draft's Item: the Item it came from (`#N` on GitHub, which links it) and the draft's id. */
export function draftMarker(from: Ref, id: string, issueNumbers: boolean): string {
  return `Found while working on ${issueNumbers ? `#${from.id}` : from.id} (draft ${id}).`;
}

/** True when an Item's text ends with this draft's marker: the Item its approval made, found again after a failed record. */
export const madeFrom = (body: string | undefined, id: string): boolean => (body ?? "").includes(`(draft ${id}).`);

export interface FiledDrafts {
  filed: ItemDraft[];
  /** Titles of drafts already filed for this source Item (open, approved or denied). */
  known: string[];
}

/**
 * Files an agent's drafts for the Item `from`, each made inert, in one transaction (a `draft.created` event each). One with the same
 * source Item and normalized title as a draft filed before (decided or not) is left out.
 */
export function fileDrafts(store: Store, from: Ref, role: ItemDraft["role"], drafts: readonly ProposedDraft[], actor: string, at: string): FiledDrafts {
  const result: FiledDrafts = { filed: [], known: [] };
  store.tx(() => {
    const seen = new Set<string>();
    for (const draft of drafts) {
      const id = draftId(from, draft.title);
      if (seen.has(id) || store.get<ItemDraft>(draftRef(id))) {
        result.known.push(draft.title);
        continue;
      }
      seen.add(id);
      const made: ItemDraft = {
        ref: draftRef(id), from: { host: from.host, kind: from.kind, id: from.id }, role,
        title: inertDraft(draft.title), description: inertDraft(draft.description), verification: inertDraft(draft.verification), at,
      };
      store.put(made, actor, at);
      result.filed.push(made);
    }
  });
  return result;
}

/** The drafts waiting for a person, oldest first. */
export function openDrafts(store: Store): ItemDraft[] {
  return store.list<ItemDraft>("draft", DRAFT_HOST).filter((draft) => !draft.decided).sort((a, b) => a.at.localeCompare(b.at) || a.ref.id.localeCompare(b.ref.id));
}

/** A person's text for the draft at Approve (their edit), else the draft's own. */
export interface DraftText {
  title: string;
  description: string;
  verification: string;
}

/**
 * The new Item an approved draft makes on the source Item's host. A host without a verification field (GitHub) gets it as a section
 * of the text. The text, made inert again (a person's edit keeps the same rules), ends with the draft's marker line.
 */
export function draftWork(draft: ItemDraft, given: DraftText, options: { verificationInBody?: boolean; issueNumbers?: boolean; by: LogLineInput["by"] }): NewWork {
  const verification = inertDraft(given.verification);
  const inBody = options.verificationInBody && verification ? `\n\n## Verification\n\n${verification}` : "";
  const body = `${inertDraft(given.description)}${inBody}\n\n${draftMarker(draft.from, draft.ref.id, options.issueNumbers === true)}`.trim();
  return {
    title: inertDraft(given.title).replace(/\s+/g, " ").slice(0, 200),
    body,
    labels: [],
    ...(!options.verificationInBody && verification ? { verification } : {}),
    log: [{ kind: "created", by: options.by, fields: { via: `draft from ${draft.role === "triage" ? "the triage" : `the ${draft.role}`} of ${draft.from.id}` } }],
  };
}

/** Records a person's decision on an open draft (a `draft.updated` event carrying it). False when it is gone or decided already. */
export function decideDraft(store: Store, id: string, verdict: "approved" | "denied", by: string, at: string, item?: Ref): boolean {
  return store.tx(() => {
    const draft = store.get<ItemDraft>(draftRef(id));
    if (!draft || draft.decided) return false;
    store.put({ ...draft, decided: { verdict, by, at, ...(item ? { item } : {}) } }, by, at);
    return true;
  });
}
