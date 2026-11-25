// Which Item a commit of the project's history belongs to, for History's commits. Pure. A main commit is linked to the
// Item that merged it: by the commit an Item's log or merged marker names, then by an Item number in its subject
// ("Title (#91) (#98)": the first number that is an Item), then by an item branch merged there. An item branch that
// points at a main commit but has no commits of its own (it starts there) is named as starting there, never as merged.

import type { WorkItem } from "../model/types.ts";
import { refKey } from "../model/types.ts";

export interface CommitLinks {
  /** refKey by full commit id, from the Items' `merged` log lines and merged markers. */
  mergedBySha: Map<string, string>;
  /** refKey by Item id. */
  byId: Map<string, string>;
  /** refKey by item branch name. */
  byBranch: Map<string, string>;
  /** Items that are done or merged: their branch on main was merged, not started. */
  finished: Set<string>;
}

export function commitLinks(works: readonly Pick<WorkItem, "ref" | "state" | "log" | "merged">[], branchOf: (work: Pick<WorkItem, "ref">) => string): CommitLinks {
  const links: CommitLinks = { mergedBySha: new Map(), byId: new Map(), byBranch: new Map(), finished: new Set() };
  for (const work of works) {
    const key = refKey(work.ref);
    links.byId.set(work.ref.id, key);
    links.byBranch.set(branchOf(work), key);
    if (work.state === "done" || (work.merged && !work.merged.reopened)) links.finished.add(key);
    if (work.merged && !work.merged.reopened) links.mergedBySha.set(work.merged.sha, key);
    for (const line of work.log ?? []) {
      const sha = line.fields.sha;
      if (line.kind === "merged" && typeof sha === "string" && sha) links.mergedBySha.set(sha, key);
    }
  }
  return links;
}

export interface CommitPlace {
  sha: string;
  subject: string;
  /** Branch names that point at the commit. */
  refs: readonly string[];
  /** Reachable from the main branch. */
  onMain: boolean;
  /** On the main branch's first-parent line: a branch tip here was not brought in by a merge commit. */
  firstParent: boolean;
}

export function linkCommit(commit: CommitPlace, links: CommitLinks): { item?: string; merged?: true; starts?: string[] } {
  const branches = commit.refs.filter((name) => links.byBranch.has(name));
  if (!commit.onMain) {
    const item = branches.map((name) => links.byBranch.get(name)).find((key) => key !== undefined);
    return item ? { item } : {};
  }
  let item = links.mergedBySha.get(commit.sha) ?? [...commit.subject.matchAll(/#(\d+)/g)].map((match) => links.byId.get(match[1]!)).find((key) => key !== undefined);
  const starts: string[] = [];
  for (const name of branches) {
    const key = links.byBranch.get(name)!;
    // A tip brought in by a merge commit, or the branch of an Item that is done: merged here. Otherwise the branch starts here.
    if (!commit.firstParent || links.finished.has(key)) item ??= key;
    else starts.push(name);
  }
  return { ...(item ? { item, merged: true as const } : {}), ...(starts.length > 0 ? { starts } : {}) };
}
