// The parts of Jira's REST shapes the host reads, Cloud (v3) and Data Center (v2) together. Hand-written from Atlassian's
// documentation and docs/research/jira.md; fields marked unconfirmed there are optional here.

/** Cloud names a person by `accountId`; Data Center by `name` and `key`. */
export interface JiraUser {
  accountId?: string;
  name?: string;
  key?: string;
  displayName?: string;
  emailAddress?: string;
  /** IANA zone of the user's profile, e.g. "Europe/Berlin": JQL dates are read in it. */
  timeZone?: string;
  accountType?: string;
}

export interface JiraStatus {
  name: string;
  /** `new` (To Do), `indeterminate` (In Progress), `done` (Done). */
  statusCategory?: { key: string; name?: string };
}

/** A linked, parent or sub-task issue as Jira embeds it: key and a few fields. */
export interface JiraIssueStub {
  id?: string;
  key: string;
  fields?: { summary?: string; status?: JiraStatus; issuetype?: { name?: string; subtask?: boolean } };
}

export interface JiraIssueLink {
  id?: string;
  type: { name: string; inward?: string; outward?: string };
  /** Present when the link's inward side is the other issue: this issue "is blocked by" it, for type Blocks. */
  inwardIssue?: JiraIssueStub;
  outwardIssue?: JiraIssueStub;
}

export interface JiraIssueFields {
  summary?: string;
  /** ADF on Cloud, wiki markup on Data Center, null when empty. */
  description?: unknown;
  status?: JiraStatus;
  resolution?: { name: string } | null;
  priority?: { name: string } | null;
  labels?: string[];
  issuetype?: { name?: string; subtask?: boolean };
  parent?: JiraIssueStub;
  subtasks?: JiraIssueStub[];
  issuelinks?: JiraIssueLink[];
  assignee?: JiraUser | null;
  /** `2026-11-20T10:15:30.000+0000`. */
  updated?: string;
  created?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  self?: string;
  fields: JiraIssueFields;
}

export interface JiraProperty {
  key: string;
  value: unknown;
}

export interface JiraComment {
  id: string;
  author?: JiraUser;
  /** ADF on Cloud, wiki markup on Data Center. */
  body?: unknown;
  created: string;
  updated?: string;
  /** With `expand=properties` (unconfirmed on both deployments). */
  properties?: JiraProperty[];
}
