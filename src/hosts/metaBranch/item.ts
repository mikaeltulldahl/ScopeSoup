// `items/<id>/item.md`: a small header and the description. Pure parsing; the format is in
// docs/DESIGN.md ("Items on a meta branch"). The header is our own tiny format, not YAML.

import { PRIORITIES, isPriority } from "../../model/priority.ts";
import type { Priority, WorkState } from "../../model/types.ts";
import { isItemId } from "./ids.ts";

export interface ItemFields {
  title: string;
  state: WorkState;
  labels: string[];
  parent?: string;
  blockedBy: string[];
  /** With state `abandoned`: closed as a duplicate of this item. */
  duplicateOf?: string;
  verification?: string;
  priority?: Priority;
  /** The vote, a score offset in points, at most 2 decimals; absent is 0. */
  vote?: number;
  /** The description, markdown. Empty when there is none. */
  body: string;
  /** Header keys Scope Soup does not know, in file order. Kept so a writer can put them back. */
  extra: [string, string][];
}

export type ParsedItem = { ok: true; fields: ItemFields } | { ok: false; problems: string[] };

export const WORK_STATES: readonly WorkState[] = ["todo", "doing", "waiting", "done", "abandoned"];
const KNOWN = new Set(["id", "title", "state", "labels", "parent", "blockedBy", "duplicateOf", "verification", "priority", "vote"]);
const KEY_LINE = /^([A-Za-z][A-Za-z0-9]*):(.*)$/;

/** "a, b" and "[a, b]" both give ["a", "b"]. Empty entries are dropped. */
function list(value: string): string[] {
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return inner
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Reads one `item.md`. `dirId` is the id from the directory name and is what counts; a header `id`
 * must agree with it. Any problem makes the whole item malformed (the caller still shows it), so a
 * writer never has to round-trip a header it only half understood.
 */
export function parseItem(text: string, dirId: string): ParsedItem {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== "---") return { ok: false, problems: ["item.md does not start with a --- line"] };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { ok: false, problems: ["the header has no closing --- line"] };

  const problems: string[] = [];
  const header = new Map<string, string>();
  const extra: [string, string][] = [];
  for (let index = 1; index < end; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = KEY_LINE.exec(line);
    if (!match) {
      problems.push(`header line ${index + 1} is not "key: value"`);
      continue;
    }
    const key = match[1] as string;
    const value = (match[2] as string).trim();
    if (header.has(key) || extra.some(([seen]) => seen === key)) {
      problems.push(`header key "${key}" appears twice`);
      continue;
    }
    if (KNOWN.has(key)) header.set(key, value);
    else extra.push([key, value]);
  }

  const id = header.get("id");
  if (id !== undefined && id !== dirId) problems.push(`the header id "${id}" is not the directory's "${dirId}"`);
  const title = header.get("title") ?? "";
  if (!title) problems.push("the title is missing");
  const state = header.get("state") ?? "";
  if (!(WORK_STATES as readonly string[]).includes(state)) problems.push(state ? `the state "${state}" is not one of ${WORK_STATES.join(", ")}` : "the state is missing");
  const priority = header.get("priority");
  if (priority !== undefined && priority !== "" && !isPriority(priority)) problems.push(`the priority "${priority}" is not one of ${PRIORITIES.join(", ")}`);
  const voteText = header.get("vote");
  if (voteText !== undefined && voteText !== "" && !/^[+-]?\d{1,9}(\.\d{1,2})?$/.test(voteText)) problems.push(`the vote "${voteText}" is not a number of points with at most 2 decimals`);
  const parent = header.get("parent") ?? "";
  if (parent && !isItemId(parent)) problems.push(`the parent "${parent}" is not an item id`);
  const blockedBy = list(header.get("blockedBy") ?? "");
  for (const blocker of blockedBy) if (!isItemId(blocker)) problems.push(`blockedBy "${blocker}" is not an item id`);
  const duplicateOf = header.get("duplicateOf") ?? "";
  if (duplicateOf && !isItemId(duplicateOf)) problems.push(`duplicateOf "${duplicateOf}" is not an item id`);
  if (problems.length > 0) return { ok: false, problems };

  // The description: everything after the header, without the blank lines around it.
  const body = lines.slice(end + 1).join("\n").replace(/^\s*\n/, "").trimEnd();
  const fields: ItemFields = { title, state: state as WorkState, labels: list(header.get("labels") ?? ""), blockedBy, body, extra };
  if (parent) fields.parent = parent;
  if (duplicateOf) fields.duplicateOf = duplicateOf;
  const verification = header.get("verification");
  if (verification) fields.verification = verification;
  if (priority) fields.priority = priority as Priority;
  if (voteText && Number(voteText) !== 0) fields.vote = Number(voteText);
  return { ok: true, fields };
}
