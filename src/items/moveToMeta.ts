// Moving Items from GitHub Issues or Jira back to the meta branch, from Settings' "Move back to the meta branch" (#134,
// decision 99): the reverse of `moveToHost.ts`, with its safety rules. Only the issues a person ticked move, so a run that stops
// anywhere is finished by the next:
//   1. every ticked issue becomes a meta-branch Item, all in one meta commit (`Writer.createItems`): title, description and
//      verification made inert, references between the moved issues (`#12`, `owner/name#12`, a Jira key) rewritten to the new ids
//      (code and addresses left alone), and the issue's comments as one `moved` line in the Item's log. Each Item carries
//      `importedFrom` (the import's marker), so a retry finds it and makes it never twice;
//   2. Items moved before (by an earlier run, or found again now) whose text names an issue moved now get the new ids too;
//   3. only then, after `beforeClose` says nothing got in the way and the Items are on the remote, each old issue gets a comment
//      naming its new Item (once: found again by its marker) and, as the person chose in the plan, is closed or left open.
// GitHub is read with the import's reader (`githubImport.ts`) and marked with its step on GitHub (`githubMove.ts`); Jira through
// its host.

import type { Client } from "../hosts/github/client.ts";
import { cleanBody, cleanLabel, githubOnly, importKey, IMPORTED_FROM, oneLine, type SourceIssue, tokenLogin } from "./githubImport.ts";
import { moveIssues } from "./githubMove.ts";
import { splitBody } from "../hosts/github/map.ts";
import type { JiraThreadComment } from "../hosts/jira/adapter.ts";
import type { BatchItem, BatchResult } from "../hosts/metaBranch/writer.ts";
import type { LineWrite } from "../hosts/metaBranch/writer.ts";
import { priorityFromLabels } from "../model/priority.ts";
import type { Actor, Priority, Ref, WorkItem } from "../model/types.ts";
import type { WorkPatch, WritePort } from "../ports/host.ts";
import { inertMoved, rewriteIds } from "./moveToHost.ts";

export type SourceKind = "github" | "jira";

/** One issue to move, as both hosts give it. Its text is data: people and agents wrote it. */
export interface SourceItem {
  /** How the issue is named in text: `#12` on GitHub, the key on Jira. Also the batch key. */
  name: string;
  /** Other names text may use for it (`owner/name#12`). */
  aliases: string[];
  /** The `importedFrom` value: the marker a retry finds the Item by. */
  unique: string;
  /** Where it came from: the repository (`github:owner/name`) or the Jira site and project (`jira:<site>/<KEY>`). */
  source: string;
  ref: Ref;
  title: string;
  body: string;
  verification?: string;
  labels: string[];
  priority?: Priority;
  /** The parent and the blockers, by name. */
  parent?: string;
  blockedBy: string[];
  url: string;
  /** The comments of people, oldest first, one line each. */
  history: string[];
  /** GitHub's labels on the issue, for its step there. */
  hostLabels?: string[];
}

const when = (at: string): string => (Number.isNaN(Date.parse(at)) ? oneLine(at) : new Date(at).toISOString().slice(0, 16).replace("T", " "));

/** GitHub's issues as the import reads them (`readIssues`), as items to move. */
export function fromGitHub(issues: readonly SourceIssue[], repo: string): SourceItem[] {
  return issues.map((issue) => {
    // Host text cleaned as the import cleans it (control characters, lone surrogates), so one issue cannot refuse the whole batch.
    const split = splitBody(cleanBody(issue.body));
    const oneLineVerification = split.verification !== undefined && !split.verification.includes("\n") ? oneLine(split.verification) : undefined;
    const link = (number: number | undefined): string | undefined => (number === undefined ? undefined : `#${number}`);
    return {
      name: `#${issue.number}`,
      aliases: [`${repo}#${issue.number}`],
      unique: importKey(repo, issue.number),
      source: `github:${repo.toLowerCase()}`,
      ref: { host: "github", kind: "work", id: String(issue.number) },
      title: oneLine(issue.title) || `Issue ${issue.number}`,
      body: oneLineVerification ? split.description : cleanBody(issue.body),
      ...(oneLineVerification ? { verification: oneLineVerification } : {}),
      labels: [...new Set(issue.labels.filter((label) => !githubOnly(label)).map(cleanLabel).filter((label) => label !== ""))],
      ...(priorityFromLabels(issue.labels) ? { priority: priorityFromLabels(issue.labels)! } : {}),
      ...(link(issue.parent?.number) ? { parent: link(issue.parent?.number)! } : {}),
      // Only open blockers, as the import keeps them.
      blockedBy: issue.blockedBy.filter((each) => each.open).map((each) => link(each.number)).filter((each): each is string => each !== undefined),
      url: issue.url,
      history: (issue.comments ?? []).map((comment) => `${when(comment.at)} @${oneLine(comment.login)}: ${oneLine(comment.body)}`),
      hostLabels: issue.labels,
    };
  });
}

