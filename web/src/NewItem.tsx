// The "New item" button in the top bar and the dialog it opens; on every page, as the board's person.
import { useState } from "preact/hooks";
import { itemHref } from "./route.ts";
import { postItem } from "./api.ts";
import type { ItemFields } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { ItemForm } from "./ItemForm.tsx";
import { useTheme } from "./useTheme.ts";

export function NewItem() {
  const theme = useTheme();
  const [writing, setWriting] = useState(false);
  // The draft in the dialog has text in it: a click outside then keeps the dialog.
  const [dirty, setDirty] = useState(false);
  const close = () => {
    setWriting(false);
    setDirty(false);
  };
  // In Backlog, or straight to To do when the person means it now (decision 120).
  const create = (fields: ItemFields, todo: boolean) =>
    postItem(fields, todo).then(({ ref }) => {
      close();
      location.hash = itemHref(ref);
    });
  return (
    <>
      <button type="button" class="primary new-item" onClick={() => setWriting(true)}>
        New {theme.words.itemOne}
      </button>
      {writing && (
        <Dialog label={`New ${theme.words.itemOne}`} onClose={close} focusSelector="input" keepOnOutsideClick={dirty}>
          <h3 class="dialog-title">New {theme.words.itemOne}</h3>
          <ItemForm
            start={{ title: "", body: "", verification: "", labels: "", blockedBy: "", priority: "" }}
            submitWords="Create"
            onDirty={setDirty}
            onSubmit={(fields) => create(fields, false)}
            also={{ words: "Create in To do", title: "Agents may start it at once; Create puts it in Backlog, where nothing starts", onSubmit: (fields) => create(fields, true) }}
            onCancel={close}
          />
        </Dialog>
      )}
    </>
  );
}
