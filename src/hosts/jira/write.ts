// The Jira host's write port, only with writes on: issues (create, summary, description, labels, priority, transitions, links,
// parent, assignee) and Scope Soup's conventions (conventions.ts): question, answer, draft and decision comments with their
// properties, the claim, log and verdict issue properties, and the needs-decision label. Every write is followed by a re-read
// that must show it, as on GitHub. Text reaching here is inert already (the orchestrator's `inertText`); it is converted to ADF
// or wiki markup that cannot mention, link a page or run a macro (toJira.ts).
// API details marked "unconfirmed" are from docs/research/jira.md's [known] marks: from memory, not yet checked on a real site.

import { createHash, randomUUID } from "node:crypto";
import { changeText } from "../../model/labels.ts";
import type { Priority, Ref } from "../../model/types.ts";
import type { AnswerWrite, WriteOutcome, WritePort } from "../../ports/host.ts";
import { AlreadyAnswered, BodyChanged, TooLarge, WriteLater } from "../../ports/host.ts";
import type { AssumptionEntry, LogKeep, LogLine } from "../github/conventions.ts";
import { answersBody, assumptionBody, clipLogFields, draftBody, mergedBody, nextQuestionNumber, questionBody, questionNumber, readVerdicts, waitsForAnswer, withdrawnBody } from "../github/conventions.ts";
import { spliceBody } from "../github/map.ts";
import type { JiraClient } from "./client.ts";
import { JiraError, transient } from "./client.ts";
import type { JiraClaim, JiraRead } from "./conventions.ts";
import { CLAIM_PROPERTY, claimOrder, COMMENT_PROPERTY, HANDBACK_KIND, LOG_PROPERTY, OVERTURNS_PROPERTY, PROPERTY_LIMIT, propertySize, splitMarked } from "./conventions.ts";
import { toJiraText, writeDescription } from "./description.ts";
import type { JiraScope } from "./map.ts";
import { ISSUE_FIELDS, isoTime, itemsJql, jqlString, NEEDS_DECISION_LABEL, priorityOf, projectOf, stateOf, workRef } from "./map.ts";
import type { JiraComment, JiraIssue } from "./rest.ts";

/** What Scope Soup moves an issue to: the workflow's transition is named per target in the configuration. */
export type TransitionTarget = "todo" | "doing" | "done" | "abandoned";

/** Jira's default names: the simplified workflow's transitions are named after the status they go to [known]. */
export const DEFAULT_TRANSITIONS: Readonly<Record<TransitionTarget, string>> = { todo: "To Do", doing: "In Progress", done: "Done", abandoned: "Won't Do" };
/** The resolution set by a transition whose screen asks for one. Jira's default names. */
export const DEFAULT_RESOLUTIONS: Readonly<Record<"done" | "abandoned" | "duplicate", string>> = { done: "Done", abandoned: "Won't Do", duplicate: "Duplicate" };
/** The issue type of a new Item and of a split's child. Jira's default names. */
export const DEFAULT_ISSUE_TYPE = "Task";
export const DEFAULT_CHILD_ISSUE_TYPE = "Sub-task";
/** The link type from a related part of a restructuring to its Item, and from a duplicate to its original. Jira's default names. */
export const DEFAULT_RELATES_LINK = "Relates";
export const DEFAULT_DUPLICATE_LINK = "Duplicate";
/**
 * About the most a comment Scope Soup posts may hold on Jira: Jira's default text field limit is 32,767 characters [known] (a site
 * admin can change it). Counted on the body as sent, the ADF's JSON or the wiki text (unconfirmed: what Jira counts; the JSON is the
 * larger, so this is on the safe side).
 */
export const JIRA_COMMENT_LIMIT = 32_000;

export interface JiraWriteSettings {
  issueType: string;
  childIssueType: string;
  transitions: Record<TransitionTarget, string>;
  resolutions: Record<"done" | "abandoned" | "duplicate", string>;
  relatesLink: string;
  duplicateLink: string;
  commentLimit: number;
  /** The component names new Items get. */
  components: string[];
}

export interface JiraWriteDeps {
  client: JiraClient;
  scope: JiraScope;
  settings: JiraWriteSettings;
  /** Called when an Item just created does not match the filter or the project read. */
  onOutsideFilter?(key: string, reason: string): void;
  /** This machine's name in claims; without it there is no claim. */
  machine?: string;
  /** The token's own account: Cloud's account id, Data Center's user name. */
  self(): Promise<string>;
  /** The issue's comments and properties as read now, through the trust rule. */
  read(ref: Ref): Promise<JiraRead>;
  /** Milliseconds since the epoch. */
  now(): number;
  /** Waits `ms`; injectable so tests do not wait. */
  sleep(ms: number): Promise<void>;
  /** How long a claim waits after its write before it reads who stands. Default 2 s. */
  claimSettleMs?: number;
  /** A fresh claim nonce; injectable for tests. */
  nonce?(): string;
}

