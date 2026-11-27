// Pure mapping from what the meta branch holds (each item's `item.md` and log) to the model.

import type { Actor, Assumption, Change, HistoryLine, Ref, Revision, Verdict, WorkItem } from "../../model/types.ts";
import { asOptions, optionText } from "../../model/types.ts";
import type { ParsedItem } from "./item.ts";
import { parseItem } from "./item.ts";
import type { LogActor, LogEntry, LogPicture, VerdictLine } from "./log.ts";
import { foldLog, parseLog } from "./log.ts";

export interface MetaScope {
  /** The host id used in refs. */
  host: string;
  /** The main branch a change merges on, unless its `merged` line names another. */
  target: string;
  /** When a line or file gives no time: the meta commit's time. */
  fallbackTime: string;
}

/** The two files of one item as read from the tree. Either may be missing. */
export interface ItemFiles {
  id: string;
  itemMd?: string;
  log?: string;
  /** Set instead of `itemMd` when the file was left unread (too large): the item is malformed with this problem. */
  itemMdProblem?: string;
  /** Set instead of `log` when the file was left unread: one malformed line is counted, the log is taken as empty. */
  logProblem?: string;
  /** The names of versions of `item.md` put aside in a conflict (`item.conflict-<blob>.md`): the item waits for a person. */
  conflicts?: string[];
}

export interface ReadItem {
  id: string;
  item: ParsedItem;
  picture: LogPicture;
  /** Versions of `item.md` put aside in a conflict. */
  conflicts: string[];
}

/** What one read found, for the operator and for tests. */
export interface ReadReport {
  items: number;
  /** Items whose `item.md` is missing or could not be read. They are still listed, as waiting. */
  malformedItems: string[];
  /** Log lines that could not be read or whose fields do not fit their kind. */
  malformedLines: number;
  /** Log lines of a kind Scope Soup does not know. */
  unknownKinds: number;
  /** Tree entries under `items/` that are not an item (a name that is not an id, a stray file). */
  skipped: string[];
  /** Items whose `item.md` was changed on two machines, with the other version kept beside it. Only when there are some. */
  conflicts?: string[];
  /**
   * Only when the meta branch is not at this Scope Soup's format: the format it is (null when its entry cannot be read)
   * and what that means here (an older one is migrated by the merge-queue-lease holder; a newer one is read only).
   */
  format?: { format: number | null; note: string };
}

export const workRef = (scope: MetaScope, id: string): Ref => ({ host: scope.host, kind: "work", id });
export const changeRef = (scope: MetaScope, id: string): Ref => ({ host: scope.host, kind: "change", id });

/** The most text of an item or a log that is echoed into `hostState`. */
export const MAX_ECHO = 200;
const clip = (text: string): string => (text.length <= MAX_ECHO ? text : `${text.slice(0, MAX_ECHO - 1)}…`);

export function actorOf(by: LogActor): Actor {
  const actor: Actor = by.machine ? { id: `${by.who}@${by.machine}`, name: `${by.who} on ${by.machine}` } : { id: by.who, name: by.who };
  if (by.agent) actor.bot = true;
  return actor;
}

/** The most text of one log line shown in the item's history. */
export const MAX_HISTORY_TEXT = 2000;

const words = (value: unknown): string => (typeof value === "string" ? value.trim() : Array.isArray(value) ? asOptions(value).map(optionText).join("; ") : "");
const short = (sha: unknown): string => (typeof sha === "string" ? sha.slice(0, 9) : "");

