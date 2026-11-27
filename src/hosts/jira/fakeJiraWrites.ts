// The write side of the fake Jira (fakeJira.ts): issues, transitions, links, assignees, comments, labels and properties. It
// refuses what Jira refuses, as far as the documentation and docs/research/jira.md say: a transition not offered from the issue's
// status, a done transition without the resolution its screen requires, a Sub-task without a parent, a Story under a Story,
// labels with spaces, ADF that is not valid (an unknown node, text outside a paragraph, an empty text node, a mark Jira does not
// take with `code`), a comment over the limit, a property over 32 KB or a key over 255 bytes, and an edit of a comment's
// property by anyone but its author. Unconfirmed shapes follow the research's [known] marks.

import type { FetchResponse } from "../github/client.ts";
import type { AdfNode } from "./adf.ts";
import type { Deployment } from "./client.ts";
import type { JiraComment, JiraIssue, JiraIssueLink, JiraIssueStub, JiraStatus, JiraUser } from "./rest.ts";

export const FAKE_STATUSES: Record<string, JiraStatus> = {
  Backlog: { name: "Backlog", statusCategory: { key: "new", name: "To Do" } },
  "To Do": { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
  "In Progress": { name: "In Progress", statusCategory: { key: "indeterminate", name: "In Progress" } },
  Done: { name: "Done", statusCategory: { key: "done", name: "Done" } },
};

/** The workflow: one transition into each status, offered from every other status; Done's screen requires a resolution. */
const TRANSITIONS = [
  { id: "41", name: "Backlog", to: "Backlog" },
  { id: "11", name: "To Do", to: "To Do" },
  { id: "21", name: "In Progress", to: "In Progress" },
  { id: "31", name: "Done", to: "Done", resolution: true },
];
const RESOLUTIONS = ["Done", "Won't Do", "Duplicate", "Cannot Reproduce"];
const ISSUE_TYPES: Record<string, { subtask: boolean; level: number }> = { Epic: { subtask: false, level: 1 }, Story: { subtask: false, level: 0 }, Task: { subtask: false, level: 0 }, Bug: { subtask: false, level: 0 }, "Sub-task": { subtask: true, level: -1 } };
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];
const LINK_TYPES: Record<string, { inward: string; outward: string }> = {
  Blocks: { inward: "is blocked by", outward: "blocks" },
  Relates: { inward: "relates to", outward: "relates to" },
  Duplicate: { inward: "is duplicated by", outward: "duplicates" },
};

const BLOCK_NODES = new Set(["paragraph", "heading", "bulletList", "orderedList", "codeBlock", "blockquote", "rule", "expand", "panel", "table", "mediaSingle"]);
const INLINE_NODES = new Set(["text", "hardBreak", "mention", "emoji", "inlineCard", "status", "date"]);
const MARKS = new Set(["strong", "em", "code", "strike", "link", "underline", "textColor", "subsup"]);

