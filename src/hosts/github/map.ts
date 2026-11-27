// Pure mapping from GitHub's REST shapes to the model.

import { priorityFromLabels } from "../../model/priority.ts";
import type { Actor, Change, Ref, Run, RunStatus, RunStep, Runner, Verdict, WorkItem } from "../../model/types.ts";
import type { RestCheckRun, RestIssue, RestJob, RestPull, RestReview, RestRunner, RestUser, RestWorkflowRun } from "./rest.ts";

/** Which host and repository the refs are for. */
export interface Scope {
  host: string;
  repo: string;
}

export function actorOf(user: RestUser | null | undefined): Actor {
  if (!user) return { id: "ghost", name: "ghost" };
  const actor: Actor = { id: user.login, name: user.login };
  if (user.type === "Bot") actor.bot = true;
  return actor;
}

export const labelNames = (labels: ({ name: string } | string)[]): string[] =>
  labels.map((label) => (typeof label === "string" ? label : label.name));

/** A ref to an issue from its API or web URL. Issues of another repository get "owner/name#N" as id. */
export function issueRefFromUrl(scope: Scope, url: string | null | undefined): Ref | null {
  const match = /(?:repos\/)?([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url ?? "");
  if (!match?.[1] || !match[2]) return null;
  const same = match[1].toLowerCase() === scope.repo.toLowerCase();
  return { host: scope.host, kind: "work", id: same ? match[2] : `${match[1]}#${match[2]}` };
}

export function workRef(scope: Scope, number: number, url?: string): Ref {
  const ref: Ref = { host: scope.host, kind: "work", id: String(number) };
  if (url) ref.url = url;
  return ref;
}

export function changeRef(scope: Scope, number: number, url?: string): Ref {
  const ref: Ref = { host: scope.host, kind: "change", id: String(number) };
  if (url) ref.url = url;
  return ref;
}

/** "A person must act": an open question, or a hold for a person (docs/github-mapping.md). */
export const NEEDS_DECISION_LABEL = "scopesoup:needs-decision";
/** Held by a Scope Soup agent, with a claim comment. Never an assignee: an assignee always means a person. */
export const CLAIMED_LABEL = "scopesoup:claimed";
/** An implementor decided something itself that a person may accept or overturn. Does not block, and is not needs-decision. */
export const ASSUMPTION_LABEL = "scopesoup:assumption";
/** In To do (decision 120): the board sets and removes it. An open issue without it is in Backlog, where no agent starts it. */
export const TODO_LABEL = "scopesoup:todo";

export const hasLabel = (labels: string[], name: string): string | undefined => labels.find((label) => label.toLowerCase() === name.toLowerCase());

const VERIFICATION_HEADING = /^##\s+Verification\s*$/i;
const FENCE = /^\s*(```|~~~)/;

/** The lines of the last `## Verification` section outside code fences: from its heading to the next `# ` or `## ` line. */
function verificationLines(lines: string[]): { start: number; end: number } | null {
  let fenced = false;
  let open: number | null = null;
  let last: { start: number; end: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (FENCE.test(line)) fenced = !fenced;
    else if (fenced) continue;
    else if (VERIFICATION_HEADING.test(line)) {
      if (open !== null) last = { start: open, end: index };
      open = index;
    } else if (open !== null && /^##? /.test(line)) {
      last = { start: open, end: index };
      open = null;
    }
  }
  return open !== null ? { start: open, end: lines.length } : last;
}

const newlineOf = (body: string): string => (body.includes("\r\n") ? "\r\n" : "\n");
const linesOf = (text: string): string[] => text.split(/\r?\n/);
const dropTrailingBlank = (lines: string[]): string[] => {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(0, end);
};

/** An issue body as the description and the trimmed text of its `## Verification` section (none when empty). Pure. */
export function splitBody(body: string): { description: string; verification?: string } {
  const lines = linesOf(body);
  const section = verificationLines(lines);
  if (!section) return { description: body.trim() };
  const nl = newlineOf(body);
  const description = [...lines.slice(0, section.start), ...lines.slice(section.end)].join(nl).trim();
  const verification = lines.slice(section.start + 1, section.end).join(nl).trim();
  return verification ? { description, verification } : { description };
}

/**
 * The body with only the description or only the Verification section changed. A new description keeps the section after it;
 * a new verification replaces the section in its place, or is appended; null or empty removes the section. Pure.
 */
export function spliceBody(body: string, change: { description?: string; verification?: string | null }): string {
  const nl = newlineOf(body);
  let lines = linesOf(body);
  let section = verificationLines(lines);
  if (change.description !== undefined) {
    const kept = section ? dropTrailingBlank(lines.slice(section.start, section.end)) : [];
    const description = change.description.trim();
    lines = [...(description ? linesOf(description) : []), ...(description && kept.length > 0 ? [""] : []), ...kept];
    section = kept.length > 0 ? { start: lines.length - kept.length, end: lines.length } : null;
  }
  if (change.verification !== undefined) {
    const text = (change.verification ?? "").trim();
    const before = section ? dropTrailingBlank(lines.slice(0, section.start)) : dropTrailingBlank(lines);
    const after = section ? lines.slice(section.end) : [];
    const heading = section ? (lines[section.start] ?? "## Verification") : "## Verification";
    const middle = text ? [heading, "", ...linesOf(text)] : [];
    lines = [...before, ...(before.length > 0 && middle.length > 0 ? [""] : []), ...middle, ...((before.length > 0 || middle.length > 0) && after.length > 0 ? [""] : []), ...after];
  }
  return lines.join(nl).trim();
}

export function issueToWork(scope: Scope, issue: RestIssue, blockedBy: Ref[] = []): WorkItem {
  const assignee = issue.assignees?.[0];
  const closed = issue.state === "closed";
  const abandoned = issue.state_reason === "not_planned" || issue.state_reason === "duplicate";
  const labels = labelNames(issue.labels);
  // The needs-decision label is never read as state: `needsDecision` comes from the question and rewrite comments (conventions layer, `waitsForAnswer`).
  const item: WorkItem = {
    ref: workRef(scope, issue.number, issue.html_url),
    title: issue.title,
    state: closed ? (abandoned ? "abandoned" : "done") : assignee ? "doing" : "todo",
    hostState: closed && issue.state_reason ? `closed:${issue.state_reason}` : issue.state,
    labels,
    blockedBy,
    openChildren: Math.max(0, (issue.sub_issues_summary?.total ?? 0) - (issue.sub_issues_summary?.completed ?? 0)),
    updatedAt: issue.updated_at,
  };
  if (item.state === "todo" && !hasLabel(labels, TODO_LABEL)) item.backlog = true;
  if (issue.sub_issues_summary?.total) item.children = issue.sub_issues_summary.total;
  const priority = priorityFromLabels(item.labels);
  if (priority) item.priority = priority;
  if (issue.body) {
    const { description, verification } = splitBody(issue.body);
    if (description) item.body = description;
    if (verification) item.verification = verification;
  }
  const parent = issueRefFromUrl(scope, issue.parent_issue_url);
  if (parent) item.parent = parent;
  if (assignee) item.holder = { actor: actorOf(assignee) };
  return item;
}

/** Issue numbers a pull request body names with `Refs #N` (also `Refs #N, #M`) or a closing keyword. */
export function worksInBody(body: string | null | undefined): number[] {
  const found: number[] = [];
  const add = (text: string): void => {
    for (const match of text.matchAll(/#(\d+)/g)) {
      const number = Number(match[1]);
      if (!found.includes(number)) found.push(number);
    }
  };
  const text = body ?? "";
  const lists = /\b(?:refs?|close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s*(#\d+(?:\s*(?:,|and)?\s*#\d+)*)/gi;
  for (const match of text.matchAll(lists)) add(match[1] ?? "");
  return found;
}

const REVIEW_VALUES: Record<string, Verdict["value"]> = { APPROVED: "pass", CHANGES_REQUESTED: "fail" };

/** One verdict per reviewer: their latest approval or change request. A dismissed review counts as none given. */
export function reviewVerdicts(reviews: RestReview[], headSha: string, requested: RestUser[] = []): Verdict[] {
  const latest = new Map<string, RestReview>();
  const ordered = [...reviews].sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "") || a.id - b.id);
  for (const review of ordered) {
    const login = review.user?.login;
    if (!login) continue;
    if (review.state === "DISMISSED") latest.delete(login);
    else if (REVIEW_VALUES[review.state]) latest.set(login, review);
  }
  const verdicts: Verdict[] = [];
  for (const review of latest.values()) {
    const verdict: Verdict = {
      dimension: "review",
      value: REVIEW_VALUES[review.state] ?? "none",
      by: actorOf(review.user),
      stale: !!review.commit_id && review.commit_id !== headSha,
    };
    if (review.commit_id) verdict.revision = review.commit_id;
    if (review.html_url) verdict.url = review.html_url;
    verdicts.push(verdict);
  }
  for (const user of requested) {
    // A re-requested reviewer must look again, whatever they said before.
    const index = verdicts.findIndex((verdict) => verdict.by?.id === user.login);
    if (index >= 0) verdicts.splice(index, 1);
    verdicts.push({ dimension: "review", value: "pending", by: actorOf(user), revision: headSha, stale: false });
  }
  return verdicts;
}

export const CHECK_GREEN = new Set(["success", "skipped", "neutral"]);

/** The check runs of the head commit as one verdict; the latest run of each check name counts. */
export function ciVerdict(checkRuns: RestCheckRun[], headSha: string): Verdict {
  const latest = new Map<string, RestCheckRun>();
  for (const run of checkRuns) {
    const seen = latest.get(run.name);
    if (!seen || run.id > seen.id) latest.set(run.name, run);
  }
  let value: Verdict["value"] = latest.size === 0 ? "none" : "pass";
  for (const run of latest.values()) {
    if (run.status !== "completed") {
      if (value !== "fail") value = "pending";
    } else if (!CHECK_GREEN.has(run.conclusion ?? "")) {
      value = "fail";
    }
  }
  return { dimension: "ci", value, revision: headSha, stale: false };
}

export function pullToChange(scope: Scope, pull: RestPull, reviews: RestReview[], checkRuns: RestCheckRun[]): Change {
  const merged = !!(pull.merged ?? pull.merged_at);
  const change: Change = {
    ref: changeRef(scope, pull.number, pull.html_url),
    title: pull.title,
    author: actorOf(pull.user),
    state: merged ? "merged" : pull.state === "closed" ? "closed" : "open",
    draft: !!pull.draft,
    target: pull.base.ref,
    branch: pull.head.ref,
    // GitHub has no revision list: the head commit is the one revision, and when it was pushed is not in the pull.
    revisions: [{ id: pull.head.sha, sha: pull.head.sha, createdAt: pull.created_at, author: actorOf(pull.user) }],
    verdicts: [...reviewVerdicts(reviews, pull.head.sha, pull.requested_reviewers), ciVerdict(checkRuns, pull.head.sha)],
    labels: labelNames(pull.labels),
    works: worksInBody(pull.body).map((number) => workRef(scope, number)),
    updatedAt: pull.updated_at,
  };
  if (typeof pull.mergeable === "boolean") {
    change.mergeable = pull.mergeable;
    if (!pull.mergeable) change.blockers = ["conflicts with the target branch"];
  }
  return change;
}

export function runStatus(status: string | null, conclusion: string | null): RunStatus {
  if (status === "completed") {
    if (conclusion === "success" || conclusion === "neutral") return "passed";
    if (conclusion === "cancelled" || conclusion === "skipped" || conclusion === "stale") return "cancelled";
    return "failed";
  }
  return status === "in_progress" ? "running" : "queued";
}

/** Steps of the run's jobs in order. With several jobs the step names carry the job name. */
export function jobSteps(jobs: RestJob[]): RunStep[] {
  const steps: RunStep[] = [];
  const prefix = (job: RestJob): string => (jobs.length > 1 ? `${job.name} / ` : "");
  const timed = (step: RunStep, startedAt?: string | null, finishedAt?: string | null): RunStep => {
    if (startedAt) step.startedAt = startedAt;
    if (finishedAt) step.finishedAt = finishedAt;
    return step;
  };
  for (const job of jobs) {
    if (!job.steps?.length) {
      steps.push(timed({ name: job.name, status: runStatus(job.status, job.conclusion) }, job.started_at, job.completed_at));
      continue;
    }
    for (const step of job.steps) {
      steps.push(
        timed({ name: prefix(job) + step.name, status: runStatus(step.status, step.conclusion) }, step.started_at, step.completed_at),
      );
    }
  }
  return steps;
}

export function runToRun(scope: Scope, run: RestWorkflowRun, jobs?: RestJob[]): Run {
  const status = runStatus(run.status, run.conclusion);
  const ref: Ref = { host: scope.host, kind: "run", id: String(run.id) };
  if (run.html_url) ref.url = run.html_url;
  const mapped: Run = { ref, pipeline: run.name ?? "", sha: run.head_sha, status };
  if (run.head_branch) mapped.branch = run.head_branch;
  if (run.created_at) mapped.createdAt = run.created_at;
  if (run.run_started_at && status !== "queued") mapped.startedAt = run.run_started_at;
  if (run.status === "completed" && run.updated_at) mapped.finishedAt = run.updated_at;
  if (jobs) {
    const runner = jobs.find((job) => job.runner_name)?.runner_name;
    if (runner) mapped.runner = runner;
    mapped.steps = jobSteps(jobs);
  }
  return mapped;
}

export function runnerToRunner(runner: RestRunner, current?: Ref): Runner {
  const mapped: Runner = {
    id: String(runner.id),
    name: runner.name,
    online: runner.status === "online",
    busy: runner.busy,
    labels: labelNames(runner.labels ?? []),
  };
  if (current) mapped.current = current;
  return mapped;
}
