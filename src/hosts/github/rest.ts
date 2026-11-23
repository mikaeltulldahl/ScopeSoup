// The parts of GitHub's REST responses the adapter reads. Everything optional that GitHub may omit.

export interface RestUser {
  login: string;
  type?: string;
}

export interface RestLabel {
  name: string;
  description?: string | null;
}

export interface RestIssue {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  labels: (RestLabel | string)[];
  assignees?: RestUser[] | null;
  pull_request?: unknown;
  html_url?: string;
  repository_url?: string;
  parent_issue_url?: string | null;
  updated_at: string;
  issue_dependencies_summary?: { blocked_by?: number; total_blocked_by?: number };
  sub_issues_summary?: { total?: number; completed?: number };
  /** How many comments the issue has. */
  comments?: number;
}

export interface RestComment {
  id: number;
  body: string | null;
  user: RestUser | null;
  created_at: string;
  updated_at?: string;
  html_url?: string;
  /** OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ... */
  author_association?: string;
  issue_url?: string;
}

/** One event of an issue's timeline; only `event` and `created_at` are read (`reopened`). */
export interface RestTimelineEvent {
  event: string;
  created_at?: string;
}

export interface RestPull {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  user: RestUser | null;
  labels: RestLabel[];
  base: { ref: string };
  head: { ref: string; sha: string };
  requested_reviewers?: RestUser[];
  mergeable?: boolean | null;
  mergeable_state?: string;
  html_url?: string;
  created_at: string;
  updated_at: string;
}

export interface RestReview {
  id: number;
  user: RestUser | null;
  state: string;
  commit_id?: string | null;
  submitted_at?: string;
  html_url?: string;
}

export interface RestCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
  /** The app that made it; `github-actions` for a job of GitHub Actions, whose id is the job's id. */
  app?: { slug?: string } | null;
}

/** One commit status (`GET /commits/{sha}/status` lists the latest of each context). */
export interface RestStatus {
  id?: number;
  context: string;
  state: "error" | "failure" | "pending" | "success";
  description?: string | null;
  target_url?: string | null;
}

export interface RestCombinedStatus {
  state: string;
  statuses: RestStatus[];
  total_count?: number;
}

export interface RestWorkflowRun {
  id: number;
  name?: string | null;
  head_sha: string;
  head_branch?: string | null;
  status: string | null;
  conclusion: string | null;
  html_url?: string;
  created_at?: string;
  run_started_at?: string;
  updated_at?: string;
}

export interface RestStep {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface RestJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  runner_name?: string | null;
  steps?: RestStep[];
}

export interface RestRunner {
  id: number;
  name: string;
  status: string;
  busy: boolean;
  labels?: RestLabel[];
}

export interface RestWorkflow {
  id: number;
  name: string;
  path?: string;
}
