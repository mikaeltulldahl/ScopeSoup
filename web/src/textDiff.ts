// A unified line diff of two texts, with the changed words marked inside a changed line. Pure (no DOM), so
// src/testing/textDiff.test.ts can test it. Used for the triage rewrite against the description (Item.tsx).

/** A run of a line's text; `changed` marks the words that differ from the paired line. */
export interface Part { text: string; changed: boolean }
export interface DiffRow {
  kind: "same" | "del" | "add";
  text: string;
  /** For a removed or added line that has a partner in the same change: its words, the differing ones marked. */
  parts?: Part[];
}
/** Rows, with long runs of unchanged rows folded into one `skipped` entry. */
export type Shown = { row: DiffRow } | { skipped: DiffRow[] };

/** Longest common subsequence of two arrays, as the pairs of matching indexes. */
function lcs<T>(a: readonly T[], b: readonly T[]): [number, number][] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** Text as lines; "" is no lines. */
function linesOf(text: string): string[] {
  const normal = text.replace(/\r\n?/g, "\n");
  return normal === "" ? [] : normal.split("\n");
}

/** Words and the white space between them, so that joining the tokens gives the line back. */
function tokens(line: string): string[] {
  return line.match(/\s+|[^\s]+/g) ?? [];
}

/** The tokens of `line` that are not in `other` (in order), marked; neighbours of one kind joined. */
export function wordParts(line: string, other: string): Part[] {
  const mine = tokens(line);
  const kept = new Set(lcs(mine, tokens(other)).map(([i]) => i));
  const parts: Part[] = [];
  mine.forEach((token, index) => {
    const changed = !kept.has(index);
    const last = parts[parts.length - 1];
    if (last && last.changed === changed) last.text += token;
    else parts.push({ text: token, changed });
  });
  return parts;
}

/**
 * The word marks of a removed line and the added line paired with it, or null when they are not partners: lines with no word
 * in common say nothing when every word is marked. The pairing rule of the rewrite diff and of a file's diff.
 */
export function partnerParts(removed: string, added: string): { del: Part[]; add: Part[] } | null {
  const theirs = new Set(tokens(added));
  if (!tokens(removed).some((token) => /\S/.test(token) && theirs.has(token))) return null;
  return { del: wordParts(removed, added), add: wordParts(added, removed) };
}

/**
 * The diff of `before` into `after`: unchanged lines, removed lines, added lines, in unified order (in each change the removed
 * lines, then the added ones). Within a change the i-th removed line and the i-th added line are partners and get `parts`.
 */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = linesOf(before);
  const b = linesOf(after);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  const change = (toI: number, toJ: number) => {
    const removed = a.slice(i, toI);
    const added = b.slice(j, toJ);
    const dels: DiffRow[] = removed.map((text) => ({ kind: "del", text }));
    const adds: DiffRow[] = added.map((text) => ({ kind: "add", text }));
    for (let k = 0; k < Math.min(removed.length, added.length); k++) {
      const partners = partnerParts(removed[k]!, added[k]!);
      if (!partners) continue;
      dels[k]!.parts = partners.del;
      adds[k]!.parts = partners.add;
    }
    rows.push(...dels, ...adds);
  };
  for (const [matchI, matchJ] of lcs(a, b)) {
    change(matchI, matchJ);
    rows.push({ kind: "same", text: a[matchI]! });
    i = matchI + 1;
    j = matchJ + 1;
  }
  change(a.length, b.length);
  return rows;
}

/** Whether the rows hold any change. */
export function hasChanges(rows: readonly DiffRow[]): boolean {
  return rows.some((row) => row.kind !== "same");
}

/**
 * Folds each run of unchanged rows into one `skipped` entry when at least `minHidden` rows would hide, keeping `context`
 * rows next to a change (and at the ends of the text only the side that touches one).
 */
export function collapse(rows: readonly DiffRow[], context = 3, minHidden = 4): Shown[] {
  const shown: Shown[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index]!.kind !== "same") { shown.push({ row: rows[index]! }); index++; continue; }
    let end = index;
    while (end < rows.length && rows[end]!.kind === "same") end++;
    const before = index === 0 ? 0 : context;
    const after = end === rows.length ? 0 : context;
    if (end - index - before - after >= minHidden) {
      for (let k = index; k < index + before; k++) shown.push({ row: rows[k]! });
      shown.push({ skipped: rows.slice(index + before, end - after) });
      for (let k = end - after; k < end; k++) shown.push({ row: rows[k]! });
    } else {
      for (let k = index; k < end; k++) shown.push({ row: rows[k]! });
    }
    index = end;
  }
  return shown;
}

/**
 * Word marks for the lines of a unified diff of one file (git's hunks: "-", "+", " " and "@@" lines). In each run of "-" lines
 * followed by "+" lines the i-th pair are partners (the rewrite diff's rule, `partnerParts`). Entry `k` is the parts of line `k`
 * without its first character, or undefined when the line has no partner.
 */
export function hunkParts(lines: readonly string[]): (Part[] | undefined)[] {
  const out: (Part[] | undefined)[] = new Array(lines.length).fill(undefined);
  let index = 0;
  while (index < lines.length) {
    if (!lines[index]!.startsWith("-")) { index++; continue; }
    let delEnd = index;
    while (delEnd < lines.length && lines[delEnd]!.startsWith("-")) delEnd++;
    let addEnd = delEnd;
    while (addEnd < lines.length && lines[addEnd]!.startsWith("+")) addEnd++;
    for (let k = 0; k < Math.min(delEnd - index, addEnd - delEnd); k++) {
      const partners = partnerParts(lines[index + k]!.slice(1), lines[delEnd + k]!.slice(1));
      if (!partners) continue;
      out[index + k] = partners.del;
      out[delEnd + k] = partners.add;
    }
    index = addEnd;
  }
  return out;
}
