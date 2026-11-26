// Writing `item.md` and log lines. Pure. Everything that goes into a file comes from people and
// agents, so a value is either written so that the reader in item.ts and log.ts reads back exactly
// that value, or refused. Nothing here is ever a path or a git argument.

import { isDeepStrictEqual } from "node:util";
import { PRIORITIES, isPriority } from "../../model/priority.ts";
import { cleanVote } from "../../model/vote.ts";
import type { Priority, WorkState } from "../../model/types.ts";
import { isItemId } from "./ids.ts";
import type { ItemFields } from "./item.ts";
import { WORK_STATES, parseItem } from "./item.ts";
import { MAX_FILE_BYTES, MAX_LINE_BYTES } from "./limits.ts";
import { foldLog, isLogTime, parseLog } from "./log.ts";

/** The text as it will be read back from the file: its UTF-8 bytes decoded again. A lone surrogate comes back as U+FFFD. */
const throughBytes = (text: string): string => Buffer.from(text, "utf8").toString("utf8");

export class RefusedWrite extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedWrite";
  }
}

const refuse = (message: string): never => {
  throw new RefusedWrite(message);
};

/**
 * Control characters end a header line, or hide in it. A tab is one too: the header is one line of
 * plain text. U+2028 and U+2029 end a line for the reader's pattern (its `.` does not match them).
 */
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const KNOWN_KEYS = new Set(["id", "title", "state", "labels", "parent", "blockedBy", "duplicateOf", "verification", "priority", "vote"]);
const KEY = /^[A-Za-z][A-Za-z0-9]*$/;

/** What a person or an agent gives for an item, before it is put in canonical form. */
export interface ItemInput {
  title: string;
  state?: WorkState;
  labels?: string[];
  parent?: string;
  blockedBy?: string[];
  duplicateOf?: string;
  verification?: string;
  priority?: Priority;
  vote?: number;
  body?: string;
  extra?: [string, string][];
}

const show = (value: string): string => JSON.stringify(value.length > 60 ? `${value.slice(0, 59)}…` : value);

function headerValue(name: string, value: string, required: boolean): void {
  if (required && value === "") refuse(`The ${name} is empty.`);
  if (CONTROL.test(value)) refuse(`The ${name} ${show(value)} holds a line break or another control character; a header value is one line.`);
  if (value !== value.trim()) refuse(`The ${name} ${show(value)} starts or ends with white space, which the reader would drop.`);
}

/** The description as the reader gives it back: `\n` line ends, no blank lines before it, nothing after it. */
function canonicalBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/^\s*\n/, "").trimEnd();
}

/**
 * Puts what a person typed in the form the reader gives back: values trimmed, the description's
 * line ends made `\n` and the blank lines around it dropped, empty labels dropped. Refuses what
 * cannot be written (a line break in a title, an id that is not one).
 */
export function canonicalItem(input: ItemInput): ItemFields {
  const fields: ItemFields = {
    title: input.title.trim(),
    state: input.state ?? "todo",
    labels: (input.labels ?? []).map((label) => label.trim()).filter((label) => label !== ""),
    blockedBy: (input.blockedBy ?? []).map((id) => id.trim()).filter((id) => id !== ""),
    body: canonicalBody(input.body ?? ""),
    extra: (input.extra ?? []).map(([key, value]): [string, string] => [key, value.trim()]),
  };
  const parent = input.parent?.trim();
  if (parent) fields.parent = parent;
  const duplicateOf = input.duplicateOf?.trim();
  if (duplicateOf) fields.duplicateOf = duplicateOf;
  const verification = input.verification?.trim();
  if (verification) fields.verification = verification;
  if (input.priority) fields.priority = input.priority;
  if (input.vote) fields.vote = input.vote;
  checkFields(fields);
  return fields;
}

/** Refuses fields the reader would not give back unchanged. */
export function checkFields(fields: ItemFields): void {
  // A lone surrogate cannot be stored as UTF-8: it would come back as U+FFFD.
  const texts = [fields.title, fields.body, fields.verification ?? "", ...fields.labels, ...fields.extra.flat()];
  if (texts.some((text) => throughBytes(text) !== text)) refuse("The item holds text that is not valid Unicode (a lone surrogate); it would not read back as written.");
  headerValue("title", fields.title, true);
  if (!(WORK_STATES as readonly string[]).includes(fields.state)) refuse(`The state ${show(String(fields.state))} is not one of ${WORK_STATES.join(", ")}.`);
  for (const label of fields.labels) {
    headerValue("label", label, true);
    if (/[,[\]]/.test(label)) refuse(`The label ${show(label)} holds a comma or a bracket, which the list syntax would split or drop.`);
  }
  if (fields.parent !== undefined && !isItemId(fields.parent)) refuse(`The parent ${show(fields.parent)} is not an item id.`);
  for (const id of fields.blockedBy) if (!isItemId(id)) refuse(`blockedBy ${show(id)} is not an item id.`);
  if (fields.duplicateOf !== undefined && !isItemId(fields.duplicateOf)) refuse(`duplicateOf ${show(fields.duplicateOf)} is not an item id.`);
  if (fields.verification !== undefined) headerValue("verification", fields.verification, true);
  if (fields.priority !== undefined && !isPriority(fields.priority)) refuse(`The priority ${show(String(fields.priority))} is not one of ${PRIORITIES.join(", ")}.`);
  if (fields.vote !== undefined && (fields.vote === 0 || cleanVote(fields.vote) !== fields.vote || Math.abs(fields.vote) >= 1e9)) refuse(`The vote ${show(String(fields.vote))} is not a number of points with at most 2 decimals (0 is left out).`);
  const keys = new Set<string>();
  for (const [key, value] of fields.extra) {
    if (!KEY.test(key)) refuse(`The header key ${show(key)} is not a letter followed by letters and digits.`);
    if (KNOWN_KEYS.has(key) || keys.has(key)) refuse(`The header key "${key}" would appear twice.`);
    keys.add(key);
    headerValue(`value of "${key}"`, value, false);
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(fields.body)) refuse("The description holds a control character other than a tab or a line break.");
  if (fields.body !== canonicalBody(fields.body)) refuse("The description has blank lines around it or \\r line ends, which the reader would drop.");
}

