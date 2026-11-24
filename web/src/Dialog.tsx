// A modal dialog over the page: the Item page and the New item form. Esc and the close button close it; a click on the backdrop
// closes it unless `keepOnOutsideClick` says there is something to lose. Focus goes in on open and back to the opener on close.

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

export function Dialog({ label, onClose, focusSelector, keepOnOutsideClick = false, children }: { label: string; onClose: () => void; focusSelector?: string; keepOnOutsideClick?: boolean; children: ComponentChildren }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = focusSelector ? panel.current?.querySelector<HTMLElement>(focusSelector) : null;
    (first ?? panel.current)?.focus({ preventScroll: true });
    document.body.classList.add("dialog-open");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("dialog-open");
      opener?.focus({ preventScroll: true });
    };
  }, [focusSelector]);
  return (
    <div
      class="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !keepOnOutsideClick) onClose();
      }}
    >
      <div class="dialog" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={panel}>
        <button type="button" class="dialog-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        {children}
      </div>
    </div>
  );
}
