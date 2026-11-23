// The step on GitHub after an import from GitHub Issues (decision 67): leave the issues as they are (the default), or label
// each open imported issue `moved-to-scopesoup` with a comment naming its Item, or also close it. Only ever done when the person
// said yes (the CLI asks, or takes `--yes`); this module does not ask, it is only called after the yes. Pull requests are never
// touched: only issues the import read (which leaves pull requests out) are given here. Safe to run again: the label is added only
// when it is missing, the comment only when no earlier one of Scope Soup's (found by its `moved` marker) is there, and an issue that
// is closed already is left alone. So a run that failed halfway is finished by the next one.

import type { Client } from "../hosts/github/client.ts";
import { GitHubError } from "../hosts/github/client.ts";
import { readMarker, withMarker } from "../hosts/github/conventions.ts";
import type { RestComment, RestLabel } from "../hosts/github/rest.ts";

/** What is done on GitHub after the import. */
export type OnGitHub = "leave" | "label" | "close";

export const MOVED_LABEL = "moved-to-scopesoup";
const MOVED_LOOK = { color: "ededed", description: "Moved to Scope Soup: the comment names the Item" };

/** The reason a closed issue is given: the work is not done, it goes on elsewhere, so not `completed`. */
export const CLOSE_REASON = "not_planned";

/** One imported issue, as the step needs it. */
export interface MoveTarget {
  number: number;
  /** The Item it became. */
  id: string;
  open: boolean;
  /** Its labels on GitHub when the import read it. */
  labels: string[];
}

export interface MoveOptions {
  client: Client;
  targets: readonly MoveTarget[];
  choice: "label" | "close";
  /** The token's login: only its own earlier comment counts as already there. Any `moved` comment counts when unknown. */
  login?: string;
  /** Where the Items are, in words, for the comment (e.g. "the meta ref `refs/scopesoup/meta`"). */
  where?: string;
  /** Says what would be done; writes nothing. */
  dryRun?: boolean;
}

export interface MoveRow {
  number: number;
  id: string;
  /** What was done; empty when everything was there already. */
  did: ("labelled" | "commented" | "closed")[];
}

export interface MoveReport {
  rows: MoveRow[];
  /** Imported issues that are closed on GitHub: left as they are. */
  closedBefore: number[];
  /** The first write that failed; the issues after it were not touched. A run again finishes them. */
  failed?: { number: number; message: string };
  /** Whether the label had to be created. */
  labelCreated: boolean;
}

/** The comment that names the Item. Built from Scope Soup's own facts only (the repository, the number, the Item id), never issue text. */
export function movedComment(target: MoveTarget, choice: "label" | "close", where: string | undefined): string {
  const lines = [`This issue moved to Scope Soup: it is Item **${target.id}** on ${where ?? "the project's Scope Soup meta branch"}, with its description and last comments. The work goes on there; what is written here is no longer read.`];
  if (choice === "close") lines.push("", "It is closed here as not planned because it is tracked in Scope Soup now, not because it was dropped.");
  return withMarker(lines.join("\n"), "moved", { issue: target.number, item: target.id });
}

const hasLabel = (labels: readonly string[], name: string): boolean => labels.some((label) => label.toLowerCase() === name.toLowerCase());

/** Does the step for the open targets, in issue order, and stops at the first write that fails. */
export async function moveIssues(options: MoveOptions): Promise<MoveReport> {
  const { client, choice } = options;
  const open = [...options.targets].filter((target) => target.open).sort((a, b) => a.number - b.number);
  const report: MoveReport = { rows: [], closedBefore: options.targets.filter((target) => !target.open).map((target) => target.number).sort((a, b) => a - b), labelCreated: false };
  if (options.dryRun) {
    for (const target of open) report.rows.push({ number: target.number, id: target.id, did: [] });
    return report;
  }
  if (open.length === 0) return report;

  // The label, created when the repository does not have it yet.
  const labels = (await client.list<RestLabel>(client.repoPath("/labels?per_page=100"))).data.map((label) => label.name);
  if (!hasLabel(labels, MOVED_LABEL) && open.some((target) => !hasLabel(target.labels, MOVED_LABEL))) {
    try {
      await client.send("POST", client.repoPath("/labels"), { name: MOVED_LABEL, ...MOVED_LOOK });
      report.labelCreated = true;
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422 && error.message.includes("already_exists"))) {
        report.failed = { number: open[0]!.number, message: `the label ${MOVED_LABEL} could not be created: ${messageOf(error)}` };
        return report;
      }
    }
  }

  const self = options.login?.toLowerCase();
  for (const target of open) {
    const row: MoveRow = { number: target.number, id: target.id, did: [] };
    report.rows.push(row);
    try {
      if (!hasLabel(target.labels, MOVED_LABEL)) {
        await client.send("POST", client.repoPath(`/issues/${target.number}/labels`), { labels: [MOVED_LABEL] });
        row.did.push("labelled");
      }
      const comments = (await client.list<RestComment>(client.repoPath(`/issues/${target.number}/comments?per_page=100`))).data;
      const earlier = comments.some((comment) => {
        const marker = readMarker(comment.body);
        return marker?.kind === "moved" && marker.data.issue === target.number && (self === undefined || comment.user?.login.toLowerCase() === self);
      });
      if (!earlier) {
        await client.send("POST", client.repoPath(`/issues/${target.number}/comments`), { body: movedComment(target, choice, options.where) });
        row.did.push("commented");
      }
      if (choice === "close") {
        await client.send("PATCH", client.repoPath(`/issues/${target.number}`), { state: "closed", state_reason: CLOSE_REASON });
        row.did.push("closed");
      }
    } catch (error) {
      report.failed = { number: target.number, message: messageOf(error) };
      return report;
    }
  }
  return report;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The report as lines for the terminal. */
export function moveText(report: MoveReport, choice: "label" | "close", repo: string, dryRun: boolean): string[] {
  const lines: string[] = [];
  const what = choice === "close" ? `labelled ${MOVED_LABEL}, given a comment naming its Item and closed as not planned` : `labelled ${MOVED_LABEL} and given a comment naming its Item`;
  if (dryRun) {
    if (report.rows.length === 0) lines.push(`On GitHub: no open imported issue in ${repo} would be changed.`);
    else lines.push(`On GitHub, each of these open issues in ${repo} would be ${what}: ${report.rows.map((row) => `#${row.number} (${row.id})`).join(", ")}. Nothing was written to GitHub.`);
    return lines;
  }
  for (const row of report.rows) {
    const failedHere = report.failed?.number === row.number;
    const text = row.did.length > 0 ? row.did.join(", ") : failedHere ? "nothing yet" : "already done before";
    lines.push(`#${String(row.number).padEnd(6)} ${row.id.padEnd(8)} ${text}`);
  }
  if (report.closedBefore.length > 0) lines.push(`Left as they are (closed on GitHub): ${report.closedBefore.map((number) => `#${number}`).join(", ")}.`);
  if (report.failed) lines.push(`On GitHub the step stopped at #${report.failed.number}: ${report.failed.message}. Run the same command again to finish it; what is done is not done twice.`);
  else if (report.rows.length === 0) lines.push(`On GitHub: no open imported issue in ${repo} to change.`);
  else lines.push(`On GitHub: ${report.rows.length} open issue(s) in ${repo} are ${what}${report.labelCreated ? ` (the label was created)` : ""}. Pull requests were not touched.`);
  return lines;
}