/** The text of `items/<id>/item.md` for these fields. It reads back as exactly these fields, or this refuses. */
export function serializeItem(id: string, fields: ItemFields): string {
  if (!isItemId(id)) refuse(`${show(id)} is not an item id.`);
  checkFields(fields);
  const header = ["---", `id: ${id}`, `title: ${fields.title}`, `state: ${fields.state}`];
  if (fields.labels.length > 0) header.push(`labels: ${fields.labels.join(", ")}`);
  if (fields.parent) header.push(`parent: ${fields.parent}`);
  if (fields.blockedBy.length > 0) header.push(`blockedBy: ${fields.blockedBy.join(", ")}`);
  if (fields.duplicateOf) header.push(`duplicateOf: ${fields.duplicateOf}`);
  if (fields.verification) header.push(`verification: ${fields.verification}`);
  if (fields.priority) header.push(`priority: ${fields.priority}`);
  if (fields.vote) header.push(`vote: ${fields.vote}`);
  for (const [key, value] of fields.extra) header.push(value === "" ? `${key}:` : `${key}: ${value}`);
  header.push("---");
  const text = fields.body === "" ? `${header.join("\n")}\n` : `${header.join("\n")}\n\n${fields.body}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) refuse(`item.md would be over ${MAX_FILE_BYTES} bytes, which the reader does not read.`);
  // A lone surrogate cannot be stored as UTF-8: it would come back as U+FFFD.
  if (throughBytes(text) !== text) refuse("The item holds text that is not valid Unicode (a lone surrogate); it would not read back as written.");
  // Belt and braces: the reader is the judge of what was written, as it will read the bytes.
  const back = parseItem(throughBytes(text), id);
  if (!back.ok || !isDeepStrictEqual(back.fields, fields)) refuse("The item would not read back as written.");
  return text;
}

// --- log lines ---

/** Who writes a line. Writers always name the machine. */
export interface LineAuthor {
  who: string;
  machine: string;
  agent: boolean;
}

export interface LineInput {
  at: string;
  by: LineAuthor;
  kind: string;
  /** The kind's own fields (docs/DESIGN.md). Not `at`, `by` or `kind`. */
  fields?: Record<string, unknown>;
}

const NAME = /^[^\u0000-\u001f\u007f]{1,100}$/;
const KIND = /^[a-z][a-z0-9_-]{0,39}$/;

/** A time as writers write it: UTC, `Z`, whole seconds unless the time has milliseconds. */
export function writerTime(value: string): string {
  if (!isLogTime(value)) refuse(`${show(value)} is not an ISO 8601 time with a zone.`);
  return new Date(value).toISOString().replace(".000Z", "Z");
}

/** One line of `log.jsonl`, without its line end. It reads back as an entry with no problem, or this refuses. */
export function serializeLogLine(input: LineInput): string {
  const { who, machine, agent } = input.by;
  if (typeof who !== "string" || !NAME.test(who)) refuse("`by.who` must be 1 to 100 characters with no control characters.");
  if (typeof machine !== "string" || !NAME.test(machine)) refuse("`by.machine` must be 1 to 100 characters with no control characters.");
  if (typeof agent !== "boolean") refuse("`by.agent` must be true or false.");
  if (typeof input.kind !== "string" || !KIND.test(input.kind)) refuse(`The kind ${show(String(input.kind))} is not a short lower-case word.`);
  const fields = input.fields ?? {};
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) refuse("A line's fields must be an object.");
  for (const key of ["at", "by", "kind"]) if (Object.hasOwn(fields, key)) refuse(`A line's fields may not set \`${key}\`.`);
  const data: Record<string, unknown> = { at: writerTime(input.at), by: { who, machine, agent }, kind: input.kind };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    // Writers write times in UTC (docs/DESIGN.md, the fold, rule 6).
    data[key] = (key === "until" || key === "to") && isLogTime(value) ? writerTime(value) : value;
  }
  const line = JSON.stringify(data);
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) refuse(`The line would be over ${MAX_LINE_BYTES} bytes.`);
  // Only JSON values survive the file: a function, NaN or a Date would read back as something else.
  if (!isDeepStrictEqual(JSON.parse(throughBytes(line)), data)) refuse("The line's fields are not plain JSON values (strings, numbers, booleans, null, lists, objects).");
  const parsed = parseLog(throughBytes(line));
  const picture = foldLog(parsed);
  const problem = parsed.malformed[0]?.problem ?? picture.malformed[0]?.problem;
  if (problem !== undefined || parsed.entries.length !== 1) refuse(`The ${input.kind} line would be malformed: ${problem ?? "it does not read back as one line"}.`);
  return line;
}
