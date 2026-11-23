/** The entry of a slider table at a position: 1 to the table's length, rounded and clamped. */
export function atPosition<T>(table: readonly T[], position: number): T {
  return table[Math.min(table.length, Math.max(1, Math.round(position))) - 1] as T;
}
