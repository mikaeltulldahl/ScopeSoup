import { atPosition } from "./slider.ts";

/** The budget reserve slider: the share of each usage window kept for people's own use. */

export interface BudgetReserve {
  /** Share of the 5-hour window, 0 to 1. */
  fiveHour: number;
  /** Share of the weekly window, 0 to 1. */
  sevenDay: number;
}

/** Position 1 to 5. Position 3 is the default (the values before the slider existed). */
export const BUDGET_RESERVE: readonly BudgetReserve[] = [
  { fiveHour: 0, sevenDay: 0 },
  { fiveHour: 0.1, sevenDay: 0.1 },
  { fiveHour: 0.2, sevenDay: 0.2 },
  { fiveHour: 0.35, sevenDay: 0.35 },
  { fiveHour: 0.5, sevenDay: 0.5 },
];

export function budgetReserve(position: number): BudgetReserve {
  return atPosition(BUDGET_RESERVE, position);
}
