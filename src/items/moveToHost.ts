// Moving Items from the meta branch to GitHub Issues or Jira, when the project connects to that host from Settings (#127,
// decision 97). Only the Items a person ticked move, in four rounds, so a run that stops anywhere is finished by the next:
//   1. each becomes a new issue (title, description, verification, made inert) whose text ends with a marker line naming the old
//      id; an issue an earlier run made is found by that marker (on Jira through an unfiltered look at the project) and reused;
//      one that falls outside the host's filter stops the move before any old Item is touched;
//   2. references to moved Items (moved now or by an earlier run, found by their `moved` line) are rewritten to the new ids, in
//      the text of every moved Item whose text names one; code and addresses are left alone;
//   3. each Item's history goes to its new issue as one comment, and the old Item gets a `moved` log line naming it;
//   4. only then, after `beforeClose` says nothing got in the way, the old Items are closed (abandoned).
// A history comment can be posted twice if a run stops between it and its `moved` line.
// (`githubMove.ts` is the other way: GitHub issues imported into the meta branch.)

import type { Ref, WorkItem } from "../model/types.ts";
import type { Host, WorkPort, WritePort } from "../ports/host.ts";
import { inertText } from "../orchestrator/hostText.ts";

/** The last line of a moved Item's new issue: which meta branch Item it was. */
export const movedMarker = (id: string): string => `Moved from Scope Soup's meta branch: Item ${id}.`;
const MARKER = /^Moved from Scope Soup's meta branch: Item (\S+)\.$/gm;

/** Item text made inert, with any line shaped like the marker broken, so text cannot pose as a moved Item. */
export function inertMoved(text: string): string {
  return inertText(text).replace(/^(\s*)M(oved from Scope Soup's meta branch)/gim, "$1M​$2");
}

/** How a new issue is named in text: `#12` on GitHub (so GitHub links it), the key on Jira. */
export const newName = (kind: "github" | "jira", ref: Ref): string => (kind === "github" ? `#${ref.id}` : ref.id);

/** Fenced code, inline code and web addresses: left as they are when ids are rewritten. */
const KEEP = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|\bhttps?:\/\/[^\s)>\]]+)/g;

