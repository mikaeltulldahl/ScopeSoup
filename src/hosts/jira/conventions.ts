// Scope Soup's own conventions on Jira (issue #6, the mapping decided there): what GitHub keeps in a hidden marker line is a property.
// - question, answer, draft, assumption, merged: a comment with a short visible first line, and the marker's data in the comment
//   property `scopesoup` (`{ v: 1, kind, ...data }`).
// - an agent's hold: the issue property `scopesoup.claim`; a person's hold is the assignee.
// - the log: the issue property `scopesoup.log`; Accept and Overturn verdicts: the issue property `scopesoup.overturns`.
// - needs-decision: the label `scopesoup-needs-decision`; a follow-up: an issue link, and `scopesoup.followUp` to find it again.
// - a person's hand-back (`scopesoup item handback`): a comment whose property (`kind: "handback"`) names the Item's branch and its
//   tip. Scope Soup's `revision` log line that adopts it names the comment (`handback`), which supersedes it and every earlier one.
//
// The trust rule, as on GitHub: a comment property counts only on a comment whose author is the token's own account (Jira lets only
// a comment's author and admins edit it and its properties); an answer, and an `A1:` reply, also from any person who can comment
// on the issue. A hand-back counts from the token's own account, or (`handbackFrom`) from the person who was the assignee when
// they posted it or one named in `answerers`: it moves more than an answer, so not from any person of the project. Issue properties
// carry no author: they count only when their `by` is the token's own account, and whoever may edit the issue may change them (as a
// GitHub collaborator may edit Scope Soup's comment).
//
// The thread logic itself (numbering, `An:` replies, drafts waiting, claims, verdicts) is the GitHub conventions' own: each Jira
// comment is shown to it as a GitHub comment whose marker line is built from its property. Pure.

import { ITEM_BRANCH_PREFIX } from "../../model/people.ts";
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
/** The comment property kind of a person's hand-back. */
export const HANDBACK_KIND = "handback";
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

/** One claim in `scopesoup.claim`: `at` is when it was first written and `nonce` tells two writes of one machine apart. */
export interface JiraClaim {
  machine: string;
  until: string;
  released: boolean;
  at: string;
  nonce: string;
}

/**
 * The longest a claim read from Jira may last from now: twice the orchestrator's claim expiry (`CLAIM_EXPIRY_MINUTES`, 120). An
 * issue property can be edited by anyone who may edit the issue, so a forged `until` far ahead holds the issue no longer than this.
 */
export const MAX_CLAIM_MS = 2 * 120 * 60_000;

/** The earliest claim first (by `at`, then `nonce`): the one that stands among the live ones. */
export const claimOrder = (a: JiraClaim, b: JiraClaim): number => a.at.localeCompare(b.at) || a.nonce.localeCompare(b.nonce);

/** An issue property's value counts when it is an object, version 1, written by the token's own account. */
function ownProperty(value: unknown, self: string | null): Record<string, unknown> | null {
  if (!isObject(value) || value.v !== 1 || self === null) return null;
  return str(value.by).toLowerCase() === self ? value : null;
}

/**
 * The claims of a `scopesoup.claim` value, earliest first, each `until` capped at `MAX_CLAIM_MS` from `now`. `anyone`: whoever
 * wrote it (a person's item commands, whose token is not the server's: a forged claim only makes them wait).
 */
export function claimsOf(value: unknown, self: string | null, now: number, anyone = false): JiraClaim[] {
  const own = anyone ? (isObject(value) && value.v === 1 ? value : null) : ownProperty(value, self);
  const out: JiraClaim[] = [];
  for (const each of Array.isArray(own?.claims) ? own.claims : []) {
    if (!isObject(each)) continue;
    const machine = str(each.machine);
    const until = str(each.until);
    if (!machine || !until || Number.isNaN(Date.parse(until))) continue;
    const capped = Math.min(Date.parse(until), now + MAX_CLAIM_MS);
    out.push({ machine, until: capped === Date.parse(until) ? until : new Date(capped).toISOString(), released: each.released === true, at: str(each.at), nonce: str(each.nonce) });
  }
  return out.sort(claimOrder);
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
  /** People's hand-backs of this Item's own branch, oldest first, from whom `readJiraThread` lets them count. */
  handbacks: JiraHandback[];
}

export interface JiraHandback {
  /** The comment's id. */
  id: string;
  by: Actor;
  at: string;
  sha: string;
  branch: string;
  note?: string;
}

// Synthetic comment ids for the issue properties: below any comment id, the log first, then the claims in order.
const LOG_ID = -2_000_000;
const CLAIM_ID = -1_000_000;

/**
 * Who may answer besides Scope Soup's own account: a person who belongs to the project (`mayAnswer`: the project's assignable
 * users, or the configured `answerers`), never an app.
 */
const mayAnswerAs = (comment: JiraThreadComment, mayAnswer: (id: string) => boolean): boolean => !comment.author.bot && mayAnswer(comment.author.id.toLowerCase());

const trustedAuthor = (comment: JiraThreadComment, self: string | null, kind: string, mayAnswer: (id: string) => boolean): boolean =>
  self !== null && (comment.author.id.toLowerCase() === self || (kind === "answer" && mayAnswerAs(comment, mayAnswer)));

