// Synthetic GitHub responses for tests: the shapes of the REST API with invented content.

import type { RestCheckRun, RestIssue, RestJob, RestPull, RestReview, RestWorkflowRun } from "./rest.ts";

export const REPO = "acme/widgets";
export const R = `/repos/${REPO}`;
export const WEB = `https://github.test/${REPO}`;

export function issue(number: number, over: Partial<RestIssue> = {}): RestIssue {
  return {
    number,
    id: 9000 + number,
    title: `Item ${number}`,
    body: `Body of item ${number}.`,
    state: "open",
    labels: [],
    assignees: [],
    html_url: `${WEB}/issues/${number}`,
    repository_url: `https://api.github.test${R}`,
    updated_at: "2026-11-10T08:00:00Z",
    ...over,
  };
}

export function pull(number: number, over: Partial<RestPull> = {}): RestPull {
  return {
    number,
    title: `Change ${number}`,
    body: null,
    state: "open",
    draft: false,
    user: { login: "robin", type: "User" },
    labels: [],
    base: { ref: "main" },
    head: { ref: `feature/${number}`, sha: `sha${number}a` },
    html_url: `${WEB}/pull/${number}`,
    created_at: "2026-11-09T10:00:00Z",
    updated_at: "2026-11-10T09:00:00Z",
    ...over,
  };
}

export function review(id: number, login: string, state: string, commit: string, submitted = "2026-11-10T09:30:00Z"): RestReview {
  return { id, user: { login, type: "User" }, state, commit_id: commit, submitted_at: submitted, html_url: `${WEB}/pull/0#review-${id}` };
}

export function check(id: number, name: string, status: string, conclusion: string | null = null): RestCheckRun {
  return { id, name, status, conclusion };
}

export function workflowRun(id: number, over: Partial<RestWorkflowRun> = {}): RestWorkflowRun {
  return {
    id,
    name: "Full suite",
    head_sha: `sha${id}`,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    html_url: `${WEB}/actions/runs/${id}`,
    created_at: "2026-11-10T10:00:00Z",
    run_started_at: "2026-11-10T10:00:05Z",
    updated_at: "2026-11-10T10:20:00Z",
    ...over,
  };
}

export function job(id: number, over: Partial<RestJob> = {}): RestJob {
  return { id, name: "test", status: "in_progress", conclusion: null, started_at: "2026-11-10T10:01:00Z", runner_name: "box-1", ...over };
}
