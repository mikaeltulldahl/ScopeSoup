// The form an item is written in: a new item from the overview, or an edit from its page. The state is set on the page's State menu, not here.

import { useEffect, useState } from "preact/hooks";
import type { ItemFields } from "./api.ts";

/** `also`: a second way to submit, beside the first (a new Item: "Create in To do" beside "Create", which files it in Backlog). */
export function ItemForm({ start, submitWords, onSubmit, onCancel, onDirty, also }: { start: ItemFields; submitWords: string; onSubmit: (fields: ItemFields) => Promise<void>; onCancel: () => void; onDirty?: (dirty: boolean) => void; also?: { words: string; title?: string; onSubmit: (fields: ItemFields) => Promise<void> } }) {
  const [fields, setFields] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether anything differs from the start: a dialog around the form keeps the draft on a click outside.
  useEffect(() => onDirty?.((Object.keys(start) as (keyof ItemFields)[]).some((key) => fields[key] !== start[key])), [fields]);
  const set = (key: keyof ItemFields) => (event: Event) => setFields({ ...fields, [key]: (event.target as HTMLInputElement).value });
  const run = (send: (fields: ItemFields) => Promise<void>) => (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    send(fields).then(
      () => setBusy(false),
      (problem: unknown) => {
        setError(problem instanceof Error ? problem.message : String(problem));
        setBusy(false);
      },
    );
  };
  const submit = run(onSubmit);
  return (
    <form class="item-form" onSubmit={submit}>
      <label>
        Title
        <input type="text" value={fields.title} onInput={set("title")} required disabled={busy} />
      </label>
      <label>
        Description (markdown)
        <textarea rows={8} value={fields.body} onInput={set("body")} disabled={busy} />
      </label>
      <label>
        Verification: how we know it is done
        <textarea rows={2} value={fields.verification} onInput={set("verification")} disabled={busy} />
      </label>
      <label>
        Labels, separated by commas
        <input type="text" value={fields.labels} onInput={set("labels")} disabled={busy} />
      </label>
      <label>
        Blocked by: item ids, separated by commas
        <input type="text" value={fields.blockedBy} onInput={set("blockedBy")} placeholder="A-1, A-2" disabled={busy} />
      </label>
      <label>
        Priority
        <select value={fields.priority} onChange={set("priority")} disabled={busy}>
          <option value="">major (default)</option>
          {["blocker", "critical", "minor"].map((priority) => (
            <option key={priority} value={priority}>{priority}</option>
          ))}
          {fields.priority === "major" && <option value="major">major</option>}
        </select>
      </label>
      <div class="form-actions">
        <button type="submit" class="primary" disabled={busy || fields.title.trim() === ""}>
          {busy ? "Saving…" : submitWords}
        </button>
        {also && (
          <button type="button" title={also.title} onClick={run(also.onSubmit)} disabled={busy || fields.title.trim() === ""}>
            {also.words}
          </button>
        )}
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && <p class="error">{error}</p>}
    </form>
  );
}
