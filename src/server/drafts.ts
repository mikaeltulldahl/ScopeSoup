// The board's Item drafts (decision 95): listed in Your turn, and a person's Approve or Deny (`POST /api/item-draft`). Approve
// makes the real Item on the source Item's host through its write port; Deny only records the decision. Both stay in the store (a
// `draft.updated` event with the decision, which History shows), so the same draft is never filed again.

import type { DraftView } from "../core/views.ts";
import type { ItemDraft, Ref, WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";
import type { WriteOutcome, WritePort } from "../ports/host.ts";
import type { Store } from "../store/store.ts";
import { decideDraft, DRAFT_HOST, draftMarker, draftRef, draftWork, madeFrom, openDrafts } from "../orchestrator/drafts.ts";

/** A host an approved draft's Item is made on: the same hosts a restructuring makes its parts on. */
export interface DraftHost {
  host: string;
  write: WritePort;
  verificationInBody?: boolean;
  issueNumbers?: boolean;
}

/** Why Approve is not offered for a draft from an Item on `host`, or undefined when it is. */
export function readOnlyWhy(host: string, hosts: readonly DraftHost[]): string | undefined {
  return hosts.some((each) => each.host === host && each.write.createWork) ? undefined : `Scope Soup cannot create Items on ${host} from here (it is read-only), so Approve is not offered: file it there by hand, or Deny it.`;
}

/** The drafts waiting for a person, as the board shows them. */
export function draftViews(store: Store, works: readonly WorkItem[], hosts: readonly DraftHost[]): DraftView[] {
  const byKey = new Map(works.map((work) => [refKey(work.ref), work]));
  return openDrafts(store).map((draft) => {
    const key = refKey(draft.from);
    const work = byKey.get(key);
    const readOnly = readOnlyWhy(draft.from.host, hosts);
    return {
      id: draft.ref.id, title: draft.title, description: draft.description, verification: draft.verification, role: draft.role, at: draft.at,
      from: { key, id: draft.from.id, ...(work ? { title: work.title } : {}) },
      ...(readOnly ? { readOnly } : {}),
    };
  });
}

export type DraftDecision =
  | { ok: true; message: string; item?: Ref; outcome?: WriteOutcome }
  | { ok: false; status: number; code: string; message: string };

/** What a person sends: the draft, Approve or Deny, and with Approve their edit of its text (each optional). */
export interface DraftRequest {
  id: string;
  action: "approve" | "deny";
  title?: string;
  description?: string;
  verification?: string;
}

/** Reads `POST /api/item-draft`'s body, or says what is wrong with it. */
export function draftRequest(body: Record<string, unknown>): DraftRequest | string {
  const usage = 'Give { "id": "the draft", "action": "approve" | "deny", "title"?, "description"?, "verification"? }.';
  if (typeof body.id !== "string" || !body.id.trim() || (body.action !== "approve" && body.action !== "deny")) return usage;
  for (const key of ["title", "description", "verification"] as const) if (body[key] !== undefined && typeof body[key] !== "string") return `${key} is text. ${usage}`;
  if (typeof body.title === "string" && !body.title.trim()) return "Give the Item a title.";
  return {
    id: body.id.trim(), action: body.action,
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.description === "string" ? { description: body.description } : {}),
    ...(typeof body.verification === "string" ? { verification: body.verification } : {}),
  };
}

/**
 * A person's decision on a draft. Deny records it. Approve first records that it is approving (`approving`), then makes the Item on
 * the source Item's host (the text made inert, ending in the draft's marker line) and records it with the Item. An Item whose last line
 * is that marker, not taken by another draft's decision, is taken instead of making a second; on a retry after an Approve that did not
 * finish, the store is brought up to date from the host first (`refresh`), so an Item made then is found. Refused for a draft that is
 * gone or decided, and Approve for a host that cannot be written.
 */
export async function decide(store: Store, hosts: readonly DraftHost[], request: DraftRequest, by: string, at: () => string, refresh?: () => Promise<void>): Promise<DraftDecision> {
  const draft = store.get<ItemDraft>(draftRef(request.id));
  if (!draft) return { ok: false, status: 404, code: "NO_DRAFT", message: `There is no draft ${request.id}.` };
  if (draft.decided) return { ok: false, status: 409, code: "DECIDED", message: `${by === draft.decided.by ? "You" : draft.decided.by} ${draft.decided.verdict} this draft already.` };
  if (request.action === "deny") {
    decideDraft(store, draft.ref.id, "denied", by, at());
    return { ok: true, message: `Denied the draft "${draft.title}".` };
  }
  const host = hosts.find((each) => each.host === draft.from.host && each.write.createWork);
  if (!host) return { ok: false, status: 403, code: "READ_ONLY", message: readOnlyWhy(draft.from.host, hosts)! };
  const marker = draftMarker(draft.from, draft.ref.id, host.issueNumbers === true);
  const made = (): Ref | undefined => {
    const taken = new Set(store.list<ItemDraft>("draft", DRAFT_HOST).flatMap((each) => (each.ref.id !== draft.ref.id && each.decided?.item ? [refKey(each.decided.item)] : [])));
    return store.list<WorkItem>("work", host.host).find((work) => madeFrom(work.body, marker) && !taken.has(refKey(work.ref)))?.ref;
  };
  let item = made();
  // An Approve before this one did not finish: the Item may be on the host and not in the store yet.
  if (!item && draft.approving && refresh) {
    await refresh();
    item = made();
  }
  let outcome: WriteOutcome | undefined;
  if (!item) {
    if (!draft.approving) store.put({ ...draft, approving: { by, at: at() } }, by, at());
    const given = { title: request.title ?? draft.title, description: request.description ?? draft.description, verification: request.verification ?? draft.verification };
    outcome = await host.write.createWork!(draftWork(draft, given, { verificationInBody: host.verificationInBody === true, issueNumbers: host.issueNumbers === true, by: { who: by, agent: false } }));
    item = outcome.work;
  }
  decideDraft(store, draft.ref.id, "approved", by, at(), item);
  return { ok: true, message: `Approved: ${item.id} was filed from the draft "${draft.title}".`, item, ...(outcome ? { outcome } : {}) };
}
