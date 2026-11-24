// Several questions (or implementors' decisions) shown one at a time, like Claude Code's question dialog: a counter, arrows
// to the previous and next one (the left and right keys too, while the panel has focus and no text box does), and a row of
// numbers that shows which are answered and goes straight to one. A single one shows without arrows.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { clampStep, firstOpen, keyStep, step, stepTitle } from "./stepper.ts";

export function Stepper({ noun, answered, children }: { noun: string; answered: readonly boolean[]; children: (index: number) => ComponentChildren }) {
  const count = answered.length;
  const [at, setAt] = useState(() => firstOpen(answered));
  const index = clampStep(at, count);
  const several = count > 1;
  const go = (by: -1 | 1) => setAt(step(index, count, by));
  return (
    <div
      class="stepper"
      tabIndex={several ? -1 : undefined}
      onKeyDown={(event) => {
        if (!several) return;
        const by = keyStep(event.key, event.target as HTMLElement | null, event.altKey || event.ctrlKey || event.metaKey || event.shiftKey);
        if (by === 0) return;
        event.preventDefault();
        go(by);
      }}
    >
      <div class="stepper-head">
        {several && (
          // aria-disabled, not disabled, at the ends: a disabled button would drop the focus and with it the keys.
          <button type="button" class="stepper-arrow" aria-label={`Previous ${noun.toLowerCase()}`} aria-disabled={index === 0} onClick={() => go(-1)}>
            ←
          </button>
        )}
        <h4 class="stepper-title num" aria-live="polite">{stepTitle(noun, index, count)}</h4>
        {several && (
          <button type="button" class="stepper-arrow" aria-label={`Next ${noun.toLowerCase()}`} aria-disabled={index === count - 1} onClick={() => go(1)}>
            →
          </button>
        )}
        {several && (
          <span class="stepper-dots">
            {answered.map((done, each) => (
              <button
                type="button"
                key={each}
                class={`stepper-dot num${done ? " stepper-dot-done" : ""}${each === index ? " stepper-dot-current" : ""}`}
                aria-label={`${noun} ${each + 1}${done ? ", answered" : ""}`}
                aria-current={each === index ? "step" : undefined}
                onClick={() => setAt(each)}
              >
                {each + 1}
              </button>
            ))}
          </span>
        )}
      </div>
      {children(index)}
    </div>
  );
}