/** Why the ADF document is not one Jira takes, or null. A simplified schema of the documented one. */
export function adfProblem(doc: unknown): string | null {
  const node = doc as AdfNode & { version?: number };
  if (!node || typeof node !== "object" || node.type !== "doc" || node.version !== 1) return "not an ADF document (type doc, version 1)";
  const inline = (nodes: AdfNode[] | undefined, where: string, code = false): string | null => {
    for (const each of nodes ?? []) {
      if (!INLINE_NODES.has(each.type)) return `${each.type} inside ${where}`;
      if (each.type !== "text") {
        if (code) return `${each.type} inside a codeBlock`;
        continue;
      }
      if (!each.text) return `an empty text node inside ${where}`;
      const marks = (each.marks ?? []).map((mark) => mark.type);
      if (code && marks.length > 0) return "marks inside a codeBlock";
      if (marks.some((mark) => !MARKS.has(mark))) return `an unknown mark in ${where}`;
      if (marks.includes("code") && marks.some((mark) => mark !== "code" && mark !== "link")) return "code with another mark than link";
      const link = each.marks?.find((mark) => mark.type === "link");
      if (link && typeof link.attrs?.href !== "string") return "a link without href";
    }
    return null;
  };
  const blocks = (nodes: AdfNode[] | undefined, where: string, allowed: Set<string>): string | null => {
    if (!nodes || nodes.length === 0) return where === "doc" ? null : `an empty ${where}`;
    for (const each of nodes) {
      if (!allowed.has(each.type)) return `${each.type} inside ${where}`;
      const problem = block(each);
      if (problem) return problem;
    }
    return null;
  };
  const LIST_CONTENT = new Set(["paragraph", "codeBlock", "bulletList", "orderedList"]);
  const block = (each: AdfNode): string | null => {
    switch (each.type) {
      case "paragraph":
        return inline(each.content, "a paragraph");
      case "heading": {
        const level = Number(each.attrs?.level);
        if (!(level >= 1 && level <= 6)) return "a heading without a level 1 to 6";
        return inline(each.content, "a heading");
      }
      case "codeBlock":
        return inline(each.content, "a codeBlock", true);
      case "rule":
        return each.content ? "a rule with content" : null;
      case "blockquote":
        return blocks(each.content, "blockquote", new Set(["paragraph", "bulletList", "orderedList", "codeBlock"]));
      case "bulletList":
      case "orderedList":
        for (const item of each.content ?? []) {
          if (item.type !== "listItem") return `${item.type} inside a list`;
          if (!["paragraph", "codeBlock"].includes(item.content?.[0]?.type ?? "")) return "a listItem not starting with a paragraph or codeBlock";
          const problem = blocks(item.content, "listItem", LIST_CONTENT);
          if (problem) return problem;
        }
        return (each.content ?? []).length === 0 ? "an empty list" : null;
      case "expand":
        return typeof each.attrs?.title !== "string" ? "an expand without a title" : blocks(each.content, "expand", new Set([...BLOCK_NODES].filter((name) => name !== "expand")));
      default:
        return null;
    }
  };
  return blocks(node.content, "doc", BLOCK_NODES);
}

/** The visible characters of a body, as Jira counts a text field (the ADF's text, or the wiki string). Unconfirmed. */
function bodyLength(deployment: Deployment, body: unknown): number {
  if (deployment === "datacenter") return typeof body === "string" ? body.length : 0;
  const count = (node: AdfNode): number => (node.text?.length ?? 0) + (node.content ?? []).reduce((sum, each) => sum + count(each), 0);
  return count(body as AdfNode);
}

export interface FakeWriteState {
  deployment: Deployment;
  site: string;
  user: JiraUser;
  project: string;
  /** The components the project has; a name not among them is refused. Undefined: any name is taken. */
  components?: string[] | undefined;
  issues: Map<string, JiraIssue>;
  comments: Record<string, JiraComment[]>;
  issueProperties: Record<string, Record<string, unknown>>;
  commentProperties: Record<string, Record<string, unknown>>;
  /** People the fake knows, by account id (Cloud) or name (Data Center), for assignees. */
  people: JiraUser[];
  /** Who may be assigned in the project; `people` when not given. */
  assignable?: JiraUser[] | undefined;
  commentLimit: number;
  now: () => number;
  ids: { comment: number; link: number; issue: number };
  /** Issue key -> its changelog, oldest first: the assignee changes the fake makes. */
  changelog: Record<string, FakeHistory[]>;
}

/** One changelog entry, as `expand=changelog` lists it [known, unconfirmed]: Cloud names people by account id, Data Center by user name. */
export interface FakeHistory {
  id: string;
  author: JiraUser;
  created: string;
  items: { field: string; fieldId?: string; from: string | null; to: string | null; fromString: string | null; toString: string | null }[];
}

type Answer = (status: number, body?: unknown) => FetchResponse;