interface JiraTransition {
  id: string;
  name: string;
  to?: { name?: string; statusCategory?: { key?: string } };
  /** With `expand=transitions.fields`: the fields its screen has [known]. */
  fields?: Record<string, { required?: boolean }>;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The hash of a description as Jira stores it (ADF as JSON, or wiki text): what a draft names as the body it read. */
export const descriptionSha = (description: unknown): string => sha256(typeof description === "string" ? description : JSON.stringify(description ?? null));

/** A failure that can change by itself becomes `WriteLater`, so the orchestrator tries the step again. */
const later = (error: unknown): unknown => (transient(error) ? new WriteLater(error instanceof Error ? error.message : String(error)) : error);

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The Jira name of a Scope Soup priority: the first name the configured map gives it. */
export function priorityName(scope: JiraScope, priority: Priority): string | undefined {
  return Object.entries(scope.priorities).find(([, value]) => value === priority)?.[0];
}

/** Whether an issue is an Item: in the project and the filter, asked of Jira (a search for its key). */
export async function issueInFilter(client: JiraClient, scope: JiraScope, key: string): Promise<boolean> {
  if (!scope.filter) return projectOf(key) === scope.project;
  const found = await client.search<JiraIssue>(`${itemsJql(scope)} AND key = ${jqlString(key)} ORDER BY updated ASC, key ASC`, ["summary"]);
  return found.some((issue) => issue.key === key);
}

export function createJiraWrite(deps: JiraWriteDeps): WritePort {
  const { client, scope, settings } = deps;
  const api = client.api;
  const deployment = scope.deployment;
  const path = (ref: Ref): string => `${api}/issue/${encodeURIComponent(ref.id)}`;
  const issueOf = (ref: Ref): Promise<JiraIssue> => client.get<JiraIssue>(`${path(ref)}?fields=${ISSUE_FIELDS.join(",")}`);

  const failIf = (ref: Ref, missed: string[]): void => {
    if (missed.length > 0) throw new Error(`Jira answered but did not apply it on ${ref.id} (${missed.join("; ")}).`);
  };

  const checkLabels = (names: string[]): void => {
    const bad = names.filter((name) => !name || /\s/.test(name));
    if (bad.length > 0) throw new Error(`Jira labels hold no spaces: ${bad.map((name) => `"${name}"`).join(", ")}.`);
  };

  /** Adds and removes labels, never replacing the set (`update.labels`), then the re-read. */
  async function changeIssueLabels(ref: Ref, add: string[], remove: string[]): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    checkLabels(add);
    await client.put(path(ref), { update: { labels: [...add.map((name) => ({ add: name })), ...remove.map((name) => ({ remove: name }))] } });
    const labels = (await issueOf(ref)).fields.labels ?? [];
    failIf(ref, [
      ...add.filter((name) => !labels.some((each) => same(each, name))).map((name) => `label ${name} not added`),
      ...remove.filter((name) => labels.some((each) => same(each, name))).map((name) => `label ${name} not removed`),
    ]);
  }

  const labelOn = (issue: JiraIssue, name: string): string | undefined => (issue.fields.labels ?? []).find((each) => same(each, name));

  async function addNeedsDecision(ref: Ref): Promise<void> {
    if (!labelOn(await issueOf(ref), NEEDS_DECISION_LABEL)) await changeIssueLabels(ref, [NEEDS_DECISION_LABEL], []);
  }

  async function settle(ref: Ref, read: JiraRead): Promise<void> {
    if (waitsForAnswer(read.thread)) return;
    const label = labelOn(await issueOf(ref), NEEDS_DECISION_LABEL);
    if (label) await changeIssueLabels(ref, [], [label]);
  }

  /** The comment over the host's limit, or a property over Jira's, is refused before anything is posted. */
  function checkSize(ref: Ref, what: string, markdown: string, property?: Record<string, unknown>): void {
    const sent = toJiraText(deployment, markdown);
    if ((typeof sent === "string" ? sent : JSON.stringify(sent)).length > settings.commentLimit) throw new TooLarge(`${what} on ${ref.id} is over ${settings.commentLimit} characters.`, settings.commentLimit);
    if (property && propertySize(property) > PROPERTY_LIMIT) throw new TooLarge(`${what} on ${ref.id} is over Jira's ${PROPERTY_LIMIT} bytes for a property.`, settings.commentLimit);
  }

  /**
   * A comment, then its property. The two are not one write: when the property fails the comment is deleted again (else it would
   * stay a plain comment), and the error goes on.
   */
  async function postComment(ref: Ref, markdown: string, property?: Record<string, unknown>): Promise<JiraComment> {
    const posted = await client.post<JiraComment>(`${path(ref)}/comment`, { body: toJiraText(deployment, markdown) });
    if (!posted?.id) throw new Error(`Jira took a comment on ${ref.id} but did not describe it.`);
    if (property) {
      try {
        await client.put(`${api}/comment/${encodeURIComponent(posted.id)}/properties/${COMMENT_PROPERTY}`, property);
      } catch (error) {
        try {
          await client.delete(`${path(ref)}/comment/${encodeURIComponent(posted.id)}`);
        } catch {
          // The comment stays, as a plain comment: the trust rule reads it as nothing.
        }
        throw error;
      }
    }
    return posted;
  }

  async function editComment(ref: Ref, id: string, markdown: string, property: Record<string, unknown>): Promise<void> {
    await client.put(`${path(ref)}/comment/${encodeURIComponent(id)}`, { body: toJiraText(deployment, markdown) });
    await client.put(`${api}/comment/${encodeURIComponent(id)}/properties/${COMMENT_PROPERTY}`, property);
  }

