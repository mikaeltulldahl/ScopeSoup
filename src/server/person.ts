// Who is at the board. There is no login, and people are equals: the board's picker names a person, remembered in that browser
// only, and every request says who it is with a header. The server records that name on answers, takes and releases.

import { actorParts } from "../core/holdings.ts";
import type { RecordedAnswer, WorkItem } from "../model/types.ts";

/** The request header that names the board's person, URI-encoded (a name may have letters a header cannot carry). */
export const PERSON_HEADER = "x-scopesoup-person";

/** The longest name the board accepts, as the item commands' `--as`. */
export const PERSON_MAX = 100;

/**
 * The person a request names: undefined when it names none, or what is wrong with the header. A name is trimmed, at most
 * `PERSON_MAX` characters, with no control characters (it goes into log lines and events).
 */
export function readPersonHeader(value: string | string[] | undefined): string | undefined | { problem: string } {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] ?? "" : value;
  let name: string;
  try {
    name = decodeURIComponent(raw).trim();
  } catch {
    return { problem: `The ${PERSON_HEADER} header is not URI-encoded text.` };
  }
  if (name === "") return undefined;
  if (name.length > PERSON_MAX) return { problem: `A person's name is at most ${PERSON_MAX} characters.` };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { problem: "A person's name cannot have line breaks or control characters." };
  return name;
}

/**
 * The people Scope Soup knows, for the board's picker: everyone who holds an item, wrote a line in an item's log or answered on
 * one, by the name the item commands use (`who` of `who@machine`). Agents are left out. Sorted, each once.
 */
export function knownPeople(works: readonly WorkItem[], answers: readonly RecordedAnswer[]): string[] {
  const names = new Set<string>();
  const add = (name: string | undefined): void => {
    const trimmed = name?.trim();
    if (trimmed && trimmed.length <= PERSON_MAX) names.add(trimmed);
  };
  for (const item of works) {
    if (item.holder && !item.holder.actor.bot) add(actorParts(item.holder.actor).who);
    for (const line of item.log ?? []) if (!line.by.agent) add(line.by.who);
    for (const answer of item.answers ?? []) add(answer.by);
  }
  for (const answer of answers) add(answer.by);
  return [...names].sort((a, b) => a.localeCompare(b));
}
