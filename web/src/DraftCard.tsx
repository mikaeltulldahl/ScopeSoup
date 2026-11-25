// An Item draft in Your turn (decision 95): a new Item an agent proposed, waiting for a person's Approve or Deny. Approve makes the
// real Item on the source Item's host (Edit first changes its text); Deny drops it. Its text came from an agent: data.

import { useState } from "preact/hooks";
import type { DraftView } from "./api.ts";
import { postItemDraft, useNow } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { Markdown } from "./Markdown.tsx";
import { ago } from "./format.ts";
import { itemHref } from "./route.ts";

const ROLE_WORDS: Record<DraftView["role"], string> = { triage: "the triage", implementor: "the implementor", reviewer: "the reviewer" };

export function DraftCard({ draft }: { draft: DraftView }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState({ title: draft.title, description: draft.description, verification: draft.verification });
  const act = (action: "approve" | "deny", edited?: typeof text) => {
    setBusy(true);
    setProblem("");
    postItemDraft(draft.id, action, edited ?? {})
      .then(() => setEditing(false))
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  const field = (key: keyof typeof text) => (event: Event) => setText({ ...text, [key]: (event.target as HTMLInputElement).value });
  return (
    <div class="card tone-yours draft-card">
      <div class="card-head">
        <span class="tag tag-draft">draft</span>
        <span class="card-title">{draft.title}</span>
      </div>
      <p class="reason">
        From {ROLE_WORDS[draft.role]}, found while working on <a href={itemHref(draft.from.key)}>{/^\d+$/.test(draft.from.id) ? `#${draft.from.id}` : draft.from.id}</a>
        {draft.from.title ? ` (${draft.from.title})` : ""}
      </p>
      {(draft.description || draft.verification) && (
        <details class="draft-text">
          <summary>Text</summary>
          {draft.description && <Markdown text={draft.description} />}
          {draft.verification && <p><strong>Verification:</strong> {draft.verification}</p>}
        </details>
      )}
      <div class="tags draft-actions">
        {!draft.readOnly && (
          <>
            <button type="button" class="primary" disabled={busy} onClick={() => act("approve")}>Approve</button>
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
          </>
        )}
        <button type="button" disabled={busy} onClick={() => act("deny")}>Deny</button>
        <span class="when num">{ago(draft.at, now)}</span>
      </div>
      {draft.readOnly && <p class="reason draft-readonly">{draft.readOnly}</p>}
      {problem && <p class="error" role="alert">{problem}</p>}
      {editing && (
        <Dialog label="Edit the draft" onClose={() => setEditing(false)} focusSelector="input" keepOnOutsideClick>
          <h3 class="dialog-title">Edit the draft, then approve</h3>
          <form class="item-form" onSubmit={(event) => { event.preventDefault(); act("approve", text); }}>
            <label>
              Title
              <input type="text" value={text.title} onInput={field("title")} required disabled={busy} />
            </label>
            <label>
              Description (markdown)
              <textarea rows={8} value={text.description} onInput={field("description")} disabled={busy} />
            </label>
            <label>
              Verification: how we know it is done
              <textarea rows={2} value={text.verification} onInput={field("verification")} disabled={busy} />
            </label>
            <div class="form-actions">
              <button type="submit" class="primary" disabled={busy || text.title.trim() === ""}>{busy ? "Approving…" : "Approve"}</button>
              <button type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            </div>
            {problem && <p class="error">{problem}</p>}
          </form>
        </Dialog>
      )}
    </div>
  );
}
