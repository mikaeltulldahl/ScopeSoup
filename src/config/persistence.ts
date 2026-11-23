import { atPosition } from "./slider.ts";

/** The persistence slider: how long Scope Soup keeps trying before an item goes to a person. */

export interface PersistenceLimits {
  /** Failed attempts of one step. */
  maxAttempts: number;
  /** Review-and-fix rounds. */
  maxFixRounds: number;
}

/** Position 1 to 5. Position 3 is the default. */
export const PERSISTENCE: readonly PersistenceLimits[] = [
  { maxAttempts: 1, maxFixRounds: 0 },
  { maxAttempts: 2, maxFixRounds: 1 },
  { maxAttempts: 3, maxFixRounds: 2 },
  { maxAttempts: 5, maxFixRounds: 4 },
  { maxAttempts: 8, maxFixRounds: 6 },
];

export function persistenceLimits(position: number): PersistenceLimits {
  return atPosition(PERSISTENCE, position);
}
