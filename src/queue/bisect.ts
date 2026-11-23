// Which prefix of the chain to test next.
//
// `good` is the longest prefix known green (0 is the base itself), `bad` the shortest prefix known
// red (null before the whole chain is tested), `suspect` the 1-based position the mapping points
// at. Testing prefix k means testing members 1..k on the base.

export type Next = { kind: "test"; k: number } | { kind: "culprit"; k: number } | { kind: "merged" };

export interface Bounds {
  good: number;
  bad: number | null;
  suspect: number | null;
}

export function nextProbe(n: number, good: number, bad: number | null, suspect: number | null = null): Next {
  if (n < 1) throw new Error("a batch has at least one member");
  if (good >= n) return { kind: "merged" };
  if (bad === null) return { kind: "test", k: n };
  if (bad <= good) throw new Error(`inconsistent batch: prefix ${good} green but ${bad} red`);
  if (bad - good === 1) return { kind: "culprit", k: bad };
  if (suspect !== null && suspect > good && suspect <= bad) {
    // The mapping says member s broke it: prove prefix s-1 green, then prefix s red.
    if (suspect - 1 > good) return { kind: "test", k: suspect - 1 };
    return { kind: "test", k: suspect };
  }
  // Binary search over (good, bad]; an odd count rounds up, so the larger part is the prefix.
  return { kind: "test", k: good + Math.ceil((bad - good) / 2) };
}

/** Folds a prefix result into the bounds. A suspect the result contradicts is dropped. */
export function applyResult(s: Bounds, k: number, green: boolean): Bounds {
  if (green) {
    const good = Math.max(s.good, k);
    return { good, bad: s.bad, suspect: s.suspect !== null && s.suspect <= good ? null : s.suspect };
  }
  const bad = s.bad === null ? k : Math.min(s.bad, k);
  return { good: s.good, bad, suspect: s.suspect !== null && s.suspect > bad ? null : s.suspect };
}
