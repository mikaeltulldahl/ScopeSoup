// Scope Soup's own conventions on Jira (issue #6, the mapping decided there): what GitHub keeps in a hidden marker line is a property.
// - question, answer, draft, assumption, merged: a comment with a short visible first line, and the marker's data in the comment
//   property `scopesoup` (`{ v: 1, kind, ...data }`).
// - an agent's hold: the issue property `scopesoup.claim`; a person's hold is the assignee.
// - the log: the issue property `scopesoup.log`; Accept and Overturn verdicts: the issue property `scopesoup.overturns`.
// - needs-decision: the label `scopesoup-needs-decision`; a follow-up: an issue link, and `scopesoup.followUp` to find it again.
//
// The trust rule, as on GitHub: a comment property counts only on a comment whose author is the token's own account (Jira lets only
// a comment's author and admins edit it and its properties); an answer, and an `A1:` reply, also from any person who can comment
// on the issue. Issue properties carry no author: they count only when their `by` is the token's own account, and whoever may edit
// the issue may change them (as a GitHub collaborator may edit Scope Soup's comment).
//
// The thread logic itself (numbering, `An:` replies, drafts waiting, claims, verdicts) is the GitHub conventions' own: each Jira
// comment is shown to it as a GitHub comment whose marker line is built from its property. Pure.

import type { Actor, Assumption, Ref, WorkItem } from "../../model/types.ts";
import type { AssumptionVerdict, MarkerKind, Thread } from "../github/conventions.ts";
import { applyThread, claimActor, liveClaims, readMarker, readThread, writeMarker } from "../github/conventions.ts";
import type { RestComment } from "../github/rest.ts";
import type { JiraThread, JiraThreadComment } from "./adapter.ts";

/** The comment property holding a Scope Soup comment's data. */
export const COMMENT_PROPERTY = "scopesoup";
export const CLAIM_PROPERTY = "scopesoup.claim";
export const LOG_PROPERTY = "scopesoup.log";
export const OVERTURNS_PROPERTY = "scopesoup.overturns";
export const FOLLOW_UP_PROPERTY = "scopesoup.followUp";
/** Jira's limit of one property's value, in bytes of JSON [docs: entity properties, 32 KB]. */
export const PROPERTY_LIMIT = 32_768;

