// Pure mapping from Jira's REST shapes to the model. The text readers are adf.ts (Cloud) and wiki.ts (Data Center).

import { isPriority } from "../../model/priority.ts";
import type { Actor, Priority, Ref, WorkItem, WorkState } from "../../model/types.ts";
import { splitBody } from "../github/map.ts";
import { adfToMarkdown } from "./adf.ts";
import type { Deployment } from "./client.ts";
import type { Converted } from "./markdown.ts";
import type { JiraIssue, JiraIssueStub, JiraStatus, JiraUser } from "./rest.ts";
import { wikiToMarkdown } from "./wiki.ts";

/** Jira priority names (either default set: Highest to Lowest, and the older Blocker to Trivial) to Scope Soup's. */
export const DEFAULT_PRIORITIES: Readonly<Record<string, Priority>> = {
  Highest: "blocker", High: "critical", Medium: "major", Low: "minor", Lowest: "minor",
  Blocker: "blocker", Critical: "critical", Major: "major", Minor: "minor", Trivial: "minor",
};

/** Resolutions that mean the work was not done: the Item is abandoned, not done. Jira's default names. */
export const DEFAULT_ABANDONED_RESOLUTIONS: readonly string[] = ["Won't Do", "Won't Fix", "Duplicate", "Cannot Reproduce", "Incomplete", "Declined"];

/** The link type whose inward side is "is blocked by". Jira's default name. */
export const DEFAULT_BLOCKS_LINK = "Blocks";

/** The fields every listing and get asks for. */
export const ISSUE_FIELDS = ["summary", "description", "status", "resolution", "priority", "labels", "issuetype", "parent", "subtasks", "issuelinks", "assignee", "updated"];

export interface JiraScope {
  /** The host id in refs: "jira". */
  host: string;
  site: string;
  /** The project key, `DEMO`. */
  project: string;
  /** A JQL condition ANDed with the project: which issues are Items. Undefined: all of them. */
  filter?: string;
  deployment: Deployment;
  priorities: Readonly<Record<string, Priority>>;
  abandonedResolutions: readonly string[];
  blocksLink: string;
  /** The status (category To Do) that is Backlog (decision 121): `transitions.backlog` in the config. Default "Backlog". */
  backlogStatus?: string;
}

/** Jira's usual name of the Backlog status. */
export const DEFAULT_BACKLOG_STATUS = "Backlog";

