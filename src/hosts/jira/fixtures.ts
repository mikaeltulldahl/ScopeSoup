// Hand-written synthetic Jira data for tests: project DEMO on example.atlassian.net (Cloud) and jira.example.test (Data
// Center). Shapes follow Atlassian's documentation as of 2026-11 (REST v3 Cloud, v2 Data Center); no real site was recorded.

import type { JiraComment, JiraIssue, JiraIssueStub, JiraUser } from "./rest.ts";

export const CLOUD_EMAIL = "robin@example.test";
export const TOKEN = "jira-token-synthetic";

export const CLOUD_ROBIN: JiraUser = { accountId: "000000:robin-0001", displayName: "Robin Example", timeZone: "Asia/Tokyo", accountType: "atlassian" };
export const CLOUD_SCOPESOUP: JiraUser = { accountId: "000000:scopesoup-0002", displayName: "Scope Soup Bot", accountType: "atlassian" };
export const DC_ROBIN: JiraUser = { name: "robin", key: "JIRAUSER10000", displayName: "Robin Example", timeZone: "America/New_York" };

const CATEGORY = { todo: { key: "new", name: "To Do" }, doing: { key: "indeterminate", name: "In Progress" }, done: { key: "done", name: "Done" } } as const;
type Category = keyof typeof CATEGORY;
const status = (name: string, category: Category) => ({ name, statusCategory: CATEGORY[category] });
const stub = (key: string, category: Category, summary = key): JiraIssueStub => ({ id: String(10000 + Number(key.split("-")[1])), key, fields: { summary, status: status(category === "done" ? "Done" : category === "doing" ? "In Progress" : "To Do", category) } });

interface IssueSpec {
  summary: string;
  category: Category;
  statusName?: string;
  updated: string;
  description?: unknown;
  priority?: string;
  labels?: string[];
  type?: string;
  resolution?: string;
  parent?: JiraIssueStub;
  subtasks?: JiraIssueStub[];
  links?: JiraIssue["fields"]["issuelinks"];
  assignee?: JiraUser;
}

function issue(key: string, spec: IssueSpec): JiraIssue {
  return {
    id: String(10000 + Number(key.split("-")[1])),
    key,
    fields: {
      summary: spec.summary,
      description: spec.description ?? null,
      status: status(spec.statusName ?? CATEGORY[spec.category].name, spec.category),
      resolution: spec.resolution ? { name: spec.resolution } : null,
      priority: spec.priority ? { name: spec.priority } : null,
      labels: spec.labels ?? [],
      issuetype: { name: spec.type ?? "Task", subtask: spec.type === "Sub-task" },
      ...(spec.parent ? { parent: spec.parent } : {}),
      subtasks: spec.subtasks ?? [],
      issuelinks: spec.links ?? [],
      assignee: spec.assignee ?? null,
      updated: spec.updated,
    },
  };
}

const BLOCKS = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
const RELATES = { name: "Relates", inward: "relates to", outward: "relates to" };

const text = (value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ version: 1, type: "doc", content });

/** Shared by both flavours: who blocks whom, states and fields; only the text format differs. */
function demoIssues(descriptions: { one: unknown; two: unknown }, assignee: JiraUser): JiraIssue[] {
  return [
    issue("DEMO-1", {
      summary: "Board shows the demo project", category: "doing", updated: "2026-11-20T09:00:00.000+0000", priority: "High", labels: ["frontend"], type: "Story",
      description: descriptions.one, subtasks: [stub("DEMO-4", "done"), stub("DEMO-5", "todo")],
      links: [{ id: "20001", type: RELATES, outwardIssue: stub("DEMO-2", "todo") }],
    }),
    issue("DEMO-2", {
      summary: "Fix the login redirect", category: "todo", statusName: "Backlog", updated: "2026-11-20T09:30:00.000+0000", priority: "Highest", labels: ["bug", "scopesoup-needs-decision"],
      description: descriptions.two, assignee,
      links: [
        { id: "20002", type: BLOCKS, inwardIssue: stub("DEMO-3", "doing") },
        { id: "20003", type: BLOCKS, inwardIssue: stub("DEMO-4", "done") },
        { id: "20004", type: BLOCKS, outwardIssue: stub("DEMO-6", "done") },
        { id: "20005", type: RELATES, inwardIssue: stub("DEMO-1", "doing") },
      ],
    }),
    issue("DEMO-3", { summary: "Write the API notes", category: "doing", updated: "2026-11-20T10:00:00.000+0000", priority: "Medium" }),
    issue("DEMO-4", { summary: "Draw the columns", category: "done", updated: "2026-11-19T08:00:00.000+0000", type: "Sub-task", resolution: "Done", parent: stub("DEMO-1", "doing") }),
    issue("DEMO-5", { summary: "Colour the cards", category: "todo", updated: "2026-11-20T10:00:30.000+0000", type: "Sub-task", priority: "Low", parent: stub("DEMO-1", "doing") }),
    issue("DEMO-6", { summary: "Old login page", category: "done", updated: "2026-11-18T12:00:00.000+0000", resolution: "Won't Do", priority: "Lowest" }),
  ];
}