  async function putIssueProperty(ref: Ref, key: string, value: Record<string, unknown>): Promise<void> {
    if (propertySize(value) > PROPERTY_LIMIT) throw new Error(`${key} on ${ref.id} would be over Jira's ${PROPERTY_LIMIT} bytes for a property.`);
    await client.put(`${path(ref)}/properties/${encodeURIComponent(key)}`, value);
  }

  /** The log property with `lines`: over Jira's property limit the oldest lines are dropped and counted. */
  async function writeLog(ref: Ref, read: JiraRead, lines: LogLine[], keep: LogKeep): Promise<void> {
    const by = await deps.self();
    let kept = [...lines];
    let dropped = read.thread.log?.dropped ?? 0;
    const build = (): Record<string, unknown> => ({
      v: 1, by, lines: kept, dropped,
      ...(keep.asked > 0 ? { asked: keep.asked } : {}), ...(keep.deleted.length > 0 ? { deleted: keep.deleted } : {}),
    });
    let value = build();
    while (propertySize(value) > PROPERTY_LIMIT - 256 && kept.length > 1) {
      const cut = Math.max(1, Math.floor(kept.length / 10));
      kept = kept.slice(cut);
      dropped += cut;
      value = build();
    }
    await putIssueProperty(ref, LOG_PROPERTY, value);
  }

  const logLines = (read: JiraRead): LogLine[] => (read.thread.log?.lines ?? []).map(({ at, kind, fields }) => ({ at, kind, fields }));

  // --- transitions ---

  async function transitionTo(ref: Ref, target: TransitionTarget, resolution?: string): Promise<void> {
    const offered = (await client.get<{ transitions?: JiraTransition[] }>(`${path(ref)}/transitions?expand=transitions.fields`)).transitions ?? [];
    const name = settings.transitions[target];
    const category = target === "todo" ? "new" : target === "doing" ? "indeterminate" : "done";
    // The configured name first (the transition's own name, or the status it goes to), else any transition into the category.
    const found = offered.find((each) => same(each.name, name) || same(each.to?.name ?? "", name)) ?? offered.find((each) => each.to?.statusCategory?.key === category);
    if (!found) throw new Error(`Jira offers no transition of ${ref.id} to ${target} (looked for "${name}"; offered: ${offered.map((each) => `"${each.name}"`).join(", ") || "none"}). Name it in host.transitions.${target}.`);
    const fields = resolution && found.fields?.resolution ? { resolution: { name: resolution } } : undefined;
    await client.post(`${path(ref)}/transitions`, { transition: { id: found.id }, ...(fields ? { fields } : {}) });
  }

  // --- links ---

  /** The Blocks links of an issue whose other side blocks it: blocker key -> link id. */
  function blockerLinks(issue: JiraIssue): Map<string, { id: string; open: boolean }> {
    const found = new Map<string, { id: string; open: boolean }>();
    for (const link of issue.fields.issuelinks ?? []) {
      if (!same(link.type.name, scope.blocksLink) || !link.inwardIssue || !link.id) continue;
      found.set(link.inwardIssue.key, { id: link.id, open: link.inwardIssue.fields?.status?.statusCategory?.key !== "done" });
    }
    return found;
  }

  /**
   * A link "`from` <outward> `to`" (Blocks: `from` blocks `to`). Unconfirmed: the side each issue takes in the request (research
   * section 1); the re-read checks that the link reads as meant.
   */
  const link = (type: string, from: string, to: string): Promise<unknown> => client.post(`${api}/issueLink`, { type: { name: type }, inwardIssue: { key: to }, outwardIssue: { key: from } });

  /** Whether the issue has a link of this type to `other`, either way round. */
  function linkedTo(issue: JiraIssue, type: string, other: string): boolean {
    return (issue.fields.issuelinks ?? []).some((each) => same(each.type.name, type) && (each.inwardIssue?.key === other || each.outwardIssue?.key === other));
  }

  async function setBlockers(subject: Ref, wanted: Ref[], addOnly: boolean): Promise<void> {
    const have = blockerLinks(await issueOf(subject));
    const add = wanted.filter((each, index) => each.id !== subject.id && !have.has(each.id) && wanted.findIndex((other) => other.id === each.id) === index);
    const remove = addOnly ? [] : [...have].filter(([key, each]) => each.open && !wanted.some((ref) => ref.id === key));
    for (const blocker of add) await link(scope.blocksLink, blocker.id, subject.id);
    for (const [, each] of remove) await client.delete(`${api}/issueLink/${encodeURIComponent(each.id)}`);
    if (add.length === 0 && remove.length === 0) return;
    const after = blockerLinks(await issueOf(subject));
    failIf(subject, [...add.filter((each) => !after.has(each.id)).map((each) => `blocked by ${each.id} not added`), ...remove.filter(([key]) => after.has(key)).map(([key]) => `blocked by ${key} not removed`)]);
  }

  // --- the conventions' writes ---