/** One log line in words, for the item page. Nothing in it is interpreted, only quoted. */
export function describeLine(entry: LogEntry): string {
  const d = entry.data;
  const tail = (label: string, value: unknown): string => (words(value) ? ` ${label}${words(value)}` : "");
  switch (entry.kind) {
    case "created":
      return "Created the item.";
    case "edited":
      // A description replaced by an accepted triage rewrite keeps the text it replaced in its line.
      return `${words(d.changed) ? `Changed ${words(d.changed).replace(/; /g, ", ")}` : "Edited the item"}${words(d.via) ? ` (${words(d.via)})` : ""}.${typeof d.was === "string" ? ` Before: ${d.was.trim() || "(no description)"}` : ""}`;
    case "claimed":
      return `Took the item until ${words(d.until)}.`;
    case "released":
      return `Let the item go.${tail("", d.reason)}`;
    case "session":
      return `Session${tail("", d.role)}${tail("ended: ", d.outcome)}.${tail("", d.summary)}`;
    case "question":
      return `Asked: ${words(d.question)}${tail("Options: ", d.options)}${tail("Recommended: ", d.recommendation)}`;
    case "answer":
      return `Answered: ${words(d.answer)}`;
    case "assumption":
      // An implementor's recorded decisions; an older line has only `assumption`.
      return Array.isArray(d.decisions)
        ? `Decided itself: ${d.decisions.map((each) => (typeof each === "object" && each !== null ? `${words((each as Record<string, unknown>).question)} ${words((each as Record<string, unknown>).chosen)}` : "")).filter(Boolean).join("; ")}`
        : `Assumed: ${words(d.assumption)}`;
    case "accepted":
      return "Accepted a decision the implementor took itself.";
    case "overturned":
      return `Overturned a decision the implementor took itself: ${words(d.answer)}${d.work === true ? " It went into the running work." : tail("New Item: ", d.item)}`;
    case "revision":
      return `New revision ${short(d.sha)}${tail("on ", d.branch)}.`;
    case "review":
      return `Review: ${words(d.verdict)} on ${short(d.sha)}.${tail("", d.findings)}`;
    case "check":
      return `Check${tail("", d.command)}: ${words(d.verdict)} on ${short(d.sha)}.${tail("", d.findings)}`;
    case "merged":
      return `Merged ${short(d.sha)}${tail("in ", d.target)}.`;
    case "moved":
      // Moved away (`to`), or moved here from GitHub or Jira (`from`), with the comments there as `history` (#134).
      if (typeof d.from === "string") return `Moved here from ${words(d.from)}${d.host === "jira" ? " on Jira" : d.host === "github" ? " on GitHub" : ""}.${typeof d.history === "string" && d.history.trim() !== "" ? ` Comments there:\n${d.history.trim()}` : ""}`;
      return `Moved to ${words(d.to)}${d.host === "jira" ? " on Jira" : d.host === "github" ? " on GitHub" : ""}.`;
    default: {
      const rest = Object.fromEntries(Object.entries(d).filter(([key]) => key !== "at" && key !== "by" && key !== "kind"));
      return `${entry.kind}: ${JSON.stringify(rest)}`;
    }
  }
}

function history(picture: LogPicture): HistoryLine[] {
  return picture.lines.map((entry) => {
    const text = describeLine(entry);
    return { at: entry.at, by: actorOf(entry.by), kind: entry.kind, text: text.length <= MAX_HISTORY_TEXT ? text : `${text.slice(0, MAX_HISTORY_TEXT - 1)}…` };
  });
}

export function readItem(files: ItemFiles): ReadItem {
  const item: ParsedItem =
    files.itemMdProblem !== undefined
      ? { ok: false, problems: [files.itemMdProblem] }
      : files.itemMd === undefined
        ? { ok: false, problems: ["item.md is missing"] }
        : parseItem(files.itemMd, files.id);
  const picture = foldLog(parseLog(files.log ?? ""));
  if (files.logProblem !== undefined) picture.malformed.push({ line: 0, raw: "", problem: files.logProblem });
  return { id: files.id, item, picture, conflicts: files.conflicts ?? [] };
}

/** A merged newest revision makes the item done, whatever the header's `state` says: the log is mechanical, the header is edited by hand. */
const isDone = (read: ReadItem): boolean => read.picture.merged !== undefined || (read.item.ok && (read.item.fields.state === "done" || read.item.fields.state === "abandoned"));
const isOpen = (read: ReadItem): boolean => read.item.ok && !isDone(read);

