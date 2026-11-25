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
export function knownPeople(works: readonly WorkItem[], answers: readonly RecordedAnswer[], jiraHost?: string): string[] {
  const names = new Set<string>();
  const add = (name: string | undefined): void => {
    const trimmed = name?.trim();
    if (trimmed && trimmed.length <= PERSON_MAX) names.add(trimmed);
  };
  for (const item of works) {
    // A Jira holder is the account id or user name as a whole (it may have an "@"); the board matches on it.
    if (item.holder && !item.holder.actor.bot) add(jiraHost !== undefined && item.ref.host === jiraHost ? item.holder.actor.id : actorParts(item.holder.actor).who);
    for (const line of item.log ?? []) if (!line.by.agent) add(line.by.who);
    for (const answer of item.answers ?? []) add(answer.by);
  }
  for (const answer of answers) add(answer.by);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * The display names of the picker's Jira holders, by the account id or user name the picker's value is (`knownPeople`): only where
 * the name differs from the id. Everyone else is shown as they are named.
 */
export function peopleNames(works: readonly WorkItem[], jiraHost: string | undefined): Record<string, string> {
  const names: Record<string, string> = {};
  if (jiraHost === undefined) return names;
  for (const item of works) {
    const actor = item.holder?.actor;
    const name = actor?.name.trim();
    if (actor && !actor.bot && item.ref.host === jiraHost && name && name !== actor.id.trim() && actor.id.trim().length <= PERSON_MAX) names[actor.id.trim()] = name;
  }
  return names;
}