  async function answerQuestions(subject: Ref, entries: readonly { to: string | null; answer: AnswerWrite }[]): Promise<{ open: number }> {
    if (entries.length === 0) throw new Error(`No answer to post on ${subject.id}.`);
    const read = await deps.read(subject);
    const { thread } = read;
    const numbered = entries.map(({ to, answer: given }) => {
      if (to === null) return { to: null, given };
      if (thread.answers.some((answer) => answer.to === to)) throw new AlreadyAnswered(`Question ${to} on ${subject.id} has an answer already.`);
      const draft = given.proposal !== undefined && thread.drafts.some((each) => each.id === to && !each.answered);
      if (!draft && !thread.openQuestions.some((question) => question.id === to)) throw new Error(`There is no open question ${to} on ${subject.id} (it may have been deleted).`);
      const n = questionNumber(read.comments.find((comment) => String(comment.id) === to));
      return { to: Number(to), ...(n ? { n } : {}), given };
    });
    const by = entries.find((each) => each.answer.by)?.answer.by ?? (await deps.self());
    const { markdown, property } = splitMarked(answersBody(numbered, by));
    checkSize(subject, "The answer", markdown, property);
    await postComment(subject, markdown, property);
    const after = await deps.read(subject);
    for (const { to, answer: given } of entries) {
      if (to === null) continue;
      const counted = after.thread.answers.find((answer) => answer.to === to);
      if (!counted) throw new Error(`Jira took the answer to question ${to} on ${subject.id}, but it does not show as the answer.`);
      if (counted.answer !== given.answer.trim()) throw new AlreadyAnswered(`Question ${to} on ${subject.id} was answered by someone else meanwhile: ${counted.answer}`);
    }
    await settle(subject, after);
    return { open: after.thread.openQuestions.length };
  }

  async function writeClaims(ref: Ref, claims: JiraClaim[]): Promise<void> {
    if (claims.length === 0) {
      try {
        await client.delete(`${path(ref)}/properties/${CLAIM_PROPERTY}`);
      } catch (error) {
        if (!(error instanceof JiraError && error.status === 404)) throw error;
      }
      return;
    }
    await putIssueProperty(ref, CLAIM_PROPERTY, { v: 1, by: await deps.self(), claims });
  }

