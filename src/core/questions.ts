// What a question line in an Item's record says about the park that asked it. Pure.

import type { OpenQuestion } from "../model/types.ts";

/**
 * A question line of a park the job settled already: its set's number (`<n>@<at>`) is below the job's park count, or is that count when
 * the job no longer waits on that park (`waiting` false). The store reads such a line after an answer whose read-back was lost (#268). A
 * line with no set is not one.
 */
export function earlierPark(question: Pick<OpenQuestion, "set">, parks: number | undefined, waiting = true): boolean {
  const number = Number.parseInt(question.set ?? "", 10);
  return Number.isInteger(number) && (number < (parks ?? 0) || (!waiting && number === (parks ?? 0)));
}