/**
 * The thread of one issue. `self` is the token's own account id (Cloud) or user name (Data Center), lower case; null when it is
 * not known, and then nothing but people's answers counts. `host` is the host id the refs carry. `mayAnswer` says, for a lower-case
 * account id or user name, whether that person's answers and `A1:` replies count. `now` caps the claims (`MAX_CLAIM_MS`).
 */
export interface ReadOptions {
  /** An agent's claim counts whoever wrote `scopesoup.claim` (a person's item commands, `claimsOf`). */
  claimsOfAnyone?: boolean;
  /** Whether a hand-back comment by someone other than the token's own account counts. Default: none does. */
  handbackFrom?: (comment: JiraThreadComment) => boolean;
}

/** The branch a hand-back of the issue must name: its own item branch (`workBranch` of a Jira key, which needs no escaping). */
export const handbackBranch = (subject: Ref): string => `${ITEM_BRANCH_PREFIX}${subject.id}`;

export function readJiraThread(host: string, subject: Ref, jira: JiraThread, self: string | null, mayAnswer: (id: string) => boolean, now: number, options: ReadOptions = {}): JiraRead {
  const verdicts = verdictsOf(jira.properties[OVERTURNS_PROPERTY], self);
  const data = new Map<string, Record<string, unknown>>();
  const comments: RestComment[] = [];
  const handbacks: JiraHandback[] = [];
  for (const comment of [...jira.comments].sort((a, b) => Number(a.id) - Number(b.id))) {
    const user = { login: comment.author.id.toLowerCase() };
    // A person of the project may answer (an `A1:` reply or an answer, a draft's decision too); anyone else's is a plain comment.
    const association = mayAnswerAs(comment, mayAnswer) ? "MEMBER" : "NONE";
    const property = comment.properties[COMMENT_PROPERTY];
    const kind = isObject(property) && property.v === 1 ? str(property.kind) : "";
    // A hand-back of this issue's own branch counts from the token's own account, or as `handbackFrom` says (never an app's); its
    // comment reads as a plain one besides.
    const handback = kind === HANDBACK_KIND ? (property as Record<string, unknown>) : null;
    const fromWhom = self !== null && user.login === self ? true : !comment.author.bot && options.handbackFrom?.(comment) === true;
    if (handback && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(str(handback.sha)) && str(handback.branch) === handbackBranch(subject) && fromWhom) {
      const note = str(handback.note);
      handbacks.push({ id: comment.id, by: comment.author, at: comment.created, sha: str(handback.sha), branch: str(handback.branch), ...(note ? { note } : {}) });
    }
    if (COMMENT_KINDS.has(kind) && trustedAuthor(comment, self, kind, mayAnswer)) {
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
  const claims = claimsOf(jira.properties[CLAIM_PROPERTY], self, now, options.claimsOfAnyone === true);
  claims.forEach((claim, index) => {
    comments.push({ id: CLAIM_ID + index, body: writeMarker("claim", { machine: claim.machine, until: claim.until, released: claim.released }), user: selfUser, created_at: "" });
  });
  const thread = readThread(subject, comments, self);
  // The GitHub reader names the host of an overturn's Item "github".
  thread.assumptions = thread.assumptions.map((each): Assumption => (each.settled?.item ? { ...each, settled: { ...each.settled, item: { ...each.settled.item, host } } } : each));
  const follow = ownProperty(jira.properties[FOLLOW_UP_PROPERTY], self);
  const followUp = follow && str(follow.item) ? { item: str(follow.item), sha: str(follow.sha) } : null;
  return { thread, comments: comments.filter((comment) => comment.id > 0), data, log, claims, verdicts, followUp, handbacks };
}

/**
 * A new Item's text without any follow-up mark (`<!-- scopesoup:follow-up ... -->`). Jira keeps a follow-up in a link and a
 * property, taken only from `NewWork.followUpOf`; a mark in the text could have come from an agent, so it is dropped, never read.
 */
export const withoutFollowUpMarks = (body: string): string => body.replace(/\n*<!--\s*scopesoup:follow-up[\s\S]*?-->/g, "").trim();

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
  // A person's newest hand-back, unless Scope Soup adopted it or a later one: its `revision` line names the comment it took on.
  // Comment ids only grow, so no clock is compared.
  const adopted = Math.max(0, ...(read.thread.log?.lines ?? []).filter((line) => line.kind === "revision").map((line) => Number(str(line.fields.handback)) || 0));
  const handback = read.handbacks.at(-1);
  if (handback && open && Number(handback.id) > adopted) item.handedBack = { id: handback.id, sha: handback.sha, branch: handback.branch, by: handback.by, at: handback.at, ...(handback.note ? { note: handback.note } : {}) };
  if (read.followUp) item.body = `${item.body ? `${item.body}\n\n` : ""}${followUpMarkOf(read.followUp)}`;
  return item;
}

/** A trusted verdict list of one assumption comment, as `readVerdicts` reads it. */
export type Verdicts = AssumptionVerdict[];