/** Jira's issues as its host reads them, with their comments (`thread`), as items to move. Scope Soup's own comments stay out. */
export function fromJira(works: readonly WorkItem[], comments: ReadonlyMap<string, readonly JiraThreadComment[]>, site: string): SourceItem[] {
  return works.map((work) => {
    const verification = cleanBody(work.verification ?? "").trim();
    const multi = verification.includes("\n");
    const body = cleanBody(work.body ?? "");
    return {
      name: work.ref.id,
      aliases: [],
      unique: `jira:${hostOf(site)}/${work.ref.id}`,
      source: `jira:${hostOf(site)}/${work.ref.id.replace(/-\d+$/, "")}`,
      ref: work.ref,
      title: oneLine(work.title) || work.ref.id,
      body: multi ? `${body.trim()}\n\n## Verification\n\n${verification}` : body,
      ...(verification && !multi ? { verification: oneLine(verification) } : {}),
      labels: [...new Set(work.labels.map(cleanLabel).filter((label) => label !== ""))],
      ...(work.priority ? { priority: work.priority } : {}),
      ...(work.parent ? { parent: work.parent.id } : {}),
      blockedBy: work.blockedBy.map((each) => each.id),
      url: `${site.replace(/\/+$/, "")}/browse/${work.ref.id}`,
      history: (comments.get(work.ref.id) ?? []).filter((comment) => Object.keys(comment.properties).length === 0 && comment.markdown.trim() !== "").map((comment) => `${when(comment.created)} ${oneLine(comment.author.name)}: ${oneLine(comment.markdown)}`),
    };
  });
}

const hostOf = (site: string): string => {
  try {
    return new URL(site).host.toLowerCase();
  } catch {
    return site.toLowerCase();
  }
};

/** The most of the comments one log line holds (a line is at most 16 KB, escaped). */
const HISTORY_CHARS = 10_000;

/** The comments as one log line's text, oldest first, made inert; cut at the end when too long. */
export function historyText(item: SourceItem, hostName: string): string {
  const all = item.history.length > 0 ? item.history.map((line) => `- ${line}`).join("\n") : "(no comments)";
  const text = all.length > HISTORY_CHARS ? `${all.slice(0, HISTORY_CHARS).replace(/[\uD800-\uDBFF]$/, "")}\n(cut here: the rest is on ${hostName})` : all;
  return inertMoved(text);
}

/** The meta branch, as a move back writes it: the batch, its Items (for those moved before) and an edit of one's text. */
export interface MetaTarget {
  /** With `dryRun` nothing is written: only checked, as a write would be. */
  createItems(batch: readonly BatchItem[], options?: { message?: string; dryRun?: boolean }): Promise<BatchResult>;
  /** The meta branch's Items, with their logs. */
  listWork(): Promise<WorkItem[]>;
  editWork(ref: Ref, patch: WorkPatch): Promise<unknown>;
}

/** Where an Item on the meta branch came from, by its `moved` line from this source (repository, or Jira site and project): the issue's name there. */
export function movedFrom(item: WorkItem, source: string): string | undefined {
  return movedLine(item, source)?.from;
}