/** Whole ids of moved Items replaced by their new names, outside code and addresses; nothing else changes. */
export function rewriteIds(text: string, names: ReadonlyMap<string, string>): string {
  if (names.size === 0) return text;
  const ids = [...names.keys()].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![A-Za-z0-9_#/-])(${ids.join("|")})(?![A-Za-z0-9_-])`, "g");
  return text.split(KEEP).map((part, index) => (index % 2 === 1 ? part : part.replace(pattern, (id) => names.get(id) ?? id))).join("");
}

/** The history as one comment: one line per log line, oldest first, made inert. */
export function historyComment(item: WorkItem): string {
  const lines = (item.history ?? []).map((line) => `- ${line.at.slice(0, 16).replace("T", " ")} ${line.by.name}: ${line.text.replace(/\s+/g, " ").trim()}`);
  return inertMoved([`History of Item ${item.ref.id} on Scope Soup's meta branch, oldest first:`, "", ...(lines.length > 0 ? lines : ["(no lines)"])].join("\n"));
}

/** Where an Item went, by its `moved` log line: the new issue's name. */
const movedTo = (item: WorkItem): string | undefined => {
  const line = [...(item.log ?? [])].reverse().find((each) => each.kind === "moved" && typeof each.fields.to === "string");
  return line ? String(line.fields.to) : undefined;
};

export interface MoveOptions {
  kind: "github" | "jira";
  /** The Items to move, as the store has them (with their history and log). */
  items: readonly WorkItem[];
  /** Every Item of the meta branch, closed ones too: those an earlier run moved name their new issue in their `moved` line. */
  all?: readonly WorkItem[];
  /** The meta branch host's writes: the `moved` line and the close. */
  from: Pick<WritePort, "appendLog" | "editWork">;
  /** The new host, with writes on. */
  to: Host;
  /** Where issues an earlier run made are looked for: the new host's project without its filter. Default `to.work`. */
  find?: WorkPort;
  /** Why an issue (just made, or found again) falls outside the host's filter, or undefined. */
  outside?: (ref: Ref) => Promise<string | undefined>;
  /** Just before the old Items are closed: what is in the way now (busy machines), or nothing. */
  beforeClose?: () => string | undefined;
  /** The person who connected, for the log lines. */
  by: string;
}

export interface MoveRow {
  id: string;
  title: string;
  /** The new issue's name (`#12`, `DEMO-7`), once it exists. */
  to?: string;
  did: ("created" | "found" | "linked" | "history" | "closed")[];
}

export interface MoveReport {
  rows: MoveRow[];
  /** The first step that failed; the rest was not done. Running it again finishes it. */
  failed?: { id: string; message: string };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Moves the Items, in id order; stops at the first failure. Safe to run again. */
export async function moveItems(options: MoveOptions): Promise<MoveReport> {
  const { kind, to, from } = options;
  const write = to.write;
  if (!to.work || !write?.createWork || !write.editWork || !write.comment) throw new Error("The new host cannot be written to: moving Items needs writes on.");
  if (!from.appendLog || !from.editWork) throw new Error("The meta branch cannot be written to here, so no Item can be moved.");
  const items = [...options.items].sort((a, b) => a.ref.id.localeCompare(b.ref.id, undefined, { numeric: true }));
  const report: MoveReport = { rows: items.map((item) => ({ id: item.ref.id, title: item.title, did: [] })) };
  const rowOf = (item: WorkItem): MoveRow => report.rows[items.indexOf(item)]!;
  const by = { who: options.by, agent: false };
  const text = (item: WorkItem) => ({ body: inertMoved((item.body ?? "").trim()), verification: inertMoved((item.verification ?? "").trim()) });
  const fail = (id: string, message: string): MoveReport => ({ ...report, failed: { id, message } });

  // The new names of Items moved by an earlier run, from their `moved` lines.
  const earlier = (options.all ?? []).filter((item) => !items.some((each) => each.ref.id === item.ref.id));
  const names = new Map<string, string>();
  for (const item of earlier) {
    const name = movedTo(item);
    if (name) names.set(item.ref.id, name);
  }

  // 1. Find what an earlier run made (by the marker), make the rest.
  const made = new Map<string, Ref>();
  try {
    for (const work of (await (options.find ?? to.work).listWork()).items) {
      for (const match of `${work.body ?? ""}\n${work.verification ?? ""}`.matchAll(MARKER)) {
        const item = items.find((each) => each.ref.id === match[1]);
        if (item && !made.has(item.ref.id) && work.title.trim() === item.title.trim()) made.set(item.ref.id, work.ref);
      }
    }
  } catch (error) {
    return fail(items[0]?.ref.id ?? "", `the new host's issues could not be read: ${messageOf(error)}`);
  }
  for (const item of items) {
    const row = rowOf(item);
    const found = made.get(item.ref.id);
    if (found) {
      row.did.push("found");
    } else {
      try {
        const { body, verification } = text(item);
        const done = await write.createWork({ title: item.title.trim(), body: `${body}\n\n${movedMarker(item.ref.id)}`.trim(), ...(verification ? { verification } : {}) });
        made.set(item.ref.id, done.work);
        row.did.push("created");
      } catch (error) {
        return fail(item.ref.id, messageOf(error));
      }
    }
    const ref = made.get(item.ref.id)!;
    row.to = newName(kind, ref);
    names.set(item.ref.id, row.to);
    let why: string | undefined;
    try {
      why = await options.outside?.(ref);
    } catch (error) {
      return fail(item.ref.id, `${row.to} could not be read back through the host's filter: ${messageOf(error)}`);
    }
    if (why) return fail(item.ref.id, `${row.to} ${why} No old Item was closed. Change the filter (or the components new Items get) so new issues fall within it, then Connect again: the issues made so far are found again, not made twice`);
  }

  // 2. References to moved Items, rewritten in every moved Item whose text names one (an earlier one's issue too).
  const mentions = (item: WorkItem): boolean => {
    const { body, verification } = text(item);
    const others = new Map([...names].filter(([id]) => id !== item.ref.id));
    return rewriteIds(`${body}\n${verification}`, others) !== `${body}\n${verification}`;
  };
  const rewrite = async (item: WorkItem, ref: Ref): Promise<void> => {
    const { body, verification } = text(item);
    await write.editWork!(ref, { body: `${rewriteIds(body, names)}\n\n${movedMarker(item.ref.id)}`.trim(), ...(verification ? { verification: rewriteIds(verification, names) } : {}) });
  };
  for (const item of items) {
    if (!mentions(item)) continue;
    try {
      await rewrite(item, made.get(item.ref.id)!);
      rowOf(item).did.push("linked");
    } catch (error) {
      return fail(item.ref.id, messageOf(error));
    }
  }
  const newly = new Set(items.map((item) => item.ref.id));
  for (const item of earlier) {
    const name = names.get(item.ref.id);
    const { body, verification } = text(item);
    const namesNew = [...newly].some((id) => rewriteIds(`${body}\n${verification}`, new Map([[id, "\u0000"]])) !== `${body}\n${verification}`);
    if (!name || !namesNew) continue;
    try {
      await rewrite(item, { host: to.info.id, kind: "work", id: kind === "github" ? name.replace(/^#/, "") : name });
    } catch (error) {
      return fail(item.ref.id, messageOf(error));
    }
  }

  // 3. The history, and the `moved` line that says it went.
  for (const item of items) {
    if (movedTo(item) === names.get(item.ref.id)) continue;
    try {
      await write.comment(made.get(item.ref.id)!, historyComment(item));
      await from.appendLog(item.ref, { kind: "moved", by, fields: { to: names.get(item.ref.id), host: kind } });
      rowOf(item).did.push("history");
    } catch (error) {
      return fail(item.ref.id, messageOf(error));
    }
  }

  // 4. The old Items closed, last.
  const blocked = options.beforeClose?.();
  if (blocked) return fail(items[0]?.ref.id ?? "", `${blocked} No old Item was closed; Connect again finishes it`);
  for (const item of items) {
    if (item.state === "abandoned" || item.state === "done") continue;
    try {
      await from.editWork(item.ref, { state: "abandoned" });
      rowOf(item).did.push("closed");
    } catch (error) {
      return fail(item.ref.id, messageOf(error));
    }
  }
  return report;
}

/** The report in words, one line per Item. */
export function moveLines(report: MoveReport): string[] {
  const lines = report.rows.map((row) => `${row.id} "${row.title}": ${row.to ? `${row.to} (${row.did.join(", ") || "nothing to do"})` : "not moved"}`);
  if (report.failed) lines.push(`Stopped at ${report.failed.id}: ${report.failed.message}. Connect again with the same Items to finish; nothing is made twice.`);
  return lines;
}