/** Jira's time (`2026-11-20T10:15:30.000+0000`) as ISO 8601 in UTC; the text itself when it cannot be read. */
export function isoTime(value: string | undefined): string {
  if (!value) return "";
  const normal = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const time = Date.parse(normal);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

export const workRef = (scope: JiraScope, key: string): Ref => ({ host: scope.host, kind: "work", id: key, url: `${scope.site}/browse/${key}` });

/** The project of an issue key: `DEMO` of `DEMO-12`. */
export const projectOf = (key: string): string => key.replace(/-\d+$/, "");

/** Cloud: the account id; Data Center: the user name. The display name for people. */
export function actorOf(user: JiraUser | null | undefined): Actor {
  const id = user?.accountId ?? user?.name ?? user?.key ?? "unknown";
  const actor: Actor = { id, name: user?.displayName || id };
  if (user?.accountType === "app") actor.bot = true;
  return actor;
}

/** `new` is todo, `indeterminate` doing, `done` done (or abandoned with a "won't do" resolution). An unknown category is todo. */
export function stateOf(scope: JiraScope, status: JiraStatus | undefined, resolution: string | undefined): WorkState {
  const category = status?.statusCategory?.key;
  if (category === "done") {
    const abandoned = resolution !== undefined && scope.abandonedResolutions.some((name) => name.toLowerCase() === resolution.toLowerCase());
    return abandoned ? "abandoned" : "done";
  }
  return category === "indeterminate" ? "doing" : "todo";
}

const isDone = (stub: JiraIssueStub): boolean => stub.fields?.status?.statusCategory?.key === "done";

/** A Jira priority name by the configured map, case-insensitively; none when the map does not name it. */
export function priorityOf(scope: JiraScope, name: string | undefined): Priority | undefined {
  if (!name) return undefined;
  const found = Object.entries(scope.priorities).find(([jira]) => jira.toLowerCase() === name.toLowerCase())?.[1];
  return isPriority(found) ? found : undefined;
}

/** Description or comment text in the deployment's format, as Markdown. */
export function textOf(scope: JiraScope, value: unknown): Converted {
  if (scope.deployment === "cloud") return adfToMarkdown(value);
  return wikiToMarkdown(typeof value === "string" ? value : null);
}

/** The open issues this one is blocked by: links of the Blocks type whose other issue is on the inward side. */
export function blockersOf(scope: JiraScope, issue: JiraIssue): Ref[] {
  const found: Ref[] = [];
  for (const link of issue.fields.issuelinks ?? []) {
    if (link.type.name.toLowerCase() !== scope.blocksLink.toLowerCase() || !link.inwardIssue) continue;
    if (isDone(link.inwardIssue)) continue;
    if (!found.some((ref) => ref.id === link.inwardIssue?.key)) found.push(workRef(scope, link.inwardIssue.key));
  }
  return found;
}

/** An issue as a work item, and what its description's conversion simplified. */
export function issueToWork(scope: JiraScope, issue: JiraIssue): { item: WorkItem; simplified: string[] } {
  const fields = issue.fields;
  const subtasks = fields.subtasks ?? [];
  const item: WorkItem = {
    ref: workRef(scope, issue.key),
    title: fields.summary ?? "",
    state: stateOf(scope, fields.status, fields.resolution?.name),
    hostState: fields.status?.name ?? "",
    labels: [...(fields.labels ?? [])],
    blockedBy: blockersOf(scope, issue),
    openChildren: subtasks.filter((stub) => !isDone(stub)).length,
    updatedAt: isoTime(fields.updated),
  };
  if (item.state === "todo" && (fields.status?.name ?? "").toLowerCase() === (scope.backlogStatus ?? DEFAULT_BACKLOG_STATUS).toLowerCase()) item.backlog = true;
  if (subtasks.length > 0) item.children = subtasks.length;
  const priority = priorityOf(scope, fields.priority?.name);
  if (priority) item.priority = priority;
  if (fields.parent?.key) item.parent = workRef(scope, fields.parent.key);
  // An assignee is a person's hold. Agents' holds are an issue property, read by the conventions layer (a later slice).
  if (fields.assignee) item.holder = { actor: actorOf(fields.assignee) };
  const text = textOf(scope, fields.description);
  if (text.markdown) {
    const { description, verification } = splitBody(text.markdown);
    if (description) item.body = description;
    if (verification) item.verification = verification;
  }
  return { item, simplified: text.simplified };
}

/**
 * A UTC instant as JQL's `yyyy-MM-dd HH:mm` in the user's time zone: JQL reads a date in the zone of the token's user profile
 * (unconfirmed: from memory, research section 1), and only to the minute.
 */
export function jqlTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

/** A JQL string literal. */
export const jqlString = (text: string): string => `"${text.replace(/["\\]/g, (char) => `\\${char}`)}"`;

/** The JQL of which issues are Items: the project, and the filter in parentheses when there is one. */
export const itemsJql = (scope: Pick<JiraScope, "project" | "filter">): string => `project = ${jqlString(scope.project)}${scope.filter ? ` AND (${scope.filter})` : ""}`;

// The approved mapping of Scope Soup's markers on Jira (issue #6). Read here; written in a later slice.
/** `needs-decision`: a label (Jira labels hold no spaces). */
export const NEEDS_DECISION_LABEL = "scopesoup-needs-decision";
/** Every property Scope Soup reads starts with this: `scopesoup` on a comment (question, answer, rewrite, assumption, review), and on the issue `scopesoup.claim` (an agent's hold), `scopesoup.overturns` and `scopesoup.log`. */
export const PROPERTY_PREFIX = "scopesoup";