export const CLOUD_DESCRIPTION_ONE = doc(
  { type: "heading", attrs: { level: 2 }, content: [text("Goal")] },
  para(text("Show "), text("every", [{ type: "strong" }]), text(" Item, see "), text("the notes", [{ type: "link", attrs: { href: "https://example.test/notes" } }]), text(".")),
  { type: "bulletList", content: [{ type: "listItem", content: [para(text("columns"))] }, { type: "listItem", content: [para(text("cards"))] }] },
  { type: "heading", attrs: { level: 2 }, content: [text("Verification")] },
  para(text("Open the board and see DEMO-1.")),
);

export const CLOUD_DESCRIPTION_TWO = doc(
  para(text("Asked by "), { type: "mention", attrs: { id: CLOUD_ROBIN.accountId, text: "@Robin Example" } }, text(", now "), { type: "status", attrs: { text: "BLOCKED", color: "red" } }),
  { type: "panel", attrs: { panelType: "warning" }, content: [para(text("Only on Fridays."))] },
);

export const DC_DESCRIPTION_ONE = "h2. Goal\nShow *every* Item, see [the notes|https://example.test/notes].\n* columns\n* cards\n\nh2. Verification\nOpen the board and see DEMO-1.";
export const DC_DESCRIPTION_TWO = "Asked by [~robin], now {color:red}BLOCKED{color}\n{panel}Only on Fridays.{panel}";

export const cloudIssues = (): JiraIssue[] => demoIssues({ one: CLOUD_DESCRIPTION_ONE, two: CLOUD_DESCRIPTION_TWO }, CLOUD_ROBIN);
export const dcIssues = (): JiraIssue[] => demoIssues({ one: DC_DESCRIPTION_ONE, two: DC_DESCRIPTION_TWO }, DC_ROBIN);

export const cloudComments = (): Record<string, JiraComment[]> => ({
  "DEMO-2": [
    { id: "30001", author: CLOUD_ROBIN, created: "2026-11-20T09:10:00.000+0000", body: doc(para(text("Is SSO affected too?"))) },
    { id: "30002", author: CLOUD_SCOPESOUP, created: "2026-11-20T09:20:00.000+0000", body: doc(para(text("Scope Soup question Q1")), para(text("Which page should the redirect go to?"))) },
  ],
});

export const dcComments = (): Record<string, JiraComment[]> => ({
  "DEMO-2": [
    { id: "30001", author: DC_ROBIN, created: "2026-11-20T09:10:00.000+0000", body: "Is SSO affected too?" },
    { id: "30002", author: { name: "scopesoup", displayName: "Scope Soup Bot" }, created: "2026-11-20T09:20:00.000+0000", body: "Scope Soup question Q1\n\nWhich page should the redirect go to?" },
  ],
});

export const COMMENT_PROPERTIES = { "30002": { scopesoup: { kind: "question", n: 1 }, "other.app": { seen: true } } };
export const ISSUE_PROPERTIES = { "DEMO-2": { "scopesoup.log": { lines: [{ kind: "claimed", at: "2026-11-20T09:00:00Z" }] }, "other.app": { x: 1 } } };
