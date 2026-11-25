// Moving Items from the meta branch to GitHub Issues or Jira, when the project connects to that host from Settings (#127,
// decision 95). Only the Items a person ticked move. Each becomes a new issue (title, description, verification, made inert) whose
// text ends with a marker line naming the old id, so a retry finds it and never makes it twice; references between moved Items
// are rewritten to the new ids; the Item's history goes to the new issue as one comment; the old Item gets a `moved` log line
// naming where it went and is closed (abandoned). Steps already done are not done again, except a history comment whose `moved`
// line was not written yet: a run cut off between the two posts it again.
// (`githubMove.ts` is the other way: GitHub issues imported into the meta branch.)

import type { Ref, WorkItem } from "../model/types.ts";
import type { Host, WritePort } from "../ports/host.ts";
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

/** Whole ids of the moved Items replaced by their new names; nothing else changes. */
export function rewriteIds(text: string, names: ReadonlyMap<string, string>): string {
  if (names.size === 0) return text;
  const ids = [...names.keys()].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(`(?<![A-Za-z0-9_-])(${ids.join("|")})(?![A-Za-z0-9_-])`, "g"), (id) => names.get(id) ?? id);
}

/** The history as one comment: one line per log line, oldest first, made inert. */
export function historyComment(item: WorkItem): string {
  const lines = (item.history ?? []).map((line) => `- ${line.at.slice(0, 16).replace("T", " ")} ${line.by.name}: ${line.text.replace(/\s+/g, " ").trim()}`);
  return inertMoved([`History of Item ${item.ref.id} on Scope Soup's meta branch, oldest first:`, "", ...(lines.length > 0 ? lines : ["(no lines)"])].join("\n"));
}

export interface MoveOptions {
  kind: "github" | "jira";
  /** The Items to move, as the store has them (with their history and log). */
  items: readonly WorkItem[];
  /** The meta branch host's writes: the `moved` line and the close. */
  from: Pick<WritePort, "appendLog" | "editWork">;
  /** The new host, with writes on. */
  to: Host;
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
  const by = { who: options.by, agent: false };
  const ids = new Set(items.map((item) => item.ref.id));
  const text = (item: WorkItem) => ({ body: inertMoved((item.body ?? "").trim()), verification: inertMoved((item.verification ?? "").trim()) });

  // 1. Find what an earlier run made (by the marker), make the rest.
  const made = new Map<string, Ref>();
  try {
    for (const work of (await to.work.listWork()).items) {
      for (const match of `${work.body ?? ""}\n${work.verification ?? ""}`.matchAll(MARKER)) {
        const id = match[1]!;
        const item = items.find((each) => each.ref.id === id);
        if (item && !made.has(id) && work.title.trim() === item.title.trim()) made.set(id, work.ref);
      }
    }
  } catch (error) {
    report.failed = { id: items[0]?.ref.id ?? "", message: `the new host's issues could not be read: ${messageOf(error)}` };
    return report;
  }
  for (const [index, item] of items.entries()) {
    const row = report.rows[index]!;
    const found = made.get(item.ref.id);
    if (found) {
      row.did.push("found");
      row.to = newName(kind, found);
      continue;
    }
    try {
      const { body, verification } = text(item);
      const done = await write.createWork({ title: item.title.trim(), body: `${body}\n\n${movedMarker(item.ref.id)}`.trim(), ...(verification ? { verification } : {}) });
      made.set(item.ref.id, done.work);
      row.did.push("created");
      row.to = newName(kind, done.work);
    } catch (error) {
      report.failed = { id: item.ref.id, message: messageOf(error) };
      return report;
    }
  }

  // 2. References between moved Items, rewritten to the new names; then the history and the old Item's close.
  const names = new Map([...made].map(([id, ref]) => [id, newName(kind, ref)]));
  for (const [index, item] of items.entries()) {
    const row = report.rows[index]!;
    const ref = made.get(item.ref.id)!;
    try {
      const { body, verification } = text(item);
      const mentions = [...ids].some((id) => id !== item.ref.id && rewriteIds(`${body}\n${verification}`, new Map([[id, "x"]])) !== `${body}\n${verification}`);
      if (mentions) {
        await write.editWork(ref, { body: `${rewriteIds(body, names)}\n\n${movedMarker(item.ref.id)}`.trim(), ...(verification ? { verification: rewriteIds(verification, names) } : {}) });
        row.did.push("linked");
      }
      const logged = (item.log ?? []).some((line) => line.kind === "moved" && line.fields.to === names.get(item.ref.id));
      if (!logged) {
        await write.comment(ref, historyComment(item));
        await from.appendLog(item.ref, { kind: "moved", by, fields: { to: names.get(item.ref.id), host: kind } });
        row.did.push("history");
      }
      if (item.state !== "abandoned" && item.state !== "done") {
        await from.editWork(item.ref, { state: "abandoned" });
        row.did.push("closed");
      }
    } catch (error) {
      report.failed = { id: item.ref.id, message: messageOf(error) };
      return report;
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
