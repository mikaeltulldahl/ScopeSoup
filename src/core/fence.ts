// The fence. The triage names the paths an Item should touch and its size; the program, not the agent, compares the
// branch's real change with them. Pure.

export type StatedSize = "small" | "medium" | "large";

/**
 * Changed lines (added plus removed, tests and docs included) a change of each size stays within. A change with more is well
 * beyond its size. Generous on purpose: the fence stops a change that has wandered, not one that is a little larger than guessed.
 */
export const FENCE_LINES: Readonly<Record<StatedSize, number>> = { small: 300, medium: 1000, large: 3000 };

/**
 * Changed files outside the triage's paths a change may have. More is well beyond them. It leaves room for the docs, a
 * fixture and a shared type a change usually also touches.
 */
export const FENCE_OUTSIDE_FILES = 5;

/** One file of the branch's change; `lines` is unknown when the runner cannot count them (then only the paths are compared). */
export interface ChangedFile {
  path: string;
  lines?: number;
}

/** What a person already saw at an earlier fence stop of this Item and let go on: it widens the fence. */
export interface FenceSeen {
  paths: string[];
  lines?: number;
}

export interface FenceBreach {
  /** Changed files outside the triage's paths (and outside what a person already saw). */
  outside: string[];
  /** Changed files inside them. */
  inside: string[];
  /** Changed lines in all, when known. */
  lines?: number;
  /** The lines this change is held to. */
  limit: number;
  /** The paths part trips (more than `FENCE_OUTSIDE_FILES` outside). */
  tooWide: boolean;
  /** The size part trips (more than `limit` lines). */
  tooLarge: boolean;
}

const normal = (path: string): string => path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");

function globRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}(/.*)?$`);
}

const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const looksLikeFile = (path: string): boolean => /\.[^/]+$/.test(path);

/**
 * Whether `path` is inside one of the triage's `named` paths: the path itself, under a named folder, matched by a named glob
 * (`*`, `**`, `?`), or beside a named file in its folder (a test next to the code, `a.test.ts` beside `a.ts`).
 */
export function insideNamed(path: string, named: readonly string[]): boolean {
  const file = normal(path);
  for (const raw of named) {
    const each = normal(raw);
    if (!each) continue;
    if (/[*?]/.test(each)) {
      if (globRegex(each).test(file)) return true;
      continue;
    }
    if (file === each || file.startsWith(`${each}/`)) return true;
    if (looksLikeFile(each) && dirOf(each) !== "" && dirOf(file) === dirOf(each)) return true;
  }
  return false;
}

/**
 * The fence: null when the change is inside the triage's `named` paths and `size`, or when the triage named no paths
 * (then there is nothing to compare with). Otherwise what is beyond them. `seen` widens it: what a person let go on before.
 */
export function fenceBreach(size: StatedSize, named: readonly string[], change: readonly ChangedFile[], seen?: FenceSeen): FenceBreach | null {
  if (named.every((each) => !normal(each))) return null;
  const allowed = [...named, ...(seen?.paths ?? [])];
  const outside: string[] = [];
  const inside: string[] = [];
  for (const file of change) (insideNamed(file.path, allowed) ? inside : outside).push(file.path);
  const counted = change.every((file) => typeof file.lines === "number");
  const lines = counted ? change.reduce((sum, file) => sum + (file.lines ?? 0), 0) : undefined;
  const limit = Math.max(FENCE_LINES[size], seen?.lines ?? 0);
  const tooWide = outside.length > FENCE_OUTSIDE_FILES;
  const tooLarge = lines !== undefined && lines > limit;
  if (!tooWide && !tooLarge) return null;
  return { outside, inside, ...(lines !== undefined ? { lines } : {}), limit, tooWide, tooLarge };
}

/** The folder a file is grouped under for a proposed split: its first two folders (`src/server`), its folder (`docs`), or the file at the root. */
const groupOf = (path: string): string => {
  const parts = normal(path).split("/");
  return parts.length <= 2 ? parts[0]! : `${parts[0]}/${parts[1]}`;
};

/** At most this many parts in a proposed split; the rest go into the last. */
const MAX_PARTS = 4;

/**
 * A proposed split of a change beyond the fence, each part as the files it keeps. Wider than the paths: the part inside them,
 * then the files outside by folder. Only larger: the files by folder. A part with nothing in it is left out.
 */
export function proposedSplit(breach: FenceBreach, change: readonly ChangedFile[]): { label: string; files: string[]; lines?: number }[] {
  const linesOf = (files: readonly string[]): number | undefined => {
    if (breach.lines === undefined) return undefined;
    return files.reduce((sum, path) => sum + (change.find((file) => file.path === path)?.lines ?? 0), 0);
  };
  const byFolder = (files: readonly string[]): { label: string; files: string[] }[] => {
    const groups = new Map<string, string[]>();
    for (const path of files) groups.set(groupOf(path), [...(groups.get(groupOf(path)) ?? []), path]);
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([label, each]) => ({ label, files: each }));
  };
  const parts = breach.tooWide
    ? [...(breach.inside.length > 0 ? [{ label: "the triage's paths", files: breach.inside }] : []), ...byFolder(breach.outside)]
    : byFolder(change.map((file) => file.path));
  const kept = parts.length > MAX_PARTS
    ? [...parts.slice(0, MAX_PARTS - 1), { label: "the rest", files: parts.slice(MAX_PARTS - 1).flatMap((part) => part.files) }]
    : parts;
  return kept.map((part) => {
    const lines = linesOf(part.files);
    return { ...part, ...(lines !== undefined ? { lines } : {}) };
  });
}
