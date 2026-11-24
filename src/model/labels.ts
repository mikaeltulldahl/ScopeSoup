// Label changes the triage proposes in its draft: read from the agent's answer, kept to the repository's existing
// labels, shown as `+bug, −question`, and applied at Accept as only the changes that still make sense.

import type { LabelChange, RepoLabel } from "./types.ts";

/** Scope Soup's own labels: its code sets them, so the triage neither sees nor proposes them. */
export const isOwnLabel = (name: string): boolean => /^scopesoup[:-]/i.test(name.trim());

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The label as `names` spells it (any case), or undefined. */
const find = (names: readonly string[], name: string): string | undefined => names.find((each) => same(each, name));

/** Names from an agent's or a person's list: strings, trimmed, not empty, at most 50 of 100 characters each. */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((each): each is string => typeof each === "string" && each.trim() !== "").map((each) => each.trim().slice(0, 100)).slice(0, 50);
}

/** A label change from an answer or a request (`{ add, remove }`); undefined when it names nothing. */
export function asLabelChange(value: unknown): LabelChange | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { add, remove } = value as Record<string, unknown>;
  const change = { add: names(add), remove: names(remove) };
  return change.add.length > 0 || change.remove.length > 0 ? change : undefined;
}

/** True when the change adds or removes nothing. */
export const isEmptyChange = (change: LabelChange | undefined): boolean => !change || (change.add.length === 0 && change.remove.length === 0);

/**
 * The triage's proposal kept to what it may propose: labels the repository has (spelled as it spells them), never `scopesoup:*`,
 * an add only of a label the Item lacks and a remove only of one it has, each once, and none both added and removed. A label the
 * repository does not have is `dropped`, to be noted (not an error).
 */
export function keepProposal(proposed: LabelChange | undefined, repo: readonly string[], current: readonly string[]): { change: LabelChange; dropped: string[] } {
  const dropped: string[] = [];
  const pick = (list: readonly string[], keep: (name: string) => boolean): string[] => {
    const out: string[] = [];
    for (const name of list) {
      if (isOwnLabel(name)) continue;
      const known = find(repo, name);
      if (!known) {
        if (!find(dropped, name)) dropped.push(name);
        continue;
      }
      if (keep(known) && !find(out, known)) out.push(known);
    }
    return out;
  };
  // A label named both to add and to remove is neither.
  const both = (proposed?.add ?? []).filter((name) => find(proposed?.remove ?? [], name));
  const add = pick(proposed?.add ?? [], (name) => !find(current, name) && !find(both, name));
  const remove = pick(proposed?.remove ?? [], (name) => !!find(current, name) && !find(both, name));
  return { change: { add, remove }, dropped };
}

/**
 * What the Item's labels become at Accept: the proposed changes that still make sense on the labels it has now (an add of a label
 * already there, or a remove of one already gone, is nothing), and every other label as people left it. `scopesoup:*` never changes.
 */
export function applyChange(current: readonly string[], change: LabelChange): { labels: string[]; add: string[]; remove: string[] } {
  const add = change.add.filter((name) => !isOwnLabel(name) && !find(current, name)).filter((name, index, all) => all.findIndex((each) => same(each, name)) === index);
  const remove = change.remove.filter((name) => !isOwnLabel(name)).flatMap((name) => find(current, name) ?? []).filter((name, index, all) => all.indexOf(name) === index);
  return { labels: [...current.filter((name) => !remove.includes(name)), ...add], add, remove };
}

/** `+bug, −question` (a minus sign, not a hyphen); empty for no change. */
export function changeText(change: LabelChange | undefined): string {
  if (!change) return "";
  return [...change.add.map((name) => `+${name}`), ...change.remove.map((name) => `−${name}`)].join(", ");
}

/** The triage's prompt: the repository's labels with their descriptions, and the Item's own, without `scopesoup:*`. */
export function labelsPromptText(repo: readonly RepoLabel[] | null, current: readonly string[]): string {
  if (repo === null) return "Scope Soup cannot change this Item's labels here: leave `labels` empty.";
  const listed = repo.filter((label) => !isOwnLabel(label.name));
  const own = current.filter((name) => !isOwnLabel(name));
  return [
    "The repository's labels (name: description):",
    ...(listed.length > 0 ? listed.map((label) => `- ${label.name}${label.description?.trim() ? `: ${label.description.trim()}` : ""}`) : ["(none)"]),
    `The Item's labels: ${own.length > 0 ? own.join(", ") : "(none)"}`,
  ].join("\n");
}