const movedLine = (item: WorkItem, source: string): { from: string; aliases: string[] } | undefined => {
  const line = [...(item.log ?? [])].reverse().find((each) => each.kind === "moved" && each.fields.source === source && typeof each.fields.from === "string");
  if (!line) return undefined;
  const aliases = Array.isArray(line.fields.aliases) ? line.fields.aliases.filter((each): each is string => typeof each === "string") : [];
  return { from: String(line.fields.from), aliases };
};

/** The comment on the old issue that names its new Item; the marker line lets a retry find it. */
export const backMarker = (id: string): string => `Moved to Scope Soup's meta branch as Item ${id}.`;

/** The batch: one Item per ticked issue, keyed by its name, found again by `importedFrom`. Pure. */
export function moveBatch(kind: SourceKind, items: readonly SourceItem[], earlier: ReadonlyMap<string, string>, by: string): BatchItem[] {
  const hostName = kind === "github" ? "GitHub" : "Jira";
  const line = { who: by, agent: false };
  return items.map((item): BatchItem => ({
    key: item.name,
    unique: [IMPORTED_FROM, item.unique],
    make(idOf) {
      const names = new Map(earlier);
      for (const each of items) {
        const id = idOf(each.name);
        if (!id) continue;
        names.set(each.name, id);
        for (const alias of each.aliases) names.set(alias, id);
      }
      const idFor = (name: string | undefined): string | undefined => (name === undefined ? undefined : names.get(name));
      const parent = idFor(item.parent);
      const blockedBy = [...new Set(item.blockedBy.map(idFor).filter((each): each is string => each !== undefined))];
      // The name in code, so a later rewrite of ids leaves it as it is.
      const notes = [`Moved from ${hostName}: [\`${item.name}\`](${item.url}).`];
      if (item.parent && !parent) notes.push(`A sub-issue there of ${item.parent}, which did not move.`);
      const away = item.blockedBy.filter((name) => !idFor(name));
      if (away.length > 0) notes.push(`Blocked there by ${away.join(", ")}, which did not move.`);
      const body = rewriteIds(inertMoved(item.body.trim()), names);
      const verification = item.verification ? rewriteIds(inertMoved(item.verification), names) : undefined;
      const lines: LineWrite[] = [
        { kind: "created", by: line },
        { kind: "moved", by: line, fields: { from: item.name, ...(item.aliases.length > 0 ? { aliases: item.aliases } : {}), host: kind, source: item.source, url: item.url, history: historyText(item, hostName) } },
      ];
      return {
        input: {
          title: item.title,
          state: "todo",
          labels: item.labels,
          ...(parent ? { parent } : {}),
          blockedBy,
          ...(verification ? { verification } : {}),
          ...(item.priority ? { priority: item.priority } : {}),
          body: [body, `_${notes.join(" ")}_`].filter((part) => part !== "").join("\n\n"),
        },
        lines,
      };
    },
  }));
}