const stamp = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");
const userId = (user: JiraUser | null | undefined): string => user?.accountId ?? user?.name ?? "";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A request the write side answers, or null when it is not one of its paths. `rest` is the path after the API version. */
export function routeWrite(state: FakeWriteState, method: string, rest: string, query: URLSearchParams, body: unknown, answer: Answer, refuse: (status: number, message: string) => FetchResponse): FetchResponse | null {
  const touch = (issue: JiraIssue): void => {
    issue.fields.updated = stamp(state.now());
  };
  const stubOf = (issue: JiraIssue): JiraIssueStub => ({ id: issue.id, key: issue.key, fields: { summary: issue.fields.summary ?? "", ...(issue.fields.status ? { status: issue.fields.status } : {}), ...(issue.fields.issuetype ? { issuetype: issue.fields.issuetype } : {}) } });
  const text = (value: unknown): string | null => {
    if (state.deployment === "datacenter") return typeof value === "string" ? null : "Data Center takes wiki markup, a string";
    return adfProblem(value);
  };
  const missing = (): FetchResponse => refuse(404, "Issue does not exist or you do not have permission to see it.");
  const badLabels = (labels: unknown[]): boolean => labels.some((label) => typeof label !== "string" || label === "" || /\s/.test(label));
  const person = (value: Record<string, unknown>): JiraUser | null | "unknown" => {
    const id = state.deployment === "cloud" ? value.accountId : value.name;
    if (id === null) return null;
    return state.people.find((each) => userId(each) === id) ?? "unknown";
  };

  if (method === "POST" && rest === "/issue") {
    const fields = (isObject(body) && isObject(body.fields) ? body.fields : {}) as Record<string, unknown>;
    const project = isObject(fields.project) ? fields.project.key : undefined;
    if (project !== state.project) return refuse(400, "project: valid project is required");
    const typeName = isObject(fields.issuetype) ? String(fields.issuetype.name) : "";
    const type = ISSUE_TYPES[typeName];
    if (!type) return refuse(400, "issuetype: valid issue type is required");
    if (typeof fields.summary !== "string" || !fields.summary.trim()) return refuse(400, "summary: You must specify a summary of the issue.");
    if (fields.description !== undefined) {
      const problem = text(fields.description);
      if (problem) return refuse(400, `description: ${problem}`);
    }
    if (fields.labels !== undefined && (!Array.isArray(fields.labels) || badLabels(fields.labels))) return refuse(400, "labels: The label must not contain spaces.");
    const priority = isObject(fields.priority) ? String(fields.priority.name) : undefined;
    if (priority !== undefined && !PRIORITIES.includes(priority)) return refuse(400, "priority: valid priority is required");
    const components = Array.isArray(fields.components) ? fields.components.map((each) => (isObject(each) ? String(each.name) : "")) : [];
    for (const name of components) if (!name || (state.components && !state.components.includes(name))) return refuse(400, `components: Component name '${name}' is not valid.`);
    const parentKey = isObject(fields.parent) ? String(fields.parent.key) : undefined;
    const parent = parentKey ? state.issues.get(parentKey) : undefined;
    if (parentKey && !parent) return refuse(400, "parent: Could not find issue by id or key.");
    if (type.subtask && !parent) return refuse(400, "parent: Sub-tasks must have a parent.");
    if (parent) {
      const parentType = ISSUE_TYPES[parent.fields.issuetype?.name ?? "Task"] ?? { subtask: false, level: 0 };
      if (parentType.level !== type.level + 1) return refuse(400, `parent: an issue of type ${typeName} cannot be a child of a ${parent.fields.issuetype?.name ?? "Task"}.`);
    }
    state.ids.issue += 1;
    const number = Math.max(0, ...[...state.issues.keys()].map((each) => Number(/-(\d+)$/.exec(each)?.[1] ?? 0))) + 1;
    const key = `${state.project}-${number}`;
    const issue: JiraIssue = {
      id: String(state.ids.issue), key, self: `${state.site}/rest/api/x/issue/${state.ids.issue}`,
      fields: {
        summary: fields.summary, description: fields.description ?? null, status: FAKE_STATUSES["To Do"]!, resolution: null,
        priority: priority ? { name: priority } : { name: "Medium" }, labels: (fields.labels as string[] | undefined) ?? [],
        ...(components.length > 0 ? { components: components.map((name) => ({ name })) } : {}),
        issuetype: { name: typeName, subtask: type.subtask }, subtasks: [], issuelinks: [], assignee: null, updated: stamp(state.now()), created: stamp(state.now()),
        ...(parent ? { parent: stubOf(parent) } : {}),
      },
    };
    state.issues.set(key, issue);
    if (parent && type.subtask) parent.fields.subtasks = [...(parent.fields.subtasks ?? []), stubOf(issue)];
    return answer(201, { id: issue.id, key, self: issue.self });
  }

  let match = /^\/issue\/([^/]+)$/.exec(rest);
  if (method === "PUT" && match?.[1]) {
    const issue = state.issues.get(decodeURIComponent(match[1]));
    if (!issue) return missing();
    const fields = (isObject(body) && isObject(body.fields) ? body.fields : {}) as Record<string, unknown>;
    const update = (isObject(body) && isObject(body.update) ? body.update : {}) as Record<string, unknown>;
    for (const name of Object.keys(fields)) if (!["summary", "description", "priority", "parent", "labels"].includes(name)) return refuse(400, `${name}: Field '${name}' cannot be set. It is not on the appropriate screen, or unknown.`);
    if (fields.summary !== undefined && (typeof fields.summary !== "string" || !fields.summary.trim())) return refuse(400, "summary: You must specify a summary of the issue.");
    if (fields.description !== undefined && fields.description !== null) {
      const problem = text(fields.description);
      if (problem) return refuse(400, `description: ${problem}`);
    }
    if (fields.priority !== undefined && fields.priority !== null && !(isObject(fields.priority) && PRIORITIES.includes(String(fields.priority.name)))) return refuse(400, "priority: valid priority is required");
    if (fields.priority === null) return refuse(400, "priority: Priority is required.");
    const labelOps = Array.isArray(update.labels) ? update.labels : [];
    for (const op of labelOps) if (!isObject(op) || (op.add !== undefined && badLabels([op.add]))) return refuse(400, "labels: The label must not contain spaces.");
    let parent: JiraIssue | undefined;
    if (isObject(fields.parent)) {
      parent = state.issues.get(String(fields.parent.key));
      if (!parent) return refuse(400, "parent: Could not find issue by id or key.");
      const type = ISSUE_TYPES[issue.fields.issuetype?.name ?? "Task"] ?? { subtask: false, level: 0 };
      const parentType = ISSUE_TYPES[parent.fields.issuetype?.name ?? "Task"] ?? { subtask: false, level: 0 };
      if (parentType.level !== type.level + 1) return refuse(400, `parent: an issue of type ${issue.fields.issuetype?.name} cannot be a child of a ${parent.fields.issuetype?.name}.`);
    }
    if (typeof fields.summary === "string") issue.fields.summary = fields.summary;
    if (fields.description !== undefined) issue.fields.description = fields.description;
    if (isObject(fields.priority)) issue.fields.priority = { name: String(fields.priority.name) };
    if (parent) issue.fields.parent = stubOf(parent);
    else if (fields.parent === null) delete issue.fields.parent;
    if (Array.isArray(fields.labels)) issue.fields.labels = fields.labels as string[];
    for (const op of labelOps as Record<string, unknown>[]) {
      const labels = issue.fields.labels ?? [];
      if (typeof op.add === "string" && !labels.includes(op.add)) issue.fields.labels = [...labels, op.add];
      if (typeof op.remove === "string") issue.fields.labels = labels.filter((label) => label !== op.remove);
    }
    touch(issue);
    return answer(204);
  }

  match = /^\/issue\/([^/]+)\/transitions$/.exec(rest);
  if (match?.[1]) {
    const issue = state.issues.get(decodeURIComponent(match[1]));
    if (!issue) return missing();
    const offered = TRANSITIONS.filter((each) => each.to !== issue.fields.status?.name);
    if (method === "GET") {
      const fieldsToo = (query.get("expand") ?? "").includes("transitions.fields");
      return answer(200, {
        transitions: offered.map((each) => ({
          id: each.id, name: each.name, to: FAKE_STATUSES[each.to],
          ...(fieldsToo ? { fields: each.resolution ? { resolution: { required: true, name: "Resolution", allowedValues: RESOLUTIONS.map((name) => ({ name })) } } : {} } : {}),
        })),
      });
    }
    if (method === "POST") {
      const request = isObject(body) ? body : {};
      const id = isObject(request.transition) ? String(request.transition.id) : "";
      const chosen = offered.find((each) => each.id === id);
      if (!chosen) return refuse(400, `It seems that you have tried to perform a workflow operation (${id}) that is not valid for the current state of this issue (${issue.key}).`);
      const fields = isObject(request.fields) ? request.fields : {};
      const resolution = isObject(fields.resolution) ? String(fields.resolution.name) : undefined;
      if (chosen.resolution && !resolution) return refuse(400, "resolution: Resolution is required.");
      if (resolution !== undefined && (!chosen.resolution || !RESOLUTIONS.includes(resolution))) return refuse(400, "resolution: Field 'resolution' cannot be set or is not valid.");
      issue.fields.status = FAKE_STATUSES[chosen.to]!;
      // Leaving Done clears the resolution, as Jira's default workflows do.
      issue.fields.resolution = chosen.resolution ? { name: resolution! } : null;
      touch(issue);
      // The parent's sub-task stub follows.
      const parent = issue.fields.parent ? state.issues.get(issue.fields.parent.key) : undefined;
      if (parent) parent.fields.subtasks = (parent.fields.subtasks ?? []).map((each) => (each.key === issue.key ? stubOf(issue) : each));
      return answer(204);
    }
  }

  if (method === "POST" && rest === "/issueLink") {
    const request = isObject(body) ? body : {};
    const typeName = isObject(request.type) ? String(request.type.name) : "";
    const type = LINK_TYPES[typeName];
    if (!type) return refuse(404, `No issue link type with name '${typeName}' found.`);
    const inward = isObject(request.inwardIssue) ? state.issues.get(String(request.inwardIssue.key)) : undefined;
    const outward = isObject(request.outwardIssue) ? state.issues.get(String(request.outwardIssue.key)) : undefined;
    if (!inward || !outward) return refuse(404, "Issue does not exist or you do not have permission to see it.");
    // "outward <outward> inward" (Blocks: the outward issue blocks the inward one). Each issue lists the other on the side it is
    // seen from: the inward issue "is blocked by" the outward one, so its entry carries `inwardIssue` (unconfirmed).
    state.ids.link += 1;
    const id = String(state.ids.link);
    const linkType = { name: typeName, ...type };
    inward.fields.issuelinks = [...(inward.fields.issuelinks ?? []), { id, type: linkType, inwardIssue: stubOf(outward) }];
    outward.fields.issuelinks = [...(outward.fields.issuelinks ?? []), { id, type: linkType, outwardIssue: stubOf(inward) }];
    touch(inward);
    touch(outward);
    return answer(201);
  }
  match = /^\/issueLink\/([^/]+)$/.exec(rest);
  if (method === "DELETE" && match?.[1]) {
    const id = decodeURIComponent(match[1]);
    let found = false;
    for (const issue of state.issues.values()) {
      const kept = (issue.fields.issuelinks ?? []).filter((link: JiraIssueLink) => link.id !== id);
      if (kept.length !== (issue.fields.issuelinks ?? []).length) {
        found = true;
        issue.fields.issuelinks = kept;
        touch(issue);
      }
    }
    return found ? answer(204) : refuse(404, "No issue link with id exists.");
  }

  match = /^\/issue\/([^/]+)\/assignee$/.exec(rest);
  if (method === "PUT" && match?.[1]) {
    const issue = state.issues.get(decodeURIComponent(match[1]));
    if (!issue) return missing();
    const who = person(isObject(body) ? body : {});
    if (who === "unknown") return refuse(400, "assignee: User cannot be assigned issues.");
    const before = issue.fields.assignee ?? null;
    if (userId(before) !== userId(who)) {
      const history = (state.changelog[issue.key] ??= []);
      history.push({
        id: String(70_000 + history.length), author: state.user, created: stamp(state.now()),
        items: [{ field: "assignee", fieldId: "assignee", from: userId(before) || null, to: userId(who) || null, fromString: before?.displayName ?? null, toString: who?.displayName ?? null }],
      });
    }
    issue.fields.assignee = who;
    touch(issue);
    return answer(204);
  }

  match = /^\/issue\/([^/]+)\/comment(?:\/([^/]+))?$/.exec(rest);
  if (match?.[1] && method !== "GET") {
    const key = decodeURIComponent(match[1]);
    const issue = state.issues.get(key);
    if (!issue) return missing();
    const list = (state.comments[key] ??= []);
    if (method === "POST" && !match[2]) {
      const request = isObject(body) ? body : {};
      const problem = text(request.body);
      if (problem) return refuse(400, `body: ${problem}`);
      if (bodyLength(state.deployment, request.body) > state.commentLimit) return refuse(400, `body: The entered text is too long. It exceeds the allowed limit of ${state.commentLimit} characters.`);
      state.ids.comment += 1;
      const comment: JiraComment = { id: String(state.ids.comment), author: state.user, body: request.body, created: stamp(state.now()), updated: stamp(state.now()) };
      list.push(comment);
      touch(issue);
      return answer(201, comment);
    }
    const comment = list.find((each) => each.id === decodeURIComponent(match![2] ?? ""));
    if (!comment) return refuse(404, "Can not find a comment for the id.");
    if (userId(comment.author) !== userId(state.user)) return refuse(403, "You do not have the permission to edit this comment.");
    if (method === "PUT") {
      const request = isObject(body) ? body : {};
      const problem = text(request.body);
      if (problem) return refuse(400, `body: ${problem}`);
      if (bodyLength(state.deployment, request.body) > state.commentLimit) return refuse(400, `body: The entered text is too long. It exceeds the allowed limit of ${state.commentLimit} characters.`);
      comment.body = request.body;
      comment.updated = stamp(state.now());
      touch(issue);
      return answer(200, comment);
    }
    if (method === "DELETE") {
      state.comments[key] = list.filter((each) => each !== comment);
      delete state.commentProperties[comment.id];
      touch(issue);
      return answer(204);
    }
  }

  match = /^\/(issue|comment)\/([^/]+)\/properties\/([^/]+)$/.exec(rest);
  if ((method === "PUT" || method === "DELETE") && match?.[1] && match[2] && match[3]) {
    const id = decodeURIComponent(match[2]);
    const key = decodeURIComponent(match[3]);
    if (Buffer.byteLength(key, "utf8") > 255) return refuse(400, "The property key cannot be longer than 255 characters.");
    let store: Record<string, Record<string, unknown>>;
    if (match[1] === "issue") {
      if (!state.issues.has(id)) return missing();
      store = state.issueProperties;
    } else {
      const comment = Object.values(state.comments).flat().find((each) => each.id === id);
      if (!comment) return refuse(404, "Can not find a comment for the id.");
      if (userId(comment.author) !== userId(state.user)) return refuse(403, "You do not have the permission to edit this comment.");
      store = state.commentProperties;
    }
    if (method === "DELETE") {
      if (!store[id] || !(key in store[id]!)) return refuse(404, `The property with key '${key}' does not exist.`);
      delete store[id]![key];
      return answer(204);
    }
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 32_768) return refuse(400, "The property value cannot be longer than 32768 bytes.");
    const had = !!store[id] && key in store[id]!;
    store[id] = { ...store[id], [key]: structuredClone(body) };
    return answer(had ? 200 : 201);
  }

  if (method === "GET" && rest === "/user/assignable/search") {
    if (query.get("project") !== state.project) return refuse(404, "No project could be found with key.");
    return answer(200, state.assignable ?? state.people);
  }

  if (method === "GET" && rest.startsWith("/label") && state.deployment === "cloud") {
    const all = [...new Set([...state.issues.values()].flatMap((issue) => issue.fields.labels ?? []))].sort();
    const start = Number(query.get("startAt") ?? 0);
    const size = Number(query.get("maxResults") ?? 1000);
    return answer(200, { startAt: start, maxResults: size, total: all.length, isLast: start + size >= all.length, values: all.slice(start, start + size) });
  }
  return null;
}
