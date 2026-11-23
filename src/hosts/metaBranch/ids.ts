// What may be an item id, and what may be the meta ref. Both come from data (tree entry names,
// header fields, settings) and end up in paths and git arguments, so both are checked here.

/**
 * An item id: a letter or digit, then letters, digits, `-` or `_`, at most 64 characters.
 * So no `.`, no `..`, no path separator, no leading `-`, and nothing git could read as an option.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isItemId(text: string): boolean {
  return ID.test(text);
}

/**
 * A ref name Scope Soup will hand to git: `refs/` and then segments of letters, digits, `.`, `_`, `-`
 * and `/`. No segment may be empty, start with `.` or end with `.lock`; no `..`, no `@{`.
 * Stricter than `git check-ref-format`, on purpose.
 */
export function isMetaRef(text: string): boolean {
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(text)) return false;
  if (text.includes("..") || text.endsWith("/") || text.endsWith(".")) return false;
  return text
    .slice("refs/".length)
    .split("/")
    .every((segment) => segment.length > 0 && !segment.startsWith(".") && !segment.startsWith("-") && !segment.endsWith(".lock"));
}

/** A branch name as a log line gives it (`scopesoup/A-12`): the same rules as a ref under `refs/heads/`. */
export function isBranchName(text: string): boolean {
  return isMetaRef(`refs/heads/${text}`);
}

/** A full or abbreviated commit id as git prints it. Anything else read from data is not passed on. (Log lines need `isFullSha`.) */
export function isSha(text: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(text);
}

/** A full commit id (SHA-1 or SHA-256), as a log line must give it: an abbreviation can become ambiguous. */
export function isFullSha(text: string): boolean {
  return /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(text);
}

/** The prefix of the ids one person or laptop creates: a letter, then up to 15 letters or digits (`A`, `RB2`). */
export function isIdPrefix(text: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(text);
}

/**
 * The next id with this prefix: one more than the highest `<prefix>-<number>` among the ids given
 * (the items that exist), so `A-12` follows `A-11` even when `A-3` is gone. Pure: two writers that
 * read the same items get the same id, so the caller must make the write conditional on what it
 * read (the meta ref's old value) and allocate again when it lost.
 */
export function allocateId(prefix: string, ids: Iterable<string>): string {
  if (!isIdPrefix(prefix)) throw new Error(`The id prefix "${prefix}" is not a letter followed by up to 15 letters or digits.`);
  // Counters of any length: BigInt, since a Number past 2^53 rounds and could merge on an existing id.
  const own = new RegExp(`^${prefix}-([0-9]+)$`);
  const taken = new Set<string>();
  let highest = 0n;
  for (const id of ids) {
    taken.add(id);
    const match = own.exec(id);
    if (match) {
      const number = BigInt(match[1] as string);
      if (number > highest) highest = number;
    }
  }
  const id = `${prefix}-${highest + 1n}`;
  if (!isItemId(id) || taken.has(id)) throw new Error(`The next id with prefix ${prefix} would be ${id}, which is not a free item id.`);
  return id;
}