/** The old host, as the move marks its issues: a comment naming the new Item, then closed if the person chose so. */
export interface OldHost {
  kind: SourceKind;
  /** Marks each, in order; stops at the first failure. Safe to run again: nothing is done twice. */
  mark(targets: readonly { item: SourceItem; id: string }[], close: boolean): Promise<{ did: Map<string, string[]>; failed?: { name: string; message: string } }>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The words of the comment on the old issue. Scope Soup's own facts only (the new id), never issue text. */
function backComment(id: string, close: boolean): string {
  return [
    `This issue moved to Scope Soup: it is Item ${id} on the project's meta branch (refs/scopesoup/meta), with its description and comments. The work goes on there; what is written here is no longer read.`,
    ...(close ? ["", "It is closed here because it is tracked in Scope Soup now, not because it was dropped."] : []),
    "",
    backMarker(id),
  ].join("\n");
}

/** GitHub: the import's step there (`githubMove.ts`): a comment naming the Item and the label, and closed as not planned if chosen. */
export function githubOldHost(client: Client): OldHost {
  return {
    kind: "github",
    async mark(targets, close) {
      // Only the token's own earlier comment counts as already there: without its login, any user's marker would.
      const login = await tokenLogin(client);
      if (!login) return { did: new Map(), failed: { name: targets[0]?.item.name ?? "", message: "GitHub did not say whose token this is (/user), so Scope Soup cannot tell its own earlier comment from someone else's; nothing was written on GitHub. Try again" } };
      const report = await moveIssues({
        client, choice: close ? "close" : "label", where: "the project's meta branch (refs/scopesoup/meta)", login,
        targets: targets.map(({ item, id }) => ({ number: Number(item.ref.id), id, open: true, labels: item.hostLabels ?? [] })),
      });
      const did = new Map(report.rows.map((row) => [`#${row.number}`, row.did as string[]]));
      return { did, ...(report.failed ? { failed: { name: `#${report.failed.number}`, message: report.failed.message } } : {}) };
    },
  };
}

/** Jira: a comment naming the Item (once: found again by its marker line), then closed (abandoned) if chosen. */
export function jiraOldHost(host: { info: { whoami(): Promise<Actor> }; thread(ref: Ref): Promise<{ comments: readonly JiraThreadComment[] }>; work: { getWork(ref: Ref): Promise<WorkItem | null> }; write?: WritePort }): OldHost {
  return {
    kind: "jira",
    async mark(targets, close) {
      const did = new Map<string, string[]>();
      const write = host.write;
      if (!write?.comment || !write.editWork) return { did, failed: { name: targets[0]?.item.name ?? "", message: "Jira cannot be written to here" } };
      // Only a comment by the token's own account counts as the one an earlier run posted.
      let self: string;
      try {
        self = (await host.info.whoami()).id.toLowerCase();
      } catch (error) {
        return { did, failed: { name: targets[0]?.item.name ?? "", message: `Jira did not say whose token this is (${messageOf(error)}), so Scope Soup cannot tell its own earlier comment from someone else's; nothing was written on Jira. Try again` } };
      }
      for (const { item, id } of targets) {
        const steps: string[] = [];
        did.set(item.name, steps);
        try {
          const thread = await host.thread(item.ref);
          if (!thread.comments.some((comment) => comment.author.id.toLowerCase() === self && comment.markdown.includes(backMarker(id)))) {
            await write.comment(item.ref, backComment(id, close));
            steps.push("commented");
          }
          if (close) {
            const now = await host.work.getWork(item.ref);
            if (now && now.state !== "done" && now.state !== "abandoned") {
              await write.editWork(item.ref, { state: "abandoned" });
              steps.push("closed");
            }
          }
        } catch (error) {
          return { did, failed: { name: item.name, message: messageOf(error) } };
        }
      }
      return { did };
    },
  };
}

export interface MoveBackOptions {
  kind: SourceKind;
  /** Where the issues come from (`SourceItem.source`): Items moved before from it are found by their `moved` line. */
  source: string;
  /** The ticked issues, as read from the old host. */
  items: readonly SourceItem[];
  to: MetaTarget;
  from: OldHost;
  /** Close the old issues (true) or leave them open (false), as the person chose in the plan. */
  close: boolean;
  /** Just before the old host is written to: what is in the way now (busy machines), or nothing. */
  beforeClose?: () => string | undefined;
  /** The person who moves them, for the log lines and the commit. */
  by: string;
}

export interface MoveBackRow {
  name: string;
  title: string;
  /** The new Item's id, once it exists. */
  to?: string;
  did: string[];
}

export interface MoveBackReport {
  rows: MoveBackRow[];
  /** The first step that failed; the rest was not done. Running it again finishes it. */
  failed?: { name: string; message: string };
}

/** Moves the ticked issues to the meta branch, then marks them on the old host. Stops at the first failure; safe to run again. */
export async function moveBack(options: MoveBackOptions): Promise<MoveBackReport> {
  const { kind, to, source } = options;
  const items = [...options.items].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const report: MoveBackReport = { rows: items.map((item) => ({ name: item.name, title: item.title, did: [] })) };
  const rowOf = (name: string): MoveBackRow | undefined => report.rows.find((row) => row.name === name);
  const fail = (name: string, message: string): MoveBackReport => ({ ...report, failed: { name, message } });
  const first = items[0]?.name ?? "";

  // The Items moved before from this host, by their `moved` line.
  let onMeta: WorkItem[];
  try {
    onMeta = (await to.listWork()).filter((work) => movedFrom(work, source) !== undefined);
  } catch (error) {
    return fail(first, `the meta branch could not be read: ${messageOf(error)}`);
  }
  const earlier = new Map<string, string>();
  for (const work of onMeta) {
    const { from, aliases } = movedLine(work, source)!;
    for (const name of [from, ...aliases]) earlier.set(name, work.ref.id);
  }

  // 1. Every Item in one meta commit; one an earlier run made is found by its marker.
  let made: BatchResult;
  const batch = moveBatch(kind, items, earlier, options.by);
  try {
    made = await to.createItems(batch, { message: `Move ${items.length} issue${items.length === 1 ? "" : "s"} back from ${kind === "github" ? "GitHub" : "Jira"}` });
  } catch (error) {
    // The batch is one commit: name the issue the meta branch refuses, checked one by one without writing.
    for (const each of batch) {
      try {
        await to.createItems([each], { dryRun: true });
      } catch (refused) {
        return fail(each.key, `the meta branch refuses it: ${messageOf(refused)}. Nothing was written`);
      }
    }
    return fail(first, messageOf(error));
  }
  const names = new Map(earlier);
  for (const item of items) {
    const got = made.items.get(item.name);
    if (!got) return fail(item.name, "the meta branch did not say which Item it became");
    const row = rowOf(item.name)!;
    row.to = got.id;
    row.did.push(got.created ? "created" : "found");
    names.set(item.name, got.id);
    for (const alias of item.aliases) names.set(alias, got.id);
  }

  // 2. References to issues made in this run, in Items moved before (or found again now). Only this run's names: an id written
  // by an earlier run is never rewritten again.
  const freshNames = new Map<string, string>();
  for (const item of items) {
    const got = made.items.get(item.name);
    if (!got?.created) continue;
    for (const name of [item.name, ...item.aliases]) freshNames.set(name, got.id);
  }
  const fresh = new Set(freshNames.values());
  for (const work of onMeta) {
    if (fresh.has(work.ref.id) || freshNames.size === 0) continue;
    const body = work.body ?? "";
    const verification = work.verification ?? "";
    const next = { body: rewriteIds(body, freshNames), verification: rewriteIds(verification, freshNames) };
    if (next.body === body && next.verification === verification) continue;
    try {
      await to.editWork(work.ref, { ...(next.body !== body ? { body: next.body } : {}), ...(next.verification !== verification ? { verification: next.verification } : {}) });
      const row = rowOf(movedFrom(work, source)!);
      if (row) row.did.push("linked");
    } catch (error) {
      return fail(movedFrom(work, source)!, messageOf(error));
    }
  }

  // 3. The old issues, last: only once the Items are where every machine sees them and nothing is in the way.
  if (made.sharing?.state === "pending") return fail(first, `the Items are not on the remote yet${made.sharing.problem ? ` (${made.sharing.problem})` : ""}, so the old issues were left as they are. Move back again once they are shared`);
  const blocked = options.beforeClose?.();
  if (blocked) return fail(first, `${blocked} The old issues were left as they are; Move back again finishes it`);
  if (items.length === 0) return report;
  const marked = await options.from.mark(items.map((item) => ({ item, id: names.get(item.name)! })), options.close);
  for (const [name, steps] of marked.did) rowOf(name)?.did.push(...steps);
  if (marked.failed) return fail(marked.failed.name, marked.failed.message);
  return report;
}

/** The report in words, one line per issue. */
export function moveBackLines(report: MoveBackReport): string[] {
  const lines = report.rows.map((row) => `${row.name} "${row.title}": ${row.to ? `${row.to} (${row.did.join(", ") || "nothing to do"})` : "not moved"}`);
  if (report.failed) lines.push(`Stopped at ${report.failed.name}: ${report.failed.message}. Move back again with the same issues to finish; nothing is made twice.`);
  return lines;
}