const COMMENT_KINDS = new Set<string>(["question", "answer", "draft", "assumption", "merged"]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The JSON size of a property value, in bytes. */
export const propertySize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * A body the GitHub conventions build (visible Markdown, a blank line, the marker line) split for Jira: the visible Markdown,
 * and the comment property with the marker's kind and data.
 */
export function splitMarked(body: string): { markdown: string; property: Record<string, unknown> } {
  const marker = readMarker(body);
  if (!marker) throw new Error("A Scope Soup comment body without its marker.");
  const lines = body.trimEnd().split("\n");
  return { markdown: lines.slice(0, -1).join("\n").trim(), property: { ...marker.data, v: 1, kind: marker.kind } };
}

/** One claim in `scopesoup.claim`. */
export interface JiraClaim {
  machine: string;
  until: string;
  released: boolean;
}

/** An issue property's value counts when it is an object, version 1, written by the token's own account. */
function ownProperty(value: unknown, self: string | null): Record<string, unknown> | null {
  if (!isObject(value) || value.v !== 1 || self === null) return null;
  return str(value.by).toLowerCase() === self ? value : null;
}

/** The claims of a `scopesoup.claim` value, in the order they were written. */
export function claimsOf(value: unknown, self: string | null): JiraClaim[] {
  const own = ownProperty(value, self);
  const out: JiraClaim[] = [];
  for (const each of Array.isArray(own?.claims) ? own.claims : []) {
    if (!isObject(each)) continue;
    const machine = str(each.machine);
    const until = str(each.until);
    if (machine && until && !Number.isNaN(Date.parse(until))) out.push({ machine, until, released: each.released === true });
  }
  return out;
}

/** The verdicts of `scopesoup.overturns`, by the assumption comment's id. */
export function verdictsOf(value: unknown, self: string | null): Record<string, unknown[]> {
  const own = ownProperty(value, self);
  const out: Record<string, unknown[]> = {};
  if (own && isObject(own.verdicts)) for (const [id, list] of Object.entries(own.verdicts)) if (Array.isArray(list)) out[id] = list;
  return out;
}

/** What one read of an issue's comments and properties says, for the reads and the writes. */
export interface JiraRead {
  thread: Thread;
  /** The comments as the GitHub conventions saw them (marker line from the property). */
  comments: RestComment[];
  /** Scope Soup's comment data, by comment id: only of comments the trust rule lets count. */
  data: Map<string, Record<string, unknown>>;
  /** The trusted value of `scopesoup.log`, as written (lines, dropped, asked, deleted). */
  log: Record<string, unknown> | null;
  claims: JiraClaim[];
  verdicts: Record<string, unknown[]>;
  followUp: { item: string; sha: string } | null;
}

// Synthetic comment ids for the issue properties: below any comment id, the log first, then the claims in order.
const LOG_ID = -2_000_000;
const CLAIM_ID = -1_000_000;

const trustedAuthor = (comment: JiraThreadComment, self: string | null, kind: string): boolean =>
  self !== null && (comment.author.id.toLowerCase() === self || (kind === "answer" && !comment.author.bot));

/**
 * The thread of one issue. `self` is the token's own account id (Cloud) or user name (Data Center), lower case; null when it is
 * not known, and then nothing but people's answers counts. `host` is the host id the refs carry.
 */
export function readJiraThread(host: string, subject: Ref, jira: JiraThread, self: string | null): JiraRead {
  const verdicts = verdictsOf(jira.properties[OVERTURNS_PROPERTY], self);
  const data = new Map<string, Record<string, unknown>>();
  const comments: RestComment[] = [];
  for (const comment of [...jira.comments].sort((a, b) => Number(a.id) - Number(b.id))) {
    const user = { login: comment.author.id.toLowerCase() };
    // Any person who can comment may answer (an `A1:` reply or an answer); an app other than Scope Soup's account may not.
    const association = comment.author.bot ? "NONE" : "MEMBER";
    const property = comment.properties[COMMENT_PROPERTY];
    const kind = isObject(property) && property.v === 1 ? str(property.kind) : "";
    if (COMMENT_KINDS.has(kind) && trustedAuthor(comment, self, kind)) {
      const { kind: _kind, text, ...rest } = property as Record<string, unknown>;
      data.set(comment.id, property as Record<string, unknown>);
      if (kind === "assumption" && verdicts[comment.id]) rest.settled = verdicts[comment.id];
      // The draft's proposed text is kept in its property; GitHub's reader takes it from the visible `<details>`.
      const visible = kind === "draft" ? `<details><summary>Draft</summary>\n\n${str(text)}\n\n</details>` : "";
      comments.push({ id: Number(comment.id), body: `${visible}\n\n${writeMarker(kind as MarkerKind, rest)}`, user, created_at: comment.created, author_association: association });
      continue;
    }
    // A plain comment: its text, for `A1:` replies. Read from ADF or wiki text, it cannot hold a marker line, but make sure.
    const body = readMarker(comment.markdown) ? `${comment.markdown}\n` + "​" : comment.markdown;
    comments.push({ id: Number(comment.id), body, user, created_at: comment.created, author_association: association });
  }
  const selfUser = { login: self ?? "" };
  const log = ownProperty(jira.properties[LOG_PROPERTY], self);
  if (log) {
    const { v: _v, by: _by, ...rest } = log;
    comments.push({ id: LOG_ID, body: writeMarker("log", rest), user: selfUser, created_at: "" });
  }
  const claims = claimsOf(jira.properties[CLAIM_PROPERTY], self);
  claims.forEach((claim, index) => {
    comments.push({ id: CLAIM_ID + index, body: writeMarker("claim", { ...claim }), user: selfUser, created_at: "" });
  });
  const thread = readThread(subject, comments, self);
  // The GitHub reader names the host of an overturn's Item "github".
  thread.assumptions = thread.assumptions.map((each): Assumption => (each.settled?.item ? { ...each, settled: { ...each.settled, item: { ...each.settled.item, host } } } : each));
  const follow = ownProperty(jira.properties[FOLLOW_UP_PROPERTY], self);
  const followUp = follow && str(follow.item) ? { item: str(follow.item), sha: str(follow.sha) } : null;
  return { thread, comments: comments.filter((comment) => comment.id > 0), data, log, claims, verdicts, followUp };
}

/** The hidden mark of a follow-up Item, as the orchestrator writes it at the end of the Item's text (`followUpMark`). */
const FOLLOW_UP_MARK = /\n*<!-- scopesoup:follow-up (\{[^\n]*\}) -->\s*$/;

/** A follow-up's mark at the end of a new Item's text: the text without it, and what it names. Jira keeps it in a link and a property. */
export function takeFollowUpMark(body: string): { body: string; followUp?: { item: string; sha: string } } {
  const match = FOLLOW_UP_MARK.exec(body);
  if (!match?.[1]) return { body };
  try {
    const data = JSON.parse(match[1]) as unknown;
    if (isObject(data) && str(data.item)) return { body: body.slice(0, match.index).trimEnd(), followUp: { item: str(data.item), sha: str(data.sha) } };
  } catch {
    // Not a mark: the text as it is.
  }
  return { body };
}

const followUpMarkOf = (followUp: { item: string; sha: string }): string => `<!-- scopesoup:follow-up ${JSON.stringify({ item: followUp.item, sha: followUp.sha })} -->`;

/**
 * Sets the item's questions, answers, decisions, record and `needsDecision` from its thread, as on GitHub. A live agent claim
 * holds an open (todo or doing) issue, shown as doing; an assignee (a person's hold) stays the holder. A `merged` marker on an
 * issue that is no longer done was reopened. A follow-up gets its mark back in its text, so the orchestrator knows it.
 */
export function applyJiraThread(item: WorkItem, read: JiraRead, bodyKnown: (sha: string) => boolean, now: number): WorkItem {
  const open = item.state === "todo" || item.state === "doing";
  const claim = liveClaims(read.thread.claims, now)[0];
  if (claim && open) {
    if (!item.holder) item.holder = { actor: claimActor(claim.machine) as Actor, until: claim.until };
    if (item.state === "todo") item.state = "doing";
  }
  applyThread(item, read.thread, bodyKnown, now);
  if (item.merged && open) item.merged.reopened = item.updatedAt || new Date(now).toISOString();
  if (item.state === "abandoned") {
    const duplicate = read.thread.log?.lines.filter((line) => line.kind === "duplicate" && str(line.fields.of)).pop();
    if (duplicate) item.duplicateOf = { host: item.ref.host, kind: "work", id: str(duplicate.fields.of) };
  }
  if (read.followUp) item.body = `${item.body ? `${item.body}\n\n` : ""}${followUpMarkOf(read.followUp)}`;
  return item;
}

/** A trusted verdict list of one assumption comment, as `readVerdicts` reads it. */
export type Verdicts = AssumptionVerdict[];
