// Items that would change the same files. The triage names the paths an Item will likely touch; an Item whose paths
// overlap those of an Item in progress or in review waits, so two branches do not race to change the same files. Pure.

import type { Ref } from "../model/types.ts";
import { refLabel } from "./snapshot.ts";

/** An Item and the paths its triage named. */
export interface NamedFiles {
  item: Ref;
  paths: readonly string[];
}

/**
 * A named path as a plain path or folder: separators made "/", leading "./" and "/" and trailing "/" dropped. A glob is
 * cut back to the folder before its first wildcard ("src/core/*.ts" is "src/core"). Empty when nothing is left, such as a
 * glob at the root: it names no place, so it overlaps nothing.
 */
function place(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  const wild = path.search(/[*?[]/);
  if (wild >= 0) path = path.slice(0, path.lastIndexOf("/", wild) + 1);
  return path.replace(/\/+$/, "");
}

/** Whether two lists of named paths share a file: the same path, or one inside the other's folder. */
export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const others = b.map(place).filter(Boolean);
  for (const one of a.map(place)) {
    if (!one) continue;
    for (const other of others) {
      if (one === other || one.startsWith(`${other}/`) || other.startsWith(`${one}/`)) return true;
    }
  }
  return false;
}

/** The Items of `busy` whose named paths overlap `candidate`'s, in `busy`'s order. None when the candidate named no paths. */
export function sameFilesAs(candidate: NamedFiles, busy: readonly NamedFiles[]): Ref[] {
  return busy.filter((each) => each.item.host !== candidate.item.host || each.item.id !== candidate.item.id).filter((each) => pathsOverlap(candidate.paths, each.paths)).map((each) => each.item);
}

/** The card's words: "waits for #5, which changes the same files". */
export function sameFilesWords(waitsFor: readonly Ref[]): string {
  const names = waitsFor.map(refLabel);
  const named = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `waits for ${named}, which ${names.length === 1 ? "changes" : "change"} the same files`;
}