  /** A new Item that Scope Soup would not read back (outside the filter, or in another project) is reported, not thrown. */
  async function checkInFilter(key: string): Promise<void> {
    if (!scope.filter) return;
    try {
      if (await issueInFilter(client, scope, key)) return;
      deps.onOutsideFilter?.(key, `was created${settings.components.length > 0 ? ` with ${settings.components.length === 1 ? "component" : "components"} ${settings.components.join(", ")}` : ""}, but it is not an Item (host.filter is ${scope.filter}): Scope Soup will not read, show or touch it.`);
    } catch (error) {
      deps.onOutsideFilter?.(key, `was created, but whether it is an Item could not be checked: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const write: WritePort = {
    async createWork(input) {
      const body = input.body ?? "";
      const markdown = input.verification !== undefined ? spliceBody(body, { verification: input.verification }) : body.trim();
      const labels = input.labels ?? [];
      checkLabels(labels);
      const priority = input.priority ? priorityName(scope, input.priority) : undefined;
      const fields = (parent: Ref | undefined): Record<string, unknown> => ({
        project: { key: scope.project },
        issuetype: { name: parent ? settings.childIssueType : settings.issueType },
        summary: input.title,
        ...(markdown ? { description: toJiraText(deployment, markdown) } : {}),
        ...(labels.length > 0 ? { labels } : {}),
        ...(settings.components.length > 0 ? { components: settings.components.map((name) => ({ name })) } : {}),
        ...(priority ? { priority: { name: priority } } : {}),
        ...(parent ? { parent: { key: parent.id } } : {}),
      });
      let created: { key?: string } | null;
      let problem: string | undefined;
      try {
        created = await client.post<{ id: string; key: string }>(`${api}/issue`, { fields: fields(input.parent) });
      } catch (error) {
        // A hierarchy the project does not allow (a child type it lacks, a Story under a Story): the issue is made on its own, and
        // the caller is told it is not under its parent (`linked: false`), as on GitHub.
        if (!input.parent || !(error instanceof JiraError && error.status === 400)) throw error;
        problem = error.message;
        created = await client.post<{ id: string; key: string }>(`${api}/issue`, { fields: fields(undefined) });
      }
      if (!created?.key) throw new Error("Jira created the issue but did not describe it.");
      const work = workRef(scope, created.key);
      const assignee = input.assignees?.[0];
      if (assignee) await client.put(`${path(work)}/assignee`, deployment === "cloud" ? { accountId: assignee } : { name: assignee });
      if (input.blockedBy && input.blockedBy.length > 0) await setBlockers(work, input.blockedBy.filter((each) => each.host === scope.host), true);
      if (input.state && input.state !== "todo" && input.state !== "waiting") await transitionTo(work, input.state, input.state === "done" ? settings.resolutions.done : input.state === "abandoned" ? settings.resolutions.abandoned : undefined);
      await checkInFilter(work.id);
      const outcome: WriteOutcome = { work, shared: "shared", conflict: false };
      if (problem) Object.assign(outcome, { linked: false, problem: `Created ${work.id} but could not put it under ${input.parent?.id}: ${problem}` });
      return outcome;
    },

    /**
     * Summary, description, verification, labels, parent and priority in one edit (labels added and removed, never replaced), then
     * the blockers as links and the state as a transition; then a re-read that must show them. A new description is refused when
     * the description holds what Scope Soup cannot write back; a new verification alone is spliced in.
     */
    async editWork(subject, patch) {
      if (patch.state === "waiting") throw new Error(`${subject.id}: waiting is not a state of a Jira issue.`);
      if (patch.duplicateOf && patch.state !== "abandoned") throw new Error(`${subject.id}: a duplicate is closed as abandoned.`);
      const issue = await issueOf(subject);
      const fields: Record<string, unknown> = {};
      const update: Record<string, unknown[]> = {};
      if (patch.title !== undefined && patch.title !== issue.fields.summary) fields.summary = patch.title;
      if (patch.body !== undefined || patch.verification !== undefined) {
        const written = writeDescription(deployment, issue.fields.description ?? null, { ...(patch.body !== undefined ? { description: patch.body } : {}), ...(patch.verification !== undefined ? { verification: patch.verification } : {}) });
        if ("refused" in written) throw new BodyChanged(`${subject.id}: ${written.refused}.`);
        if (JSON.stringify(written.value) !== JSON.stringify(issue.fields.description ?? null)) fields.description = written.value;
      }
      if (patch.priority !== undefined) {
        const name = patch.priority ? priorityName(scope, patch.priority) ?? "" : null;
        if (name === "") throw new Error(`${subject.id}: no Jira priority is named for ${patch.priority} (host.priorities).`);
        if (name === null || !same(issue.fields.priority?.name ?? "", name)) fields.priority = name === null ? null : { name };
      }
      if (patch.parent !== undefined && patch.parent?.id !== issue.fields.parent?.key) fields.parent = patch.parent ? { key: patch.parent.id } : null;
      let labelAdd: string[] = [];
      let labelRemove: string[] = [];
      if (patch.labels !== undefined) {
        const have = issue.fields.labels ?? [];
        labelAdd = patch.labels.filter((name) => !have.some((each) => same(each, name)));
        labelRemove = have.filter((name) => !patch.labels!.some((each) => same(each, name)));
        checkLabels(labelAdd);
        if (labelAdd.length > 0 || labelRemove.length > 0) update.labels = [...labelAdd.map((name) => ({ add: name })), ...labelRemove.map((name) => ({ remove: name }))];
      }
      if (Object.keys(fields).length > 0 || Object.keys(update).length > 0) await client.put(path(subject), { ...(Object.keys(fields).length > 0 ? { fields } : {}), ...(Object.keys(update).length > 0 ? { update } : {}) });
      if (patch.blockedBy !== undefined) await setBlockers(subject, patch.blockedBy.filter((each) => each.host === scope.host), false);
      const state = stateOf(scope, issue.fields.status, issue.fields.resolution?.name);
      if (patch.state !== undefined && patch.state !== state) {
        const resolution = patch.state === "done" ? settings.resolutions.done : patch.state === "abandoned" ? (patch.duplicateOf ? settings.resolutions.duplicate : settings.resolutions.abandoned) : undefined;
        await transitionTo(subject, patch.state, resolution);
      }
      // Once: a retry finds the link there already.
      if (patch.duplicateOf && !linkedTo(await issueOf(subject), settings.duplicateLink, patch.duplicateOf.id)) await link(settings.duplicateLink, subject.id, patch.duplicateOf.id);
      const after = await issueOf(subject);
      const missed: string[] = [];
      if (fields.summary !== undefined && after.fields.summary !== fields.summary) missed.push("summary not changed");
      if (fields.description !== undefined && JSON.stringify(after.fields.description ?? null) !== JSON.stringify(fields.description)) missed.push("description not changed");
      if (fields.priority !== undefined && priorityOf(scope, after.fields.priority?.name) !== (patch.priority ?? undefined)) missed.push(`priority not ${patch.priority ?? "cleared"}`);
      if (fields.parent !== undefined && (after.fields.parent?.key ?? null) !== (patch.parent?.id ?? null)) missed.push("parent not changed");
      for (const name of labelAdd) if (!(after.fields.labels ?? []).some((each) => same(each, name))) missed.push(`label ${name} not added`);
      for (const name of labelRemove) if ((after.fields.labels ?? []).some((each) => same(each, name))) missed.push(`label ${name} not removed`);
      const stateAfter = stateOf(scope, after.fields.status, after.fields.resolution?.name);
      if (patch.state !== undefined && stateAfter !== patch.state) missed.push(`state ${stateAfter}, not ${patch.state} (check host.transitions and host.resolutions)`);
      failIf(subject, missed);
      return { work: subject, shared: "shared", conflict: false };
    },

    async addBlockers(subject, blockers) {
      await setBlockers(subject, blockers.filter((each) => each.host === scope.host), true);
      return { work: subject, shared: "shared", conflict: false };
    },

    /** A restructuring's related part, linked "relates to" once; then the re-read that must show it. */
    async linkRelated(item, related) {
      if (related.host !== scope.host || linkedTo(await issueOf(item), settings.relatesLink, related.id)) return;
      await link(settings.relatesLink, related.id, item.id);
      failIf(item, linkedTo(await issueOf(item), settings.relatesLink, related.id) ? [] : [`relates to ${related.id} not added`]);
    },

    /** A restructuring's child put under its parent: the parent field (hierarchy rules of the project apply). */
    async linkChild(parent, child) {
      const issue = await issueOf(child);
      if (issue.fields.parent?.key === parent.id) return;
      await client.put(path(child), { fields: { parent: { key: parent.id } } });
      failIf(child, (await issueOf(child)).fields.parent?.key === parent.id ? [] : [`parent not ${parent.id}`]);
    },

    async setLabels(subject, add, remove) {
      await changeIssueLabels(subject, add, remove);
    },

    /** A triage draft's labels at Accept: only what changes is sent (a label exists on Jira by being used), then the re-read. */
    async changeLabels(subject, add, remove) {
      const have = (await issueOf(subject)).fields.labels ?? [];
      const added = add.filter((name, index) => !/\s/.test(name) && !have.some((each) => same(each, name)) && add.findIndex((each) => same(each, name)) === index);
      const removed = remove.flatMap((name) => have.filter((each) => same(each, name)).slice(0, 1));
      await changeIssueLabels(subject, added, removed);
      return { added, removed };
    },

    /** The assignee is a person's hold: one person on Jira. Cloud names people by account id, Data Center by user name. */
    async setAssignees(work, add, remove) {
      const issue = await issueOf(work);
      const current = issue.fields.assignee ? (issue.fields.assignee.accountId ?? issue.fields.assignee.name ?? "") : "";
      const wanted = add[0] ?? (current && remove.some((each) => same(each, current)) ? null : undefined);
      if (wanted === undefined || (wanted !== null && same(wanted, current))) return;
      await client.put(`${path(work)}/assignee`, deployment === "cloud" ? { accountId: wanted } : { name: wanted });
      const after = (await issueOf(work)).fields.assignee;
      const now = after ? (after.accountId ?? after.name ?? "") : "";
      failIf(work, (wanted === null ? !after : same(now, wanted)) ? [] : [wanted === null ? "assignee not removed" : `assignee ${wanted} not set`]);
    },

    /**
     * A person's hand-back: a comment that says it, with the branch and its tip in its property; then the re-read must count it.
     * The branch name is shown in a code span and the note is inert already. `person`: the hand-back goes through this token for
     * someone else (the board's picked person); the comment names them, inert already, and its property keeps who they are.
     */
    async recordHandback(subject, { sha, branch, note, person }) {
      const markdown = `**Handed back**${person ? ` by ${person.name}` : ""} on \`${branch.replaceAll("`", "")}\` (${sha.slice(0, 9)}) for Scope Soup's review.${note ? `

${note}` : ""}`;
      const property = { v: 1, kind: HANDBACK_KIND, sha, branch, ...(note ? { note } : {}), ...(person ? { person: { id: person.id, name: person.name } } : {}) };
      checkSize(subject, "The hand-back", markdown, property);
      await postComment(subject, markdown, property);
      if (!(await deps.read(subject)).handbacks.some((each) => each.sha === sha && each.branch === branch)) throw new Error(`Jira took the hand-back of ${subject.id} but it does not show as one.`);
    },

    async comment(subject, markdown) {
      checkSize(subject, "The comment", markdown);
      await postComment(subject, markdown);
    },

    /**
     * The done transition first, then the comment (with the `merged` property): a `merged` property on an issue that is not done
     * then always means it was reopened after the merge. The re-read must show it done.
     */
    async closeWork(work, comment, merged) {
      const issue = await issueOf(work);
      if (stateOf(scope, issue.fields.status, issue.fields.resolution?.name) !== "done") await transitionTo(work, "done", settings.resolutions.done);
      const after = await issueOf(work);
      failIf(work, stateOf(scope, after.fields.status, after.fields.resolution?.name) === "done" ? [] : ["state not done (check host.transitions.done)"]);
      if (merged) {
        const { markdown, property } = splitMarked(mergedBody(comment, merged));
        await postComment(work, markdown, property);
      } else await postComment(work, comment);
    },

    /**
     * The needs-decision label first, then one comment per question, numbered on from the issue's earlier questions (never reused,
     * nor a deleted one's, which the log keeps). A question still open with the same text and draft is not posted again.
     */
    async askQuestions(subject, questions) {
      try {
        const read = await deps.read(subject);
        const self = (await deps.self()).toLowerCase();
        const open = new Set(read.thread.openQuestions.map((question) => question.id));
        const taken = new Set<string>();
        const already = questions.map((question) => {
          const found = [...read.data].find(([id, data]) => !taken.has(id) && open.has(id) && data.question === question.question.trim() && data.draft === (question.draft ? Number(question.draft) : undefined));
          if (found) taken.add(found[0]);
          return found?.[0];
        });
        let next = nextQuestionNumber(read.comments, self, read.thread.log?.asked ?? 0);
        const numbers = already.map((id) => (id ? questionNumber(read.comments.find((comment) => String(comment.id) === id)) ?? 0 : next++));
        const bodies = questions.map((question, index) => (already[index] ? null : splitMarked(questionBody(numbers[index]!, question))));
        for (const body of bodies) if (body) checkSize(subject, "A question", body.markdown, body.property);
        await addNeedsDecision(subject);
        const ids: string[] = [];
        let at = "";
        for (const [index, body] of bodies.entries()) {
          if (!body) {
            ids.push(already[index]!);
            const found = read.thread.openQuestions.find((question) => question.id === already[index]);
            if (found && found.at > at) at = found.at;
            continue;
          }
          const posted = await postComment(subject, body.markdown, body.property);
          ids.push(posted.id);
          const created = isoTime(posted.created);
          if (created > at) at = created;
        }
        return { ids, at, numbers };
      } catch (error) {
        throw later(error);
      }
    },

    async withdrawQuestions(subject, deleted) {
      const read = await deps.read(subject);
      const open = new Set(read.thread.openQuestions.map((question) => question.id));
      for (const [id, data] of read.data) {
        if (!open.has(id) || data.kind !== "question") continue;
        const { kind: _kind, ...marker } = data;
        const { markdown, property } = splitMarked(withdrawnBody(marker));
        await editComment(subject, id, markdown, property);
      }
      const self = (await deps.self()).toLowerCase();
      const old = read.thread.log;
      const have = old?.deleted ?? [];
      const add = deleted.filter((each) => !have.some((one) => one.question === each.question && one.n === each.n));
      const asked = Math.max(nextQuestionNumber(read.comments, self, old?.asked ?? 0) - 1, ...deleted.map((each) => each.n ?? 0));
      if (add.length === 0 && asked === (old?.asked ?? 0)) return;
      await writeLog(subject, read, logLines(read), { asked, deleted: [...have, ...add.map((each) => ({ question: each.question, ...(each.n ? { n: each.n } : {}) }))] });
    },

    answerQuestion: (subject, to, given) => answerQuestions(subject, [{ to, answer: given }]),
    answerQuestions: (subject, entries) => answerQuestions(subject, entries),

    /** The draft comment with the hash of the description as read now; the proposed text is kept in its property too. */
    async postDraft(subject, draft) {
      try {
        const bodySha = descriptionSha((await issueOf(subject)).fields.description);
        const { markdown, property } = splitMarked(draftBody(draft.round, draft.draft, bodySha, draft.labels));
        property.text = draft.draft.trim();
        checkSize(subject, "The draft", markdown, property);
        await addNeedsDecision(subject);
        const same = (await deps.read(subject)).thread.drafts.find((each) => !each.answered && each.round === draft.round && each.bodySha === bodySha && each.text === draft.draft.trim() && changeText(each.labels) === changeText(draft.labels));
        if (same) return { id: same.id, at: same.at };
        const posted = await postComment(subject, markdown, property);
        return { id: posted.id, at: isoTime(posted.created) };
      } catch (error) {
        throw later(error);
      }
    },

    async checkDraft(subject, id) {
      const draft = (await deps.read(subject)).thread.drafts.find((each) => each.id === id);
      if (!draft) throw new Error(`The draft comment ${id} on ${subject.id} is gone (it may have been deleted).`);
      if (draft.answered) throw new AlreadyAnswered(`The draft of round ${draft.round} on ${subject.id} has an answer already.`);
      if (descriptionSha((await issueOf(subject)).fields.description) !== draft.bodySha) throw new BodyChanged(`The description of ${subject.id} changed on Jira since the draft of round ${draft.round} was written.`);
    },

    /** One line more in the log, the hidden issue property `scopesoup.log` (silent to watchers). */
    async logLine(subject, line) {
      const read = await deps.read(subject);
      const old = read.thread.log;
      await writeLog(subject, read, [...logLines(read), { at: new Date(deps.now()).toISOString(), kind: line.kind, fields: clipLogFields(line.kind, line.fields) }], { asked: old?.asked ?? 0, deleted: old?.deleted ?? [] });
    },

    async settleQuestions(subject) {
      await settle(subject, await deps.read(subject));
    },

    async postAssumptions(subject, decisions) {
      const { markdown, property } = splitMarked(assumptionBody(decisions));
      checkSize(subject, "The decisions", markdown, property);
      const posted = await postComment(subject, markdown, property);
      return { id: posted.id };
    },

    /**
     * The verdicts of one Send, after one fresh look that each decision is still open (one that is not refuses them all before
     * anything is written): into the issue property `scopesoup.overturns`, then each decisions comment's visible text says them.
     */
    async settleAssumptions(subject, settles) {
      const read = await deps.read(subject);
      const lists = new Map<string, ReturnType<typeof readVerdicts>>();
      for (const { id, settled } of settles) {
        const found = read.thread.assumptions.find((each) => each.id === id);
        if (!found) throw new AlreadyAnswered(`There is no decision ${id} on ${subject.id} (its comment may have been deleted).`);
        if (found.settled) throw new AlreadyAnswered(`Decision ${id} on ${subject.id} is ${found.settled.verdict} already.`);
        const [commentId, n] = id.split("-");
        if (!read.data.has(commentId!)) throw new AlreadyAnswered(`The comment of decision ${id} on ${subject.id} is gone.`);
        const list = lists.get(commentId!) ?? readVerdicts(read.verdicts[commentId!]);
        if (list.some((each) => each.n === Number(n))) throw new AlreadyAnswered(`Decision ${id} on ${subject.id} is settled already.`);
        list.push({ n: Number(n), verdict: settled.verdict, at: settled.at, by: settled.by, ...(settled.answer ? { answer: settled.answer } : {}), ...(settled.item ? { item: settled.item.id } : {}), ...(settled.work ? { work: true as const } : {}) });
        lists.set(commentId!, list);
      }
      const verdicts: Record<string, unknown[]> = { ...read.verdicts };
      for (const [id, list] of lists) verdicts[id] = list.map((each) => ({ ...each }));
      await putIssueProperty(subject, OVERTURNS_PROPERTY, { v: 1, by: await deps.self(), verdicts });
      for (const [id, list] of lists) {
        const data = read.data.get(id)!;
        const decisions = (Array.isArray(data.decisions) ? data.decisions : []) as AssumptionEntry[];
        const { markdown } = splitMarked(assumptionBody(decisions, list));
        await client.put(`${path(subject)}/comment/${encodeURIComponent(id)}`, { body: toJiraText(deployment, markdown.replace(/Reworked in #/g, "Reworked in ")) });
      }
      const after = await deps.read(subject);
      for (const { id } of settles) if (!after.thread.assumptions.find((each) => each.id === id)?.settled) throw new Error(`Jira took the verdicts on the decisions of ${subject.id} but does not show them.`);
    },

    /**
     * The claim, in the issue property `scopesoup.claim`. Jira has no conditional write, so two machines may write the whole
     * property at nearly the same time and the later write stands. To decide the same way on both: an assignee (a person's hold) or
     * a live claim of another machine wins without a write; else this machine's entry (a new one with its time and a nonce, or its
     * live one renewed, keeping its time) is written, and after `claimSettleMs` the property is read again. The earliest live entry
     * there wins (by time, then nonce); it must be this write's own nonce, else this entry is taken out and the claim is not won.
     * A person's claim (`scopesoup item claim`) sets the assignee, waits as long and yields to a claim it then finds; this claim
     * looks at the assignee again after its own wait and yields to a person who appeared. Both may yield; neither runs over the other.
     */
    async claim(subject, { until }) {
      const machine = deps.machine!;
      const issue = await issueOf(subject);
      if (issue.fields.assignee) return { won: false, why: `held by ${issue.fields.assignee.displayName ?? issue.fields.assignee.accountId ?? issue.fields.assignee.name}` };
      const now = deps.now();
      const live = (claims: JiraClaim[]): JiraClaim[] => claims.filter((each) => !each.released && Date.parse(each.until) > deps.now()).sort(claimOrder);
      const before = live((await deps.read(subject)).claims);
      const first = before[0];
      if (first && first.machine !== machine) return { won: false, why: `held by scopesoup on ${first.machine}` };
      const nonce = deps.nonce?.() ?? randomUUID();
      const own = before.find((each) => each.machine === machine);
      const mine: JiraClaim = { machine, until, released: false, at: own?.at || new Date(now).toISOString(), nonce };
      await writeClaims(subject, [...before.filter((each) => each.machine !== machine), mine].sort(claimOrder));
      await deps.sleep(deps.claimSettleMs ?? 2000);
      const after = live((await deps.read(subject)).claims);
      const winner = after[0];
      const assignee = winner?.nonce === nonce ? (await issueOf(subject)).fields.assignee : null;
      if (winner?.nonce === nonce && !assignee) return { won: true };
      if (after.some((each) => each.nonce === nonce)) await writeClaims(subject, after.filter((each) => each.nonce !== nonce));
      if (assignee) return { won: false, why: `held by ${assignee.displayName ?? assignee.accountId ?? assignee.name}` };
      return { won: false, why: winner ? `scopesoup on ${winner.machine} claimed it first` : "the claim does not show on Jira" };
    },

    /** This machine's claim taken out of `scopesoup.claim` (with any that ran out); the property goes when none is left. */
    async releaseClaim(subject) {
      const machine = deps.machine!;
      const read = await deps.read(subject);
      const left = read.claims.filter((each) => each.machine !== machine && !each.released && Date.parse(each.until) > deps.now());
      if (left.length === read.claims.length) return;
      await writeClaims(subject, left);
    },
  };
  if (!deps.machine) {
    delete write.claim;
    delete write.releaseClaim;
  }
  if (!scope.filter) return write;
  // A write to an issue outside the filter is refused, whichever write it is: every Item given to a method is checked first.
  const isRef = (value: unknown): value is Ref => typeof value === "object" && value !== null && (value as Ref).kind === "work" && (value as Ref).host === scope.host && typeof (value as Ref).id === "string";
  const guarded: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(write)) {
    if (typeof method !== "function" || name === "createWork") {
      guarded[name] = method;
      continue;
    }
    guarded[name] = async (...args: unknown[]): Promise<unknown> => {
      for (const ref of args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg])).filter(isRef)) {
        if (!(await issueInFilter(client, scope, ref.id))) throw new Error(`${ref.id} is not an Item here: it is outside host.filter (${scope.filter}), so Scope Soup does not touch it.`);
      }
      return (method as (...given: unknown[]) => unknown).apply(write, args);
    };
  }
  return guarded as WritePort;
}

