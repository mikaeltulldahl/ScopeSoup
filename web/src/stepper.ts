// Which one of several questions (or implementors' decisions) is shown, when an Item page shows them one at a time like
// Claude Code's question dialog. Pure: the panel keeps the index, these say where the arrows and keys take it.

/** `index` kept inside 0..count-1 (0 when there is nothing), so a list that got shorter still shows one. */
export const clampStep = (index: number, count: number): number => (count <= 0 ? 0 : Math.min(Math.max(0, Math.trunc(index)), count - 1));

/** One step back (-1) or on (1); it stops at the first and the last, it does not wrap round. */
export const step = (index: number, count: number, by: -1 | 1): number => clampStep(clampStep(index, count) + by, count);

/** Where the panel opens: the first one not answered yet, or the first when all are. */
export const firstOpen = (answered: readonly boolean[]): number => Math.max(0, answered.indexOf(false));

/**
 * The step a key press makes: ArrowLeft back, ArrowRight on, anything else none (0). Not while a person types in a text
 * box (the arrows move the caret there) or with a modifier held (the browser's own shortcuts).
 */
export function keyStep(key: string, target: { tagName?: string; isContentEditable?: boolean } | null, modified: boolean): -1 | 0 | 1 {
  if (modified) return 0;
  const tag = (target?.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || target?.isContentEditable) return 0;
  return key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
}

/** The counter's words: "Question 2 of 4", or only "Question" when there is one. */
export const stepTitle = (noun: string, index: number, count: number): string => (count > 1 ? `${noun} ${clampStep(index, count) + 1} of ${count}` : noun);