export function toWork(scope: MetaScope, read: ReadItem, openChildren: number): WorkItem {
  const { picture } = read;
  const updatedAt = picture.lastAt ?? scope.fallbackTime;
  let work: WorkItem;
  if (read.item.ok) {
    const fields = read.item.fields;
    work = {
      ref: workRef(scope, read.id),
      title: fields.title,
      state: picture.merged ? "done" : fields.state,
      // The log's merging is this host's own record of done; the header is edited by hand and would read "todo".
      hostState: picture.merged ? "done" : fields.state,
      labels: fields.labels,
      blockedBy: fields.blockedBy.map((id) => workRef(scope, id)),
      openChildren,
      updatedAt,
    };
    if (fields.lane === "backlog" && work.state === "todo") work.backlog = true;
    if (fields.body) work.body = fields.body;
    if (fields.parent) work.parent = workRef(scope, fields.parent);
    if (fields.duplicateOf && fields.state === "abandoned") work.duplicateOf = workRef(scope, fields.duplicateOf);
    if (fields.verification) work.verification = fields.verification;
    if (fields.priority) work.priority = fields.priority;
    if (fields.vote) work.vote = fields.vote;
  } else {
    // Shown, not dropped: a person must see it to fix it, and "waiting" keeps agents off it.
    work = {
      ref: workRef(scope, read.id),
      title: `${read.id}: item.md cannot be read`,
      state: "waiting",
      hostState: clip(`malformed: ${read.item.problems.join("; ")}`),
      labels: [],
      blockedBy: [],
      openChildren,
      updatedAt,
    };
  }
  if (picture.lines.length > 0) {
    work.history = history(picture);
    work.log = picture.lines.map((entry) => {
      const { at: _at, by: _by, kind: _kind, ...fields } = entry.data;
      return { at: entry.at, by: { ...entry.by }, kind: entry.kind, fields };
    });
  }
  // A closed Item asks nothing: closing it ended its open questions (the log's `edited` line with the state keeps them ended after a reopen).
  if (isDone(read)) picture.openQuestions = [];
  if (picture.openQuestions.length > 0) {
    work.openQuestions = picture.openQuestions.map((line) => ({
      at: line.at, by: { ...line.by }, question: line.question, options: line.options.map((option) => (typeof option === "string" ? option : { ...option })), ...(line.recommendation ? { recommendation: line.recommendation } : {}), ...(line.context ? { context: line.context } : {}), ...(line.multiSelect ? { multiSelect: true as const } : {}),
      ...(line.proposal ? { proposal: { ...line.proposal } } : {}), ...(line.set ? { set: line.set } : {}),
    }));
  }
  const assumptions = assumptionsOf(picture.lines, scope);
  if (assumptions.length > 0) work.assumptions = assumptions;
  if (picture.holder) work.holder = picture.holder.until ? { actor: actorOf(picture.holder.by), until: picture.holder.until } : { actor: actorOf(picture.holder.by) };
  if (picture.openQuestions.length > 0) work.needsDecision = true;
  if (read.conflicts.length > 0) {
    // Both versions are kept; a person picks or merges them. Agents leave the item alone meanwhile.
    work.needsDecision = true;
    work.hostState = clip(`${work.hostState}; conflict: item.md was changed on two machines, the other version is in ${read.conflicts.join(", ")}`);
  }
  return work;
}

/**
 * The verdict per key (the reviewer, the command): the latest on the current commit if there is
 * one, else the latest on any other, which is then stale. So a verdict written later on an older
 * commit never hides one on the current commit.
 */
function verdicts(lines: VerdictLine[], dimension: string, key: (line: VerdictLine) => string, current: string): Verdict[] {
  const latest = new Map<string, VerdictLine>();
  for (const line of lines) {
    const held = latest.get(key(line));
    if (!held || line.sha === current || held.sha !== current) latest.set(key(line), line);
  }
  return [...latest.values()].map((line) => ({ dimension, value: line.verdict, by: actorOf(line.by), revision: line.sha, stale: line.sha !== current }));
}

