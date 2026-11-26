// Items that would change the same files. The triage names the paths an Item will likely touch; an Item whose paths
// overlap those of a busy Item (in progress, in review, or with a change not yet on main) waits, so two branches do not race
// to change the same files. So does an Item linked to a busy one with `conflictsWith`, unless a person said to go on with both. Pure.

import type { ItemLinkAnswer, RecordedAnswer, Ref } from "../model/types.ts";
import { wentOnWithBoth } from "./answerReuse.ts";
import { refLabel } from "./snapshot.ts";

/** An Item, the paths its triage named and the triage's links. */
export interface NamedFiles {
  item: Ref;
  paths: readonly string[];
  links?: readonly ItemLinkAnswer[];
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

/** Whether a link's Item name from an agent (`#12`, `12`, `A-3` or a ref key) names `target`, on `from`'s host. */
function names(from: Ref, name: string, target: Ref): boolean {
  if (target.host !== from.host) return false;
  let id = name.trim();
  const prefix = `${from.host}:work:`;
  if (id.startsWith(prefix)) id = id.slice(prefix.length);
  return id.replace(/^#/, "") === target.id;
}

const conflicts = (from: NamedFiles, other: Ref): boolean => (from.links ?? []).some((link) => link.type === "conflictsWith" && names(from.item, link.item, other));

/**
 * The Items of `busy` linked to `candidate` with `conflictsWith`, by either one's triage, in `busy`'s order; not a pair a person
 * answered "Go on with both" for (`wentOnWithBoth`), and never the candidate itself.
 */
export function mayConflictWith(candidate: NamedFiles, busy: readonly NamedFiles[], answers: readonly RecordedAnswer[]): Ref[] {
  return busy
    .filter((each) => each.item.host !== candidate.item.host || each.item.id !== candidate.item.id)
    .filter((each) => conflicts(candidate, each.item) || conflicts(each, candidate.item))
    .filter((each) => !wentOnWithBoth(answers, candidate.item, each.item))
    .map((each) => each.item);
}

const listed = (refs: readonly Ref[]): string => {
  const labels = refs.map(refLabel);
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
};

/** The card's words: "waits for #5, which changes the same files", "waits for #6, which may conflict with it", or both joined. */
export function sameFilesWords(waitsFor: readonly Ref[], mayConflict: readonly Ref[] = []): string {
  const parts: string[] = [];
  if (waitsFor.length > 0) parts.push(`${listed(waitsFor)}, which ${waitsFor.length === 1 ? "changes" : "change"} the same files`);
  if (mayConflict.length > 0) parts.push(`${listed(mayConflict)}, which may conflict with it`);
  return `waits for ${parts.join(", and ")}`;
}