/** An item's change: its branch and its `revision`, `review`, `check` and `merged` lines. None without a revision. */
export function toChange(scope: MetaScope, read: ReadItem): Change | null {
  const { picture } = read;
  const first = picture.revisions[0];
  const last = picture.revisions[picture.revisions.length - 1];
  if (!first || !last) return null;
  const revisions: Revision[] = picture.revisions.map((line) => ({ id: line.sha, sha: line.sha, createdAt: line.at, author: actorOf(line.by) }));
  const times = [...picture.revisions, ...picture.reviews, ...picture.checks, ...(picture.merged ? [picture.merged] : [])].map((line) => line.at);
  const updatedAt = times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  const abandoned = read.item.ok && read.item.fields.state === "abandoned";
  const change: Change = {
    ref: changeRef(scope, read.id),
    title: read.item.ok ? read.item.fields.title : read.id,
    author: actorOf(first.by),
    state: picture.merged ? "merged" : abandoned ? "closed" : "open",
    draft: false,
    target: picture.merged?.target ?? scope.target,
    revisions,
    verdicts: [
      ...verdicts(picture.reviews, "review", (line) => actorOf(line.by).id, last.sha),
      // The project's check command plays the part CI plays elsewhere: one verdict per command.
      ...verdicts(picture.checks, "ci", (line) => line.command ?? "", last.sha),
    ],
    labels: [],
    works: [workRef(scope, read.id)],
    updatedAt,
  };
  if (picture.branch) change.branch = picture.branch;
  return change;
}

/**
 * The decisions implementors recorded in `assumption` lines (with `decisions`; an older line without them is no decision),
 * oldest first, each settled by the first `accepted` or `overturned` line that names its line's `at` in `to` and its place in `n`.
 * Ids are `<line at>#<n>`.
 */
export function assumptionsOf(lines: readonly LogEntry[], scope: MetaScope): Assumption[] {
  const out: Assumption[] = [];
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  for (const entry of lines) {
    const d = entry.data;
    if (entry.kind === "assumption" && Array.isArray(d.decisions)) {
      d.decisions.forEach((each, n) => {
        if (typeof each !== "object" || each === null || Array.isArray(each)) return;
        const fields = each as Record<string, unknown>;
        const question = text(fields.question);
        const chosen = text(fields.chosen);
        if (!question || !chosen) return;
        const others = Array.isArray(fields.others) ? fields.others.map(text).filter(Boolean) : [];
        out.push({ id: `${entry.at}#${n}`, at: entry.at, question, chosen, others, why: text(fields.why) });
      });
    } else if ((entry.kind === "accepted" || entry.kind === "overturned") && typeof d.to === "string" && typeof d.n === "number") {
      const to = Date.parse(d.to);
      const found = out.find((each) => Date.parse(each.at) === to && each.id.endsWith(`#${d.n}`) && !each.settled);
      if (!found) continue;
      const answer = text(d.answer);
      const item = text(d.item);
      found.settled = { verdict: entry.kind, at: entry.at, by: entry.by.who, ...(answer ? { answer } : {}), ...(item ? { item: workRef(scope, item) } : {}), ...(d.work === true ? { work: true as const } : {}) };
    }
  }
  return out;
}

/** Everything on the meta branch as model objects, plus what the read found wrong. */
export function mapItems(scope: MetaScope, files: ItemFiles[], skipped: string[] = []): { works: WorkItem[]; changes: Change[]; report: ReadReport } {
  const reads = files.map(readItem);
  const openChildren = new Map<string, number>();
  const allChildren = new Map<string, number>();
  for (const read of reads) {
    const parent = read.item.ok ? read.item.fields.parent : undefined;
    if (!parent) continue;
    allChildren.set(parent, (allChildren.get(parent) ?? 0) + 1);
    if (isOpen(read)) openChildren.set(parent, (openChildren.get(parent) ?? 0) + 1);
  }
  const works = reads.map((read) => {
    const work = toWork(scope, read, openChildren.get(read.id) ?? 0);
    const total = allChildren.get(read.id);
    if (total) work.children = total;
    return work;
  });
  const changes = reads.map((read) => toChange(scope, read)).filter((change): change is Change => change !== null);
  const report: ReadReport = {
    items: reads.length,
    malformedItems: reads.filter((read) => !read.item.ok).map((read) => read.id),
    malformedLines: reads.reduce((sum, read) => sum + read.picture.malformed.length, 0),
    unknownKinds: reads.reduce((sum, read) => sum + read.picture.unknown.length, 0),
    skipped,
  };
  const conflicted = reads.filter((read) => read.conflicts.length > 0).map((read) => read.id);
  if (conflicted.length > 0) report.conflicts = conflicted;
  return { works, changes, report };
}
